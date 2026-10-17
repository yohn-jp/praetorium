import assert from "node:assert/strict";
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { createSign, randomUUID } from "node:crypto";
import { createSecureContext } from "node:tls";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "@playwright/test";
import { RuntimeAssignmentSchema } from "../../packages/contracts/dist/index.js";
import {
  CLUSTER_LABEL_KEY,
  GENERATION_LABEL_KEY,
  INSTANCE_LABEL_KEY,
  MANAGED_BY_LABEL_KEY,
  MANAGED_BY_LABEL_VALUE,
  PLATFORM_LABEL_KEY,
  PLATFORM_LABEL_VALUE,
  REPOSITORY_LABEL_KEY,
  RUNTIME_EPOCH_LABEL_KEY,
  createInClusterKubernetesApi,
  runtimeNamespaceName,
  runtimeResourceName,
} from "../../plugins/kubernetes/dist/index.js";
import { validateInventory } from "../../scripts/verify-integration.mjs";

const CATEGORY = "producer-recovery";
const INVENTORY_ENV = "PRAETORIUM_T14_INVENTORY_PATH";
const CATEGORY_ENV = "PRAETORIUM_T14_CATEGORY";
const RESULT_ENV = "PRAETORIUM_T14_RESULT_PATH";
const RESULT_FILENAME = "runner-result.json";
const MAX_OWNER_FILE_BYTES = 64 * 1024;
const MAX_HTTP_BYTES = 2 * 1024 * 1024;
const HTTP_TIMEOUT_MS = 15_000;
const ID_PATTERN = /^ins_[0-9A-HJKMNP-TV-Z]{26}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const BLOCKED_CODES = new Set([
  "OWNER_INPUT_MISSING",
  "OWNED_ENVIRONMENT_UNAVAILABLE",
  "PRODUCER_CONTRACT_MISSING",
  "RUNTIME_UNAVAILABLE",
  "BROWSER_UNAVAILABLE",
  "INSUFFICIENT_LIFETIME",
]);

const FIXTURE_FILES = Object.freeze({
  "plot/volumes/vol-1/volume.yaml": "id: vol-1\ntitle: Volume One\n",
  "plot/volumes/vol-1/chapters/ch-1/chapter.yaml": "id: ch-1\nvolume: vol-1\ntitle: Chapter One\n",
  "plot/volumes/vol-1/chapters/ch-1/scenes/scene-1.yaml":
    "id: scene-1\ntitle: Scene One\nvolume: vol-1\nchapter: ch-1\nmanuscript: manuscript/vol-1/ch-1/scene-1.md\n",
  "manuscript/vol-1/ch-1/scene-1.md": "# Scene One\n\nThe first line of the story.\n",
  "plot/volumes/vol-1/chapters/ch-1/scenes/scene-2.yaml":
    "id: scene-2\ntitle: Scene Two\nvolume: vol-1\nchapter: ch-1\nmanuscript: manuscript/vol-1/ch-1/scene-2.md\n",
  "manuscript/vol-1/ch-1/scene-2.md": "# Scene Two\n\nThe second line of the story.\n",
});
const SCENE_ONE = "manuscript/vol-1/ch-1/scene-1.md";
const SCENE_TWO = "manuscript/vol-1/ch-1/scene-2.md";
const OPERATION_PATH = /^meta\/scriptorium\/operations\/v1\/[A-Za-z0-9_-]{1,128}\.json$/u;
const PUBLICATION_PATH = /^meta\/scriptorium\/publications\/v1\/[A-Za-z0-9_-]{1,128}\.json$/u;
const PROPOSAL_PATH =
  /^meta\/scriptorium\/proposals\/(?:v1\/[A-Za-z0-9_-]{1,128}\.json|v2\/(?:bindings|complete)\/[A-Za-z0-9_-]{1,128}\.json)$/u;

class BlockedError extends Error {
  constructor(reasonCode) {
    super(reasonCode);
    this.name = "BlockedError";
    this.reasonCode = reasonCode;
  }
}

function block(reasonCode) {
  throw new BlockedError(reasonCode);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return (
    isRecord(value) && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0")
  );
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

function parseHttpsOrigin(value) {
  if (!safeText(value)) return null;
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

function parseSessionCookie(value) {
  if (typeof value !== "string" || value.length > 4096 || /[\r\n]/u.test(value)) return null;
  const entries = value.split(";").map((part) => part.trim());
  const pairs = new Map();
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator < 1) return null;
    const key = entry.slice(0, separator);
    if (pairs.has(key)) return null;
    pairs.set(key, entry.slice(separator + 1));
  }
  const session = pairs.get("__Host-praetorium_session");
  const csrf = pairs.get("__Host-praetorium_csrf");
  return session && csrf ? { session, csrf } : null;
}

function validGithubRepository(value) {
  return (
    exactKeys(value, ["id", "owner", "name"]) &&
    Number.isSafeInteger(value.id) &&
    value.id > 0 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(value.owner ?? "") &&
    /^[A-Za-z0-9_.-]{1,100}$/u.test(value.name ?? "")
  );
}

function validGatewayUser(value) {
  const cookie = typeof value?.sessionCookie === "string" ? value.sessionCookie : "";
  return (
    exactKeys(value, ["expectedUserId", "sessionCookie", "csrfToken", "accessToken"]) &&
    /^[1-9][0-9]{0,15}$/u.test(value.expectedUserId ?? "") &&
    cookie.length <= 4096 &&
    !/[\r\n]/u.test(cookie) &&
    parseSessionCookie(cookie) !== null &&
    /^[A-Za-z0-9_-]{16,512}$/u.test(value.csrfToken ?? "") &&
    cookie.includes(`__Host-praetorium_csrf=${value.csrfToken}`) &&
    typeof value.accessToken === "string" &&
    value.accessToken.length >= 20 &&
    value.accessToken.length <= 4096 &&
    !/[\r\n ]/u.test(value.accessToken)
  );
}

