#!/usr/bin/env node

import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TOOL = Object.freeze({
  buildkitd: "/nix/store/1032gvcwdf4q6zyx7bhircpf2vcsp1za-buildkit-0.30.0/bin/buildkitd",
  buildctl: "/nix/store/1032gvcwdf4q6zyx7bhircpf2vcsp1za-buildkit-0.30.0/bin/buildctl",
  podman: "/nix/store/ml8x1jki0s2s18923xp603wiz731s871-podman-5.8.8/bin/podman",
  runc: "/nix/store/hyq7l7806idfdy8jg0nl8ffhx5dz696z-docker-runc-29.5.3/bin/runc",
  slirp4netns: "/nix/store/458z7r5nixqv9c3k4dq88x6x90il48jh-slirp4netns-1.3.3/bin/slirp4netns",
  unshare: "/run/current-system/sw/bin/unshare",
});

const REGISTRY_IMAGE =
  "docker.io/library/registry@sha256:5b12b22f21522fe69443079df04c0f3f42cb9977857f3c20404386652a6c6d8e";
const REGISTRY_CONTAINER = "praetorium-owned-registry";
const OWNER_SCHEMA = "praetorium.local-disposable-owner/v1";

function cli(argv) {
  if (argv.length === 1 && argv[0] === "--plan") return { mode: "plan", keep: false };
  if (argv.length === 1 && argv[0] === "--run") return { mode: "run", keep: false };
  if (argv.length === 2 && argv[0] === "--run" && argv[1] === "--keep")
    return { mode: "run", keep: true };
  if (argv.length === 2 && argv[0] === "--cleanup" && path.isAbsolute(argv[1]))
    return { mode: "cleanup", root: argv[1] };
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) return { mode: "help" };
  throw new Error(
    "usage: node scripts/local-disposable-environment.mjs --plan | --run [--keep] | --cleanup <absolute-owned-temp-root>",
  );
}

function privateEnvironment(root) {
  const systemPaths = ["/run/current-system/sw/bin", "/run/wrappers/bin"];
  return {
    PATH: [
      ...new Set([...Object.values(TOOL).map((binary) => path.dirname(binary)), ...systemPaths]),
    ].join(path.delimiter),
    HOME: root,
    USER: process.env.USER ?? `uid-${process.getuid()}`,
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? `uid-${process.getuid()}`,
    LANG: "C.UTF-8",
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_RUNTIME_DIR: path.join(root, "runtime"),
    TMPDIR: path.join(root, "t"),
    DOCKER_CONFIG: path.join(root, "config", "docker"),
    CONTAINERS_CONF: path.join(root, "config", "containers", "containers.conf"),
    CONTAINERS_STORAGE_CONF: path.join(root, "config", "containers", "storage.conf"),
    REGISTRY_AUTH_FILE: path.join(root, "config", "containers", "auth.json"),
    CONTAINERS_REGISTRIES_CONF: path.join(root, "config", "containers", "registries.conf"),
  };
}

function podmanArgs(root) {
  return [
    "--root",
    path.join(root, "storage", "podman-graphroot"),
    "--runroot",
    path.join(root, "storage", "podman-runroot"),
    "--tmpdir",
    path.join(root, "t"),
    "--storage-driver=vfs",
    "--events-backend=file",
  ];
}

