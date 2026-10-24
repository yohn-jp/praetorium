import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { access, lstat, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { chromium } from "@playwright/test";

const CATEGORY = "browser-entry";
const INVENTORY_ENV = "PRAETORIUM_T14_INVENTORY_PATH";
const CATEGORY_ENV = "PRAETORIUM_T14_CATEGORY";
const RESULT_ENV = "PRAETORIUM_T14_RESULT_PATH";
const RESULT_FILENAME = "runner-result.json";
const REQUIRED_CATEGORIES = [
  "workers-d1-do",
  "github-access",
  "buildkit-registry",
  "kubernetes-isolation",
  "browser-entry",
  "producer-recovery",
  "stable-rollout",
];
const MAX_INVENTORY_BYTES = 64 * 1024;
const MAX_CONFIG_BYTES = 32 * 1024;
const MAX_STORAGE_STATE_BYTES = 2 * 1024 * 1024;
const MAX_WRITE_BODY_BYTES = 8 * 1024;
const MAX_BROWSER_MANUSCRIPT_CHARS = 16 * 1024;
const BROWSER_EDIT_MARKER = "Praetorium T14 browser edit:";
const OWNED_MANUSCRIPT_PATH = "manuscript/vol-1/ch-1/scene-1.md";
const ID_PATTERN = /^ins_[0-9A-HJKMNP-TV-Z]{26}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const BLOCKED_CODES = new Set([
  "OWNER_INPUT_MISSING",
  "OWNED_ENVIRONMENT_UNAVAILABLE",
  "PRODUCER_CONTRACT_MISSING",
  "PRODUCER_ADMISSION_UNAVAILABLE",
  "RUNTIME_UNAVAILABLE",
  "BROWSER_UNAVAILABLE",
  "INSUFFICIENT_LIFETIME",
]);

class GateBlocked extends Error {
  constructor(reasonCode) {
    super(reasonCode);
    this.reasonCode = reasonCode;
  }
}

function block(reasonCode) {
  throw new GateBlocked(reasonCode);
}

function ensureOwnerLifetime(inventory, requiredSeconds) {
  const remainingMs = Date.parse(inventory.environment.expiresAt) - Date.now();
  const requiredMs = requiredSeconds * 1_000 + 5_000;
  if (remainingMs < requiredMs) block("INSUFFICIENT_LIFETIME");
  return Math.min(requiredSeconds * 1_000, remainingMs - 5_000);
}

function ownerBoundSignal(inventory, maximumMs) {
  const remainingMs = Date.parse(inventory.environment.expiresAt) - Date.now();
  return AbortSignal.timeout(Math.max(1, Math.min(maximumMs, remainingMs)));
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return (
    isRecord(value) && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0")
  );
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
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

function parseOrigin(value) {
  if (!nonEmpty(value)) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.origin !== value ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.hostname.length > 253 ||
      /(?:^|\.)(?:localhost|example\.(?:com|net|org)|invalid|test)$/u.test(url.hostname)
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function safeAbsolutePath(value) {
  return typeof value === "string" && path.isAbsolute(value) && !value.includes("\0");
}

function validateInventory(inventory) {
  if (
    !exactKeys(inventory, ["schemaVersion", "inventoryId", "owner", "environment", "resources"]) ||
    inventory.schemaVersion !== 1 ||
    !safeText(inventory.inventoryId, 128) ||
    !exactKeys(inventory.owner, ["name", "identity"]) ||
    !safeText(inventory.owner.name, 256) ||
    !safeText(inventory.owner.identity, 256) ||
    !exactKeys(inventory.environment, [
      "name",
      "purpose",
      "disposable",
      "production",
      "expiresAt",
      "cleanupProcedure",
    ]) ||
    !safeText(inventory.environment.name, 256) ||
    inventory.environment.purpose !== "t14-disposable-test" ||
    inventory.environment.disposable !== true ||
    inventory.environment.production !== false ||
    !safeText(inventory.environment.cleanupProcedure, 2048) ||
    !safeText(inventory.environment.expiresAt, 64) ||
    Date.parse(inventory.environment.expiresAt) <= Date.now() ||
    !exactKeys(inventory.resources, REQUIRED_CATEGORIES)
  ) {
    block("OWNER_INPUT_MISSING");
  }

  for (const category of REQUIRED_CATEGORIES) {
    const resource = inventory.resources[category];
    if (
      !exactKeys(resource, ["state", "owner", "disposable", "production", "reference"]) ||
      !["available", "missing"].includes(resource.state) ||
      resource.owner !== inventory.owner.identity ||
      resource.disposable !== true ||
      resource.production !== false ||
      (resource.state === "missing" && resource.reference !== null) ||
      (resource.state === "available" && !safeText(resource.reference, 1024))
    ) {
      block("OWNER_INPUT_MISSING");
    }
  }

  if (inventory.resources[CATEGORY].state !== "available") {
    block("OWNED_ENVIRONMENT_UNAVAILABLE");
  }
  if (!safeAbsolutePath(inventory.resources[CATEGORY].reference)) {
    block("OWNER_INPUT_MISSING");
  }
}

async function readJsonFile(filePath, maximumBytes, privateFile = false) {
  if (!safeAbsolutePath(filePath)) block("OWNER_INPUT_MISSING");
  const linkInfo = await lstat(filePath).catch(() => null);
  if (!linkInfo?.isFile() || linkInfo.isSymbolicLink()) block("OWNER_INPUT_MISSING");
  const actualPath = await realpath(filePath).catch(() => null);
  if (!actualPath || actualPath !== path.resolve(filePath)) block("OWNER_INPUT_MISSING");
  const fileInfo = await stat(actualPath).catch(() => null);
  if (
    !fileInfo?.isFile() ||
    fileInfo.size > maximumBytes ||
    (privateFile && (fileInfo.uid !== process.getuid?.() || (fileInfo.mode & 0o077) !== 0))
  ) {
    block("OWNER_INPUT_MISSING");
  }
  const contents = await readFile(actualPath).catch(() => null);
  if (!contents || contents.byteLength > maximumBytes) block("OWNER_INPUT_MISSING");
  try {
    const value = JSON.parse(contents.toString("utf8"));
    if (!isRecord(value)) block("OWNER_INPUT_MISSING");
    return value;
  } catch {
    block("OWNER_INPUT_MISSING");
  }
}

async function readPrivateCredential(filePath) {
  if (!safeAbsolutePath(filePath)) block("OWNER_INPUT_MISSING");
  const linkInfo = await lstat(filePath).catch(() => null);
  if (!linkInfo?.isFile() || linkInfo.isSymbolicLink()) block("OWNER_INPUT_MISSING");
  const actualPath = await realpath(filePath).catch(() => null);
  const fileInfo = actualPath ? await stat(actualPath).catch(() => null) : null;
  if (
    !actualPath ||
    actualPath !== path.resolve(filePath) ||
    !fileInfo?.isFile() ||
    fileInfo.uid !== process.getuid?.() ||
    (fileInfo.mode & 0o077) !== 0 ||
    fileInfo.size < 1 ||
    fileInfo.size > 4096
  ) {
    block("OWNER_INPUT_MISSING");
  }
  const bytes = await readFile(actualPath).catch(() => null);
  if (!bytes || bytes.byteLength > 4096) block("OWNER_INPUT_MISSING");
  const credential = bytes.toString("utf8").trimEnd();
  if (!/^[\x21-\x7e]{32,4096}$/u.test(credential)) block("OWNER_INPUT_MISSING");
  return credential;
}

const SOURCE_JOB_ID_PATTERN =
  /^sr_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const RELEASE_ID_PATTERN =
  /^rel_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_ADMISSION_RESPONSE_BYTES = 64 * 1024;

async function readBoundedJsonResponse(response) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ADMISSION_RESPONSE_BYTES) {
    block("PRODUCER_ADMISSION_UNAVAILABLE");
  }
  const reader = response.body?.getReader();
  if (!reader) block("PRODUCER_ADMISSION_UNAVAILABLE");
  const chunks = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read().catch(() => ({ done: true, value: null }));
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > MAX_ADMISSION_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      block("PRODUCER_ADMISSION_UNAVAILABLE");
    }
    chunks.push(Buffer.from(value));
  }
  const bytes = Buffer.concat(chunks, byteLength);
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    if (!isRecord(value)) block("PRODUCER_ADMISSION_UNAVAILABLE");
    return value;
  } catch {
    block("PRODUCER_ADMISSION_UNAVAILABLE");
  }
}

async function readAdmissionEndpoint({
  origin,
  pathname,
  actorId,
  credential,
  inventory,
  fetchImpl = fetch,
}) {
  const response = await fetchImpl(new URL(pathname, origin), {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-Control-Plane-Admin-Auth": credential,
      "X-Praetorium-Admin-Actor": actorId,
    },
    redirect: "manual",
    signal: ownerBoundSignal(inventory, 15_000),
  }).catch(() => null);
  if (Date.parse(inventory.environment.expiresAt) <= Date.now()) {
    block("INSUFFICIENT_LIFETIME");
  }
  if (
    !response ||
    response.status !== 200 ||
    response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
      "application/json"
  ) {
    block("PRODUCER_ADMISSION_UNAVAILABLE");
  }
  return readBoundedJsonResponse(response);
}

function validateSourceJobDetail(value, config) {
  const job = value.job;
  if (
    !isRecord(job) ||
    job.id !== config.producerAdmission.sourceJobId ||
    job.state !== "admitted" ||
    job.commit !== config.producer.revision ||
    job.admittedReleaseId !== config.producerAdmission.releaseId
  ) {
    block("PRODUCER_CONTRACT_MISSING");
  }
}