async function readOwnedBytes(filePath, { privateFile, maximumBytes }) {
  if (
    typeof process.getuid !== "function" ||
    !safeAbsolutePath(filePath) ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    !Number.isInteger(fsConstants.O_NOFOLLOW) ||
    !Number.isInteger(fsConstants.O_NONBLOCK)
  ) {
    throw new BlockedError("OWNER_INPUT_MISSING");
  }

  let handle;
  try {
    handle = await open(
      filePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
    const before = await handle.stat();
    const uid = process.getuid();
    if (
      !before.isFile() ||
      before.uid !== uid ||
      before.nlink !== 1 ||
      (privateFile ? (before.mode & 0o077) !== 0 : (before.mode & 0o022) !== 0) ||
      before.size > maximumBytes
    ) {
      throw new BlockedError("OWNER_INPUT_MISSING");
    }
    const chunks = [];
    let size = 0;
    while (true) {
      const buffer = Buffer.allocUnsafe(Math.min(8192, maximumBytes - size + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > maximumBytes) throw new BlockedError("OWNER_INPUT_MISSING");
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
      after.uid !== uid ||
      after.nlink !== 1 ||
      (privateFile ? (after.mode & 0o077) !== 0 : (after.mode & 0o022) !== 0)
    ) {
      throw new BlockedError("OWNER_INPUT_MISSING");
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    if (error instanceof BlockedError) throw error;
    throw new BlockedError("OWNER_INPUT_MISSING");
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readOwnedJson(filePath, { privateFile, maximumBytes = MAX_OWNER_FILE_BYTES }) {
  const bytes = await readOwnedBytes(filePath, { privateFile, maximumBytes });
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    if (!isRecord(value)) throw new Error("invalid owner json");
    return value;
  } catch {
    throw new BlockedError("OWNER_INPUT_MISSING");
  }
}

function validateInventoryOwnerFiles(inventory, inventoryPath) {
  const validation = validateInventory(inventory);
  if (validation.errors.length > 0) block("OWNER_INPUT_MISSING");
  const resource = inventory.resources?.[CATEGORY];
  if (
    resource?.state !== "available" ||
    resource.owner !== inventory.owner.identity ||
    resource.disposable !== true ||
    resource.production !== false ||
    !safeAbsolutePath(resource.reference)
  ) {
    block("OWNED_ENVIRONMENT_UNAVAILABLE");
  }
  return { reference: resource.reference, inventoryPath: path.resolve(inventoryPath) };
}

function requiredOwnerLifetimeSeconds(timeouts) {
  return timeouts.wakeSeconds + 3 * timeouts.redeploySeconds + 14 * timeouts.remoteSeconds + 300;
}

function validateBoundConfig(config, inventory) {
  if (
    !exactKeys(config, ["schemaVersion", "inventory", "inputReferences", "timeouts"]) ||
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
    config.inventory.expiresAt !== inventory.environment.expiresAt ||
    !exactKeys(config.inputReferences, ["browserEntry", "githubAccess", "kubernetesIsolation"]) ||
    config.inputReferences.browserEntry !== inventory.resources["browser-entry"].reference ||
    config.inputReferences.githubAccess !== inventory.resources["github-access"].reference ||
    config.inputReferences.kubernetesIsolation !==
      inventory.resources["kubernetes-isolation"].reference ||
    !exactKeys(config.timeouts, ["wakeSeconds", "redeploySeconds", "remoteSeconds"])
  ) {
    block("OWNER_INPUT_MISSING");
  }
  for (const seconds of Object.values(config.timeouts)) {
    if (!Number.isSafeInteger(seconds) || seconds < 15 || seconds > 1800) {
      block("OWNER_INPUT_MISSING");
    }
  }
  const requiredSeconds = requiredOwnerLifetimeSeconds(config.timeouts);
  if (
    requiredSeconds > 3600 ||
    Date.parse(inventory.environment.expiresAt) - Date.now() < requiredSeconds * 1000
  ) {
    block("INSUFFICIENT_LIFETIME");
  }
}

function validateGithubConfigs(primary, inventory, inventoryPath) {
  if (
    !exactKeys(primary, [
      "schemaVersion",
      "inventoryPath",
      "ownerIdentity",
      "environment",
      "gateway",
      "controlPlane",
      "github",
    ]) ||
    primary.schemaVersion !== 1 ||
    primary.inventoryPath !== inventoryPath ||
    primary.ownerIdentity !== inventory.owner.identity ||
    !exactKeys(primary.environment, [
      "name",
      "expiresAt",
      "cleanupProcedure",
      "privateDisposable",
      "production",
      "resourceReference",
    ]) ||
    primary.environment.privateDisposable !== true ||
    primary.environment.production !== false ||
    primary.environment.resourceReference !== inventory.resources["github-access"].reference ||
    Date.parse(primary.environment.expiresAt) <= Date.now() ||
    !exactKeys(primary.gateway, ["origin", "writer", "reader"]) ||
    !parseHttpsOrigin(primary.gateway.origin) ||
    !validGatewayUser(primary.gateway.writer) ||
    !validGatewayUser(primary.gateway.reader) ||
    primary.gateway.writer.expectedUserId === primary.gateway.reader.expectedUserId ||
    !exactKeys(primary.controlPlane, ["origin", "gatewayAuth"]) ||
    !parseHttpsOrigin(primary.controlPlane.origin) ||
    typeof primary.controlPlane.gatewayAuth !== "string" ||
    !/^[\x21-\x7e]{32,4096}$/u.test(primary.controlPlane.gatewayAuth) ||
    !exactKeys(primary.github, [
      "appId",
      "installationId",
      "privateKeyPem",
      "repository",
      "unrelatedRepository",
    ]) ||
    !Number.isSafeInteger(primary.github.appId) ||
    primary.github.appId < 1 ||
    !Number.isSafeInteger(primary.github.installationId) ||
    primary.github.installationId < 1 ||
    typeof primary.github.privateKeyPem !== "string" ||
    primary.github.privateKeyPem.length < 100 ||
    primary.github.privateKeyPem.length > 16_384 ||
    !/^-----BEGIN (RSA )?PRIVATE KEY-----[\s\S]+-----END \1PRIVATE KEY-----$/u.test(
      primary.github.privateKeyPem.trim(),
    ) ||
    !validGithubRepository(primary.github.repository) ||
    !validGithubRepository(primary.github.unrelatedRepository) ||
    primary.github.repository.id === primary.github.unrelatedRepository.id
  ) {
    block("OWNER_INPUT_MISSING");
  }
}

function validateBrowserConfig(config, inventory) {
  if (
    !exactKeys(config, [
      "schemaVersion",
      "inventory",
      "gateway",
      "repository",
      "instance",
      "browser",
      "producer",
      "writeProbe",
      "selection",
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
    config.inventory.expiresAt !== inventory.environment.expiresAt ||
    !exactKeys(config.gateway, ["origin", "expectedUserId"]) ||
    !parseHttpsOrigin(config.gateway.origin) ||
    !safeText(config.gateway.expectedUserId, 128) ||
    !exactKeys(config.repository, ["id", "fullName"]) ||
    !Number.isSafeInteger(config.repository.id) ||
    config.repository.id < 1 ||
    !/^[A-Za-z0-9_.-]{1,255}\/[A-Za-z0-9_.-]{1,255}$/u.test(config.repository.fullName) ||
    !exactKeys(config.instance, ["id", "origin", "applicationHeading"]) ||
    !ID_PATTERN.test(config.instance.id ?? "") ||
    !parseHttpsOrigin(config.instance.origin) ||
    !safeText(config.instance.applicationHeading, 256) ||
    !exactKeys(config.browser, ["executablePath", "githubStorageStatePath"]) ||
    !safeAbsolutePath(config.browser.executablePath) ||
    !safeAbsolutePath(config.browser.githubStorageStatePath) ||
    !exactKeys(config.producer, ["revision", "tree", "artifactDigest"]) ||
    !REVISION_PATTERN.test(config.producer.revision ?? "") ||
    !REVISION_PATTERN.test(config.producer.tree ?? "") ||
    !DIGEST_PATTERN.test(config.producer.artifactDigest ?? "") ||
    !exactKeys(config.selection, [
      "releasePolicy",
      "releaseId",
      "moduleIds",
      "resourceProfileId",
    ]) ||
    !["stable", "pinned"].includes(config.selection.releasePolicy) ||
    !safeText(config.selection.releaseId, 128) ||
    !Array.isArray(config.selection.moduleIds) ||
    config.selection.moduleIds.some((id) => !/^[a-z][a-z0-9-]{0,63}$/u.test(id)) ||
    new Set(config.selection.moduleIds).size !== config.selection.moduleIds.length ||
    !safeText(config.selection.resourceProfileId, 128)
  ) {
    block("OWNER_INPUT_MISSING");
  }
  const gatewayOrigin = parseHttpsOrigin(config.gateway.origin);
  const instanceOrigin = parseHttpsOrigin(config.instance.origin);
  const expectedPrefix = `ins-${config.instance.id.slice(4).toLowerCase()}.`;
  if (
    !gatewayOrigin ||
    !instanceOrigin ||
    gatewayOrigin.origin === instanceOrigin.origin ||
    !instanceOrigin.hostname.startsWith(expectedPrefix) ||
    instanceOrigin.hostname.split(".").length < 3
  ) {
    block("OWNER_INPUT_MISSING");
  }
  const required = ["S01", "S02", "S03", "S04", "S05"];
  const producerStatusPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../docs/migration/PRODUCER-STATUS.json",
  );
  return { gatewayOrigin, instanceOrigin, producerStatusPath, required };
}

async function validateKubernetesConfig(config, inventory) {
  if (
    !exactKeys(config, [
      "schemaVersion",
      "inventory",
      "cluster",
      "credentials",
      "metadataFixture",
      "probe",
      "network",
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
    config.inventory.expiresAt !== inventory.environment.expiresAt ||
    !exactKeys(config.cluster, [
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
    !/^clu_[0-9A-HJKMNP-TV-Z]{26}$/u.test(config.cluster.id ?? "") ||
    config.cluster.provider !== "kind" ||
    !/^praetorium-t14-[a-z0-9-]{1,23}[a-z0-9]$/u.test(config.cluster.name ?? "") ||
    config.cluster.context !== `kind-${config.cluster.name}` ||
    config.cluster.confirmation !== config.cluster.name ||
    !["127.0.0.1", "::1"].includes(config.cluster.apiHost) ||
    !Number.isSafeInteger(config.cluster.apiPort) ||
    config.cluster.apiPort < 1 ||
    config.cluster.apiPort > 65_535 ||
    config.cluster.namespacePrefix !== "praetorium-instances" ||
    !exactKeys(config.credentials, [
      "directory",
      "controllerIdentity",
      "controllerTokenPath",
      "providerTokenPath",
      "caPath",
    ]) ||
    !safeAbsolutePath(config.credentials.directory) ||
    !safeAbsolutePath(config.credentials.controllerTokenPath) ||
    !safeAbsolutePath(config.credentials.providerTokenPath) ||
    !safeAbsolutePath(config.credentials.caPath)
  ) {
    block("OWNER_INPUT_MISSING");
  }
  const { realpath, stat } = await import("node:fs/promises");
  const credentialRoot = await realpath(config.credentials.directory).catch(() => null);
  const rootInfo = credentialRoot ? await stat(credentialRoot).catch(() => null) : null;
  if (
    !credentialRoot ||
    credentialRoot !== path.resolve(config.credentials.directory) ||
    !rootInfo?.isDirectory() ||
    rootInfo.uid !== process.getuid?.() ||
    (rootInfo.mode & 0o077) !== 0
  )
    block("OWNER_INPUT_MISSING");
  for (const filePath of [
    config.credentials.controllerTokenPath,
    config.credentials.providerTokenPath,
    config.credentials.caPath,
  ]) {
    const resolved = await realpath(filePath).catch(() => null);
    const info = resolved ? await stat(resolved).catch(() => null) : null;
    if (
      !resolved ||
      path.dirname(resolved) !== credentialRoot ||
      !info?.isFile() ||
      info.uid !== process.getuid?.() ||
      info.nlink !== 1 ||
      (filePath === config.credentials.caPath
        ? (info.mode & 0o022) !== 0
        : (info.mode & 0o077) !== 0)
    ) {
      block("OWNER_INPUT_MISSING");
    }
  }
  const controllerToken = (
    await readOwnedBytes(config.credentials.controllerTokenPath, {
      privateFile: true,
      maximumBytes: 8192,
    })
  )
    .toString("utf8")
    .trim();
  const ca = await readOwnedBytes(config.credentials.caPath, {
    privateFile: false,
    maximumBytes: 128 * 1024,
  });
  if (
    controllerToken.length < 20 ||
    controllerToken.length > 8192 ||
    /[\r\n]/u.test(controllerToken)
  )
    block("OWNER_INPUT_MISSING");
  try {
    createSecureContext({ ca });
  } catch {
    block("OWNER_INPUT_MISSING");
  }
  return config;
}

async function loadInputs() {
  if (process.env[CATEGORY_ENV] !== CATEGORY || !safeAbsolutePath(process.env[INVENTORY_ENV])) {
    block("OWNER_INPUT_MISSING");
  }
  const inventoryPath = path.resolve(process.env[INVENTORY_ENV]);
  const inventory = await readOwnedJson(inventoryPath, { privateFile: false });
  const { reference: configPath } = validateInventoryOwnerFiles(inventory, inventoryPath);
  const config = await readOwnedJson(configPath, { privateFile: true });
  validateBoundConfig(config, inventory);
  for (const id of ["browser-entry", "github-access", "kubernetes-isolation"]) {
    const resource = inventory.resources[id];
    if (
      resource.state !== "available" ||
      resource.owner !== inventory.owner.identity ||
      resource.disposable !== true ||
      resource.production !== false
    ) {
      block("OWNED_ENVIRONMENT_UNAVAILABLE");
    }
  }
  const browserConfig = await readOwnedJson(inventory.resources["browser-entry"].reference, {
    privateFile: true,
  });
  const githubConfigPath = `${inventoryPath}.github-access.json`;
  const githubConfig = await readOwnedJson(githubConfigPath, { privateFile: true });
  const kubernetesConfig = await readOwnedJson(
    inventory.resources["kubernetes-isolation"].reference,
    { privateFile: true },
  );
  const derived = validateBrowserConfig(browserConfig, inventory);
  validateGithubConfigs(githubConfig, inventory, inventoryPath);
  await validateKubernetesConfig(kubernetesConfig, inventory);
  if (
    config.inputReferences.browserEntry !== inventory.resources["browser-entry"].reference ||
    config.inputReferences.githubAccess !== inventory.resources["github-access"].reference ||
    config.inputReferences.kubernetesIsolation !==
      inventory.resources["kubernetes-isolation"].reference ||
    browserConfig.gateway.origin !== githubConfig.gateway.origin ||
    browserConfig.gateway.expectedUserId !== githubConfig.gateway.writer.expectedUserId ||
    browserConfig.repository.id !== githubConfig.github.repository.id ||
    browserConfig.repository.fullName.toLowerCase() !==
      `${githubConfig.github.repository.owner}/${githubConfig.github.repository.name}`.toLowerCase()
  ) {
    block("OWNED_ENVIRONMENT_UNAVAILABLE");
  }
  const producerStatus = await readOwnedJson(derived.producerStatusPath, { privateFile: false });
  const capabilities = new Map(
    Array.isArray(producerStatus.capabilities)
      ? producerStatus.capabilities.filter(isRecord).map((item) => [item.id, item])
      : [],
  );
  if (
    derived.required.some((id) => capabilities.get(id)?.status !== "available") ||
    producerStatus.producerRevision !== browserConfig.producer.revision ||
    producerStatus.producerTree !== browserConfig.producer.tree ||
    producerStatus.artifactDigest !== browserConfig.producer.artifactDigest ||
    !DIGEST_PATTERN.test(producerStatus.artifactDigest ?? "")
  ) {
    block("PRODUCER_CONTRACT_MISSING");
  }
  const chromiumPath = await import("node:fs/promises").then(({ realpath, stat }) =>
    realpath(browserConfig.browser.executablePath)
      .then(async (real) => ({ real, info: await stat(real).catch(() => null) }))
      .catch(() => null),
  );
  if (!chromiumPath?.info?.isFile()) block("BROWSER_UNAVAILABLE");
  const { access } = await import("node:fs/promises");
  try {
    await access(chromiumPath.real, fsConstants.X_OK);
  } catch {
    block("BROWSER_UNAVAILABLE");
  }
  const expiresAt = Math.min(
    Date.parse(inventory.environment.expiresAt),
    Date.parse(githubConfig.environment.expiresAt),
  );
  if (expiresAt - Date.now() < requiredOwnerLifetimeSeconds(config.timeouts) * 1000) {
    block("INSUFFICIENT_LIFETIME");
  }
  return {
    inventory,
    inventoryPath,
    config,
    browserConfig,
    githubConfig,
    kubernetesConfig,
    derived,
    chromiumPath: chromiumPath.real,
    expiresAt,
  };
}

async function writeRunnerResult(status, reasonCode) {
  if (!BLOCKED_CODES.has(reasonCode) && reasonCode !== "ACCEPTANCE_ASSERTION_FAILED") return;
  const reportPath = process.env[RESULT_ENV];
  const resultHome = process.env.HOME;
  if (!safeAbsolutePath(reportPath) || !safeAbsolutePath(resultHome)) return;
  const { realpath, writeFile } = await import("node:fs/promises");
  const resolvedHome = await realpath(resultHome).catch(() => null);
  const resolvedParent = await realpath(path.dirname(reportPath)).catch(() => null);
  if (
    !resolvedHome ||
    resolvedParent !== resolvedHome ||
    path.basename(reportPath) !== RESULT_FILENAME
  )
    return;
  await writeFile(
    path.join(resolvedHome, RESULT_FILENAME),
    `${JSON.stringify({ reportVersion: 1, category: CATEGORY, status, reasonCode })}\n`,
    { flag: "wx", mode: 0o600 },
  ).catch(() => {});
}

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

async function githubInstallationToken(inputs) {
  const { appId, installationId, privateKeyPem } = inputs.githubConfig.github;
  const issuedAt = Math.floor(Date.now() / 1000) - 30;
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({ iat: issuedAt, exp: issuedAt + 540, iss: String(appId) }),
  );
  const signingInput = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const jwt = `${signingInput}.${signer.sign(privateKeyPem, "base64url")}`;
  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({ repository_ids: [inputs.browserConfig.repository.id] }),
      redirect: "error",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    },
  ).catch(() => null);
  if (!response) block("RUNTIME_UNAVAILABLE");
  const body = await response.json().catch(() => null);
  if (
    response.status === 401 ||
    response.status === 403 ||
    response.status === 404 ||
    response.status === 422
  )
    block("OWNED_ENVIRONMENT_UNAVAILABLE");
  assert.equal(
    response.status,
    201,
    "the configured GitHub App must mint a repository-limited installation token",
  );
  assert.ok(
    isRecord(body) &&
      typeof body.token === "string" &&
      body.token.length >= 20 &&
      body.token.length <= 4096,
  );
  assert.ok(typeof body.expires_at === "string" && Date.parse(body.expires_at) > Date.now());
  assert.ok(
    Array.isArray(body.repositories) &&
      body.repositories.length === 1 &&
      body.repositories[0]?.id === inputs.browserConfig.repository.id,
    "GitHub App token must be scoped to the one assigned repository",
  );
  return { token: body.token, expiresAt: Date.parse(body.expires_at) };
}

function createGitHubClient(token, repository) {
  const base = `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
  async function request(method, suffix, body, allowMissing = false) {
    const response = await fetch(`${base}${suffix}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    }).catch(() => null);
    if (!response) block("RUNTIME_UNAVAILABLE");
    if (allowMissing && response.status === 404) return { status: 404, value: null };
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > MAX_HTTP_BYTES) assert.fail("GitHub returned an oversized response");
    let value;
    try {
      value = bytes.byteLength ? JSON.parse(bytes.toString("utf8")) : null;
    } catch {
      assert.fail(`GitHub ${method} returned invalid JSON (${response.status})`);
    }
    if (
      response.status === 401 ||
      response.status === 403 ||
      response.status === 404 ||
      response.status === 422
    )
      block("OWNED_ENVIRONMENT_UNAVAILABLE");
    assert.ok(response.ok, `GitHub ${method} request failed with ${response.status}`);
    return { status: response.status, value };
  }
  return {
    async metadata() {
      return (await request("GET", "", undefined)).value;
    },
    async head(branch) {
      return (await request("GET", `/branches/${encodeURIComponent(branch)}`, undefined)).value
        .commit.sha;
    },
    async tree(commit) {
      return (
        await request("GET", `/git/trees/${encodeURIComponent(commit)}?recursive=1`, undefined)
      ).value;
    },
    async content(filePath, branch) {
      const encoded = filePath.split("/").map(encodeURIComponent).join("/");
      const { status, value } = await request(
        "GET",
        `/contents/${encoded}?ref=${encodeURIComponent(branch)}`,
        undefined,
        true,
      );
      if (status === 404) return null;
      if (
        !isRecord(value) ||
        value.type !== "file" ||
        typeof value.content !== "string" ||
        typeof value.sha !== "string"
      )
        return null;
      return {
        sha: value.sha,
        content: Buffer.from(value.content.replace(/\s/gu, ""), "base64").toString("utf8"),
      };
    },
    async updateContent(filePath, branch, content, message) {
      const previous = await this.content(filePath, branch);
      assert.ok(previous, `dedicated recovery fixture is missing ${filePath}`);
      const encoded = filePath.split("/").map(encodeURIComponent).join("/");
      const { value } = await request("PUT", `/contents/${encoded}`, {
        message,
        content: Buffer.from(content, "utf8").toString("base64"),
        sha: previous.sha,
        branch,
      });
      assert.ok(isRecord(value) && typeof value.commit?.sha === "string");
      return value.commit.sha;
    },
  };
}

function operationPath(operationId) {
  assert.match(operationId, /^[A-Za-z0-9_-]{1,128}$/u);
  return `meta/scriptorium/operations/v1/${operationId}.json`;
}

async function validateSyntheticRepository(github, expectedRepository) {
  const metadata = await github.metadata();
  assert.equal(
    metadata.id,
    expectedRepository.id,
    "GitHub installation token must reach the assigned numeric repository",
  );
  assert.equal(
    metadata.private,
    true,
    "producer recovery requires the dedicated private synthetic repository",
  );
  assert.equal(metadata.full_name?.toLowerCase(), expectedRepository.fullName.toLowerCase());
  assert.ok(typeof metadata.default_branch === "string" && metadata.default_branch.length > 0);
  assert.notEqual(
    metadata.name.toLowerCase(),
    "scriptorium-epic7-acceptance-20261017-db517d",
    "completed Epic #7 fixture must remain untouched",
  );
  const branch = metadata.default_branch;
  const tree = await github.tree(await github.head(branch));
  assert.equal(tree.truncated, false, "dedicated repository tree must be complete");
  const blobs = Array.isArray(tree.tree)
    ? tree.tree
        .filter((entry) => entry.type === "blob")
        .map((entry) => entry.path)
        .sort()
    : [];
  for (const filePath of blobs) {
    assert.ok(
      Object.hasOwn(FIXTURE_FILES, filePath) ||
        OPERATION_PATH.test(filePath) ||
        PUBLICATION_PATH.test(filePath) ||
        PROPOSAL_PATH.test(filePath),
      `refusing to mutate a repository with non-fixture content at ${filePath}`,
    );
  }
  for (const [filePath, expected] of Object.entries(FIXTURE_FILES)) {
    assert.ok(blobs.includes(filePath), `dedicated repository is missing fixture file ${filePath}`);
    const actual = await github.content(filePath, branch);
    assert.ok(actual, `dedicated repository is missing fixture content ${filePath}`);
    if (filePath === SCENE_ONE || filePath === SCENE_TWO) {
      assert.ok(
        actual.content.startsWith(expected),
        `dedicated repository scene baseline changed at ${filePath}`,
      );
    } else {
      assert.equal(actual.content, expected, `dedicated repository fixture changed at ${filePath}`);
    }
  }
  return { branch, initialHead: await github.head(branch) };
}

async function browserJournal(page) {
  return page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = globalThis.indexedDB.open("scriptorium-recovery", 3);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error("author journal could not be opened"));
    });
    try {
      const transaction = database.transaction("operations", "readonly");
      return await new Promise((resolve, reject) => {
        let records;
        transaction.oncomplete = () =>
          resolve(
            records.map((entry) => ({
              key: entry.key,
              documentPath: entry.documentPath,
              state: entry.state,
              operationId: entry.operation?.id,
              generation: entry.operation?.generation,
              text: entry.text,
              operationContent:
                entry.operation?.writes?.find((write) => write.path === entry.documentPath)
                  ?.content ?? null,
              repositoryId: entry.repository?.repositoryId,
              defaultBranch: entry.repository?.defaultBranch,
              checkpoint: entry.checkpoint
                ? {
                    operationId: entry.checkpoint.operationId,
                    generation: entry.checkpoint.generation,
                    localCommit: entry.checkpoint.localCommit,
                    remoteBase: entry.checkpoint.remoteBase,
                  }
                : null,
            })),
          );
        transaction.onerror = () =>
          reject(transaction.error ?? new Error("author journal transaction failed"));
        transaction.onabort = () =>
          reject(transaction.error ?? new Error("author journal transaction aborted"));
        const request = transaction.objectStore("operations").getAll();
        request.onsuccess = () => {
          records = request.result;
        };
        request.onerror = () => reject(request.error ?? new Error("author journal read failed"));
      });
    } finally {
      database.close();
    }
  });
}

