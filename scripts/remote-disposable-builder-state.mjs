import { chmod, link, lstat, open, readFile, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";

export const BUILDER_OWNER = Object.freeze({
  schema: "praetorium.t14-builder-owner/v1",
  owner: "praetorium-t14",
  image: "/var/lib/praetorium-t14/state.img",
  imageBytes: 6 * 1024 ** 3,
  mount: "/var/lib/praetorium-t14/state",
  mountUnit: "var-lib-praetorium\\x2dt14-state.mount",
  sliceUnit: "praetorium-t14.slice",
  testBuildkitUnit: "praetorium-buildkit-t14.service",
  cluster: "praetorium-t14-canary",
  context: "kind-praetorium-t14-canary",
  buildkitHostPort: 1235,
});
export const BUILDER_JOURNAL = Object.freeze({
  schema: "praetorium.t14-builder-setup-journal/v1",
  owner: "praetorium-t14",
  base: "/var/lib/praetorium-t14",
  image: "/var/lib/praetorium-t14/state.img",
  mount: "/var/lib/praetorium-t14/state",
  mountUnit: "var-lib-praetorium\\x2dt14-state.mount",
  sliceUnit: "praetorium-t14.slice",
  cluster: "praetorium-t14-canary",
});
export const BUILDER_CGROUP_RECEIPT = Object.freeze({
  schema: "praetorium.t14-cgroup-verification/v1",
  owner: "praetorium-t14",
  sliceUnit: "praetorium-t14.slice",
  cluster: "praetorium-t14-canary",
  cpuMax: "200000 100000",
  memoryMax: "4294967296",
  pidsMax: "2048",
});
const JOURNAL_STAGES = ["reserved", "account", "image", "units", "mounted", "ready"];

const hashPattern = /^[a-f0-9]{64}$/u;

export function createOwnerMarker({
  filesystemUuid,
  mountUnitSha256,
  sliceUnitSha256,
  ownerUid,
  ownerGid,
  now = new Date(),
}) {
  if (typeof filesystemUuid !== "string" || !/^[a-f0-9-]{16,64}$/iu.test(filesystemUuid))
    throw new Error("filesystem UUID is invalid");
  if (!hashPattern.test(mountUnitSha256) || !hashPattern.test(sliceUnitSha256))
    throw new Error("systemd unit hashes are invalid");
  if (
    !Number.isSafeInteger(ownerUid) ||
    ownerUid < 1 ||
    !Number.isSafeInteger(ownerGid) ||
    ownerGid < 1
  )
    throw new Error("owner UID/GID are invalid");
  return {
    ...BUILDER_OWNER,
    ownerUid,
    ownerGid,
    subidStart: 3000000,
    subidCount: 65536,
    filesystemUuid,
    mountUnitSha256,
    sliceUnitSha256,
    expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  };
}

export function validateOwnerMarker(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("owner marker must be a JSON object");
  for (const [key, expected] of Object.entries(BUILDER_OWNER)) {
    if (value[key] !== expected)
      throw new Error(`owner marker ${key} does not match the T14 contract`);
  }
  if (
    typeof value.filesystemUuid !== "string" ||
    !/^[a-f0-9-]{16,64}$/iu.test(value.filesystemUuid)
  )
    throw new Error("owner marker filesystem UUID is invalid");
  if (!hashPattern.test(value.mountUnitSha256) || !hashPattern.test(value.sliceUnitSha256))
    throw new Error("owner marker unit hash is invalid");
  if (
    !Number.isSafeInteger(value.ownerUid) ||
    value.ownerUid < 1 ||
    !Number.isSafeInteger(value.ownerGid) ||
    value.ownerGid < 1
  )
    throw new Error("owner marker UID/GID is invalid");
  if (value.subidStart !== 3000000 || value.subidCount !== 65536)
    throw new Error("owner marker subordinate ID allocation is invalid");
  if (typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt)))
    throw new Error("owner marker expiry is invalid");
  return value;
}

export function createBuilderJournal(stage = "reserved") {
  if (!JOURNAL_STAGES.includes(stage)) throw new Error("setup journal stage is invalid");
  return { ...BUILDER_JOURNAL, stage, uid: null, gid: null, filesystemUuid: null };
}

export function renderMountUnit() {
  return `[Unit]\nDescription=Praetorium T14 bounded disposable state\nBefore=praetorium-t14.slice\n\n[Mount]\nWhat=${BUILDER_OWNER.image}\nWhere=${BUILDER_OWNER.mount}\nType=ext4\nOptions=loop,nodev,nosuid\n\n[Install]\nWantedBy=multi-user.target\n`;
}

