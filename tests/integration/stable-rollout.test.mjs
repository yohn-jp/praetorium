import assert from "node:assert/strict";
import { constants as fsConstants } from "node:fs";
import { access, lstat, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import { createSecureContext } from "node:tls";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "@playwright/test";
import {
  InstanceDashboardSchema,
  PublicOperationSchema,
  ReleaseListSchema,
} from "../../packages/contracts/dist/index.js";
import {
  compareReleaseVersions,
  ReleaseCandidateManifestSchema,
} from "../../packages/application/dist/releases/index.js";
import { validateInventory as validateFixedInventory } from "../../scripts/verify-integration.mjs";
import {
  InClusterKubernetesTransport,
  KubernetesApiClient,
  runtimeNamespaceName,
  runtimeResourceName,
} from "../../plugins/kubernetes/dist/index.js";

const CATEGORY = "stable-rollout";
const INVENTORY_ENV = "PRAETORIUM_T14_INVENTORY_PATH";
const CATEGORY_ENV = "PRAETORIUM_T14_CATEGORY";
const RESULT_ENV = "PRAETORIUM_T14_RESULT_PATH";
const RESULT_FILENAME = "runner-result.json";
const PRODUCER_STATUS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../docs/migration/PRODUCER-STATUS.json",
);
const KUBERNETES_CATEGORY = "kubernetes-isolation";
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_STORAGE_STATE_BYTES = 2 * 1024 * 1024;
const MAX_HTTP_BYTES = 1024 * 1024;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const REVISION = /^[0-9a-f]{40}$/u;
const INSTANCE_ID = /^ins_[0-9A-HJKMNP-TV-Z]{26}$/u;
const CLUSTER_ID = /^clu_[0-9A-HJKMNP-TV-Z]{26}$/u;
const ALLOWED_BLOCK_REASONS = new Set([
  "OWNER_INPUT_MISSING",
  "OWNED_ENVIRONMENT_UNAVAILABLE",
  "PRODUCER_CONTRACT_MISSING",
  "RUNTIME_UNAVAILABLE",
  "BROWSER_UNAVAILABLE",
  "INSUFFICIENT_LIFETIME",
]);
const REPOSITORY_LABEL = "praetorium.io/repository-id";
const INSTANCE_LABEL = "arcadia.io/instance-id";
const PLATFORM_LABEL = "arcadia.io/platform";
const CLUSTER_LABEL = "arcadia.io/runtime-cluster-id";
const EPOCH_LABEL = "praetorium.io/runtime-epoch";
const GENERATION_LABEL = "arcadia.io/generation";
const OWNERSHIP_LABEL = "arcadia.io/ownership-version";
const MANAGED_BY_LABEL = "app.kubernetes.io/managed-by";
const APP_LABEL = "app.kubernetes.io/name";
const RELEASE_LABEL = "arcadia.io/release-id";
const PLATFORM_VALUE = "arcadia-platform";
const MANAGED_BY_VALUE = "arcadia-provisioner";
const NO_RELEASE = "none";

class GateBlocked extends Error {
  constructor(reasonCode) {
    super(reasonCode);
    this.name = "GateBlocked";
    this.reasonCode = reasonCode;
  }
}

function block(reasonCode) {
  throw new GateBlocked(reasonCode);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function safeText(value, maximum = 512) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 0x20 || codePoint === 0x7f;
    })
  );
}

function safeAbsolutePath(value) {
  return typeof value === "string" && path.isAbsolute(value) && !value.includes("\0");
}

function exactOrigin(value) {
  if (!safeText(value, 1024)) return null;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.origin !== value ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      /(?:^|\.)(?:localhost|example\.(?:com|net|org)|invalid|test)$/u.test(parsed.hostname)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function validModuleIds(value, allowEmpty = false) {
  return (
    Array.isArray(value) &&
    value.length <= 128 &&
    (allowEmpty || value.length > 0) &&
    value.every((entry) => safeText(entry, 128)) &&
    new Set(value).size === value.length
  );
}

function validSelection(value, expectedPolicy, expectedReleaseId) {
  return (
    exactKeys(value, ["releasePolicy", "releaseId", "moduleIds", "resourceProfileId"]) &&
    value.releasePolicy === expectedPolicy &&
    value.releaseId === expectedReleaseId &&
    validModuleIds(value.moduleIds, true) &&
    safeText(value.resourceProfileId, 128)
  );
}

function equalStringSet(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
  );
}

function ensureOwnerLifetime(inventory, requiredSeconds) {
  if (!Number.isFinite(requiredSeconds) || requiredSeconds < 0) {
    throw new TypeError("runner requested an invalid owner lifetime");
  }
  const remainingMs = Date.parse(inventory.environment.expiresAt) - Date.now();
  if (remainingMs < requiredSeconds * 1000 + 5_000) block("INSUFFICIENT_LIFETIME");
  return Math.min(requiredSeconds * 1000, remainingMs - 5_000);
}

async function readJsonFile(filePath, maximumBytes = MAX_INPUT_BYTES, privateFile = false) {
  if (!safeAbsolutePath(filePath)) block("OWNER_INPUT_MISSING");
  const link = await lstat(filePath).catch(() => null);
  if (!link?.isFile() || link.isSymbolicLink() || link.size < 1 || link.size > maximumBytes) {
    block("OWNER_INPUT_MISSING");
  }
  if (typeof process.getuid === "function" && link.uid !== process.getuid()) {
    block("OWNER_INPUT_MISSING");
  }
  if (privateFile && (link.mode & 0o077) !== 0) block("OWNER_INPUT_MISSING");
  const actual = await realpath(filePath).catch(() => null);
  if (!actual || actual !== path.resolve(filePath)) block("OWNER_INPUT_MISSING");
  const file = await stat(actual).catch(() => null);
  if (!file?.isFile() || file.size < 1 || file.size > maximumBytes) {
    block("OWNER_INPUT_MISSING");
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile(actual, "utf8"));
  } catch {
    block("OWNER_INPUT_MISSING");
  }
  if (!isRecord(parsed)) block("OWNER_INPUT_MISSING");
  return parsed;
}

function validateInventory(inventory) {
  const validation = validateFixedInventory(inventory);
  if (validation.errors.length > 0) block("OWNER_INPUT_MISSING");
  for (const category of [
    CATEGORY,
    KUBERNETES_CATEGORY,
    "github-access",
    "browser-entry",
    "buildkit-registry",
    "producer-recovery",
  ]) {
    if (inventory.resources[category]?.state !== "available") {
      block("OWNED_ENVIRONMENT_UNAVAILABLE");
    }
    if (!safeAbsolutePath(inventory.resources[category]?.reference)) {
      block("OWNER_INPUT_MISSING");
    }
  }
}

function validTarget(target, policy, releaseId) {
  if (
    !exactKeys(target, [
      "repositoryId",
      "fullName",
      "instanceId",
      "origin",
      "applicationHeading",
      "baseline",
    ]) ||
    !Number.isSafeInteger(target.repositoryId) ||
    target.repositoryId < 1 ||
    !/^[A-Za-z0-9_.-]{1,255}\/[A-Za-z0-9_.-]{1,255}$/u.test(target.fullName) ||
    !INSTANCE_ID.test(target.instanceId ?? "") ||
    !exactOrigin(target.origin) ||
    !safeText(target.applicationHeading, 256) ||
    !validSelection(target.baseline, policy, releaseId)
  ) {
    return false;
  }
  const hostname = exactOrigin(target.origin)?.hostname ?? "";
  return hostname.startsWith(`ins-${target.instanceId.slice(4).toLowerCase()}.`);
}

function validateConfig(config, inventory) {
  if (
    !exactKeys(config, [
      "schemaVersion",
      "inventory",
      "gateway",
      "browser",
      "controlPlane",
      "release",
      "targets",
      "scenarios",
      "timeouts",
    ]) ||
    config.schemaVersion !== 1 ||
    !exactKeys(config.inventory, [
      "inventoryId",
      "ownerIdentity",
      "environmentName",
      "expiresAt",
    ]) ||
    config.inventory.inventoryId !== inventory.inventoryId ||
    config.inventory.ownerIdentity !== inventory.owner.identity ||
    config.inventory.environmentName !== inventory.environment.name ||
    config.inventory.expiresAt !== inventory.environment.expiresAt
  ) {
    block("OWNER_INPUT_MISSING");
  }

  if (
    !exactKeys(config.gateway, ["origin", "expectedUserId"]) ||
    !exactOrigin(config.gateway.origin) ||
    !/^[1-9][0-9]{0,15}$/u.test(config.gateway.expectedUserId ?? "") ||
    !exactKeys(config.browser, ["executablePath", "githubStorageStatePath"]) ||
    !safeAbsolutePath(config.browser.executablePath) ||
    !safeAbsolutePath(config.browser.githubStorageStatePath) ||
    !exactKeys(config.controlPlane, ["origin", "gatewayAuth", "releaseOperatorToken"]) ||
    !exactOrigin(config.controlPlane.origin) ||
    config.controlPlane.origin === config.gateway.origin ||
    !/^[\x21-\x7e]{32,4096}$/u.test(config.controlPlane.gatewayAuth ?? "") ||
    !/^[\x21-\x7e]{32,4096}$/u.test(config.controlPlane.releaseOperatorToken ?? "") ||
    config.controlPlane.gatewayAuth === config.controlPlane.releaseOperatorToken
  ) {
    block("OWNER_INPUT_MISSING");
  }

  if (
    !exactKeys(config.release, ["previousReleaseId", "candidateManifestPath"]) ||
    !safeText(config.release.previousReleaseId, 128) ||
    !safeAbsolutePath(config.release.candidateManifestPath) ||
    !exactKeys(config.targets, ["stable", "pinned"]) ||
    !validTarget(config.targets.stable, "stable", config.release.previousReleaseId) ||
    !validTarget(config.targets.pinned, "pinned", config.release.previousReleaseId) ||
    config.targets.stable.repositoryId === config.targets.pinned.repositoryId ||
    config.targets.stable.instanceId === config.targets.pinned.instanceId ||
    config.targets.stable.origin === config.targets.pinned.origin
  ) {
    block("OWNER_INPUT_MISSING");
  }

  const scenarios = config.scenarios;
  if (
    !exactKeys(scenarios, ["failedBuild", "configurationChange", "rollback"]) ||
    !exactKeys(scenarios.failedBuild, [
      "releasePolicy",
      "releaseId",
      "moduleIds",
      "resourceProfileId",
      "expectedErrorCode",
    ]) ||
    scenarios.failedBuild.releasePolicy !== "pinned" ||
    scenarios.failedBuild.releaseId !== config.release.previousReleaseId ||
    !validModuleIds(scenarios.failedBuild.moduleIds, true) ||
    !safeText(scenarios.failedBuild.resourceProfileId, 128) ||
    !/^[A-Z][A-Z0-9_]{0,127}$/u.test(scenarios.failedBuild.expectedErrorCode ?? "") ||
    !exactKeys(scenarios.configurationChange, ["moduleIds", "resourceProfileId"]) ||
    !validModuleIds(scenarios.configurationChange.moduleIds) ||
    !safeText(scenarios.configurationChange.resourceProfileId, 128) ||
    !exactKeys(scenarios.rollback, ["moduleIds", "resourceProfileId"]) ||
    !validModuleIds(scenarios.rollback.moduleIds) ||
    !safeText(scenarios.rollback.resourceProfileId, 128) ||
    equalStringSet(scenarios.failedBuild.moduleIds, config.targets.pinned.baseline.moduleIds) ||
    equalStringSet(
      scenarios.configurationChange.moduleIds,
      config.targets.stable.baseline.moduleIds,
    ) ||
    equalStringSet(scenarios.rollback.moduleIds, scenarios.configurationChange.moduleIds)
  ) {
    block("OWNER_INPUT_MISSING");
  }

  const timeoutNames = [
    "loginSeconds",
    "buildSeconds",
    "promotionSeconds",
    "rolloutSeconds",
    "rollbackSeconds",
    "wakeSeconds",
    "totalSeconds",
  ];
  if (
    !exactKeys(config.timeouts, timeoutNames) ||
    timeoutNames.some(
      (name) => !Number.isSafeInteger(config.timeouts[name]) || config.timeouts[name] < 10,
    ) ||
    config.timeouts.loginSeconds > 900 ||
    config.timeouts.buildSeconds > 3600 ||
    config.timeouts.promotionSeconds > 7200 ||
    config.timeouts.rolloutSeconds > 3600 ||
    config.timeouts.rollbackSeconds > 3600 ||
    config.timeouts.wakeSeconds > 900 ||
    config.timeouts.totalSeconds > 14_400
  ) {
    block("OWNER_INPUT_MISSING");
  }
  const minimumTotal =
    config.timeouts.loginSeconds +
    config.timeouts.buildSeconds +
    config.timeouts.promotionSeconds +
    config.timeouts.rolloutSeconds +
    config.timeouts.rollbackSeconds +
    config.timeouts.wakeSeconds +
    180;
  if (config.timeouts.totalSeconds < minimumTotal) block("OWNER_INPUT_MISSING");
  if (
    Date.parse(inventory.environment.expiresAt) - Date.now() <
    config.timeouts.totalSeconds * 1000 + 60_000
  ) {
    block("INSUFFICIENT_LIFETIME");
  }
  return {
    gatewayOrigin: exactOrigin(config.gateway.origin),
    controlPlaneOrigin: exactOrigin(config.controlPlane.origin),
  };
}

function validateBrowserState(value) {
  if (
    !exactKeys(value, ["cookies", "origins"]) ||
    !Array.isArray(value.cookies) ||
    !Array.isArray(value.origins)
  ) {
    block("OWNER_INPUT_MISSING");
  }
  if (value.origins.length !== 0) block("OWNER_INPUT_MISSING");
  for (const cookie of value.cookies) {
    if (!isRecord(cookie) || typeof cookie.domain !== "string") block("OWNER_INPUT_MISSING");
    const domain = cookie.domain.replace(/^\./u, "").toLowerCase();
    if (domain !== "github.com" && !domain.endsWith(".github.com")) {
      block("OWNER_INPUT_MISSING");
    }
  }
}

function validateSelectionAgainstCatalog(selection, catalog) {
  const modules = new Set(catalog.modules.map((module) => module.id));
  const profiles = new Set(catalog.resourceProfiles.map((profile) => profile.id));
  return (
    selection.moduleIds.every((id) => modules.has(id)) && profiles.has(selection.resourceProfileId)
  );
}