async function run(command, args, options = {}) {
  const { env, cwd, logPath, captureLimit = 2_000_000 } = options;
  let output = "";
  const child = spawn(command, args, {
    cwd,
    env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const collect = (chunk) => {
    if (output.length < captureLimit)
      output += chunk.toString("utf8").slice(0, captureLimit - output.length);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  if (logPath) await writeFile(logPath, output, { mode: 0o600 });
  if (result.code !== 0) {
    throw new Error(
      `${path.basename(command)} exited ${result.code ?? `on ${result.signal}`}: ${output.trim().slice(-1200)}`,
    );
  }
  return output.trim();
}

async function waitFor(check, description, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(
    `${description} did not become ready${lastError ? `: ${lastError.message}` : ""}`,
  );
}

async function freeLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("could not allocate a loopback port");
  const { port } = address;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function createRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "praetorium-owned-"));
  await chmod(root, 0o700);
  for (const directory of [
    "config/containers",
    "config/docker",
    "config/podman-network",
    "config/buildkit",
    "cache",
    "data",
    "state",
    "runtime",
    "logs",
    "input",
    "storage/podman-graphroot",
    "storage/podman-runroot",
    "storage/buildkit",
    "t",
  ]) {
    await mkdir(path.join(root, directory), { recursive: true, mode: 0o700 });
  }
  await chmod(path.join(root, "runtime"), 0o700);
  await chmod(path.join(root, "t"), 0o700);

  const config = `[containers]\nlog_driver = "k8s-file"\npids_limit = 65536\n\n[engine]\ncgroup_manager = "cgroupfs"\nevents_logger = "file"\nruntime = "${TOOL.runc}"\nnetwork_cmd_path = "${TOOL.slirp4netns}"\ntmp_dir = "${path.join(root, "t")}"\n\n[network]\nnetwork_backend = "netavark"\nnetwork_config_dir = "${path.join(root, "config", "podman-network")}"\n`;
  await writeFile(path.join(root, "config", "containers", "containers.conf"), config, {
    mode: 0o600,
  });
  const storageConfig = `[storage]\ndriver = "vfs"\nrunroot = "${path.join(root, "storage", "podman-runroot")}"\ngraphroot = "${path.join(root, "storage", "podman-graphroot")}"\n`;
  await writeFile(path.join(root, "config", "containers", "storage.conf"), storageConfig, {
    mode: 0o600,
  });
  await writeFile(
    path.join(root, "config", "containers", "registries.conf"),
    'unqualified-search-registries = ["docker.io"]\nshort-name-mode = "disabled"\n',
    { mode: 0o600 },
  );
  await writeFile(path.join(root, "config", "containers", "auth.json"), "{}\n", {
    mode: 0o600,
  });
  await writeFile(
    path.join(root, "config", "containers", "policy.json"),
    `${JSON.stringify(
      {
        default: [{ type: "reject" }],
        transports: {
          docker: {
            "docker.io/library/registry": [{ type: "insecureAcceptAnything" }],
          },
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  return root;
}

async function assertTools() {
  for (const binary of Object.values(TOOL)) await access(binary, fsConstants.X_OK);
}

async function pullAndStartRegistry(root, env) {
  const baseArgs = podmanArgs(root);
  const port = await freeLoopbackPort();
  await run(
    TOOL.podman,
    [
      ...baseArgs,
      "image",
      "pull",
      "--signature-policy",
      path.join(root, "config", "containers", "policy.json"),
      REGISTRY_IMAGE,
    ],
    { env, logPath: path.join(root, "logs", "registry-pull.log") },
  );
  await run(
    TOOL.podman,
    [
      ...baseArgs,
      "run",
      "--pull=never",
      "--rm",
      "--detach",
      "--name",
      REGISTRY_CONTAINER,
      "--userns=host",
      "--network=host",
      "--env",
      `REGISTRY_HTTP_ADDR=127.0.0.1:${port}`,
      REGISTRY_IMAGE,
    ],
    { env, logPath: path.join(root, "logs", "registry-start.log") },
  );
  const registryUrl = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    const response = await fetch(`${registryUrl}/v2/`);
    return response.status === 200 ? registryUrl : false;
  }, "loopback OCI registry");
  return { registryUrl, registryImage: REGISTRY_IMAGE };
}

async function startBuildkit(root, env, registryUrl, recordProcessGroupId) {
  const socket = path.join(root, "runtime", "buildkit.sock");
  const port = new URL(registryUrl).port;
  const configPath = path.join(root, "config", "buildkit", "buildkitd.toml");
  await writeFile(configPath, `[registry."127.0.0.1:${port}"]\n  http = true\n`, {
    mode: 0o600,
  });
  const stdout = await open(path.join(root, "logs", "buildkitd.stdout.log"), "w", 0o600);
  const stderr = await open(path.join(root, "logs", "buildkitd.stderr.log"), "w", 0o600);
  let child;
  try {
    child = spawn(
      TOOL.unshare,
      [
        "--user",
        "--map-root-user",
        "--mount",
        "--propagation",
        "private",
        TOOL.buildkitd,
        "--rootless",
        `--addr=unix://${socket}`,
        `--root=${path.join(root, "storage", "buildkit")}`,
        `--config=${configPath}`,
      ],
      { env, detached: true, shell: false, stdio: ["ignore", stdout.fd, stderr.fd] },
    );
  } finally {
    await Promise.all([stdout.close(), stderr.close()]);
  }
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    setTimeout(resolve, 100);
  });
  if (!child.pid) throw new Error("BuildKit namespace process did not start");
  await recordProcessGroupId(child.pid);
  child.unref();
  try {
    await waitFor(async () => {
      try {
        await run(TOOL.buildctl, [`--addr=unix://${socket}`, "debug", "workers"], {
          env,
          logPath: path.join(root, "logs", "buildkit-workers.log"),
        });
        return true;
      } catch {
        return false;
      }
    }, "rootless BuildKit worker");
  } catch (error) {
    const daemonLog = await readFile(path.join(root, "logs", "buildkitd.stderr.log"), "utf8");
    const clientLog = await readFile(path.join(root, "logs", "buildkit-workers.log"), "utf8").catch(
      () => "",
    );
    throw new Error(
      `${error.message}; BuildKit daemon: ${daemonLog.trim().slice(-1000) || "no stderr output"}; buildctl probe: ${clientLog.trim().slice(-500) || "no output"}`,
    );
  }
  return { socket, processGroupId: child.pid };
}

