import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_RECOVERY_FILE_BYTES = 16 * 1024;
const RECOVERY_FILE_PREFIX = "praetorium-t14-github-recovery-";
const REQUEST_TIMEOUT_MS = 12_000;
const GIT_TIMEOUT_MS = 20_000;

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value, keys) {
  return isObject(value) && Object.keys(value).every((key) => keys.includes(key));
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function effectiveExpiry(configExpiresAt, inventoryExpiresAt) {
  return Math.min(configExpiresAt, inventoryExpiresAt);
}

function createLifetimeGate(expiresAtMs, now = Date.now) {
  return async (effect) => {
    const nowMs = now();
    if (
      !Number.isSafeInteger(expiresAtMs) ||
      !Number.isSafeInteger(nowMs) ||
      nowMs >= expiresAtMs
    ) {
      throw new Error("owned test environment has expired");
    }
    return effect();
  };
}

function guardedRestClient(rest, gate) {
  return {
    async request(...args) {
      return gate(() => rest.request(...args));
    },
  };
}

async function readOwnedFile(filePath, { privateFile, maxBytes }) {
  if (
    typeof process.getuid !== "function" ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    !Number.isInteger(fsConstants.O_NOFOLLOW) ||
    !Number.isInteger(fsConstants.O_NONBLOCK)
  ) {
    return { blocked: "owner files cannot be safely verified on this platform" };
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
      (privateFile ? (before.mode & 0o077) !== 0 : (before.mode & 0o022) !== 0) ||
      before.size > maxBytes
    ) {
      return { blocked: "owner file permissions, ownership, or size are invalid" };
    }

    const chunks = [];
    let size = 0;
    while (true) {
      const buffer = Buffer.allocUnsafe(Math.min(8192, maxBytes - size + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > maxBytes) return { blocked: "owner file exceeds the size limit" };
      chunks.push(buffer.subarray(0, bytesRead));
    }

    const after = await handle.stat();
    if (
      after.size !== size ||
      before.size !== after.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      after.uid !== uid ||
      (privateFile ? (after.mode & 0o077) !== 0 : (after.mode & 0o022) !== 0)
    ) {
      return { blocked: "owner file changed while it was read" };
    }
    return { bytes: Buffer.concat(chunks, size) };
  } catch {
    return { blocked: "owner file is unavailable or is not a regular file" };
  } finally {
    await handle?.close().catch(() => {});
  }
}

function hasAsciiControlCharacters(value) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint < 0x20 || codePoint === 0x7f;
  });
}

function repositoryName(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,100}$/.test(value);
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

