import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workerEntryPath = path.join(repositoryRoot, "apps/control-plane/src/worker.ts");
const workerConfigPath = path.join(repositoryRoot, "apps/control-plane/wrangler.toml");
const migrationDirectory = path.join(repositoryRoot, "apps/control-plane/migrations");
const gatewayAuthHeader = "X-Control-Plane-Gateway-Auth";
const testRepository = {
  repositoryId: 899998001,
  installationId: 899998002,
  owner: "praetorium-t14",
  name: "d1-do-acceptance-probe",
  authorizationRevision: 7,
};

async function assertOwnedDisposableInventory() {
  const inventoryPath = process.env.PRAETORIUM_T14_INVENTORY_PATH;
  assert.ok(inventoryPath, "Run this acceptance runner through verify-integration.mjs");
  assert.equal(process.env.PRAETORIUM_T14_CATEGORY, "workers-d1-do");

  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  const resource = inventory.resources?.["workers-d1-do"];
  assert.equal(inventory.environment?.purpose, "t14-disposable-test");
  assert.equal(inventory.environment?.disposable, true);
  assert.equal(inventory.environment?.production, false);
  assert.notEqual(inventory.environment?.expiresAt, undefined);
  assert.ok(
    inventory.owner?.identity &&
      inventory.owner.identity !== "operator-supplied before provisioning",
  );
  assert.equal(resource?.state, "available");
  assert.equal(resource?.owner, inventory.owner.identity);
  assert.equal(resource?.disposable, true);
  assert.equal(resource?.production, false);
  assert.ok(typeof resource?.reference === "string" && resource.reference.length > 0);
}

function makeMiniflare(script, persistenceRoot, secrets, compatibilityDate, compatibilityFlags) {
  return new Miniflare({
    name: "praetorium-control-plane-t14",
    script,
    modules: true,
    compatibilityDate,
    compatibilityFlags,
    bindings: {
      CONTROL_PLANE_GATEWAY_AUTH: secrets.gateway,
      PROVISIONER_AUTH_TOKEN: secrets.provisioner,
      PROVISIONER_WORKER_ID: "test-worker",
      PROVISIONER_CLUSTER_ID: "test-cluster",
      GATEWAY_ORIGIN: "https://gateway.test",
      INSTANCE_HOST_SUFFIX: "instances.test",
    },
    d1Databases: { CONTROL_PLANE_DB: "praetorium-t14-control-plane" },
    d1Persist: path.join(persistenceRoot, "d1"),
    durableObjects: {
      REPOSITORY_COORDINATOR: {
        className: "RepositoryCoordinator",
        useSQLite: true,
      },
    },
    durableObjectsPersist: path.join(persistenceRoot, "durable-objects"),
    defaultPersistRoot: path.join(persistenceRoot, "other-storage"),
  });
}

function gatewayHeaders(secret) {
  return {
    [gatewayAuthHeader]: secret,
    "content-type": "application/json",
  };
}

async function postJson(
  miniflare,
  route,
  secret,
  payload,
  authorizationHeader = gatewayAuthHeader,
) {
  const headers = { "content-type": "application/json", [authorizationHeader]: secret };
  if (authorizationHeader === "Authorization") headers.Authorization = `Bearer ${secret}`;
  const response = await miniflare.dispatchFetch(`https://control-plane.test${route}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  const bodyText = await response.text();
  let body;
  try {
    body = bodyText.length > 0 ? JSON.parse(bodyText) : null;
  } catch {
    assert.fail(`Control Plane returned non-JSON from ${route}: ${bodyText.slice(0, 256)}`);
  }
  return { response, body };
}

async function resolveRepository(miniflare, secret, actorId, idempotencyKey) {
  return postJson(miniflare, "/v1/repositories/resolve", secret, {
    ...testRepository,
    actorId,
    idempotencyKey,
  });
}

async function assertRepositoryBinding(miniflare, secret, instanceId) {
  const response = await miniflare.dispatchFetch(
    `https://control-plane.test/v1/repositories/${testRepository.repositoryId}`,
    { headers: gatewayHeaders(secret) },
  );
  assert.equal(response.status, 200, "repository read survives the Worker restart");
  const snapshot = await response.json();
  assert.equal(snapshot.binding.repositoryId, testRepository.repositoryId);
  assert.equal(snapshot.binding.instanceId, instanceId);
  assert.equal(snapshot.instance.instanceId, instanceId);
  return snapshot;
}