async function verifyBuild(root, env, registryUrl, socket) {
  const input = path.join(root, "input");
  await writeFile(path.join(input, "Dockerfile"), "FROM scratch\nCOPY note.txt /note.txt\n", {
    mode: 0o600,
  });
  await writeFile(path.join(input, "note.txt"), "local disposable substrate smoke\n", {
    mode: 0o600,
  });
  const image = `${new URL(registryUrl).host}/praetorium-substrate/smoke:probe-nocache`;
  const metadataPath = path.join(root, "logs", "build-metadata.json");
  await run(
    TOOL.buildctl,
    [
      `--addr=unix://${socket}`,
      "build",
      "--no-cache",
      "--frontend",
      "dockerfile.v0",
      "--local",
      `context=${input}`,
      "--local",
      `dockerfile=${input}`,
      "--output",
      `type=image,name=${image},push=true`,
      "--metadata-file",
      metadataPath,
    ],
    { env, logPath: path.join(root, "logs", "buildctl.log") },
  );

  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  const tag = image.split(":").at(-1);
  const repository = image.slice(0, image.lastIndexOf(":"));
  const manifestResponse = await fetch(
    `${registryUrl}/v2/${repository.slice(new URL(registryUrl).host.length + 1)}/manifests/${tag}`,
    {
      headers: {
        Accept:
          "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
      },
    },
  );
  if (!manifestResponse.ok)
    throw new Error(`registry manifest GET returned ${manifestResponse.status}`);
  const manifestBytes = Buffer.from(await manifestResponse.arrayBuffer());
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const manifestDigest = `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`;
  if (manifestDigest !== metadata["containerimage.digest"])
    throw new Error("BuildKit metadata digest did not match the registry manifest bytes");
  const expectedHeader = manifestResponse.headers.get("docker-content-digest");
  if (expectedHeader !== manifestDigest) throw new Error("registry content digest header mismatch");

  const blobs = [];
  for (const descriptor of [manifest.config, ...manifest.layers]) {
    const digestHex = descriptor.digest.replace(/^sha256:/, "");
    const response = await fetch(
      `${registryUrl}/v2/${repository.slice(new URL(registryUrl).host.length + 1)}/blobs/${descriptor.digest}`,
    );
    if (!response.ok) throw new Error(`registry blob GET returned ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const actualDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (actualDigest !== descriptor.digest || bytes.length !== descriptor.size)
      throw new Error(`registry blob verification failed for ${descriptor.digest}`);
    blobs.push({ digest: actualDigest, size: bytes.length, verified: digestHex.length === 64 });
  }
  return {
    image,
    manifestDigest,
    configDigest: manifest.config.digest,
    layerDigests: manifest.layers.map((layer) => layer.digest),
    blobs,
    manifestSize: manifestBytes.length,
  };
}

async function readOwnerRecord(root) {
  const tempRoot = await realpath(os.tmpdir());
  const actualRoot = await realpath(root);
  const rootStat = await stat(actualRoot);
  if (
    path.dirname(actualRoot) !== tempRoot ||
    !path.basename(actualRoot).startsWith("praetorium-owned-") ||
    rootStat.uid !== process.getuid() ||
    (rootStat.mode & 0o077) !== 0
  ) {
    throw new Error(
      "refusing cleanup: path is not a private, current-user praetorium-owned temp root",
    );
  }
  const ownerPath = path.join(actualRoot, "owner.json");
  const owner = JSON.parse(await readFile(ownerPath, "utf8"));
  if (
    owner.schema !== OWNER_SCHEMA ||
    owner.root !== actualRoot ||
    owner.ownerUid !== process.getuid() ||
    owner.disposable !== true ||
    owner.production !== false ||
    typeof owner.registryStarted !== "boolean" ||
    typeof owner.podmanInitialized !== "boolean" ||
    (owner.buildkitProcessGroupId !== null &&
      (!Number.isSafeInteger(owner.buildkitProcessGroupId) || owner.buildkitProcessGroupId <= 1))
  ) {
    throw new Error("refusing cleanup: ownership record does not match this process and temp root");
  }
  return { root: actualRoot, owner };
}

async function stopBuildkitProcessGroup(root, processGroupId) {
  let commandLine;
  try {
    commandLine = (await readFile(`/proc/${processGroupId}/cmdline`)).toString("utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    try {
      process.kill(-processGroupId, 0);
    } catch (groupError) {
      if (groupError.code === "ESRCH") return;
      throw groupError;
    }
    throw new Error(
      "refusing cleanup: BuildKit process group remains but its recorded leader is gone",
    );
  }
  if (!commandLine.includes(path.join(root, "runtime", "buildkit.sock"))) {
    throw new Error(
      "refusing to stop BuildKit: recorded process no longer matches the owned socket",
    );
  }
  try {
    process.kill(-processGroupId, "SIGTERM");
  } catch (error) {
    if (error.code === "ESRCH") return;
    throw error;
  }

  const stopDeadline = Date.now() + 5_000;
  while (Date.now() < stopDeadline) {
    try {
      process.kill(-processGroupId, 0);
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
  }
  try {
    process.kill(-processGroupId, 0);
    throw new Error(
      "BuildKit process group did not stop; leaving owned temp root for investigation",
    );
  } catch (error) {
    if (error.code === "ESRCH") return;
    throw error;
  }
}

async function stopOwnedServices(root, owner) {
  if (owner.buildkitProcessGroupId !== null) {
    await stopBuildkitProcessGroup(root, owner.buildkitProcessGroupId);
  }
  if (owner.registryStarted) {
    const env = privateEnvironment(root);
    try {
      await run(TOOL.podman, [...podmanArgs(root), "stop", "--time", "2", REGISTRY_CONTAINER], {
        env,
        logPath: path.join(root, "logs", "registry-stop.log"),
      });
    } catch (error) {
      if (!/no such|not found|does not exist/i.test(error.message)) throw error;
    }
  }
  if (owner.podmanInitialized) {
    const env = privateEnvironment(root);
    await run(TOOL.podman, [...podmanArgs(root), "system", "reset", "--force"], {
      env,
      logPath: path.join(root, "logs", "podman-reset.log"),
    });
  }
}

async function cleanup(root) {
  const { root: actualRoot, owner } = await readOwnerRecord(root);
  await stopOwnedServices(actualRoot, owner);
  await rm(actualRoot, { recursive: true, force: true });
  return actualRoot;
}

function expiryIso() {
  return new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
}

function inventory(root, ownerIdentity, registryUrl, socket) {
  const missing = () => ({
    state: "missing",
    owner: ownerIdentity,
    disposable: true,
    production: false,
    reference: null,
  });
  return {
    schemaVersion: 1,
    inventoryId: path.basename(root),
    owner: { name: `Local operator uid ${process.getuid()}`, identity: ownerIdentity },
    environment: {
      name: path.basename(root),
      purpose: "t14-disposable-test",
      disposable: true,
      production: false,
      expiresAt: expiryIso(),
      cleanupProcedure: `Run node scripts/local-disposable-environment.mjs --cleanup ${root}; it verifies the current UID, private /tmp root, ownership marker, and exact BuildKit socket before cleanup.`,
    },
    resources: {
      "workers-d1-do": missing(),
      "github-access": missing(),
      "buildkit-registry": {
        state: "available",
        owner: ownerIdentity,
        disposable: true,
        production: false,
        reference: `loopback OCI registry ${registryUrl}; BuildKit socket unix://${socket}; owned root ${root}`,
      },
      "kubernetes-isolation": missing(),
      "browser-entry": missing(),
      "producer-recovery": missing(),
      "stable-rollout": missing(),
    },
  };
}

