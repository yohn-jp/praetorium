#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createHash, generateKeyPairSync } from "node:crypto";
import { spawn } from "node:child_process";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { D1PlatformStore } from "../../packages/persistence/dist/d1/index.js";
import {
  InstanceService,
  RepositoryRegistryService,
} from "../../packages/application/dist/instances/index.js";
import { OperationService } from "../../packages/application/dist/operations/index.js";
import { GhcrRegistryClient } from "../../plugins/ghcr/dist/oci-registry-client.js";
import { SigstoreProvenanceVerifier } from "../../plugins/ghcr/dist/sigstore-provenance.js";
import { createScriptoriumCatalogResolverRegistry } from "../../plugins/scriptorium/dist/index.js";
import {
  BoundedOutputTail,
  FIXTURE_CHILD_OUTPUT_MAX_BYTES,
  FIXTURE_EVIDENCE_MAX_BYTES,
  removeOwnedBuildKitRoot,
  run as runOwnedCommand,
  sanitizeFixtureDiagnostic,
  stopPrivilegedProcessGroup,
} from "./fixture-process.mjs";
import {
  BuildQueueHttpClient,
  readBuildServiceToken,
} from "../../apps/build-worker/dist/http-client.js";
import { SourceReleaseBuildWorker } from "../../apps/build-worker/dist/source-release-worker.js";
import { buildSourceRelease } from "../../apps/build-worker/dist/source-producer-builder.js";
import { createBuildWorker } from "../../apps/build-worker/dist/main.js";
import { readBuildWorkerConfig } from "../../apps/build-worker/dist/config.js";
import { composeBuildServices } from "../../apps/control-plane/dist/build-composition.js";
import { composeReleaseServices } from "../../apps/control-plane/dist/release-composition.js";
import { createT11RolloutComposition } from "../../apps/control-plane/dist/rollout-composition.js";
import { verifyReleaseProducerMetadata } from "../../apps/control-plane/dist/release-producer-metadata.js";
import { progressProducedSourceReleases } from "../../apps/control-plane/dist/source-release-progression.js";
import {
  D1SourceReleaseBuildQueue,
  createSourceReleaseOperatorRoutes,
  createSourceReleaseWorkerRoutes,
} from "../../apps/control-plane/dist/source-release-builds.js";
import { createControlPlaneApp } from "../../apps/control-plane/dist/app.js";
import { advanceStablePromotions } from "../../packages/application/dist/releases/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BUILDKIT_VERSION = "v0.34.0";
const BUILDKIT_SHA256 = "14813b1fb2a40082114e6d386c6fc5e7dd5298176ce7ee1a18bc33e73e109ac3";
const REGISTRY_IMAGE =
  "docker.io/library/registry:3.0.0@sha256:6c5666b861f3505b116bb9aa9b25175e71210414bd010d92035ff64018f9457e";
const RELEASE = Object.freeze({
  releaseId: 416422590,
  sourceTag: "v0.2.1",
  sourceRevision: "3189a85bfa28ddd160600a0188ab3ccfa91755e4",
  releaseVersion: "0.2.1",
});
const INSTANCE_ID = "ins_01J9A2M4K8B7C6D5E4F3G2H1A0";
const REPOSITORY_ID = 1938475621;

function run(command, args, options = {}) {
  return runOwnedCommand(command, args, {
    cwd: ROOT,
    env: process.env,
    ...options,
  });
}

function freeDiskBytes(directory) {
  const output = execFileSync("df", ["-Pk", directory], { encoding: "utf8" });
  const fields = output.trim().split(/\s+/u);
  return Number(fields.at(-3)) * 1024;
}

class SqliteD1Statement {
  values = [];
  constructor(sql, statement, database) {
    this.sql = sql;
    this.statement = statement;
    this.database = database;
  }
  bind(...values) {
    this.values = values.map((value) =>
      value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : typeof value === "boolean"
          ? Number(value)
          : value,
    );
    return this;
  }
  async first() {
    return this.statement.get(...this.values) ?? null;
  }
  async all() {
    return { results: this.statement.all(...this.values), meta: { changes: 0 } };
  }
  async run() {
    const result = this.statement.run(...this.values);
    return { results: [], meta: { changes: Number(result.changes) } };
  }
  async executeBatch() {
    if (/^\s*(?:SELECT|PRAGMA|EXPLAIN)\b/iu.test(this.sql))
      return { results: this.statement.all(...this.values), meta: { changes: 0 } };
    if (/\bRETURNING\b/iu.test(this.sql)) {
      const results = this.statement.all(...this.values);
      const changeRow = this.database.prepare("SELECT changes() AS changes").get();
      return { results, meta: { changes: Number(changeRow.changes) } };
    }
    return this.run();
  }
}

class SqliteD1Database {
  database = new DatabaseSync(":memory:");
  prepare(sql) {
    return new SqliteD1Statement(sql, this.database.prepare(sql), this.database);
  }
  async batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.executeBatch());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