function validateAdmittedReleaseStatus(value, config) {
  const release = value.release;
  if (
    !isRecord(release) ||
    release.id !== config.producerAdmission.releaseId ||
    release.status !== "available" ||
    release.imageDigest !== config.producer.runtimeBaseDigest
  ) {
    block("PRODUCER_CONTRACT_MISSING");
  }
}

async function verifyCurrentProducerAdmission(config, inventory, fetchImpl = fetch) {
  const credential = await readPrivateCredential(config.producerAdmission.adminCredentialPath);
  const origin = parseOrigin(config.producerAdmission.controlPlaneOrigin)?.origin;
  if (!origin) block("OWNER_INPUT_MISSING");
  const sourceJob = await readAdmissionEndpoint({
    origin,
    pathname: `/v1/operator/source-builds/${encodeURIComponent(config.producerAdmission.sourceJobId)}?limit=10`,
    actorId: config.gateway.expectedUserId,
    credential,
    inventory,
    fetchImpl,
  });
  validateSourceJobDetail(sourceJob, config);
  const releaseStatus = await readAdmissionEndpoint({
    origin,
    pathname: `/v1/operator/releases/${encodeURIComponent(config.producerAdmission.releaseId)}`,
    actorId: config.gateway.expectedUserId,
    credential,
    inventory,
    fetchImpl,
  });
  validateAdmittedReleaseStatus(releaseStatus, config);
}

test("owner admission guard accepts a current tuple independently of the historical ledger", () => {
  const config = {
    producer: {
      revision: "a".repeat(40),
      runtimeBaseDigest: `sha256:${"b".repeat(64)}`,
    },
    producerAdmission: {
      sourceJobId: "sr_11111111-1111-4111-8111-111111111111",
      releaseId: "rel_11111111-1111-4111-8111-111111111111",
    },
  };
  const jobDetail = {
    job: {
      id: config.producerAdmission.sourceJobId,
      state: "admitted",
      commit: config.producer.revision,
      admittedReleaseId: config.producerAdmission.releaseId,
    },
  };
  const releaseStatus = {
    release: {
      id: config.producerAdmission.releaseId,
      status: "available",
      imageDigest: config.producer.runtimeBaseDigest,
    },
  };
  assert.doesNotThrow(() => {
    validateSourceJobDetail(jobDetail, config);
    validateAdmittedReleaseStatus(releaseStatus, config);
  });
});

test("owner admission guard blocks mismatched or unavailable current evidence", async () => {
  const config = {
    producer: {
      revision: "a".repeat(40),
      runtimeBaseDigest: `sha256:${"b".repeat(64)}`,
    },
    producerAdmission: {
      sourceJobId: "sr_11111111-1111-4111-8111-111111111111",
      releaseId: "rel_11111111-1111-4111-8111-111111111111",
    },
  };
  assert.throws(
    () => validateSourceJobDetail({ job: { id: "other", state: "admitted" } }, config),
    (error) => error instanceof GateBlocked && error.reasonCode === "PRODUCER_CONTRACT_MISSING",
  );
  assert.throws(
    () =>
      validateSourceJobDetail(
        {
          job: {
            id: config.producerAdmission.sourceJobId,
            state: "admitted",
            commit: "c".repeat(40),
            admittedReleaseId: config.producerAdmission.releaseId,
          },
        },
        config,
      ),
    (error) => error instanceof GateBlocked && error.reasonCode === "PRODUCER_CONTRACT_MISSING",
  );
  assert.throws(
    () =>
      validateAdmittedReleaseStatus(
        {
          release: {
            id: config.producerAdmission.releaseId,
            status: "candidate",
            imageDigest: config.producer.runtimeBaseDigest,
          },
        },
        config,
      ),
    (error) => error instanceof GateBlocked && error.reasonCode === "PRODUCER_CONTRACT_MISSING",
  );
  assert.throws(
    () =>
      validateAdmittedReleaseStatus(
        {
          release: {
            id: config.producerAdmission.releaseId,
            status: "available",
            imageDigest: `sha256:${"c".repeat(64)}`,
          },
        },
        config,
      ),
    (error) => error instanceof GateBlocked && error.reasonCode === "PRODUCER_CONTRACT_MISSING",
  );
  await assert.rejects(
    () =>
      readAdmissionEndpoint({
        origin: "https://control.example",
        pathname: "/v1/operator/source-builds/sr_11111111-1111-4111-8111-111111111111?limit=10",
        actorId: "213253858",
        credential: "never-logged-private-credential-value",
        inventory: { environment: { expiresAt: new Date(Date.now() + 60_000).toISOString() } },
        fetchImpl: async () => new Response("", { status: 503 }),
      }),
    (error) =>
      error instanceof GateBlocked && error.reasonCode === "PRODUCER_ADMISSION_UNAVAILABLE",
  );
});

function validateBrowserState(state) {
  if (
    !exactKeys(state, ["cookies", "origins"]) ||
    !Array.isArray(state.cookies) ||
    !Array.isArray(state.origins)
  ) {
    block("OWNER_INPUT_MISSING");
  }
  if (state.origins.length !== 0) block("OWNER_INPUT_MISSING");
  for (const cookie of state.cookies) {
    if (!isRecord(cookie) || typeof cookie.domain !== "string") block("OWNER_INPUT_MISSING");
    const domain = cookie.domain.replace(/^\./u, "").toLowerCase();
    if (domain !== "github.com" && !domain.endsWith(".github.com")) {
      block("OWNER_INPUT_MISSING");
    }
  }
}

function validateWriteProbe(value) {
  if (
    !exactKeys(value, ["path", "body"]) ||
    typeof value.path !== "string" ||
    !isRecord(value.body)
  ) {
    block("OWNER_INPUT_MISSING");
  }
  let parsed;
  try {
    parsed = new URL(value.path, "https://instance.invalid");
  } catch {
    block("OWNER_INPUT_MISSING");
  }
  if (
    parsed.origin !== "https://instance.invalid" ||
    parsed.pathname !== value.path ||
    parsed.search ||
    parsed.hash ||
    !(
      parsed.pathname.startsWith("/api/") ||
      parsed.pathname === "/mcp" ||
      parsed.pathname.startsWith("/mcp/")
    )
  ) {
    block("OWNER_INPUT_MISSING");
  }
  const body = JSON.stringify(value.body);
  if (Buffer.byteLength(body) > MAX_WRITE_BODY_BYTES) block("OWNER_INPUT_MISSING");
  return body;
}

function validHostnameSuffix(value) {
  return (
    typeof value === "string" &&
    value.length <= 253 &&
    value === value.toLowerCase() &&
    value.includes(".") &&
    !/^\d+(?:\.\d+){3}$/u.test(value) &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(
      value,
    ) &&
    !/(?:^|\.)(?:localhost|local|internal|onion|example\.(?:com|net|org)|invalid|test)$/u.test(
      value,
    )
  );
}

function ownedApplicationOriginMatches(repositoryId, hostnameSuffix, rawOrigin) {
  const origin = parseOrigin(rawOrigin);
  return (
    Number.isSafeInteger(repositoryId) &&
    repositoryId > 0 &&
    validHostnameSuffix(hostnameSuffix) &&
    origin?.origin === `https://${repositoryId}.${hostnameSuffix}`
  );
}

function rpcBodyFromText(text) {
  try {
    return JSON.parse(text);
  } catch {
    const eventData = text
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    try {
      return eventData ? JSON.parse(eventData) : null;
    } catch {
      return null;
    }
  }
}