async function launch(keep) {
  await assertTools();
  const root = await createRoot();
  const env = privateEnvironment(root);
  let owner = {
    schema: OWNER_SCHEMA,
    root,
    ownerUid: process.getuid(),
    disposable: true,
    production: false,
    registryStarted: false,
    podmanInitialized: false,
    buildkitProcessGroupId: null,
  };
  const ownerPath = path.join(root, "owner.json");
  const persistOwner = async () =>
    writeFile(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600 });
  await persistOwner();
  try {
    const infoText = await run(TOOL.podman, [...podmanArgs(root), "info", "--format", "json"], {
      env,
      logPath: path.join(root, "logs", "podman-info.json"),
    });
    const info = JSON.parse(infoText);
    const graphRoot = path.join(root, "storage", "podman-graphroot");
    if (!info.host?.security?.rootless || info.store?.graphRoot !== graphRoot)
      throw new Error("Podman did not report the expected rootless isolated graphroot");
    owner.podmanInitialized = true;
    await persistOwner();

    const registry = await pullAndStartRegistry(root, env);
    owner.registryStarted = true;
    await persistOwner();
    const buildkit = await startBuildkit(
      root,
      env,
      registry.registryUrl,
      async (processGroupId) => {
        owner.buildkitProcessGroupId = processGroupId;
        await persistOwner();
      },
    );
    const build = await verifyBuild(root, env, registry.registryUrl, buildkit.socket);
    const record = {
      schema: "praetorium.local-disposable-substrate-result/v1",
      createdAt: new Date().toISOString(),
      ownerUid: process.getuid(),
      root,
      production: false,
      disposable: true,
      podmanRootless: true,
      registry: { ...registry, anonymous: true, loopbackOnly: true },
      buildkitSocket: buildkit.socket,
      build,
    };

    if (keep) {
      const ownerIdentity = `local uid ${process.getuid()} at ${root}`;
      await writeFile(
        path.join(root, "acceptance-inventory.json"),
        `${JSON.stringify(inventory(root, ownerIdentity, registry.registryUrl, buildkit.socket), null, 2)}\n`,
        { mode: 0o600 },
      );
      record.acceptanceInventory = path.join(root, "acceptance-inventory.json");
      record.cleanup = `node scripts/local-disposable-environment.mjs --cleanup ${root}`;
    }

    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    if (!keep) await cleanup(root);
  } catch (error) {
    try {
      const cleanedRoot = await cleanup(root);
      process.stderr.write(`Cleaned owned temp root after failed run: ${cleanedRoot}\n`);
    } catch (cleanupError) {
      process.stderr.write(`Cleanup needs attention for ${root}: ${cleanupError.message}\n`);
    }
    throw error;
  }
}