async function publicationReceipts(page) {
  return page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = globalThis.indexedDB.open("scriptorium-recovery", 3);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error("publication journal could not be opened"));
    });
    try {
      const transaction = database.transaction("publicationReceipts", "readonly");
      return await new Promise((resolve, reject) => {
        let records;
        transaction.oncomplete = () =>
          resolve(
            records.map((record) => ({
              state: record.receipt?.state,
              acknowledged:
                record.receipt?.acknowledged?.map((item) => ({
                  operationId: item.operationId,
                  generation: item.generation,
                })) ?? [],
            })),
          );
        transaction.onerror = () =>
          reject(transaction.error ?? new Error("publication receipt read failed"));
        transaction.onabort = () =>
          reject(transaction.error ?? new Error("publication receipt transaction aborted"));
        const request = transaction.objectStore("publicationReceipts").getAll();
        request.onsuccess = () => {
          records = request.result;
        };
        request.onerror = () =>
          reject(request.error ?? new Error("publication receipt read failed"));
      });
    } finally {
      database.close();
    }
  });
}

async function remoteObservation(page, projectId) {
  return page.evaluate(async (id) => {
    const response = await fetch(`/api/projects/${encodeURIComponent(id)}/observation`, {
      cache: "no-store",
    });
    if (!response.ok) throw new Error("Scriptorium remote observation failed");
    const body = await response.json();
    return body.snapshot?.remoteCommit ?? null;
  }, projectId);
}

