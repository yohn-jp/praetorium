import assert from "node:assert/strict";
import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  BuildInputSchema,
  BuildReportRequestSchema,
  CompositionManifestSchema,
  ReleaseListSchema,
  buildKey,
  canonicalBuildInput,
  validateCompositionBindings,
} from "../../packages/contracts/dist/index.js";
import {
  BuildQueueHttpClient,
  createBuildWorker,
  readBuildServiceToken,
  readBuildWorkerConfig,
  readRegistryPullCredential,
} from "../../apps/build-worker/dist/index.js";
import { loadFileBuilderSigner } from "../../packages/application/dist/builds/index.js";
import { validateBuildKitFiles } from "../../plugins/buildkit/dist/index.js";
import { GhcrRegistryClient } from "../../plugins/ghcr/dist/index.js";
import { validateInventory } from "../../scripts/verify-integration.mjs";

const CATEGORY = "buildkit-registry";
const INVENTORY_ENV = "PRAETORIUM_T14_INVENTORY_PATH";
const RESULT_ENV = "PRAETORIUM_T14_RESULT_PATH";
const CONFIG_SUFFIX = ".buildkit-registry.json";
const EVIDENCE_SUFFIX = ".buildkit-registry-evidence.json";
const MAX_OWNER_FILE_BYTES = 64 * 1024;
const MAX_HTTP_BYTES = 1024 * 1024;
const HTTP_TIMEOUT_MS = 15_000;
const CLEANUP_MARGIN_MS = 10 * 60_000;
const MINIMUM_LEASE_SECONDS = 15;
const WORKER_ENV_KEYS = Object.freeze([
  "PRAETORIUM_BUILD_WORKER_ID",
  "PRAETORIUM_CONTROL_PLANE_URL",
  "PRAETORIUM_BUILD_SERVICE_TOKEN_FILE",
  "PRAETORIUM_BUILD_HTTP_TIMEOUT_MS",
  "PRAETORIUM_BUILD_HTTP_MAX_RESPONSE_BYTES",
  "PRAETORIUM_BUILD_LEASE_SECONDS",
  "PRAETORIUM_BUILD_HEARTBEAT_MS",
  "PRAETORIUM_BUILD_IDLE_DELAY_MS",
  "PRAETORIUM_BUILD_SIGNING_KEY_FILE",
  "PRAETORIUM_BUILD_SIGNING_KEY_ID",
  "PRAETORIUM_BUILD_REGISTRY_URL",
  "PRAETORIUM_BUILD_ALLOW_INSECURE_LOOPBACK_REGISTRY",
  "PRAETORIUM_BUILD_ALLOW_ANONYMOUS_LOOPBACK_PUBLISH",
  "PRAETORIUM_BUILD_REGISTRY_PULL_CREDENTIAL_FILE",
  "PRAETORIUM_BUILD_COMPOSITION_REPOSITORY",
  "PRAETORIUM_BUILD_MAX_IMAGE_LAYER_BYTES",
  "PRAETORIUM_BUILD_MAX_IMAGE_VERIFICATION_MS",
  "PRAETORIUM_BUILD_MAX_REGISTRY_REQUEST_MS",
  "PRAETORIUM_BUILDKIT_ADDRESS",
  "PRAETORIUM_BUILDKIT_TLS_SERVER_NAME",
  "PRAETORIUM_BUILDKIT_TLS_CA_FILE",
  "PRAETORIUM_BUILDKIT_TLS_CERT_FILE",
  "PRAETORIUM_BUILDKIT_TLS_KEY_FILE",
  "PRAETORIUM_BUILDKIT_BUILDCTL_PATH",
  "PRAETORIUM_BUILDKIT_FRONTEND_REPOSITORY",
  "PRAETORIUM_BUILDKIT_OUTPUT_REPOSITORY",
  "PRAETORIUM_BUILDKIT_DOCKER_CONFIG_DIRECTORY",
  "PRAETORIUM_BUILDKIT_TEMPORARY_DIRECTORY",
  "PRAETORIUM_BUILDKIT_MAX_INPUT_BYTES",
  "PRAETORIUM_BUILDKIT_MAX_PROGRESS_BYTES",
  "PRAETORIUM_BUILDKIT_TIMEOUT_MS",
  "PRAETORIUM_BUILDKIT_SAFE_PATH",
]);
const REQUIRED_WORKER_ENV_KEYS = Object.freeze([
  "PRAETORIUM_BUILD_WORKER_ID",
  "PRAETORIUM_CONTROL_PLANE_URL",
  "PRAETORIUM_BUILD_SERVICE_TOKEN_FILE",
  "PRAETORIUM_BUILD_SIGNING_KEY_FILE",
  "PRAETORIUM_BUILD_SIGNING_KEY_ID",
  "PRAETORIUM_BUILD_REGISTRY_URL",
  "PRAETORIUM_BUILD_COMPOSITION_REPOSITORY",
  "PRAETORIUM_BUILD_MAX_IMAGE_LAYER_BYTES",
  "PRAETORIUM_BUILD_MAX_IMAGE_VERIFICATION_MS",
  "PRAETORIUM_BUILD_MAX_REGISTRY_REQUEST_MS",
  "PRAETORIUM_BUILDKIT_ADDRESS",
  "PRAETORIUM_BUILDKIT_TLS_SERVER_NAME",
  "PRAETORIUM_BUILDKIT_TLS_CA_FILE",
  "PRAETORIUM_BUILDKIT_TLS_CERT_FILE",
  "PRAETORIUM_BUILDKIT_TLS_KEY_FILE",
  "PRAETORIUM_BUILDKIT_BUILDCTL_PATH",
  "PRAETORIUM_BUILDKIT_FRONTEND_REPOSITORY",
  "PRAETORIUM_BUILDKIT_OUTPUT_REPOSITORY",
  "PRAETORIUM_BUILDKIT_DOCKER_CONFIG_DIRECTORY",
  "PRAETORIUM_BUILDKIT_TEMPORARY_DIRECTORY",
  "PRAETORIUM_BUILDKIT_SAFE_PATH",
]);
const PATH_ENV_KEYS = new Set([
  "PRAETORIUM_BUILD_SERVICE_TOKEN_FILE",
  "PRAETORIUM_BUILD_SIGNING_KEY_FILE",
  "PRAETORIUM_BUILD_REGISTRY_PULL_CREDENTIAL_FILE",
  "PRAETORIUM_BUILDKIT_TLS_CA_FILE",
  "PRAETORIUM_BUILDKIT_TLS_CERT_FILE",
  "PRAETORIUM_BUILDKIT_TLS_KEY_FILE",
  "PRAETORIUM_BUILDKIT_BUILDCTL_PATH",
  "PRAETORIUM_BUILDKIT_DOCKER_CONFIG_DIRECTORY",
  "PRAETORIUM_BUILDKIT_TEMPORARY_DIRECTORY",
]);
const BLOCKED_REASON_CODES = new Set([
  "OWNER_INPUT_MISSING",
  "OWNED_ENVIRONMENT_UNAVAILABLE",
  "INSUFFICIENT_LIFETIME",
]);