function validateConfig(config, inventory) {
  if (
    !exactKeys(config, [
      "schemaVersion",
      "inventory",
      "gateway",
      "repository",
      "instance",
      "browser",
      "producer",
      "producerAdmission",
      "writeProbe",
      "selection",
      "mcp",
      "timeouts",
    ]) ||
    config.schemaVersion !== 1
  ) {
    block("OWNER_INPUT_MISSING");
  }
  if (
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
    !parseOrigin(config.gateway.origin) ||
    !safeText(config.gateway.expectedUserId, 128) ||
    !exactKeys(config.repository, ["id", "fullName"]) ||
    !Number.isSafeInteger(config.repository.id) ||
    config.repository.id < 1 ||
    !/^[A-Za-z0-9_.-]{1,255}\/[A-Za-z0-9_.-]{1,255}$/u.test(config.repository.fullName) ||
    !exactKeys(config.instance, ["id", "origin", "hostnameSuffix", "applicationHeading"]) ||
    !ID_PATTERN.test(config.instance.id) ||
    !parseOrigin(config.instance.origin) ||
    !validHostnameSuffix(config.instance.hostnameSuffix) ||
    !safeText(config.instance.applicationHeading, 256)
  ) {
    block("OWNER_INPUT_MISSING");
  }

  const instanceOrigin = parseOrigin(config.instance.origin);
  const gatewayOrigin = parseOrigin(config.gateway.origin);
  if (
    !instanceOrigin ||
    !gatewayOrigin ||
    instanceOrigin.origin === gatewayOrigin.origin ||
    !ownedApplicationOriginMatches(
      config.repository.id,
      config.instance.hostnameSuffix,
      instanceOrigin.origin,
    )
  ) {
    block("OWNER_INPUT_MISSING");
  }

  if (
    !exactKeys(config.browser, ["executablePath", "githubStorageStatePath"]) ||
    !safeAbsolutePath(config.browser.executablePath) ||
    !safeAbsolutePath(config.browser.githubStorageStatePath)
  ) {
    block("OWNER_INPUT_MISSING");
  }

  if (
    !exactKeys(config.producer, ["revision", "runtimeBaseDigest"]) ||
    !REVISION_PATTERN.test(config.producer.revision) ||
    !DIGEST_PATTERN.test(config.producer.runtimeBaseDigest)
  ) {
    block("OWNER_INPUT_MISSING");
  }

  if (
    !exactKeys(config.producerAdmission, [
      "sourceJobId",
      "releaseId",
      "controlPlaneOrigin",
      "adminCredentialPath",
    ]) ||
    !SOURCE_JOB_ID_PATTERN.test(config.producerAdmission.sourceJobId) ||
    !RELEASE_ID_PATTERN.test(config.producerAdmission.releaseId) ||
    !parseOrigin(config.producerAdmission.controlPlaneOrigin) ||
    !safeAbsolutePath(config.producerAdmission.adminCredentialPath)
  ) {
    block("OWNER_INPUT_MISSING");
  }

  if (
    !exactKeys(config.selection, [
      "releasePolicy",
      "releaseId",
      "moduleIds",
      "resourceProfileId",
    ]) ||
    !["stable", "pinned"].includes(config.selection.releasePolicy) ||
    !safeText(config.selection.releaseId, 128) ||
    !Array.isArray(config.selection.moduleIds) ||
    config.selection.moduleIds.length === 0 ||
    config.selection.moduleIds.some((moduleId) => !safeText(moduleId, 128)) ||
    new Set(config.selection.moduleIds).size !== config.selection.moduleIds.length ||
    !safeText(config.selection.resourceProfileId, 128)
  ) {
    block("OWNER_INPUT_MISSING");
  }

  if (
    !exactKeys(config.mcp, ["clientName", "requiredTools"]) ||
    !safeText(config.mcp.clientName, 80) ||
    !Array.isArray(config.mcp.requiredTools) ||
    config.mcp.requiredTools.length === 0 ||
    config.mcp.requiredTools.length > 32 ||
    config.mcp.requiredTools.some(
      (tool) => !safeText(tool, 64) || !/^[a-z][a-z0-9_-]{0,63}$/u.test(tool),
    ) ||
    new Set(config.mcp.requiredTools).size !== config.mcp.requiredTools.length
  ) {
    block("OWNER_INPUT_MISSING");
  }

  if (
    !exactKeys(config.timeouts, [
      "loginSeconds",
      "wakeSeconds",
      "configurationSeconds",
      "redeploySeconds",
      "mcpSeconds",
    ]) ||
    Object.values(config.timeouts).some(
      (seconds) => !Number.isSafeInteger(seconds) || seconds < 10 || seconds > 1800,
    )
  ) {
    block("OWNER_INPUT_MISSING");
  }

  const requiredLifetimeSeconds =
    Object.values(config.timeouts).reduce((sum, value) => sum + value, 0) + 120;
  if (
    requiredLifetimeSeconds > 3_600 ||
    Date.parse(inventory.environment.expiresAt) - Date.now() < requiredLifetimeSeconds * 1000
  ) {
    block("INSUFFICIENT_LIFETIME");
  }

  const writeProbeBody = validateWriteProbe(config.writeProbe);
  return {
    gatewayOrigin,
    instanceOrigin,
    writeProbeBody,
  };
}

async function loadInputs() {
  if (process.env[CATEGORY_ENV] !== CATEGORY || !safeAbsolutePath(process.env[INVENTORY_ENV])) {
    block("OWNER_INPUT_MISSING");
  }
  const inventory = await readJsonFile(process.env[INVENTORY_ENV], MAX_INVENTORY_BYTES);
  validateInventory(inventory);
  const configPath = inventory.resources[CATEGORY].reference;
  const config = await readJsonFile(configPath, MAX_CONFIG_BYTES, true);
  const derived = validateConfig(config, inventory);

  const executablePath = await realpath(config.browser.executablePath).catch(() => null);
  if (!executablePath || !(await stat(executablePath).catch(() => null))?.isFile()) {
    block("BROWSER_UNAVAILABLE");
  }
  try {
    await access(executablePath, fsConstants.X_OK);
  } catch {
    block("BROWSER_UNAVAILABLE");
  }

  const storageState = await readJsonFile(
    config.browser.githubStorageStatePath,
    MAX_STORAGE_STATE_BYTES,
    true,
  );
  validateBrowserState(storageState);

  await verifyCurrentProducerAdmission(config, inventory);
  return { inventory, config, storageState, derived, executablePath };
}

test("stable public origin binds the numeric repository under the owner suffix", () => {
  assert.equal(
    ownedApplicationOriginMatches(
      1423923158,
      "scriptorium.yohn.jp",
      "https://1423923158.scriptorium.yohn.jp",
    ),
    true,
  );
  assert.equal(
    ownedApplicationOriginMatches(
      1423923158,
      "scriptorium.yohn.jp",
      "https://1423923159.scriptorium.yohn.jp",
    ),
    false,
  );
  assert.equal(
    ownedApplicationOriginMatches(
      1423923158,
      "scriptorium.yohn.jp",
      "https://ins-01arz3ndektsv4rrffq69g5fav.instances.praetorium.yohn.jp",
    ),
    false,
  );
  assert.equal(
    ownedApplicationOriginMatches(
      1423923158,
      "scriptorium.test",
      "https://1423923158.scriptorium.test",
    ),
    false,
  );
  assert.equal(
    ownedApplicationOriginMatches(
      1423923158,
      "scriptorium.internal",
      "https://1423923158.scriptorium.internal",
    ),
    false,
  );
  assert.equal(
    ownedApplicationOriginMatches(1423923158, "127.0.0.1", "https://1423923158.127.0.0.1"),
    false,
  );
  assert.equal(
    ownedApplicationOriginMatches(
      1423923158,
      "scriptorium.yohn.jp",
      "https://1423923158.scriptorium.yohn.jp:8443",
    ),
    false,
  );
});

async function writeRunnerResult(status, reasonCode) {
  if (!BLOCKED_CODES.has(reasonCode) && reasonCode !== "ACCEPTANCE_ASSERTION_FAILED") return;
  const reportPath = process.env[RESULT_ENV];
  if (!safeAbsolutePath(reportPath)) return;
  const isolatedHome = process.env.HOME;
  if (!safeAbsolutePath(isolatedHome)) return;
  const resolvedHome = await realpath(isolatedHome).catch(() => null);
  const resolvedParent = await realpath(path.dirname(reportPath)).catch(() => null);
  if (
    !resolvedHome ||
    resolvedParent !== resolvedHome ||
    path.basename(reportPath) !== RESULT_FILENAME
  )
    return;
  const report = { reportVersion: 1, category: CATEGORY, status, reasonCode };
  await writeFile(path.join(resolvedHome, RESULT_FILENAME), `${JSON.stringify(report)}\n`, {
    flag: "wx",
    mode: 0o600,
  }).catch(() => {});
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

function readCookie(cookies, name, host) {
  const matches = cookies.filter((cookie) => cookie.name === name);
  assert.equal(matches.length, 1, "expected one host-only cookie");
  const cookie = matches[0];
  assert.equal(cookie.domain, host, "cookie must be host-only");
  assert.equal(cookie.secure, true, "cookie must be Secure");
  assert.equal(cookie.sameSite, "Lax", "cookie must use SameSite=Lax");
  return cookie;
}

async function cookiesAt(context, origin) {
  const host = new URL(origin).hostname;
  return (await context.cookies()).filter((cookie) => cookie.domain === host);
}

function parseModuleSelection(text) {
  const match = /Requested modules:\s*([\s\S]*?)\s*Included modules:/u.exec(text);
  if (!match) return null;
  const section = match[1]?.trim() ?? "";
  if (section === "None") return [];
  return section.split(", ").map((value) => value.trim());
}

async function formSelection(form) {
  return {
    releasePolicy: await form.locator('select[name="releasePolicy"]').inputValue(),
    releaseId: await form.locator('select[name="releaseId"]').inputValue(),
    moduleIds: await form
      .locator('input[type="checkbox"][name="moduleIds"]:checked')
      .evaluateAll((inputs) => inputs.map((input) => input.value).sort()),
    resourceProfileId: await form.locator('select[name="resourceProfileId"]').inputValue(),
  };
}

async function moduleDisplayNames(form) {
  const options = await form
    .locator('input[type="checkbox"][name="moduleIds"]')
    .evaluateAll((inputs) =>
      inputs.map((input) => {
        const label = input.closest("label");
        const display = label?.querySelector(":scope > span");
        const version = display?.querySelector(".field-help")?.textContent?.split(" · ")[0]?.trim();
        const name = display?.firstChild?.textContent?.trim();
        return name && version ? { id: input.value, displayName: `${name} (${version})` } : null;
      }),
    );
  if (options.some((option) => option === null)) return null;
  const byId = new Map(options.map((option) => [option.id, option.displayName]));
  const names = [...byId.values()];
  if (names.length !== new Set(names).size) return null;
  return byId;
}

function sameSelection(left, right) {
  return (
    left.releasePolicy === right.releasePolicy &&
    left.releaseId === right.releaseId &&
    JSON.stringify([...left.moduleIds].sort()) === JSON.stringify([...right.moduleIds].sort()) &&
    left.resourceProfileId === right.resourceProfileId
  );
}

function sameStringSet(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
  );
}

function extractDigest(text) {
  return /Composed image\s*:?\s*(sha256:[0-9a-f]{64})/u.exec(text)?.[1] ?? null;
}