async function listCompleteNamespacePods(kubernetesApi, namespace) {
  const items = [];
  const cursors = new Set();
  let cursor;
  let resourceVersion;
  for (let pageNumber = 0; pageNumber < 1000; pageNumber += 1) {
    let page;
    try {
      page = await kubernetesApi.list("Pod", namespace, "", cursor);
    } catch {
      block("RUNTIME_UNAVAILABLE");
    }
    assert.ok(isRecord(page) && Array.isArray(page.items));
    assert.ok(
      typeof page.resourceVersion === "string" && page.resourceVersion.length > 0,
      "Kubernetes Pod census must carry a resource version",
    );
    if (resourceVersion === undefined) resourceVersion = page.resourceVersion;
    else {
      assert.equal(
        page.resourceVersion,
        resourceVersion,
        "all pages of the Kubernetes Pod census must share one resource version",
      );
    }
    items.push(...page.items);
    assert.ok(items.length <= 10_000, "Kubernetes Pod census exceeded its safety bound");
    if (page.nextCursor === null) return { items, resourceVersion };
    assert.ok(typeof page.nextCursor === "string" && page.nextCursor.length > 0);
    assert.ok(!cursors.has(page.nextCursor), "Kubernetes Pod census pagination must advance");
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  assert.fail("Kubernetes Pod census exceeded its page bound");
}

async function waitFor(description, read, accept, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (accept(value)) return value;
    } catch (error) {
      if (error instanceof BlockedError) throw error;
      lastError = error;
    }
    await delay(750);
  }
  if (lastError)
    assert.fail(`Timed out waiting for ${description}: ${String(lastError.message).slice(0, 240)}`);
  assert.fail(`Timed out waiting for ${description}`);
}

function findJournalEntry(records, filePath, expectedText) {
  return records.find((entry) => entry.documentPath === filePath && entry.text === expectedText);
}

function safeKubeObject(value, message) {
  assert.ok(isRecord(value), message);
  return value;
}

function assertLabels(labels, assignment, clusterId) {
  assert.ok(isRecord(labels));
  assert.equal(labels[PLATFORM_LABEL_KEY], PLATFORM_LABEL_VALUE);
  assert.equal(labels[MANAGED_BY_LABEL_KEY], MANAGED_BY_LABEL_VALUE);
  assert.equal(labels[INSTANCE_LABEL_KEY], assignment.instanceId);
  assert.equal(labels[REPOSITORY_LABEL_KEY], String(assignment.repositoryId));
  assert.equal(labels[RUNTIME_EPOCH_LABEL_KEY], String(assignment.runtimeEpoch));
  assert.equal(labels[CLUSTER_LABEL_KEY], clusterId);
}

