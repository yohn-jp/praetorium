import assert from "node:assert/strict";
import { constants as fsConstants } from "node:fs";
import {
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
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateInventory } from "../../scripts/verify-integration.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MAX_OWNER_FILE_BYTES = 64 * 1024;
const MAX_HTTP_BYTES = 16 * 1024;
const HTTP_TIMEOUT_MS = 12_000;
const GIT_TIMEOUT_MS = 30_000;
const MAX_INSTALLATION_TOKEN_MS = 3_605_000;
const CLEANUP_MARGIN_MS = 300_000;
const MINIMUM_LIFETIME_MS = MAX_INSTALLATION_TOKEN_MS + CLEANUP_MARGIN_MS;
const RUNNER_TIMEOUT_MS = 4_000_000;
const INVENTORY_ENV = "PRAETORIUM_T14_INVENTORY_PATH";
const RESULT_ENV = "PRAETORIUM_T14_RESULT_PATH";
const ACCESS_CONFIG_SUFFIX = ".github-access.json";
const RUNTIME_CONFIG_SUFFIX = ".github-access-runtime.json";
const RUNNER_REASON_CODES = Object.freeze({
  OWNER_INPUT_MISSING: "BLOCKED",
  OWNED_ENVIRONMENT_UNAVAILABLE: "BLOCKED",
  PRODUCER_CONTRACT_MISSING: "BLOCKED",
  RUNTIME_UNAVAILABLE: "BLOCKED",
  INSUFFICIENT_LIFETIME: "BLOCKED",
  ACCEPTANCE_ASSERTION_FAILED: "FAILED",
});

class BlockedError extends Error {
  constructor(reasonCode) {
    super(reasonCode);
    this.name = "BlockedError";
    this.reasonCode = reasonCode;
  }
}