async function installMigrations(db) {
  const directory = path.join(ROOT, "apps/control-plane/migrations");
  const names = (await (await import("node:fs/promises")).readdir(directory))
    .filter((name) => /^\d{4}_[a-z0-9][a-z0-9_-]*\.sql$/u.test(name))
    .sort((left, right) => {
      const difference = Number(left.slice(0, 4)) - Number(right.slice(0, 4));
      return difference || (left < right ? -1 : left > right ? 1 : 0);
    });
  db.database.exec("PRAGMA foreign_keys = ON");
  for (const name of names) db.database.exec(await readFile(path.join(directory, name), "utf8"));
}

async function waitFor(check, message, timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`${message}${last ? `: ${last.message}` : ""}`);
}

async function startOwnedBuildKit(root, daemonOutput) {
  const tools = path.join(root, "tools");
  await mkdir(tools, { recursive: true, mode: 0o700 });
  const archive = path.join(tools, `buildkit-${BUILDKIT_VERSION}.tgz`);
  await run(
    "curl",
    [
      "--fail",
      "--silent",
      "--show-error",
      "--location",
      "--proto",
      "=https",
      "--tlsv1.2",
      `https://github.com/moby/buildkit/releases/download/${BUILDKIT_VERSION}/buildkit-${BUILDKIT_VERSION}.linux-amd64.tar.gz`,
      "--output",
      archive,
    ],
    { timeoutMs: 120_000 },
  );
  const actual = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  assert.equal(actual, BUILDKIT_SHA256, "pinned BuildKit release archive checksum");
  await run("tar", ["-xzf", archive, "-C", tools]);
  const buildctl = path.join(tools, "bin/buildctl");
  const buildkitd = path.join(tools, "bin/buildkitd");
  await access(buildctl);
  await access(buildkitd);
  await run("docker", ["pull", REGISTRY_IMAGE]);
  const name = `praetorium-source-fixture-${process.pid}`;
  await run("docker", [
    "run",
    "--detach",
    "--name",
    name,
    "--pull",
    "never",
    "--publish",
    "127.0.0.1:5000:5000",
    REGISTRY_IMAGE,
  ]);
  const pki = path.join(root, "pki");
  await mkdir(pki, { mode: 0o700 });
  await run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:3072",
    "-nodes",
    "-keyout",
    path.join(pki, "ca.key"),
    "-out",
    path.join(pki, "ca.crt"),
    "-subj",
    "/CN=Praetorium-Disposable-Fixture-CA",
    "-days",
    "1",
  ]);
  for (const [name, usage, san] of [
    ["server", "serverAuth", "subjectAltName=IP:127.0.0.1"],
    ["client", "clientAuth", "subjectAltName=IP:127.0.0.1"],
  ]) {
    await run("openssl", [
      "req",
      "-newkey",
      "rsa:3072",
      "-nodes",
      "-keyout",
      path.join(pki, `${name}.key`),
      "-out",
      path.join(pki, `${name}.csr`),
      "-subj",
      `/CN=praetorium-${name}-fixture`,
    ]);
    await writeFile(
      path.join(pki, `${name}.ext`),
      `[v3_req]\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=${usage}\n${san}\n`,
      { mode: 0o600 },
    );
    await run("openssl", [
      "x509",
      "-req",
      "-in",
      path.join(pki, `${name}.csr`),
      "-CA",
      path.join(pki, "ca.crt"),
      "-CAkey",
      path.join(pki, "ca.key"),
      "-CAcreateserial",
      "-out",
      path.join(pki, `${name}.crt`),
      "-days",
      "1",
      "-extfile",
      path.join(pki, `${name}.ext`),
      "-extensions",
      "v3_req",
    ]);
  }
  const buildkitAddress = `tcp://127.0.0.1:${process.env.PRAETORIUM_FIXTURE_BUILDKIT_PORT ?? "12384"}`;
  const buildkitPort = buildkitAddress.split(":").at(-1);
  const configPath = path.join(root, "buildkitd.toml");
  await writeFile(
    configPath,
    `[grpc]\n  address = ["${buildkitAddress}"]\n[grpc.tls]\n  cert = "${path.join(pki, "server.crt")}"\n  key = "${path.join(pki, "server.key")}"\n  ca = "${path.join(pki, "ca.crt")}"\n[registry."127.0.0.1:5000"]\n  http = true\n  insecure = true\n`,
    { mode: 0o600 },
  );
  const daemonPidFile = path.join(root, "daemon.pid");
  const daemonLaunchMarker = path.join(root, "daemon.launching");
  await writeFile(daemonLaunchMarker, "launching\n", { mode: 0o600 });
  let daemon;
  try {
    daemon = spawn(
      "sudo",
      [
        "-n",
        buildkitd,
        "--addr",
        buildkitAddress,
        "--config",
        configPath,
        "--root",
        path.join(root, "buildkit-root"),
      ],
      {
        cwd: ROOT,
        env: { ...process.env, NODE_USE_ENV_PROXY: "1" },
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    await unlink(daemonLaunchMarker).catch(() => {});
    throw error;
  }
  if (!Number.isSafeInteger(daemon.pid) || daemon.pid < 2) {
    await unlink(daemonLaunchMarker).catch(() => {});
    throw new Error("BuildKit daemon did not provide a process ID");
  }
  daemon.stdout?.on("data", (chunk) => daemonOutput.append(chunk));
  daemon.stderr?.on("data", (chunk) => daemonOutput.append(chunk));
  daemon.once("error", (error) => daemonOutput.append(`buildkitd spawn error: ${error.message}\n`));
  daemon.once("close", (code, signal) =>
    daemonOutput.append(`buildkitd exited ${code ?? signal ?? "unknown"}\n`),
  );
  await writeFile(daemonPidFile, `${daemon.pid}\n`, { mode: 0o600 });
  await unlink(daemonLaunchMarker);
  await waitFor(
    async () => {
      try {
        await run(
          "sudo",
          [
            "-n",
            buildctl,
            "--addr",
            buildkitAddress,
            "--tlscacert",
            path.join(pki, "ca.crt"),
            "--tlscert",
            path.join(pki, "client.crt"),
            "--tlskey",
            path.join(pki, "client.key"),
            "debug",
            "workers",
          ],
          { timeoutMs: 5_000 },
        );
        return true;
      } catch {
        return false;
      }
    },
    `BuildKit ${buildkitPort} mTLS worker`,
    60_000,
  );
  await waitFor(
    async () => {
      try {
        await run("curl", ["--fail", "--silent", "http://127.0.0.1:5000/v2/"], {
          timeoutMs: 2_000,
        });
        return true;
      } catch {
        return false;
      }
    },
    "loopback OCI registry",
    30_000,
  );
  return {
    buildctl,
    buildkitAddress,
    buildkitPort,
    pki,
    registryContainer: name,
    daemonPid: daemon.pid,
    daemonOutput,
  };
}

async function workerEnvironment(root, kit, input, keys) {
  const tokenFile = path.join(root, "build-worker.token");
  const signingKeyFile = path.join(root, "builder-ed25519.pem");
  const dockerConfig = path.join(root, "docker-config");
  const temporary = path.join(root, "buildkit-tmp");
  await mkdir(dockerConfig, { mode: 0o700 });
  await mkdir(temporary, { mode: 0o700 });
  await writeFile(tokenFile, "fixture-build-worker-token-0123456789abcdef\n", { mode: 0o600 });
  await writeFile(signingKeyFile, keys.privateKey.export({ type: "pkcs8", format: "pem" }), {
    mode: 0o600,
  });
  await chmod(tokenFile, 0o600);
  await chmod(signingKeyFile, 0o600);
  await writeFile(path.join(dockerConfig, "config.json"), '{"auths":{}}\n', { mode: 0o600 });
  for (const file of ["ca.crt", "client.crt", "client.key"])
    await chmod(path.join(kit.pki, file), file.endsWith(".key") ? 0o600 : 0o644);
  const host = "127.0.0.1:5000";
  return {
    ...process.env,
    PRAETORIUM_BUILD_WORKER_ID: "source-stable-fixture-worker",
    PRAETORIUM_CONTROL_PLANE_URL: "https://control.praetorium.fixture",
    PRAETORIUM_BUILD_SERVICE_TOKEN_FILE: tokenFile,
    PRAETORIUM_BUILD_HTTP_TIMEOUT_MS: "60000",
    PRAETORIUM_BUILD_HTTP_MAX_RESPONSE_BYTES: "1048576",
    PRAETORIUM_BUILD_LEASE_SECONDS: "300",
    PRAETORIUM_BUILD_HEARTBEAT_MS: "15000",
    PRAETORIUM_BUILD_SIGNING_KEY_FILE: signingKeyFile,
    PRAETORIUM_BUILD_SIGNING_KEY_ID: "source-stable-fixture-builder",
    PRAETORIUM_BUILD_REGISTRY_URL: `http://${host}`,
    PRAETORIUM_BUILD_ALLOW_INSECURE_LOOPBACK_REGISTRY: "1",
    PRAETORIUM_BUILD_ALLOW_ANONYMOUS_LOOPBACK_PUBLISH: "1",
    PRAETORIUM_BUILD_COMPOSITION_REPOSITORY: "yohn-jp/praetorium/compositions",
    PRAETORIUM_BUILD_MAX_IMAGE_LAYER_BYTES: "17179869184",
    PRAETORIUM_BUILD_MAX_IMAGE_VERIFICATION_MS: "120000",
    PRAETORIUM_BUILD_MAX_REGISTRY_REQUEST_MS: "60000",
    PRAETORIUM_BUILDKIT_ADDRESS: kit.buildkitAddress,
    PRAETORIUM_BUILDKIT_TLS_SERVER_NAME: "127.0.0.1",
    PRAETORIUM_BUILDKIT_TLS_CA_FILE: path.join(kit.pki, "ca.crt"),
    PRAETORIUM_BUILDKIT_TLS_CERT_FILE: path.join(kit.pki, "client.crt"),
    PRAETORIUM_BUILDKIT_TLS_KEY_FILE: path.join(kit.pki, "client.key"),
    PRAETORIUM_BUILDKIT_BUILDCTL_PATH: kit.buildctl,
    PRAETORIUM_BUILDKIT_FRONTEND_REPOSITORY: input.frontendRepository,
    PRAETORIUM_BUILDKIT_OUTPUT_REPOSITORY: `${host}/${input.outputRepository}`,
    PRAETORIUM_BUILDKIT_DOCKER_CONFIG_DIRECTORY: dockerConfig,
    PRAETORIUM_BUILDKIT_TEMPORARY_DIRECTORY: temporary,
    PRAETORIUM_BUILDKIT_TIMEOUT_MS: "5400000",
    PRAETORIUM_BUILDKIT_SAFE_PATH: "/usr/local/bin:/usr/bin:/bin",
  };
}

function transportFetch(app) {
  return async (url, init) => {
    const pending = [];
    const context = {
      waitUntil(promise) {
        pending.push(Promise.resolve(promise));
      },
      passThroughOnException() {},
    };
    const request = new Request(url, init);
    const response = await app.fetch(request, {}, context);
    await Promise.all(pending);
    return response;
  };
}

async function createRuntimeFixture(root, kit) {
  const db = new SqliteD1Database();
  await installMigrations(db);
  const keyPair = generateKeyPairSync("ed25519");
  const producerRepository = "ghcr.io/yohn-jp/praetorium/scriptorium-producer";
  const candidateRepository = "yohn-jp/praetorium/candidates";
  const compositionRepository = "yohn-jp/praetorium/compositions";
  const workerEnv = await workerEnvironment(
    root,
    kit,
    {
      frontendRepository: producerRepository,
      outputRepository: candidateRepository,
    },
    keyPair,
  );
  const sourceConfig = readBuildWorkerConfig(workerEnv);
  const serviceToken = await readBuildServiceToken(workerEnv.PRAETORIUM_BUILD_SERVICE_TOKEN_FILE);
  let operationNumber = 0;
  let leaseNumber = 0;
  const store = new D1PlatformStore(db);
  const instances = new InstanceService(store, () => `fixture-operation-${++operationNumber}`);
  const repositories = new RepositoryRegistryService(store, () => INSTANCE_ID);
  const operations = new OperationService(
    store,
    () => `fixture-lease-token-${++leaseNumber}-0123456789`,
  );
  const bindingResult = await repositories.resolveOrCreate({
    repository: {
      repositoryId: REPOSITORY_ID,
      installationId: 20261022,
      owner: "yohn-jp",
      name: "praetorium-source-stable-fixture",
      authorizationRevision: 1,
    },
    actor: { id: "71", kind: "operator" },
    requestId: "source-stable-fixture-repository",
    idempotencyKey: "source-stable-fixture-repository",
    now: Date.now(),
  });
  const binding = {
    owner: "yohn-jp",
    disposable: true,
    production: false,
    repositoryId: REPOSITORY_ID,
    instanceId: INSTANCE_ID,
    bindingEpoch: bindingResult.binding.bindingEpoch,
    authorizationRevision: bindingResult.binding.authorizationRevision,
    requestedModules: [],
    resourceProfileId: "small",
  };
  const publicKeyBase64 = keyPair.publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("base64");
  const loopback = new GhcrRegistryClient({
    registryUrl: "http://127.0.0.1:5000",
    allowInsecureLoopback: true,
    allowAnonymousLoopbackPublish: true,
    allowedRepositories: [
      "yohn-jp/praetorium/scriptorium-producer",
      "yohn-jp/praetorium/candidates",
      "yohn-jp/praetorium/compositions",
    ],
    publishRepositories: ["yohn-jp/praetorium/candidates", "yohn-jp/praetorium/compositions"],
    maxImageLayerBytes: 16 * 1024 ** 3,
    maxImageVerificationMs: 120_000,
    maxRegistryRequestMs: 60_000,
    maxMetadataBlobBytes: 8 * 1024 * 1024,
  });
  const buildPolicy = {
    registryUrl: "https://ghcr.io",
    sourceProducerRepository: producerRepository,
    allowedRepositories: [
      producerRepository.slice("ghcr.io/".length),
      candidateRepository,
      compositionRepository,
    ],
    outputRepository: candidateRepository,
    maxImageLayerBytes: 16 * 1024 ** 3,
    maxImageVerificationMs: 120_000,
    maxRegistryRequestMs: 60_000,
    runtimeResourceLimits: { cpuMilli: 2000, memoryMiB: 4096, ephemeralStorageMiB: 8192 },
    cacheRetention: { maxBytes: 1_048_576, maxEntries: 32, minAgeMs: 0, maxEvictions: 8 },
    targetPlatform: "linux/amd64",
    builderKeys: [{ keyId: "source-stable-fixture-builder", publicKeyBase64 }],
  };
  const builds = composeBuildServices(
    db,
    JSON.stringify(buildPolicy),
    undefined,
    createScriptoriumCatalogResolverRegistry(),
    { registry: loopback },
  );
  const gatewaySecret = "source-stable-fixture-gateway-secret-0123456789";
  const operatorToken = "source-stable-fixture-release-operator-0123456789";
  const releasePolicy = {
    workerId: "source-stable-fixture-release-controller",
    clusterId: "cluster-source-stable-fixture",
    operatorActorId: "71",
    canaryProbeActorId: 72,
    signerIdentityAllowlist: [{ subjectAlternativeName: "https://fixture.invalid/source" }],
    canary: binding,
  };
  const releaseServices = composeReleaseServices({
    db,
    builds,
    instances,
    operations,
    policyJson: JSON.stringify(releasePolicy),
    operatorToken,
    gatewayServiceSecret: gatewaySecret,
  });
  let simulatedNow = Date.now();
  let healthNumber = 0;
  const simulatedOperations = {
    async getById(operationId) {
      const operation = await operations.getById(operationId);
      if (!operation) return null;
      return { ...operation, status: "succeeded" };
    },
  };
  const provenance = {
    verify: (proof) =>
      proof.signatureRef.startsWith("https://control.praetorium.yohn.jp/internal/source-proofs/")
        ? releaseServices.sourceProofVerifier.provenance(proof)
        : new SigstoreProvenanceVerifier({
            signerIdentityAllowlist: releasePolicy.signerIdentityAllowlist,
          }).verify(proof),
  };
  const t11 = createT11RolloutComposition({
    db,
    configurations: builds.configurations,
    canaryConfigurations: builds.canaryConfigurations,
    instances,
    operations: simulatedOperations,
    canaryBinding: binding,
    canaryObservations: {
      async latestHealth(input) {
        const revision = db.database
          .prepare(
            "SELECT artifact_digest FROM deployment_revisions WHERE instance_id=? AND status='admitted' ORDER BY generation DESC LIMIT 1",
          )
          .get(input.instanceId);
        const operation = await operations.getById(input.operationId);
        if (!revision?.artifact_digest || !operation) return null;
        const observedAt = simulatedNow;
        const unique = String(++healthNumber).padStart(4, "0");
        return {
          artifactDigest: revision.artifact_digest,
          runtimeId: input.instanceId,
          operationId: input.operationId,
          runtimeEpoch: operation.runtimeEpoch,
          providerObservationId: `fixture-runtime-health-${unique}`,
          source: "runtime-provisioner-observation",
          imageIdentityVerified: true,
          observedAt,
          checks: { startup: true, auth: true, uiApiMcp: true, persistence: true },
          checkEvidence: {
            startup: `startup-${unique}`,
            auth: `auth-${unique}`,
            uiApiMcp: `ui-${unique}`,
            persistence: `persistence-${unique}`,
          },
        };
      },
      async writerAbsence(input) {
        return {
          instanceId: input.instanceId,
          repositoryId: input.repositoryId,
          retiredEpoch: input.retiredEpoch,
          providerObservationId: `fixture-writer-census-${input.afterOperationId}`,
          censusObservedAt: simulatedNow,
          remainingWriters: 0,
          evidenceIdentities: [],
          source: "runtime-provider-census",
        };
      },
    },
    defaultClusterId: releasePolicy.clusterId,
    clock: { nowMs: () => simulatedNow, now: () => new Date(simulatedNow).toISOString() },
    ids: { newReleaseId: () => `rel_${crypto.randomUUID()}` },
    workerId: releasePolicy.workerId,
    authorizeOperator: async () => ({ actorId: "71" }),
    registry: builds.registry,
    provenance,
    producerMetadata: { verify: verifyReleaseProducerMetadata },
  });
  const sourceQueue = new D1SourceReleaseBuildQueue(db);
  const sourceWorkerId = "source-stable-fixture-worker";
  const sourceRoutes = createSourceReleaseWorkerRoutes({
    queue: sourceQueue,
    workerId: sourceWorkerId,
    serviceToken,
    verifyProduced: (job, result) =>
      releaseServices.sourceProofVerifier.verify(job, result).then(() => undefined),
    afterProduced: async () => {
      simulatedNow = Math.max(simulatedNow, Date.now());
      return progressProducedSourceReleases({
        queue: sourceQueue,
        admit: (job, result) => releaseServices.admitSourceRelease(job, result),
        progressAdmitted: async () => {
          await (
            await import("../../apps/control-plane/dist/scheduled.js")
          ).runStableReleaseWork(t11.scheduled, { promotionPasses: 2 });
        },
      });
    },
  });
  const operatorRoutes = createSourceReleaseOperatorRoutes({
    queue: sourceQueue,
    operatorActorId: "71",
  });
  const app = createControlPlaneApp({
    registry: repositories,
    instances,
    gatewaySecret,
    sourceReleaseOperator: operatorRoutes,
    sourceReleaseWorker: sourceRoutes,
    operatorAdmission: releaseServices.operatorReleaseAdmission,
    operatorToken,
    builds: {
      queue: builds.builds,
      serviceToken,
      workerId: sourceWorkerId,
      afterAcceptedSuccess: async (buildId) => {
        simulatedNow = Math.max(simulatedNow, Date.now());
        await t11.afterAcceptedCanaryBuild(buildId);
      },
    },
  });
  const registryHost = "127.0.0.1:5000";
  return {
    db,
    app,
    fetch: transportFetch(app),
    releaseServices,
    t11,
    sourceQueue,
    sourceConfig,
    sourceIdentity: { host: registryHost, repositoryPath: producerRepository.slice("ghcr.io/".length) },
    workerEnvironment: workerEnv,
    simulatedNow: () => simulatedNow,
    advanceClock: (milliseconds) => {
      simulatedNow += milliseconds;
    },
    binding,
    releasePolicy,
    repositories,
    builds,
    keyPair,
  };
}

async function runSourceToStable(root, kit) {
  const fixture = await createRuntimeFixture(root, kit);
  const response = await fixture.fetch(
    new URL("/v1/operator/source-builds", "https://control.praetorium.fixture"),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Control-Plane-Gateway-Auth": "source-stable-fixture-gateway-secret-0123456789",
        "X-Praetorium-Admin-Actor": "71",
      },
      body: JSON.stringify({
        sourceId: "scriptorium",
        githubReleaseId: RELEASE.releaseId,
        sourceTag: RELEASE.sourceTag,
        sourceRevision: RELEASE.sourceRevision,
        releaseVersion: RELEASE.releaseVersion,
      }),
    },
  );
  if (response.status !== 202) {
    // Keep the failure bound to the canonical route/status; never conflate
    // a mount mismatch (404) with a Source build or Registry failure.
    const diagnostic = (await response.text()).slice(0, 1024);
    throw new Error(`Source queue POST /v1/operator/source-builds returned HTTP ${response.status}: ${diagnostic}`);
  }
  const queued = await response.json();
  const jobId = queued.job?.id;
  assert.match(jobId ?? "", /^sr_[0-9a-f-]{36}$/u, "canonical Source queue generated job identity");

  const sourceClient = new BuildQueueHttpClient({
    baseUrl: fixture.sourceConfig.controlPlaneUrl,
    serviceToken: await readBuildServiceToken(
      fixture.workerEnvironment.PRAETORIUM_BUILD_SERVICE_TOKEN_FILE,
    ),
    requestTimeoutMs: fixture.sourceConfig.requestTimeoutMs,
    maxResponseBytes: fixture.sourceConfig.maxResponseBytes,
    leaseSeconds: fixture.sourceConfig.leaseSeconds,
    fetch: fixture.fetch,
  });
  let sourceResult;
  let sourceFailure = null;
  const sourceWorker = new SourceReleaseBuildWorker(
    fixture.sourceConfig,
    sourceClient,
    async (job, config, signal) => {
      try {
        const result = await buildSourceRelease(job, config, signal, {
          isolatedRegistry: fixture.sourceIdentity,
        });
        sourceResult = result;
        return result;
      } catch (error) {
        // This is a disposable CI fixture with synthetic credentials. The
        // production Worker deliberately returns a bounded public error code;
        // preserve its safe failure phase here without leaking subprocess I/O.
        sourceFailure = sanitizeFixtureDiagnostic(
          error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          512,
        );
        throw error;
      }
    },
  );
  assert.equal(
    await sourceWorker.runOnce(),
    true,
    "the queued published Source Release was claimed",
  );
  const admittedJob = await fixture.sourceQueue.byId(jobId);
  assert.equal(
    admittedJob?.state,
    "admitted",
    `Source queue did not reach canonical Admission (${admittedJob?.failure_code ?? admittedJob?.state}); producer: ${sourceFailure ?? "no captured failure"}`,
  );
  assert.ok(admittedJob.admitted_release_id);
  const admittedCandidate = fixture.db.database
    .prepare("SELECT release_id, status FROM release_candidates WHERE release_id=?")
    .get(admittedJob.admitted_release_id);
  assert.equal(admittedCandidate?.release_id, admittedJob.admitted_release_id);

  const localRepository = `${fixture.sourceIdentity.host}/yohn-jp/praetorium/scriptorium-producer`;
  const compositionEnvironment = {
    ...fixture.workerEnvironment,
    PRAETORIUM_BUILDKIT_FRONTEND_REPOSITORY: localRepository,
    PRAETORIUM_BUILDKIT_OUTPUT_REPOSITORY: `${fixture.sourceIdentity.host}/yohn-jp/praetorium/candidates`,
  };
  const compositionQueue = new BuildQueueHttpClient({
    baseUrl: fixture.sourceConfig.controlPlaneUrl,
    serviceToken: await readBuildServiceToken(
      fixture.workerEnvironment.PRAETORIUM_BUILD_SERVICE_TOKEN_FILE,
    ),
    requestTimeoutMs: fixture.sourceConfig.requestTimeoutMs,
    maxResponseBytes: fixture.sourceConfig.maxResponseBytes,
    leaseSeconds: fixture.sourceConfig.leaseSeconds,
    fetch: fixture.fetch,
  });
  const compositionWorker = await createBuildWorker(compositionEnvironment, {
    queue: compositionQueue,
  });
  const claimedComposition = await compositionWorker.runOnce();
  if (!claimedComposition) {
    const workflow = fixture.db.database.prepare(
      `SELECT state, failure_code, next_attempt_at, canary_build_key
         FROM release_candidate_workflows WHERE release_id=?`,
    ).get(admittedJob.admitted_release_id);
    const queued = fixture.db.database.prepare(
      "SELECT status, COUNT(*) AS count FROM builds GROUP BY status ORDER BY status",
    ).all();
    throw new Error(
      "Admitted release has no claimable composition build; workflow=" +
      JSON.stringify(workflow ?? null) + "; buildQueue=" + JSON.stringify(queued),
    );
  }

  const builds = fixture.db.database
    .prepare(
      "SELECT build_id, status, artifact_digest FROM builds ORDER BY created_at DESC LIMIT 1",
    )
    .get();
  assert.equal(
    builds?.status,
    "succeeded",
    "gateway.v0 BuildKit composition reached verified OCI admission",
  );
  assert.match(builds?.artifact_digest ?? "", /^sha256:[a-f0-9]{64}$/u);
  const releaseId = admittedJob.admitted_release_id;
  const startOperation = fixture.db.database
    .prepare(
      "SELECT operation_id, generation, runtime_epoch, deployment_revision_id FROM operations WHERE instance_id=? AND kind='start' ORDER BY created_at DESC LIMIT 1",
    )
    .get(INSTANCE_ID);
  assert.ok(
    startOperation?.operation_id,
    "T11 created the normal disposable canary start operation",
  );
  fixture.db.database
    .prepare(
      `UPDATE logical_instances
        SET observed_state='ready', observed_generation=generation,
            observed_runtime_epoch=runtime_epoch, observed_revision_id=desired_revision_id,
            current_artifact_digest=desired_artifact_digest, updated_at=?
      WHERE instance_id=?`,
    )
    .run(fixture.simulatedNow(), INSTANCE_ID);

  const promotionDependencies = { ...fixture.t11.scheduled.promotions, healthWindowMs: 0 };
  // This disposable test has no provisioner event callback. Advance the
  // simulated clock to the *real* durable canary-observation backstop rather
  // than altering next_attempt_at or bypassing the observation state machine.
  // The health and writer-absence evidence below is explicitly simulated.
  fixture.advanceClock(5 * 60_000);
  let workflow;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    fixture.advanceClock(1_000);
    await advanceStablePromotions(promotionDependencies, { limit: 1, releaseId });
    workflow = fixture.db.database
      .prepare("SELECT state FROM release_candidate_workflows WHERE release_id=?")
      .get(releaseId);
    if (workflow?.state === "promoted") break;
  }
  assert.equal(
    workflow?.state,
    "promoted",
    "T11 canary health, writer-absence cleanup and stable CAS completed",
  );
  await (
    await import("../../apps/control-plane/dist/scheduled.js")
  ).runStableReleaseWork(fixture.t11.scheduled);
  const stable = await fixture.t11.releases.getStableChannel();
  assert.equal(
    stable.currentReleaseId,
    releaseId,
    "stable channel CAS selected the admitted Source Release",
  );
  const report = {
    schemaVersion: "praetorium.source-stable-fixture/v1",
    status: "PASS",
    acceptanceLevel: "DISPOSABLE_CI_FIXTURE",
    source: {
      githubReleaseId: RELEASE.releaseId,
      tag: RELEASE.sourceTag,
      revision: RELEASE.sourceRevision,
      queueState: admittedJob.state,
      proofAndRegistryVerification: "REAL_BUILDKIT_AND_LOOPBACK_OCI",
      imageRepository: sourceResult.statement.imageRepository,
      runtimeBaseDigest: sourceResult.statement.runtimeBaseDigest,
      buildKitDigest: sourceResult.statement.buildKitDigest,
      catalogDigest: sourceResult.statement.catalogDigest,
      runtimeMetadataDigest: sourceResult.statement.runtimeMetadataDigest,
      resolverDigest: sourceResult.statement.resolverDigest,
      resolverProvenanceDigest: sourceResult.resolver.provenanceDigest,
    },
    canonicalAdmission: { releaseId, status: admittedCandidate.status },
    composition: {
      buildId: builds.build_id,
      status: builds.status,
      artifactDigest: builds.artifact_digest,
    },
    canaryAndStable: {
      state: workflow.state,
      stableReleaseId: stable.currentReleaseId,
      stableRevision: stable.revision,
      runtimeEvidence: "SIMULATED_DISPOSABLE_FIXTURE",
    },
    hostedProducerRegistryAndBrowserAcceptance: "NOT_CHECKED",
    externalPublication: false,
  };
  await writeFile(
    path.join(root, "source-stable-fixture-result.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    { mode: 0o600 },
  );
  fixture.db.database.close();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report;
}