function plan() {
  process.stdout.write(
    `${JSON.stringify(
      {
        mode: "plan",
        effectsExecuted: false,
        tools: TOOL,
        image: REGISTRY_IMAGE,
        intendedEffects: [
          "Create a private mkdtemp root below the operating-system temp directory.",
          "Use rootless Podman with isolated XDG paths, explicit vfs graph/run roots, and a loopback-only anonymous OCI registry.",
          "Start rootless BuildKit inside user and private mount namespaces with a socket and root below the owned temp directory.",
          "Build an uncached scratch-only recipe, push it to the local registry, and independently verify the manifest, config, and layer digests.",
          "By default stop both services and remove only the marked owned temp root; --keep leaves them available with a strict T14 resource inventory.",
        ],
        exclusions: [
          "No host daemon, existing container store, Docker context, kubeconfig, sysctl, production account, or production resource is read or modified.",
          "No credentials are configured or emitted.",
          "No producer artifact or product acceptance criterion is claimed.",
        ],
      },
      null,
      2,
    )}\n`,
  );
}

async function main() {
  const args = cli(process.argv.slice(2));
  if (args.mode === "help") {
    process.stdout.write(
      "Usage: node scripts/local-disposable-environment.mjs --plan | --run [--keep] | --cleanup <absolute-owned-temp-root>\n",
    );
    return;
  }
  if (args.mode === "plan") return plan();
  if (args.mode === "cleanup") {
    const root = await cleanup(args.root);
    process.stdout.write(`${JSON.stringify({ cleaned: root, production: false })}\n`);
    return;
  }
  await launch(args.keep);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
