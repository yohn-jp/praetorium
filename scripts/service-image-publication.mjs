// Service-image preparation for deploy-platform; this module is not a second deploy CLI.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateInventory } from "../infrastructure/scripts/inventory.mjs";

// Same immutable inputs and Dockerfiles as the existing service verification/publication recipe.
export const serviceImages = [
  {
    service: "provisioner",
    key: "provisioner",
    dockerfile: "infrastructure/docker/service-runtime.Dockerfile",
  },
  {
    service: "instance-access",
    key: "instanceAccess",
    dockerfile: "infrastructure/docker/service-runtime.Dockerfile",
  },
  {
    service: "build-worker",
    key: "buildWorker",
    dockerfile: "infrastructure/docker/build-worker.Dockerfile",
  },
  {
    service: "coordination",
    key: "coordination",
    dockerfile: "infrastructure/docker/service-runtime.Dockerfile",
  },
];
const NODE_IMAGE =
  "docker.io/library/node@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5";
const BUILDKIT_IMAGE =
  "docker.io/moby/buildkit@sha256:b059f8d7226d0b326bc871af489a5dddf65e36af4d20d14251b072974d9ee87c";
const REPOSITORY = "yohn-jp/praetorium";
const DIGEST = /^sha256:[a-f0-9]{64}$/u;

export function assertSeparateRegistryCredentials(pull, publisher) {
  if (pull.password === publisher.password) {
    throw new Error("Registry pull and publication credentials must be separate");
  }
}

export function privateFile(filename, label) {
  if (typeof filename !== "string" || !path.isAbsolute(filename))
    throw new Error(`${label} requires an absolute path`);
  const meta = lstatSync(filename);
  if (
    !meta.isFile() ||
    meta.isSymbolicLink() ||
    (meta.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && meta.uid !== process.getuid())
  ) {
    throw new Error(`${label} must be an owner-only regular file`);
  }
  return filename;
}

function run(root, command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0)
    throw new Error(`${command} prerequisite failed (${result.error?.code ?? result.status})`);
  return result.stdout;
}

/** Deployment source must be the clean current main with all seven verification jobs passing. */
export function verifiedMain(root, execute = (command, args) => run(root, command, args)) {
  const revision = execute("git", ["rev-parse", "HEAD"]).trim();
  if (!/^[a-f0-9]{40}$/u.test(revision) || execute("git", ["status", "--porcelain"]).trim()) {
    throw new Error("Image publication requires a clean immutable checkout");
  }
  const remote = execute("git", ["remote", "get-url", "origin"]).trim();
  if (
    ![
      "https://github.com/yohn-jp/praetorium.git",
      "https://github.com/yohn-jp/praetorium",
      "git@github.com:yohn-jp/praetorium.git",
    ].includes(remote)
  ) {
    throw new Error("Image publication requires the canonical repository origin");
  }
  if (
    execute("git", ["ls-remote", "--exit-code", "origin", "refs/heads/main"]).split(/\s/u)[0] !==
    revision
  ) {
    throw new Error("Image publication requires current main");
  }
  const runs = JSON.parse(
    execute("gh", [
      "api",
      `repos/${REPOSITORY}/actions/workflows/publish-services.yml/runs?head_sha=${revision}&branch=main&event=push&per_page=10`,
    ]),
  );
  const ci = runs.workflow_runs?.find(
    (row) =>
      row.head_sha === revision &&
      row.head_branch === "main" &&
      row.event === "push" &&
      row.conclusion === "success",
  );
  if (!ci) throw new Error("Current main has no successful service verification CI run");
  const jobs = JSON.parse(
    execute("gh", ["api", `repos/${REPOSITORY}/actions/runs/${ci.id}/jobs?per_page=100`]),
  ).jobs;
  if (
    !Array.isArray(jobs) ||
    jobs.length !== 7 ||
    jobs.some((job) => job.conclusion !== "success") ||
    !["verify", "source-stable-fixture", "kubernetes-admission"].every((name) =>
      jobs.some((job) => job.name === name),
    ) ||
    !serviceImages.every(({ service }) =>
      jobs.some((job) => job.name.startsWith(`candidate-images (${service},`)),
    )
  ) {
    throw new Error("Current main requires all seven expected verification jobs to pass");
  }
  return { revision, ciRunId: ci.id, ciUrl: ci.html_url };
}