function failureReport(error) {
  return {
    schemaVersion: "praetorium.source-stable-fixture/v1",
    status: error?.blocked ? "BLOCKED" : "FAIL",
    reason: error?.reason ?? "FIXTURE_FAILED",
    detail: sanitizeFixtureDiagnostic(error?.message ?? String(error), FIXTURE_EVIDENCE_MAX_BYTES),
    hostedProducerRegistryAndBrowserAcceptance: "NOT_CHECKED",
    externalPublication: false,
  };
}

async function writeFixtureEvidence(directory, report, daemonOutput) {
  if (!directory) return;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(directory, "source-stable-fixture-result.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    path.join(directory, "buildkitd.log"),
    sanitizeFixtureDiagnostic(
      daemonOutput?.toString() ?? "BuildKit daemon did not start.\n",
      FIXTURE_CHILD_OUTPUT_MAX_BYTES,
    ),
    { mode: 0o600 },
  );
}

async function readOwnedBuildKitPid(root) {
  const pidFile = path.join(root, "daemon.pid");
  let info;
  try {
    info = await lstat(pidFile);
  } catch (error) {
    if (error?.code === "ENOENT") {
      try {
        await lstat(path.join(root, "daemon.launching"));
      } catch (markerError) {
        if (markerError?.code === "ENOENT") return null;
        throw markerError;
      }
      throw new Error("BuildKit daemon launch did not persist a trusted PID");
    }
    throw error;
  }
  if (
    info.isSymbolicLink() ||
    !info.isFile() ||
    (typeof process.getuid === "function" && info.uid !== process.getuid()) ||
    (info.mode & 0o077) !== 0
  )
    throw new TypeError("BuildKit daemon PID file is not a private fixture-owned file");
  const value = (await readFile(pidFile, "utf8")).trim();
  if (!/^[1-9][0-9]*$/u.test(value)) throw new TypeError("BuildKit daemon PID file is malformed");
  const pid = Number(value);
  if (!Number.isSafeInteger(pid) || pid < 2)
    throw new TypeError("BuildKit daemon PID is outside the valid range");
  return pid;
}

