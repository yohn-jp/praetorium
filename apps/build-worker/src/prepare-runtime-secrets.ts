import { constants } from "node:fs";
import { chmod, mkdir, open, readdir, realpath, lstat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DESTINATION_MOUNT = "/var/run/praetorium-build-worker";
const TEMPORARY_MOUNT = "/tmp/praetorium-build-worker";
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const WRITE_FLAGS = constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

type SecretFile = {
  name: string;
  maxBytes: number;
};

type SecretVolume = {
  name: string;
  files: readonly SecretFile[];
};

type SecretLayout = {
  destinationMount: string;
  temporaryMount: string;
  sourceMounts: Readonly<Record<string, string>>;
};

const VOLUMES: readonly SecretVolume[] = [
  {
    name: "buildkit",
    files: [
      { name: "ca.crt", maxBytes: 1024 * 1024 },
      { name: "tls.crt", maxBytes: 1024 * 1024 },
      { name: "tls.key", maxBytes: 16 * 1024 },
    ],
  },
  { name: "registry", files: [{ name: "config.json", maxBytes: 64 * 1024 }] },
  {
    name: "registry-pull",
    files: [{ name: "credential.json", maxBytes: 4096 }],
  },
  { name: "control-plane", files: [{ name: "token", maxBytes: 4098 }] },
  { name: "signing", files: [{ name: "key.pem", maxBytes: 16 * 1024 }] },
];

const DEFAULT_LAYOUT: SecretLayout = {
  destinationMount: DESTINATION_MOUNT,
  temporaryMount: TEMPORARY_MOUNT,
  sourceMounts: {
    buildkit: "/var/run/secrets/buildkit",
    registry: "/var/run/secrets/registry",
    "registry-pull": "/var/run/secrets/registry-pull",
    "control-plane": "/var/run/secrets/control-plane",
    signing: "/var/run/secrets/signing",
  },
};

class RuntimeSecretPreparationError extends Error {
  constructor() {
    super("Build worker runtime secret preparation failed");
    this.name = "RuntimeSecretPreparationError";
  }
}

function fail(): never {
  throw new RuntimeSecretPreparationError();
}

function isWithin(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) fail();
  return uid;
}

async function requireMountDirectory(directory: string): Promise<void> {
  const info = await lstat(directory);
  // Kubernetes v1.35 emptyDir roots can be root-owned mode 2777 after fsGroup
  // applies. These are fixed Pod volume mounts; the child private directories
  // created below are the security boundary and are checked at 0700/current UID.
  if (!info.isDirectory() || info.isSymbolicLink()) {
    fail();
  }
}

async function ensurePrivateDirectory(parent: string, name: string, uid: number): Promise<string> {
  const directory = path.join(parent, name);
  let created = false;
  try {
    await mkdir(directory, { mode: DIRECTORY_MODE });
    created = true;
  } catch (error) {
    if (
      !(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")
    ) {
      throw error;
    }
  }
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== uid ||
    (!created && (info.mode & 0o7777) !== DIRECTORY_MODE)
  ) {
    fail();
  }
  if (created) {
    await chmod(directory, DIRECTORY_MODE);
    const verified = await lstat(directory);
    if (
      !verified.isDirectory() ||
      verified.isSymbolicLink() ||
      verified.uid !== uid ||
      (verified.mode & 0o7777) !== DIRECTORY_MODE
    ) {
      fail();
    }
  }
  return directory;
}

async function projectedGeneration(sourceMount: string): Promise<{
  root: string;
  generation: string;
  linkDevice: number;
  linkInode: number;
}> {
  await requireMountDirectory(sourceMount);
  const root = await realpath(sourceMount);
  const generationLink = path.join(sourceMount, "..data");
  const linkInfo = await lstat(generationLink);
  if (!linkInfo.isSymbolicLink()) fail();
  const generation = await realpath(generationLink);
  if (!isWithin(root, generation)) fail();
  const generationInfo = await lstat(generation);
  if (!generationInfo.isDirectory() || generationInfo.isSymbolicLink()) fail();
  return {
    root,
    generation,
    linkDevice: linkInfo.dev,
    linkInode: linkInfo.ino,
  };
}

async function assertGenerationUnchanged(
  sourceMount: string,
  snapshot: Awaited<ReturnType<typeof projectedGeneration>>,
): Promise<void> {
  const generationLink = path.join(sourceMount, "..data");
  const linkInfo = await lstat(generationLink);
  if (
    !linkInfo.isSymbolicLink() ||
    linkInfo.dev !== snapshot.linkDevice ||
    linkInfo.ino !== snapshot.linkInode ||
    (await realpath(generationLink)) !== snapshot.generation
  ) {
    fail();
  }
}

async function readProjectedFile(
  sourceMount: string,
  snapshot: Awaited<ReturnType<typeof projectedGeneration>>,
  file: SecretFile,
): Promise<Buffer> {
  const entry = path.join(sourceMount, file.name);
  const entryInfo = await lstat(entry);
  if (!entryInfo.isSymbolicLink()) fail();
  const resolved = await realpath(entry);
  const pinnedTarget = path.join(snapshot.generation, file.name);
  if (!isWithin(snapshot.root, resolved) || resolved !== pinnedTarget) fail();

  let handle: FileHandle | undefined;
  try {
    handle = await open(resolved, READ_FLAGS);
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > file.maxBytes) fail();
    const bytes = Buffer.allocUnsafe(file.maxBytes + 1);
    let offset = 0;
    while (offset <= file.maxBytes) {
      const remaining = file.maxBytes + 1 - offset;
      const { bytesRead } = await handle.read(bytes, offset, Math.min(8192, remaining), offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== info.size || offset < 1 || offset > file.maxBytes) fail();
    await assertGenerationUnchanged(sourceMount, snapshot);
    return Buffer.from(bytes.subarray(0, offset));
  } finally {
    await handle?.close();
  }
}