async function dashboardSnapshot(page, config, gatewayOrigin, inventory) {
  ensureOwnerLifetime(inventory, 0);
  let response;
  try {
    response = await page.goto(`${gatewayOrigin.origin}/repositories/${config.repository.id}`, {
      waitUntil: "domcontentloaded",
    });
  } catch {
    block("RUNTIME_UNAVAILABLE");
  }
  if (response?.status() === 503) block("RUNTIME_UNAVAILABLE");
  assert.equal(response?.status(), 200, "repository dashboard must load successfully");
  await page.getByRole("heading", { name: config.repository.fullName, exact: true }).waitFor();
  const text = await page.locator("main").innerText();
  const stateBadge = page
    .getByRole("region", { name: "Application status", exact: true })
    .locator(".status-badge");
  assert.equal(await stateBadge.count(), 1, "dashboard must show one application-state badge");
  const state = await stateBadge.innerText();
  assert.match(state, /^(Ready|Starting|Stopped|Failed|Blocked|Status unavailable)$/u);
  const current = page
    .getByRole("heading", { name: "Current deployment", exact: true })
    .locator("xpath=..");
  const desired = page
    .getByRole("heading", { name: "Desired deployment", exact: true })
    .locator("xpath=..");
  for (const deployment of [current, desired]) {
    const identifiers = deployment.getByText("Exact artifact identifiers", { exact: true });
    if (await identifiers.count()) await identifiers.click();
  }
  const configureForm = page.locator("form").filter({
    has: page.locator('[name="action"][value="configure"]'),
  });
  const buildHeading = page.getByRole("heading", { name: "Configuration build", exact: true });
  const buildState = (await buildHeading.count())
    ? await buildHeading.locator("xpath=..").locator(".status-badge").innerText()
    : null;
  const redeployCards = page.locator("article.operation-card").filter({
    has: page.getByRole("heading", { name: /^redeploy$/iu }),
  });
  const redeployState = (await redeployCards.count())
    ? await redeployCards.first().locator(".status-badge").innerText()
    : null;
  return {
    text,
    state,
    buildState,
    redeployState,
    currentDigest: extractDigest(await current.innerText()),
    desiredDigest: extractDigest(await desired.innerText()),
    currentModules: parseModuleSelection(await current.innerText()),
    desiredModules: parseModuleSelection(await desired.innerText()),
    selection: (await configureForm.count()) === 1 ? await formSelection(configureForm) : null,
    moduleDisplayNames:
      (await configureForm.count()) === 1 ? await moduleDisplayNames(configureForm) : null,
  };
}

async function waitForReadyApp(page, config, derived, inventory, handoffPosts, deadlineMs) {
  const entryPath = `/entry/${encodeURIComponent(config.instance.id)}`;
  while (Date.now() < deadlineMs) {
    const location = new URL(page.url());
    if (location.origin === derived.instanceOrigin.origin && location.pathname === "/") {
      const heading = page.getByRole("heading", {
        name: config.instance.applicationHeading,
        exact: true,
      });
      if (await heading.count()) {
        await heading.waitFor({ state: "visible", timeout: 5_000 });
        return;
      }
    }

    if (location.origin === derived.gatewayOrigin.origin && location.pathname === entryPath) {
      const body = await page
        .locator("body")
        .innerText()
        .catch(() => "");
      if (body.includes("Configuration required")) {
        throw new Error("application artifact is not configured");
      }
      const poll = Number(location.searchParams.get("poll") ?? "0");
      if (body.includes("Repository instance is starting") && poll >= 5) {
        const statusLink = page.getByRole("link", { name: "Check status", exact: true });
        if (await statusLink.count()) {
          ensureOwnerLifetime(inventory, 5);
          await statusLink.click();
        }
      }
    }

    await delay(1_000);
  }
  assert.fail("instance did not reach the producer application before the owned deadline");
}

async function waitForDeployment(page, config, derived, inventory, expectedModules, deadlineMs) {
  while (Date.now() < deadlineMs) {
    const snapshot = await dashboardSnapshot(page, config, derived.gatewayOrigin, inventory);
    const alerts = await page.getByRole("alert").allTextContents();
    if (alerts.length > 0 || ["Failed", "Canceled"].includes(snapshot.buildState)) {
      assert.fail("configuration build failed; current deployment must remain available");
    }
    const selectedModuleNames =
      snapshot.selection && snapshot.moduleDisplayNames
        ? snapshot.selection.moduleIds.map((moduleId) => snapshot.moduleDisplayNames.get(moduleId))
        : null;
    const deployedAndRequestedModulesMatch =
      snapshot.currentModules !== null &&
      snapshot.desiredModules !== null &&
      selectedModuleNames !== null &&
      !selectedModuleNames.some((name) => typeof name !== "string") &&
      sameStringSet(snapshot.currentModules, selectedModuleNames) &&
      sameStringSet(snapshot.desiredModules, selectedModuleNames);
    if (
      snapshot.state === "Ready" &&
      snapshot.currentDigest &&
      snapshot.currentDigest === snapshot.desiredDigest &&
      snapshot.selection !== null &&
      sameSelection(snapshot.selection, config.selection) &&
      deployedAndRequestedModulesMatch &&
      JSON.stringify([...snapshot.selection.moduleIds].sort()) ===
        JSON.stringify([...expectedModules].sort())
    ) {
      return snapshot;
    }
    await delay(2_000);
  }
  assert.fail("configuration did not build and become ready before the owned deadline");
}

async function verifyApplicationCookies(context, derived) {
  const cookies = await cookiesAt(context, derived.instanceOrigin.origin);
  const access = readCookie(cookies, "__Host-praetorium_access", derived.instanceOrigin.hostname);
  const refresh = readCookie(
    cookies,
    "__Secure-praetorium_refresh",
    derived.instanceOrigin.hostname,
  );
  const csrf = readCookie(cookies, "__Host-praetorium_csrf", derived.instanceOrigin.hostname);
  assert.equal(access.path, "/");
  assert.equal(access.httpOnly, true);
  assert.equal(refresh.path, "/_platform");
  assert.equal(refresh.httpOnly, true);
  assert.equal(csrf.path, "/");
  assert.equal(csrf.httpOnly, false);
}

async function ownedApiJson(page, pathname, inventory, label) {
  ensureOwnerLifetime(inventory, 1);
  const response = await page.evaluate(async (path) => {
    if (!path.startsWith("/api/")) throw new Error("owned API path required");
    const result = await fetch(path, {
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
    });
    return { status: result.status, body: await result.json().catch(() => null) };
  }, pathname);
  assert.equal(response.status, 200, `${label} must return HTTP 200`);
  assert.ok(
    isRecord(response.body) || Array.isArray(response.body),
    `${label} must return a JSON object or array`,
  );
  return response.body;
}

async function remoteObservation(page, projectId, config, inventory) {
  const observation = await ownedApiJson(
    page,
    `/api/projects/${encodeURIComponent(projectId)}/observation`,
    inventory,
    "owned repository observation",
  );
  const snapshot = observation.snapshot;
  assert.equal(observation.state, "fresh", "the owned repository observation must be fresh");
  assert.ok(isRecord(snapshot), "the repository observation must include its snapshot");
  assert.equal(snapshot.repository?.provider, "github");
  assert.equal(String(snapshot.repository?.repositoryId), String(config.repository.id));
  assert.match(snapshot.remoteCommit ?? "", REVISION_PATTERN);
  return snapshot;
}

async function readRemoteScene(page, projectId, sceneId, snapshot, inventory) {
  const query = new URLSearchParams({ view: "remote", snapshot: snapshot.remoteCommit });
  const sceneRead = await ownedApiJson(
    page,
    `/api/projects/${encodeURIComponent(projectId)}/scenes/${encodeURIComponent(sceneId)}?${query}`,
    inventory,
    "pinned remote manuscript",
  );
  assert.equal(sceneRead.snapshot?.remoteCommit, snapshot.remoteCommit);
  assert.equal(sceneRead.scene?.id, sceneId);
  assert.equal(sceneRead.document?.path, OWNED_MANUSCRIPT_PATH);
  assert.equal(typeof sceneRead.document?.content, "string");
  return sceneRead;
}

async function readCodeMirrorText(textbox) {
  return textbox.evaluate((element) => {
    if (
      element.getAttribute("role") !== "textbox" ||
      element.getAttribute("contenteditable") !== "true"
    ) {
      throw new Error("expected the Scriptorium CodeMirror manuscript editor");
    }
    const lines = Array.from(element.children).filter((child) =>
      child.classList.contains("cm-line"),
    );
    if (lines.length === 0 || lines.length !== element.children.length) {
      throw new Error("the manuscript editor has an unexpected CodeMirror line structure");
    }
    return lines.map((line) => line.textContent ?? "").join("\n");
  });
}

function withBoundedBrowserEdit(text, marker) {
  assert.equal(typeof text, "string", "the editor must contain manuscript text");
  assert.ok(
    text.length <= MAX_BROWSER_MANUSCRIPT_CHARS,
    "the owned manuscript exceeds the edit bound",
  );
  const lines = text.split(/\r?\n/u);
  const markerIndexes = lines.flatMap((line, index) =>
    line.startsWith(BROWSER_EDIT_MARKER) ? [index] : [],
  );
  assert.ok(markerIndexes.length <= 1, "the owned manuscript has multiple acceptance marker lines");
  const nextMarker = `${BROWSER_EDIT_MARKER} ${marker}`;
  if (markerIndexes.length === 1) lines[markerIndexes[0]] = nextMarker;
  else lines.push(nextMarker);
  const nextText = lines.join("\n");
  assert.ok(nextText.length <= MAX_BROWSER_MANUSCRIPT_CHARS, "the bounded edit exceeds its limit");
  return nextText;
}