/** Preserve tracked source modes even when the operator protects credentials with umask 077. */
export function archiveServiceSource({ root, revision, archive, context }) {
  run(root, "git", [
    "-c",
    "tar.umask=0022",
    "archive",
    "--format=tar",
    `--output=${archive}`,
    revision,
  ]);
  run(root, "tar", ["-xpf", archive, "-C", context]);
}

export function buildctlConnectionArguments({ inventory, secrets, buildkitAddress }) {
  if (buildkitAddress !== undefined) {
    const address = new URL(buildkitAddress);
    if (
      address.protocol !== "tcp:" ||
      !["127.0.0.1", "[::1]"].includes(address.hostname) ||
      !address.port ||
      address.username ||
      address.password ||
      address.pathname ||
      address.search ||
      address.hash
    ) {
      throw new Error("BuildKit transport override must be an explicit loopback TCP tunnel");
    }
  }
  return [
    "--addr",
    buildkitAddress ?? inventory.buildkit.endpoint,
    // A local tunnel changes transport only. Authenticate the original Builder identity.
    "--tlsservername",
    new URL(inventory.buildkit.endpoint).hostname,
    "--tlscacert",
    secrets.buildkitClient.caKey,
    "--tlscert",
    secrets.buildkitClient.certKey,
    "--tlskey",
    secrets.buildkitClient.privateKey,
  ];
}

export function serviceBuildArguments({
  inventory,
  secrets,
  buildkitAddress,
  context,
  metadata,
  service,
  dockerfile,
  tag,
  revision,
}) {
  return [
    ...buildctlConnectionArguments({ inventory, secrets, buildkitAddress }),
    "build",
    "--progress=rawjson",
    "--frontend",
    "dockerfile.v0",
    "--local",
    `context=${context}`,
    "--local",
    `dockerfile=${context}`,
    "--opt",
    `filename=${dockerfile}`,
    "--opt",
    "platform=linux/amd64",
    "--opt",
    `build-arg:NODE_BUILD_IMAGE=${NODE_IMAGE}`,
    "--opt",
    `build-arg:NODE_RUNTIME_IMAGE=${NODE_IMAGE}`,
    "--opt",
    `build-arg:BUILDKIT_CLIENT_IMAGE=${BUILDKIT_IMAGE}`,
    "--opt",
    "build-arg:BUILDKIT_CLIENT_BUILDCTL_PATH=/usr/bin/buildctl",
    "--opt",
    "build-arg:PRAETORIUM_BUILDKIT_BUILDCTL_PATH=/usr/local/bin/buildctl",
    "--opt",
    `build-arg:SERVICE_PACKAGE=@praetorium/${service}`,
    "--opt",
    `label:org.opencontainers.image.revision=${revision}`,
    "--opt",
    `label:org.opencontainers.image.source=https://github.com/${REPOSITORY}`,
    "--opt",
    "attest:provenance=mode=max",
    "--output",
    `type=image,name=ghcr.io/${REPOSITORY}/${service}:${tag},push=true,oci-mediatypes=true`,
    "--metadata-file",
    metadata,
  ];
}