async function readVolume(
  sourceMount: string,
  volume: SecretVolume,
): Promise<readonly { file: SecretFile; content: Buffer }[]> {
  const snapshot = await projectedGeneration(sourceMount);
  const contents: { file: SecretFile; content: Buffer }[] = [];
  for (const file of volume.files) {
    contents.push({ file, content: await readProjectedFile(sourceMount, snapshot, file) });
  }
  await assertGenerationUnchanged(sourceMount, snapshot);
  return contents;
}

async function assertExpectedEntries(
  directory: string,
  expectedNames: readonly string[],
  requireAll: boolean,
): Promise<void> {
  const entries = await readdir(directory);
  if (
    entries.some((entry) => !expectedNames.includes(entry)) ||
    (requireAll && entries.length !== expectedNames.length)
  ) {
    fail();
  }
}

async function assertExistingOutputFile(filePath: string, uid: number): Promise<boolean> {
  try {
    const info = await lstat(filePath);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.uid !== uid ||
      info.nlink !== 1 ||
      (info.mode & 0o7777) !== FILE_MODE
    ) {
      fail();
    }
    return true;
  } catch (error) {
    if (error instanceof RuntimeSecretPreparationError) throw error;
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function writePrivateFile(filePath: string, content: Buffer, uid: number): Promise<void> {
  const existing = await assertExistingOutputFile(filePath, uid);
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      filePath,
      existing ? WRITE_FLAGS : WRITE_FLAGS | constants.O_CREAT | constants.O_EXCL,
      FILE_MODE,
    );
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.uid !== uid ||
      info.nlink !== 1 ||
      (existing && (info.mode & 0o7777) !== FILE_MODE)
    ) {
      fail();
    }
    if (existing) {
      const pathInfo = await lstat(filePath);
      if (
        !pathInfo.isFile() ||
        pathInfo.isSymbolicLink() ||
        pathInfo.dev !== info.dev ||
        pathInfo.ino !== info.ino
      ) {
        fail();
      }
      await handle.truncate(0);
    }
    if (!existing) await handle.chmod(FILE_MODE);
    await handle.writeFile(content);
    await handle.chmod(FILE_MODE);
    await handle.sync();
    const written = await handle.stat();
    if (
      !written.isFile() ||
      written.uid !== uid ||
      written.nlink !== 1 ||
      written.size !== content.byteLength ||
      (written.mode & 0o7777) !== FILE_MODE
    ) {
      fail();
    }
    const pathInfo = await lstat(filePath);
    if (
      !pathInfo.isFile() ||
      pathInfo.isSymbolicLink() ||
      pathInfo.dev !== written.dev ||
      pathInfo.ino !== written.ino
    ) {
      fail();
    }
  } finally {
    await handle?.close();
  }
}

async function prepare(layout: SecretLayout): Promise<void> {
  const uid = currentUid();
  const prepared: {
    volume: SecretVolume;
    contents: readonly { file: SecretFile; content: Buffer }[];
  }[] = [];

  for (const volume of VOLUMES) {
    const sourceMount = layout.sourceMounts[volume.name];
    if (!sourceMount) fail();
    prepared.push({ volume, contents: await readVolume(sourceMount, volume) });
  }

  await requireMountDirectory(layout.destinationMount);
  await requireMountDirectory(layout.temporaryMount);
  const destinationRoot = await ensurePrivateDirectory(layout.destinationMount, "private", uid);
  const temporaryRoot = await ensurePrivateDirectory(layout.temporaryMount, "private", uid);
  const outputDirectories = new Map<string, string>();
  for (const { volume } of prepared) {
    outputDirectories.set(
      volume.name,
      await ensurePrivateDirectory(destinationRoot, volume.name, uid),
    );
  }

  await assertExpectedEntries(
    destinationRoot,
    prepared.map(({ volume }) => volume.name),
    true,
  );
  for (const { volume, contents } of prepared) {
    const directory = outputDirectories.get(volume.name);
    if (!directory) fail();
    await assertExpectedEntries(
      directory,
      contents.map(({ file }) => file.name),
      false,
    );
    for (const { file } of contents) {
      await assertExistingOutputFile(path.join(directory, file.name), uid);
    }
  }

  for (const { volume, contents } of prepared) {
    const directory = outputDirectories.get(volume.name);
    if (!directory) fail();
    for (const { file, content } of contents) {
      await writePrivateFile(path.join(directory, file.name), content, uid);
    }
  }

  // BuildKit's configured temporary path points here; keep the mount root
  // writable for fsGroup while giving the worker a UID-owned private directory.
  const temporaryInfo = await lstat(temporaryRoot);
  if (
    !temporaryInfo.isDirectory() ||
    temporaryInfo.isSymbolicLink() ||
    temporaryInfo.uid !== uid ||
    (temporaryInfo.mode & 0o7777) !== DIRECTORY_MODE
  ) {
    fail();
  }
}

/** Copies only the fixed Kubernetes Secret projections used by the Build Worker. */
export async function prepareRuntimeSecrets(layout: SecretLayout = DEFAULT_LAYOUT): Promise<void> {
  try {
    await prepare(layout);
  } catch {
    throw new RuntimeSecretPreparationError();
  }
}

export async function main(): Promise<void> {
  if (process.argv.length !== 2) fail();
  await prepareRuntimeSecrets();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => {
    process.stderr.write("Build worker runtime secret preparation failed\n");
    process.exitCode = 1;
  });
}