export function renderSliceUnit() {
  return `[Unit]\nDescription=Praetorium T14 disposable resource ceiling\n\n[Slice]\nCPUAccounting=yes\nCPUQuota=200%\nMemoryAccounting=yes\nMemoryMax=4G\nTasksAccounting=yes\nTasksMax=2048\n`;
}

export function createCgroupReceipt({ ownerUid, sliceUnitSha256, now = new Date() }) {
  if (!Number.isSafeInteger(ownerUid) || ownerUid < 1 || !hashPattern.test(sliceUnitSha256))
    throw new Error("cgroup verification ownership is invalid");
  return {
    ...BUILDER_CGROUP_RECEIPT,
    ownerUid,
    sliceUnitSha256,
    capturedAt: now.toISOString(),
  };
}

export function validateCgroupReceipt(value, { ownerUid, sliceUnitSha256 } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("cgroup receipt must be a JSON object");
  for (const [key, expected] of Object.entries(BUILDER_CGROUP_RECEIPT)) {
    if (value[key] !== expected)
      throw new Error(`cgroup receipt ${key} differs from the T14 limits`);
  }
  if (
    !Number.isSafeInteger(value.ownerUid) ||
    value.ownerUid < 1 ||
    !hashPattern.test(value.sliceUnitSha256)
  )
    throw new Error("cgroup receipt ownership is invalid");
  if (ownerUid !== undefined && value.ownerUid !== ownerUid)
    throw new Error("cgroup receipt owner UID differs from owner marker");
  if (sliceUnitSha256 !== undefined && value.sliceUnitSha256 !== sliceUnitSha256)
    throw new Error("cgroup receipt slice hash differs from owner marker");
  const capturedAt =
    typeof value.capturedAt === "string" ? Date.parse(value.capturedAt) : Number.NaN;
  if (!Number.isFinite(capturedAt)) throw new Error("cgroup receipt capture time is invalid");
  if (capturedAt > Date.now() + 5 * 60 * 1000 || Date.now() - capturedAt > 60 * 60 * 1000)
    throw new Error("cgroup receipt is stale or from the future");
  return value;
}

export function validateBuilderJournal(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("setup journal must be a JSON object");
  for (const [key, expected] of Object.entries(BUILDER_JOURNAL)) {
    if (value[key] !== expected)
      throw new Error(`setup journal ${key} does not match the T14 contract`);
  }
  if (!JOURNAL_STAGES.includes(value.stage)) throw new Error("setup journal stage is invalid");
  if (value.uid !== null && (!Number.isSafeInteger(value.uid) || value.uid < 1))
    throw new Error("setup journal uid is invalid");
  if (value.gid !== null && (!Number.isSafeInteger(value.gid) || value.gid < 1))
    throw new Error("setup journal gid is invalid");
  const stageIndex = JOURNAL_STAGES.indexOf(value.stage);
  if (stageIndex >= 1 && (value.uid === null || value.gid === null))
    throw new Error("setup journal account identity is missing for its stage");
  if (
    value.filesystemUuid !== null &&
    (typeof value.filesystemUuid !== "string" || !/^[a-f0-9-]{16,64}$/iu.test(value.filesystemUuid))
  )
    throw new Error("setup journal UUID is invalid");
  if (stageIndex >= 2 && value.filesystemUuid === null)
    throw new Error("setup journal filesystem UUID is missing for its stage");
  return value;
}

async function writePrivateJson(filePath, value, { exclusive }) {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(directory, `.praetorium-t14-${process.pid}-${Date.now()}.tmp`);
  const data = `${JSON.stringify(value)}\n`;
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(data, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    if (exclusive) {
      await link(temporaryPath, filePath);
      await unlink(temporaryPath);
    } else {
      await rename(temporaryPath, filePath);
    }
    await chmod(filePath, 0o600);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function readBuilderJournal(filePath) {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o077) !== 0)
    throw new Error("setup journal must be a root-owned private regular file");
  return validateBuilderJournal(JSON.parse(await readFile(filePath, "utf8")));
}