/** All four must verify before a candidate inventory can be returned. */
export async function prepareServiceImages({
  inventory,
  source,
  registry,
  build,
  directory,
  record = () => {},
}) {
  if (!/^[a-f0-9]{40}$/u.test(source.revision)) throw new Error("Invalid publication revision");
  const result = structuredClone(inventory);
  for (const { service, key } of serviceImages) {
    const current = inventory.images[key];
    if (current != null && !current.startsWith(`ghcr.io/${REPOSITORY}/${service}@sha256:`)) {
      throw new Error(
        `Existing ${service} repository differs from the canonical publication destination`,
      );
    }
  }
  const tag = `source-${source.revision}-${randomUUID()}`;
  const images = {};
  for (const image of serviceImages) {
    const repository = `${REPOSITORY}/${image.service}`;
    try {
      await registry.discoverTag(repository, tag);
      throw new Error("Refusing to replace an existing service publication tag");
    } catch (error) {
      if (error.reason !== "not_found") throw error;
    }
    const metadata = path.join(directory, `${image.service}.json`);
    await build({ ...image, tag, metadata });
    const meta = lstatSync(metadata);
    if (!meta.isFile() || meta.isSymbolicLink() || meta.size > 1024 * 1024)
      throw new Error("Invalid BuildKit metadata file");
    const digest = JSON.parse(readFileSync(metadata, "utf8"))["containerimage.digest"];
    if (!DIGEST.test(digest ?? "")) throw new Error("BuildKit returned an invalid image digest");
    const discovered = await registry.discoverTag(repository, tag);
    if (discovered.digest !== digest) throw new Error("Published tag differs from BuildKit digest");
    const verified = await registry.verifyImage(repository, digest, {
      os: "linux",
      architecture: "amd64",
    });
    if (
      verified.manifestDigest !== digest ||
      verified.repository !== repository ||
      verified.platform.os !== "linux" ||
      verified.platform.architecture !== "amd64"
    ) {
      throw new Error("Published image identity/platform mismatch");
    }
    const config = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        (await registry.readBlob(repository, verified.configDigest, 1024 * 1024)).bytes,
      ),
    );
    if (
      config.config?.Labels?.["org.opencontainers.image.revision"] !== source.revision ||
      config.config?.Labels?.["org.opencontainers.image.source"] !==
        `https://github.com/${REPOSITORY}`
    ) {
      throw new Error("Published image source identity mismatch");
    }
    result.images[image.key] = `ghcr.io/${repository}@${digest}`;
    images[image.service] = { tag, reference: result.images[image.key], ...verified };
    record({ ...source, images: structuredClone(images), complete: false });
  }
  const checked = validateInventory(result);
  if (checked.errors.length || checked.blockers.length)
    throw new Error("Published service inventory is invalid");
  const receipt = {
    schema: "praetorium.service-image-publication/v1",
    ...source,
    nodeImage: NODE_IMAGE,
    buildkitClientImage: BUILDKIT_IMAGE,
    buildkitProvenance: "REQUESTED_NOT_INDEPENDENTLY_VERIFIED",
    images,
    complete: true,
  };
  record(receipt);
  return { inventory: result, receipt };
}