function validUser(value) {
  const cookiePairs =
    typeof value?.sessionCookie === "string"
      ? value.sessionCookie.split(";").map((item) => item.trim())
      : [];
  const cookieNames = cookiePairs.map((item) => item.slice(0, item.indexOf("=")));
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

function validRepository(value) {
  return (
    hasOnlyKeys(value, ["id", "owner", "name"]) &&
    positiveInteger(value.id) &&
    typeof value.owner === "string" &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(value.owner) &&
    repositoryName(value.name)
  );
}

function validateConfig(value) {
  if (
    !hasOnlyKeys(value, [
      "schemaVersion",
      "inventoryPath",
      "ownerIdentity",
      "environment",
      "gateway",
      "controlPlane",
      "github",
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.inventoryPath !== "string" ||
    !path.isAbsolute(value.inventoryPath) ||
    typeof value.ownerIdentity !== "string" ||
    value.ownerIdentity.trim().length < 2 ||
    !hasOnlyKeys(value.environment, [
      "name",
      "expiresAt",
      "cleanupProcedure",
      "privateDisposable",
      "production",
      "resourceReference",
    ]) ||
    typeof value.environment.name !== "string" ||
    value.environment.name.trim().length < 2 ||
    value.environment.privateDisposable !== true ||
    value.environment.production !== false ||
    typeof value.environment.cleanupProcedure !== "string" ||
    value.environment.cleanupProcedure.trim().length < 12 ||
    typeof value.environment.resourceReference !== "string" ||
    value.environment.resourceReference.trim().length < 2 ||
    typeof value.environment.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.environment.expiresAt)) ||
    Date.parse(value.environment.expiresAt) <= Date.now() ||
    !hasOnlyKeys(value.gateway, ["origin", "writer", "reader"]) ||
    !exactHttpsOrigin(value.gateway.origin) ||
    !validUser(value.gateway.writer) ||
    !validUser(value.gateway.reader) ||
    value.gateway.writer.expectedUserId === value.gateway.reader.expectedUserId ||
    !hasOnlyKeys(value.controlPlane, ["origin", "gatewayAuth"]) ||
    !exactHttpsOrigin(value.controlPlane.origin) ||
    typeof value.controlPlane.gatewayAuth !== "string" ||
    !/^[\x21-\x7e]{32,4096}$/.test(value.controlPlane.gatewayAuth) ||
    !hasOnlyKeys(value.github, [
      "appId",
      "installationId",
      "privateKeyPem",
      "repository",
      "unrelatedRepository",
    ]) ||
    !positiveInteger(value.github.appId) ||
    !positiveInteger(value.github.installationId) ||
    typeof value.github.privateKeyPem !== "string" ||
    value.github.privateKeyPem.length < 100 ||
    value.github.privateKeyPem.length > 16_384 ||
    !validRepository(value.github.repository) ||
    !validRepository(value.github.unrelatedRepository) ||
    value.github.repository.id === value.github.unrelatedRepository.id
  ) {
    return false;
  }
  return true;
}

async function loadOwnerConfig() {
  const configPath = process.env.PRAETORIUM_T14_GITHUB_ACCESS_CONFIG;
  if (!configPath) return { blocked: "PRAETORIUM_T14_GITHUB_ACCESS_CONFIG is not set" };
  if (!path.isAbsolute(configPath)) return { blocked: "the owner config path must be absolute" };

  const configFile = await readOwnedFile(configPath, {
    privateFile: true,
    maxBytes: MAX_CONFIG_BYTES,
  });
  if (!configFile.bytes) {
    return {
      blocked:
        "the owner config must be a private, current-owner regular file with mode 0600 or stricter",
    };
  }

  let config;
  try {
    config = JSON.parse(configFile.bytes.toString("utf8"));
  } catch {
    return { blocked: "the owner config is unreadable or invalid JSON" };
  }
  if (!validateConfig(config))
    return { blocked: "the owner config does not match the supported schema" };

  const inventoryFile = await readOwnedFile(config.inventoryPath, {
    privateFile: false,
    maxBytes: MAX_CONFIG_BYTES,
  });
  if (!inventoryFile.bytes) {
    return {
      blocked:
        "the owned inventory must be a current-owner regular file without group or other write permission",
    };
  }
  let inventory;
  try {
    inventory = JSON.parse(inventoryFile.bytes.toString("utf8"));
  } catch {
    return { blocked: "the owned inventory is unreadable or invalid JSON" };
  }
  const resource = inventory?.resources?.["github-access"];
  const configExpires = Date.parse(config.environment.expiresAt);
  const inventoryExpires = Date.parse(inventory?.environment?.expiresAt ?? "");
  if (
    inventory?.schemaVersion !== 1 ||
    inventory?.owner?.identity !== config.ownerIdentity ||
    inventory?.environment?.purpose !== "t14-disposable-test" ||
    inventory?.environment?.disposable !== true ||
    inventory?.environment?.production !== false ||
    typeof inventory?.environment?.expiresAt !== "string" ||
    !Number.isFinite(inventoryExpires) ||
    inventoryExpires <= Date.now() ||
    resource?.state !== "available" ||
    resource?.owner !== config.ownerIdentity ||
    resource?.disposable !== true ||
    resource?.production !== false ||
    resource?.reference !== config.environment.resourceReference
  ) {
    return {
      blocked: "the inventory does not declare this live GitHub resource as owned and disposable",
    };
  }
  return { config, effectiveExpiresAt: effectiveExpiry(configExpires, inventoryExpires) };
}

test("owned environment expiry gates new effects at the effective deadline", async () => {
  const configExpiresAt = 2_005_000;
  const inventoryExpiresAt = 2_000_000;
  const expiresAt = effectiveExpiry(configExpiresAt, inventoryExpiresAt);
  let nowMs = expiresAt - 1;
  let effects = 0;
  const gate = createLifetimeGate(expiresAt, () => nowMs);

  assert.equal(
    await gate(async () => {
      effects += 1;
      return "allowed before expiry";
    }),
    "allowed before expiry",
  );
  nowMs = expiresAt;
  await assert.rejects(
    gate(async () => {
      effects += 1;
    }),
    /owned test environment has expired/u,
  );
  assert.equal(effects, 1, "expired lifetime gate invoked an outbound effect");
});

test("owner attestation reads reject symlinks, writable inventory, and oversized files", async (t) => {
  if (
    typeof process.getuid !== "function" ||
    !Number.isInteger(fsConstants.O_NOFOLLOW) ||
    !Number.isInteger(fsConstants.O_NONBLOCK)
  ) {
    return t.skip("secure owner-file verification requires POSIX UID and O_NOFOLLOW support");
  }

  const directory = await mkdtemp(path.join(os.tmpdir(), "praetorium-t14-owner-file-test-"));
  try {
    const ownerFile = path.join(directory, "owner.json");
    await writeFile(ownerFile, '{"owned":true}', { mode: 0o600 });
    await chmod(ownerFile, 0o600);
    const validOwnerFile = await readOwnedFile(ownerFile, {
      privateFile: true,
      maxBytes: MAX_CONFIG_BYTES,
    });
    assert.equal(validOwnerFile.bytes?.toString("utf8"), '{"owned":true}');

    const alias = path.join(directory, "owner-link.json");
    await symlink(ownerFile, alias);
    assert.ok(
      (await readOwnedFile(alias, { privateFile: true, maxBytes: MAX_CONFIG_BYTES })).blocked,
      "owner config symlink was accepted",
    );
    assert.ok(
      (await readOwnedFile(alias, { privateFile: false, maxBytes: MAX_CONFIG_BYTES })).blocked,
      "owner inventory symlink was accepted",
    );

    const writableInventory = path.join(directory, "inventory.json");
    await writeFile(writableInventory, '{"owned":true}', { mode: 0o666 });
    await chmod(writableInventory, 0o666);
    assert.ok(
      (
        await readOwnedFile(writableInventory, {
          privateFile: false,
          maxBytes: MAX_CONFIG_BYTES,
        })
      ).blocked,
      "group or other writable inventory was accepted",
    );

    assert.ok(
      (
        await readOwnedFile(ownerFile, {
          privateFile: true,
          maxBytes: 4,
        })
      ).blocked,
      "oversized owner config was accepted",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "FIFO owner config is rejected without blocking the runner",
  { skip: process.env.PRAETORIUM_T14_FIFO_CHILD === "1" },
  async (t) => {
    if (
      typeof process.getuid !== "function" ||
      !Number.isInteger(fsConstants.O_NOFOLLOW) ||
      !Number.isInteger(fsConstants.O_NONBLOCK)
    ) {
      return t.skip("FIFO open safety requires POSIX nonblocking file support");
    }

    const directory = await mkdtemp(path.join(os.tmpdir(), "praetorium-t14-owner-fifo-test-"));
    const fifoPath = path.join(directory, "owner-config.fifo");
    try {
      try {
        await execFileAsync("mkfifo", [fifoPath], {
          timeout: 2_000,
          maxBuffer: 16 * 1024,
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        });
      } catch {
        return t.skip("mkfifo utility is unavailable");
      }

      const child = spawnSync(process.execPath, ["--test", fileURLToPath(import.meta.url)], {
        cwd: repositoryRoot,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          PRAETORIUM_T14_GITHUB_ACCESS_CONFIG: fifoPath,
          PRAETORIUM_T14_FIFO_CHILD: "1",
        },
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      });
      assert.equal(child.error, undefined, "FIFO owner config reader blocked the child process");
      assert.equal(child.status, 0, child.stderr || child.stdout);
      assert.match(child.stdout, /BLOCKED: the owner config must be a private/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

async function readJson(response, message) {
  assert.equal(response.redirected, false, `${message}: redirects are not accepted`);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/i, message);
  let value;
  try {
    value = await response.json();
  } catch {
    assert.fail(message);
  }
  return value;
}

async function gatewayRequest(config, user, route, gate, init = {}) {
  const url = new URL(route, config.gateway.origin);
  assert.equal(url.origin, config.gateway.origin, "Gateway request origin changed unexpectedly");
  return gate(() =>
    fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Cookie: user.sessionCookie,
        ...(init.headers ?? {}),
      },
    }),
  );
}

async function controlPlaneSnapshot(config, repositoryId, gate) {
  const response = await gate(() =>
    fetch(new URL(`/v1/repositories/${repositoryId}`, config.controlPlane.origin), {
      headers: { "X-Control-Plane-Gateway-Auth": config.controlPlane.gatewayAuth },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }),
  );
  if (response.status === 404) return null;
  assert.equal(response.status, 200, "Control Plane binding lookup failed");
  return readJson(response, "Control Plane binding response was invalid");
}

function parseBinding(snapshot) {
  const binding = snapshot?.binding;
  const instance = snapshot?.instance;
  assert.ok(isObject(binding) && isObject(instance), "Control Plane snapshot is incomplete");
  assert.ok(positiveInteger(binding.repositoryId), "Control Plane repository ID is invalid");
  assert.ok(positiveInteger(binding.installationId), "Control Plane installation ID is invalid");
  assert.ok(typeof binding.owner === "string" && typeof binding.name === "string");
  assert.ok(typeof binding.instanceId === "string" && binding.instanceId.length > 0);
  assert.equal(
    binding.instanceId,
    instance.instanceId,
    "repository binding and instance IDs differ",
  );
  assert.ok(typeof binding.suspended === "boolean");
  assert.ok(Number.isSafeInteger(binding.bindingEpoch) && binding.bindingEpoch >= 0);
  assert.ok(
    Number.isSafeInteger(binding.authorizationRevision) && binding.authorizationRevision >= 0,
  );
  assert.ok(Number.isSafeInteger(instance.runtimeEpoch) && instance.runtimeEpoch >= 0);
  return binding;
}

function githubRepositoryFrom(accessible, requested) {
  return accessible.find(
    (repository) =>
      repository.id === requested.id &&
      repository.owner.toLowerCase() === requested.owner.toLowerCase() &&
      repository.name.toLowerCase() === requested.name.toLowerCase(),
  );
}

async function checkLiveUser(api, rest, config, userName, user) {
  const response = await rest.request("/user", user.accessToken);
  assert.equal(response.status, 200, `${userName} GitHub token was not accepted`);
  assert.ok(
    isObject(response.body) && String(response.body.id) === user.expectedUserId,
    `${userName} GitHub token and Gateway session identify different users`,
  );

  const installations = await api.listUserInstallations(user.accessToken);
  const installation = installations.find(
    (item) => item.id === config.github.installationId && item.appId === config.github.appId,
  );
  assert.ok(
    installation && installation.suspendedAt === null,
    `${userName} does not have the active owned GitHub App installation`,
  );
  assert.equal(
    installation.permissions.contents,
    "write",
    "the owned test installation must grant Contents write so per-token read/write scoping is testable",
  );
  const repositories = await api.listInstallationRepositories(user.accessToken, installation.id);
  const target = githubRepositoryFrom(repositories, config.github.repository);
  const unrelated = githubRepositoryFrom(repositories, config.github.unrelatedRepository);
  assert.ok(target?.private, `${userName} cannot see the configured private test repository`);
  assert.ok(
    unrelated?.private,
    `${userName} cannot see the configured private sibling repository in the same installation`,
  );
  return { installation, target, unrelated };
}

function tokenSource(users) {
  return {
    async accessTokenFor(userId) {
      return (
        Object.values(users).find((user) => user.expectedUserId === userId)?.accessToken ?? null
      );
    },
  };
}

function repositoryBindingReader(config, gate) {
  return {
    async getByRepositoryId(repositoryId) {
      const snapshot = await controlPlaneSnapshot(config, repositoryId, gate);
      if (!snapshot) return null;
      const binding = parseBinding(snapshot);
      return {
        repositoryId: binding.repositoryId,
        installationId: binding.installationId,
        owner: binding.owner,
        name: binding.name,
        instanceId: binding.instanceId,
        runtimeEpoch: snapshot.instance.runtimeEpoch,
        authorizationRevision: binding.authorizationRevision,
        bindingEpoch: binding.bindingEpoch,
        status: binding.suspended ? "suspended" : "active",
      };
    },
  };
}

function servicePolicy(config) {
  return {
    async allowsRepository(repository) {
      return (
        repository.id === config.github.repository.id &&
        repository.owner.toLowerCase() === config.github.repository.owner.toLowerCase() &&
        repository.name.toLowerCase() === config.github.repository.name.toLowerCase() &&
        repository.private
      );
    },
  };
}

function gatewayActionHeaders(config, user, extra = {}) {
  return {
    Origin: config.gateway.origin,
    "Sec-Fetch-Site": "same-origin",
    "X-CSRF-Token": user.csrfToken,
    ...extra,
  };
}

async function enterRepository(config, user, repositoryId, gate) {
  const form = new URLSearchParams({ action: "enter", csrfToken: user.csrfToken });
  const response = await gatewayRequest(
    config,
    user,
    `/repositories/${repositoryId}/actions`,
    gate,
    {
      method: "POST",
      headers: gatewayActionHeaders(config, user, {
        "Content-Type": "application/x-www-form-urlencoded",
      }),
      body: form,
    },
  );
  // This existing test instance has no approved artifact. The production Gateway must
  // resolve/check it and stop before requesting a runtime start or handoff.
  assert.equal(
    response.status,
    503,
    "repository entry did not stop at configuration-required state",
  );
  const text = await response.text();
  assert.match(
    text,
    /Configuration is required before this repository instance can start/i,
    "repository entry returned an unexpected failure",
  );
}

async function requestMutationAuthorization(config, user, repositoryId, gate) {
  return gatewayRequest(
    config,
    user,
    `/api/repositories/${repositoryId}/mutation-authorizations`,
    gate,
    {
      method: "POST",
      headers: gatewayActionHeaders(config, user, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        operationId: `t14_${crypto.randomUUID()}`,
        payloadDigest: "sha256:" + "a".repeat(64),
      }),
    },
  );
}

function gitBaseEnvironment(home, globalConfig) {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
    LC_ALL: "C",
  };
}

function gitEnvironment(base, token) {
  return {
    ...base,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
  };
}

async function executeGit(cwd, args, env) {
  return execFileAsync("git", args, {
    cwd,
    env,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 256 * 1024,
    windowsHide: true,
  });
}

async function git(cwd, args, env) {
  try {
    const result = await executeGit(cwd, args, env);
    return { ok: true, stdout: result.stdout };
  } catch {
    assert.fail("bounded Git operation failed");
  }
}

function isDefinitiveGitAuthorizationDenial(error) {
  if (
    !Number.isInteger(error?.code) ||
    error.code === 0 ||
    error.killed === true ||
    error.signal != null
  ) {
    return false;
  }
  const stderr = typeof error.stderr === "string" ? error.stderr : "";
  return /^fatal: unable to access '[^\r\n]+': The requested URL returned error: (?:403|404)\r?$/mu.test(
    stderr,
  );
}

async function gitRefHash(cwd, remote, ref, env, gate) {
  const read = () => git(cwd, ["ls-remote", remote, ref], env);
  const result = gate ? await gate(read) : await read();
  const line = result.stdout.trim();
  if (!line) return null;
  const [hash, returnedRef] = line.split(/\s+/u);
  assert.equal(returnedRef, ref, "GitHub returned an unexpected ref during cleanup");
  assert.match(hash ?? "", /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
  return hash;
}

async function gitRefExists(cwd, remote, ref, env, gate) {
  return (await gitRefHash(cwd, remote, ref, env, gate)) !== null;
}

async function deleteOwnedRef(
  cwd,
  remote,
  ref,
  expectedHash,
  env,
  {
    runGit = git,
    readRef = () => gitRefHash(cwd, remote, ref, env),
    afterVerifiedAbsent = async () => {},
  } = {},
) {
  if (!ref || !expectedHash) return;
  const currentHash = await readRef();
  if (currentHash === null) {
    await afterVerifiedAbsent();
    return;
  }
  assert.equal(currentHash, expectedHash, "owned Git ref changed before cleanup");
  await runGit(
    cwd,
    ["push", "--quiet", `--force-with-lease=${ref}:${expectedHash}`, remote, ":" + ref],
    env,
  );
  assert.equal(await readRef(), null, "owned Git ref remained after cleanup");
  await afterVerifiedAbsent();
}

async function attemptOwnedRefPush(
  cwd,
  remote,
  ref,
  expectedHash,
  env,
  gate,
  runGit = executeGit,
  beforePush = async () => {},
) {
  let headResult;
  try {
    headResult = await runGit(cwd, ["rev-parse", "HEAD"], env);
  } catch {
    assert.fail("bounded Git operation failed");
  }
  const localHead = headResult.stdout.trim();
  assert.equal(localHead, expectedHash, "push source differs from its recorded cleanup hash");
  return gate(async () => {
    await beforePush();
    try {
      // The empty expected value makes branch creation atomic and refuses a ref that
      // another actor created after the preflight existence check.
      await runGit(
        cwd,
        ["push", "--quiet", `--force-with-lease=${ref}:`, remote, `HEAD:${ref}`],
        env,
      );
      return { ok: true, created: true, outcome: "created" };
    } catch (error) {
      // Only a completed GitHub authorization refusal proves that the push was
      // rejected. Timeouts and transport failures remain uncertain even if a later
      // read currently sees no ref, because the original receive-pack may finish late.
      const denied = isDefinitiveGitAuthorizationDenial(error);
      return { ok: false, created: false, outcome: denied ? "denied" : "uncertain" };
    }
  });
}

function refRecoveryRecord(repository, ref, expectedCommit, observedCommit) {
  return {
    repositoryId: repository.id,
    repository: `${repository.owner}/${repository.name}`,
    ref,
    expectedCommit,
    ...(observedCommit ? { observedCommit } : {}),
  };
}

async function createDurableRefRecovery(config, repository, ref, expectedCommit) {
  const allowedRepositories = [config.github.repository, config.github.unrelatedRepository];
  const ownerName = `${repository.owner}/${repository.name}`;
  const uuidPattern = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  const allowedRef = new RegExp(
    `^refs/heads/praetorium-t14(?:-(?:read-deny|scope-deny))?/${uuidPattern}$`,
  );
  if (
    !allowedRepositories.some(
      (allowed) => allowed.id === repository.id && `${allowed.owner}/${allowed.name}` === ownerName,
    ) ||
    !allowedRef.test(ref) ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(expectedCommit) ||
    typeof process.getuid !== "function" ||
    !Number.isInteger(fsConstants.O_NOFOLLOW)
  ) {
    throw new Error("owned Git recovery record is outside the fixed owner scope");
  }
  const pending = {
    recordVersion: 1,
    category: "github-access",
    status: "PENDING",
    records: [
      {
        repositoryId: repository.id,
        repository: ownerName,
        ref,
        expectedCommit,
      },
    ],
  };
  const pendingLine = `${JSON.stringify(pending)}\n`;
  const recoveryDirectory = path.dirname(config.inventoryPath);
  const recoveryPath = path.join(
    recoveryDirectory,
    `${RECOVERY_FILE_PREFIX}${crypto.randomUUID()}.ndjson`,
  );
  let handle;
  try {
    handle = await open(
      recoveryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(pendingLine, "utf8");
    await handle.sync();
    const directory = await open(recoveryDirectory, fsConstants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return { path: recoveryPath, pending, pendingLine };
  } finally {
    await handle?.close();
  }
}

async function markDurableRefRecoveryCleaned(artifact) {
  let handle;
  try {
    handle = await open(
      artifact.path,
      fsConstants.O_RDWR | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW,
    );
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.uid !== process.getuid() ||
      (before.mode & 0o077) !== 0 ||
      before.nlink !== 1 ||
      before.size !== Buffer.byteLength(artifact.pendingLine) ||
      before.size > MAX_RECOVERY_FILE_BYTES
    )
      throw new Error("owned Git recovery artifact changed before cleanup proof");
    const bytes = await handle.readFile();
    const afterRead = await handle.stat();
    if (
      bytes.toString("utf8") !== artifact.pendingLine ||
      afterRead.dev !== before.dev ||
      afterRead.ino !== before.ino ||
      afterRead.size !== before.size ||
      afterRead.uid !== process.getuid()
    )
      throw new Error("owned Git recovery artifact changed before cleanup proof");
    await handle.writeFile(`${JSON.stringify({ ...artifact.pending, status: "CLEANED" })}\n`);
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function observedRefAfterPush({
  cwd,
  remote,
  ref,
  env,
  gate,
  push,
  repository,
  expectedCommit,
  recoveryRecords,
  readRef = () => gitRefHash(cwd, remote, ref, env, gate),
}) {
  const record = refRecoveryRecord(repository, ref, expectedCommit);
  let observedCommit;
  try {
    observedCommit = await readRef();
  } catch {
    if (push.outcome !== "created") recoveryRecords.push(record);
    throw new Error("could not inspect the run-specific Git ref after push");
  }
  if (push.outcome === "uncertain") {
    recoveryRecords.push({ ...record, ...(observedCommit ? { observedCommit } : {}) });
    throw new Error("Git push outcome is uncertain; automatic deletion was withheld");
  }
  if (push.outcome === "denied" && observedCommit !== null) {
    recoveryRecords.push({ ...record, observedCommit });
    throw new Error("GitHub denied the push but the run-specific ref exists");
  }
  return observedCommit;
}

test("partial Git writes leave durable recovery evidence before push and verify cleanup", async (t) => {
  if (typeof process.getuid !== "function" || !Number.isInteger(fsConstants.O_NOFOLLOW)) {
    return t.skip("durable owner recovery requires POSIX UID and O_NOFOLLOW support");
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "praetorium-t14-partial-recovery-test-"));
  const repository = { id: 70002, owner: "owned-org", name: "t14-access" };
  const config = {
    inventoryPath: path.join(directory, "inventory.json"),
    github: { repository, unrelatedRepository: { id: 70003, owner: "owned-org", name: "sibling" } },
  };
  const expectedCommit = "c".repeat(40);
  const ref = "refs/heads/praetorium-t14/12345678-1234-1234-1234-123456789abc";
  let artifact;
  try {
    const push = await attemptOwnedRefPush(
      "/unused/local-repository",
      "https://github.com/owned-org/t14-access.git",
      ref,
      expectedCommit,
      {},
      async (effect) => effect(),
      async (_cwd, args) => {
        if (args[0] === "rev-parse") return { stdout: `${expectedCommit}\n` };
        assert.equal(args[0], "push");
        const lines = (await readFile(artifact.path, "utf8")).trim().split("\n");
        assert.equal(JSON.parse(lines[0]).status, "PENDING");
        throw Object.assign(new Error("simulated uncertain receive-pack"), {
          code: "ETIMEDOUT",
          killed: true,
          signal: null,
          stderr: "fatal: operation timed out",
        });
      },
      async () => {
        artifact = await createDurableRefRecovery(config, repository, ref, expectedCommit);
      },
    );
    assert.equal(push.outcome, "uncertain");
    const info = await stat(artifact.path);
    assert.equal(info.uid, process.getuid());
    assert.equal(info.mode & 0o777, 0o600);
    let reads = [expectedCommit, null];
    await deleteOwnedRef(
      "/unused/local-repository",
      "https://github.com/owned-org/t14-access.git",
      ref,
      expectedCommit,
      {},
      {
        readRef: async () => reads.shift(),
        runGit: async (_cwd, args) => {
          assert.deepEqual(args, [
            "push",
            "--quiet",
            `--force-with-lease=${ref}:${expectedCommit}`,
            "https://github.com/owned-org/t14-access.git",
            `:${ref}`,
          ]);
        },
        afterVerifiedAbsent: () => markDurableRefRecoveryCleaned(artifact),
      },
    );
    const records = (await readFile(artifact.path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      records.map((record) => record.status),
      ["PENDING", "CLEANED"],
    );
    const remainingRef = "refs/heads/praetorium-t14/12345678-1234-1234-1234-123456789abd";
    const remainingArtifact = await createDurableRefRecovery(
      config,
      repository,
      remainingRef,
      expectedCommit,
    );
    let cleanupProofWritten = false;
    reads = [expectedCommit, expectedCommit];
    await assert.rejects(
      deleteOwnedRef(
        "/unused/local-repository",
        "https://github.com/owned-org/t14-access.git",
        remainingRef,
        expectedCommit,
        {},
        {
          readRef: async () => reads.shift(),
          runGit: async () => {},
          afterVerifiedAbsent: async () => {
            cleanupProofWritten = true;
          },
        },
      ),
      /owned Git ref remained after cleanup/u,
    );
    assert.equal(cleanupProofWritten, false);
    assert.equal(
      JSON.parse((await readFile(remainingArtifact.path, "utf8")).trim()).status,
      "PENDING",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("uncertain Git push remains a recovery failure when the later ref snapshot is absent", async () => {
  const expectedCommit = "a".repeat(40);
  const repository = { id: 70001, owner: "owned-org", name: "t14-access" };
  const ref = "refs/heads/praetorium-t14-uncertain";
  const runGit = async (_cwd, args) => {
    if (args[0] === "rev-parse") return { stdout: `${expectedCommit}\n` };
    assert.equal(args[0], "push");
    throw Object.assign(new Error("simulated transport timeout"), {
      code: "ETIMEDOUT",
      killed: true,
      signal: null,
      stderr: "fatal: unable to access remote: operation timed out",
    });
  };
  const gate = async (effect) => effect();
  const push = await attemptOwnedRefPush(
    "/unused/local-repository",
    "https://example.invalid/owned-org/t14-access.git",
    ref,
    expectedCommit,
    {},
    gate,
    runGit,
  );
  assert.deepEqual(push, { ok: false, created: false, outcome: "uncertain" });

  const recoveryRecords = [];
  let snapshotReads = 0;
  await assert.rejects(
    observedRefAfterPush({
      cwd: "/unused/local-repository",
      remote: "https://example.invalid/owned-org/t14-access.git",
      ref,
      env: {},
      gate,
      push,
      repository,
      expectedCommit,
      recoveryRecords,
      readRef: async () => {
        snapshotReads += 1;
        return null;
      },
    }),
    /Git push outcome is uncertain/u,
  );
  assert.equal(snapshotReads, 1);
  assert.deepEqual(recoveryRecords, [refRecoveryRecord(repository, ref, expectedCommit)]);
});

test("only a completed explicit GitHub authorization refusal proves a negative push", async () => {
  const expectedCommit = "b".repeat(40);
  const repository = { id: 70002, owner: "owned-org", name: "t14-sibling" };
  const ref = "refs/heads/praetorium-t14-denied";
  const runGit = async (_cwd, args) => {
    if (args[0] === "rev-parse") return { stdout: `${expectedCommit}\n` };
    assert.equal(args[0], "push");
    throw Object.assign(new Error("GitHub refused the push"), {
      code: 128,
      killed: false,
      signal: null,
      stderr:
        "fatal: unable to access 'https://github.com/owned-org/t14-sibling.git/': The requested URL returned error: 403",
    });
  };
  const gate = async (effect) => effect();
  const push = await attemptOwnedRefPush(
    "/unused/local-repository",
    "https://example.invalid/owned-org/t14-sibling.git",
    ref,
    expectedCommit,
    {},
    gate,
    runGit,
  );
  assert.deepEqual(push, { ok: false, created: false, outcome: "denied" });

  const recoveryRecords = [];
  assert.equal(
    await observedRefAfterPush({
      cwd: "/unused/local-repository",
      remote: "https://example.invalid/owned-org/t14-sibling.git",
      ref,
      env: {},
      gate,
      push,
      repository,
      expectedCommit,
      recoveryRecords,
      readRef: async () => null,
    }),
    null,
  );
  assert.deepEqual(recoveryRecords, []);
});

test("invalid credentials and remote hook text do not prove a negative push", async () => {
  const expectedCommit = "c".repeat(40);
  const repository = { id: 70003, owner: "owned-org", name: "t14-auth-check" };
  const ref = "refs/heads/praetorium-t14-unproven-denial";
  const gate = async (effect) => effect();
  const cases = [
    {
      label: "invalid credential status",
      stderr:
        "fatal: unable to access 'https://github.com/owned-org/t14-auth-check.git/': The requested URL returned error: 401",
    },
    {
      label: "untrusted server hook text",
      stderr: "remote: Write access to repository not granted.",
    },
  ];

  for (const { label, stderr } of cases) {
    const runGit = async (_cwd, args) => {
      if (args[0] === "rev-parse") return { stdout: `${expectedCommit}\n` };
      assert.equal(args[0], "push");
      throw Object.assign(new Error(label), {
        code: 128,
        killed: false,
        signal: null,
        stderr,
      });
    };
    const push = await attemptOwnedRefPush(
      "/unused/local-repository",
      "https://example.invalid/owned-org/t14-auth-check.git",
      ref,
      expectedCommit,
      {},
      gate,
      runGit,
    );
    assert.equal(push.outcome, "uncertain", `${label} was accepted as proof of denial`);

    const recoveryRecords = [];
    await assert.rejects(
      observedRefAfterPush({
        cwd: "/unused/local-repository",
        remote: "https://example.invalid/owned-org/t14-auth-check.git",
        ref,
        env: {},
        gate,
        push,
        repository,
        expectedCommit,
        recoveryRecords,
        readRef: async () => null,
      }),
      /Git push outcome is uncertain/u,
    );
    assert.deepEqual(recoveryRecords, [refRecoveryRecord(repository, ref, expectedCommit)]);
  }
});

async function issueGitHubScopedTokens(config, client, now, gate) {
  const issuanceRest = guardedRestClient(
    client.createGitHubRestClient({ requestTimeoutMs: REQUEST_TIMEOUT_MS }),
    gate,
  );
  const issuer = client.createGitHubInstallationTokenIssuer({
    appId: config.github.appId,
    privateKeyPem: config.github.privateKeyPem,
    client: issuanceRest,
  });
  const revoker = client.createGitHubInstallationTokenRevoker({
    client: client.createGitHubRestClient({ requestTimeoutMs: REQUEST_TIMEOUT_MS }),
  });
  const issued = [];
  try {
    issued.push(
      await gate(() =>
        issuer.issue(config.github.installationId, config.github.repository.id, "read", now),
      ),
    );
    issued.push(
      await gate(() =>
        issuer.issue(config.github.installationId, config.github.repository.id, "write", now),
      ),
    );
    return { issuer, revoker, issued };
  } catch {
    let cleanupFailed = false;
    for (const token of issued.reverse()) {
      try {
        await revoker.revoke(token);
      } catch {
        cleanupFailed = true;
      }
    }
    assert.equal(
      cleanupFailed,
      false,
      "an installation token issued before failure could not be revoked",
    );
    assert.fail("production GitHub App token issuance failed");
  }
}

async function runOwnedProbe(config, effectiveExpiresAt) {
  const gate = createLifetimeGate(effectiveExpiresAt);
  const githubPackage = path.join(repositoryRoot, "plugins/github/dist/index.js");
  const packageStat = await stat(githubPackage).catch(() => null);
  assert.ok(
    packageStat?.isFile(),
    "build @praetorium/github first; the probe calls the production provider package",
  );
  const github = await import(githubPackage);
  const now = new Date();

  // Validate the private key locally before any network call or remote effect.
  const appJwt = await github.createGitHubAppJwt(
    config.github.appId,
    config.github.privateKeyPem,
    now,
  );
  assert.ok(typeof appJwt === "string" && appJwt.split(".").length === 3);

  const rest = guardedRestClient(
    github.createGitHubRestClient({ requestTimeoutMs: REQUEST_TIMEOUT_MS }),
    gate,
  );
  const api = github.createGitHubAccessApi(rest);
  const [writerLive, readerLive] = await Promise.all([
    checkLiveUser(api, rest, config, "writer", config.gateway.writer),
    checkLiveUser(api, rest, config, "reader", config.gateway.reader),
  ]);
  assert.equal(writerLive.installation.id, readerLive.installation.id);
  assert.equal(writerLive.target.id, config.github.repository.id);
  assert.equal(readerLive.target.id, config.github.repository.id);
  assert.equal(writerLive.unrelated.id, config.github.unrelatedRepository.id);
  assert.equal(readerLive.unrelated.id, config.github.unrelatedRepository.id);
  assert.equal(
    writerLive.target.permissions.push,
    true,
    "the writer must have current GitHub push permission on the test repository",
  );
  assert.equal(
    readerLive.target.permissions.pull,
    true,
    "the reader must have current GitHub read permission on the test repository",
  );
  assert.equal(
    readerLive.target.permissions.push,
    false,
    "the reader must not have GitHub push permission on the test repository",
  );
  assert.equal(
    writerLive.unrelated.permissions.push,
    true,
    "the writer must have push permission on the sibling scope-test repository",
  );

  const existing = await controlPlaneSnapshot(config, config.github.repository.id, gate);
  assert.ok(existing, "the owned disposable test repository must already have a CP binding");
  const binding = parseBinding(existing);
  assert.equal(binding.repositoryId, config.github.repository.id);
  assert.equal(binding.installationId, config.github.installationId);
  assert.equal(binding.owner.toLowerCase(), config.github.repository.owner.toLowerCase());
  assert.equal(binding.name.toLowerCase(), config.github.repository.name.toLowerCase());
  assert.equal(binding.suspended, false, "the existing owned test binding must be active");
  assert.equal(
    existing.instance.currentArtifactDigest,
    null,
    "the test instance must have no current artifact so entry cannot start a runtime",
  );
  assert.equal(
    existing.instance.desiredArtifactDigest,
    null,
    "the test instance must have no desired artifact so entry cannot start a runtime",
  );
  assert.ok(
    Number.isSafeInteger(existing.instance.runtimeEpoch) && existing.instance.runtimeEpoch > 0,
    "the existing stopped test instance must have a positive runtime epoch for Gateway mutation authorization",
  );
  assert.equal(
    await controlPlaneSnapshot(config, config.github.unrelatedRepository.id, gate),
    null,
    "the sibling scope-test repository must not have a Praetorium instance binding",
  );

  const users = {
    [config.gateway.writer.expectedUserId]: config.gateway.writer,
    [config.gateway.reader.expectedUserId]: config.gateway.reader,
  };
  const provider = github.createGitHubAccessProvider({
    appId: config.github.appId,
    api,
    userTokens: tokenSource(users),
    repositoryBindings: repositoryBindingReader(config, gate),
    servicePolicy: servicePolicy(config),
    instanceOriginFor: (instanceId) => `https://${instanceId}.t14.invalid`,
    now: () => new Date(),
  });
  const writerRead = await provider.authorize(
    config.gateway.writer.expectedUserId,
    binding.repositoryId,
    "read",
  );
  const writerWrite = await provider.authorize(
    config.gateway.writer.expectedUserId,
    binding.repositoryId,
    "write",
  );
  const readerRead = await provider.authorize(
    config.gateway.reader.expectedUserId,
    binding.repositoryId,
    "read",
  );
  const readerWrite = await provider.authorize(
    config.gateway.reader.expectedUserId,
    binding.repositoryId,
    "write",
  );
  const unrelatedWrite = await provider.authorize(
    config.gateway.writer.expectedUserId,
    config.github.unrelatedRepository.id,
    "write",
  );
  assert.equal(writerRead.allowed, true, "production provider denied the authorized writer read");
  assert.equal(
    writerWrite.allowed,
    true,
    "production provider denied the authorized writer mutation",
  );
  assert.equal(readerRead.allowed, true, "production provider denied the read-only user read");
  assert.equal(
    readerWrite.allowed,
    false,
    "production provider allowed a read-only user to mutate",
  );
  assert.equal(
    unrelatedWrite.allowed,
    false,
    "production provider allowed an unbound repository mutation",
  );

  for (const [name, user] of Object.entries({
    writer: config.gateway.writer,
    reader: config.gateway.reader,
  })) {
    const sessionResponse = await gatewayRequest(config, user, "/api/session", gate);
    assert.equal(sessionResponse.status, 200, `${name} Gateway session was rejected`);
    const session = await readJson(sessionResponse, `${name} Gateway session response was invalid`);
    assert.equal(
      session.userId,
      user.expectedUserId,
      `${name} session identity did not match GitHub`,
    );
  }

  await enterRepository(config, config.gateway.writer, config.github.repository.id, gate);
  const afterWriter = await controlPlaneSnapshot(config, config.github.repository.id, gate);
  assert.ok(afterWriter, "Gateway entry did not preserve the test repository binding");
  const writerBinding = parseBinding(afterWriter);
  assert.equal(
    writerBinding.instanceId,
    binding.instanceId,
    "writer entry resolved a different numeric-repository instance",
  );

  await enterRepository(config, config.gateway.reader, config.github.repository.id, gate);
  const afterReader = await controlPlaneSnapshot(config, config.github.repository.id, gate);
  assert.ok(afterReader, "reader Gateway entry did not preserve the test repository binding");
  const readerBinding = parseBinding(afterReader);
  assert.equal(
    readerBinding.instanceId,
    writerBinding.instanceId,
    "both users did not resolve the same repository instance",
  );
  assert.equal(
    readerBinding.bindingEpoch,
    writerBinding.bindingEpoch,
    "authorized entry unexpectedly changed the repository binding epoch",
  );

  const readOnlyMutation = await requestMutationAuthorization(
    config,
    config.gateway.reader,
    config.github.repository.id,
    gate,
  );
  assert.equal(
    readOnlyMutation.status,
    403,
    "Gateway issued mutation authority to the GitHub read-only user",
  );
  const writerMutation = await requestMutationAuthorization(
    config,
    config.gateway.writer,
    config.github.repository.id,
    gate,
  );
  assert.equal(
    writerMutation.status,
    201,
    "Gateway did not authorize the currently GitHub-writable user",
  );
  // The signed receipt remains in memory and is intentionally never sent to a producer.
  await writerMutation.arrayBuffer();
  const unrelatedMutation = await requestMutationAuthorization(
    config,
    config.gateway.writer,
    config.github.unrelatedRepository.id,
    gate,
  );
  assert.ok(
    [403, 404].includes(unrelatedMutation.status),
    "Gateway authorized mutation on an unrelated unbound repository",
  );
  await unrelatedMutation.arrayBuffer();

  const tokenSet = await issueGitHubScopedTokens(config, github, new Date().toISOString(), gate);
  const [readToken, writeToken] = tokenSet.issued;
  let tempRoot;
  let primaryRef;
  let readOnlyRef;
  let unrelatedRef;
  let primaryCommit;
  let unrelatedCommit;
  let primaryRecovery;
  let readOnlyRecovery;
  let unrelatedRecovery;
  let primaryCreated = false;
  let readOnlyCreated = false;
  let unrelatedCreated = false;
  let gitHome;
  let globalGitConfig;
  let baseGitEnv;
  let cleanupFailed = false;
  let probeError;
  const uncertainRefs = [];

  try {
    assert.equal(readToken.repositoryId, config.github.repository.id);
    assert.equal(readToken.permission, "read");
    assert.equal(writeToken.repositoryId, config.github.repository.id);
    assert.equal(writeToken.permission, "write");
    const targetResponse = await rest.request(
      `/repos/${config.github.repository.owner}/${config.github.repository.name}`,
      readToken.token,
    );
    assert.equal(
      targetResponse.status,
      200,
      "read-scoped token could not read its assigned private repository",
    );
    assert.ok(
      isObject(targetResponse.body) &&
        targetResponse.body.private === true &&
        targetResponse.body.id === config.github.repository.id,
      "GitHub App token resolved to a different or non-private repository",
    );

    let unrelatedStatus = null;
    try {
      const unrelatedResponse = await rest.request(
        `/repos/${config.github.unrelatedRepository.owner}/${config.github.unrelatedRepository.name}`,
        writeToken.token,
      );
      unrelatedStatus = unrelatedResponse.status;
    } catch (error) {
      unrelatedStatus = error?.status;
    }
    assert.ok(
      [403, 404].includes(unrelatedStatus),
      "repository-scoped write token could access the sibling private repository",
    );

    await execFileAsync("git", ["--version"], {
      timeout: 3_000,
      maxBuffer: 16 * 1024,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "praetorium-t14-github-access-"));
    gitHome = path.join(tempRoot, "home");
    await mkdir(gitHome, { mode: 0o700 });
    globalGitConfig = path.join(tempRoot, "empty-gitconfig");
    await writeFile(globalGitConfig, "", { mode: 0o600, flag: "wx" });
    baseGitEnv = gitBaseEnvironment(gitHome, globalGitConfig);
    const targetRemote = `https://github.com/${config.github.repository.owner}/${config.github.repository.name}.git`;
    const unrelatedRemote = `https://github.com/${config.github.unrelatedRepository.owner}/${config.github.unrelatedRepository.name}.git`;
    const runId = crypto.randomUUID().toLowerCase();
    primaryRef = `refs/heads/praetorium-t14/${runId}`;
    readOnlyRef = `refs/heads/praetorium-t14-read-deny/${runId}`;
    unrelatedRef = `refs/heads/praetorium-t14-scope-deny/${runId}`;

    const writerRepo = path.join(tempRoot, "writer-repo");
    const readRepo = path.join(tempRoot, "read-repo");
    const siblingRepo = path.join(tempRoot, "sibling-repo");
    for (const directory of [writerRepo, readRepo, siblingRepo]) {
      await mkdir(directory, { mode: 0o700 });
    }
    const writerEnv = gitEnvironment(baseGitEnv, writeToken.token);
    const readEnv = gitEnvironment(baseGitEnv, readToken.token);
    const userEnv = gitEnvironment(baseGitEnv, config.gateway.writer.accessToken);

    await git(writerRepo, ["init", "--quiet", "--initial-branch=main"], baseGitEnv);
    await git(writerRepo, ["config", "user.name", "Praetorium T14 disposable probe"], baseGitEnv);
    await git(writerRepo, ["config", "user.email", "t14-probe@example.invalid"], baseGitEnv);
    await writeFile(path.join(writerRepo, "probe.txt"), "owned disposable GitHub access probe\n", {
      mode: 0o600,
    });
    await git(writerRepo, ["add", "--", "probe.txt"], baseGitEnv);
    await git(
      writerRepo,
      ["commit", "--quiet", "-m", "T14 owned disposable access probe"],
      baseGitEnv,
    );
    primaryCommit = (await git(writerRepo, ["rev-parse", "HEAD"], baseGitEnv)).stdout.trim();
    await git(writerRepo, ["remote", "add", "origin", targetRemote], baseGitEnv);
    assert.equal(
      await gitRefExists(writerRepo, "origin", primaryRef, writerEnv, gate),
      false,
      "generated target branch already exists; refusing to overwrite it",
    );
    assert.equal(
      await gitRefExists(writerRepo, "origin", readOnlyRef, writerEnv, gate),
      false,
      "generated read-denial branch already exists; refusing to overwrite it",
    );
    assert.equal(
      await gitRefExists(siblingRepo, unrelatedRemote, unrelatedRef, userEnv, gate),
      false,
      "generated sibling branch already exists; refusing to overwrite it",
    );

    const primaryPush = await attemptOwnedRefPush(
      writerRepo,
      "origin",
      primaryRef,
      primaryCommit,
      writerEnv,
      gate,
      executeGit,
      async () => {
        primaryRecovery = await createDurableRefRecovery(
          config,
          config.github.repository,
          primaryRef,
          primaryCommit,
        );
      },
    );
    primaryCreated = primaryPush.created;
    if (primaryPush.outcome === "uncertain") {
      uncertainRefs.push(refRecoveryRecord(config.github.repository, primaryRef, primaryCommit));
    }
    assert.equal(
      primaryPush.ok,
      true,
      `write-scoped token could not push its owned target ref: ${primaryRef}`,
    );
    await git(readRepo, ["init", "--quiet", "--initial-branch=main"], baseGitEnv);
    await git(readRepo, ["remote", "add", "origin", targetRemote], baseGitEnv);
    await gate(() =>
      git(readRepo, ["fetch", "--quiet", "--no-tags", "origin", primaryRef], readEnv),
    );
    const fetchedCommit = (
      await git(readRepo, ["rev-parse", "FETCH_HEAD"], baseGitEnv)
    ).stdout.trim();
    assert.equal(
      fetchedCommit,
      primaryCommit,
      "read-scoped token could not fetch the write-scoped token's owned ref",
    );

    const readOnlyPush = await attemptOwnedRefPush(
      writerRepo,
      targetRemote,
      readOnlyRef,
      primaryCommit,
      readEnv,
      gate,
      executeGit,
      async () => {
        readOnlyRecovery = await createDurableRefRecovery(
          config,
          config.github.repository,
          readOnlyRef,
          primaryCommit,
        );
      },
    );
    readOnlyCreated = readOnlyPush.created;
    const readOnlyObserved = await observedRefAfterPush({
      cwd: writerRepo,
      remote: targetRemote,
      ref: readOnlyRef,
      env: writerEnv,
      gate,
      push: readOnlyPush,
      repository: config.github.repository,
      expectedCommit: primaryCommit,
      recoveryRecords: uncertainRefs,
    });
    assert.equal(
      readOnlyPush.outcome,
      "denied",
      `read-scoped push was not an explicit GitHub authorization refusal: ${readOnlyRef}`,
    );
    assert.equal(
      readOnlyObserved,
      null,
      `read-scoped token created a branch despite the failed push response: ${readOnlyRef}`,
    );
    await markDurableRefRecoveryCleaned(readOnlyRecovery);

    await git(siblingRepo, ["init", "--quiet", "--initial-branch=main"], baseGitEnv);
    await git(siblingRepo, ["config", "user.name", "Praetorium T14 disposable probe"], baseGitEnv);
    await git(siblingRepo, ["config", "user.email", "t14-probe@example.invalid"], baseGitEnv);
    await writeFile(path.join(siblingRepo, "probe.txt"), "owned disposable scope-denial probe\n", {
      mode: 0o600,
    });
    await git(siblingRepo, ["add", "--", "probe.txt"], baseGitEnv);
    await git(
      siblingRepo,
      ["commit", "--quiet", "-m", "T14 scoped token denial probe"],
      baseGitEnv,
    );
    unrelatedCommit = (await git(siblingRepo, ["rev-parse", "HEAD"], baseGitEnv)).stdout.trim();
    await git(siblingRepo, ["remote", "add", "origin", unrelatedRemote], baseGitEnv);
    const scopedPush = await attemptOwnedRefPush(
      siblingRepo,
      "origin",
      unrelatedRef,
      unrelatedCommit,
      writerEnv,
      gate,
      executeGit,
      async () => {
        unrelatedRecovery = await createDurableRefRecovery(
          config,
          config.github.unrelatedRepository,
          unrelatedRef,
          unrelatedCommit,
        );
      },
    );
    unrelatedCreated = scopedPush.created;
    const unrelatedObserved = await observedRefAfterPush({
      cwd: siblingRepo,
      remote: unrelatedRemote,
      ref: unrelatedRef,
      env: userEnv,
      gate,
      push: scopedPush,
      repository: config.github.unrelatedRepository,
      expectedCommit: unrelatedCommit,
      recoveryRecords: uncertainRefs,
    });
    assert.equal(
      scopedPush.outcome,
      "denied",
      `repository-scoped sibling push was not an explicit GitHub authorization refusal: ${unrelatedRef}`,
    );
    assert.equal(
      unrelatedObserved,
      null,
      `scoped-token denial left a sibling branch behind: ${unrelatedRef}`,
    );
    await markDurableRefRecoveryCleaned(unrelatedRecovery);
  } catch (error) {
    probeError = error;
  } finally {
    const cleanup = async (operation) => {
      try {
        await operation();
      } catch {
        cleanupFailed = true;
      }
    };
    if (baseGitEnv && globalGitConfig) {
      const writerEnv = gitEnvironment(baseGitEnv, writeToken.token);
      const userEnv = gitEnvironment(baseGitEnv, config.gateway.writer.accessToken);
      if (primaryCreated)
        await cleanup(() =>
          deleteOwnedRef(
            path.join(tempRoot, "writer-repo"),
            `https://github.com/${config.github.repository.owner}/${config.github.repository.name}.git`,
            primaryRef,
            primaryCommit,
            writerEnv,
            { afterVerifiedAbsent: () => markDurableRefRecoveryCleaned(primaryRecovery) },
          ),
        );
      if (readOnlyCreated)
        await cleanup(() =>
          deleteOwnedRef(
            path.join(tempRoot, "writer-repo"),
            `https://github.com/${config.github.repository.owner}/${config.github.repository.name}.git`,
            readOnlyRef,
            primaryCommit,
            writerEnv,
            { afterVerifiedAbsent: () => markDurableRefRecoveryCleaned(readOnlyRecovery) },
          ),
        );
      if (unrelatedCreated)
        await cleanup(() =>
          deleteOwnedRef(
            path.join(tempRoot, "sibling-repo"),
            `https://github.com/${config.github.unrelatedRepository.owner}/${config.github.unrelatedRepository.name}.git`,
            unrelatedRef,
            unrelatedCommit,
            userEnv,
            { afterVerifiedAbsent: () => markDurableRefRecoveryCleaned(unrelatedRecovery) },
          ),
        );
    }
    if (tempRoot) await cleanup(() => rm(tempRoot, { recursive: true, force: true }));
    for (const token of [...tokenSet.issued].reverse()) {
      await cleanup(() => tokenSet.revoker.revoke(token));
    }
  }
  if (uncertainRefs.length > 0) {
    throw new Error(
      `Git refs need owner recovery; automatic deletion was withheld where ownership was not confirmed. Preserve these sanitized repository/ref/commit records: ${JSON.stringify(uncertainRefs)}${cleanupFailed ? "; cleanup of other confirmed owned resources also failed" : ""}`,
    );
  }
  if (cleanupFailed) {
    const generatedRefs = [primaryRef, readOnlyRef, unrelatedRef].filter(Boolean);
    throw new Error(
      `owned test branch or installation token cleanup failed${
        generatedRefs.length > 0
          ? `; verify only this run's refs before cleanup: ${generatedRefs.join(", ")}`
          : ""
      }`,
    );
  }
  if (probeError) throw probeError;
}

const ownerInputs = await loadOwnerConfig();
if (ownerInputs.blocked) {
  test("real GitHub access partial probe", { skip: `BLOCKED: ${ownerInputs.blocked}` }, () => {});
} else {
  test(
    "real owned GitHub App, user, repository, and Git access path (partial T14 evidence)",
    {
      timeout: 180_000,
    },
    async () => {
      await runOwnedProbe(ownerInputs.config, ownerInputs.effectiveExpiresAt);
    },
  );
}