test("production Control Plane Worker uses migrated D1 and persistent repository Durable Object", async () => {
  await assertOwnedDisposableInventory();
  const workerInfo = await stat(workerEntryPath).catch(() => null);
  assert.ok(
    workerInfo?.isFile(),
    "apps/control-plane/src/worker.ts must exist; the acceptance runner does not substitute an app fixture",
  );
  const workerConfig = await readFile(workerConfigPath, "utf8");
  const compatibilityDateMatch = workerConfig.match(
    /^compatibility_date\s*=\s*"(\d{4}-\d{2}-\d{2})"\s*$/m,
  );
  assert.ok(
    compatibilityDateMatch,
    "apps/control-plane/wrangler.toml must declare the production Worker compatibility date",
  );
  const compatibilityFlagsMatch = workerConfig.match(
    /^compatibility_flags\s*=\s*(\[[^\]]*\])\s*$/m,
  );
  assert.ok(
    compatibilityFlagsMatch,
    "apps/control-plane/wrangler.toml must declare the production Worker compatibility flags",
  );
  const compatibilityFlags = JSON.parse(compatibilityFlagsMatch[1]);
  assert.ok(Array.isArray(compatibilityFlags));
  assert.ok(
    compatibilityFlags.includes("nodejs_compat"),
    "Control Plane Worker must enable nodejs_compat",
  );

  const migrationNames = (await readdir(migrationDirectory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.ok(migrationNames.length > 0, "Control Plane D1 SQL migrations must be present");

  const bundle = await build({
    absWorkingDir: repositoryRoot,
    entryPoints: [workerEntryPath],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    tsconfig: path.join(repositoryRoot, "apps/control-plane/tsconfig.json"),
    external: ["node:*"],
    write: false,
    logLevel: "silent",
  });
  const script = bundle.outputFiles[0]?.text;
  assert.ok(script, "esbuild must produce the actual Control Plane Worker bundle");

  const persistenceRoot = await mkdtemp(path.join(os.tmpdir(), "praetorium-t14-workers-d1-do-"));
  const secrets = {
    gateway: randomBytes(32).toString("base64url"),
    provisioner: randomBytes(32).toString("base64url"),
  };
  assert.notEqual(secrets.gateway, secrets.provisioner);
  let miniflare;

  try {
    miniflare = makeMiniflare(
      script,
      persistenceRoot,
      secrets,
      compatibilityDateMatch[1],
      compatibilityFlags,
    );
    await miniflare.ready;
    const env = await miniflare.getBindings();
    assert.ok(env.CONTROL_PLANE_DB, "production Worker D1 binding is present");
    assert.ok(env.REPOSITORY_COORDINATOR, "production Worker Durable Object binding is present");

    const database = await miniflare.getD1Database("CONTROL_PLANE_DB");
    for (const migrationName of migrationNames) {
      const migration = await readFile(path.join(migrationDirectory, migrationName), "utf8");
      assert.ok(migration.trim().length > 0, `${migrationName} must not be empty`);
      const executableSql = migration
        .split(/\r?\n/)
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n")
        .trim();
      assert.ok(executableSql.length > 0, `${migrationName} must contain executable SQL`);
      const statements = executableSql
        .split(";")
        .map((statement) => statement.trim())
        .filter((statement) => statement.length > 0);
      assert.ok(statements.length > 0, `${migrationName} must contain SQL statements`);
      for (const statement of statements) {
        await database.prepare(statement).run();
      }
    }
    const migratedTables = await database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all();
    const tableNames = new Set((migratedTables.results ?? []).map((row) => row.name));
    assert.ok(tableNames.has("repository_bindings"), "migration creates repository_bindings");
    assert.ok(tableNames.has("logical_instances"), "migration creates logical_instances");

    const health = await miniflare.dispatchFetch("https://control-plane.test/internal/health", {
      headers: gatewayHeaders(secrets.gateway),
    });
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { service: "praetorium-control-plane", status: "ok" });

    const unauthenticated = await miniflare.dispatchFetch(
      "https://control-plane.test/v1/repositories/resolve",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    assert.equal(unauthenticated.status, 401, "gateway operations require their test-only secret");

    const firstRace = await Promise.all([
      resolveRepository(miniflare, secrets.gateway, "test-actor-a", "t14-resolve-a"),
      resolveRepository(miniflare, secrets.gateway, "test-actor-b", "t14-resolve-b"),
    ]);
    assert.deepEqual(
      firstRace.map(({ response }) => response.status).sort(),
      [200, 201],
      "concurrent first access creates one repository binding and reuses it for the second actor",
    );
    const resolutions = firstRace.map(({ body }) => body);
    assert.equal(resolutions.filter((result) => result.created === true).length, 1);
    assert.equal(resolutions.filter((result) => result.created === false).length, 1);
    const instanceId = resolutions[0].binding.instanceId;
    assert.ok(typeof instanceId === "string" && instanceId.length > 0);
    for (const result of resolutions) {
      assert.equal(result.binding.repositoryId, testRepository.repositoryId);
      assert.equal(result.instance.instanceId, instanceId);
    }

    const snapshot = await assertRepositoryBinding(miniflare, secrets.gateway, instanceId);
    const desiredRequest = {
      actorId: "test-actor-a",
      expectedGeneration: snapshot.instance.generation,
      desiredState: "running",
      idempotencyKey: "t14-desired-running",
      bindingEpoch: snapshot.binding.bindingEpoch,
      authorizationRevision: snapshot.binding.authorizationRevision,
    };
    const desired = await postJson(
      miniflare,
      `/v1/instances/${instanceId}/desired`,
      secrets.gateway,
      desiredRequest,
    );
    assert.equal(desired.response.status, 200);
    assert.equal(desired.body.instance.instanceId, instanceId);
    assert.equal(typeof desired.body.replayed, "boolean");

    const replay = await postJson(
      miniflare,
      `/v1/instances/${instanceId}/desired`,
      secrets.gateway,
      desiredRequest,
    );
    assert.equal(replay.response.status, 200);
    assert.equal(
      replay.body.replayed,
      true,
      "same desired-state key replays without duplicating an operation",
    );
    assert.equal(replay.body.operation?.id ?? null, desired.body.operation?.id ?? null);

    const claim = await postJson(
      miniflare,
      "/internal/provisioner/claim",
      secrets.provisioner,
      { workerId: "test-worker", clusterId: "test-cluster", leaseSeconds: 30 },
      "Authorization",
    );
    assert.equal(claim.response.status, 200);
    assert.ok(
      claim.body === null ||
        claim.body.status === "blocked" ||
        claim.body.operation?.status === "blocked",
      "an instance without an admitted image must not yield a runnable Provisioner claim",
    );

    await miniflare.dispose();
    miniflare = makeMiniflare(
      script,
      persistenceRoot,
      secrets,
      compatibilityDateMatch[1],
      compatibilityFlags,
    );
    await miniflare.ready;
    await assertRepositoryBinding(miniflare, secrets.gateway, instanceId);

    const afterRestart = await Promise.all([
      resolveRepository(miniflare, secrets.gateway, "test-actor-c", "t14-resolve-c"),
      resolveRepository(miniflare, secrets.gateway, "test-actor-d", "t14-resolve-d"),
    ]);
    assert.ok(afterRestart.every(({ response }) => [200, 201].includes(response.status)));
    assert.equal(afterRestart.filter(({ body }) => body.created === true).length, 0);
    assert.ok(afterRestart.every(({ body }) => body.binding.instanceId === instanceId));
  } finally {
    await miniflare?.dispose();
    await rm(persistenceRoot, { recursive: true, force: true });
  }
});
