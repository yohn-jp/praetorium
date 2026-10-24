import assert from "node:assert/strict";
import { randomBytes, webcrypto } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Miniflare } from "miniflare";
import "./sigstore-workerd-compat.test.mjs";

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

async function assertEventually(predicate) {
  const deadline = Date.now() + 5_000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(predicate(), "actual Worker/DO committed work must deliver the availability hint");
}

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
    unsafeTriggerHandlers: true,
    compatibilityDate,
    compatibilityFlags,
    bindings: {
      CONTROL_PLANE_GATEWAY_AUTH: secrets.gateway,
      PROVISIONER_AUTH_TOKEN: secrets.provisioner,
      PROVISIONER_WORKER_ID: "test-worker",
      PROVISIONER_CLUSTER_ID: "test-cluster",
      GATEWAY_ORIGIN: "https://gateway.test",
      INSTANCE_HOST_SUFFIX: "instances.test",
      CONTROL_PLANE_ORIGIN: "https://control-plane.test",
      RUNTIME_IDENTITY_SIGNING_KEY: secrets.runtimeIdentityKey,
      RUNTIME_CONTROL_SIGNING_KEY: secrets.runtimeControlKey,
      PROVISIONER_WORK_NOTIFICATION_URL: "https://provisioner-notify.test/internal/work-available",
      PROVISIONER_WORK_NOTIFICATION_TOKEN: secrets.workNotification,
      ...(secrets.buildPolicy ? { BUILD_POLICY_JSON: secrets.buildPolicy } : {}),
      ...(secrets.releasePolicy
        ? {
            RELEASE_POLICY_JSON: secrets.releasePolicy,
            RELEASE_OPERATOR_TOKEN: secrets.releaseOperator,
          }
        : {}),
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
    outboundService: async (request) => {
      assert.equal(request.url, "https://provisioner-notify.test/internal/work-available");
      assert.equal(request.method, "POST");
      assert.ok(
        request.headers.get("authorization") === `Bearer ${secrets.workNotification}`,
        "notification must authenticate with its separate test-only token",
      );
      const hint = await request.json();
      assert.equal(hint.version, 1);
      assert.equal(hint.kind, "operation");
      assert.ok(Object.keys(hint).every((key) => ["version", "kind", "instanceId"].includes(key)));
      if (hint.instanceId !== undefined) assert.equal(typeof hint.instanceId, "string");
      secrets.workNotifications.push(hint);
      return new Response(null, { status: secrets.workNotificationStatus });
    },
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

function assertPublicOperation(operation, operationId, instanceId) {
  assert.equal(operation.id, operationId);
  assert.equal(operation.instanceId, instanceId);
  for (const privateField of ["leaseToken", "checkpoint", "workerId"]) {
    assert.equal(
      Object.hasOwn(operation, privateField),
      false,
      `public operation must omit ${privateField}`,
    );
  }
}

async function verifyFencedRuntimeIdentityOnRealD1(worker, gatewaySecret, provisionerSecret, instanceId) {
  // Intentionally use the migrated Miniflare D1 database, not Node's SQLite.
  // Only this disposable fixture is mutated; no external Kubernetes/Cloudflare.
  const db = await worker.getD1Database("CONTROL_PLANE_DB");
  const now = Date.now();
  const epoch = 5;
  const generation = 8;
  const operationId = "op-ci-runtime-identity-5";
  const reservationId = "res-ci-runtime-identity-5";
  const leaseToken = "ci-runtime-identity-lease-".padEnd(64, "x");
  const proof = {
    instanceId,
    repositoryId: testRepository.repositoryId,
    retiredRuntimeEpoch: null,
    providerObservationId: "ci-provider-observation-5",
    censusObservedAt: new Date(now - 1_000).toISOString(),
    remainingWriters: 0,
    evidenceIdentities: ["ci-owned-disposable-census"],
    source: "runtime-provider-census",
  };
  const absence = JSON.stringify({
    schemaVersion: 1,
    lifecycle: { instanceId, repositoryId: testRepository.repositoryId, writerAbsenceProof: proof },
    writerAbsenceProof: proof,
  });
  const current = JSON.stringify({
    schemaVersion: 1,
    lifecycle: { instanceId, repositoryId: testRepository.repositoryId, phase: "starting-target", writerAbsenceProof: proof },
    writerAbsenceProof: proof,
  });
  await db.prepare("UPDATE repository_bindings SET suspended=0 WHERE repository_id=?")
    .bind(testRepository.repositoryId).run();
  await db.prepare(
    `UPDATE logical_instances
       SET generation=?, runtime_epoch=?, observed_state='absent',
           observed_generation=NULL, observed_runtime_epoch=NULL, observed_revision_id=NULL,
           current_artifact_digest=NULL, desired_state='running',
           reservation_state='reserved', reservation_id=?, updated_at=?
     WHERE instance_id=? AND repository_id=?`,
  ).bind(generation, epoch, reservationId, now, instanceId, testRepository.repositoryId).run();
  await db.prepare(
    `INSERT INTO runtime_reservations (
       reservation_id, instance_id, repository_id, runtime_epoch, generation,
       cluster_id, status, capacity_snapshot_epoch, cpu_milli, memory_mib,
       ephemeral_storage_mib, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'test-cluster', 'reserved', 1, 100, 256, 128, ?, ?)`,
  ).bind(reservationId, instanceId, testRepository.repositoryId, epoch, generation, now - 1_000, now - 1_000).run();
  await db.prepare(
    `INSERT INTO operations (
       operation_id, instance_id, repository_id, generation, runtime_epoch, kind,
       status, phase, attempt, lease_epoch, worker_id, lease_token, lease_expires_at,
       report_sequence, checkpoint_sequence, checkpoint_json, cluster_id, reservation_id,
       idempotency_scope, idempotency_key, request_hash, actor_id,
       authorization_revision, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'redeploy',
       'running', 'old-writer-absent', 1, 4, 'test-worker', ?, ?,
       1, 1, ?, 'test-cluster', ?,
       ?, 'ci-target-lease', 'ci-target-request', '12345', 7, ?, ?)`,
  ).bind(operationId, instanceId, testRepository.repositoryId, generation, epoch,
    leaseToken, now + 60_000, absence, reservationId,
    `repo:${testRepository.repositoryId}`, now - 1_000, now).run();
  await db.prepare(
    `INSERT INTO operation_checkpoints (
       operation_id, sequence, phase, runtime_epoch, checkpoint_json, actor_id, occurred_at
     ) VALUES (?, 1, 'old-writer-absent', ?, ?, 'test-worker', ?)`,
  ).bind(operationId, epoch, absence, now - 500).run();
  // Publish authority through the production fenced retirement checkpoint path.
  // A fixture's historical evidence alone must not grant a runtime credentials.
  const checkpointFence = {
    operationId, workerId: "test-worker", leaseToken, leaseEpoch: 4,
  };
  const admitted = await postJson(worker, "/internal/provisioner/checkpoint",
    provisionerSecret, { ...checkpointFence, expectedCheckpointSequence: 0,
      phase: "old-writer-absent", checkpoint: JSON.parse(absence) }, "Authorization");
  assert.equal(admitted.response.status, 200,
    `retirement checkpoint must publish target authority: ${JSON.stringify(admitted.body)}`);
  const starting = await postJson(worker, "/internal/provisioner/checkpoint",
    provisionerSecret, { ...checkpointFence, expectedCheckpointSequence: 1,
      phase: "starting-target", checkpoint: JSON.parse(current) }, "Authorization");
  assert.equal(starting.response.status, 200);

  const bindingUrl = `https://control-plane.test/internal/runtime-bindings/${testRepository.repositoryId}`;
  const bindingResponse = await worker.dispatchFetch(bindingUrl, {
    headers: gatewayHeaders(gatewaySecret),
  });
  assert.equal(bindingResponse.status, 200, "real D1 selects the fenced post-absence target");
  assert.equal((await bindingResponse.json()).authority, "post-absence-target");
  const payload = {
    runtimeId: reservationId,
    instanceId,
    repositoryId: testRepository.repositoryId,
    installationId: testRepository.installationId,
    runtimeEpoch: epoch,
    leaseId: reservationId,
    workerId: "test-worker",
    clusterId: "test-cluster",
    operationId,
    leaseToken,
    leaseEpoch: 4,
  };
  const issued = await postJson(worker, "/internal/provisioner/runtime-identity",
    provisionerSecret, payload, "Authorization");
  assert.equal(issued.response.status, 200,
    `real Workerd/D1 must issue a fenced target identity, got ${JSON.stringify(issued.body)}`);
  assert.equal(typeof issued.body.token, "string");
  const stale = await postJson(worker, "/internal/provisioner/runtime-identity",
    provisionerSecret, { ...payload, leaseEpoch: 3 }, "Authorization");
  assert.equal(stale.response.status, 409, "wrong lease epoch must be fenced by real D1");
  const credential = {
    tokenId: "a".repeat(64), repositoryId: testRepository.repositoryId,
    installationId: testRepository.installationId,
    instanceId: `run_${instanceId.slice(4)}_${epoch}`, runtimeId: reservationId,
    runtimeEpoch: epoch, leaseId: reservationId, permission: "read",
    expiresAt: new Date(now + 120_000).toISOString(),
    encryptedSecret: { version: 1, keyId: "owned-test-key", iv: "AAAAAAAAAAAAAAAA",
      ciphertext: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" },
  };
  const registered = await postJson(worker, "/internal/runtime-credentials", gatewaySecret, credential);
  assert.equal(registered.response.status, 200);
  assert.equal(registered.body.status, "active", "real D1 atomically admits the current physical identity");
  const { tokenId: _tokenId, expiresAt: _expiresAt, encryptedSecret: _secret, ...lookup } = credential;
  const reused = await postJson(worker, "/internal/runtime-credentials/reuse", gatewaySecret, lookup);
  assert.equal(reused.response.status, 200);
  assert.equal(reused.body.credential.tokenId, credential.tokenId, "real D1 reuses the existing ciphertext row");
  const wrongScope = await postJson(worker, "/internal/runtime-credentials/reuse", gatewaySecret,
    { ...lookup, leaseId: "stale-lease" });
  assert.equal(wrongScope.body.credential, null);
  await db.prepare("UPDATE operations SET lease_expires_at=? WHERE operation_id=?")
    .bind(now - 1, operationId).run();
  const fencedReuse = await postJson(worker, "/internal/runtime-credentials/reuse", gatewaySecret, lookup);
  assert.equal(fencedReuse.body.credential, null, "an expired authority lease cannot reuse a bearer");
  const lateRegistration = await postJson(worker, "/internal/runtime-credentials", gatewaySecret,
    { ...credential, tokenId: "b".repeat(64) });
  assert.equal(lateRegistration.body.status, "revocation_pending",
    "a late credential registration after fencing is durably pending, never active");
  const expired = await postJson(worker, "/internal/provisioner/runtime-identity",
    provisionerSecret, payload, "Authorization");
  assert.equal(expired.response.status, 409, "expired operation lease must be rejected");
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

  const bundleRoot = await mkdtemp(path.join(os.tmpdir(), "praetorium-t14-worker-bundle-"));
  let script;
  try {
    // Use the actual deploy bundler: nodejs_compat includes CommonJS builtin
    // interop required by the real Sigstore provider. No provider is stubbed.
    await promisify(execFile)(
      process.execPath,
      [
        path.join(repositoryRoot, "apps/control-plane/node_modules/wrangler/bin/wrangler.js"),
        "deploy",
        "--dry-run",
        "--outdir",
        bundleRoot,
      ],
      {
        cwd: path.dirname(workerConfigPath),
        env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
        timeout: 60000,
        maxBuffer: 1024 * 1024,
      },
    );
    script = await readFile(path.join(bundleRoot, "worker.js"), "utf8");
  } finally {
    await rm(bundleRoot, { recursive: true, force: true });
  }
  assert.ok(script, "Wrangler dry-run must produce the actual Control Plane Worker bundle");

  const healthWorker = new Miniflare({
    script,
    modules: true,
    compatibilityDate: compatibilityDateMatch[1],
    compatibilityFlags,
  });
  try {
    const health = await healthWorker.dispatchFetch("https://control-plane.test/healthz");
    assert.equal(health.status, 200, "liveness must not require any environment binding");
    assert.equal(health.headers.get("cache-control"), "no-store");
    assert.deepEqual(await health.json(), { status: "ok" });
  } finally {
    await healthWorker.dispose();
  }

  const persistenceRoot = await mkdtemp(path.join(os.tmpdir(), "praetorium-t14-workers-d1-do-"));
  const identityKey = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const controlKey = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const secrets = {
    gateway: randomBytes(32).toString("base64url"),
    provisioner: randomBytes(32).toString("base64url"),
    workNotification: randomBytes(32).toString("base64url"),
    workNotifications: [],
    workNotificationStatus: 503,
    runtimeIdentityKey: JSON.stringify({
      kid: "t14-owned-runtime-identity",
      privateKeyJwk: await webcrypto.subtle.exportKey("jwk", identityKey.privateKey),
    }),
    runtimeControlKey: JSON.stringify({
      kid: "t14-owned-runtime-control",
      privateKeyJwk: await webcrypto.subtle.exportKey("jwk", controlKey.privateKey),
    }),
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
    const identityJwksResponse = await miniflare.dispatchFetch(
      "https://control-plane.test/.well-known/runtime-identity-jwks.json",
    );
    assert.equal(identityJwksResponse.status, 200);
    const identityJwks = await identityJwksResponse.json();
    assert.equal(identityJwks.keys.length, 1);
    assert.deepEqual(Object.keys(identityJwks.keys[0]).sort(), [
      "alg",
      "crv",
      "kid",
      "kty",
      "use",
      "x",
      "y",
    ]);
    assert.equal(identityJwks.keys[0].kid, "t14-owned-runtime-identity");
    const privateBindingUrl = `https://control-plane.test/internal/runtime-bindings/${testRepository.repositoryId}`;
    assert.equal((await miniflare.dispatchFetch(privateBindingUrl)).status, 401);
    assert.equal(
      (
        await miniflare.dispatchFetch(privateBindingUrl, {
          headers: gatewayHeaders(secrets.gateway),
        })
      ).status,
      404,
      "no reservation or writer cannot become an active runtime binding",
    );
    assert.equal(
      (await postJson(miniflare, "/internal/provisioner/runtime-identity", secrets.gateway, {}))
        .response.status,
      401,
      "Gateway authority cannot mint runtime service identities",
    );

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
    const initialDashboardResponse = await miniflare.dispatchFetch(
      `https://control-plane.test/v1/instances/${instanceId}/dashboard`,
      { headers: gatewayHeaders(secrets.gateway) },
    );
    assert.equal(initialDashboardResponse.status, 200);
    const initialDashboard = await initialDashboardResponse.json();
    assert.equal(initialDashboard.snapshot.instance.instanceId, instanceId);
    assert.equal(initialDashboard.current, null);
    assert.equal(initialDashboard.desired, null);
    assert.deepEqual(initialDashboard.operations, []);
    assert.deepEqual(initialDashboard.releases, []);

    const releasesResponse = await miniflare.dispatchFetch(
      "https://control-plane.test/v1/releases",
      { headers: gatewayHeaders(secrets.gateway) },
    );
    assert.equal(releasesResponse.status, 200);
    assert.deepEqual(await releasesResponse.json(), { releases: [] });
    const disabledReleaseAdmission = await miniflare.dispatchFetch(
      "https://control-plane.test/v1/operator/releases",
      { method: "POST" },
    );
    assert.equal(
      disabledReleaseAdmission.status,
      503,
      "missing operator policy is an explicit unavailable gate",
    );
    const disabledConfiguration = await postJson(
      miniflare,
      `/v1/instances/${instanceId}/configuration`,
      secrets.gateway,
      {},
    );
    assert.equal(
      disabledConfiguration.response.status,
      503,
      "no build policy cannot silently configure an instance",
    );

    const desiredRequest = {
      actorId: "test-actor-a",
      expectedGeneration: snapshot.instance.generation,
      desiredState: "running",
      idempotencyKey: "t14-desired-running",
      bindingEpoch: snapshot.binding.bindingEpoch,
      authorizationRevision: snapshot.binding.authorizationRevision,
    };
    assert.equal(
      secrets.workNotifications.length,
      0,
      "reads and rejected configuration send no work hints",
    );
    const desired = await postJson(
      miniflare,
      `/v1/instances/${instanceId}/desired`,
      secrets.gateway,
      desiredRequest,
    );
    assert.equal(desired.response.status, 200);
    assert.equal(desired.body.instance.instanceId, instanceId);
    assert.equal(typeof desired.body.replayed, "boolean");
    const operationId = desired.body.operation?.id;
    assert.ok(typeof operationId === "string" && operationId.length > 0);
    await assertEventually(() => secrets.workNotifications.length > 0);
    assert.deepEqual(secrets.workNotifications[0], { version: 1, kind: "operation", instanceId });
    // The notification endpoint deliberately failed; the committed operation
    // must remain readable and claimable from D1 independently of delivery.
    secrets.workNotificationStatus = 202;

    const publicOperationResponse = await miniflare.dispatchFetch(
      `https://control-plane.test/v1/operations/${operationId}`,
      { headers: gatewayHeaders(secrets.gateway) },
    );
    assert.equal(publicOperationResponse.status, 200);
    assertPublicOperation(await publicOperationResponse.json(), operationId, instanceId);

    const activeDashboardResponse = await miniflare.dispatchFetch(
      `https://control-plane.test/v1/instances/${instanceId}/dashboard`,
      { headers: gatewayHeaders(secrets.gateway) },
    );
    assert.equal(activeDashboardResponse.status, 200);
    const activeDashboard = await activeDashboardResponse.json();
    assert.equal(activeDashboard.operations.length, 1);
    assertPublicOperation(activeDashboard.operations[0], operationId, instanceId);

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

    const idlePointRequest = { workerId: "test-worker", clusterId: "test-cluster", instanceId };
    const idlePoint = await postJson(
      miniflare,
      "/internal/provisioner/idle-candidate",
      secrets.provisioner,
      idlePointRequest,
      "Authorization",
    );
    assert.equal(idlePoint.response.status, 200);
    assert.equal(idlePoint.body, null, "pending unadmitted runtime is not an idle candidate");
    const wrongWorker = await postJson(
      miniflare,
      "/internal/provisioner/idle-candidate",
      secrets.provisioner,
      { ...idlePointRequest, workerId: "another-worker" },
      "Authorization",
    );
    assert.equal(wrongWorker.response.status, 403);
    const healthDue = await postJson(
      miniflare,
      "/internal/provisioner/runtime-health-due",
      secrets.provisioner,
      {
        ...idlePointRequest,
        repositoryId: testRepository.repositoryId,
        expectedGeneration: desired.body.instance.generation,
        expectedRuntimeEpoch: desired.body.instance.runtimeEpoch,
      },
      "Authorization",
    );
    assert.equal(healthDue.response.status, 200);
    assert.deepEqual(healthDue.body, {
      active: false,
      nextCheckAt: null,
      sampleDueAt: null,
      healthOperationId: null,
    });

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

    // This is the private, Gateway-verified metadata boundary. Raw HMAC is
    // tested separately; no real GitHub delivery or App acceptance is claimed.
    const delivery = {
      deliveryId: "t14-worker-delivery",
      bodyDigest: "a".repeat(64),
      event: "installation_repositories",
      action: "removed",
      installationId: testRepository.installationId,
      repositoryIds: [],
      repositorySelection: "selected",
    };
    const webhook = await postJson(
      miniflare,
      "/internal/github/webhook",
      secrets.gateway,
      delivery,
    );
    assert.equal(webhook.response.status, 202);
    const duplicate = await postJson(
      miniflare,
      "/internal/github/webhook",
      secrets.gateway,
      delivery,
    );
    assert.equal(duplicate.response.status, 200);
    const conflict = await postJson(miniflare, "/internal/github/webhook", secrets.gateway, {
      ...delivery,
      bodyDigest: "b".repeat(64),
    });
    assert.equal(conflict.response.status, 409);
    const suspended = await miniflare.dispatchFetch(
      `https://control-plane.test/v1/repositories/${testRepository.repositoryId}`,
      { headers: gatewayHeaders(secrets.gateway) },
    );
    assert.equal(suspended.status, 200);
    assert.equal((await suspended.json()).binding.suspended, true);
    const auditPath = `https://control-plane.test/v1/instances/${instanceId}/audit?limit=1`;
    const auditResponse = await miniflare.dispatchFetch(auditPath, {
      headers: gatewayHeaders(secrets.gateway),
    });
    assert.equal(auditResponse.status, 200);
    const audit = await auditResponse.json();
    assert.equal(audit.events.length, 1);
    assert.equal(audit.events[0].instanceId, instanceId);
    assert.equal(typeof audit.nextCursor, "string");
    assert.ok(!JSON.stringify(audit).includes("leaseToken"));
    assert.ok(!JSON.stringify(audit).includes("checkpoint_json"));
    const auditNext = await miniflare.dispatchFetch(
      `${auditPath}&cursor=${encodeURIComponent(audit.nextCursor)}`,
      {
        headers: gatewayHeaders(secrets.gateway),
      },
    );
    assert.equal(auditNext.status, 200);
    const nextPage = await auditNext.json();
    assert.equal(nextPage.events.length, 1);
    assert.notEqual(nextPage.events[0].eventId, audit.events[0].eventId);

    // Exercise the real release composition constructor and isolated operator
    // entry with owned local keys; no real producer manifest is fabricated.
    await miniflare.dispose();
    const builderKey = await webcrypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const releaseOperator = randomBytes(32).toString("base64url");
    const buildPolicy = JSON.stringify({
      registryUrl: "https://registry.test",
      allowedRepositories: ["praetorium-t14/output"],
      outputRepository: "praetorium-t14/output",
      maxImageLayerBytes: 1048576,
      cacheRetention: { maxBytes: 1048576, maxEntries: 32, minAgeMs: 0, maxEvictions: 8 },
      maxImageVerificationMs: 5000,
      maxRegistryRequestMs: 1000,
      runtimeResourceLimits: { cpuMilli: 1000, memoryMiB: 1024, ephemeralStorageMiB: 1024 },
      targetPlatform: "linux/amd64",
      builderKeys: [
        {
          keyId: "t14-owned-builder",
          publicKeyBase64: Buffer.from(
            await webcrypto.subtle.exportKey("raw", builderKey.publicKey),
          ).toString("base64"),
        },
      ],
    });
    miniflare = makeMiniflare(
      script,
      persistenceRoot,
      {
        ...secrets,
        releaseOperator,
        buildPolicy,
        releasePolicy: JSON.stringify({
          workerId: "t14-owned-release-worker",
          clusterId: "test-cluster",
          operatorActorId: "t14-owned-operator",
          canaryProbeActorId: 12345,
          signerIdentityAllowlist: [{ subjectAlternativeName: "t14-owned-producer@test.invalid" }],
          canary: {
            owner: "sophia uid=1000",
            disposable: true,
            production: false,
            repositoryId: testRepository.repositoryId,
            instanceId,
            bindingEpoch: snapshot.binding.bindingEpoch,
            authorizationRevision: snapshot.binding.authorizationRevision,
            requestedModules: [],
            resourceProfileId: "t14-small",
          },
        }),
      },
      compatibilityDateMatch[1],
      compatibilityFlags,
    );
    await miniflare.ready;
    const operatorPath = "/v1/operator/releases";
    assert.equal(
      (await postJson(miniflare, operatorPath, secrets.gateway, {})).response.status,
      403,
      "Gateway service authority is not operator release authority",
    );
    assert.equal(
      (await postJson(miniflare, operatorPath, secrets.provisioner, {}, "Authorization")).response
        .status,
      403,
      "Provisioner service authority is not operator release authority",
    );
    assert.equal(
      (await postJson(miniflare, operatorPath, releaseOperator, {}, "Authorization")).response
        .status,
      422,
      "operator authority reaches real admission but cannot admit a malformed manifest",
    );
    // Optional release policy must not fail unrelated maintenance. Periodic
    // recovery must not append unchanged advisory cache-GC plans.
    await miniflare.dispose();
    miniflare = makeMiniflare(
      script,
      persistenceRoot,
      { ...secrets, buildPolicy },
      compatibilityDateMatch[1],
      compatibilityFlags,
    );
    await miniflare.ready;
    const scheduledResponse = await miniflare.dispatchFetch(
      "https://control-plane.test/cdn-cgi/handler/scheduled?cron=*%2F5%20*%20*%20*%20*",
    );
    assert.equal(scheduledResponse.status, 200, "disabled release policy permits maintenance");
    const maintenanceDb = await miniflare.getD1Database("CONTROL_PLANE_DB");
    const maintenance = await maintenanceDb
      .prepare(
        "SELECT metadata_json FROM audit_events WHERE action='build-cache.gc.planned' ORDER BY occurred_at DESC LIMIT 1",
      )
      .first();
    assert.equal(maintenance, null, "scheduled recovery does not append advisory GC audits");
    await verifyFencedRuntimeIdentityOnRealD1(miniflare, secrets.gateway, secrets.provisioner, instanceId);
  } finally {
    await miniflare?.dispose();
    await rm(persistenceRoot, { recursive: true, force: true });
  }
});