function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value, keys) {
  return object(value) && Object.keys(value).every((key) => keys.includes(key));
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function boundedText(value, maxLength) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function hasAsciiControlCharacters(value) {
  return [...value].some((character) => {
    const point = character.codePointAt(0);
    return point < 0x20 || point === 0x7f;
  });
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

function validRepository(value) {
  return (
    hasOnlyKeys(value, ["id", "owner", "name"]) &&
    positiveInteger(value.id) &&
    typeof value.owner === "string" &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(value.owner) &&
    typeof value.name === "string" &&
    /^[A-Za-z0-9_.-]{1,100}$/.test(value.name)
  );
}

function validUser(value) {
  const cookiePairs =
    typeof value?.sessionCookie === "string"
      ? value.sessionCookie.split(";").map((part) => part.trim())
      : [];
  const cookieNames = cookiePairs.map((part) => part.slice(0, part.indexOf("=")));
  return (
    hasOnlyKeys(value, ["expectedUserId", "sessionCookie", "csrfToken", "accessToken"]) &&
    typeof value.expectedUserId === "string" &&
    /^[1-9][0-9]{0,15}$/.test(value.expectedUserId) &&
    typeof value.sessionCookie === "string" &&
    value.sessionCookie.length <= 4096 &&
    !hasAsciiControlCharacters(value.sessionCookie) &&
    cookiePairs.length === 2 &&
    cookieNames.includes("__Host-praetorium_session") &&
    cookieNames.includes("__Host-praetorium_csrf") &&
    new Set(cookieNames).size === 2 &&
    /(?:^|;\s*)__Host-praetorium_session=[^;]+/.test(value.sessionCookie) &&
    /(?:^|;\s*)__Host-praetorium_csrf=[^;]+/.test(value.sessionCookie) &&
    typeof value.csrfToken === "string" &&
    /^[A-Za-z0-9_-]{16,512}$/.test(value.csrfToken) &&
    value.sessionCookie.includes(`__Host-praetorium_csrf=${value.csrfToken}`) &&
    typeof value.accessToken === "string" &&
    value.accessToken.length >= 20 &&
    value.accessToken.length <= 4096 &&
    !hasAsciiControlCharacters(value.accessToken) &&
    !value.accessToken.includes(" ")
  );
}

function validPrimaryConfig(value) {
  return (
    hasOnlyKeys(value, [
      "schemaVersion",
      "inventoryPath",
      "ownerIdentity",
      "environment",
      "gateway",
      "controlPlane",
      "github",
    ]) &&
    value.schemaVersion === 1 &&
    typeof value.inventoryPath === "string" &&
    path.isAbsolute(value.inventoryPath) &&
    typeof value.ownerIdentity === "string" &&
    value.ownerIdentity.trim().length >= 2 &&
    hasOnlyKeys(value.environment, [
      "name",
      "expiresAt",
      "cleanupProcedure",
      "privateDisposable",
      "production",
      "resourceReference",
    ]) &&
    boundedText(value.environment.name, 256) &&
    value.environment.privateDisposable === true &&
    value.environment.production === false &&
    boundedText(value.environment.cleanupProcedure, 1024) &&
    boundedText(value.environment.resourceReference, 1024) &&
    typeof value.environment.expiresAt === "string" &&
    Number.isFinite(Date.parse(value.environment.expiresAt)) &&
    Date.parse(value.environment.expiresAt) > Date.now() &&
    hasOnlyKeys(value.gateway, ["origin", "writer", "reader"]) &&
    exactHttpsOrigin(value.gateway.origin) &&
    validUser(value.gateway.writer) &&
    validUser(value.gateway.reader) &&
    value.gateway.writer.expectedUserId !== value.gateway.reader.expectedUserId &&
    hasOnlyKeys(value.controlPlane, ["origin", "gatewayAuth"]) &&
    exactHttpsOrigin(value.controlPlane.origin) &&
    typeof value.controlPlane.gatewayAuth === "string" &&
    /^[\x21-\x7e]{32,4096}$/.test(value.controlPlane.gatewayAuth) &&
    hasOnlyKeys(value.github, [
      "appId",
      "installationId",
      "privateKeyPem",
      "repository",
      "unrelatedRepository",
    ]) &&
    positiveInteger(value.github.appId) &&
    positiveInteger(value.github.installationId) &&
    typeof value.github.privateKeyPem === "string" &&
    value.github.privateKeyPem.length >= 100 &&
    value.github.privateKeyPem.length <= 16_384 &&
    /^-----BEGIN (RSA )?PRIVATE KEY-----[\s\S]+-----END \1PRIVATE KEY-----$/.test(
      value.github.privateKeyPem.trim(),
    ) &&
    validRepository(value.github.repository) &&
    validRepository(value.github.unrelatedRepository) &&
    value.github.repository.id !== value.github.unrelatedRepository.id
  );
}

function validRuntimeConfig(value) {
  return (
    hasOnlyKeys(value, [
      "schemaVersion",
      "inventoryPath",
      "ownerIdentity",
      "environment",
      "runtimeRepository",
      "runtime",
      "provisionerAuth",
    ]) &&
    value.schemaVersion === 1 &&
    typeof value.inventoryPath === "string" &&
    path.isAbsolute(value.inventoryPath) &&
    typeof value.ownerIdentity === "string" &&
    value.ownerIdentity.trim().length >= 2 &&
    hasOnlyKeys(value.environment, ["expiresAt", "resourceReference"]) &&
    typeof value.environment.expiresAt === "string" &&
    Number.isFinite(Date.parse(value.environment.expiresAt)) &&
    Date.parse(value.environment.expiresAt) > Date.now() &&
    boundedText(value.environment.resourceReference, 1024) &&
    validRepository(value.runtimeRepository) &&
    hasOnlyKeys(value.runtime, [
      "runtimeId",
      "instanceId",
      "repositoryId",
      "installationId",
      "runtimeEpoch",
      "leaseId",
      "workerId",
      "clusterId",
    ]) &&
    boundedText(value.runtime.runtimeId, 128) &&
    boundedText(value.runtime.instanceId, 128) &&
    positiveInteger(value.runtime.repositoryId) &&
    positiveInteger(value.runtime.installationId) &&
    positiveInteger(value.runtime.runtimeEpoch) &&
    boundedText(value.runtime.leaseId, 128) &&
    /^[A-Za-z0-9_.:-]{1,128}$/.test(value.runtime.workerId ?? "") &&
    /^[A-Za-z0-9_.:-]{1,128}$/.test(value.runtime.clusterId ?? "") &&
    typeof value.provisionerAuth === "string" &&
    /^[\x21-\x7e]{32,4096}$/.test(value.provisionerAuth)
  );
}

function credentialsSeparated(primary, runtime) {
  const credentials = [
    primary.controlPlane.gatewayAuth,
    primary.github.privateKeyPem,
    primary.gateway.writer.accessToken,
    primary.gateway.reader.accessToken,
    runtime.provisionerAuth,
  ];
  return new Set(credentials).size === credentials.length;
}

test("fixed GitHub owner configuration rejects extra fields and unbound runtime inputs", () => {
  const writer = {
    expectedUserId: "10001",
    sessionCookie:
      "__Host-praetorium_session=session-value; __Host-praetorium_csrf=abcdefghijklmnop",
    csrfToken: "abcdefghijklmnop",
    accessToken: `gho_${"a".repeat(32)}`,
  };
  const primary = {
    schemaVersion: 1,
    inventoryPath: "/tmp/t14-inventory.json",
    ownerIdentity: "owner uid=1000",
    environment: {
      name: "owned-disposable-github-test",
      expiresAt: "2099-01-01T00:00:00Z",
      cleanupProcedure: "Destroy the disposable test bindings after expiry.",
      privateDisposable: true,
      production: false,
      resourceReference: "owned-app-and-test-repositories",
    },
    gateway: {
      origin: "https://gateway.test.invalid",
      writer,
      reader: {
        ...writer,
        expectedUserId: "10002",
        accessToken: `gho_${"b".repeat(32)}`,
      },
    },
    controlPlane: {
      origin: "https://control-plane.test.invalid",
      gatewayAuth: "x".repeat(40),
    },
    github: {
      appId: 1001,
      installationId: 2001,
      privateKeyPem: `-----BEGIN PRIVATE KEY-----\n${"A".repeat(100)}\n-----END PRIVATE KEY-----`,
      repository: { id: 3001, owner: "owned-org", name: "target" },
      unrelatedRepository: { id: 3002, owner: "owned-org", name: "sibling" },
    },
  };
  const runtime = {
    schemaVersion: 1,
    inventoryPath: primary.inventoryPath,
    ownerIdentity: primary.ownerIdentity,
    environment: {
      expiresAt: primary.environment.expiresAt,
      resourceReference: primary.environment.resourceReference,
    },
    runtimeRepository: { id: 3003, owner: "owned-org", name: "runtime" },
    runtime: {
      runtimeId: "runtime-owned-01",
      instanceId: "ins_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      repositoryId: 3003,
      installationId: 2001,
      runtimeEpoch: 1,
      leaseId: "lease-owned-01",
      workerId: "worker-owned-01",
      clusterId: "cluster-owned-01",
    },
    provisionerAuth: "p".repeat(40),
  };
  assert.equal(validPrimaryConfig(primary), true);
  assert.equal(validRuntimeConfig(runtime), true);
  assert.equal(credentialsSeparated(primary, runtime), true);
  assert.equal(validPrimaryConfig({ ...primary, unexpected: true }), false);
  assert.equal(validRuntimeConfig({ ...runtime, leaseToken: "unbound" }), false);
  assert.equal(
    validRuntimeConfig({ ...runtime, runtime: { ...runtime.runtime, repositoryId: 3001 } }),
    true,
    "the runtime config parser validates shape; cross-file repository binding is checked during load",
  );
  assert.equal(
    credentialsSeparated(primary, {
      ...runtime,
      provisionerAuth: primary.controlPlane.gatewayAuth,
    }),
    false,
    "Control Plane Gateway and provisioner service credentials are distinct authorities",
  );
});

test("fixed GitHub owner file reads reject symlinks and writable private configs", async (t) => {
  if (
    typeof process.getuid !== "function" ||
    !Number.isInteger(fsConstants.O_NOFOLLOW) ||
    !Number.isInteger(fsConstants.O_NONBLOCK)
  )
    return t.skip("secure owner-file verification requires POSIX UID and O_NOFOLLOW support");

  const directory = await mkdtemp(path.join(os.tmpdir(), "praetorium-t14-github-fixed-owner-"));
  try {
    const configPath = path.join(directory, "owner.json");
    await writeFile(configPath, '{"owned":true}', { mode: 0o600 });
    await chmod(configPath, 0o600);
    assert.equal(
      (await readOwnedFile(configPath, { privateFile: true, maximumBytes: 64 })).toString("utf8"),
      '{"owned":true}',
    );
    const alias = path.join(directory, "owner-link.json");
    await (await import("node:fs/promises")).symlink(configPath, alias);
    await assert.rejects(
      readOwnedFile(alias, { privateFile: true, maximumBytes: 64 }),
      (error) => error instanceof BlockedError,
    );
    await chmod(configPath, 0o644);
    await assert.rejects(
      readOwnedFile(configPath, { privateFile: true, maximumBytes: 64 }),
      (error) => error instanceof BlockedError,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function readOwnedFile(filePath, { privateFile, maximumBytes }) {
  if (
    typeof process.getuid !== "function" ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    !Number.isInteger(fsConstants.O_NOFOLLOW) ||
    !Number.isInteger(fsConstants.O_NONBLOCK)
  )
    throw new BlockedError("OWNED_ENVIRONMENT_UNAVAILABLE");

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
      (privateFile ? (before.mode & 0o077) !== 0 : (before.mode & 0o022) !== 0) ||
      before.size > maximumBytes
    )
      throw new BlockedError("OWNED_ENVIRONMENT_UNAVAILABLE");

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
      after.uid !== uid ||
      (privateFile ? (after.mode & 0o077) !== 0 : (after.mode & 0o022) !== 0)
    )
      throw new BlockedError("OWNED_ENVIRONMENT_UNAVAILABLE");
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

function environmentExpiry(inventory, primary, runtime) {
  return Math.min(
    Date.parse(inventory.environment.expiresAt),
    Date.parse(primary.environment.expiresAt),
    Date.parse(runtime.environment.expiresAt),
  );
}

async function loadOwnedInputs() {
  const rawInventoryPath = process.env[INVENTORY_ENV];
  if (!rawInventoryPath || !path.isAbsolute(rawInventoryPath))
    throw new BlockedError("OWNER_INPUT_MISSING");
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
  if (
    validation.errors.length > 0 ||
    inventory.resources?.["github-access"]?.state !== "available" ||
    inventory.resources["github-access"].owner !== inventory.owner?.identity ||
    inventory.resources["github-access"].disposable !== true ||
    inventory.resources["github-access"].production !== false
  )
    throw new BlockedError("OWNED_ENVIRONMENT_UNAVAILABLE");

  const accessConfigPath = `${inventoryPath}${ACCESS_CONFIG_SUFFIX}`;
  const runtimeConfigPath = `${inventoryPath}${RUNTIME_CONFIG_SUFFIX}`;
  let primary;
  try {
    primary = await readOwnedJson(accessConfigPath, {
      privateFile: true,
      maximumBytes: MAX_OWNER_FILE_BYTES,
    });
  } catch (error) {
    if (error instanceof BlockedError) throw error;
    throw new BlockedError("OWNER_INPUT_MISSING");
  }
  let runtime;
  try {
    runtime = await readOwnedJson(runtimeConfigPath, {
      privateFile: true,
      maximumBytes: MAX_OWNER_FILE_BYTES,
    });
  } catch (error) {
    if (error instanceof BlockedError) throw error;
    throw new BlockedError("RUNTIME_UNAVAILABLE");
  }
  if (
    !validPrimaryConfig(primary) ||
    !validRuntimeConfig(runtime) ||
    primary.inventoryPath !== inventoryPath ||
    runtime.inventoryPath !== inventoryPath ||
    primary.ownerIdentity !== inventory.owner.identity ||
    runtime.ownerIdentity !== inventory.owner.identity ||
    primary.environment.resourceReference !== inventory.resources["github-access"].reference ||
    runtime.environment.resourceReference !== inventory.resources["github-access"].reference ||
    Date.parse(runtime.environment.expiresAt) > Date.parse(primary.environment.expiresAt) ||
    runtime.runtime.repositoryId !== runtime.runtimeRepository.id ||
    runtime.runtime.installationId !== primary.github.installationId ||
    !credentialsSeparated(primary, runtime) ||
    runtime.runtimeRepository.id === primary.github.repository.id ||
    runtime.runtimeRepository.id === primary.github.unrelatedRepository.id
  )
    throw new BlockedError("OWNED_ENVIRONMENT_UNAVAILABLE");

  const effectiveExpiresAt = environmentExpiry(inventory, primary, runtime);
  if (effectiveExpiresAt - Date.now() < MINIMUM_LIFETIME_MS)
    throw new BlockedError("INSUFFICIENT_LIFETIME");
  return { inventoryPath, primary, runtime, effectiveExpiresAt };
}

async function writeRunnerResult(status, reasonCode) {
  if (!Object.hasOwn(RUNNER_REASON_CODES, reasonCode) || RUNNER_REASON_CODES[reasonCode] !== status)
    throw new Error("invalid fixed-runner outcome code");
  const resultPath = process.env[RESULT_ENV];
  if (!resultPath) return;
  const home = process.env.HOME;
  if (!home || !path.isAbsolute(resultPath)) throw new Error("invalid fixed-runner result path");
  const resolvedHome = path.resolve(home);
  const resolvedResult = path.resolve(resultPath);
  if (
    path.dirname(resolvedResult) !== resolvedHome ||
    path.basename(resolvedResult) !== "runner-result.json"
  )
    throw new Error("fixed-runner result path escaped its isolated home");
  let handle;
  try {
    handle = await open(
      resolvedResult,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(
      JSON.stringify({ reportVersion: 1, category: "github-access", status, reasonCode }),
    );
  } finally {
    await handle?.close();
  }
}

function blockedTest(reasonCode) {
  test("T14 GitHub access acceptance is BLOCKED by an unverified prerequisite", () => {
    assert.fail(`BLOCKED: ${reasonCode}`);
  });
}

async function boundedJson(response, message) {
  assert.equal(response.redirected, false, `${message}: redirects are rejected`);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/i, message);
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    assert.match(declaredLength, /^(0|[1-9][0-9]*)$/);
    assert.ok(Number(declaredLength) <= MAX_HTTP_BYTES, `${message}: response is too large`);
  }
  const reader = response.body?.getReader();
  assert.ok(reader, `${message}: response body is missing`);
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      assert.ok(size <= MAX_HTTP_BYTES, `${message}: response is too large`);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } catch {
    assert.fail(`${message}: body is not valid JSON`);
  }
}

function ensureBeforeExpiry(expiresAt) {
  if (!Number.isSafeInteger(expiresAt) || Date.now() >= expiresAt)
    throw new BlockedError("INSUFFICIENT_LIFETIME");
}

async function requestJson(url, init, { expiresAt, publicPrerequisite = false } = {}) {
  if (expiresAt !== undefined) ensureBeforeExpiry(expiresAt);
  let response;
  try {
    response = await fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch {
    if (publicPrerequisite) throw new BlockedError("RUNTIME_UNAVAILABLE");
    throw new Error("owned integration HTTP request failed");
  }
  return response;
}

function runtimeProof(runtime, serviceToken) {
  return {
    serviceToken,
    runtimeId: runtime.runtimeId,
    instanceId: runtime.instanceId,
    repositoryId: runtime.repositoryId,
    installationId: runtime.installationId,
    runtimeEpoch: runtime.runtimeEpoch,
    leaseId: runtime.leaseId,
  };
}

async function issueRuntimeIdentity(inputs) {
  const { primary, runtime, effectiveExpiresAt } = inputs;
  ensureBeforeExpiry(effectiveExpiresAt);
  const response = await requestJson(
    new URL("/internal/provisioner/runtime-identity", primary.controlPlane.origin),
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${runtime.provisionerAuth}`,
      },
      body: JSON.stringify({
        ...runtime.runtime,
        clusterId: runtime.runtime.clusterId,
      }),
    },
    { expiresAt: effectiveExpiresAt, publicPrerequisite: true },
  );
  if ([401, 404, 409, 503].includes(response.status)) throw new BlockedError("RUNTIME_UNAVAILABLE");
  assert.equal(response.status, 200, "Control Plane did not issue the owned runtime identity");
  const body = await boundedJson(response, "runtime identity response");
  assert.ok(
    hasOnlyKeys(body, ["token", "expiresAt"]) &&
      typeof body.token === "string" &&
      body.token.length >= 20 &&
      body.token.length <= 16_384 &&
      typeof body.expiresAt === "string" &&
      new Date(body.expiresAt).toISOString() === body.expiresAt,
    "Control Plane runtime identity response did not match its public route schema",
  );
  const expiresAt = Date.parse(body.expiresAt);
  assert.ok(expiresAt > Date.now() && expiresAt <= Date.now() + 300_000);
  return { proof: runtimeProof(runtime.runtime, body.token), expiresAt };
}

async function issueBrokerCredential(inputs, identity, operation = "fetch", publish = null) {
  const { primary, effectiveExpiresAt } = inputs;
  ensureBeforeExpiry(effectiveExpiresAt);
  const payload = { operation, proof: identity.proof };
  if (publish) Object.assign(payload, publish);
  const response = await requestJson(
    new URL("/internal/github/credential", primary.gateway.origin),
    {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    { expiresAt: effectiveExpiresAt, publicPrerequisite: true },
  );
  if ([401, 404, 503].includes(response.status)) throw new BlockedError("RUNTIME_UNAVAILABLE");
  assert.equal(response.status, 200, "Gateway rejected the real runtime token-broker request");
  const body = await boundedJson(response, "Gateway scoped credential response");
  assert.ok(
    hasOnlyKeys(body, [
      "username",
      "token",
      "repositoryId",
      "permission",
      "runtimeEpoch",
      "expiresAt",
    ]) &&
      body.username === "x-access-token" &&
      typeof body.token === "string" &&
      body.token.length >= 20 &&
      body.token.length <= 4096 &&
      body.repositoryId === inputs.runtime.runtime.repositoryId &&
      body.permission === (operation === "fetch" ? "read" : "write") &&
      body.runtimeEpoch === inputs.runtime.runtime.runtimeEpoch &&
      typeof body.expiresAt === "string" &&
      new Date(body.expiresAt).toISOString() === body.expiresAt,
    "Gateway credential did not match repository, operation permission, or runtime epoch",
  );
  const expiresAt = Date.parse(body.expiresAt);
  assert.ok(expiresAt > Date.now() && expiresAt <= Date.now() + MAX_INSTALLATION_TOKEN_MS);
  return { ...body, expiresAtMs: expiresAt };
}

async function requestMutationReceipt(inputs, operationId, payloadDigest) {
  const { primary, effectiveExpiresAt, runtime } = inputs;
  ensureBeforeExpiry(effectiveExpiresAt);
  const writer = primary.gateway.writer;
  const response = await requestJson(
    new URL(
      `/api/repositories/${runtime.runtime.repositoryId}/mutation-authorizations`,
      primary.gateway.origin,
    ),
    {
      method: "POST",
      headers: {
        Cookie: writer.sessionCookie,
        Origin: primary.gateway.origin,
        "Sec-Fetch-Site": "same-origin",
        "X-CSRF-Token": writer.csrfToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ operationId, payloadDigest }),
    },
    { expiresAt: effectiveExpiresAt, publicPrerequisite: true },
  );
  if ([401, 403, 404, 503].includes(response.status)) throw new BlockedError("RUNTIME_UNAVAILABLE");
  assert.equal(response.status, 201, "Gateway did not authorize the currently authorized writer");
  const body = await boundedJson(response, "Gateway mutation receipt response");
  assert.ok(
    hasOnlyKeys(body, [
      "contractVersion",
      "receipt",
      "operationId",
      "payloadDigest",
      "expiresAt",
    ]) &&
      body.contractVersion === 1 &&
      typeof body.receipt === "string" &&
      body.receipt.length >= 16 &&
      body.operationId === operationId &&
      body.payloadDigest === payloadDigest &&
      typeof body.expiresAt === "string" &&
      Date.parse(body.expiresAt) > Date.now(),
    "Gateway mutation receipt does not bind the requested actor operation",
  );
  return body.receipt;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Buffer.from(digest).toString("hex");
}

async function githubRepositoryRequest(
  githubRest,
  repository,
  token,
  expectedStatus,
  effectiveExpiresAt,
) {
  ensureBeforeExpiry(effectiveExpiresAt);
  let response;
  try {
    response = await githubRest.request(`/repos/${repository.owner}/${repository.name}`, token, {
      redirect: "error",
    });
  } catch (error) {
    if (error?.status === expectedStatus) return null;
    throw new Error("GitHub repository access returned an unexpected status");
  }
  assert.equal(
    response.status,
    expectedStatus,
    "GitHub repository access had an unexpected status",
  );
  if (expectedStatus === 200) {
    assert.ok(
      object(response.body) && response.body.id === repository.id && response.body.private === true,
      "installation token reached a different or nonprivate repository",
    );
  }
  return response;
}

function gitEnvironment(home, globalConfig, askpass, token) {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: askpass,
    SSH_ASKPASS: askpass,
    GIT_TRACE: "0",
    GIT_CURL_VERBOSE: "0",
    LC_ALL: "C",
    PRAETORIUM_T14_GITHUB_TOKEN: token,
  };
}

function runGit(cwd, args, env, { allowExitCodes = [0], timeout = GIT_TIMEOUT_MS } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    timeout,
    maxBuffer: 1024 * 1024,
    shell: false,
  });
  if (result.error || result.signal || !allowExitCodes.includes(result.status))
    throw new Error("owned Git operation failed or completed with an unknown result");
  return { status: result.status, stdout: result.stdout ?? "" };
}

function gitRefHash(cwd, remote, ref, env) {
  const result = runGit(cwd, ["ls-remote", "--refs", remote, ref], env);
  const line = result.stdout.trim();
  if (!line) return null;
  const fields = line.split(/\s+/u);
  assert.equal(fields.length, 2, "GitHub returned an invalid ref snapshot");
  assert.equal(fields[1], ref, "GitHub returned an unexpected ref name");
  assert.match(fields[0], /^[a-f0-9]{40,64}$/u);
  return fields[0];
}

async function runBrokerGitProbe(
  inputs,
  readCredential,
  writeCredential,
  operationId,
  payloadDigest,
) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "praetorium-t14-github-broker-"));
  const home = path.join(tempRoot, "home");
  const repo = path.join(tempRoot, "repo");
  const globalConfig = path.join(tempRoot, "empty-gitconfig");
  const askpass = path.join(tempRoot, "askpass.sh");
  const repository = inputs.runtime.runtimeRepository;
  const remoteUrl = `https://github.com/${repository.owner}/${repository.name}.git`;
  const ref = `refs/heads/praetorium-t14-broker/${crypto.randomUUID().toLowerCase()}`;
  const payload = `Praetorium T14 runtime broker probe ${operationId}\n`;
  assert.equal(payloadDigest, `sha256:${await sha256Hex(payload)}`);
  const writerEnv = gitEnvironment(home, globalConfig, askpass, writeCredential.token);
  const readerEnv = gitEnvironment(home, globalConfig, askpass, readCredential.token);
  let expectedCommit;
  let pushAttempted = false;
  let pushCompleted = false;
  let recoveryRequired = false;
  let cleanupError = false;
  let probeError;
  try {
    await mkdir(home, { mode: 0o700 });
    await mkdir(repo, { mode: 0o700 });
    await writeFile(globalConfig, "", { mode: 0o600, flag: "wx" });
    await writeFile(
      askpass,
      "#!/bin/sh\ncase \"$1\" in *Username*) printf '%s\\n' 'x-access-token' ;; *Password*) printf '%s\\n' \"$PRAETORIUM_T14_GITHUB_TOKEN\" ;; *) exit 1 ;; esac\n",
      { mode: 0o700, flag: "wx" },
    );
    await chmod(askpass, 0o700);
    runGit(repo, ["init", "--quiet", "--initial-branch=main"], readerEnv);
    runGit(repo, ["config", "user.name", "Praetorium T14 broker"], readerEnv);
    runGit(repo, ["config", "user.email", "t14-broker@example.invalid"], readerEnv);
    await writeFile(path.join(repo, "probe.txt"), payload, { mode: 0o600, flag: "wx" });
    runGit(repo, ["add", "--", "probe.txt"], readerEnv);
    runGit(repo, ["commit", "--quiet", "-m", "T14 runtime broker probe"], readerEnv);
    expectedCommit = runGit(repo, ["rev-parse", "HEAD"], readerEnv).stdout.trim();
    assert.match(expectedCommit, /^[a-f0-9]{40,64}$/u);
    runGit(repo, ["remote", "add", "origin", remoteUrl], readerEnv);
    assert.equal(
      gitRefHash(repo, "origin", ref, writerEnv),
      null,
      "generated Git ref already exists",
    );

    ensureBeforeExpiry(inputs.effectiveExpiresAt);
    pushAttempted = true;
    const push = runGit(repo, ["push", "--porcelain", "origin", `HEAD:${ref}`], writerEnv);
    pushCompleted = push.status === 0;
    if (!pushCompleted) recoveryRequired = true;

    const observed = gitRefHash(repo, "origin", ref, readerEnv);
    if (observed !== expectedCommit) {
      recoveryRequired = true;
      throw new Error("owned GitHub push did not produce the exact run-owned commit");
    }
    recoveryRequired = true;
    runGit(repo, ["fetch", "--quiet", "--no-tags", "origin", ref], readerEnv);
    assert.equal(
      runGit(repo, ["rev-parse", "FETCH_HEAD"], readerEnv).stdout.trim(),
      expectedCommit,
      "read-scoped runtime broker token could not fetch the write-scoped runtime broker ref",
    );

    ensureBeforeExpiry(inputs.effectiveExpiresAt);
    runGit(
      repo,
      ["push", "--porcelain", `--force-with-lease=${ref}:${expectedCommit}`, "origin", `:${ref}`],
      writerEnv,
    );
    assert.equal(
      gitRefHash(repo, "origin", ref, readerEnv),
      null,
      "run-owned ref cleanup was not observed",
    );
    recoveryRequired = false;
  } catch (error) {
    if (expectedCommit && pushAttempted && !pushCompleted) recoveryRequired = true;
    if (recoveryRequired && expectedCommit) {
      probeError = new Error(
        `GitHub ref requires owner reconciliation; preserve only repository ${repository.id}, ref ${ref}, expected commit ${expectedCommit}`,
      );
    } else {
      probeError = error;
    }
  } finally {
    if (recoveryRequired) {
      // A timeout or ambiguous write is deliberately not auto-deleted.
    }
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {
      cleanupError = true;
    });
  }
  if (cleanupError) throw new Error("owned local Git temporary data cleanup failed");
  if (probeError) throw probeError;
}

async function runPartialProbe(inputs) {
  const partialPath = path.join(repositoryRoot, "tests/integration/github-access.partial.test.mjs");
  const partialRealPath = await realpath(partialPath);
  if (!partialRealPath.startsWith(`${repositoryRoot}${path.sep}`))
    throw new Error("partial access probe resolved outside the repository");
  const isolatedHome = process.env.HOME ?? os.tmpdir();
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", partialRealPath], {
    cwd: repositoryRoot,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      PRAETORIUM_T14_GITHUB_ACCESS_CONFIG: `${inputs.inventoryPath}${ACCESS_CONFIG_SUFFIX}`,
    },
    encoding: "utf8",
    timeout: 240_000,
    maxBuffer: 2 * 1024 * 1024,
    shell: false,
  });
  const report = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const tests = Number(report.match(/^# tests (\d+)$/mu)?.[1]);
  const passed = Number(report.match(/^# pass (\d+)$/mu)?.[1]);
  const failed = Number(report.match(/^# fail (\d+)$/mu)?.[1]);
  const skipped = Number(report.match(/^# skipped (\d+)$/mu)?.[1]);
  if (
    result.error ||
    result.signal ||
    result.status !== 0 ||
    !Number.isSafeInteger(tests) ||
    tests < 1 ||
    passed !== tests ||
    failed !== 0 ||
    skipped !== 0 ||
    !/^ok \d+ - real owned GitHub App, user, repository, and Git access path \(partial T14 evidence\)$/mu.test(
      report,
    )
  )
    throw new Error("reviewed partial access and Git probe failed");
}

async function runLiveAcceptance(inputs) {
  const { primary, runtime, effectiveExpiresAt } = inputs;
  const githubPackage = path.join(repositoryRoot, "plugins/github/dist/index.js");
  const packageStat = await stat(githubPackage).catch(() => null);
  assert.ok(packageStat?.isFile(), "build the production @praetorium/github provider before T14");
  const github = await import(new URL(`file://${githubPackage}`).href);
  const githubRest = github.createGitHubRestClient({ requestTimeoutMs: HTTP_TIMEOUT_MS });

  await runPartialProbe(inputs);

  const writerLive = await githubRest.request(
    `/repos/${runtime.runtimeRepository.owner}/${runtime.runtimeRepository.name}`,
    primary.gateway.writer.accessToken,
  );
  assert.equal(writerLive.status, 200, "writer cannot read the separate live runtime repository");
  assert.ok(
    object(writerLive.body) &&
      writerLive.body.id === runtime.runtimeRepository.id &&
      writerLive.body.private === true &&
      object(writerLive.body.permissions) &&
      writerLive.body.permissions.push === true,
    "runtime repository is not private or writer is not currently authorized to push",
  );

  const firstIdentity = await issueRuntimeIdentity(inputs);
  const firstReadCredential = await issueBrokerCredential(inputs, firstIdentity);
  await githubRepositoryRequest(
    githubRest,
    runtime.runtimeRepository,
    firstReadCredential.token,
    200,
    effectiveExpiresAt,
  );
  await githubRepositoryRequest(
    githubRest,
    primary.github.unrelatedRepository,
    firstReadCredential.token,
    404,
    effectiveExpiresAt,
  );

  const operationId = `t14_${crypto.randomUUID()}`;
  const payload = `Praetorium T14 runtime broker probe ${operationId}\n`;
  const payloadDigest = `sha256:${await sha256Hex(payload)}`;
  const publishReceipt = await requestMutationReceipt(inputs, operationId, payloadDigest);
  const writeCredential = await issueBrokerCredential(inputs, firstIdentity, "publish", {
    mutationReceipt: publishReceipt,
    operationId,
    payloadDigest,
  });
  await githubRepositoryRequest(
    githubRest,
    primary.github.unrelatedRepository,
    writeCredential.token,
    404,
    effectiveExpiresAt,
  );
  await runBrokerGitProbe(inputs, firstReadCredential, writeCredential, operationId, payloadDigest);

  const remainingBeforeExpiry = firstReadCredential.expiresAtMs - Date.now();
  if (
    remainingBeforeExpiry < 1 ||
    firstReadCredential.expiresAtMs + CLEANUP_MARGIN_MS > effectiveExpiresAt
  )
    throw new BlockedError("INSUFFICIENT_LIFETIME");
  await new Promise((resolve) => setTimeout(resolve, remainingBeforeExpiry + 1_100));
  ensureBeforeExpiry(effectiveExpiresAt);

  await githubRepositoryRequest(
    githubRest,
    runtime.runtimeRepository,
    firstReadCredential.token,
    401,
    effectiveExpiresAt,
  );
  const staleProofResponse = await requestJson(
    new URL("/internal/github/credential", primary.gateway.origin),
    {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "fetch", proof: firstIdentity.proof }),
    },
    { expiresAt: effectiveExpiresAt },
  );
  assert.equal(
    staleProofResponse.status,
    401,
    "Gateway accepted an expired runtime identity proof",
  );

  const refreshedIdentity = await issueRuntimeIdentity(inputs);
  assert.notEqual(refreshedIdentity.proof.serviceToken, firstIdentity.proof.serviceToken);
  const refreshedCredential = await issueBrokerCredential(inputs, refreshedIdentity);
  assert.notEqual(refreshedCredential.token, firstReadCredential.token);
  assert.ok(refreshedCredential.expiresAtMs > Date.now());
  await githubRepositoryRequest(
    githubRest,
    runtime.runtimeRepository,
    refreshedCredential.token,
    200,
    effectiveExpiresAt,
  );

  const gitRoot = await mkdtemp(path.join(os.tmpdir(), "praetorium-t14-github-refresh-"));
  try {
    const home = path.join(gitRoot, "home");
    const repoPath = path.join(gitRoot, "repo");
    const globalConfig = path.join(gitRoot, "empty-gitconfig");
    const askpass = path.join(gitRoot, "askpass.sh");
    await mkdir(home, { mode: 0o700 });
    await mkdir(repoPath, { mode: 0o700 });
    await writeFile(globalConfig, "", { mode: 0o600, flag: "wx" });
    await writeFile(
      askpass,
      "#!/bin/sh\ncase \"$1\" in *Username*) printf '%s\\n' 'x-access-token' ;; *Password*) printf '%s\\n' \"$PRAETORIUM_T14_GITHUB_TOKEN\" ;; *) exit 1 ;; esac\n",
      { mode: 0o700, flag: "wx" },
    );
    const env = gitEnvironment(home, globalConfig, askpass, refreshedCredential.token);
    runGit(repoPath, ["init", "--quiet", "--initial-branch=main"], env);
    runGit(
      repoPath,
      [
        "remote",
        "add",
        "origin",
        `https://github.com/${runtime.runtimeRepository.owner}/${runtime.runtimeRepository.name}.git`,
      ],
      env,
    );
    runGit(repoPath, ["fetch", "--quiet", "--no-tags", "--depth=1", "origin", "HEAD"], env);
    assert.match(
      runGit(repoPath, ["rev-parse", "FETCH_HEAD"], env).stdout.trim(),
      /^[a-f0-9]{40,64}$/u,
    );
  } finally {
    await rm(gitRoot, { recursive: true, force: true });
  }

  const producerStatus = JSON.parse(
    await readFile(path.join(repositoryRoot, "docs/migration/PRODUCER-STATUS.json"), "utf8"),
  );
  const s03 = producerStatus.capabilities?.find((item) => item.id === "S03");
  if (!s03 || s03.status !== "available" || s03.gate === "BLOCKED")
    throw new BlockedError("PRODUCER_CONTRACT_MISSING");
  // A published status row is not itself live producer proof. This runner does not
  // invent a Scriptorium invocation while the producer-owned GitCredentialProvider
  // and its expiry behavior have no executable public contract.
  throw new BlockedError("PRODUCER_CONTRACT_MISSING");
}

let ownerInputs;
let preflightBlock;
try {
  ownerInputs = await loadOwnedInputs();
} catch (error) {
  preflightBlock = error instanceof BlockedError ? error : new BlockedError("OWNER_INPUT_MISSING");
  await writeRunnerResult("BLOCKED", preflightBlock.reasonCode);
}

if (preflightBlock) {
  blockedTest(preflightBlock.reasonCode);
} else {
  test(
    "T14 owned GitHub App, user, runtime broker, and expiry-backed credential acceptance",
    {
      timeout: RUNNER_TIMEOUT_MS,
    },
    async () => {
      try {
        await runLiveAcceptance(ownerInputs);
      } catch (error) {
        if (error instanceof BlockedError) {
          await writeRunnerResult("BLOCKED", error.reasonCode);
          assert.fail(`BLOCKED: ${error.reasonCode}`);
        }
        await writeRunnerResult("FAILED", "ACCEPTANCE_ASSERTION_FAILED");
        assert.fail(
          "T14 GitHub acceptance assertion failed; credentials and private endpoint details are withheld",
        );
      }
    },
  );
}