class BlockedError extends Error {
  constructor(reasonCode) {
    super(reasonCode);
    this.name = "BlockedError";
    this.reasonCode = reasonCode;
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value, expected) {
  return isRecord(value) && Object.keys(value).every((key) => expected.includes(key));
}

function exactKeys(value, expected) {
  return (
    isRecord(value) && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0")
  );
}

function nonEmptyText(value, maxLength = 1024) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim() === value &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
    })
  );
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function safeAbsolutePath(value) {
  return typeof value === "string" && path.isAbsolute(value) && !value.includes("\0");
}

function exactHttpsOrigin(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value && !url.username && !url.password;
  } catch {
    return false;
  }
}

function validateOwnerConfig(config, inventory, inventoryPath) {
  if (
    !exactKeys(config, [
      "schemaVersion",
      "inventoryPath",
      "ownerIdentity",
      "environment",
      "controlPlane",
      "releaseId",
      "buildWorkerEnvironment",
      "evidencePath",
    ]) ||
    config.schemaVersion !== 1 ||
    path.resolve(config.inventoryPath ?? "") !== inventoryPath ||
    config.ownerIdentity !== inventory.owner.identity ||
    !exactKeys(config.environment, [
      "resourceReference",
      "expiresAt",
      "disposable",
      "production",
      "exclusiveBuildQueue",
    ]) ||
    config.environment.resourceReference !== inventory.resources[CATEGORY].reference ||
    config.environment.expiresAt !== inventory.environment.expiresAt ||
    config.environment.disposable !== true ||
    config.environment.production !== false ||
    config.environment.exclusiveBuildQueue !== true ||
    !nonEmptyText(config.releaseId, 128) ||
    !safeAbsolutePath(config.evidencePath) ||
    config.evidencePath !== `${inventoryPath}${EVIDENCE_SUFFIX}` ||
    !exactKeys(config.controlPlane, ["origin", "gatewayTokenFile", "repository", "actorId"]) ||
    !exactHttpsOrigin(config.controlPlane.origin) ||
    !safeAbsolutePath(config.controlPlane.gatewayTokenFile) ||
    !nonEmptyText(config.controlPlane.actorId, 255) ||
    !exactKeys(config.controlPlane.repository, [
      "id",
      "installationId",
      "owner",
      "name",
      "authorizationRevision",
      "instanceId",
    ]) ||
    !positiveInteger(config.controlPlane.repository.id) ||
    !positiveInteger(config.controlPlane.repository.installationId) ||
    !Number.isSafeInteger(config.controlPlane.repository.authorizationRevision) ||
    config.controlPlane.repository.authorizationRevision < 0 ||
    !/^[A-Za-z0-9_.-]{1,255}$/u.test(config.controlPlane.repository.owner) ||
    !/^[A-Za-z0-9_.-]{1,255}$/u.test(config.controlPlane.repository.name) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(config.controlPlane.repository.instanceId) ||
    !isRecord(config.buildWorkerEnvironment) ||
    !hasOnlyKeys(config.buildWorkerEnvironment, WORKER_ENV_KEYS) ||
    REQUIRED_WORKER_ENV_KEYS.some(
      (key) => !nonEmptyText(config.buildWorkerEnvironment[key], 4096),
    ) ||
    Object.entries(config.buildWorkerEnvironment).some(
      ([key, value]) =>
        !nonEmptyText(value, 4096) || (PATH_ENV_KEYS.has(key) && !safeAbsolutePath(value)),
    ) ||
    config.buildWorkerEnvironment.PRAETORIUM_CONTROL_PLANE_URL !== config.controlPlane.origin
  ) {
    return false;
  }
  return true;
}