async function readKubernetesConfig(configPath, inventory) {
  const value = await readJsonFile(configPath, MAX_INPUT_BYTES, true);
  if (
    !exactKeys(value, [
      "schemaVersion",
      "inventory",
      "cluster",
      "credentials",
      "metadataFixture",
      "probe",
      "network",
      "timeouts",
    ]) ||
    value.schemaVersion !== 1 ||
    !exactKeys(value.inventory, ["inventoryId", "ownerIdentity", "environmentName", "expiresAt"]) ||
    value.inventory.inventoryId !== inventory.inventoryId ||
    value.inventory.ownerIdentity !== inventory.owner.identity ||
    value.inventory.environmentName !== inventory.environment.name ||
    value.inventory.expiresAt !== inventory.environment.expiresAt ||
    !exactKeys(value.cluster, [
      "id",
      "provider",
      "name",
      "context",
      "confirmation",
      "apiHost",
      "apiPort",
      "namespacePrefix",
      "ingressNamespace",
      "instanceAccessNamespace",
      "maximumResources",
      "resourceProfile",
    ]) ||
    !CLUSTER_ID.test(value.cluster.id ?? "") ||
    value.cluster.provider !== "kind" ||
    value.cluster.context !== `kind-${value.cluster.name}` ||
    value.cluster.confirmation !== value.cluster.name ||
    !/^praetorium-instances$/u.test(value.cluster.namespacePrefix ?? "") ||
    !/^praetorium-[a-z0-9-]{1,48}$/u.test(value.cluster.name ?? "") ||
    isIP(value.cluster.apiHost) === 0 ||
    !["127.0.0.1", "::1"].includes(value.cluster.apiHost) ||
    !Number.isSafeInteger(value.cluster.apiPort) ||
    value.cluster.apiPort < 1 ||
    value.cluster.apiPort > 65_535 ||
    !exactKeys(value.credentials, [
      "directory",
      "controllerIdentity",
      "controllerTokenPath",
      "providerTokenPath",
      "caPath",
    ]) ||
    !safeAbsolutePath(value.credentials.directory) ||
    !safeAbsolutePath(value.credentials.controllerTokenPath) ||
    !safeAbsolutePath(value.credentials.providerTokenPath) ||
    !safeAbsolutePath(value.credentials.caPath) ||
    !exactKeys(value.timeouts, ["requestMs", "readinessMs", "networkProbeMs", "totalMs"]) ||
    !Number.isSafeInteger(value.timeouts.requestMs) ||
    value.timeouts.requestMs < 1_000 ||
    value.timeouts.requestMs > 20_000
  ) {
    block("OWNER_INPUT_MISSING");
  }
  return value;
}

async function privateCredential(pathValue, directory, maximumBytes = 128 * 1024) {
  const root = await realpath(directory).catch(() => null);
  const actual = await realpath(pathValue).catch(() => null);
  if (!root || !actual || !actual.startsWith(`${root}${path.sep}`)) block("OWNER_INPUT_MISSING");
  const info = await stat(actual).catch(() => null);
  if (
    !info?.isFile() ||
    info.size < 1 ||
    info.size > maximumBytes ||
    (typeof process.getuid === "function" && info.uid !== process.getuid()) ||
    (info.mode & 0o077) !== 0
  ) {
    block("OWNER_INPUT_MISSING");
  }
  return await readFile(actual);
}

async function loadInputs() {
  if (process.env[CATEGORY_ENV] !== CATEGORY || !safeAbsolutePath(process.env[INVENTORY_ENV])) {
    block("OWNER_INPUT_MISSING");
  }
  const inventory = await readJsonFile(process.env[INVENTORY_ENV]);
  validateInventory(inventory);
  const config = await readJsonFile(inventory.resources[CATEGORY].reference, MAX_INPUT_BYTES, true);
  const derived = validateConfig(config, inventory);

  const executable = await realpath(config.browser.executablePath).catch(() => null);
  if (!executable || !(await stat(executable).catch(() => null))?.isFile()) {
    block("BROWSER_UNAVAILABLE");
  }
  try {
    await access(executable, fsConstants.X_OK);
  } catch {
    block("BROWSER_UNAVAILABLE");
  }
  const storageState = await readJsonFile(
    config.browser.githubStorageStatePath,
    MAX_STORAGE_STATE_BYTES,
    true,
  );
  validateBrowserState(storageState);

  const manifestValue = await readJsonFile(
    config.release.candidateManifestPath,
    MAX_MANIFEST_BYTES,
    true,
  );
  const manifest = ReleaseCandidateManifestSchema.safeParse(manifestValue);
  if (!manifest.success) block("OWNER_INPUT_MISSING");
  const producerStatus = await readJsonFile(PRODUCER_STATUS_PATH, MAX_INPUT_BYTES);
  const capabilityRows = Array.isArray(producerStatus.capabilities)
    ? producerStatus.capabilities.filter((item) => isRecord(item))
    : [];
  const capabilities = new Map(capabilityRows.map((item) => [item.id, item]));
  if (
    !["S01", "S02", "S03", "S04", "S05"].every(
      (id) => capabilities.get(id)?.status === "available",
    ) ||
    !REVISION.test(producerStatus.producerRevision ?? "") ||
    !REVISION.test(producerStatus.producerTree ?? "") ||
    !DIGEST.test(producerStatus.artifactDigest ?? "") ||
    manifest.data.catalog.producerRevision !== producerStatus.producerRevision ||
    manifest.data.catalog.runtimeBaseDigest !== producerStatus.artifactDigest
  ) {
    block("PRODUCER_CONTRACT_MISSING");
  }
  if (
    !validateSelectionAgainstCatalog(config.scenarios.configurationChange, manifest.data.catalog) ||
    !validateSelectionAgainstCatalog(config.scenarios.rollback, manifest.data.catalog)
  ) {
    block("OWNER_INPUT_MISSING");
  }
  const moduleIds = manifest.data.catalog.modules.map((module) => module.id);
  if (
    moduleIds.length < 2 ||
    config.targets.stable.baseline.moduleIds.length !== 0 ||
    config.scenarios.configurationChange.moduleIds.length === moduleIds.length ||
    config.scenarios.rollback.moduleIds.length === moduleIds.length ||
    config.scenarios.configurationChange.moduleIds.length === 0 ||
    config.scenarios.rollback.moduleIds.length === 0 ||
    equalStringSet(
      config.scenarios.configurationChange.moduleIds,
      config.scenarios.rollback.moduleIds,
    )
  ) {
    block("OWNER_INPUT_MISSING");
  }

  const kubeConfig = await readKubernetesConfig(
    inventory.resources[KUBERNETES_CATEGORY].reference,
    inventory,
  );
  const [controllerTokenBytes, providerTokenBytes, caBytes] = await Promise.all([
    privateCredential(
      kubeConfig.credentials.controllerTokenPath,
      kubeConfig.credentials.directory,
      16 * 1024,
    ),
    privateCredential(
      kubeConfig.credentials.providerTokenPath,
      kubeConfig.credentials.directory,
      16 * 1024,
    ),
    privateCredential(kubeConfig.credentials.caPath, kubeConfig.credentials.directory),
  ]);
  const controllerToken = controllerTokenBytes.toString("utf8").trim();
  const providerToken = providerTokenBytes.toString("utf8").trim();
  if (
    controllerToken.length < 1 ||
    controllerToken.length > 16_384 ||
    /\s/u.test(controllerToken) ||
    providerToken.length < 1 ||
    providerToken.length > 16_384 ||
    /\s/u.test(providerToken) ||
    controllerToken === providerToken
  ) {
    block("OWNER_INPUT_MISSING");
  }
  const caPath = await realpath(kubeConfig.credentials.caPath).catch(() => null);
  if (!caPath) block("OWNER_INPUT_MISSING");
  const caFile = await stat(caPath).catch(() => null);
  if (!caFile?.isFile() || (caFile.mode & 0o022) !== 0) block("OWNER_INPUT_MISSING");
  try {
    createSecureContext({ ca: caBytes });
  } catch {
    block("OWNER_INPUT_MISSING");
  }

  return {
    inventory,
    config,
    manifest: manifest.data,
    storageState,
    executable,
    kubeConfig,
    controllerToken,
    ca: caBytes,
    ...derived,
  };
}

async function writeRunnerResult(status, reasonCode) {
  if (!ALLOWED_BLOCK_REASONS.has(reasonCode) && reasonCode !== "ACCEPTANCE_ASSERTION_FAILED")
    return;
  const reportPath = process.env[RESULT_ENV];
  const isolatedHome = process.env.HOME;
  if (!safeAbsolutePath(reportPath) || !safeAbsolutePath(isolatedHome)) return;
  const home = await realpath(isolatedHome).catch(() => null);
  const parent = await realpath(path.dirname(reportPath)).catch(() => null);
  if (!home || parent !== home || path.basename(reportPath) !== RESULT_FILENAME) return;
  const report = { reportVersion: 1, category: CATEGORY, status, reasonCode };
  await writeFile(path.join(home, RESULT_FILENAME), `${JSON.stringify(report)}\n`, {
    flag: "wx",
    mode: 0o600,
  }).catch(() => {});
}