/** Preflight the complete candidate before changing the existing inventory. Keep its exact old bytes. */
export async function admitServiceInventory({ inventoryPath, original, candidate, preflight }) {
  privateFile(inventoryPath, "deployment inventory");
  const stage = `${inventoryPath}.candidate-${randomUUID()}`;
  const backup = `${inventoryPath}.before-publication-${randomUUID()}`;
  try {
    writeFileSync(stage, JSON.stringify(candidate, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await preflight(stage);
    privateFile(inventoryPath, "deployment inventory");
    if (!readFileSync(inventoryPath).equals(original))
      throw new Error("Inventory changed during service publication");
    writeFileSync(backup, original, { mode: 0o600, flag: "wx" });
    const backupFd = openSync(backup, "r+");
    try {
      fsyncSync(backupFd);
    } finally {
      closeSync(backupFd);
    }
    const fd = openSync(stage, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(stage, inventoryPath);
    const parentFd = openSync(path.dirname(inventoryPath), "r");
    try {
      fsyncSync(parentFd);
    } finally {
      closeSync(parentFd);
    }
    return backup;
  } finally {
    rmSync(stage, { force: true });
  }
}

export async function publishPlatformImages({
  root,
  inventoryPath,
  secretFilesPath,
  buildctlPath,
  buildkitAddress,
  preflight,
}) {
  const source = verifiedMain(root);
  privateFile(inventoryPath, "deployment inventory");
  let directory;
  try {
    directory = mkdtempSync(path.join(path.dirname(inventoryPath), ".service-publication-"));
    const original = readFileSync(inventoryPath);
    const inventory = JSON.parse(original);
    const secrets = JSON.parse(
      readFileSync(privateFile(secretFilesPath, "secret manifest")),
    ).values;
    for (const [key, filename] of Object.entries(secrets.buildkitClient ?? {}))
      privateFile(filename, `BuildKit ${key}`);
    privateFile(secrets.buildWorkerRegistryPush, "registry push config");
    const { readRegistryPullCredential } = await import(
      pathToFileURL(path.join(root, "apps/build-worker/dist/registry-credential.js"))
    );
    const { GhcrRegistryClient } = await import(
      pathToFileURL(path.join(root, "plugins/ghcr/dist/index.js"))
    );
    const { createBuildctlRunner, validateRegistryAuth, readBuildKitRegistryCredential } =
      await import(pathToFileURL(path.join(root, "plugins/buildkit/dist/index.js")));
    const pullCredential = await readRegistryPullCredential(secrets.buildWorkerRegistryPull);
    const registry = new GhcrRegistryClient({
      pullCredential,
      allowedRepositories: serviceImages.map(({ service }) => `${REPOSITORY}/${service}`),
      maxImageLayerBytes: inventory.buildPolicy.maxImageLayerBytes,
      maxImageVerificationMs: inventory.buildPolicy.maxImageVerificationMs,
      maxRegistryRequestMs: inventory.buildPolicy.maxRegistryRequestMs,
    });
    const context = path.join(directory, "context");
    const dockerConfigDirectory = path.join(directory, "docker");
    mkdirSync(context, { mode: 0o700 });
    mkdirSync(dockerConfigDirectory, { mode: 0o700 });
    writeFileSync(
      path.join(dockerConfigDirectory, "config.json"),
      readFileSync(secrets.buildWorkerRegistryPush),
      { mode: 0o600 },
    );
    const registryConfig = {
      dockerConfigDirectory,
      outputRepository: `ghcr.io/${REPOSITORY}/build-worker`,
      buildkitRepository: `ghcr.io/${REPOSITORY}/build-worker`,
    };
    await validateRegistryAuth(registryConfig);
    assertSeparateRegistryCredentials(
      pullCredential,
      await readBuildKitRegistryCredential(registryConfig, "ghcr.io"),
    );
    const archive = path.join(directory, "source.tar");
    archiveServiceSource({ root, revision: source.revision, archive, context });
    const runner = createBuildctlRunner({ buildctlPath });
    console.log("Checking Builder mTLS connectivity before publication...");
    await runner(
      [...buildctlConnectionArguments({ inventory, secrets, buildkitAddress }), "debug", "workers"],
      {
        cwd: context,
        dockerConfigDirectory,
        temporaryDirectory: directory,
        safePath: process.env.PATH,
        buildTimeoutMs: 30_000,
        maxProgressBytes: 1024 * 1024,
        signal: AbortSignal.timeout(30_000),
        onProgress: () => {},
      },
    );
    const receiptPath = `${inventoryPath}.publication-${source.revision}-${randomUUID()}.json`;
    const prepared = await prepareServiceImages({
      inventory,
      source,
      registry,
      directory,
      record: (receipt) =>
        writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 }),
      build: async (image) => {
        console.log(`Building and publishing ${image.service} from ${source.revision}...`);
        await runner(
          serviceBuildArguments({
            inventory,
            secrets,
            buildkitAddress,
            context,
            revision: source.revision,
            ...image,
          }),
          {
            cwd: context,
            dockerConfigDirectory,
            temporaryDirectory: directory,
            safePath: process.env.PATH,
            buildTimeoutMs: 90 * 60_000,
            maxProgressBytes: 16 * 1024 * 1024,
            signal: AbortSignal.timeout(90 * 60_000),
            onProgress: () => {},
          },
        );
      },
    });
    const backup = await admitServiceInventory({
      inventoryPath,
      original,
      candidate: prepared.inventory,
      preflight: async (candidate) => {
        await preflight(candidate);
        // Recheck after both the long build and the candidate's remote preflights.
        if (verifiedMain(root).revision !== source.revision)
          throw new Error("Main changed during publication");
      },
    });
    console.log(`Verified four service images. Prior inventory retained at ${backup}`);
    console.log(`Publication receipt: ${receiptPath}`);
    return prepared.receipt;
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}

/** Keep a second local deployment from publishing/admitting another inventory during rollout. */
export async function withDeploymentLock(inventoryPath, action) {
  privateFile(inventoryPath, "deployment inventory");
  const lock = `${inventoryPath}.deploy-lock`;
  const fd = openSync(lock, "wx", 0o600);
  try {
    writeFileSync(
      fd,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + "\n",
    );
    return await action();
  } finally {
    closeSync(fd);
    rmSync(lock, { force: true });
  }
}