async function readOwnedFile(filePath, { privateFile, maximumBytes }) {
  if (
    typeof process.getuid !== "function" ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    !Number.isInteger(fsConstants.O_NOFOLLOW) ||
    !Number.isInteger(fsConstants.O_NONBLOCK)
  ) {
    throw new BlockedError("OWNED_ENVIRONMENT_UNAVAILABLE");
  }

  let handle;
  try {
    handle = await open(
      filePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.uid !== process.getuid() ||
      (privateFile ? (before.mode & 0o077) !== 0 : (before.mode & 0o022) !== 0) ||
      before.size > maximumBytes
    ) {
      throw new BlockedError("OWNED_ENVIRONMENT_UNAVAILABLE");
    }
    const chunks = [];
    let size = 0;
    while (true) {
      const buffer = Buffer.allocUnsafe(Math.min(8192, maximumBytes - size + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > maximumBytes) throw new BlockedError("OWNED_ENVIRONMENT_UNAVAILABLE");
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (
      after.size !== size ||
      before.size !== after.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      after.uid !== process.getuid() ||
      (privateFile ? (after.mode & 0o077) !== 0 : (after.mode & 0o022) !== 0)
    ) {
      throw new BlockedError("OWNED_ENVIRONMENT_UNAVAILABLE");
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    if (error instanceof BlockedError) throw error;
    throw new BlockedError("OWNER_INPUT_MISSING");
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readOwnedJson(filePath, options) {
  const bytes = await readOwnedFile(filePath, options);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new BlockedError("OWNED_ENVIRONMENT_UNAVAILABLE");
  }
}

async function assertOwnerPathExists(filePath) {
  try {
    await lstat(filePath);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      throw new BlockedError("OWNER_INPUT_MISSING");
    }
    throw new BlockedError("OWNED_ENVIRONMENT_UNAVAILABLE");
  }
}

async function loadOwnedInputs() {
  const rawInventoryPath = process.env[INVENTORY_ENV];
  if (!rawInventoryPath || !path.isAbsolute(rawInventoryPath)) {
    throw new BlockedError("OWNER_INPUT_MISSING");
  }
  const inventoryPath = path.resolve(rawInventoryPath);
  let inventory;
  try {
    inventory = await readOwnedJson(inventoryPath, {
      privateFile: false,
      maximumBytes: MAX_OWNER_FILE_BYTES,
    });
  } catch (error) {
    if (error instanceof BlockedError) throw error;
    throw new BlockedError("OWNER_INPUT_MISSING");
  }

  const validation = validateInventory(inventory);
  const resource = inventory.resources?.[CATEGORY];
  if (
    validation.errors.length > 0 ||
    resource?.state !== "available" ||
    resource.owner !== inventory.owner?.identity ||
    resource.disposable !== true ||
    resource.production !== false ||
    !nonEmptyText(resource.reference, 1024)
  ) {
    throw new BlockedError("OWNED_ENVIRONMENT_UNAVAILABLE");
  }

  const configPath = `${inventoryPath}${CONFIG_SUFFIX}`;
  const config = await readOwnedJson(configPath, {
    privateFile: true,
    maximumBytes: MAX_OWNER_FILE_BYTES,
  });
  if (!validateOwnerConfig(config, inventory, inventoryPath)) {
    throw new BlockedError("OWNED_ENVIRONMENT_UNAVAILABLE");
  }
  const effectiveExpiresAt = Math.min(
    Date.parse(inventory.environment.expiresAt),
    Date.parse(config.environment.expiresAt),
  );
  if (!Number.isFinite(effectiveExpiresAt)) {
    throw new BlockedError("OWNED_ENVIRONMENT_UNAVAILABLE");
  }

  let gatewayToken;
  try {
    gatewayToken = (
      await readOwnedFile(config.controlPlane.gatewayTokenFile, {
        privateFile: true,
        maximumBytes: 4098,
      })
    )
      .toString("utf8")
      .replace(/\n$/u, "");
  } catch (error) {
    if (error instanceof BlockedError) throw error;
    throw new BlockedError("OWNER_INPUT_MISSING");
  }
  if (!/^[\x21-\x7e]{32,4096}$/u.test(gatewayToken)) {
    throw new BlockedError("OWNED_ENVIRONMENT_UNAVAILABLE");
  }

  let workerConfig;
  try {
    workerConfig = readBuildWorkerConfig(config.buildWorkerEnvironment);
  } catch {
    throw new BlockedError("OWNED_ENVIRONMENT_UNAVAILABLE");
  }
  if (
    workerConfig.workerId.length > 64 ||
    workerConfig.leaseSeconds < MINIMUM_LEASE_SECONDS ||
    workerConfig.leaseSeconds > 300 ||
    workerConfig.registryUrl.length === 0
  ) {
    throw new BlockedError("OWNED_ENVIRONMENT_UNAVAILABLE");
  }
  const configuredPaths = [
    workerConfig.serviceTokenFile,
    workerConfig.signingKeyFile,
    workerConfig.buildKit.tlsCaFile,
    workerConfig.buildKit.tlsCertFile,
    workerConfig.buildKit.tlsKeyFile,
    workerConfig.buildKit.buildctlPath,
    workerConfig.buildKit.dockerConfigDirectory,
    workerConfig.buildKit.temporaryDirectory,
    ...(workerConfig.registryPullCredentialFile ? [workerConfig.registryPullCredentialFile] : []),
  ];
  for (const filePath of configuredPaths) await assertOwnerPathExists(filePath);
  try {
    await readBuildServiceToken(workerConfig.serviceTokenFile);
    await loadFileBuilderSigner({
      privateKeyPath: workerConfig.signingKeyFile,
      keyId: workerConfig.signingKeyId,
    });
    await validateBuildKitFiles(workerConfig.buildKit);
    if (workerConfig.registryPullCredentialFile) {
      await readRegistryPullCredential(workerConfig.registryPullCredentialFile);
    }
  } catch {
    throw new BlockedError("OWNED_ENVIRONMENT_UNAVAILABLE");
  }
  const neededLifetime =
    3 * workerConfig.buildKit.buildTimeoutMs +
    3 * workerConfig.maxImageVerificationMs +
    CLEANUP_MARGIN_MS +
    MINIMUM_LEASE_SECONDS * 1000;
  if (effectiveExpiresAt - Date.now() < neededLifetime) {
    throw new BlockedError("INSUFFICIENT_LIFETIME");
  }
  const evidenceInfo = await lstat(config.evidencePath).catch((error) =>
    error.code === "ENOENT" ? null : Promise.reject(error),
  );
  if (evidenceInfo !== null) throw new BlockedError("OWNED_ENVIRONMENT_UNAVAILABLE");

  return {
    inventory,
    inventoryPath,
    config,
    gatewayToken,
    workerConfig,
    workerEnvironment: config.buildWorkerEnvironment,
    effectiveExpiresAt,
  };
}

async function boundedResponseBody(response) {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_HTTP_BYTES)) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Control Plane response exceeded its fixed bound");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_HTTP_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error("Control Plane response exceeded its fixed bound");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function controlPlaneRequest(
  inputs,
  pathname,
  { method = "GET", body, idempotencyKey } = {},
) {
  const url = new URL(pathname, `${inputs.config.controlPlane.origin}/`);
  if (url.origin !== inputs.config.controlPlane.origin || url.search || url.hash) {
    throw new Error("fixed Control Plane route escaped its configured origin");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  timeout.unref();
  let response;
  try {
    response = await fetch(url, {
      method,
      redirect: "error",
      cache: "no-store",
      headers: {
        "X-Control-Plane-Gateway-Auth": inputs.gatewayToken,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(idempotencyKey === undefined ? {} : { "Idempotency-Key": idempotencyKey }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timeout);
    throw new BlockedError("OWNED_ENVIRONMENT_UNAVAILABLE");
  }
  try {
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => {});
      throw new BlockedError("OWNED_ENVIRONMENT_UNAVAILABLE");
    }
    const bytes = await boundedResponseBody(response);
    let value = null;
    if (bytes.byteLength > 0) {
      try {
        value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        throw new Error("Control Plane returned a non-JSON response");
      }
    }
    return { status: response.status, value };
  } catch (error) {
    if (error instanceof BlockedError) throw error;
    if (controller.signal.aborted) throw new BlockedError("OWNED_ENVIRONMENT_UNAVAILABLE");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function resourceProfiles(catalog) {
  return [...catalog.resourceProfiles].sort(
    (left, right) =>
      right.cpuMilli - left.cpuMilli ||
      right.memoryMiB - left.memoryMiB ||
      right.ephemeralStorageMiB - left.ephemeralStorageMiB ||
      left.id.localeCompare(right.id),
  );
}

function assertBuildInputMatchesCatalog(input, catalog, requestedModules) {
  assert.equal(input.contractVersion, catalog.contractVersion);
  assert.equal(input.producerRevision, catalog.producerRevision);
  assert.equal(input.runtimeBaseDigest, catalog.runtimeBaseDigest);
  assert.equal(input.buildKitDigest, catalog.buildKitDigest);
  assert.equal(input.recipeDigest, catalog.recipeDigest);
  assert.equal(input.lockDigest, catalog.lockDigest);
  assert.equal(input.sourceDigest, catalog.sourceDigest);
  assert.ok(catalog.supportedPlatforms.includes(input.platform));
  assert.deepEqual(input.requestedModules, [...requestedModules].sort());

  const modules = new Map(catalog.modules.map((module) => [module.id, module]));
  for (const id of requestedModules)
    assert.ok(modules.has(id), `requested module ${id} must be catalogued`);
  const expectedClosure = new Set();
  const include = (id) => {
    if (expectedClosure.has(id)) return;
    const module = modules.get(id);
    assert.ok(module, `catalog module dependency ${id} must be present`);
    expectedClosure.add(id);
    for (const requiredId of module.requires) include(requiredId);
  };
  for (const id of requestedModules) include(id);
  const resolvedIds = new Set(input.resolvedModules.map(({ id }) => id));
  assert.deepEqual([...resolvedIds].sort(), [...expectedClosure].sort());
  for (const resolved of input.resolvedModules) {
    const module = modules.get(resolved.id);
    assert.ok(module, `resolved module ${resolved.id} must be catalogued`);
    assert.equal(resolved.version, module.version);
    assert.equal(resolved.artifactDigest, module.artifactDigest);
    for (const requiredId of module.requires) {
      assert.ok(resolvedIds.has(requiredId), `resolved module ${module.id} requires ${requiredId}`);
    }
    for (const conflictingId of module.conflicts) {
      assert.equal(
        resolvedIds.has(conflictingId),
        false,
        `resolved module ${module.id} conflicts with ${conflictingId}`,
      );
    }
  }
}

async function previewSelection(inputs, snapshot, releaseId, requestedModules, profiles, catalog) {
  for (const profile of profiles) {
    const selection = {
      releaseId,
      requestedModules: [...requestedModules],
      resourceProfileId: profile.id,
      policy: "pinned",
    };
    const response = await controlPlaneRequest(
      inputs,
      `/v1/instances/${encodeURIComponent(snapshot.instance.instanceId)}/configuration/preview`,
      {
        method: "POST",
        body: {
          bindingEpoch: snapshot.binding.bindingEpoch,
          authorizationRevision: snapshot.binding.authorizationRevision,
          expectedGeneration: snapshot.instance.generation,
          selection,
        },
      },
    );
    if (response.status === 400) continue;
    if (response.status !== 200 || !isRecord(response.value)) {
      throw new Error("producer-backed configuration preview did not succeed");
    }
    const input = BuildInputSchema.parse(response.value.buildInput);
    assertBuildInputMatchesCatalog(input, catalog, requestedModules);
    const calculatedKey = await buildKey(input);
    assert.equal(response.value.buildKey, calculatedKey);
    assert.deepEqual(input.requestedModules, [...requestedModules].sort());
    return { selection, input, buildKey: calculatedKey };
  }
  return null;
}

async function chooseCompositions(inputs, snapshot, release) {
  const catalog = release.catalog;
  assert.equal(catalog.contractVersion, "scriptorium-build/v1");
  assert.match(catalog.producerRevision, /^[a-f0-9]{40}$/u);
  assert.equal(catalog.runtimeBaseDigest, release.imageDigest);
  assert.ok(catalog.modules.length >= 2, "producer must publish at least two optional modules");
  const profiles = resourceProfiles(catalog);
  assert.ok(profiles.length > 0, "producer catalog must publish resource profiles");

  // An empty module selection means the Runtime Base + Build Kit Core product.
  const core = await previewSelection(inputs, snapshot, release.releaseId, [], profiles, catalog);
  assert.ok(core, "Scriptorium Core must resolve from its versioned producer catalog");

  const variants = [];
  for (const module of catalog.modules) {
    const candidate = await previewSelection(
      inputs,
      snapshot,
      release.releaseId,
      [module.id],
      profiles,
      catalog,
    );
    if (!candidate) continue;
    if (
      candidate.buildKey === core.buildKey ||
      variants.some((item) => item.buildKey === candidate.buildKey)
    )
      continue;
    variants.push({ ...candidate, selectedModuleId: module.id });
    if (variants.length === 2) break;
  }
  assert.equal(
    variants.length,
    2,
    "producer catalog must resolve two distinct legal single-addon configurations",
  );
  assert.notEqual(variants[0].selectedModuleId, variants[1].selectedModuleId);
  assert.notEqual(variants[0].buildKey, variants[1].buildKey);
  return { core, variants };
}

function makeObservedQueue(queue, capturedReports) {
  return {
    claimNext: (input) => queue.claimNext(input),
    heartbeat: (input) => queue.heartbeat(input),
    async report(input) {
      capturedReports.push(structuredClone(input));
      return queue.report(input);
    },
  };
}

async function readCompositionEvidence(inputs, expectedInput, report, expectedBuildId) {
  assert.equal(report.buildId, expectedBuildId);
  const expectedBuildKey = await buildKey(expectedInput);
  assert.equal(report.buildKey, expectedBuildKey);
  assert.equal(report.result.kind, "succeeded");
  const wireReport = { ...report };
  delete wireReport.now;
  const result = BuildReportRequestSchema.parse(wireReport);
  const signed = result.result;
  assert.equal(signed.kind, "succeeded");
  assert.equal(signed.statement.buildKey, expectedBuildKey);
  assert.equal(signed.statement.artifact.digest, signed.manifestDigest);
  assert.equal(signed.statement.producerRevision, expectedInput.producerRevision);
  assert.equal(signed.statement.contractVersion, expectedInput.contractVersion);

  const registryOrigin = new URL(inputs.workerConfig.registryUrl);
  const registryHost = registryOrigin.host;
  const registryRepositoryPrefix = `${registryHost}/`;
  const outputRepository = inputs.workerConfig.buildKit.outputRepository;
  assert.ok(outputRepository.startsWith(registryRepositoryPrefix));
  const imageRepository = outputRepository.slice(registryRepositoryPrefix.length);
  const compositionRepository = signed.compositionManifest.repository;
  assert.equal(signed.candidateRef, `${registryHost}/${imageRepository}@${signed.manifestDigest}`);
  assert.equal(
    signed.statement.compositionManifest.repository,
    signed.compositionManifest.repository,
  );
  assert.equal(signed.statement.compositionManifest.digest, signed.compositionManifest.digest);
  const pullCredential = inputs.workerConfig.registryPullCredentialFile
    ? await readRegistryPullCredential(inputs.workerConfig.registryPullCredentialFile)
    : undefined;
  const registry = new GhcrRegistryClient({
    registryUrl: inputs.workerConfig.registryUrl,
    ...(inputs.workerConfig.registryAllowInsecureLoopback ? { allowInsecureLoopback: true } : {}),
    allowedRepositories: [imageRepository, compositionRepository],
    maxImageLayerBytes: inputs.workerConfig.maxImageLayerBytes,
    maxImageVerificationMs: inputs.workerConfig.maxImageVerificationMs,
    maxRegistryRequestMs: inputs.workerConfig.maxRegistryRequestMs,
    ...(pullCredential ? { pullCredential } : {}),
  });
  const [image, compositionBlob] = await Promise.all([
    registry.verifyImage(imageRepository, signed.manifestDigest, {
      os: expectedInput.platform.split("/")[0],
      architecture: expectedInput.platform.split("/")[1],
    }),
    registry.readBlob(compositionRepository, signed.compositionManifest.digest, 4 * 1024 * 1024),
  ]);
  const composition = CompositionManifestSchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(compositionBlob.bytes)),
  );
  assert.equal(image.manifestDigest, signed.manifestDigest);
  assert.equal(compositionBlob.digest, signed.compositionManifest.digest);
  assert.equal(await validateCompositionBindings(composition), true);
  assert.equal(canonicalBuildInput(composition.buildInput), canonicalBuildInput(expectedInput));
  assert.equal(composition.buildKey, expectedBuildKey);
  assert.deepEqual(composition.resolvedModules, expectedInput.resolvedModules);
  const expectedModuleIds = expectedInput.resolvedModules.map(({ id }) => id).sort();
  assert.deepEqual(
    [...new Set([...composition.server.moduleIds, ...composition.browser.moduleIds])].sort(),
    expectedModuleIds,
  );
  return {
    buildKey: expectedBuildKey,
    buildId: expectedBuildId,
    producerRevision: expectedInput.producerRevision,
    runtimeBaseDigest: expectedInput.runtimeBaseDigest,
    requestedModules: expectedInput.requestedModules,
    resolvedModules: expectedInput.resolvedModules,
    imageDigest: signed.manifestDigest,
    imagePlatformManifestDigest: image.platformManifestDigest,
    imageConfigDigest: image.configDigest,
    layerDigests: image.layerDescriptors.map(({ digest }) => digest),
    compositionManifestDigest: compositionBlob.digest,
    serverEntry: composition.server.entry,
    serverModuleIds: composition.server.moduleIds,
    browserEntry: composition.browser.entry,
    browserModuleIds: composition.browser.moduleIds,
    nativeDependencies: composition.nativeDependencies,
    smoke: composition.smoke,
  };
}

async function getDashboard(inputs, instanceId) {
  const response = await controlPlaneRequest(
    inputs,
    `/v1/instances/${encodeURIComponent(instanceId)}/dashboard`,
  );
  assert.equal(response.status, 200, "owned instance dashboard must be available");
  assert.ok(isRecord(response.value));
  return response.value;
}

async function planConfiguration(inputs, snapshot, choice, generation) {
  const idempotencyKey = `praetorium-t14-buildkit-${crypto.randomUUID()}`;
  const response = await controlPlaneRequest(
    inputs,
    `/v1/instances/${encodeURIComponent(snapshot.instance.instanceId)}/configuration`,
    {
      method: "POST",
      idempotencyKey,
      body: {
        actorId: inputs.config.controlPlane.actorId,
        bindingEpoch: snapshot.binding.bindingEpoch,
        authorizationRevision: snapshot.binding.authorizationRevision,
        expectedGeneration: generation,
        selection: choice.selection,
      },
    },
  );
  assert.equal(response.status, 200, "owned configuration selection must be accepted");
  const value = response.value;
  assert.ok(isRecord(value) && isRecord(value.instance) && isRecord(value.revision));
  assert.equal(value.revision.repositoryId, snapshot.binding.repositoryId);
  assert.equal(value.revision.buildKey, choice.buildKey);
  assert.equal(value.buildKey, choice.buildKey);
  assert.equal(value.operation, null, "a stopped acceptance instance must not start a runtime");
  return value;
}

async function runBuild(
  inputs,
  worker,
  queue,
  capturedReports,
  instanceId,
  plan,
  choice,
  staleProbe = false,
) {
  const before = await getDashboard(inputs, instanceId);
  assert.equal(before.snapshot.instance.desiredState, "stopped");
  assert.equal(before.desired?.buildKey, plan.buildKey);
  assert.ok(before.build?.id === plan.buildId);
  assert.equal(
    before.build.status,
    "pending",
    "a fresh composition must reach the real Build Worker queue",
  );

  let abandonedClaim = null;
  if (staleProbe) {
    abandonedClaim = await queue.claimNext({
      workerId: inputs.workerConfig.workerId,
      now: Date.now(),
      leaseSeconds: MINIMUM_LEASE_SECONDS,
    });
    assert.ok(abandonedClaim, "the owned queue must provide the planned Core build");
    assert.equal(abandonedClaim.buildId, plan.buildId);
    assert.equal(abandonedClaim.buildKey, choice.buildKey);
    const waitMs = Math.max(0, abandonedClaim.leaseExpiresAt - Date.now() + 250);
    if (Date.now() + waitMs + CLEANUP_MARGIN_MS >= inputs.effectiveExpiresAt) {
      throw new BlockedError("INSUFFICIENT_LIFETIME");
    }
    await delay(waitMs);
  }

  const reportIndex = capturedReports.length;
  assert.equal(
    await worker.runOnce(),
    true,
    "the production Build Worker must claim and process this composition",
  );
  const liveReport = capturedReports
    .slice(reportIndex)
    .find((report) => report.buildId === plan.buildId && report.result.kind === "succeeded");
  assert.ok(liveReport, "the Build Worker must submit its signed, inspected OCI result");
  const evidence = await readCompositionEvidence(inputs, choice.input, liveReport, plan.buildId);
  assert.equal(evidence.buildId, plan.buildId);

  const after = await getDashboard(inputs, instanceId);
  assert.equal(after.build.id, plan.buildId);
  assert.equal(after.build.status, "succeeded");
  assert.equal(after.desired.revisionId, plan.revision.revisionId);
  assert.equal(after.desired.status, "admitted");
  assert.equal(after.desired.artifactDigest, evidence.imageDigest);
  evidence.admissionStatus = after.build.status;

  if (abandonedClaim) {
    assert.ok(liveReport.leaseEpoch > abandonedClaim.leaseEpoch);
    const staleResult = await queue.report({
      ...liveReport,
      attemptId: abandonedClaim.attemptId,
      leaseToken: abandonedClaim.leaseToken,
      leaseEpoch: abandonedClaim.leaseEpoch,
      now: Date.now(),
    });
    assert.equal(
      staleResult.accepted,
      false,
      "a superseded lease must reject a valid signed image result",
    );

    const lateFailure = await queue.report({
      ...liveReport,
      sequence: liveReport.sequence + 1,
      result: {
        kind: "failed",
        code: "BUILD_FAILED",
        message: "BuildKit solve failed",
        retryable: true,
      },
      now: Date.now(),
    });
    assert.equal(
      lateFailure.accepted,
      false,
      "a late failed report must not replace an admitted artifact",
    );
    const afterLateReports = await getDashboard(inputs, instanceId);
    assert.equal(afterLateReports.build.status, "succeeded");
    assert.equal(afterLateReports.desired.artifactDigest, evidence.imageDigest);
    return {
      evidence,
      staleProtection: {
        expiredAttemptLeaseEpoch: abandonedClaim.leaseEpoch,
        acceptedAttemptLeaseEpoch: liveReport.leaseEpoch,
        staleSignedResultRejected: staleResult.accepted === false,
        lateFailureRejected: lateFailure.accepted === false,
        admittedDigestPreserved: evidence.imageDigest,
      },
    };
  }
  return { evidence, staleProtection: null };
}

async function writeRunnerResult(status, reasonCode) {
  const resultPath = process.env[RESULT_ENV];
  if (!BLOCKED_REASON_CODES.has(reasonCode) && reasonCode !== "ACCEPTANCE_ASSERTION_FAILED") return;
  if (!resultPath || !path.isAbsolute(resultPath)) return;
  let handle;
  try {
    handle = await open(
      resultPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    const report = JSON.stringify({
      reportVersion: 1,
      category: CATEGORY,
      status,
      reasonCode,
    });
    await handle.writeFile(report, "utf8");
    await handle.sync();
    await handle.chmod(0o600);
  } catch {
    // The outer verifier treats a missing or malformed result as a failed runner.
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeEvidence(inputs, evidence) {
  const document = {
    schemaVersion: 1,
    category: CATEGORY,
    inventoryId: inputs.inventory.inventoryId,
    verifiedAt: new Date().toISOString(),
    producerRevision: evidence.producerRevision,
    runtimeBaseDigest: evidence.runtimeBaseDigest,
    repositoryId: inputs.config.controlPlane.repository.id,
    instanceId: inputs.config.controlPlane.repository.instanceId,
    configurations: evidence.configurations,
    cacheReuse: evidence.cacheReuse,
    staleAndFailureProtection: evidence.staleAndFailureProtection,
  };
  let handle;
  try {
    handle = await open(
      inputs.config.evidencePath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.chmod(0o600);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function runLiveAcceptance(inputs) {
  const { repository } = inputs.config.controlPlane;
  const repositoryResponse = await controlPlaneRequest(inputs, `/v1/repositories/${repository.id}`);
  assert.equal(repositoryResponse.status, 200, "owned test repository binding must be present");
  const snapshot = repositoryResponse.value;
  assert.ok(isRecord(snapshot) && isRecord(snapshot.binding) && isRecord(snapshot.instance));
  assert.equal(snapshot.binding.repositoryId, repository.id);
  assert.equal(snapshot.binding.installationId, repository.installationId);
  assert.equal(snapshot.binding.owner.toLowerCase(), repository.owner.toLowerCase());
  assert.equal(snapshot.binding.name.toLowerCase(), repository.name.toLowerCase());
  assert.equal(snapshot.binding.authorizationRevision, repository.authorizationRevision);
  assert.equal(snapshot.instance.instanceId, repository.instanceId);
  assert.equal(snapshot.instance.repositoryId, repository.id);
  assert.equal(snapshot.binding.suspended, false);
  assert.equal(
    snapshot.instance.desiredState,
    "stopped",
    "the build runner only mutates a stopped test instance",
  );

  const releaseResponse = await controlPlaneRequest(inputs, "/v1/releases");
  assert.notEqual(
    releaseResponse.status,
    404,
    "the production Control Plane release route must be mounted",
  );
  assert.equal(releaseResponse.status, 200);
  const releaseList = ReleaseListSchema.parse(releaseResponse.value);
  const release = releaseList.releases.find(
    ({ releaseId }) => releaseId === inputs.config.releaseId,
  );
  if (!release) throw new BlockedError("OWNER_INPUT_MISSING");
  assert.equal(release.catalog.contractVersion, "scriptorium-build/v1");
  assert.equal(release.catalog.runtimeBaseDigest, release.imageDigest);

  const dashboard = await getDashboard(inputs, repository.instanceId);
  assert.equal(dashboard.snapshot.binding.repositoryId, repository.id);
  assert.equal(dashboard.snapshot.instance.instanceId, repository.instanceId);
  assert.equal(dashboard.snapshot.instance.desiredState, "stopped");
  assert.equal(
    dashboard.current,
    null,
    "the dedicated test instance must not serve an old runtime",
  );
  assert.equal(
    dashboard.desired,
    null,
    "the dedicated test instance must start without a prior selection",
  );
  assert.equal(dashboard.snapshot.instance.generation, snapshot.instance.generation);
  assert.equal(
    dashboard.operations.some((operation) =>
      ["pending", "claimed", "running"].includes(operation.status),
    ),
    false,
  );

  const choices = await chooseCompositions(inputs, snapshot, release);
  const serviceToken = await readBuildServiceToken(inputs.workerConfig.serviceTokenFile);
  const rawQueue = new BuildQueueHttpClient({
    baseUrl: inputs.workerConfig.controlPlaneUrl,
    serviceToken,
    requestTimeoutMs: inputs.workerConfig.requestTimeoutMs,
    maxResponseBytes: inputs.workerConfig.maxResponseBytes,
    leaseSeconds: inputs.workerConfig.leaseSeconds,
  });
  const capturedReports = [];
  const observedQueue = makeObservedQueue(rawQueue, capturedReports);
  const worker = await createBuildWorker(inputs.workerEnvironment, { queue: observedQueue });
  const configurations = [];
  let generation = snapshot.instance.generation;

  const planAndBuild = async (label, choice, staleProbe = false) => {
    const plan = await planConfiguration(inputs, snapshot, choice, generation);
    generation = plan.instance.generation;
    const { evidence: result, staleProtection } = await runBuild(
      inputs,
      worker,
      rawQueue,
      capturedReports,
      repository.instanceId,
      plan,
      choice,
      staleProbe,
    );
    configurations.push({ label, ...result });
    return { plan, result, staleProtection };
  };

  const core = await planAndBuild("core", choices.core, true);
  for (let index = 0; index < choices.variants.length; index += 1) {
    await planAndBuild(`addon-${index + 1}`, choices.variants[index]);
  }

  const repeatedPreview = await previewSelection(
    inputs,
    { ...snapshot, instance: { ...snapshot.instance, generation } },
    release.releaseId,
    choices.variants[0].selection.requestedModules,
    [
      release.catalog.resourceProfiles.find(
        ({ id }) => id === choices.variants[0].selection.resourceProfileId,
      ),
    ].filter(Boolean),
    release.catalog,
  );
  assert.ok(repeatedPreview);
  assert.equal(repeatedPreview.buildKey, choices.variants[0].buildKey);
  const repeatPlan = await planConfiguration(inputs, snapshot, repeatedPreview, generation);
  generation = repeatPlan.instance.generation;
  assert.equal(repeatPlan.buildId, configurations.find(({ label }) => label === "addon-1").buildId);
  assert.equal(repeatPlan.revision.status, "admitted");
  const firstAddon = configurations.find(({ label }) => label === "addon-1");
  assert.ok(firstAddon);
  assert.equal(repeatPlan.revision.artifactDigest, firstAddon.imageDigest);
  assert.equal(
    await worker.runOnce(),
    false,
    "an identical admitted build key must be reused without another BuildKit claim",
  );
  const reuseDashboard = await getDashboard(inputs, repository.instanceId);
  assert.equal(reuseDashboard.build.id, repeatPlan.buildId);
  assert.equal(reuseDashboard.build.status, "succeeded");
  assert.equal(reuseDashboard.desired.artifactDigest, firstAddon.imageDigest);
  assert.equal(core.staleProtection?.staleSignedResultRejected, true);
  assert.equal(core.staleProtection?.lateFailureRejected, true);

  await writeEvidence(inputs, {
    producerRevision: release.catalog.producerRevision,
    runtimeBaseDigest: release.catalog.runtimeBaseDigest,
    configurations,
    cacheReuse: {
      buildKey: repeatedPreview.buildKey,
      originalBuildId: firstAddon.buildId,
      replayedBuildId: repeatPlan.buildId,
      artifactDigest: repeatPlan.revision.artifactDigest,
      noSecondBuildClaim: true,
    },
    staleAndFailureProtection: core.staleProtection,
  });
}

let ownerInputs;
let preflightError;
try {
  ownerInputs = await loadOwnedInputs();
} catch (error) {
  preflightError = error;
}

test(
  "T14 real Scriptorium Core and addon builds are admitted from OCI and reused by immutable key",
  {
    timeout: ownerInputs
      ? Math.min(
          2_000_000_000,
          3 *
            (ownerInputs.workerConfig.buildKit.buildTimeoutMs +
              ownerInputs.workerConfig.maxImageVerificationMs) +
            CLEANUP_MARGIN_MS +
            2 * MINIMUM_LEASE_SECONDS * 1000,
        )
      : 60_000,
    concurrency: false,
  },
  async () => {
    if (preflightError instanceof BlockedError) {
      await writeRunnerResult("BLOCKED", preflightError.reasonCode);
      assert.fail(`BLOCKED: ${preflightError.reasonCode}`);
    }
    if (preflightError !== undefined) {
      await writeRunnerResult("FAILED", "ACCEPTANCE_ASSERTION_FAILED");
      assert.fail(
        "T14 BuildKit owner preflight failed unexpectedly; private configuration and raw errors are withheld",
      );
    }
    try {
      await runLiveAcceptance(ownerInputs);
    } catch (error) {
      if (error instanceof BlockedError && BLOCKED_REASON_CODES.has(error.reasonCode)) {
        await writeRunnerResult("BLOCKED", error.reasonCode);
        assert.fail(`BLOCKED: ${error.reasonCode}`);
      }
      await writeRunnerResult("FAILED", "ACCEPTANCE_ASSERTION_FAILED");
      assert.fail(
        "T14 BuildKit/registry assertion failed; private endpoints, credentials and raw BuildKit output are withheld",
      );
    }
  },
);