function cpRequest(
  inputs,
  method,
  requestPath,
  token,
  payload,
  authorizationHeader = "X-Control-Plane-Gateway-Auth",
) {
  const url = new URL(requestPath, inputs.controlPlaneOrigin);
  if (
    url.origin !== inputs.controlPlaneOrigin.origin ||
    !url.pathname.startsWith("/v1/") ||
    url.username ||
    url.password
  ) {
    throw new TypeError("Control Plane request escaped its configured origin");
  }
  ensureOwnerLifetime(inputs.inventory, 5);
  const body = payload === undefined ? undefined : Buffer.from(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method,
        headers: {
          Accept: "application/json",
          [authorizationHeader]:
            authorizationHeader === "Authorization" ? `Bearer ${token}` : token,
          ...(body === undefined
            ? {}
            : {
                "Content-Type": "application/json",
                "Content-Length": String(body.byteLength),
              }),
        },
        timeout: 15_000,
      },
      (response) => {
        const chunks = [];
        let length = 0;
        response.on("data", (chunk) => {
          length += chunk.length;
          if (length > MAX_HTTP_BYTES) {
            request.destroy(new Error("Control Plane response exceeded the runner bound"));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed = null;
          if (text.length > 0) {
            try {
              parsed = JSON.parse(text);
            } catch {
              reject(new TypeError("Control Plane returned invalid JSON"));
              return;
            }
          }
          resolve({ status: response.statusCode ?? 0, body: parsed });
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("Control Plane request timed out")));
    request.on("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

async function getDashboard(inputs, target) {
  let response;
  try {
    response = await cpRequest(
      inputs,
      "GET",
      `/v1/instances/${encodeURIComponent(target.instanceId)}/dashboard`,
      inputs.config.controlPlane.gatewayAuth,
    );
  } catch {
    block("RUNTIME_UNAVAILABLE");
  }
  if (response.status === 404 || response.status === 503) block("RUNTIME_UNAVAILABLE");
  assert.equal(response.status, 200, "Control Plane must return the product dashboard");
  return InstanceDashboardSchema.parse(response.body);
}

async function getReleaseList(inputs) {
  let response;
  try {
    response = await cpRequest(
      inputs,
      "GET",
      "/v1/releases",
      inputs.config.controlPlane.gatewayAuth,
    );
  } catch {
    block("RUNTIME_UNAVAILABLE");
  }
  if (response.status === 503) block("RUNTIME_UNAVAILABLE");
  assert.equal(response.status, 200, "Control Plane release catalog must be available");
  return ReleaseListSchema.parse(response.body).releases;
}

async function getOperationEvidence(inputs, operationId) {
  let response;
  try {
    response = await cpRequest(
      inputs,
      "GET",
      `/v1/operations/${encodeURIComponent(operationId)}/evidence`,
      inputs.config.controlPlane.gatewayAuth,
    );
  } catch {
    block("RUNTIME_UNAVAILABLE");
  }
  if (response.status === 404 || response.status === 503) block("RUNTIME_UNAVAILABLE");
  assert.equal(
    response.status,
    200,
    "Control Plane must expose the bounded operation evidence projection",
  );
  assert.ok(
    exactKeys(response.body, [
      "operation",
      "readinessEvidence",
      "rollbackCompatibilityEvidence",
      "rollbackCompatible",
      "rollbackDeclarations",
    ]),
    "operation evidence must expose only the approved parsed evidence fields",
  );
  assert.ok(
    response.body.rollbackCompatible === null ||
      typeof response.body.rollbackCompatible === "boolean",
  );
  const operation = PublicOperationSchema.parse(response.body.operation);
  const readinessEvidence = response.body.readinessEvidence;
  const rollbackCompatibilityEvidence = response.body.rollbackCompatibilityEvidence;
  const rollbackDeclarations = response.body.rollbackDeclarations;
  if (readinessEvidence !== null) {
    assert.ok(
      exactKeys(readinessEvidence, [
        "assignment",
        "providerObservationId",
        "actualImageDigest",
        "producerObservedAt",
        "compositionManifestDigest",
        "enabledModuleIds",
        "applicationProbeId",
        "validGrantProbeId",
        "wrongRepositoryProbeId",
        "wrongEpochProbeId",
        "invalidServiceCredentialProbeId",
        "uiApiMcpProbeId",
        "persistenceProbeId",
        "persistence",
        "verifiedAt",
      ]),
    );
  }
  if (rollbackCompatibilityEvidence !== null) {
    assert.ok(
      exactKeys(rollbackCompatibilityEvidence, [
        "contractVersion",
        "instanceId",
        "repositoryId",
        "runtimeEpoch",
        "imageDigest",
        "compositionManifestDigest",
        "providerObservationId",
        "providerObservedAt",
        "observedAt",
        "observedRemoteCommit",
        "quiesceRevision",
        "quiesceRemoteCommit",
        "formats",
      ]),
    );
  }
  if (rollbackDeclarations !== null) {
    assert.ok(exactKeys(rollbackDeclarations, ["previous", "target"]));
    for (const side of [rollbackDeclarations.previous, rollbackDeclarations.target]) {
      assert.ok(exactKeys(side, ["imageDigest", "compositionManifestDigest", "persistence"]));
      assert.ok(DIGEST.test(side.imageDigest));
      assert.ok(DIGEST.test(side.compositionManifestDigest));
      assert.ok(
        exactKeys(side.persistence, ["contractVersion", "readable", "writable"]) &&
          side.persistence.contractVersion === "scriptorium-persistence/v1" &&
          Array.isArray(side.persistence.readable) &&
          Array.isArray(side.persistence.writable),
        "Control Plane must expose the parsed producer persistence declaration",
      );
      for (const readable of side.persistence.readable) {
        assert.ok(exactKeys(readable, ["formatId", "versions"]));
        assert.ok(/^[a-z][a-z0-9.-]{0,127}$/u.test(readable.formatId));
        assert.ok(
          Array.isArray(readable.versions) &&
            readable.versions.length > 0 &&
            readable.versions.every((version) => Number.isSafeInteger(version) && version > 0),
        );
      }
      for (const writable of side.persistence.writable) {
        assert.ok(exactKeys(writable, ["formatId", "version"]));
        assert.ok(/^[a-z][a-z0-9.-]{0,127}$/u.test(writable.formatId));
        assert.ok(Number.isSafeInteger(writable.version) && writable.version > 0);
      }
    }
  }
  return {
    operation,
    readinessEvidence,
    rollbackCompatibilityEvidence,
    rollbackCompatible: response.body.rollbackCompatible,
    rollbackDeclarations,
  };
}

function expectDashboardTarget(inputs, target, dashboard, policy, releaseId) {
  const { binding, instance } = dashboard.snapshot;
  assert.equal(binding.repositoryId, target.repositoryId);
  assert.equal(binding.instanceId, target.instanceId);
  assert.equal(instance.instanceId, target.instanceId);
  assert.equal(instance.repositoryId, target.repositoryId);
  assert.equal(binding.owner.toLowerCase(), target.fullName.split("/")[0].toLowerCase());
  assert.equal(binding.name.toLowerCase(), target.fullName.split("/")[1].toLowerCase());
  assert.equal(instance.clusterId, inputs.kubeConfig.cluster.id);
  assert.equal(instance.policy, policy);
  assert.equal(instance.desiredState, "running");
  assert.equal(instance.observedState, "ready");
  assert.equal(instance.observedRuntimeEpoch, instance.runtimeEpoch);
  assert.ok(instance.runtimeEpoch > 0);
  assert.match(instance.currentArtifactDigest ?? "", DIGEST);
  assert.equal(instance.currentArtifactDigest, instance.desiredArtifactDigest);
  assert.ok(dashboard.current, "ready product instance must have a current revision");
  assert.ok(dashboard.desired, "ready product instance must have a desired revision");
  assert.equal(dashboard.current.revisionId, instance.observedRevisionId);
  assert.equal(dashboard.current.artifactDigest, instance.currentArtifactDigest);
  assert.equal(dashboard.current.selection.policy, policy);
  assert.equal(dashboard.current.selection.releaseId, releaseId);
  assert.equal(dashboard.desired.selection.policy, policy);
  assert.equal(dashboard.desired.selection.releaseId, releaseId);
  assert.equal(dashboard.desired.artifactDigest, instance.desiredArtifactDigest);
  return dashboard;
}

function runtimeNamespace(inputs, instanceId) {
  return runtimeNamespaceName(inputs.kubeConfig.cluster.namespacePrefix, instanceId);
}

function runtimeDeploymentName(instanceId) {
  return runtimeResourceName(instanceId);
}

async function kubernetesSelfReview(transport, apiVersion, kind, spec = {}, timeoutMs = 10_000) {
  const resource =
    kind === "SelfSubjectAccessReview" ? "selfsubjectaccessreviews" : "selfsubjectreviews";
  const response = await transport.request({
    method: "POST",
    path: `/apis/${apiVersion}/${resource}`,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiVersion, kind, spec }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  assert.ok(response.statusCode === 200 || response.statusCode === 201);
  return response.body;
}

function kubernetesTransport(inputs, tokenPath) {
  return new InClusterKubernetesTransport({
    env: {
      KUBERNETES_SERVICE_HOST: inputs.kubeConfig.cluster.apiHost,
      KUBERNETES_SERVICE_PORT_HTTPS: String(inputs.kubeConfig.cluster.apiPort),
    },
    tokenPath,
    caPath: inputs.kubeConfig.credentials.caPath,
    requestTimeoutMs: inputs.kubeConfig.timeouts.requestMs,
  });
}

function namespaceLabels(namespace) {
  return namespace?.metadata?.labels ?? {};
}

function objectMetadata(value) {
  return isRecord(value?.metadata) ? value.metadata : {};
}

function runtimeLabels(value) {
  return objectMetadata(value).labels ?? {};
}

function appContainer(deployment) {
  const containers = deployment?.spec?.template?.spec?.containers;
  if (!Array.isArray(containers)) return null;
  const matches = containers.filter((container) => container?.name === "scriptorium");
  return matches.length === 1 ? matches[0] : null;
}

async function listCompleteNamespacePods(api, namespace) {
  const items = [];
  const cursors = new Set();
  let cursor;
  let resourceVersion;
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    let page;
    try {
      page = await api.list("Pod", namespace, "", cursor);
    } catch {
      block("RUNTIME_UNAVAILABLE");
    }
    assert.ok(isRecord(page) && Array.isArray(page.items));
    assert.ok(
      typeof page.resourceVersion === "string" && page.resourceVersion.length > 0,
      "complete Pod census must carry a resource version",
    );
    if (resourceVersion === undefined) resourceVersion = page.resourceVersion;
    else {
      assert.equal(
        page.resourceVersion,
        resourceVersion,
        "every page in the Pod census must use the same Kubernetes snapshot",
      );
    }
    items.push(...page.items);
    assert.ok(items.length <= 10_000, "complete Pod census exceeded its item bound");
    if (page.nextCursor === null) return { items, resourceVersion };
    assert.ok(typeof page.nextCursor === "string" && page.nextCursor.length > 0);
    assert.ok(!cursors.has(page.nextCursor), "Pod census pagination must advance");
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  assert.fail("complete Pod census exceeded its page bound");
}

function readinessPath(deployment) {
  return appContainer(deployment)?.readinessProbe?.httpGet?.path ?? null;
}

function assertOwnedRuntimeObject(inputs, target, dashboard, value, objectName) {
  const metadata = objectMetadata(value);
  const labels = metadata.labels ?? {};
  const expectedEpoch = String(dashboard.snapshot.instance.runtimeEpoch);
  const expectedReleaseId = dashboard.current?.selection.releaseId ?? "";
  assert.equal(metadata.name, objectName);
  assert.equal(metadata.namespace, runtimeNamespace(inputs, target.instanceId));
  assert.ok(typeof metadata.uid === "string" && metadata.uid.length > 0);
  assert.ok(typeof metadata.resourceVersion === "string" && metadata.resourceVersion.length > 0);
  for (const [key, expected] of Object.entries({
    [PLATFORM_LABEL]: PLATFORM_VALUE,
    [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
    [INSTANCE_LABEL]: target.instanceId,
    [REPOSITORY_LABEL]: String(target.repositoryId),
    [CLUSTER_LABEL]: inputs.kubeConfig.cluster.id,
    [EPOCH_LABEL]: expectedEpoch,
    [OWNERSHIP_LABEL]: "v1",
    [APP_LABEL]: "scriptorium",
    [RELEASE_LABEL]: expectedReleaseId || NO_RELEASE,
  })) {
    assert.equal(labels[key], expected, `Kubernetes ownership label ${key} must match CP state`);
  }
  return metadata;
}

async function readRuntimeObjects(inputs, target, dashboard, api) {
  const namespaceName = runtimeNamespace(inputs, target.instanceId);
  const namespace = await api.getNamespace(namespaceName);
  assert.equal(namespace?.metadata?.name, namespaceName);
  const nsLabels = namespaceLabels(namespace);
  for (const [key, expected] of Object.entries({
    [PLATFORM_LABEL]: PLATFORM_VALUE,
    [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
    [INSTANCE_LABEL]: target.instanceId,
    [REPOSITORY_LABEL]: String(target.repositoryId),
    [CLUSTER_LABEL]: inputs.kubeConfig.cluster.id,
    [OWNERSHIP_LABEL]: "v1",
  })) {
    assert.equal(nsLabels[key], expected, `Kubernetes namespace ownership label ${key} must match`);
  }
  const deployment = await api.get({
    kind: "Deployment",
    namespace: namespaceName,
    name: runtimeDeploymentName(target.instanceId),
  });
  const metadata = assertOwnedRuntimeObject(
    inputs,
    target,
    dashboard,
    deployment,
    runtimeDeploymentName(target.instanceId),
  );
  const templateLabels = deployment?.spec?.template?.metadata?.labels ?? {};
  for (const [key, expected] of Object.entries(runtimeLabels(deployment))) {
    if (
      key === PLATFORM_LABEL ||
      key === MANAGED_BY_LABEL ||
      key === INSTANCE_LABEL ||
      key === REPOSITORY_LABEL ||
      key === CLUSTER_LABEL ||
      key === EPOCH_LABEL ||
      key === OWNERSHIP_LABEL ||
      key === RELEASE_LABEL ||
      key === APP_LABEL
    ) {
      assert.equal(templateLabels[key], expected, `Pod template ownership label ${key} must match`);
    }
  }
  const container = appContainer(deployment);
  assert.ok(container, "runtime Deployment must have one Scriptorium application container");
  assert.match(container.image ?? "", /@sha256:[0-9a-f]{64}$/u);
  assert.ok(
    container.image.endsWith(`@${dashboard.snapshot.instance.currentArtifactDigest}`),
    "live Deployment image digest must match the admitted current Platform artifact",
  );
  assert.equal(
    objectMetadata(deployment).annotations?.["arcadia.io/release-digest"],
    dashboard.snapshot.instance.currentArtifactDigest,
    "Deployment artifact annotation must match the admitted current Platform artifact",
  );
  assert.equal(deployment?.spec?.replicas, 1);
  assert.ok(
    deployment?.status?.observedGeneration >= metadata.generation &&
      deployment?.status?.updatedReplicas === 1 &&
      deployment?.status?.availableReplicas === 1,
    "Kubernetes must observe one updated and Ready runtime replica",
  );
  return { namespace, deployment };
}

async function readReadyPodImageDigest(inputs, target, dashboard, api) {
  const namespace = runtimeNamespace(inputs, target.instanceId);
  assert.equal(
    dashboard.snapshot.instance.observedRuntimeEpoch,
    dashboard.snapshot.instance.runtimeEpoch,
    "ready runtime must be observed at its current epoch before counting writers",
  );
  assert.equal(
    dashboard.snapshot.instance.observedGeneration,
    dashboard.snapshot.instance.generation,
    "ready runtime must be observed at its current generation before counting writers",
  );
  const pods = await listCompleteNamespacePods(api, namespace);
  assert.equal(
    pods.items.length,
    1,
    "complete namespace census must contain only the current writer Pod across all epochs",
  );
  const pod = pods.items[0];
  assert.equal(pod?.status?.phase, "Running");
  const podMetadata = objectMetadata(pod);
  assert.equal(podMetadata.namespace, namespace);
  assert.ok(typeof podMetadata.uid === "string" && podMetadata.uid.length > 0);
  assert.ok(
    podMetadata.deletionTimestamp === undefined || podMetadata.deletionTimestamp === null,
    "the current writer Pod must not be terminating",
  );
  assert.equal(runtimeLabels(pod)[INSTANCE_LABEL], target.instanceId);
  assert.equal(runtimeLabels(pod)[REPOSITORY_LABEL], String(target.repositoryId));
  assert.equal(runtimeLabels(pod)[CLUSTER_LABEL], inputs.kubeConfig.cluster.id);
  assert.equal(runtimeLabels(pod)[EPOCH_LABEL], String(dashboard.snapshot.instance.runtimeEpoch));
  assert.equal(
    runtimeLabels(pod)[GENERATION_LABEL],
    String(dashboard.snapshot.instance.generation),
  );
  assert.equal(runtimeLabels(pod)[OWNERSHIP_LABEL], "v1");
  assert.equal(runtimeLabels(pod)[PLATFORM_LABEL], PLATFORM_VALUE);
  assert.equal(runtimeLabels(pod)[MANAGED_BY_LABEL], MANAGED_BY_VALUE);
  assert.equal(runtimeLabels(pod)[APP_LABEL], "scriptorium");
  assert.equal(
    runtimeLabels(pod)[RELEASE_LABEL],
    dashboard.current?.selection.releaseId ?? NO_RELEASE,
  );
  assert.ok(
    Array.isArray(pod?.status?.conditions) &&
      pod.status.conditions.some(
        (condition) => condition?.type === "Ready" && condition?.status === "True",
      ),
    "current writer Pod must report Ready",
  );
  const statuses = Array.isArray(pod?.status?.containerStatuses)
    ? pod.status.containerStatuses.filter((entry) => entry?.name === "scriptorium")
    : [];
  assert.equal(statuses.length, 1, "runtime Pod must report one Scriptorium container status");
  assert.equal(statuses[0]?.ready, true);
  const actualImageDigest = /sha256:[0-9a-f]{64}$/u.exec(statuses[0]?.imageID ?? "")?.[0];
  assert.match(
    actualImageDigest ?? "",
    DIGEST,
    "CRI image identity must expose its actual immutable digest",
  );
  const confirmedDashboard = await getDashboard(inputs, target);
  assert.equal(confirmedDashboard.snapshot.instance.observedState, "ready");
  assert.equal(
    confirmedDashboard.snapshot.instance.runtimeEpoch,
    dashboard.snapshot.instance.runtimeEpoch,
    "runtime epoch must remain current while the complete Pod census is checked",
  );
  assert.equal(
    confirmedDashboard.snapshot.instance.generation,
    dashboard.snapshot.instance.generation,
    "runtime generation must remain current while the complete Pod census is checked",
  );
  assert.equal(
    confirmedDashboard.snapshot.instance.currentArtifactDigest,
    dashboard.snapshot.instance.currentArtifactDigest,
    "serving artifact must remain current while the complete Pod census is checked",
  );
  return actualImageDigest;
}

async function authorizationReview(transport, attributes, expectedAllowed, timeoutMs) {
  const result = await kubernetesSelfReview(
    transport,
    "authorization.k8s.io/v1",
    "SelfSubjectAccessReview",
    { resourceAttributes: attributes },
    timeoutMs,
  );
  assert.equal(result?.status?.allowed, expectedAllowed);
  assert.equal(result?.status?.evaluationError, undefined);
}

async function prepareKubernetes(inputs) {
  const providerTransport = kubernetesTransport(
    inputs,
    inputs.kubeConfig.credentials.providerTokenPath,
  );
  const controllerTransport = kubernetesTransport(
    inputs,
    inputs.kubeConfig.credentials.controllerTokenPath,
  );
  const timeoutMs = inputs.kubeConfig.timeouts.requestMs;
  const providerIdentity = await kubernetesSelfReview(
    providerTransport,
    "authentication.k8s.io/v1",
    "SelfSubjectReview",
    {},
    timeoutMs,
  );
  assert.equal(
    providerIdentity?.status?.userInfo?.username,
    "system:serviceaccount:praetorium-system:praetorium-provisioner",
    "runtime reads must use the exact deployed Provisioner ServiceAccount",
  );
  const controllerIdentity = await kubernetesSelfReview(
    controllerTransport,
    "authentication.k8s.io/v1",
    "SelfSubjectReview",
    {},
    timeoutMs,
  );
  assert.equal(
    controllerIdentity?.status?.userInfo?.username,
    inputs.kubeConfig.credentials.controllerIdentity,
    "owned test controller token must match its declared Kubernetes identity",
  );
  assert.equal(
    controllerIdentity?.status?.userInfo?.groups?.includes("system:masters"),
    false,
    "owned test controller must not use the Kubernetes system:masters group",
  );

  const stableNamespace = runtimeNamespace(inputs, inputs.config.targets.stable.instanceId);
  const stableDeployment = runtimeDeploymentName(inputs.config.targets.stable.instanceId);
  const stableService = stableDeployment;
  await authorizationReview(
    providerTransport,
    {
      verb: "get",
      group: "apps",
      version: "v1",
      resource: "deployments",
      namespace: stableNamespace,
      name: stableDeployment,
    },
    true,
    timeoutMs,
  );
  await authorizationReview(
    providerTransport,
    {
      verb: "patch",
      group: "apps",
      version: "v1",
      resource: "deployments",
      namespace: stableNamespace,
      name: stableDeployment,
    },
    false,
    timeoutMs,
  );
  await authorizationReview(
    controllerTransport,
    {
      verb: "patch",
      group: "apps",
      version: "v1",
      resource: "deployments",
      namespace: stableNamespace,
      name: stableDeployment,
    },
    true,
    timeoutMs,
  );
  await authorizationReview(
    controllerTransport,
    {
      verb: "patch",
      group: "",
      version: "v1",
      resource: "services",
      namespace: stableNamespace,
      name: stableService,
    },
    true,
    timeoutMs,
  );
  await authorizationReview(
    controllerTransport,
    {
      verb: "patch",
      group: "apps",
      version: "v1",
      resource: "deployments",
      namespace: stableNamespace,
    },
    false,
    timeoutMs,
  );
  for (const namespace of ["kube-system", "praetorium-system", "traefik"]) {
    await authorizationReview(
      controllerTransport,
      {
        verb: "patch",
        group: "apps",
        version: "v1",
        resource: "deployments",
        namespace,
        name: stableDeployment,
      },
      false,
      timeoutMs,
    );
  }
  return {
    providerTransport,
    controllerTransport,
    providerApi: new KubernetesApiClient(providerTransport),
    controllerApi: new KubernetesApiClient(controllerTransport),
  };
}

function isGithubHost(hostname) {
  const host = hostname.toLowerCase();
  return (
    host === "github.com" ||
    host.endsWith(".github.com") ||
    host === "githubassets.com" ||
    host.endsWith(".githubassets.com") ||
    host === "githubusercontent.com" ||
    host.endsWith(".githubusercontent.com")
  );
}

async function loginThroughGithub(page, context, inputs, gatewayRequests) {
  ensureOwnerLifetime(inputs.inventory, inputs.config.timeouts.loginSeconds);
  try {
    await page.goto(`${inputs.gatewayOrigin.origin}/`, { waitUntil: "domcontentloaded" });
  } catch {
    block("RUNTIME_UNAVAILABLE");
  }
  const deadline = Date.now() + inputs.config.timeouts.loginSeconds * 1000;
  while (Date.now() < deadline) {
    const location = new URL(page.url());
    if (location.origin === inputs.gatewayOrigin.origin && location.pathname === "/") break;
    if (isGithubHost(location.hostname)) {
      await delay(500);
      continue;
    }
    block("OWNED_ENVIRONMENT_UNAVAILABLE");
  }
  assert.equal(new URL(page.url()).origin, inputs.gatewayOrigin.origin);
  assert.equal(new URL(page.url()).pathname, "/");
  assert.equal(
    gatewayRequests.filter((request) => request === "/auth/github/callback").length,
    1,
    "the Gateway session must come from a live GitHub App OAuth callback",
  );
  const session = await page.evaluate(async () => {
    const response = await fetch("/api/session", { cache: "no-store" });
    return { status: response.status, body: await response.json().catch(() => null) };
  });
  assert.equal(session.status, 200, "OAuth callback must create a live Gateway session");
  assert.equal(session.body?.userId, inputs.config.gateway.expectedUserId);
  const gatewayCookies = (await context.cookies()).filter(
    (cookie) => cookie.domain.replace(/^\./u, "") === inputs.gatewayOrigin.hostname,
  );
  assert.ok(
    gatewayCookies.some((cookie) => cookie.name === "__Host-praetorium_session"),
    "Gateway OAuth must establish its host-only session cookie",
  );
  return session.body.userId;
}

async function visitRepository(page, inputs, target) {
  ensureOwnerLifetime(inputs.inventory, 10);
  let response;
  try {
    response = await page.goto(
      `${inputs.gatewayOrigin.origin}/repositories/${encodeURIComponent(String(target.repositoryId))}`,
      { waitUntil: "domcontentloaded" },
    );
  } catch {
    block("RUNTIME_UNAVAILABLE");
  }
  if (response?.status() === 503) block("RUNTIME_UNAVAILABLE");
  assert.equal(response?.status(), 200, "maintained repository dashboard must load");
  await page.getByRole("heading", { name: target.fullName, exact: true }).waitFor();
  const mainText = await page.locator("main").innerText();
  assert.match(mainText, /GitHub App: Active/u);
  assert.match(mainText, /Repository access: (Maintain|Admin) access/u);
  return mainText;
}

async function applySelection(page, inputs, target, selection, expectedPolicy, expectedReleaseId) {
  await visitRepository(page, inputs, target);
  const previewForm = page.locator("form").filter({
    has: page.locator('input[name="action"][value="preview"]'),
  });
  assert.equal(await previewForm.count(), 1, "repository maintainers must receive a preview form");
  await previewForm.locator('select[name="releasePolicy"]').selectOption(expectedPolicy);
  await previewForm.locator('select[name="releaseId"]').selectOption(expectedReleaseId);
  await previewForm.locator('select[name="moduleIds"]').selectOption(selection.moduleIds);
  await previewForm
    .locator('select[name="resourceProfileId"]')
    .selectOption(selection.resourceProfileId);
  ensureOwnerLifetime(inputs.inventory, 10);
  await previewForm.getByRole("button", { name: "Preview selection", exact: true }).click();
  await page.getByText("Supported module configuration", { exact: true }).waitFor();
  const configureForm = page.locator("form").filter({
    has: page.locator('input[name="action"][value="configure"]'),
  });
  assert.equal(await configureForm.count(), 1);
  const selected = {
    releasePolicy: await configureForm.locator('select[name="releasePolicy"]').inputValue(),
    releaseId: await configureForm.locator('select[name="releaseId"]').inputValue(),
    moduleIds: await configureForm
      .locator('select[name="moduleIds"] option:checked')
      .evaluateAll((options) => options.map((option) => option.value).sort()),
    resourceProfileId: await configureForm.locator('select[name="resourceProfileId"]').inputValue(),
  };
  assert.equal(selected.releasePolicy, expectedPolicy);
  assert.equal(selected.releaseId, expectedReleaseId);
  assert.equal(selected.resourceProfileId, selection.resourceProfileId);
  assert.ok(equalStringSet(selected.moduleIds, selection.moduleIds));
  return configureForm;
}

async function saveSelection(page, inputs, target, selection, expectedPolicy, expectedReleaseId) {
  const form = await applySelection(
    page,
    inputs,
    target,
    selection,
    expectedPolicy,
    expectedReleaseId,
  );
  const actionPath = `/repositories/${encodeURIComponent(String(target.repositoryId))}/actions`;
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().startsWith(`${inputs.gatewayOrigin.origin}${actionPath}`) &&
      response.request().method() === "POST",
  );
  ensureOwnerLifetime(inputs.inventory, 10);
  await form.getByRole("button", { name: "Save and build", exact: true }).click();
  const response = await responsePromise;
  assert.equal(response.status(), 202, "Gateway must enqueue the real configuration build");
}

async function redeployThroughUi(page, inputs, target) {
  await visitRepository(page, inputs, target);
  const actionPath = `/repositories/${encodeURIComponent(String(target.repositoryId))}/actions`;
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().startsWith(`${inputs.gatewayOrigin.origin}${actionPath}`) &&
      response.request().method() === "POST",
  );
  ensureOwnerLifetime(inputs.inventory, 10);
  await page.getByRole("button", { name: "Redeploy current configuration", exact: true }).click();
  const response = await responsePromise;
  assert.equal(response.status(), 202, "Gateway must enqueue the same-artifact redeploy");
}

async function waitForDashboard(inputs, target, predicate, timeoutSeconds, assertion) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let latest;
  while (Date.now() < deadline) {
    ensureOwnerLifetime(inputs.inventory, 5);
    latest = await getDashboard(inputs, target);
    if (predicate(latest)) return latest;
    await delay(1_500);
  }
  assert.fail(assertion);
}

function assertNoActiveOperation(dashboard, label) {
  assert.equal(
    dashboard.operations.some((operation) =>
      ["pending", "claimed", "running"].includes(operation.status),
    ),
    false,
    `${label} must have no pending lifecycle operation before the next product action`,
  );
}

function assertReadyCurrent(dashboard, selection, releaseId) {
  assert.equal(dashboard.snapshot.instance.observedState, "ready");
  assert.equal(dashboard.snapshot.instance.desiredState, "running");
  assert.equal(
    dashboard.snapshot.instance.currentArtifactDigest,
    dashboard.snapshot.instance.desiredArtifactDigest,
  );
  assert.equal(dashboard.current?.selection.policy, selection.releasePolicy);
  assert.equal(dashboard.current?.selection.releaseId, releaseId);
  assert.ok(
    equalStringSet(dashboard.current?.selection.requestedModules ?? [], selection.moduleIds),
  );
  assert.equal(dashboard.current?.selection.resourceProfileId, selection.resourceProfileId);
}

function assertRuntimeTarget(inputs, target, value, expected) {
  const namespaceName = runtimeNamespace(inputs, target.instanceId);
  const expectedName = runtimeDeploymentName(target.instanceId);
  const metadata = objectMetadata(value);
  const labels = metadata.labels ?? {};
  assert.equal(metadata.name, expectedName);
  assert.equal(metadata.namespace, namespaceName);
  assert.ok(typeof metadata.uid === "string" && metadata.uid.length > 0);
  assert.ok(typeof metadata.resourceVersion === "string" && metadata.resourceVersion.length > 0);
  for (const [key, valueExpected] of Object.entries({
    [PLATFORM_LABEL]: PLATFORM_VALUE,
    [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
    [INSTANCE_LABEL]: target.instanceId,
    [REPOSITORY_LABEL]: String(target.repositoryId),
    [CLUSTER_LABEL]: inputs.kubeConfig.cluster.id,
    [EPOCH_LABEL]: String(expected.runtimeEpoch),
    [OWNERSHIP_LABEL]: "v1",
    [APP_LABEL]: "scriptorium",
    [RELEASE_LABEL]: expected.releaseId || NO_RELEASE,
  })) {
    assert.equal(labels[key], valueExpected, `target runtime ownership label ${key} must match`);
  }
  const podLabels = value?.spec?.template?.metadata?.labels ?? {};
  for (const key of [
    PLATFORM_LABEL,
    MANAGED_BY_LABEL,
    INSTANCE_LABEL,
    REPOSITORY_LABEL,
    CLUSTER_LABEL,
    EPOCH_LABEL,
    OWNERSHIP_LABEL,
    APP_LABEL,
    RELEASE_LABEL,
  ]) {
    assert.equal(
      podLabels[key],
      labels[key],
      `target Pod template label ${key} must match Deployment`,
    );
  }
  const container = appContainer(value);
  assert.ok(container, "target Deployment must contain the Scriptorium runtime container");
  assert.ok(container.image.endsWith(`@${expected.artifactDigest}`));
  assert.equal(metadata.annotations?.["arcadia.io/release-digest"], expected.artifactDigest);
  return { metadata, container };
}

async function patchJsonResource(transport, resourcePath, operations, timeoutMs) {
  const response = await transport.request({
    method: "PATCH",
    path: resourcePath,
    headers: {
      accept: "application/json",
      "content-type": "application/json-patch+json",
    },
    body: JSON.stringify(operations),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`owned Kubernetes mutation was rejected with HTTP ${response.statusCode}`);
  }
  return response.body;
}

function resourcePath(kind, namespaceName, name) {
  const plural = kind === "Deployment" ? "deployments" : kind === "Service" ? "services" : null;
  const api = kind === "Deployment" ? "/apis/apps/v1" : kind === "Service" ? "/api/v1" : null;
  if (!plural || !api) throw new TypeError("unsupported fixed rollout mutation resource");
  return `${api}/namespaces/${encodeURIComponent(namespaceName)}/${plural}/${encodeURIComponent(name)}`;
}

function testOwnerMetadata(metadata, target, clusterId, epoch) {
  return [
    { op: "test", path: "/metadata/uid", value: metadata.uid },
    { op: "test", path: "/metadata/resourceVersion", value: metadata.resourceVersion },
    {
      op: "test",
      path: `/metadata/labels/${REPOSITORY_LABEL.replaceAll("/", "~1")}`,
      value: String(target.repositoryId),
    },
    {
      op: "test",
      path: `/metadata/labels/${INSTANCE_LABEL.replaceAll("/", "~1")}`,
      value: target.instanceId,
    },
    {
      op: "test",
      path: `/metadata/labels/${CLUSTER_LABEL.replaceAll("/", "~1")}`,
      value: clusterId,
    },
    {
      op: "test",
      path: `/metadata/labels/${EPOCH_LABEL.replaceAll("/", "~1")}`,
      value: String(epoch),
    },
    { op: "test", path: `/metadata/labels/${OWNERSHIP_LABEL.replaceAll("/", "~1")}`, value: "v1" },
  ];
}

async function enableServiceForUnreadyControl(
  inputs,
  target,
  epoch,
  releaseId,
  api,
  transport,
  namespaceUid,
  onPrepared,
) {
  const namespaceName = runtimeNamespace(inputs, target.instanceId);
  const serviceName = runtimeDeploymentName(target.instanceId);
  const namespace = await api.getNamespace(namespaceName);
  assert.equal(
    objectMetadata(namespace).uid,
    namespaceUid,
    "owned namespace UID changed before injection",
  );
  const namespaceOwner = namespaceLabels(namespace);
  assert.equal(namespaceOwner[INSTANCE_LABEL], target.instanceId);
  assert.equal(namespaceOwner[REPOSITORY_LABEL], String(target.repositoryId));
  assert.equal(namespaceOwner[CLUSTER_LABEL], inputs.kubeConfig.cluster.id);
  const service = await api.get({ kind: "Service", namespace: namespaceName, name: serviceName });
  const metadata = objectMetadata(service);
  const labels = runtimeLabels(service);
  assert.equal(metadata.name, serviceName);
  assert.equal(metadata.namespace, namespaceName);
  for (const [key, expected] of Object.entries({
    [PLATFORM_LABEL]: PLATFORM_VALUE,
    [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
    [INSTANCE_LABEL]: target.instanceId,
    [REPOSITORY_LABEL]: String(target.repositoryId),
    [CLUSTER_LABEL]: inputs.kubeConfig.cluster.id,
    [EPOCH_LABEL]: String(epoch),
    [OWNERSHIP_LABEL]: "v1",
    [APP_LABEL]: "scriptorium",
    [RELEASE_LABEL]: releaseId || NO_RELEASE,
  })) {
    assert.equal(labels[key], expected, `owned runtime Service label ${key} must match`);
  }
  assert.deepEqual(service?.spec?.selector, {
    [INSTANCE_LABEL]: target.instanceId,
    [APP_LABEL]: "scriptorium",
  });
  if (service?.spec?.publishNotReadyAddresses === true) {
    assert.fail(
      "owned runtime Service unexpectedly published not-ready endpoints before injection",
    );
  }
  const publishFieldWasPresent = Object.hasOwn(service?.spec ?? {}, "publishNotReadyAddresses");
  const state = {
    name: serviceName,
    namespace: namespaceName,
    namespaceUid,
    uid: metadata.uid,
    epoch,
    publishFieldWasPresent,
    originalPublishValue: publishFieldWasPresent
      ? service.spec.publishNotReadyAddresses
      : undefined,
    originalPublishEnabled: service.spec.publishNotReadyAddresses === true,
  };
  onPrepared(state);
  await patchJsonResource(
    transport,
    resourcePath("Service", namespaceName, serviceName),
    [
      ...testOwnerMetadata(metadata, target, inputs.kubeConfig.cluster.id, epoch),
      ...(publishFieldWasPresent
        ? [
            {
              op: "test",
              path: "/spec/publishNotReadyAddresses",
              value: service.spec.publishNotReadyAddresses,
            },
            { op: "replace", path: "/spec/publishNotReadyAddresses", value: true },
          ]
        : [{ op: "add", path: "/spec/publishNotReadyAddresses", value: true }]),
    ],
    inputs.kubeConfig.timeouts.requestMs,
  );
  return state;
}

async function injectUnreadyTarget(
  inputs,
  target,
  deployment,
  expected,
  api,
  transport,
  namespaceUid,
) {
  const namespaceName = runtimeNamespace(inputs, target.instanceId);
  const { metadata, container } = assertRuntimeTarget(inputs, target, deployment, expected);
  const currentReadinessPath = readinessPath(deployment);
  assert.equal(
    currentReadinessPath,
    inputs.manifest.runtimeMetadata.paths.readiness,
    "target readiness path must match its admitted Scriptorium runtime metadata",
  );
  const injectedPath = `/__praetorium_rollout_unready_${randomBytes(8).toString("hex")}`;
  assert.notEqual(injectedPath, currentReadinessPath);
  const injection = {
    deploymentUid: metadata.uid,
    namespaceUid,
    runtimeEpoch: expected.runtimeEpoch,
    releaseId: expected.releaseId,
    artifactDigest: expected.artifactDigest,
    originalReadinessPath: currentReadinessPath,
    injectedReadinessPath: injectedPath,
    serviceState: null,
  };
  try {
    injection.serviceState = await enableServiceForUnreadyControl(
      inputs,
      target,
      expected.runtimeEpoch,
      expected.releaseId,
      api,
      transport,
      namespaceUid,
      (state) => {
        injection.serviceState = state;
      },
    );
    const liveNamespace = await api.getNamespace(namespaceName);
    assert.equal(objectMetadata(liveNamespace).uid, namespaceUid);
    const latest = await api.get({
      kind: "Deployment",
      namespace: namespaceName,
      name: runtimeDeploymentName(target.instanceId),
    });
    const latestMetadata = assertRuntimeTarget(inputs, target, latest, expected).metadata;
    assert.equal(
      latestMetadata.uid,
      metadata.uid,
      "target Deployment UID changed before failure injection",
    );
    const latestContainer = appContainer(latest);
    assert.equal(latestContainer.name, container.name);
    assert.equal(readinessPath(latest), currentReadinessPath);
    await patchJsonResource(
      transport,
      resourcePath("Deployment", namespaceName, runtimeDeploymentName(target.instanceId)),
      [
        ...testOwnerMetadata(
          latestMetadata,
          target,
          inputs.kubeConfig.cluster.id,
          expected.runtimeEpoch,
        ),
        {
          op: "test",
          path: "/spec/template/spec/containers/0/name",
          value: "scriptorium",
        },
        {
          op: "test",
          path: "/spec/template/spec/containers/0/readinessProbe/httpGet/path",
          value: currentReadinessPath,
        },
        {
          op: "replace",
          path: "/spec/template/spec/containers/0/readinessProbe/httpGet/path",
          value: injectedPath,
        },
      ],
      inputs.kubeConfig.timeouts.requestMs,
    );
    return injection;
  } catch (error) {
    if (injection.serviceState) {
      const cleanupErrors = [];
      try {
        const latest = await api.get({
          kind: "Deployment",
          namespace: namespaceName,
          name: runtimeDeploymentName(target.instanceId),
        });
        if (readinessPath(latest) === injectedPath) {
          await restoreInjectedReadiness(
            inputs,
            target,
            api,
            transport,
            injection,
            expected.runtimeEpoch,
            expected.artifactDigest,
            expected.releaseId,
            currentReadinessPath,
          );
        }
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      try {
        await restoreServicePublishNotReady(
          inputs,
          target,
          api,
          transport,
          injection,
          expected.runtimeEpoch,
          expected.releaseId,
        );
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (cleanupErrors.length > 0 && error instanceof Error) {
        error.cleanupError =
          "bounded failure injection partially applied and cleanup needs attention";
      }
    }
    throw error;
  }
}

async function reassertUnreadyTarget(inputs, target, api, transport, expected, injection) {
  const namespace = await api.getNamespace(runtimeNamespace(inputs, target.instanceId));
  assert.equal(objectMetadata(namespace).uid, injection.namespaceUid);
  const deployment = await api.get({
    kind: "Deployment",
    namespace: runtimeNamespace(inputs, target.instanceId),
    name: runtimeDeploymentName(target.instanceId),
  });
  const { metadata } = assertRuntimeTarget(inputs, target, deployment, expected);
  assert.equal(metadata.uid, injection.deploymentUid);
  const observedPath = readinessPath(deployment);
  if (observedPath !== injection.injectedReadinessPath) {
    if (observedPath !== injection.originalReadinessPath) {
      throw new Error(
        "target runtime readiness path changed outside the bounded failure injection",
      );
    }
    await patchJsonResource(
      transport,
      resourcePath("Deployment", metadata.namespace, metadata.name),
      [
        ...testOwnerMetadata(metadata, target, inputs.kubeConfig.cluster.id, expected.runtimeEpoch),
        {
          op: "test",
          path: "/spec/template/spec/containers/0/readinessProbe/httpGet/path",
          value: injection.originalReadinessPath,
        },
        {
          op: "replace",
          path: "/spec/template/spec/containers/0/readinessProbe/httpGet/path",
          value: injection.injectedReadinessPath,
        },
      ],
      inputs.kubeConfig.timeouts.requestMs,
    );
  }

  const service = await api.get({
    kind: "Service",
    namespace: runtimeNamespace(inputs, target.instanceId),
    name: runtimeDeploymentName(target.instanceId),
  });
  const serviceMetadata = objectMetadata(service);
  assert.equal(serviceMetadata.uid, injection.serviceState.uid);
  const serviceLabels = runtimeLabels(service);
  assert.equal(serviceLabels[INSTANCE_LABEL], target.instanceId);
  assert.equal(serviceLabels[REPOSITORY_LABEL], String(target.repositoryId));
  assert.equal(serviceLabels[CLUSTER_LABEL], inputs.kubeConfig.cluster.id);
  assert.equal(serviceLabels[EPOCH_LABEL], String(expected.runtimeEpoch));
  assert.equal(serviceLabels[OWNERSHIP_LABEL], "v1");
  const publishValue = service?.spec?.publishNotReadyAddresses;
  if (publishValue === true) return false;
  assert.ok(
    publishValue === undefined || publishValue === false,
    "owned runtime Service has an unsupported publishNotReadyAddresses value",
  );
  await patchJsonResource(
    transport,
    resourcePath("Service", serviceMetadata.namespace, serviceMetadata.name),
    [
      ...testOwnerMetadata(
        serviceMetadata,
        target,
        inputs.kubeConfig.cluster.id,
        expected.runtimeEpoch,
      ),
      ...(publishValue === undefined
        ? [{ op: "add", path: "/spec/publishNotReadyAddresses", value: true }]
        : [
            { op: "test", path: "/spec/publishNotReadyAddresses", value: false },
            { op: "replace", path: "/spec/publishNotReadyAddresses", value: true },
          ]),
    ],
    inputs.kubeConfig.timeouts.requestMs,
  );
  return true;
}

async function restoreInjectedReadiness(
  inputs,
  target,
  api,
  transport,
  injection,
  expectedEpoch,
  expectedArtifact,
  expectedReleaseId,
  originalPath,
) {
  const namespaceName = runtimeNamespace(inputs, target.instanceId);
  const namespace = await api.getNamespace(namespaceName);
  assert.equal(objectMetadata(namespace).uid, injection.namespaceUid);
  const namespaceOwner = namespaceLabels(namespace);
  assert.equal(namespaceOwner[INSTANCE_LABEL], target.instanceId);
  assert.equal(namespaceOwner[REPOSITORY_LABEL], String(target.repositoryId));
  assert.equal(namespaceOwner[CLUSTER_LABEL], inputs.kubeConfig.cluster.id);
  const latest = await api.get({
    kind: "Deployment",
    namespace: namespaceName,
    name: runtimeDeploymentName(target.instanceId),
  });
  const metadata = objectMetadata(latest);
  if (metadata.uid !== injection.deploymentUid) {
    throw new Error(
      "owned runtime Deployment UID changed while restoring the injected readiness path",
    );
  }
  if (readinessPath(latest) !== injection.injectedReadinessPath) {
    if (readinessPath(latest) === originalPath) return;
    throw new Error(
      "owned runtime Deployment readiness path changed outside the bounded injection",
    );
  }
  assertRuntimeTarget(inputs, target, latest, {
    runtimeEpoch: expectedEpoch,
    releaseId: expectedReleaseId,
    artifactDigest: expectedArtifact,
  });
  const current = appContainer(latest);
  await patchJsonResource(
    transport,
    resourcePath("Deployment", namespaceName, runtimeDeploymentName(target.instanceId)),
    [
      ...testOwnerMetadata(metadata, target, inputs.kubeConfig.cluster.id, expectedEpoch),
      { op: "test", path: "/spec/template/spec/containers/0/name", value: "scriptorium" },
      {
        op: "test",
        path: "/spec/template/spec/containers/0/readinessProbe/httpGet/path",
        value: injection.injectedReadinessPath,
      },
      {
        op: "replace",
        path: "/spec/template/spec/containers/0/readinessProbe/httpGet/path",
        value: originalPath,
      },
    ],
    inputs.kubeConfig.timeouts.requestMs,
  );
  assert.ok(current);
}

async function restoreServicePublishNotReady(
  inputs,
  target,
  api,
  transport,
  injection,
  expectedEpoch,
  expectedReleaseId,
) {
  const state = injection.serviceState;
  const namespace = await api.getNamespace(state.namespace);
  assert.equal(objectMetadata(namespace).uid, state.namespaceUid);
  const service = await api.get({ kind: "Service", namespace: state.namespace, name: state.name });
  const metadata = objectMetadata(service);
  assert.equal(metadata.uid, state.uid);
  const labels = runtimeLabels(service);
  for (const [key, expected] of Object.entries({
    [PLATFORM_LABEL]: PLATFORM_VALUE,
    [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
    [INSTANCE_LABEL]: target.instanceId,
    [REPOSITORY_LABEL]: String(target.repositoryId),
    [CLUSTER_LABEL]: inputs.kubeConfig.cluster.id,
    [EPOCH_LABEL]: String(expectedEpoch),
    [OWNERSHIP_LABEL]: "v1",
    [APP_LABEL]: "scriptorium",
    [RELEASE_LABEL]: expectedReleaseId || NO_RELEASE,
  })) {
    assert.equal(labels[key], expected, `Service cleanup ownership label ${key} changed`);
  }
  if (service?.spec?.publishNotReadyAddresses !== true) return;
  const operations = [
    ...testOwnerMetadata(metadata, target, inputs.kubeConfig.cluster.id, expectedEpoch),
    { op: "test", path: "/spec/publishNotReadyAddresses", value: true },
    ...(state.publishFieldWasPresent
      ? [
          {
            op: "replace",
            path: "/spec/publishNotReadyAddresses",
            value: state.originalPublishValue,
          },
        ]
      : [{ op: "remove", path: "/spec/publishNotReadyAddresses" }]),
  ];
  await patchJsonResource(
    transport,
    resourcePath("Service", state.namespace, state.name),
    operations,
    inputs.kubeConfig.timeouts.requestMs,
  );
}

async function waitForBuildFailure(inputs, target, expectedErrorCode, timeoutSeconds) {
  return waitForDashboard(
    inputs,
    target,
    (dashboard) => dashboard.build?.status === "failed",
    timeoutSeconds,
    "the real configuration build did not report its expected failure before the owned deadline",
  ).then((dashboard) => {
    assert.equal(dashboard.build?.errorCode, expectedErrorCode);
    return dashboard;
  });
}

async function waitForConfiguredRuntime(
  inputs,
  target,
  selection,
  releaseId,
  previousDigest,
  timeoutSeconds,
) {
  const dashboard = await waitForDashboard(
    inputs,
    target,
    (latest) =>
      latest.snapshot.instance.observedState === "ready" &&
      latest.snapshot.instance.desiredState === "running" &&
      latest.current?.selection.releaseId === releaseId &&
      latest.current?.selection.policy === selection.releasePolicy &&
      equalStringSet(latest.current?.selection.requestedModules ?? [], selection.moduleIds) &&
      latest.current?.selection.resourceProfileId === selection.resourceProfileId &&
      latest.snapshot.instance.currentArtifactDigest !== null &&
      latest.snapshot.instance.currentArtifactDigest ===
        latest.snapshot.instance.desiredArtifactDigest,
    timeoutSeconds,
    "the real selected composition did not become the ready current runtime before the owned deadline",
  );
  assertReadyCurrent(dashboard, selection, releaseId);
  assert.notEqual(
    dashboard.snapshot.instance.currentArtifactDigest,
    previousDigest,
    "a distinct legal composition must produce an independently admitted artifact",
  );
  assert.equal(dashboard.current?.status, "admitted");
  return dashboard;
}

async function waitForSameDigestRedeploy(inputs, target, previous, timeoutSeconds) {
  const dashboard = await waitForDashboard(
    inputs,
    target,
    (latest) =>
      latest.snapshot.instance.observedState === "ready" &&
      latest.snapshot.instance.observedRuntimeEpoch > previous.snapshot.instance.runtimeEpoch &&
      latest.snapshot.instance.currentArtifactDigest ===
        previous.snapshot.instance.currentArtifactDigest &&
      latest.snapshot.instance.currentArtifactDigest ===
        latest.snapshot.instance.desiredArtifactDigest &&
      latest.current?.revisionId === previous.current?.revisionId,
    timeoutSeconds,
    "same-digest redeployment did not reach a fresh ready runtime epoch",
  );
  assert.equal(
    dashboard.snapshot.instance.currentArtifactDigest,
    previous.snapshot.instance.currentArtifactDigest,
  );
  assert.ok(
    dashboard.snapshot.instance.observedRuntimeEpoch >
      previous.snapshot.instance.observedRuntimeEpoch,
  );
  return dashboard;
}

function operationById(dashboard, operationId) {
  return dashboard.operations.find((operation) => operation.id === operationId) ?? null;
}

async function performCompatibleRollback(
  page,
  inputs,
  target,
  candidateReleaseId,
  startingDashboard,
  providerApi,
  controllerTransport,
  namespaceUid,
) {
  assertNoActiveOperation(startingDashboard, "stable target before rollback injection");
  const originalDigest = startingDashboard.snapshot.instance.currentArtifactDigest;
  const originalRuntimeEpoch = startingDashboard.snapshot.instance.runtimeEpoch;
  const originalRevisionId = startingDashboard.current?.revisionId;
  assert.equal(startingDashboard.current?.selection.releaseId, candidateReleaseId);
  const buildDeadline =
    Date.now() +
    (inputs.config.timeouts.buildSeconds + inputs.config.timeouts.rollbackSeconds) * 1000;
  await saveSelection(
    page,
    inputs,
    target,
    inputs.config.scenarios.rollback,
    "stable",
    candidateReleaseId,
  );

  let targetOperation;
  let targetDigest;
  let targetEpoch;
  let injection;
  let primaryError;
  let completed;
  let injectionCleanupError;
  try {
    while (Date.now() < buildDeadline && injection === undefined) {
      ensureOwnerLifetime(inputs.inventory, 5);
      const dashboard = await getDashboard(inputs, target);
      if (dashboard.build?.status === "failed" || dashboard.build?.status === "cancelled") {
        assert.fail(
          `rollback composition build failed with ${dashboard.build.errorCode ?? "unknown"}`,
        );
      }
      if (
        dashboard.desired?.selection.policy === "stable" &&
        dashboard.desired.selection.releaseId === candidateReleaseId &&
        equalStringSet(
          dashboard.desired.selection.requestedModules,
          inputs.config.scenarios.rollback.moduleIds,
        ) &&
        dashboard.desired.selection.resourceProfileId ===
          inputs.config.scenarios.rollback.resourceProfileId &&
        dashboard.desired.status === "admitted" &&
        dashboard.desired.artifactDigest &&
        dashboard.desired.artifactDigest !== originalDigest
      ) {
        targetDigest = dashboard.desired.artifactDigest;
        targetOperation = dashboard.operations.find(
          (operation) =>
            operation.generation === dashboard.snapshot.instance.generation &&
            operation.kind === "update" &&
            operation.runtimeEpoch > originalRuntimeEpoch,
        );
        if (targetOperation) {
          targetEpoch = targetOperation.runtimeEpoch;
          if (["failed", "blocked", "succeeded"].includes(targetOperation.status)) {
            assert.fail("target lifecycle operation completed before the owned failure injection");
          }
          if (["target-ready", "route-activated", "complete"].includes(targetOperation.phase)) {
            assert.fail(
              "failure injection arrived after the target passed readiness or route activation",
            );
          }
          if (targetOperation.phase === "starting-target") {
            const namespace = await providerApi.getNamespace(
              runtimeNamespace(inputs, target.instanceId),
            );
            assert.equal(
              namespace?.metadata?.uid,
              namespaceUid,
              "owned instance namespace UID changed before target rollout",
            );
            const deployment = await providerApi.get({
              kind: "Deployment",
              namespace: runtimeNamespace(inputs, target.instanceId),
              name: runtimeDeploymentName(target.instanceId),
            });
            const labels = runtimeLabels(deployment);
            const deploymentDigest = /@(?<digest>sha256:[0-9a-f]{64})$/u.exec(
              appContainer(deployment)?.image ?? "",
            )?.groups?.digest;
            if (
              labels[INSTANCE_LABEL] === target.instanceId &&
              labels[REPOSITORY_LABEL] === String(target.repositoryId) &&
              labels[CLUSTER_LABEL] === inputs.kubeConfig.cluster.id &&
              labels[EPOCH_LABEL] === String(targetEpoch) &&
              labels[OWNERSHIP_LABEL] === "v1" &&
              deploymentDigest === targetDigest &&
              dashboard.current?.artifactDigest === originalDigest
            ) {
              const expectedTarget = {
                runtimeEpoch: targetEpoch,
                releaseId: candidateReleaseId,
                artifactDigest: targetDigest,
              };
              assertRuntimeTarget(inputs, target, deployment, expectedTarget);
              injection = await injectUnreadyTarget(
                inputs,
                target,
                deployment,
                expectedTarget,
                providerApi,
                controllerTransport,
                namespaceUid,
              );
            }
          }
        }
      }
      if (injection === undefined) await delay(125);
    }
    assert.ok(
      injection,
      "owned Kubernetes failure injection did not reach the exact target Deployment",
    );

    const rollbackDeadline = Date.now() + inputs.config.timeouts.rollbackSeconds * 1000;
    while (Date.now() < rollbackDeadline) {
      ensureOwnerLifetime(inputs.inventory, 5);
      const dashboard = await getDashboard(inputs, target);
      const failedOperation = operationById(dashboard, targetOperation.id);
      if (failedOperation?.status === "failed" && failedOperation.phase === "failed") {
        if (
          dashboard.snapshot.instance.observedState === "ready" &&
          dashboard.snapshot.instance.observedRuntimeEpoch > targetEpoch &&
          dashboard.snapshot.instance.currentArtifactDigest === originalDigest &&
          dashboard.current?.revisionId === originalRevisionId &&
          dashboard.current?.selection.releaseId === candidateReleaseId &&
          equalStringSet(
            dashboard.current.selection.requestedModules,
            inputs.config.scenarios.configurationChange.moduleIds,
          )
        ) {
          completed = dashboard;
          break;
        }
        assert.fail(
          "failed target did not recover the previously admitted composition at a fresh epoch",
        );
      }
      if (["succeeded", "blocked"].includes(failedOperation?.status)) {
        assert.fail("failed target did not produce a compatible prior-runtime rollback");
      }
      if (
        failedOperation?.phase === "target-ready" ||
        failedOperation?.phase === "route-activated" ||
        failedOperation?.phase === "complete"
      ) {
        assert.fail(
          "failure injection arrived after the target passed readiness or route activation",
        );
      }
      if (failedOperation?.phase === "starting-target") {
        const live = await providerApi.get({
          kind: "Deployment",
          namespace: runtimeNamespace(inputs, target.instanceId),
          name: runtimeDeploymentName(target.instanceId),
        });
        const liveDigest = /@(?<digest>sha256:[0-9a-f]{64})$/u.exec(appContainer(live)?.image ?? "")
          ?.groups?.digest;
        if (
          runtimeLabels(live)[EPOCH_LABEL] === String(targetEpoch) &&
          liveDigest === targetDigest &&
          readinessPath(live) === injection.originalReadinessPath
        ) {
          await reassertUnreadyTarget(
            inputs,
            target,
            providerApi,
            controllerTransport,
            {
              runtimeEpoch: targetEpoch,
              releaseId: candidateReleaseId,
              artifactDigest: targetDigest,
            },
            injection,
          );
        }
      }
      await delay(100);
    }
    assert.ok(completed, "target readiness failure did not complete a fresh compatible rollback");
    assert.equal(operationById(completed, targetOperation.id)?.status, "failed");
    assert.equal(completed.snapshot.instance.currentArtifactDigest, originalDigest);
    assert.ok(completed.snapshot.instance.runtimeEpoch > targetEpoch);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (injection) {
      let cleanupError;
      try {
        const latest = await getDashboard(inputs, target);
        const currentEpoch = latest.snapshot.instance.runtimeEpoch;
        const currentDigest = latest.snapshot.instance.currentArtifactDigest;
        const currentReleaseId = latest.current?.selection.releaseId ?? candidateReleaseId;
        const currentReadinessPath =
          latest.current?.runtimeMetadata.paths.readiness ?? injection.originalReadinessPath;
        const currentDeployment = await providerApi.get({
          kind: "Deployment",
          namespace: runtimeNamespace(inputs, target.instanceId),
          name: runtimeDeploymentName(target.instanceId),
        });
        const currentEpochLabel = Number(runtimeLabels(currentDeployment)[EPOCH_LABEL]);
        const currentImageDigest = /@(?<digest>sha256:[0-9a-f]{64})$/u.exec(
          appContainer(currentDeployment)?.image ?? "",
        )?.groups?.digest;
        const isFailedTarget =
          currentEpochLabel === injection.runtimeEpoch &&
          currentImageDigest === injection.artifactDigest;
        const restoreEpoch = isFailedTarget ? injection.runtimeEpoch : currentEpoch;
        const restoreDigest = isFailedTarget ? injection.artifactDigest : currentDigest;
        const restoreReleaseId = isFailedTarget ? injection.releaseId : currentReleaseId;
        const restorePath = isFailedTarget ? injection.originalReadinessPath : currentReadinessPath;
        await restoreInjectedReadiness(
          inputs,
          target,
          providerApi,
          controllerTransport,
          injection,
          restoreEpoch,
          restoreDigest,
          restoreReleaseId,
          restorePath,
        );
        await restoreServicePublishNotReady(
          inputs,
          target,
          providerApi,
          controllerTransport,
          injection,
          restoreEpoch,
          restoreReleaseId,
        );
        const restoredService = await providerApi.get({
          kind: "Service",
          namespace: injection.serviceState.namespace,
          name: injection.serviceState.name,
        });
        assert.equal(
          restoredService?.spec?.publishNotReadyAddresses === true,
          injection.serviceState.originalPublishEnabled,
          "bounded runtime failure injection must restore the original Service endpoint behavior",
        );
        const restoredDeployment = await providerApi.get({
          kind: "Deployment",
          namespace: runtimeNamespace(inputs, target.instanceId),
          name: runtimeDeploymentName(target.instanceId),
        });
        assert.equal(readinessPath(restoredDeployment), restorePath);
      } catch (error) {
        cleanupError = error;
      }
      if (cleanupError) {
        if (primaryError) {
          primaryError.cleanupError =
            "owned runtime cleanup did not restore bounded failure injection";
        } else {
          injectionCleanupError = cleanupError;
        }
      }
    }
  }
  if (injectionCleanupError) throw injectionCleanupError;
  const recovered = await waitForDashboard(
    inputs,
    target,
    (latest) =>
      latest.snapshot.instance.observedState === "ready" &&
      latest.snapshot.instance.currentArtifactDigest === originalDigest &&
      latest.snapshot.instance.observedRuntimeEpoch > targetEpoch &&
      latest.current?.revisionId === originalRevisionId,
    Math.min(inputs.config.timeouts.rollbackSeconds, 120),
    "restored rollback readiness injection did not leave the previous runtime Ready",
  );
  const runtime = await readRuntimeObjects(inputs, target, recovered, providerApi);
  assert.equal(runtime.deployment.metadata.uid, injection.deploymentUid);
  assert.equal(readinessPath(runtime.deployment), injection.originalReadinessPath);

  const failedOperation = operationById(recovered, targetOperation.id);
  assert.ok(failedOperation);
  const evidence = await getOperationEvidence(inputs, targetOperation.id);
  assert.equal(evidence.operation.id, failedOperation.id);
  assert.equal(evidence.operation.status, "failed");
  assert.equal(evidence.operation.phase, "failed");
  assert.equal(evidence.operation.runtimeEpoch, targetEpoch);
  assert.equal(
    evidence.rollbackCompatible,
    true,
    "failed rollout must persist the positive result of the admitted-manifest compatibility check",
  );
  const rollback = evidence.rollbackCompatibilityEvidence;
  const readiness = evidence.readinessEvidence;
  const declarations = evidence.rollbackDeclarations;
  assert.ok(rollback, "failed target must expose its persisted compatibility proof");
  assert.ok(readiness, "recovered prior runtime must expose fresh Scriptorium readiness evidence");
  assert.ok(declarations, "rollback must expose both parsed admitted persistence declarations");
  assert.equal(rollback.contractVersion, "praetorium-rollback-compatibility/v1");
  assert.equal(rollback.instanceId, target.instanceId);
  assert.equal(rollback.repositoryId, target.repositoryId);
  assert.equal(rollback.runtimeEpoch, targetEpoch);
  assert.equal(rollback.imageDigest, targetDigest);
  assert.match(rollback.compositionManifestDigest, DIGEST);
  assert.notEqual(
    rollback.compositionManifestDigest,
    readiness.compositionManifestDigest,
    "failed target composition proof must differ from the restored prior composition",
  );
  assert.equal(declarations.target.imageDigest, targetDigest);
  assert.equal(declarations.target.imageDigest, rollback.imageDigest);
  assert.equal(declarations.target.compositionManifestDigest, rollback.compositionManifestDigest);
  assert.equal(declarations.previous.imageDigest, originalDigest);
  assert.equal(rollback.quiesceRevision, originalRevisionId);
  assert.match(rollback.observedRemoteCommit, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
  assert.equal(rollback.observedRemoteCommit, rollback.quiesceRemoteCommit);
  assert.ok(Number.isFinite(Date.parse(rollback.providerObservedAt)));
  assert.ok(Number.isFinite(Date.parse(rollback.observedAt)));
  assert.ok(
    Date.parse(rollback.providerObservedAt) <= Date.parse(rollback.observedAt),
    "writer census must be no newer than the Scriptorium persistence snapshot",
  );

  const readinessAssignment = readiness.assignment;
  const readinessDeployment = readinessAssignment.deployment;
  assert.equal(readinessAssignment.instanceId, target.instanceId);
  assert.equal(readinessAssignment.repositoryId, target.repositoryId);
  assert.equal(readinessAssignment.runtimeEpoch, recovered.snapshot.instance.runtimeEpoch);
  assert.ok(readinessAssignment.runtimeEpoch > targetEpoch);
  assert.equal(readinessAssignment.generation, recovered.snapshot.instance.generation);
  assert.equal(readinessAssignment.clusterId, inputs.kubeConfig.cluster.id);
  assert.equal(readinessDeployment.revisionId, originalRevisionId);
  assert.equal(readinessDeployment.imageDigest, originalDigest);
  assert.equal(
    declarations.previous.compositionManifestDigest,
    readinessDeployment.compositionManifestDigest,
  );
  assert.equal(readiness.actualImageDigest, readinessDeployment.platformManifestDigest);
  assert.equal(readiness.compositionManifestDigest, readinessDeployment.compositionManifestDigest);
  assert.deepEqual(
    [...readiness.enabledModuleIds].sort(),
    [...(startingDashboard.current?.resolvedModules ?? []).map((module) => module.id)].sort(),
  );
  for (const field of [
    "providerObservationId",
    "applicationProbeId",
    "validGrantProbeId",
    "wrongRepositoryProbeId",
    "wrongEpochProbeId",
    "invalidServiceCredentialProbeId",
    "uiApiMcpProbeId",
    "persistenceProbeId",
  ]) {
    assert.ok(safeText(readiness[field], 512), `recovery evidence must include ${field}`);
  }
  assert.equal(readiness.persistence.state, "verified");
  assert.match(readiness.persistence.observedRemoteCommit, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
  for (const format of rollback.formats) {
    assert.ok(/^[a-z][a-z0-9.-]{0,127}$/u.test(format.formatId));
    assert.ok(Number.isSafeInteger(format.version) && format.version > 0);
  }
  const priorReadable = new Map(
    declarations.previous.persistence.readable.map((format) => [
      format.formatId,
      new Set(format.versions),
    ]),
  );
  for (const format of declarations.target.persistence.writable) {
    assert.ok(
      priorReadable.get(format.formatId)?.has(format.version),
      `restored previous composition must read target writable format ${format.formatId}@${format.version}`,
    );
  }
  for (const format of rollback.formats) {
    assert.ok(
      priorReadable.get(format.formatId)?.has(format.version),
      `restored previous composition must read observed remote format ${format.formatId}@${format.version}`,
    );
  }
  for (const format of readiness.persistence.formats) {
    assert.ok(/^[a-z][a-z0-9.-]{0,127}$/u.test(format.formatId));
    assert.ok(Number.isSafeInteger(format.version) && format.version > 0);
  }
  const actualPodImageDigest = await readReadyPodImageDigest(
    inputs,
    target,
    recovered,
    providerApi,
  );
  assert.equal(
    readiness.actualImageDigest,
    actualPodImageDigest,
    "recovery evidence must match the live CRI digest for the restored Scriptorium image",
  );
  return recovered;
}

async function waitForStableCandidate(
  inputs,
  stableTarget,
  pinnedTarget,
  candidateId,
  pinnedBaseline,
) {
  const dashboard = await waitForDashboard(
    inputs,
    stableTarget,
    (latest) =>
      latest.snapshot.instance.observedState === "ready" &&
      latest.current?.selection.policy === "stable" &&
      latest.current.selection.releaseId === candidateId &&
      latest.snapshot.instance.currentArtifactDigest ===
        latest.snapshot.instance.desiredArtifactDigest &&
      latest.current.artifactDigest === latest.snapshot.instance.currentArtifactDigest &&
      latest.current.selection.requestedModules.length === 0,
    inputs.config.timeouts.promotionSeconds + inputs.config.timeouts.rolloutSeconds,
    "candidate was not promoted and fanned out to the stable follower before the owned deadline",
  );
  const stableRelease = dashboard.releases.find((release) => release.releaseId === candidateId);
  assert.ok(
    stableRelease,
    "candidate must be available in the actual product release list after promotion",
  );
  const pinned = expectDashboardTarget(
    inputs,
    pinnedTarget,
    await getDashboard(inputs, pinnedTarget),
    "pinned",
    inputs.config.release.previousReleaseId,
  );
  assert.equal(
    pinned.snapshot.instance.runtimeEpoch,
    pinnedBaseline.snapshot.instance.runtimeEpoch,
    "pinned follower must not receive the stable release rollout",
  );
  assert.equal(
    pinned.snapshot.instance.currentArtifactDigest,
    pinnedBaseline.snapshot.instance.currentArtifactDigest,
  );
  assert.equal(pinned.current?.revisionId, pinnedBaseline.current?.revisionId);
  assert.ok(
    equalStringSet(
      pinned.current?.selection.requestedModules ?? [],
      pinnedBaseline.current?.selection.requestedModules ?? [],
    ),
  );
  assertReadyCurrent(dashboard, inputs.config.targets.stable.baseline, candidateId);
  return dashboard;
}

async function verifyBaselineUi(page, inputs, target) {
  await visitRepository(page, inputs, target);
  const form = page.locator("form").filter({
    has: page.locator('input[name="action"][value="configure"]'),
  });
  assert.equal(
    await form.count(),
    1,
    "maintained repository must expose its current configuration",
  );
  const selection = {
    releasePolicy: await form.locator('select[name="releasePolicy"]').inputValue(),
    releaseId: await form.locator('select[name="releaseId"]').inputValue(),
    moduleIds: await form
      .locator('select[name="moduleIds"] option:checked')
      .evaluateAll((options) => options.map((option) => option.value).sort()),
    resourceProfileId: await form.locator('select[name="resourceProfileId"]').inputValue(),
  };
  assert.equal(selection.releasePolicy, target.baseline.releasePolicy);
  assert.equal(selection.releaseId, target.baseline.releaseId);
  assert.ok(equalStringSet(selection.moduleIds, target.baseline.moduleIds));
  assert.equal(selection.resourceProfileId, target.baseline.resourceProfileId);
}

async function performFailedBuildPreservation(page, inputs, target, dashboard, providerApi) {
  expectDashboardTarget(
    inputs,
    target,
    dashboard,
    "pinned",
    inputs.config.release.previousReleaseId,
  );
  assertNoActiveOperation(dashboard, "pinned target before expected build failure");
  assert.ok(
    equalStringSet(dashboard.current?.selection.requestedModules ?? [], target.baseline.moduleIds),
  );
  const beforeDigest = dashboard.snapshot.instance.currentArtifactDigest;
  const beforeEpoch = dashboard.snapshot.instance.runtimeEpoch;
  const beforeRevision = dashboard.current?.revisionId;
  const beforeRuntime = await readRuntimeObjects(inputs, target, dashboard, providerApi);
  await saveSelection(
    page,
    inputs,
    target,
    inputs.config.scenarios.failedBuild,
    "pinned",
    inputs.config.release.previousReleaseId,
  );
  const failed = await waitForBuildFailure(
    inputs,
    target,
    inputs.config.scenarios.failedBuild.expectedErrorCode,
    inputs.config.timeouts.buildSeconds,
  );
  assert.equal(failed.snapshot.instance.observedState, "ready");
  assert.equal(failed.snapshot.instance.desiredState, "running");
  assert.equal(failed.snapshot.instance.runtimeEpoch, beforeEpoch);
  assert.equal(failed.snapshot.instance.observedRuntimeEpoch, beforeEpoch);
  assert.equal(failed.snapshot.instance.currentArtifactDigest, beforeDigest);
  assert.equal(failed.current?.revisionId, beforeRevision);
  assert.equal(failed.current?.artifactDigest, beforeDigest);
  assert.equal(failed.desired?.status, "failed");
  assert.equal(failed.desired?.artifactDigest, null);
  assert.equal(failed.desired?.selection.policy, "pinned");
  assert.equal(failed.desired?.selection.releaseId, inputs.config.release.previousReleaseId);
  assert.ok(
    equalStringSet(
      failed.desired?.selection.requestedModules ?? [],
      inputs.config.scenarios.failedBuild.moduleIds,
    ),
  );
  const afterRuntime = await readRuntimeObjects(inputs, target, failed, providerApi);
  assert.equal(
    afterRuntime.deployment.metadata.uid,
    beforeRuntime.deployment.metadata.uid,
    "failed build must leave the exact currently serving pinned Deployment intact",
  );
  assert.equal(
    appContainer(afterRuntime.deployment)?.image,
    appContainer(beforeRuntime.deployment)?.image,
    "failed build must leave the current immutable image in place",
  );
  return failed;
}

async function admitCandidate(inputs, previousRelease) {
  assert.ok(
    compareReleaseVersions(inputs.manifest.version, previousRelease.version) > 0,
    "candidate release version must advance the currently serving stable release",
  );
  assert.match(
    inputs.manifest.catalog.runtimeBaseDigest,
    DIGEST,
    "candidate catalog must bind its immutable Runtime Base digest",
  );
  let response;
  try {
    response = await cpRequest(
      inputs,
      "POST",
      "/v1/operator/releases",
      inputs.config.controlPlane.releaseOperatorToken,
      inputs.manifest,
      "Authorization",
    );
  } catch {
    block("RUNTIME_UNAVAILABLE");
  }
  assert.equal(
    response.status,
    201,
    "real release admission must accept one new immutable candidate",
  );
  assert.equal(
    response.body?.duplicate,
    false,
    "candidate admission must not reuse an unrelated prior candidate",
  );
  assert.ok(isRecord(response.body?.release));
  assert.equal(response.body.release.version, inputs.manifest.version);
  assert.equal(response.body.release.imageDigest, inputs.manifest.catalog.runtimeBaseDigest);
  assert.equal(response.body.release.status, "candidate");
  assert.ok(safeText(response.body.release.id, 128));
  return response.body.release;
}

async function submitStop(inputs, userId, target, dashboard) {
  assertNoActiveOperation(dashboard, "stable target before stopped-origin wake scenario");
  assert.equal(dashboard.snapshot.instance.observedState, "ready");
  const body = {
    actorId: userId,
    expectedGeneration: dashboard.snapshot.instance.generation,
    desiredState: "stopped",
    idempotencyKey: `t14-stop-${randomBytes(16).toString("hex")}`,
    bindingEpoch: dashboard.snapshot.binding.bindingEpoch,
    authorizationRevision: dashboard.snapshot.binding.authorizationRevision,
  };
  let response;
  try {
    response = await cpRequest(
      inputs,
      "POST",
      `/v1/instances/${encodeURIComponent(target.instanceId)}/desired`,
      inputs.config.controlPlane.gatewayAuth,
      body,
    );
  } catch {
    block("RUNTIME_UNAVAILABLE");
  }
  assert.equal(
    response.status,
    200,
    "Gateway-authorized desired-state request must stop the owned instance",
  );
  assert.equal(response.body?.snapshot?.binding?.repositoryId, target.repositoryId);
  assert.equal(response.body?.snapshot?.binding?.instanceId, target.instanceId);
  assert.equal(response.body?.snapshot?.instance?.desiredState, "stopped");
  assert.ok(safeText(response.body?.operation?.id, 128));
  assert.equal(response.body.operation.instanceId, target.instanceId);
  assert.equal(response.body.operation.kind, "stop");
  return response.body.operation.id;
}

async function waitForStoppedAndVerifyWriters(inputs, target, operationId, expectedDigest, api) {
  const stopped = await waitForDashboard(
    inputs,
    target,
    (dashboard) =>
      dashboard.snapshot.instance.desiredState === "stopped" &&
      dashboard.snapshot.instance.observedState === "stopped" &&
      dashboard.snapshot.instance.currentArtifactDigest === expectedDigest &&
      operationById(dashboard, operationId)?.status === "succeeded",
    inputs.config.timeouts.wakeSeconds,
    "the real stop operation did not prove a stopped owned runtime before direct wake",
  );
  const namespaceName = runtimeNamespace(inputs, target.instanceId);
  const deployment = await api.get({
    kind: "Deployment",
    namespace: namespaceName,
    name: runtimeDeploymentName(target.instanceId),
  });
  assert.equal(runtimeLabels(deployment)[INSTANCE_LABEL], target.instanceId);
  assert.equal(runtimeLabels(deployment)[REPOSITORY_LABEL], String(target.repositoryId));
  assert.equal(runtimeLabels(deployment)[CLUSTER_LABEL], inputs.kubeConfig.cluster.id);
  assert.equal(deployment?.spec?.replicas, 0);
  const pods = await listCompleteNamespacePods(api, namespaceName);
  assert.equal(
    pods.items.length,
    0,
    "stopped instance must have no remaining Pod across any epoch or lifecycle phase",
  );
  const confirmedStopped = await getDashboard(inputs, target);
  assert.equal(confirmedStopped.snapshot.instance.desiredState, "stopped");
  assert.equal(confirmedStopped.snapshot.instance.observedState, "stopped");
  assert.equal(confirmedStopped.snapshot.instance.currentArtifactDigest, expectedDigest);
  assert.equal(operationById(confirmedStopped, operationId)?.status, "succeeded");
  return stopped;
}

async function wakeFromDirectOrigin(page, context, inputs, target, handoffs, wakeDeadline) {
  const hostname = exactOrigin(target.origin).hostname;
  await context.clearCookies({ domain: hostname });
  assert.equal(
    (await context.cookies()).some((cookie) => cookie.domain.replace(/^\./u, "") === hostname),
    false,
    "direct stopped-origin wake must begin without stale application cookies",
  );
  const firstHandoffCount = handoffs.length;
  ensureOwnerLifetime(inputs.inventory, inputs.config.timeouts.wakeSeconds);
  try {
    await page.goto(target.origin, { waitUntil: "domcontentloaded" });
  } catch {
    block("RUNTIME_UNAVAILABLE");
  }
  while (Date.now() < wakeDeadline) {
    const location = new URL(page.url());
    if (location.origin === target.origin && location.pathname === "/") {
      const heading = page.getByRole("heading", { name: target.applicationHeading, exact: true });
      if (await heading.count()) {
        await heading.waitFor({ state: "visible", timeout: 5_000 });
        break;
      }
    }
    if (
      location.origin === inputs.gatewayOrigin.origin &&
      location.pathname === `/entry/${encodeURIComponent(target.instanceId)}`
    ) {
      const body = await page
        .locator("body")
        .innerText()
        .catch(() => "");
      if (body.includes("Configuration required")) {
        assert.fail("selected instance lost its admitted configuration during stopped-origin wake");
      }
      if (
        body.includes("Repository instance is starting") &&
        Number(location.searchParams.get("poll") ?? "0") >= 5
      ) {
        const statusLink = page.getByRole("link", { name: "Check status", exact: true });
        if (await statusLink.count()) await statusLink.click();
      }
    } else if (isGithubHost(location.hostname)) {
      await delay(500);
    } else if (
      location.origin !== target.origin &&
      location.origin !== inputs.gatewayOrigin.origin
    ) {
      block("OWNED_ENVIRONMENT_UNAVAILABLE");
    }
    await delay(500);
  }
  assert.equal(new URL(page.url()).origin, target.origin);
  assert.equal(new URL(page.url()).pathname, "/");
  assert.equal(
    await page.getByRole("heading", { name: target.applicationHeading, exact: true }).count(),
    1,
    "direct-origin wake must return the authenticated user to the same Scriptorium application",
  );
  const emittedHandoffs = handoffs.slice(firstHandoffCount);
  assert.equal(
    emittedHandoffs.length,
    1,
    "direct-origin wake must use exactly one one-use handoff",
  );
  assert.equal(emittedHandoffs[0].validForm, true);
  assert.equal(
    emittedHandoffs[0].referer,
    "",
    "handoff codes must not be sent in a Referer header",
  );
}

test(
  "real Stable and Pinned rollout, failed-build preservation, same-digest redeploy, compatible rollback, and stopped-origin wake",
  { timeout: 14_400_000 },
  async () => {
    let inputs;
    try {
      inputs = await loadInputs();
    } catch (error) {
      const reasonCode =
        error instanceof GateBlocked && ALLOWED_BLOCK_REASONS.has(error.reasonCode)
          ? error.reasonCode
          : "OWNER_INPUT_MISSING";
      await writeRunnerResult("BLOCKED", reasonCode);
      throw new Error(`BLOCKED: ${reasonCode}`);
    }

    const { inventory, config, storageState, executable } = inputs;
    let browser;
    let context;
    let failureStage = "browser-launch";
    const gatewayRequests = [];
    const handoffs = [];
    try {
      try {
        browser = await chromium.launch({ executablePath: executable, headless: true });
      } catch {
        block("BROWSER_UNAVAILABLE");
      }
      context = await browser.newContext({ storageState, serviceWorkers: "block" });
      context.setDefaultTimeout(15_000);
      context.setDefaultNavigationTimeout(
        ensureOwnerLifetime(inventory, config.timeouts.loginSeconds),
      );
      const allowedOrigins = new Set([
        inputs.gatewayOrigin.origin,
        config.targets.stable.origin,
        config.targets.pinned.origin,
      ]);
      context.setDefaultNavigationTimeout(config.timeouts.totalSeconds * 1000);
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (Date.parse(inventory.environment.expiresAt) <= Date.now()) {
          await route.abort("aborted");
          return;
        }
        if (
          allowedOrigins.has(url.origin) ||
          (url.protocol === "https:" && isGithubHost(url.hostname))
        ) {
          await route.continue();
        } else {
          await route.abort("blockedbyclient");
        }
      });
      const page = await context.newPage();
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.origin === inputs.gatewayOrigin.origin) gatewayRequests.push(url.pathname);
        if (
          (url.origin === config.targets.stable.origin ||
            url.origin === config.targets.pinned.origin) &&
          url.pathname === "/_platform/handoff" &&
          request.method() === "POST"
        ) {
          const form = new URLSearchParams(request.postData() ?? "");
          handoffs.push({
            validForm:
              form.getAll("code").length === 1 &&
              form.getAll("code")[0]?.length > 0 &&
              form.getAll("returnPath").length === 1 &&
              form.getAll("returnPath")[0] === "/",
            referer: request.headers().referer ?? "",
          });
        }
      });

      failureStage = "product-health-and-github-oauth";
      let gatewayHealth;
      try {
        ensureOwnerLifetime(inventory, 10);
        gatewayHealth = await context.request.get(`${inputs.gatewayOrigin.origin}/healthz`, {
          maxRedirects: 0,
          timeout: 10_000,
        });
      } catch {
        block("RUNTIME_UNAVAILABLE");
      }
      assert.equal(gatewayHealth.status(), 200, "real Gateway health route must respond");
      context.setDefaultNavigationTimeout(
        ensureOwnerLifetime(inventory, config.timeouts.loginSeconds),
      );
      const userId = await loginThroughGithub(page, context, inputs, gatewayRequests);

      failureStage = "release-and-instance-inventory";
      const releases = await getReleaseList(inputs);
      const previousRelease = releases.find(
        (release) => release.releaseId === config.release.previousReleaseId,
      );
      assert.ok(
        previousRelease,
        "currently configured release must be available in the actual Control Plane catalog",
      );
      assert.ok(
        !releases.some((release) => release.version === inputs.manifest.version),
        "candidate version must not already be admitted into this owned product environment",
      );
      assert.ok(
        compareReleaseVersions(inputs.manifest.version, previousRelease.version) > 0,
        "candidate version must be newer than the current stable and pinned release",
      );
      for (const selection of [
        config.targets.stable.baseline,
        config.targets.pinned.baseline,
        config.scenarios.failedBuild,
      ]) {
        assert.ok(
          validateSelectionAgainstCatalog(selection, previousRelease.catalog),
          "baseline and failure scenario must use legal modules and profiles from the serving release catalog",
        );
      }
      for (const selection of [config.scenarios.configurationChange, config.scenarios.rollback]) {
        assert.ok(
          validateSelectionAgainstCatalog(selection, inputs.manifest.catalog),
          "non-preset configuration must use legal modules and profiles from the candidate catalog",
        );
      }

      const [stableBaseline, pinnedBaseline] = await Promise.all([
        getDashboard(inputs, config.targets.stable),
        getDashboard(inputs, config.targets.pinned),
      ]);
      expectDashboardTarget(
        inputs,
        config.targets.stable,
        stableBaseline,
        "stable",
        config.release.previousReleaseId,
      );
      expectDashboardTarget(
        inputs,
        config.targets.pinned,
        pinnedBaseline,
        "pinned",
        config.release.previousReleaseId,
      );
      assert.equal(stableBaseline.current?.status, "admitted");
      assert.equal(pinnedBaseline.current?.status, "admitted");
      assert.ok(
        equalStringSet(
          stableBaseline.current?.selection.requestedModules ?? [],
          config.targets.stable.baseline.moduleIds,
        ),
      );
      assert.ok(
        equalStringSet(
          pinnedBaseline.current?.selection.requestedModules ?? [],
          config.targets.pinned.baseline.moduleIds,
        ),
      );
      assertNoActiveOperation(stableBaseline, "stable baseline target");
      assertNoActiveOperation(pinnedBaseline, "pinned baseline target");

      failureStage = "owned-kubernetes-runtime-preflight";
      const kubernetes = await prepareKubernetes(inputs);
      const [stableRuntimeBefore, pinnedRuntimeBefore] = await Promise.all([
        readRuntimeObjects(inputs, config.targets.stable, stableBaseline, kubernetes.providerApi),
        readRuntimeObjects(inputs, config.targets.pinned, pinnedBaseline, kubernetes.providerApi),
      ]);
      const stableNamespaceUid = objectMetadata(stableRuntimeBefore.namespace).uid;
      const pinnedNamespaceUid = objectMetadata(pinnedRuntimeBefore.namespace).uid;
      assert.ok(
        stableNamespaceUid && pinnedNamespaceUid && stableNamespaceUid !== pinnedNamespaceUid,
      );

      failureStage = "real-github-app-repository-selection";
      await verifyBaselineUi(page, inputs, config.targets.stable);
      await verifyBaselineUi(page, inputs, config.targets.pinned);

      failureStage = "real-pinned-failed-build-preservation";
      const failedPinned = await performFailedBuildPreservation(
        page,
        inputs,
        config.targets.pinned,
        pinnedBaseline,
        kubernetes.providerApi,
      );
      assert.equal(
        failedPinned.snapshot.instance.currentArtifactDigest,
        pinnedBaseline.snapshot.instance.currentArtifactDigest,
      );
      assert.equal(
        failedPinned.snapshot.instance.runtimeEpoch,
        pinnedBaseline.snapshot.instance.runtimeEpoch,
      );

      failureStage = "operator-release-admission";
      const admitted = await admitCandidate(inputs, previousRelease);

      failureStage = "actual-scheduled-stable-promotion-and-fanout";
      const stableCore = await waitForStableCandidate(
        inputs,
        config.targets.stable,
        config.targets.pinned,
        admitted.id,
        pinnedBaseline,
      );
      assert.notEqual(
        stableCore.snapshot.instance.currentArtifactDigest,
        stableBaseline.snapshot.instance.currentArtifactDigest,
        "candidate Runtime Base and Core composition must produce a new immutable Platform artifact",
      );
      assert.equal(
        stableCore.current?.resolvedModules.length,
        0,
        "stable follower must run the Core composition",
      );
      const stableCoreRuntime = await readRuntimeObjects(
        inputs,
        config.targets.stable,
        stableCore,
        kubernetes.providerApi,
      );
      assert.equal(objectMetadata(stableCoreRuntime.namespace).uid, stableNamespaceUid);
      const pinnedAfterPromotion = expectDashboardTarget(
        inputs,
        config.targets.pinned,
        await getDashboard(inputs, config.targets.pinned),
        "pinned",
        config.release.previousReleaseId,
      );
      assert.equal(
        pinnedAfterPromotion.snapshot.instance.runtimeEpoch,
        pinnedBaseline.snapshot.instance.runtimeEpoch,
      );
      assert.equal(
        pinnedAfterPromotion.snapshot.instance.currentArtifactDigest,
        pinnedBaseline.snapshot.instance.currentArtifactDigest,
      );
      const pinnedRuntimeAfterPromotion = await readRuntimeObjects(
        inputs,
        config.targets.pinned,
        pinnedAfterPromotion,
        kubernetes.providerApi,
      );
      assert.equal(
        pinnedRuntimeAfterPromotion.deployment.metadata.uid,
        pinnedRuntimeBefore.deployment.metadata.uid,
      );
      assert.equal(objectMetadata(pinnedRuntimeAfterPromotion.namespace).uid, pinnedNamespaceUid);

      failureStage = "real-ui-nonpreset-composition-change";
      assertNoActiveOperation(stableCore, "stable Core runtime before add-on composition change");
      await saveSelection(
        page,
        inputs,
        config.targets.stable,
        config.scenarios.configurationChange,
        "stable",
        admitted.id,
      );
      const configured = await waitForConfiguredRuntime(
        inputs,
        config.targets.stable,
        { ...config.scenarios.configurationChange, releasePolicy: "stable" },
        admitted.id,
        stableCore.snapshot.instance.currentArtifactDigest,
        config.timeouts.buildSeconds + config.timeouts.rolloutSeconds,
      );
      assert.equal(
        configured.snapshot.instance.observedRuntimeEpoch,
        configured.snapshot.instance.runtimeEpoch,
      );
      const configuredRuntime = await readRuntimeObjects(
        inputs,
        config.targets.stable,
        configured,
        kubernetes.providerApi,
      );
      assert.equal(objectMetadata(configuredRuntime.namespace).uid, stableNamespaceUid);
      assert.equal(
        new URL(page.url()).origin,
        config.targets.stable.origin,
        "configuration change must keep the stable instance's original Origin",
      );

      failureStage = "same-digest-redeployment";
      assertNoActiveOperation(
        configured,
        "stable non-preset composition before same-digest redeployment",
      );
      await redeployThroughUi(page, inputs, config.targets.stable);
      const redeployed = await waitForSameDigestRedeploy(
        inputs,
        config.targets.stable,
        configured,
        config.timeouts.rolloutSeconds,
      );
      const redeployedRuntime = await readRuntimeObjects(
        inputs,
        config.targets.stable,
        redeployed,
        kubernetes.providerApi,
      );
      assert.equal(
        appContainer(redeployedRuntime.deployment)?.image,
        appContainer(configuredRuntime.deployment)?.image,
      );
      assert.equal(objectMetadata(redeployedRuntime.namespace).uid, stableNamespaceUid);

      failureStage = "bounded-real-compatible-rollback";
      const rolledBack = await performCompatibleRollback(
        page,
        inputs,
        config.targets.stable,
        admitted.id,
        redeployed,
        kubernetes.providerApi,
        kubernetes.controllerTransport,
        stableNamespaceUid,
      );
      assert.ok(
        rolledBack.snapshot.instance.runtimeEpoch > redeployed.snapshot.instance.runtimeEpoch,
      );
      const rolledBackRuntime = await readRuntimeObjects(
        inputs,
        config.targets.stable,
        rolledBack,
        kubernetes.providerApi,
      );
      assert.equal(objectMetadata(rolledBackRuntime.namespace).uid, stableNamespaceUid);
      assert.equal(
        appContainer(rolledBackRuntime.deployment)?.image,
        appContainer(configuredRuntime.deployment)?.image,
      );
      assert.notEqual(
        rolledBack.snapshot.instance.currentArtifactDigest,
        redeployed.snapshot.instance.currentArtifactDigest,
        "rollback must restore the prior admitted artifact after the different target image failed readiness",
      );
      assert.equal(rolledBack.current?.selection.releaseId, admitted.id);
      assert.ok(
        equalStringSet(
          rolledBack.current?.selection.requestedModules ?? [],
          config.scenarios.configurationChange.moduleIds,
        ),
      );

      failureStage = "direct-origin-stop-and-wake";
      const wakeDigest = rolledBack.snapshot.instance.currentArtifactDigest;
      const stopOperationId = await submitStop(inputs, userId, config.targets.stable, rolledBack);
      const stopped = await waitForStoppedAndVerifyWriters(
        inputs,
        config.targets.stable,
        stopOperationId,
        wakeDigest,
        kubernetes.providerApi,
      );
      context.setDefaultNavigationTimeout(
        ensureOwnerLifetime(inventory, config.timeouts.wakeSeconds),
      );
      const wakeDeadline = Date.now() + config.timeouts.wakeSeconds * 1000;
      await wakeFromDirectOrigin(
        page,
        context,
        inputs,
        config.targets.stable,
        handoffs,
        wakeDeadline,
      );
      const awakened = await waitForDashboard(
        inputs,
        config.targets.stable,
        (latest) =>
          latest.snapshot.instance.desiredState === "running" &&
          latest.snapshot.instance.observedState === "ready" &&
          latest.snapshot.instance.currentArtifactDigest === wakeDigest &&
          latest.snapshot.instance.observedRuntimeEpoch === latest.snapshot.instance.runtimeEpoch,
        config.timeouts.wakeSeconds,
        "direct-origin access did not complete the stopped-instance wake",
      );
      assert.equal(awakened.current?.selection.releaseId, admitted.id);
      assert.ok(
        equalStringSet(
          awakened.current?.selection.requestedModules ?? [],
          config.scenarios.configurationChange.moduleIds,
        ),
      );
      const awakenedRuntime = await readRuntimeObjects(
        inputs,
        config.targets.stable,
        awakened,
        kubernetes.providerApi,
      );
      assert.equal(objectMetadata(awakenedRuntime.namespace).uid, stableNamespaceUid);
      assert.equal(
        appContainer(awakenedRuntime.deployment)?.image,
        appContainer(rolledBackRuntime.deployment)?.image,
      );
      assert.equal(new URL(page.url()).origin, config.targets.stable.origin);
      assert.equal(stopped.snapshot.instance.currentArtifactDigest, wakeDigest);
    } catch (error) {
      const reasonCode =
        error instanceof GateBlocked && ALLOWED_BLOCK_REASONS.has(error.reasonCode)
          ? error.reasonCode
          : "ACCEPTANCE_ASSERTION_FAILED";
      await writeRunnerResult(
        reasonCode === "ACCEPTANCE_ASSERTION_FAILED" ? "FAILED" : "BLOCKED",
        reasonCode,
      );
      if (error instanceof GateBlocked) {
        throw new Error(`BLOCKED: ${reasonCode} during ${failureStage}`);
      }
      error.message = `${failureStage}: ${error.message}`;
      throw error;
    } finally {
      await context?.close().catch(() => {});
      await browser?.close().catch(() => {});
    }
  },
);