async function updateJournal(filePath, stage, uidText, gidText, filesystemUuid) {
  const current = await readBuilderJournal(filePath);
  const oldIndex = JOURNAL_STAGES.indexOf(current.stage);
  const newIndex = JOURNAL_STAGES.indexOf(stage);
  if (newIndex < 0) throw new Error("setup journal stage is invalid");
  const next = {
    ...current,
    stage: newIndex < oldIndex ? current.stage : stage,
    uid: uidText ? Number(uidText) : current.uid,
    gid: gidText ? Number(gidText) : current.gid,
    filesystemUuid: filesystemUuid || current.filesystemUuid,
  };
  validateBuilderJournal(next);
  await writePrivateJson(filePath, next, { exclusive: false });
}

export async function readCgroupReceipt(filePath, expected) {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o077) !== 0)
    throw new Error("cgroup receipt must be root-owned and private");
  return validateCgroupReceipt(JSON.parse(await readFile(filePath, "utf8")), expected);
}

export async function writeCgroupReceipt(filePath, receipt) {
  validateCgroupReceipt(receipt);
  try {
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o077) !== 0)
      throw new Error("existing cgroup receipt path is not a root-owned private regular file");
    await writePrivateJson(filePath, receipt, { exclusive: false });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await writePrivateJson(filePath, receipt, { exclusive: true });
  }
}

export async function writeOwnerMarker(markerPath, marker) {
  validateOwnerMarker(marker);
  const directory = path.dirname(markerPath);
  const temporaryPath = path.join(directory, `.owner-${process.pid}-${Date.now()}.tmp`);
  const data = `${JSON.stringify(marker)}\n`;
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(data, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await link(temporaryPath, markerPath);
    await unlink(temporaryPath);
    await chmod(markerPath, 0o600);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function readOwnerMarker(markerPath) {
  const info = await lstat(markerPath);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o077) !== 0)
    throw new Error("owner marker must be a root-owned private regular file");
  const value = JSON.parse(await readFile(markerPath, "utf8"));
  return validateOwnerMarker(value);
}

async function main(argv) {
  const [action, markerPath, filesystemUuid, mountHash, sliceHash, ownerUid, ownerGid] = argv;
  if (
    action === "write" &&
    markerPath &&
    filesystemUuid &&
    mountHash &&
    sliceHash &&
    ownerUid &&
    ownerGid
  ) {
    await writeOwnerMarker(
      markerPath,
      createOwnerMarker({
        filesystemUuid,
        mountUnitSha256: mountHash,
        sliceUnitSha256: sliceHash,
        ownerUid: Number(ownerUid),
        ownerGid: Number(ownerGid),
      }),
    );
    return;
  }
  if (action === "validate" && markerPath && argv.length === 2) {
    await readOwnerMarker(markerPath);
    return;
  }
  if (action === "journal-init" && markerPath && argv.length === 2) {
    await writePrivateJson(markerPath, createBuilderJournal(), { exclusive: true });
    return;
  }
  if (action === "journal-validate" && markerPath && argv.length === 2) {
    await readBuilderJournal(markerPath);
    return;
  }
  if (action === "journal-stage" && markerPath && argv.length >= 3) {
    await updateJournal(markerPath, argv[2], argv[3], argv[4], argv[5]);
    return;
  }
  if (action === "journal-remove" && markerPath && argv.length === 2) {
    const journal = await readBuilderJournal(markerPath);
    if (journal.stage !== "ready") throw new Error("setup journal is not at the ready stage");
    await unlink(markerPath);
    return;
  }
  if (action === "render-mount" && argv.length === 1) {
    process.stdout.write(renderMountUnit());
    return;
  }
  if (action === "render-slice" && argv.length === 1) {
    process.stdout.write(renderSliceUnit());
    return;
  }
  if (action === "cgroup-write" && markerPath && filesystemUuid && mountHash) {
    const ownerUid = Number(filesystemUuid);
    const receipt = createCgroupReceipt({ ownerUid, sliceUnitSha256: mountHash });
    await writeCgroupReceipt(markerPath, receipt);
    return;
  }
  if (action === "cgroup-validate" && markerPath && filesystemUuid && mountHash) {
    await readCgroupReceipt(markerPath, {
      ownerUid: Number(filesystemUuid),
      sliceUnitSha256: mountHash,
    });
    return;
  }
  throw new Error(
    "usage: remote-disposable-builder-state.mjs write|validate|journal-init|journal-validate|journal-stage|journal-remove|render-mount|render-slice|cgroup-write|cgroup-validate <path> [fields]",
  );
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`BLOCKED: ${error.message}\n`);
    process.exitCode = 1;
  });
}