async function observeRuntime(inputs, kubernetesApi) {
  const assignmentConfig = inputs.kubernetesConfig;
  const namespace = runtimeNamespaceName(
    assignmentConfig.cluster.namespacePrefix,
    inputs.browserConfig.instance.id,
  );
  const deploymentName = runtimeResourceName(inputs.browserConfig.instance.id);
  let deployment;
  try {
    deployment = safeKubeObject(
      await kubernetesApi.get({ kind: "Deployment", namespace, name: deploymentName }),
      "managed Scriptorium Deployment is unavailable",
    );
  } catch {
    block("RUNTIME_UNAVAILABLE");
  }
  const deploymentMetadata = safeKubeObject(
    deployment.metadata,
    "managed Deployment metadata is unavailable",
  );
  const deploymentLabels = isRecord(deploymentMetadata.labels) ? deploymentMetadata.labels : {};
  assert.equal(deploymentMetadata.name, deploymentName);
  assert.equal(deploymentMetadata.namespace, namespace);
  assert.equal(deploymentMetadata.uid && typeof deploymentMetadata.uid === "string", true);
  const spec = safeKubeObject(deployment.spec, "managed Deployment spec is unavailable");
  const template = safeKubeObject(spec.template, "managed Deployment pod template is unavailable");
  const templateMetadata = safeKubeObject(
    template.metadata,
    "managed Deployment template metadata is unavailable",
  );
  const templateLabels = isRecord(templateMetadata.labels) ? templateMetadata.labels : {};
  const podSpec = safeKubeObject(template.spec, "managed Deployment pod spec is unavailable");
  const deploymentStatus = safeKubeObject(
    deployment.status,
    "managed Deployment status is unavailable",
  );
  const generationLabel = deploymentLabels[GENERATION_LABEL_KEY];
  assert.match(
    typeof generationLabel === "string" ? generationLabel : "",
    /^[1-9][0-9]*$/u,
    "Deployment must carry its current logical generation",
  );
  assert.equal(templateLabels[GENERATION_LABEL_KEY], generationLabel);
  assert.equal(spec.replicas, 1, "the serving Deployment must request exactly one writer Pod");
  assert.ok(
    Number.isSafeInteger(deploymentStatus.observedGeneration) &&
      deploymentStatus.observedGeneration >= deploymentMetadata.generation &&
      deploymentStatus.updatedReplicas === 1 &&
      deploymentStatus.readyReplicas === 1,
    "Deployment status must report one updated and ready replica at its current generation",
  );
  const containers = Array.isArray(podSpec.containers) ? podSpec.containers : [];
  const container = containers.find((item) => isRecord(item) && item.name === "scriptorium");
  assert.ok(
    isRecord(container),
    "Deployment must contain the real Scriptorium application container",
  );
  const environment = Array.isArray(container.env) ? container.env : [];
  const environmentValue = (name) =>
    environment.find((item) => isRecord(item) && item.name === name)?.value;
  assert.equal(
    environmentValue("SCRIPTORIUM_HOSTED_MODE"),
    "1",
    "Scriptorium must start in Hosted mode",
  );
  assert.ok(
    environmentValue("SCRIPTORIUM_RUNTIME_ASSIGNMENT_PATH") === undefined ||
      environmentValue("SCRIPTORIUM_RUNTIME_ASSIGNMENT_PATH") ===
        "/run/scriptorium/runtime-assignment.json",
    "Hosted assignment path must follow the shared producer contract",
  );
  const mount = (Array.isArray(container.volumeMounts) ? container.volumeMounts : []).find(
    (item) => isRecord(item) && item.mountPath === "/run/scriptorium",
  );
  assert.ok(
    isRecord(mount) && mount.readOnly === true,
    "runtime identity and assignment must be projected read-only",
  );
  const volumes = Array.isArray(podSpec.volumes) ? podSpec.volumes : [];
  const volume = volumes.find((item) => isRecord(item) && item.name === mount.name);
  const secretName = volume?.secret?.secretName;
  assert.ok(
    typeof secretName === "string" && secretName.length > 0,
    "assignment mount must resolve from the Deployment's Secret volume",
  );
  let secret;
  try {
    secret = safeKubeObject(
      await kubernetesApi.get({ kind: "Secret", namespace, name: secretName }),
      "runtime assignment Secret is unavailable",
    );
  } catch {
    block("RUNTIME_UNAVAILABLE");
  }
  const items = Array.isArray(volume.secret.items) ? volume.secret.items : [];
  const assignmentItem = items.find(
    (item) => isRecord(item) && item.path === "runtime-assignment.json",
  );
  const assignmentKey = assignmentItem?.key ?? "runtime-assignment.json";
  const encodedAssignment = secret.data?.[assignmentKey];
  assert.ok(
    typeof encodedAssignment === "string" && encodedAssignment.length <= 128 * 1024,
    "projected runtime assignment is missing",
  );
  const identityItem = items.find((item) => isRecord(item) && item.path === "runtime-identity.jwt");
  const identityKey = identityItem?.key ?? "runtime-identity.jwt";
  assert.ok(
    typeof secret.data?.[identityKey] === "string" && secret.data[identityKey].length <= 32 * 1024,
    "renewable runtime identity proof must be mounted beside the assignment",
  );
  let assignment;
  try {
    assignment = RuntimeAssignmentSchema.parse(
      JSON.parse(Buffer.from(encodedAssignment, "base64").toString("utf8")),
    );
  } catch {
    assert.fail("projected RuntimeAssignment does not satisfy the shared contract");
  }
  assertLabels(deploymentLabels, assignment, assignmentConfig.cluster.id);
  assertLabels(templateLabels, assignment, assignmentConfig.cluster.id);
  assert.equal(assignment.instanceId, inputs.browserConfig.instance.id);
  assert.equal(assignment.repositoryId, inputs.browserConfig.repository.id);
  assert.equal(assignment.imageDigest, inputs.browserConfig.producer.artifactDigest);
  assert.deepEqual(
    [...assignment.enabledModuleIds].sort(),
    [...inputs.browserConfig.selection.moduleIds].sort(),
    "RuntimeAssignment modules must equal the selected Hosted composition",
  );
  assert.ok(DIGEST_PATTERN.test(assignment.compositionManifestDigest));
  assert.equal(
    container.image?.endsWith(`@${assignment.imageDigest}`),
    true,
    "Deployment image must be immutable and match its admitted assignment digest",
  );
  const deploymentSelector = spec.selector?.matchLabels;
  assert.ok(
    isRecord(deploymentSelector) && Object.keys(deploymentSelector).length > 0,
    "Deployment must use a label selector",
  );
  const podList = await listCompleteNamespacePods(kubernetesApi, namespace);
  assert.equal(
    podList.items.length,
    1,
    "the complete instance namespace census must contain exactly one writer Pod across all epochs",
  );
  const pod = safeKubeObject(
    podList.items[0],
    "the complete instance namespace census contains an invalid Pod object",
  );
  assert.ok(isRecord(pod.metadata) && typeof pod.metadata.uid === "string");
  assert.equal(
    pod.metadata.deletionTimestamp === undefined || pod.metadata.deletionTimestamp === null,
    true,
    "the current writer Pod must not be terminating",
  );
  const podStatus = safeKubeObject(pod.status, "current writer Pod status is unavailable");
  assert.equal(podStatus.phase, "Running", "the current writer Pod must be Running");
  assert.ok(
    Array.isArray(podStatus.conditions) &&
      podStatus.conditions.some(
        (condition) =>
          isRecord(condition) && condition.type === "Ready" && condition.status === "True",
      ),
    "the current writer Pod must report Ready",
  );
  assertLabels(pod.metadata.labels, assignment, assignmentConfig.cluster.id);
  assert.equal(
    pod.metadata.labels[GENERATION_LABEL_KEY],
    generationLabel,
    "the only Pod in the full census must carry the current Deployment generation",
  );
  assert.ok(
    Object.entries(deploymentSelector).every(([key, value]) => pod.metadata.labels[key] === value),
    "the current writer Pod must match the admitted Deployment selector",
  );
  const ownedByDeployment =
    Array.isArray(pod.metadata.ownerReferences) &&
    pod.metadata.ownerReferences.some((owner) => isRecord(owner) && owner.kind === "ReplicaSet");
  assert.equal(
    ownedByDeployment,
    true,
    "serving Pod must be owned by a ReplicaSet from the assigned Deployment",
  );
  const containerStatuses = Array.isArray(podStatus.containerStatuses)
    ? podStatus.containerStatuses
    : [];
  const appStatus = containerStatuses.find((item) => isRecord(item) && item.name === "scriptorium");
  assert.ok(
    isRecord(appStatus) &&
      appStatus.ready === true &&
      typeof appStatus.imageID === "string" &&
      appStatus.imageID.length > 0,
    "CRI must report the ready Scriptorium container image identity",
  );
  return {
    namespace,
    deploymentName,
    deploymentUid: deploymentMetadata.uid,
    podUid: pod.metadata.uid,
    image: container.image,
    imageId: appStatus.imageID,
    generation: Number(generationLabel),
    assignment,
  };
}

async function sessionCookies(context, gatewayOrigin, writer) {
  const values = parseSessionCookie(writer.sessionCookie);
  assert.ok(values);
  await context.addCookies([
    {
      name: "__Host-praetorium_session",
      value: values.session,
      url: gatewayOrigin.origin,
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    },
    {
      name: "__Host-praetorium_csrf",
      value: values.csrf,
      url: gatewayOrigin.origin,
      path: "/",
      secure: true,
      httpOnly: false,
      sameSite: "Lax",
    },
  ]);
}

async function verifyHostedAccessCookies(context, instanceOrigin) {
  const cookies = await context.cookies(instanceOrigin.origin);
  const host = instanceOrigin.hostname;
  const one = (name) => {
    const matches = cookies.filter((cookie) => cookie.name === name);
    assert.equal(matches.length, 1, `Hosted instance must set one ${name} cookie`);
    assert.equal(matches[0].domain, host, `${name} must be host-only`);
    assert.equal(matches[0].secure, true, `${name} must be Secure`);
    assert.equal(matches[0].sameSite, "Lax", `${name} must use SameSite=Lax`);
    return matches[0];
  };
  const access = one("__Host-praetorium_access");
  const refresh = one("__Secure-praetorium_refresh");
  const csrf = one("__Host-praetorium_csrf");
  assert.equal(access.path, "/");
  assert.equal(access.httpOnly, true);
  assert.equal(refresh.path, "/_platform");
  assert.equal(refresh.httpOnly, true);
  assert.equal(csrf.path, "/");
  assert.equal(csrf.httpOnly, false);
}

function dashboardCurrent(page) {
  return page.getByRole("heading", { name: "Current deployment", exact: true }).locator("xpath=..");
}

async function readDashboard(page, inputs) {
  const response = await page
    .goto(
      `${inputs.derived.gatewayOrigin.origin}/repositories/${inputs.browserConfig.repository.id}`,
      { waitUntil: "domcontentloaded" },
    )
    .catch(() => null);
  if (!response || response.status() === 503) block("RUNTIME_UNAVAILABLE");
  assert.equal(response?.status(), 200, "real Gateway repository dashboard must load");
  await page
    .getByRole("heading", { name: inputs.browserConfig.repository.fullName, exact: true })
    .waitFor();
  const currentText = await dashboardCurrent(page).innerText();
  const mainText = await page.locator("main").innerText();
  const operations = await page
    .locator('section[aria-labelledby="operations"] article')
    .evaluateAll((articles) =>
      articles.map((article) => {
        const heading = article.querySelector("h3")?.innerText ?? "";
        const [kind, state] = heading.split(/:\s*/u, 2);
        return {
          kind: kind?.trim().toLowerCase() ?? "",
          state: state?.trim() ?? "",
          operationId: article.querySelector("code")?.innerText?.trim() ?? "",
        };
      }),
    );
  const state = /Instance:\s*(Ready|Starting|Stopped|Failed|Blocked|Status unavailable)/u.exec(
    mainText,
  )?.[1];
  assert.ok(state, "Gateway dashboard must report actual instance lifecycle state");
  return {
    state,
    text: mainText,
    operations,
    currentDigest: /Composed image:\s*(sha256:[0-9a-f]{64})/u.exec(currentText)?.[1] ?? null,
  };
}

async function waitForApplication(page, inputs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const location = new URL(page.url());
    if (location.origin === inputs.derived.instanceOrigin.origin && location.pathname === "/") {
      const heading = page.getByRole("heading", {
        name: inputs.browserConfig.instance.applicationHeading,
        exact: true,
      });
      if (await heading.count()) {
        await heading.waitFor({ state: "visible", timeout: 5_000 });
        return;
      }
    }
    const entryPath = `/entry/${encodeURIComponent(inputs.browserConfig.instance.id)}`;
    if (
      location.origin === inputs.derived.gatewayOrigin.origin &&
      location.pathname === entryPath
    ) {
      const body = await page
        .locator("body")
        .innerText()
        .catch(() => "");
      const poll = Number(location.searchParams.get("poll") ?? "0");
      if (body.includes("Repository instance is starting") && poll >= 5) {
        const statusLink = page.getByRole("link", { name: "Check status", exact: true });
        if (await statusLink.count()) await statusLink.click();
      }
    }
    await delay(500);
  }
  assert.fail("real Scriptorium instance did not become available at its assigned stable origin");
}