function withCleanupFailure(report, error) {
  const result = report ?? failureReport(new Error("fixture ended without a result"));
  return {
    ...result,
    status: "FAIL",
    reason: "FIXTURE_CLEANUP_FAILED",
    cleanupFailure: sanitizeFixtureDiagnostic(error?.message ?? String(error)),
  };
}

async function main() {
  let root;
  let report;
  let failure;
  let cleanupFailure;
  let daemonStopped = true;
  let buildKitRootRemoved = false;
  const daemonOutput = new BoundedOutputTail();
  const artifactDirectory = process.env.PRAETORIUM_SOURCE_FIXTURE_ARTIFACT_DIR;
  try {
    if (process.env.NODE_ENV !== "test")
      throw new Error("NODE_ENV=test is required for the loopback Source output adapter");
    if (process.platform !== "linux" || process.versions.node.split(".")[0] !== "24")
      throw Object.assign(new Error("runner must be Linux with Node 24"), {
        blocked: true,
        reason: "RUNNER_CAPABILITY_MISSING",
      });
    for (const command of ["docker", "sudo", "curl", "tar", "openssl", "git", "df"]) {
      try {
        await run("sh", ["-c", `command -v ${command} >/dev/null`], { timeoutMs: 2_000 });
      } catch {
        throw Object.assign(new Error(`required isolated runner tool is unavailable: ${command}`), {
          blocked: true,
          reason: "RUNNER_CAPABILITY_MISSING",
        });
      }
    }
    root = await mkdtemp(path.join(os.tmpdir(), "praetorium-source-stable-fixture-"));
    await chmod(root, 0o700);
    const available = freeDiskBytes(root);
    if (available < 8 * 1024 ** 3)
      throw Object.assign(
        new Error(`isolated BuildKit/OCI fixture requires 8 GiB free; found ${available} bytes`),
        { blocked: true, reason: "INSUFFICIENT_DISK" },
      );
    const kit = await startOwnedBuildKit(root, daemonOutput);
    report = await runSourceToStable(root, kit);
  } catch (error) {
    failure = error;
    report = failureReport(error);
  } finally {
    if (root) {
      try {
        const pid = await readOwnedBuildKitPid(root);
        if (pid !== null) {
          daemonStopped = await stopPrivilegedProcessGroup(pid);
          if (!daemonStopped) throw new Error("BuildKit daemon process group did not stop");
        }
      } catch (error) {
        daemonStopped = false;
        cleanupFailure ??= error;
      }
      await run("docker", ["rm", "--force", `praetorium-source-fixture-${process.pid}`], {
        timeoutMs: 30_000,
      }).catch(() => {});
    }
    if (cleanupFailure) {
      failure ??= cleanupFailure;
      report = withCleanupFailure(report, cleanupFailure);
    }
    try {
      await writeFixtureEvidence(
        artifactDirectory,
        report ?? failureReport(new Error("fixture ended without a result")),
        daemonOutput,
      );
    } catch (error) {
      failure ??= error;
      cleanupFailure ??= error;
      report = withCleanupFailure(report, error);
    }
    if (root && daemonStopped) {
      try {
        await removeOwnedBuildKitRoot(root);
        buildKitRootRemoved = true;
      } catch (error) {
        cleanupFailure ??= error;
      }
    }
    if (root && daemonStopped && buildKitRootRemoved) {
      try {
        await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
      } catch (error) {
        cleanupFailure ??= error;
      }
    }
    if (cleanupFailure) {
      failure ??= cleanupFailure;
      report = withCleanupFailure(report, cleanupFailure);
      try {
        await writeFixtureEvidence(artifactDirectory, report, daemonOutput);
      } catch (error) {
        failure ??= error;
      }
    }
  }
  if (failure) {
    process.stderr.write(
      `Source to Stable disposable fixture failed: ${sanitizeFixtureDiagnostic(failure.message, FIXTURE_CHILD_OUTPUT_MAX_BYTES)}\n`,
    );
    process.exitCode = 1;
  }
}

if (process.argv.includes("--check-imports")) {
  process.stdout.write("Source fixture built workspace imports resolve.\n");
} else {
  await main();
}