function sceneCount(tree) {
  return (tree?.volumes ?? []).reduce(
    (volumeTotal, volume) =>
      volumeTotal +
      (volume.chapters ?? []).reduce(
        (chapterTotal, chapter) => chapterTotal + (chapter.scenes ?? []).length,
        0,
      ),
    0,
  );
}

test(
  "real Gateway OAuth, repository UI, stopped-origin wake, handoff, and reconfiguration",
  { timeout: 3_600_000 },
  async () => {
    let inputs;
    try {
      inputs = await loadInputs();
    } catch (error) {
      const reasonCode =
        error instanceof GateBlocked && BLOCKED_CODES.has(error.reasonCode)
          ? error.reasonCode
          : "OWNER_INPUT_MISSING";
      await writeRunnerResult("BLOCKED", reasonCode);
      throw new Error(`BLOCKED: ${reasonCode}`);
    }

    const { inventory, config, storageState, derived, executablePath } = inputs;
    let browser;
    let context;
    let callbackServer;
    let callbackOrigin = null;
    let stage = "browser-launch";
    const gatewayRequests = [];
    const instanceRequests = [];
    const handoffPosts = [];
    let ownerWindowExpired = false;
    try {
      try {
        browser = await chromium.launch({ executablePath, headless: true });
      } catch {
        block("BROWSER_UNAVAILABLE");
      }
      context = await browser.newContext({ serviceWorkers: "block", storageState });
      context.setDefaultTimeout(15_000);
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (Date.parse(inventory.environment.expiresAt) <= Date.now()) {
          ownerWindowExpired = true;
          await route.abort("aborted");
          return;
        }
        if (
          url.origin === derived.gatewayOrigin.origin ||
          url.origin === derived.instanceOrigin.origin ||
          url.origin === callbackOrigin ||
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
        const entry = { origin: url.origin, pathname: url.pathname, method: request.method() };
        if (url.origin === derived.gatewayOrigin.origin) gatewayRequests.push(entry);
        if (url.origin === derived.instanceOrigin.origin) {
          instanceRequests.push(entry);
          if (url.pathname === "/_platform/handoff" && request.method() === "POST") {
            const form = new URLSearchParams(request.postData() ?? "");
            const values = form.getAll("code");
            const returnPaths = form.getAll("returnPath");
            handoffPosts.push({
              code: values.length === 1 ? values[0] : null,
              validForm: values.length === 1 && returnPaths.length === 1 && returnPaths[0] === "/",
              referer: request.headers().referer ?? "",
            });
          }
        }
      });

      stage = "gateway-runtime-probe";
      let gatewayHealth;
      try {
        ensureOwnerLifetime(inventory, 10);
        gatewayHealth = await context.request.get(`${derived.gatewayOrigin.origin}/healthz`, {
          timeout: 10_000,
          maxRedirects: 0,
        });
      } catch {
        block("RUNTIME_UNAVAILABLE");
      }
      if (gatewayHealth.status() !== 200) block("RUNTIME_UNAVAILABLE");

      stage = "github-oauth-login";
      context.setDefaultNavigationTimeout(
        ensureOwnerLifetime(inventory, config.timeouts.loginSeconds),
      );
      try {
        ensureOwnerLifetime(inventory, 10);
        await page.goto(`${derived.gatewayOrigin.origin}/`, { waitUntil: "domcontentloaded" });
      } catch {
        block("RUNTIME_UNAVAILABLE");
      }
      const loginDeadline = Date.now() + config.timeouts.loginSeconds * 1000;
      while (Date.now() < loginDeadline) {
        const location = new URL(page.url());
        if (location.origin === derived.gatewayOrigin.origin && location.pathname === "/") break;
        if (location.hostname === "github.com" || location.hostname.endsWith(".github.com")) {
          await delay(1_000);
          continue;
        }
        block("OWNED_ENVIRONMENT_UNAVAILABLE");
      }
      if (
        new URL(page.url()).origin !== derived.gatewayOrigin.origin ||
        new URL(page.url()).pathname !== "/"
      ) {
        block("OWNED_ENVIRONMENT_UNAVAILABLE");
      }
      assert.equal(
        gatewayRequests.filter((request) => request.pathname === "/auth/github/callback").length,
        1,
        "the authenticated Gateway session must be created by its real GitHub OAuth callback",
      );
      ensureOwnerLifetime(inventory, 10);
      const session = await page.evaluate(async () => {
        const response = await fetch("/api/session", { cache: "no-store" });
        return { status: response.status, body: await response.json().catch(() => null) };
      });
      assert.equal(session.status, 200, "OAuth callback must create a usable Gateway session");
      assert.equal(session.body?.userId, config.gateway.expectedUserId);
      const gatewayCookies = await cookiesAt(context, derived.gatewayOrigin.origin);
      const sessionCookie = readCookie(
        gatewayCookies,
        "__Host-praetorium_session",
        derived.gatewayOrigin.hostname,
      );
      const csrfCookie = readCookie(
        gatewayCookies,
        "__Host-praetorium_csrf",
        derived.gatewayOrigin.hostname,
      );
      assert.equal(sessionCookie.path, "/");
      assert.equal(sessionCookie.httpOnly, true);
      assert.equal(csrfCookie.path, "/");
      assert.equal(csrfCookie.httpOnly, false);
      assert.equal(
        gatewayCookies.some((cookie) => cookie.name === "__Host-praetorium_login_nonce"),
        false,
        "OAuth nonce must be cleared after callback",
      );

      stage = "repository-selection";
      const repositoryLink = page.getByRole("link", {
        name: config.repository.fullName,
        exact: true,
      });
      assert.equal(
        await repositoryLink.count(),
        1,
        "the live repository list must show the owned repository",
      );
      // Other authorized repositories can have their own management links.
      // Follow only the link bound to this run's owned repository.
      const manageRepository = repositoryLink;
      const manageUrl = new URL(
        await manageRepository.getAttribute("href"),
        derived.gatewayOrigin.origin,
      );
      assert.equal(manageUrl.pathname, `/repositories/${config.repository.id}`);
      ensureOwnerLifetime(inventory, 10);
      await manageRepository.click();
      await page.waitForURL(
        (url) =>
          url.origin === derived.gatewayOrigin.origin &&
          url.pathname === `/repositories/${config.repository.id}`,
      );

      stage = "repository-and-stopped-dashboard";
      const dashboard = await dashboardSnapshot(page, config, derived.gatewayOrigin, inventory);
      if (dashboard.state !== "Stopped" || !dashboard.currentDigest || !dashboard.desiredDigest) {
        block("OWNED_ENVIRONMENT_UNAVAILABLE");
      }
      const appStatus = page
        .getByRole("heading", { name: "GitHub App", exact: true })
        .locator("xpath=..")
        .locator(".status-badge");
      const accessStatus = page
        .getByRole("heading", { name: "Your repository access", exact: true })
        .locator("xpath=..")
        .locator(".status-badge");
      assert.equal(await appStatus.innerText(), "Active");
      assert.match(await accessStatus.innerText(), /^(Maintain|Admin) access$/u);
      assert.match(
        dashboard.text,
        new RegExp(config.repository.fullName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")),
      );

      const configureForm = page.locator("form").filter({
        has: page.locator('[name="action"][value="configure"]'),
      });
      if (!(await configureForm.count())) block("OWNED_ENVIRONMENT_UNAVAILABLE");
      const initialSelection = await formSelection(configureForm);
      if (
        dashboard.currentDigest !== dashboard.desiredDigest ||
        dashboard.currentModules === null ||
        dashboard.desiredModules === null ||
        !sameStringSet(dashboard.currentModules, dashboard.desiredModules)
      ) {
        block("OWNED_ENVIRONMENT_UNAVAILABLE");
      }
      if (sameStringSet(initialSelection.moduleIds, config.selection.moduleIds)) {
        block("OWNER_INPUT_MISSING");
      }

      stage = "stopped-api-write-no-replay";
      const stoppedBeforeWrite = await dashboardSnapshot(
        page,
        config,
        derived.gatewayOrigin,
        inventory,
      );
      if (stoppedBeforeWrite.state !== "Stopped") block("OWNED_ENVIRONMENT_UNAVAILABLE");
      if ((await cookiesAt(context, derived.instanceOrigin.origin)).length !== 0) {
        block("OWNER_INPUT_MISSING");
      }
      let writeResponse;
      try {
        ensureOwnerLifetime(inventory, 10);
        writeResponse = await context.request.post(
          `${derived.instanceOrigin.origin}${config.writeProbe.path}`,
          {
            data: derived.writeProbeBody,
            headers: {
              Accept: "application/json",
              "Cache-Control": "no-store",
              "Content-Type": "application/json",
              Origin: derived.instanceOrigin.origin,
              "Sec-Fetch-Mode": "cors",
              "Sec-Fetch-Site": "same-origin",
            },
            maxRedirects: 0,
            timeout: 10_000,
          },
        );
      } catch {
        block("RUNTIME_UNAVAILABLE");
      }
      assert.equal(writeResponse.status(), 503, "stopped instance writes must fail closed");
      assert.equal(writeResponse.headers()["retry-after"], "5");
      assert.equal(
        writeResponse.headers()["location"],
        undefined,
        "write must not be redirected or replayed",
      );
      const writeResult = await writeResponse.json().catch(() => null);
      assert.equal(writeResult?.error?.code, "INSTANCE_STARTING");

      stage = "stopped-bookmark-wake-and-handoff";
      context.setDefaultNavigationTimeout(
        ensureOwnerLifetime(inventory, config.timeouts.wakeSeconds),
      );
      const initialHandoffCount = handoffPosts.length;
      try {
        ensureOwnerLifetime(inventory, 10);
        await page.goto(`${derived.instanceOrigin.origin}/`, { waitUntil: "domcontentloaded" });
      } catch {
        block("RUNTIME_UNAVAILABLE");
      }
      await waitForReadyApp(
        page,
        config,
        derived,
        inventory,
        handoffPosts,
        Date.now() + config.timeouts.wakeSeconds * 1000,
      );
      assert.equal(new URL(page.url()).origin, derived.instanceOrigin.origin);
      assert.equal(new URL(page.url()).pathname, "/");
      assert.equal(
        await page
          .getByRole("heading", { name: config.instance.applicationHeading, exact: true })
          .count(),
        1,
      );
      assert.equal(
        handoffPosts.length - initialHandoffCount,
        1,
        "stopped bookmark wake must use one handoff",
      );
      const firstHandoff = handoffPosts.at(-1);
      assert.ok(
        firstHandoff?.validForm && firstHandoff.code,
        "handoff form must carry one one-use code",
      );
      assert.equal(firstHandoff.referer, "", "handoff code must not be sent in a Referer header");
      await verifyApplicationCookies(context, derived);

      ensureOwnerLifetime(inventory, 10);
      const replay = await context.request.post(
        `${derived.instanceOrigin.origin}/_platform/handoff`,
        {
          data: new URLSearchParams({ code: firstHandoff.code, returnPath: "/" }).toString(),
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
            Origin: derived.gatewayOrigin.origin,
          },
          maxRedirects: 0,
          timeout: 10_000,
        },
      );
      assert.equal(replay.status(), 401, "a consumed handoff code must not be reusable");
      assert.equal(
        replay.headers()["set-cookie"],
        undefined,
        "replayed code must not mint application cookies",
      );

      stage = "mcp-read-only-oauth-and-tools-list";
      ensureOwnerLifetime(inventory, config.timeouts.mcpSeconds);
      const callbackPath = `/oauth/callback/${randomBytes(16).toString("hex")}`;
      let resolveCallback;
      const callbackResult = new Promise((resolve) => {
        resolveCallback = resolve;
      });
      callbackServer = createServer((request, response) => {
        if (request.method !== "GET") {
          response.writeHead(405);
          response.end();
          return;
        }
        const callbackUrl = new URL(request.url ?? "/", callbackOrigin ?? "http://127.0.0.1");
        if (callbackUrl.pathname !== callbackPath) {
          response.writeHead(404);
          response.end();
          return;
        }
        const codes = callbackUrl.searchParams.getAll("code");
        const states = callbackUrl.searchParams.getAll("state");
        const issuers = callbackUrl.searchParams.getAll("iss");
        const errors = callbackUrl.searchParams.getAll("error");
        resolveCallback({
          code: codes.length === 1 ? codes[0] : null,
          state: states.length === 1 ? states[0] : null,
          issuer: issuers.length === 1 ? issuers[0] : null,
          error: errors.length <= 1 ? (errors[0] ?? null) : "duplicate_error",
        });
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Type": "text/plain; charset=utf-8",
        });
        response.end("MCP authorization completed. You may close this page.");
      });
      await new Promise((resolve, reject) => {
        callbackServer.once("error", reject);
        callbackServer.listen(0, "127.0.0.1", resolve);
      });
      const callbackAddress = callbackServer.address();
      assert.ok(callbackAddress && typeof callbackAddress === "object");
      callbackOrigin = `http://127.0.0.1:${callbackAddress.port}`;
      const redirectUri = `${callbackOrigin}${callbackPath}`;

      ensureOwnerLifetime(inventory, 10);
      const registrationResponse = await fetch(`${derived.gatewayOrigin.origin}/oauth/register`, {
        method: "POST",
        redirect: "manual",
        signal: ownerBoundSignal(inventory, 10_000),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: config.mcp.clientName,
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code"],
          response_types: ["code"],
        }),
      });
      assert.equal(
        registrationResponse.status,
        201,
        "Gateway must register the ephemeral public MCP client",
      );
      const registration = await registrationResponse.json();
      assert.match(registration.client_id, /^praetorium_cl_[A-Za-z0-9_-]{22}$/u);
      assert.deepEqual(registration.redirect_uris, [redirectUri]);

      const verifier = randomBytes(32).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const oauthState = randomBytes(24).toString("base64url");
      const authorizeUrl = new URL("/oauth/authorize", derived.gatewayOrigin.origin);
      for (const [key, value] of Object.entries({
        response_type: "code",
        client_id: registration.client_id,
        redirect_uri: redirectUri,
        resource: derived.instanceOrigin.origin,
        scope: "read",
        state: oauthState,
        code_challenge: challenge,
        code_challenge_method: "S256",
      })) {
        authorizeUrl.searchParams.set(key, value);
      }
      const mcpPage = await context.newPage();
      mcpPage.setDefaultTimeout(15_000);
      mcpPage.setDefaultNavigationTimeout(
        ensureOwnerLifetime(inventory, config.timeouts.mcpSeconds),
      );
      await mcpPage.goto(authorizeUrl.toString(), { waitUntil: "domcontentloaded" });
      assert.equal(
        await mcpPage.getByRole("heading", { name: "Allow MCP access?", exact: true }).count(),
        1,
        "read-only MCP authorization must use Gateway's real consent screen",
      );
      let callbackTimeout;
      const callbackWait = Promise.race([
        callbackResult,
        new Promise((_, reject) => {
          callbackTimeout = setTimeout(
            () => reject(new Error("MCP authorization callback timed out")),
            config.timeouts.mcpSeconds * 1_000,
          );
        }),
      ]).finally(() => clearTimeout(callbackTimeout));
      ensureOwnerLifetime(inventory, 10);
      await mcpPage.getByRole("button", { name: "Allow", exact: true }).click();
      const authorization = await callbackWait;
      assert.equal(authorization.error, null, "MCP consent must not return an OAuth error");
      assert.equal(authorization.state, oauthState, "OAuth callback must preserve PKCE state");
      assert.equal(authorization.issuer, derived.gatewayOrigin.origin);
      assert.ok(authorization.code, "Gateway consent must issue an authorization code");

      ensureOwnerLifetime(inventory, 10);
      const tokenResponse = await fetch(`${derived.gatewayOrigin.origin}/oauth/token`, {
        method: "POST",
        redirect: "manual",
        signal: ownerBoundSignal(inventory, 10_000),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: registration.client_id,
          code: authorization.code,
          redirect_uri: redirectUri,
          resource: derived.instanceOrigin.origin,
          code_verifier: verifier,
        }),
      });
      assert.equal(
        tokenResponse.status,
        200,
        "PKCE code exchange must issue an instance-scoped token",
      );
      const tokenBody = await tokenResponse.json();
      assert.equal(tokenBody.scope, "read", "MCP access must remain read-only");
      assert.equal(tokenBody.token_type, "Bearer");
      assert.ok(Number.isSafeInteger(tokenBody.expires_in) && tokenBody.expires_in > 0);
      assert.ok(tokenBody.expires_in <= 300);
      assert.ok(safeText(tokenBody.access_token, 16_384));
      assert.ok(safeText(tokenBody.refresh_token, 1_024));
      const accept = "application/json, text/event-stream";
      async function mcpRequest(body, bearerToken, sessionId = null, protocolVersion = null) {
        ensureOwnerLifetime(inventory, 10);
        const headers = {
          Accept: accept,
          "Cache-Control": "no-store",
          "Content-Type": "application/json",
          Authorization: `Bearer ${bearerToken}`,
          ...(sessionId ? { "MCP-Session-Id": sessionId } : {}),
          ...(protocolVersion ? { "MCP-Protocol-Version": protocolVersion } : {}),
        };
        const response = await fetch(`${derived.instanceOrigin.origin}/mcp`, {
          method: "POST",
          redirect: "manual",
          signal: ownerBoundSignal(inventory, 10_000),
          headers,
          body: JSON.stringify(body),
        });
        return {
          status: response.status,
          headers: response.headers,
          body: rpcBodyFromText(await response.text()),
        };
      }
      const invalidCredential = await mcpRequest(
        {
          jsonrpc: "2.0",
          id: 0,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "praetorium-invalid-credential-check", version: "1.0" },
          },
        },
        "invalid-praetorium-t14-credential",
      );
      assert.equal(invalidCredential.status, 401, "invalid MCP bearer credential must fail closed");
      assert.match(invalidCredential.headers.get("www-authenticate") ?? "", /^Bearer\b/iu);

      const initialized = await mcpRequest(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: config.mcp.clientName, version: "1.0" },
          },
        },
        tokenBody.access_token,
      );
      assert.equal(initialized.status, 200, "valid read token must initialize MCP");
      assert.equal(initialized.body?.jsonrpc, "2.0");
      assert.equal(initialized.body?.id, 1);
      assert.equal(initialized.body?.result?.protocolVersion, "2025-03-26");
      const mcpSessionId = initialized.headers.get("mcp-session-id");
      const notification = await mcpRequest(
        { jsonrpc: "2.0", method: "notifications/initialized" },
        tokenBody.access_token,
        mcpSessionId,
        initialized.body.result.protocolVersion,
      );
      assert.ok([200, 202, 204].includes(notification.status));
      const listedTools = await mcpRequest(
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        tokenBody.access_token,
        notification.headers.get("mcp-session-id") ?? mcpSessionId,
        initialized.body.result.protocolVersion,
      );
      assert.equal(listedTools.status, 200, "authorized read token must list MCP tools");
      assert.equal(listedTools.body?.jsonrpc, "2.0");
      assert.equal(listedTools.body?.id, 2);
      assert.ok(Array.isArray(listedTools.body?.result?.tools));
      const toolNames = listedTools.body.result.tools.map((tool) => tool.name);
      for (const requiredTool of config.mcp.requiredTools) {
        assert.ok(toolNames.includes(requiredTool), `MCP tools/list must include ${requiredTool}`);
      }
      await mcpPage.close();
      await new Promise((resolve) => callbackServer.close(resolve));
      callbackServer = null;

      stage = "owned-manuscript-edit-checkpoint-publish-reload";
      context.setDefaultNavigationTimeout(
        ensureOwnerLifetime(inventory, Math.min(30, config.timeouts.configurationSeconds)),
      );
      const projects = await ownedApiJson(page, "/api/projects", inventory, "owned project list");
      assert.ok(
        Array.isArray(projects),
        "the authenticated Scriptorium project list must be an array",
      );
      assert.equal(
        projects.length,
        1,
        "the disposable Scriptorium profile must contain only its owned project",
      );
      const projectId = projects[0]?.id;
      assert.equal(typeof projectId, "string");
      assert.ok(projectId.length > 0);
      const initialManuscriptSnapshot = await remoteObservation(page, projectId, config, inventory);
      const initialTree = await ownedApiJson(
        page,
        `/api/projects/${encodeURIComponent(projectId)}/tree?${new URLSearchParams({ view: "remote", snapshot: initialManuscriptSnapshot.remoteCommit })}`,
        inventory,
        "pinned owned repository tree",
      );
      assert.equal(initialTree.snapshot?.remoteCommit, initialManuscriptSnapshot.remoteCommit);
      assert.equal(
        sceneCount(initialTree.tree),
        1,
        "the owned repository must contain one editable scene",
      );
      const ownedScene = initialTree.tree.volumes[0].chapters[0].scenes[0];
      assert.ok(ownedScene?.id);
      const initialSceneRead = await readRemoteScene(
        page,
        projectId,
        ownedScene.id,
        initialManuscriptSnapshot,
        inventory,
      );
      const sceneButtons = page
        .getByRole("navigation", { name: "作品構成" })
        .locator("button.scene-button");
      assert.equal(
        await sceneButtons.count(),
        1,
        "the editor must expose only the owned synthetic scene",
      );
      ensureOwnerLifetime(inventory, 5);
      await sceneButtons.first().click();
      const editor = page.locator('section[aria-label="原稿エディター"]');
      await editor.waitFor({ state: "visible" });
      const manuscript = editor.getByRole("textbox", { name: "原稿 Markdown", exact: true });
      await manuscript.waitFor({ state: "visible" });
      const initialEditorText = await readCodeMirrorText(manuscript);
      assert.equal(
        initialEditorText,
        initialSceneRead.scene.text,
        "the editor must show the selected scene from the pinned owned remote snapshot",
      );
      const editMarkerValue = crypto.randomUUID();
      const editMarker = `${BROWSER_EDIT_MARKER} ${editMarkerValue}`;
      await manuscript.fill(withBoundedBrowserEdit(initialEditorText, editMarkerValue));
      const checkpointButton = editor.getByRole("button", { name: "Checkpoint", exact: true });
      const draftDeadline = Date.now() + 15_000;
      while (!(await checkpointButton.isEnabled()) && Date.now() < draftDeadline) await delay(100);
      assert.equal(
        await checkpointButton.isEnabled(),
        true,
        "Checkpoint must become available only after the browser draft is durable",
      );
      ensureOwnerLifetime(inventory, 10);
      await checkpointButton.click();
      await page
        .locator('p.durability-message[role="status"]')
        .getByText(
          "ローカルチェックポイントを作成しました。GitHub へ保存するまでブラウザーの回復記録を保持します。",
          { exact: true },
        )
        .waitFor({ state: "visible" });
      const publishButton = editor.getByRole("button", { name: "Save to GitHub", exact: true });
      await publishButton.waitFor({ state: "visible" });
      assert.equal(
        await publishButton.isEnabled(),
        true,
        "a local checkpoint must enable GitHub publication",
      );
      const publishPath = `/api/projects/${encodeURIComponent(projectId)}/publish`;
      const publishResponsePromise = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.origin === new URL(page.url()).origin &&
          url.pathname === publishPath &&
          response.request().method() === "POST"
        );
      });
      ensureOwnerLifetime(inventory, 10);
      await publishButton.click();
      const publishResponse = await publishResponsePromise;
      assert.equal(
        publishResponse.status(),
        200,
        "the UI must publish the checkpoint through Scriptorium",
      );
      const publishReceipt = await publishResponse.json();
      assert.equal(publishReceipt.state, "confirmed", "GitHub publication must be confirmed");
      assert.match(publishReceipt.remoteCommit ?? "", REVISION_PATTERN);
      const acknowledgedPaths = (publishReceipt.acknowledged ?? []).flatMap((item) =>
        (item.revisions ?? []).map((revision) => revision.path),
      );
      assert.deepEqual(
        [...new Set(acknowledgedPaths)].sort(),
        [OWNED_MANUSCRIPT_PATH],
        "the confirmed publication must acknowledge only the owned manuscript path",
      );
      await page
        .locator('p.durability-message[role="status"]')
        .getByText("GitHub への保存を確認しました。確認済みの操作だけ回復記録から削除しました。", {
          exact: true,
        })
        .waitFor({ state: "visible" });
      const publishedBadge = editor
        .locator(".durability-badge.is-current")
        .filter({ hasText: "Saved to GitHub" });
      await publishedBadge.waitFor({ state: "visible" });

      const publishDeadline = Date.now() + config.timeouts.configurationSeconds * 1_000;
      let publishedSnapshot;
      while (Date.now() < publishDeadline) {
        const observed = await remoteObservation(page, projectId, config, inventory);
        if (observed.remoteCommit === publishReceipt.remoteCommit) {
          publishedSnapshot = observed;
          break;
        }
        await delay(1_000);
      }
      assert.ok(
        publishedSnapshot,
        "the public repository head must match the confirmed publication receipt",
      );
      const publishedSceneRead = await readRemoteScene(
        page,
        projectId,
        ownedScene.id,
        publishedSnapshot,
        inventory,
      );
      assert.ok(publishedSceneRead.document.content.includes(editMarker));
      assert.equal(publishedSceneRead.document.path, OWNED_MANUSCRIPT_PATH);

      ensureOwnerLifetime(inventory, 10);
      const reloaded = await page.reload({ waitUntil: "domcontentloaded" });
      assert.equal(
        reloaded?.status(),
        200,
        "the connected Scriptorium application must reload successfully",
      );
      assert.equal(new URL(page.url()).origin, derived.instanceOrigin.origin);
      assert.equal(new URL(page.url()).pathname, "/");
      await page
        .getByRole("heading", { name: config.instance.applicationHeading, exact: true })
        .waitFor();
      const reloadedSceneButtons = page
        .getByRole("navigation", { name: "作品構成" })
        .locator("button.scene-button");
      assert.equal(await reloadedSceneButtons.count(), 1);
      ensureOwnerLifetime(inventory, 5);
      await reloadedSceneButtons.first().click();
      const reloadedEditor = page.locator('section[aria-label="原稿エディター"]');
      const reloadedManuscript = reloadedEditor.getByRole("textbox", {
        name: "原稿 Markdown",
        exact: true,
      });
      await reloadedManuscript.waitFor({ state: "visible" });
      assert.ok((await readCodeMirrorText(reloadedManuscript)).includes(editMarker));
      await reloadedEditor
        .locator(".durability-badge.is-current")
        .filter({ hasText: "Saved to GitHub" })
        .waitFor({ state: "visible" });
      const afterReloadSnapshot = await remoteObservation(page, projectId, config, inventory);
      assert.equal(afterReloadSnapshot.remoteCommit, publishReceipt.remoteCommit);
      const afterReloadScene = await readRemoteScene(
        page,
        projectId,
        ownedScene.id,
        afterReloadSnapshot,
        inventory,
      );
      assert.ok(afterReloadScene.document.content.includes(editMarker));

      stage = "ui-selection-preview";
      context.setDefaultNavigationTimeout(
        ensureOwnerLifetime(inventory, Math.min(30, config.timeouts.configurationSeconds)),
      );
      await dashboardSnapshot(page, config, derived.gatewayOrigin, inventory);
      const previewButton = page.getByRole("button", { name: "Preview selection", exact: true });
      const previewForm = previewButton.locator("xpath=ancestor::form");
      await previewForm
        .locator('select[name="releasePolicy"]')
        .selectOption(config.selection.releasePolicy);
      await previewForm
        .locator('select[name="releaseId"]')
        .selectOption(config.selection.releaseId);
      const moduleInputs = previewForm.locator('input[type="checkbox"][name="moduleIds"]');
      const selectedModules = new Set(config.selection.moduleIds);
      const availableModules = new Set();
      for (let index = 0; index < (await moduleInputs.count()); index += 1) {
        const checkbox = moduleInputs.nth(index);
        const moduleId = await checkbox.getAttribute("value");
        assert.ok(moduleId, "module selection checkboxes must carry their module IDs");
        availableModules.add(moduleId);
        if (selectedModules.has(moduleId) && !(await checkbox.isChecked())) {
          await checkbox.check();
        } else if (!selectedModules.has(moduleId) && (await checkbox.isChecked())) {
          await checkbox.uncheck();
        }
      }
      assert.deepEqual(
        [...availableModules].filter((moduleId) => selectedModules.has(moduleId)).sort(),
        [...selectedModules].sort(),
        "the configured module selection must be represented by the UI checkboxes",
      );
      await previewForm
        .locator('select[name="resourceProfileId"]')
        .selectOption(config.selection.resourceProfileId);
      ensureOwnerLifetime(inventory, Math.min(30, config.timeouts.configurationSeconds));
      await previewButton.click();
      await page.getByText("Supported module configuration", { exact: true }).waitFor();
      const previewStatus = page.locator(
        'section[aria-labelledby="module-preview"] [role="status"]',
      );
      const previewText = await previewStatus.innerText();
      assert.ok(previewText.includes("Requested modules:"));
      const previewedForm = page.locator("form").filter({
        has: page.locator('[name="action"][value="configure"]'),
      });
      assert.equal(await previewedForm.count(), 1);
      assert.ok(sameSelection(await formSelection(previewedForm), config.selection));

      stage = "ui-reconfigure-build-and-preservation";
      const actionPath = `/repositories/${config.repository.id}/actions`;
      context.setDefaultNavigationTimeout(
        ensureOwnerLifetime(inventory, config.timeouts.configurationSeconds),
      );
      const saveResponsePromise = page.waitForResponse(
        (response) =>
          response.url().startsWith(`${derived.gatewayOrigin.origin}${actionPath}`) &&
          response.request().method() === "POST",
      );
      ensureOwnerLifetime(inventory, 10);
      await page.getByRole("button", { name: "Save configuration and build", exact: true }).click();
      const saveResponse = await saveResponsePromise;
      assert.equal(saveResponse.status(), 202, "UI configuration must queue the build");
      const pendingBuild = await dashboardSnapshot(page, config, derived.gatewayOrigin, inventory);
      assert.equal(
        pendingBuild.currentDigest,
        dashboard.currentDigest,
        "the old deployment must still be current before replacement finishes",
      );
      assert.equal(
        pendingBuild.state,
        "Ready",
        "the current runtime must remain ready during the build",
      );
      assert.ok(
        ["Reserved", "Queued", "Claimed", "Building", "Verifying artifact"].includes(
          pendingBuild.buildState,
        ),
        "the old runtime must be observed while the replacement build is active",
      );
      context.setDefaultNavigationTimeout(ensureOwnerLifetime(inventory, 10));
      let duringBuild;
      try {
        duringBuild = await page.goto(`${derived.instanceOrigin.origin}/`, {
          waitUntil: "domcontentloaded",
        });
      } catch {
        block("RUNTIME_UNAVAILABLE");
      }
      if (duringBuild?.status() === 503) block("RUNTIME_UNAVAILABLE");
      assert.equal(
        duringBuild?.status(),
        200,
        "current application must remain reachable during a new build",
      );
      await page
        .getByRole("heading", { name: config.instance.applicationHeading, exact: true })
        .waitFor();
      const afterAppGet = await dashboardSnapshot(page, config, derived.gatewayOrigin, inventory);
      assert.equal(
        afterAppGet.currentDigest,
        dashboard.currentDigest,
        "the stable application GET must finish while the old deployment remains current",
      );
      assert.equal(
        afterAppGet.state,
        "Ready",
        "the current runtime must remain ready through the application GET",
      );
      assert.ok(
        ["Reserved", "Queued", "Claimed", "Building", "Verifying artifact"].includes(
          afterAppGet.buildState,
        ),
        "the stable application GET must be bracketed by observations of the active build",
      );
      const configured = await waitForDeployment(
        page,
        config,
        derived,
        inventory,
        config.selection.moduleIds,
        Date.now() + config.timeouts.configurationSeconds * 1000,
      );
      assert.notEqual(
        configured.currentDigest,
        dashboard.currentDigest,
        "a distinct composition must produce a new digest",
      );
      const configuredDigest = configured.currentDigest;

      stage = "ui-same-image-redeploy";
      context.setDefaultNavigationTimeout(
        ensureOwnerLifetime(inventory, config.timeouts.redeploySeconds),
      );
      await page
        .getByRole("button", { name: "Redeploy current configuration", exact: true })
        .waitFor();
      const redeployResponsePromise = page.waitForResponse(
        (response) =>
          response.url().startsWith(`${derived.gatewayOrigin.origin}${actionPath}`) &&
          response.request().method() === "POST",
      );
      ensureOwnerLifetime(inventory, config.timeouts.redeploySeconds);
      await page
        .getByRole("button", { name: "Redeploy current configuration", exact: true })
        .click();
      const redeployResponse = await redeployResponsePromise;
      assert.equal(redeployResponse.status(), 202, "same-image redeploy must be accepted");
      let redeployed;
      const redeployDeadline = Date.now() + config.timeouts.redeploySeconds * 1000;
      while (Date.now() < redeployDeadline) {
        redeployed = await dashboardSnapshot(page, config, derived.gatewayOrigin, inventory);
        if (redeployed.redeployState === "Complete" && redeployed.state === "Ready") break;
        if (["Failed", "Blocked"].includes(redeployed.redeployState)) {
          assert.fail("same-image redeploy failed");
        }
        await delay(2_000);
      }
      assert.ok(
        redeployed && redeployed.redeployState === "Complete",
        "redeploy operation must complete",
      );
      assert.equal(redeployed.state, "Ready");
      assert.equal(
        redeployed.currentDigest,
        configuredDigest,
        "same-image redeploy must preserve the image digest",
      );

      stage = "ui-entry-after-redeploy";
      context.setDefaultNavigationTimeout(
        ensureOwnerLifetime(inventory, config.timeouts.redeploySeconds),
      );
      await page.getByRole("button", { name: "Open application", exact: true }).waitFor();
      ensureOwnerLifetime(inventory, config.timeouts.redeploySeconds);
      const handoffCountBeforeUiEntry = handoffPosts.length;
      await page.getByRole("button", { name: "Open application", exact: true }).click();
      await waitForReadyApp(
        page,
        config,
        derived,
        inventory,
        handoffPosts,
        Date.now() + config.timeouts.redeploySeconds * 1000,
      );
      assert.equal(
        handoffPosts.length - handoffCountBeforeUiEntry,
        1,
        "UI entry must mint one handoff",
      );
      assert.equal(
        new URL(page.url()).origin,
        derived.instanceOrigin.origin,
        "reconfiguration must keep the stable origin",
      );
      await verifyApplicationCookies(context, derived);

      stage = "instance-access-csrf-refresh";
      const csrfBefore = (await cookiesAt(context, derived.instanceOrigin.origin)).find(
        (cookie) => cookie.name === "__Host-praetorium_csrf",
      );
      assert.ok(csrfBefore && !csrfBefore.httpOnly);
      ensureOwnerLifetime(inventory, 10);
      const invalidRefresh = await page.evaluate(async () => {
        const response = await fetch("/_platform/refresh", {
          method: "POST",
          headers: { "X-CSRF-Token": "invalid-t14-csrf" },
          redirect: "manual",
        });
        return { status: response.status, body: await response.json().catch(() => null) };
      });
      assert.equal(invalidRefresh.status, 403, "invalid-CSRF refresh must fail");
      assert.equal(invalidRefresh.body?.error?.code, "CSRF_INVALID");
      const beforeRefresh = (await cookiesAt(context, derived.instanceOrigin.origin)).find(
        (cookie) => cookie.name === "__Host-praetorium_access",
      )?.value;
      ensureOwnerLifetime(inventory, 10);
      const validRefresh = await page.evaluate(async () => {
        const csrf = globalThis.document.cookie
          .split(";")
          .map((part) => part.trim())
          .find((part) => part.startsWith("__Host-praetorium_csrf="))
          ?.slice("__Host-praetorium_csrf=".length);
        const response = await fetch("/_platform/refresh", {
          method: "POST",
          headers: { "X-CSRF-Token": csrf ?? "" },
          redirect: "manual",
        });
        return { status: response.status, location: response.headers.get("location") };
      });
      assert.equal(validRefresh.status, 303, "valid same-origin CSRF refresh must rotate access");
      assert.equal(validRefresh.location, "/");
      const afterRefreshCookies = await cookiesAt(context, derived.instanceOrigin.origin);
      assert.ok(
        afterRefreshCookies.find((cookie) => cookie.name === "__Host-praetorium_access")?.value !==
          beforeRefresh,
        "refresh must replace the short-lived access cookie",
      );
      assert.equal(
        handoffPosts.some((handoff) => handoff.code?.includes("=")),
        false,
      );
      assert.equal(
        instanceRequests.some(
          (request) => request.pathname === "/_platform/handoff" && request.method === "GET",
        ),
        false,
      );
    } catch (error) {
      const reasonCode =
        error instanceof GateBlocked && BLOCKED_CODES.has(error.reasonCode)
          ? error.reasonCode
          : ownerWindowExpired || Date.parse(inventory.environment.expiresAt) <= Date.now()
            ? "INSUFFICIENT_LIFETIME"
            : "ACCEPTANCE_ASSERTION_FAILED";
      await writeRunnerResult(
        reasonCode === "ACCEPTANCE_ASSERTION_FAILED" ? "FAILED" : "BLOCKED",
        reasonCode,
      );
      throw new Error(`${reasonCode}: ${stage}`);
    } finally {
      if (callbackServer)
        await new Promise((resolve) => callbackServer.close(resolve)).catch(() => {});
      await context?.close().catch(() => {});
      await browser?.close().catch(() => {});
    }
  },
);