async function enterApplication(page, inputs, expectedBranch) {
  const dashboard = await readDashboard(page, inputs);
  const enter = page.getByRole("button", { name: "Enter application", exact: true });
  await enter.waitFor({ state: "visible", timeout: 15_000 });
  await enter.click();
  await waitForApplication(page, inputs, inputs.config.timeouts.wakeSeconds * 1000);
  assert.equal(
    new URL(page.url()).origin,
    inputs.derived.instanceOrigin.origin,
    "product entry must use the assigned stable origin",
  );
  const session = await page.evaluate(async () => {
    const response = await fetch("/api/session", { cache: "no-store" });
    return { status: response.status, body: await response.json().catch(() => null) };
  });
  assert.equal(session.status, 200, "one-use Gateway handoff must create the author session");
  await verifyHostedAccessCookies(page.context(), inputs.derived.instanceOrigin);
  const projects = await page.evaluate(async () => {
    const response = await fetch("/api/projects", { cache: "no-store" });
    return { status: response.status, body: await response.json().catch(() => null) };
  });
  assert.equal(
    projects.status,
    200,
    "Hosted Scriptorium must expose its assigned repository to the author",
  );
  assert.ok(Array.isArray(projects.body));
  assert.equal(projects.body.length, 1, "Hosted runtime must expose exactly its assigned project");
  const project = projects.body[0];
  let projectUrl;
  try {
    projectUrl = new URL(project.url);
  } catch {
    projectUrl = null;
  }
  assert.ok(
    project &&
      typeof project.id === "string" &&
      project.branch === expectedBranch &&
      projectUrl?.protocol === "https:" &&
      projectUrl.hostname.toLowerCase() === "github.com" &&
      projectUrl.pathname
        .replace(/\.git$/u, "")
        .replace(/\/$/u, "")
        .toLowerCase() ===
        `/${inputs.githubConfig.github.repository.owner}/${inputs.githubConfig.github.repository.name}`.toLowerCase(),
    "Scriptorium project must bind the assigned numeric repository ID",
  );
  const observation = await page.evaluate(async (projectId) => {
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/observation`, {
      cache: "no-store",
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }, project.id);
  assert.equal(
    observation.status,
    200,
    "the assigned repository remote observation must be available",
  );
  assert.equal(
    observation.body?.snapshot?.repository?.repositoryId,
    inputs.browserConfig.repository.id,
  );
  return { projectId: project.id, dashboard };
}

async function openScene(page, name, heading) {
  await page.getByRole("button", { name, exact: true }).click();
  await page.getByRole("heading", { name: heading, exact: true }).waitFor({ state: "visible" });
  await page.locator(".cm-content").waitFor({ state: "visible" });
}

async function editorText(page) {
  return page.locator(".cm-content").evaluate((element) => element.innerText ?? "");
}

async function triggerRedeploy(page, inputs, disposition) {
  const actionPath = `/repositories/${inputs.browserConfig.repository.id}/actions`;
  const before = await readDashboard(page, inputs);
  const previousOperationIds = new Set(before.operations.map((operation) => operation.operationId));
  const button = page.getByRole("button", { name: "Redeploy current configuration", exact: true });
  await button.waitFor({ state: "visible" });
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().startsWith(`${inputs.derived.gatewayOrigin.origin}${actionPath}`) &&
      response.request().method() === "POST",
  );
  await button.click();
  const response = await responsePromise;
  assert.ok(
    response.status() === 200 || response.status() === 202,
    "Gateway must accept the real redeploy operation",
  );
  const deadline = Date.now() + inputs.config.timeouts.redeploySeconds * 1000;
  let snapshot;
  while (Date.now() < deadline) {
    snapshot = await readDashboard(page, inputs);
    const expectedState = disposition === "blocked" ? "Blocked" : "Complete";
    const operation = snapshot.operations.find(
      (item) =>
        item.kind === "redeploy" &&
        item.state === expectedState &&
        !previousOperationIds.has(item.operationId),
    );
    if (disposition === "blocked" && operation)
      return { ...snapshot, operationId: operation.operationId };
    if (disposition === "complete" && operation && snapshot.state === "Ready")
      return { ...snapshot, operationId: operation.operationId };
    if (/redeploy:\s*Failed/iu.test(snapshot.text))
      assert.fail("real lifecycle redeploy operation failed");
    await delay(1_000);
  }
  assert.fail(`real lifecycle redeploy did not reach ${disposition}`);
}

function containerImageDigest(imageId) {
  if (typeof imageId !== "string") return null;
  return /(?:^|[@:])sha256:[a-f0-9]{64}$/u.exec(imageId)?.[0]?.replace(/^[@:]/u, "") ?? null;
}

async function assertAdmittedRuntimeImage(inputs, runtime, operationId) {
  const evidenceUrl = new URL(
    `/v1/operations/${encodeURIComponent(operationId)}/evidence`,
    inputs.githubConfig.controlPlane.origin,
  );
  let response;
  try {
    response = await fetch(evidenceUrl, {
      headers: { "X-Control-Plane-Gateway-Auth": inputs.githubConfig.controlPlane.gatewayAuth },
      redirect: "error",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch {
    block("RUNTIME_UNAVAILABLE");
  }
  if (response.status === 401 || response.status === 403) block("OWNED_ENVIRONMENT_UNAVAILABLE");
  if (!response.ok) block("RUNTIME_UNAVAILABLE");
  const body = await response.json().catch(() => null);
  assert.ok(isRecord(body) && isRecord(body.operation));
  assert.equal(body.operation.id, operationId);
  assert.equal(body.operation.instanceId, runtime.assignment.instanceId);
  assert.equal(body.operation.generation, runtime.generation);
  assert.equal(body.operation.runtimeEpoch, runtime.assignment.runtimeEpoch);
  assert.equal(body.operation.status, "succeeded");
  const evidence = body.readinessEvidence;
  assert.ok(
    isRecord(evidence),
    "completed deployment must expose schema-validated readiness evidence",
  );
  assert.ok(isRecord(evidence.assignment) && isRecord(evidence.assignment.deployment));
  const assignment = evidence.assignment;
  const deployment = assignment.deployment;
  assert.equal(assignment.instanceId, runtime.assignment.instanceId);
  assert.equal(assignment.repositoryId, runtime.assignment.repositoryId);
  assert.equal(assignment.runtimeEpoch, runtime.assignment.runtimeEpoch);
  assert.equal(assignment.generation, runtime.generation);
  assert.equal(deployment.imageDigest, runtime.assignment.imageDigest);
  assert.equal(deployment.compositionManifestDigest, runtime.assignment.compositionManifestDigest);
  assert.deepEqual(
    [...evidence.enabledModuleIds].sort(),
    [...runtime.assignment.enabledModuleIds].sort(),
  );
  assert.equal(
    evidence.actualImageDigest,
    deployment.platformManifestDigest,
    "Control Plane readiness evidence must bind the observed image to the admitted platform manifest",
  );
  assert.equal(
    containerImageDigest(runtime.imageId),
    deployment.platformManifestDigest,
    "the current CRI image identity must equal the admitted platform manifest digest",
  );
  return deployment.platformManifestDigest;
}

async function latestSceneText(github, branch, filePath) {
  const file = await github.content(filePath, branch);
  assert.ok(file);
  return file.content;
}

async function publishCurrentEditor(page, github, branch, filePath, expectedText, timeoutMs) {
  await page.getByRole("button", { name: "Save to GitHub", exact: true }).click();
  const entry = await waitFor(
    "Scriptorium durable publication receipt",
    () => publicationReceipts(page),
    (receipts) =>
      receipts.some(
        (receipt) =>
          receipt.state === "confirmed" &&
          receipt.acknowledged.some(
            (item) =>
              item.operationId === page.__praetoriumPendingOperationId &&
              item.generation === page.__praetoriumPendingGeneration,
          ),
      ),
    timeoutMs,
  );
  assert.ok(entry);
  const newHead = await waitFor(
    "GitHub default-branch publication",
    () => github.head(branch),
    (head) => head !== page.__praetoriumPriorHead,
    timeoutMs,
  );
  assert.ok(
    (await latestSceneText(github, branch, filePath)).includes(expectedText),
    "GitHub saved the actual manuscript write",
  );
  return newHead;
}

async function publishExistingCheckpoint(
  page,
  github,
  branch,
  filePath,
  expectedText,
  entry,
  timeoutMs,
) {
  const priorHead = await github.head(branch);
  setPendingOperation(page, entry, priorHead);
  return publishCurrentEditor(page, github, branch, filePath, expectedText, timeoutMs);
}

function setPendingOperation(page, entry, priorHead) {
  page.__praetoriumPendingOperationId = entry.operationId;
  page.__praetoriumPendingGeneration = entry.generation;
  page.__praetoriumPriorHead = priorHead;
}

async function proveCheckpointAndPublish(page, github, branch, filePath, expectedText, timeoutMs) {
  const priorHead = await github.head(branch);
  await page.getByRole("button", { name: "Checkpoint", exact: true }).click();
  const checkpointed = await waitFor(
    "author IndexedDB journal checkpoint",
    () => browserJournal(page),
    (records) =>
      records.some(
        (entry) =>
          entry.documentPath === filePath &&
          entry.text === expectedText &&
          entry.state === "checkpointed" &&
          entry.checkpoint?.localCommit,
      ),
    timeoutMs,
  );
  const entry = findJournalEntry(checkpointed, filePath, expectedText);
  assert.ok(entry && entry.operationId && entry.generation);
  assert.equal(
    await github.head(branch),
    priorHead,
    "Checkpoint must remain local until explicit GitHub save",
  );
  setPendingOperation(page, entry, priorHead);
  return publishCurrentEditor(page, github, branch, filePath, expectedText, timeoutMs);
}

function makeKubernetesApi(config) {
  return createInClusterKubernetesApi({
    env: {
      KUBERNETES_SERVICE_HOST: config.cluster.apiHost,
      KUBERNETES_SERVICE_PORT_HTTPS: String(config.cluster.apiPort),
      KUBERNETES_SERVICE_PORT: String(config.cluster.apiPort),
    },
    tokenPath: config.credentials.controllerTokenPath,
    caPath: config.credentials.caPath,
    requestTimeoutMs: HTTP_TIMEOUT_MS,
  });
}

async function readInitialJournalState(page, filePath, expectedText, timeoutMs) {
  return waitFor(
    "author draft in the real browser IndexedDB recovery journal",
    () => browserJournal(page),
    (records) =>
      records.some(
        (entry) =>
          entry.documentPath === filePath &&
          entry.text === expectedText &&
          entry.state === "draft" &&
          entry.operationContent === expectedText,
      ),
    timeoutMs,
  );
}

test(
  "real Hosted Scriptorium preserves author journal, blocks unsafe quiesce, recreates same origin, and merges remote conflict",
  { timeout: 3_600_000 },
  async () => {
    let inputs;
    try {
      inputs = await loadInputs();
    } catch (error) {
      const reasonCode =
        error instanceof BlockedError && BLOCKED_CODES.has(error.reasonCode)
          ? error.reasonCode
          : "OWNER_INPUT_MISSING";
      await writeRunnerResult("BLOCKED", reasonCode);
      throw new Error(`BLOCKED: ${reasonCode}`);
    }

    let browser;
    let context;
    let stage = "app-token-and-fixture";
    try {
      const appToken = await githubInstallationToken(inputs);
      if (
        appToken.expiresAt - Date.now() <
        requiredOwnerLifetimeSeconds(inputs.config.timeouts) * 1000
      ) {
        block("INSUFFICIENT_LIFETIME");
      }
      const repository = {
        id: inputs.browserConfig.repository.id,
        owner: inputs.githubConfig.github.repository.owner,
        name: inputs.githubConfig.github.repository.name,
        fullName: inputs.browserConfig.repository.fullName,
      };
      const github = createGitHubClient(appToken.token, repository);
      const { branch, initialHead } = await validateSyntheticRepository(github, repository);
      const initialSceneOne = await latestSceneText(github, branch, SCENE_ONE);
      const initialSceneTwo = await latestSceneText(github, branch, SCENE_TWO);
      const kubernetesApi = makeKubernetesApi(inputs.kubernetesConfig);

      stage = "browser-and-writer-session";
      try {
        browser = await chromium.launch({ executablePath: inputs.chromiumPath, headless: true });
      } catch {
        block("BROWSER_UNAVAILABLE");
      }
      context = await browser.newContext({ serviceWorkers: "block" });
      context.setDefaultTimeout(30_000);
      await sessionCookies(
        context,
        inputs.derived.gatewayOrigin,
        inputs.githubConfig.gateway.writer,
      );
      const page = await context.newPage();
      page.on("dialog", (dialog) => {
        if (dialog.type() === "beforeunload" || dialog.type() === "confirm") void dialog.accept();
        else void dialog.dismiss();
      });
      const gatewaySession = await context.request
        .get(`${inputs.derived.gatewayOrigin.origin}/api/session`, {
          timeout: HTTP_TIMEOUT_MS,
          maxRedirects: 0,
        })
        .catch(() => null);
      if (!gatewaySession || gatewaySession.status() !== 200) block("RUNTIME_UNAVAILABLE");
      const gatewaySessionBody = await gatewaySession.json().catch(() => null);
      assert.equal(
        gatewaySessionBody?.userId,
        inputs.githubConfig.gateway.writer.expectedUserId,
        "Gateway writer cookie must resolve to the configured author",
      );

      stage = "hosted-handoff-and-assignment";
      let project;
      let appObservation;
      const entered = await enterApplication(page, inputs, branch);
      project = entered.projectId;
      const initialRuntime = await observeRuntime(inputs, kubernetesApi);
      assert.equal(
        initialRuntime.assignment.imageDigest,
        inputs.browserConfig.producer.artifactDigest,
      );
      assert.equal(
        initialRuntime.assignment.repositoryLocator,
        `https://github.com/${repository.owner}/${repository.name}`,
      );
      assert.equal(
        entered.dashboard.currentDigest,
        initialRuntime.assignment.imageDigest,
        "Gateway current deployment must point to the admitted RuntimeAssignment image",
      );
      appObservation = await remoteObservation(page, project);
      assert.ok(typeof appObservation === "string" && REVISION_PATTERN.test(appObservation));
      assert.equal(
        appObservation,
        initialHead,
        "Scriptorium must start from the confirmed GitHub default-branch revision",
      );
      const runtimeBefore = await observeRuntime(inputs, kubernetesApi);
      assert.equal(runtimeBefore.assignment.runtimeEpoch, initialRuntime.assignment.runtimeEpoch);
      assert.equal(runtimeBefore.podUid, initialRuntime.podUid);
      assert.equal(new URL(page.url()).origin, inputs.derived.instanceOrigin.origin);

      stage = "checkpoint-and-unsafe-quiesce";
      await openScene(page, "Chapter One: Scene One", "Scene One");
      const editor = page.locator(".cm-content");
      const sceneOneText = `${initialSceneOne.trimEnd()}\n\nPraetorium Hosted recovery checkpoint ${randomUUID()}\n`;
      await editor.fill(sceneOneText);
      const sceneOneDraft = await readInitialJournalState(
        page,
        SCENE_ONE,
        sceneOneText,
        inputs.config.timeouts.remoteSeconds * 1000,
      );
      const sceneOneEntry = findJournalEntry(sceneOneDraft, SCENE_ONE, sceneOneText);
      assert.ok(sceneOneEntry);
      assert.equal(sceneOneEntry.repositoryId, repository.id);
      assert.equal(sceneOneEntry.defaultBranch, branch);
      await page.getByRole("button", { name: "Checkpoint", exact: true }).click();
      const localCheckpoint = await waitFor(
        "local-only Scriptorium checkpoint",
        () => browserJournal(page),
        (records) =>
          records.some(
            (entry) =>
              entry.operationId === sceneOneEntry.operationId &&
              entry.state === "checkpointed" &&
              entry.checkpoint?.localCommit,
          ),
        inputs.config.timeouts.remoteSeconds * 1000,
      );
      const checkpointEntry = localCheckpoint.find(
        (entry) => entry.operationId === sceneOneEntry.operationId,
      );
      assert.ok(checkpointEntry);
      assert.equal(await github.head(branch), initialHead, "checkpoint must not write to GitHub");
      const beforeBlockedRedeploy = await observeRuntime(inputs, kubernetesApi);
      const blockedRedeploy = await triggerRedeploy(page, inputs, "blocked");
      assert.equal(
        blockedRedeploy.state,
        "Ready",
        "unsafe quiesce must keep the serving runtime ready",
      );
      const afterBlockedRedeploy = await observeRuntime(inputs, kubernetesApi);
      assert.equal(
        blockedRedeploy.currentDigest,
        beforeBlockedRedeploy.assignment.imageDigest,
        "blocked redeploy must keep the same Gateway image digest",
      );
      assert.equal(
        afterBlockedRedeploy.podUid,
        beforeBlockedRedeploy.podUid,
        "unsafe quiesce must not replace the writer Pod",
      );
      assert.equal(
        afterBlockedRedeploy.assignment.runtimeEpoch,
        beforeBlockedRedeploy.assignment.runtimeEpoch,
        "blocked operation must not advance the runtime epoch",
      );
      assert.equal(
        afterBlockedRedeploy.assignment.imageDigest,
        beforeBlockedRedeploy.assignment.imageDigest,
      );
      assert.equal(
        afterBlockedRedeploy.assignment.compositionManifestDigest,
        beforeBlockedRedeploy.assignment.compositionManifestDigest,
      );
      await enterApplication(page, inputs, branch);
      await openScene(page, "Chapter One: Scene One", "Scene One");
      assert.equal(await editorText(page), sceneOneText);
      const blockedJournal = await browserJournal(page);
      assert.ok(
        blockedJournal.some(
          (entry) =>
            entry.operationId === checkpointEntry.operationId &&
            entry.text === sceneOneText &&
            entry.state === "checkpointed",
        ),
      );
      const publishedOne = await publishExistingCheckpoint(
        page,
        github,
        branch,
        SCENE_ONE,
        sceneOneText,
        checkpointEntry,
        inputs.config.timeouts.remoteSeconds * 1000,
      );
      assert.notEqual(publishedOne, initialHead);
      const operationRecord = await github.content(
        operationPath(checkpointEntry.operationId),
        branch,
      );
      assert.ok(
        operationRecord,
        "explicit save must publish the canonical Scriptorium operation receipt",
      );
      const decodedOperation = JSON.parse(operationRecord.content);
      assert.equal(decodedOperation.operation?.id, checkpointEntry.operationId);
      assert.ok(
        decodedOperation.operation?.writes?.some(
          (write) => write.path === SCENE_ONE && write.content === sceneOneText,
        ),
      );
      await waitFor(
        "confirmed journal cleanup after GitHub save",
        () => browserJournal(page),
        (records) => !records.some((entry) => entry.operationId === checkpointEntry.operationId),
        inputs.config.timeouts.remoteSeconds * 1000,
      );

      stage = "same-origin-redeploy-and-browser-journal";
      await openScene(page, "Chapter One: Scene Two", "Scene Two");
      const sceneTwoText = `${initialSceneTwo.trimEnd()}\n\nPraetorium Hosted browser journal ${randomUUID()}\n`;
      await page.locator(".cm-content").fill(sceneTwoText);
      const sceneTwoDrafts = await readInitialJournalState(
        page,
        SCENE_TWO,
        sceneTwoText,
        inputs.config.timeouts.remoteSeconds * 1000,
      );
      const sceneTwoEntry = findJournalEntry(sceneTwoDrafts, SCENE_TWO, sceneTwoText);
      assert.ok(sceneTwoEntry);
      const beforeSafeRedeploy = await observeRuntime(inputs, kubernetesApi);
      const completedRedeploy = await triggerRedeploy(page, inputs, "complete");
      assert.equal(completedRedeploy.state, "Ready");
      assert.equal(
        completedRedeploy.currentDigest,
        beforeSafeRedeploy.assignment.imageDigest,
        "Gateway same-image redeploy must keep the assigned image digest",
      );
      const afterSafeRedeploy = await waitFor(
        "new Scriptorium Pod and runtime epoch after real same-image redeploy",
        () => observeRuntime(inputs, kubernetesApi),
        (state) =>
          state.podUid !== beforeSafeRedeploy.podUid &&
          state.assignment.runtimeEpoch > beforeSafeRedeploy.assignment.runtimeEpoch,
        inputs.config.timeouts.redeploySeconds * 1000,
      );
      const admittedPlatformDigest = await assertAdmittedRuntimeImage(
        inputs,
        afterSafeRedeploy,
        completedRedeploy.operationId,
      );
      assert.equal(
        afterSafeRedeploy.assignment.instanceId,
        beforeSafeRedeploy.assignment.instanceId,
      );
      assert.equal(
        afterSafeRedeploy.assignment.repositoryId,
        beforeSafeRedeploy.assignment.repositoryId,
      );
      assert.equal(
        afterSafeRedeploy.assignment.imageDigest,
        beforeSafeRedeploy.assignment.imageDigest,
        "same-image redeploy must retain the immutable image",
      );
      assert.equal(
        afterSafeRedeploy.assignment.compositionManifestDigest,
        beforeSafeRedeploy.assignment.compositionManifestDigest,
      );
      assert.deepEqual(
        [...afterSafeRedeploy.assignment.enabledModuleIds].sort(),
        [...beforeSafeRedeploy.assignment.enabledModuleIds].sort(),
      );
      assert.equal(afterSafeRedeploy.image, beforeSafeRedeploy.image);
      await enterApplication(page, inputs, branch);
      await openScene(page, "Chapter One: Scene Two", "Scene Two");
      assert.equal(
        await editorText(page),
        sceneTwoText,
        "browser IndexedDB journal must replay the author draft after same-origin Pod replacement",
      );
      const restoredDraft = await browserJournal(page);
      const restoredEntry = findJournalEntry(restoredDraft, SCENE_TWO, sceneTwoText);
      assert.ok(
        restoredEntry &&
          restoredEntry.state === "draft" &&
          restoredEntry.operationContent === sceneTwoText,
      );
      assert.equal(restoredEntry.repositoryId, repository.id);

      stage = "remote-update-and-conflict-preservation";
      const remoteUneditedSceneOne = `${sceneOneText.trimEnd()}\n\nPraetorium Hosted external unedited update ${randomUUID()}\n`;
      const uneditedExternalHead = await github.updateContent(
        SCENE_ONE,
        branch,
        remoteUneditedSceneOne,
        "acceptance: external update to unedited Scriptorium scene",
      );
      await page.evaluate(() => globalThis.dispatchEvent(new Event("online")));
      await waitFor(
        "Scriptorium observation of the external unedited-scene update",
        () => remoteObservation(page, project),
        (head) => head === uneditedExternalHead,
        inputs.config.timeouts.remoteSeconds * 1000,
      );
      await openScene(page, "Chapter One: Scene One", "Scene One");
      assert.equal(
        await editorText(page),
        remoteUneditedSceneOne,
        "an unedited manuscript view must follow the confirmed GitHub update",
      );
      await openScene(page, "Chapter One: Scene Two", "Scene Two");
      assert.equal(
        await editorText(page),
        sceneTwoText,
        "following a remote update to another scene must preserve the author's draft",
      );
      const remoteUpdateText = `${initialSceneTwo.trimEnd()}\n\nPraetorium Hosted external remote update ${randomUUID()}\n`;
      const externalHead = await github.updateContent(
        SCENE_TWO,
        branch,
        remoteUpdateText,
        "acceptance: external update to dedicated Scriptorium fixture",
      );
      await page.evaluate(() => globalThis.dispatchEvent(new Event("online")));
      await waitFor(
        "Scriptorium observation of the external GitHub update",
        () => remoteObservation(page, project),
        (head) => head === externalHead,
        inputs.config.timeouts.remoteSeconds * 1000,
      );
      await waitFor(
        "author draft conflict in browser recovery journal",
        () => browserJournal(page),
        (records) =>
          records.some(
            (entry) =>
              entry.operationId === restoredEntry.operationId &&
              entry.state === "draft" &&
              entry.text === sceneTwoText,
          ),
        inputs.config.timeouts.remoteSeconds * 1000,
      );
      await page
        .locator(".conflict")
        .waitFor({ state: "visible", timeout: inputs.config.timeouts.remoteSeconds * 1000 });
      assert.equal(
        await editorText(page),
        sceneTwoText,
        "remote refresh must preserve exact author input",
      );
      const authoredAddition = sceneTwoText.slice(initialSceneTwo.trimEnd().length).trim();
      const visibleRemoteText = `${remoteUpdateText.trimEnd()}\n\n${authoredAddition}\n`;
      await page.locator(".cm-content").fill(visibleRemoteText);
      await page
        .getByRole("button", { name: "比較して下書きを最新の版に結び直す", exact: true })
        .click();
      await page
        .getByText("比較した下書きを最新の原稿に結び直しました。", { exact: true })
        .waitFor({ state: "visible", timeout: inputs.config.timeouts.remoteSeconds * 1000 });
      assert.equal(await editorText(page), visibleRemoteText);
      assert.equal(
        await page.locator(".conflict").count(),
        0,
        "explicit merge and rebase must clear the conflict state",
      );
      const mergedJournal = await waitFor(
        "rebased browser author operation",
        () => browserJournal(page),
        (records) =>
          records.some(
            (entry) =>
              entry.operationId === restoredEntry.operationId &&
              entry.state === "draft" &&
              entry.text === visibleRemoteText &&
              entry.operationContent === visibleRemoteText,
          ),
        inputs.config.timeouts.remoteSeconds * 1000,
      );
      const mergedEntry = findJournalEntry(mergedJournal, SCENE_TWO, visibleRemoteText);
      assert.ok(mergedEntry);
      const finalHead = await proveCheckpointAndPublish(
        page,
        github,
        branch,
        SCENE_TWO,
        visibleRemoteText,
        inputs.config.timeouts.remoteSeconds * 1000,
      );
      assert.notEqual(finalHead, externalHead);
      const finalSceneTwo = await latestSceneText(github, branch, SCENE_TWO);
      assert.ok(
        finalSceneTwo.startsWith(initialSceneTwo),
        "final save must preserve the original scene text",
      );
      assert.ok(finalSceneTwo.includes("Praetorium Hosted external remote update"));
      assert.ok(finalSceneTwo.includes("Praetorium Hosted browser journal"));
      const finalSceneOne = await latestSceneText(github, branch, SCENE_ONE);
      assert.ok(
        finalSceneOne.includes("Praetorium Hosted external unedited update"),
        "saving a merged scene must retain an independent remote update",
      );
      assert.notEqual(
        await github.head(branch),
        externalHead,
        "explicit author publication must follow the external remote update",
      );
      await waitFor(
        "final remote confirmation in Scriptorium",
        () => remoteObservation(page, project),
        (head) => head === finalHead,
        inputs.config.timeouts.remoteSeconds * 1000,
      );
      const finalRuntime = await observeRuntime(inputs, kubernetesApi);
      assert.equal(
        finalRuntime.podUid,
        afterSafeRedeploy.podUid,
        "editing and publishing must not unexpectedly replace the current runtime",
      );
      assert.equal(finalRuntime.assignment.runtimeEpoch, afterSafeRedeploy.assignment.runtimeEpoch);
      assert.equal(
        containerImageDigest(finalRuntime.imageId),
        admittedPlatformDigest,
        "the final serving Pod must retain the admitted platform image digest",
      );
      assert.equal(new URL(page.url()).origin, inputs.derived.instanceOrigin.origin);

      process.stdout.write(
        JSON.stringify({
          category: CATEGORY,
          status: "VERIFIED",
          instanceId: finalRuntime.assignment.instanceId,
          repositoryId: finalRuntime.assignment.repositoryId,
          runtimeEpochBefore: initialRuntime.assignment.runtimeEpoch,
          runtimeEpochAfter: finalRuntime.assignment.runtimeEpoch,
          imageDigest: finalRuntime.assignment.imageDigest,
          platformManifestDigest: admittedPlatformDigest,
          compositionManifestDigest: finalRuntime.assignment.compositionManifestDigest,
          blockedPodUidPreserved: afterBlockedRedeploy.podUid === beforeBlockedRedeploy.podUid,
          safeRedeployRecreatedPod: afterSafeRedeploy.podUid !== beforeSafeRedeploy.podUid,
          browserJournalRestored: restoredEntry.operationId === sceneTwoEntry.operationId,
          externalUpdatePreserved: finalSceneTwo.includes(
            "Praetorium Hosted external remote update",
          ),
          authorSaveConfirmed: finalSceneTwo.includes("Praetorium Hosted browser journal"),
        }) + "\n",
      );
    } catch (error) {
      const reasonCode =
        error instanceof BlockedError && BLOCKED_CODES.has(error.reasonCode)
          ? error.reasonCode
          : Date.parse(inputs.expiresAt) <= Date.now()
            ? "INSUFFICIENT_LIFETIME"
            : "ACCEPTANCE_ASSERTION_FAILED";
      await writeRunnerResult(
        reasonCode === "ACCEPTANCE_ASSERTION_FAILED" ? "FAILED" : "BLOCKED",
        reasonCode,
      );
      throw new Error(`${reasonCode}: ${stage}`);
    } finally {
      await context?.close().catch(() => {});
      await browser?.close().catch(() => {});
    }
  },
);
