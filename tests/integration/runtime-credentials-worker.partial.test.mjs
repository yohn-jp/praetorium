import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes, webcrypto } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { Miniflare } from "miniflare";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ownedEvidencePaths = [
  "tests/integration/runtime-credentials-worker.partial.test.mjs",
  "docs/verification/RUNTIME-CREDENTIALS-PARTIAL.md",
];
const gatewayAuthHeader = "X-Control-Plane-Gateway-Auth";
const promisifiedExecFile = promisify(execFile);

function assertCleanProductionTree() {
  const checkedHead = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  const status = execFileSync(
    "git",
    [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--",
      ".",
      ...ownedEvidencePaths.map((file) => `:(exclude)${file}`),
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(
    status,
    "",
    "the current committed production tree must be clean except for this test and its evidence note",
  );
  return checkedHead;
}

function gatewayHeaders(secret) {
  return { [gatewayAuthHeader]: secret, "content-type": "application/json" };
}

async function jsonResponse(response) {
  const text = await response.text();
  assert.ok(text.length > 0, "Control Plane response must be JSON");
  return JSON.parse(text);
}

async function postControlPlane(miniflare, route, secret, payload) {
  const response = await miniflare.dispatchFetch(`https://control-plane.test${route}`, {
    method: "POST",
    headers: gatewayHeaders(secret),
    body: JSON.stringify(payload),
  });
  return { response, body: await jsonResponse(response) };
}

function makeControlPlaneWorker(
  script,
  persistenceRoot,
  gatewaySecret,
  retirementSecret,
  provisionerSecret,
  gatewayService,
  date,
  flags,
) {
  return new Miniflare({
    name: "praetorium-runtime-credential-partial",
    script,
    modules: true,
    compatibilityDate: date,
    compatibilityFlags: flags,
    bindings: {
      CONTROL_PLANE_GATEWAY_AUTH: gatewaySecret,
      RUNTIME_CREDENTIAL_RETIREMENT_AUTH: retirementSecret,
      PROVISIONER_AUTH_TOKEN: provisionerSecret,
      PROVISIONER_WORKER_ID: "owned-partial-provisioner",
      PROVISIONER_CLUSTER_ID: "owned-partial-cluster",
    },
    serviceBindings: { GATEWAY_SERVICE: gatewayService },
    d1Databases: { CONTROL_PLANE_DB: "praetorium-runtime-credential-partial" },
    d1Persist: path.join(persistenceRoot, "d1"),
    durableObjects: {
      REPOSITORY_COORDINATOR: { className: "RepositoryCoordinator", useSQLite: true },
    },
    durableObjectsPersist: path.join(persistenceRoot, "durable-objects"),
    defaultPersistRoot: path.join(persistenceRoot, "other-storage"),
  });
}

async function migrate(database, migrationDirectory) {
  const names = (await readdir(migrationDirectory)).filter((name) => name.endsWith(".sql")).sort();
  assert.deepEqual(names, [
    "0001_repository_platform.sql",
    "0002_stable_release_rollouts.sql",
    "0003_staged_configurations.sql",
    "0004_runtime_git_credentials.sql",
  ]);
  for (const name of names) {
    const source = await readFile(path.join(migrationDirectory, name), "utf8");
    const executable = source
      .split(/\r?\n/u)
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n")
      .trim();
    assert.notEqual(executable, "", `${name} contains SQL after full-line comments are removed`);
    for (const statement of executable
      .split(";")
      .map((sql) => sql.trim())
      .filter(Boolean)) {
      await database.prepare(statement).run();
    }
  }
}

function runtimeCredentialContext(metadata) {
  return JSON.stringify([
    "praetorium-runtime-git-credential:v1",
    metadata.tokenId,
    metadata.repositoryId,
    metadata.installationId,
    metadata.instanceId,
    metadata.runtimeId,
    metadata.runtimeEpoch,
    metadata.leaseId,
    metadata.permission,
    metadata.expiresAt,
  ]);
}

async function seedActiveRuntimeCredential(database, tokenVault, input) {
  const expiresAt = new Date(Date.now() + 3_000_000).toISOString();
  const tokenId = await sha256Hex(input.token);
  const metadata = {
    tokenId,
    repositoryId: input.repositoryId,
    installationId: input.installationId,
    instanceId: input.instanceId,
    runtimeId: input.runtimeId,
    runtimeEpoch: input.runtimeEpoch,
    leaseId: input.leaseId,
    permission: "read",
    expiresAt,
  };
  const encryptedSecret = await tokenVault.seal(input.token, runtimeCredentialContext(metadata));
  const now = Date.now();
  await database
    .prepare(
      `INSERT INTO runtime_git_credentials (
         token_id, repository_id, installation_id, instance_id, runtime_id,
         runtime_epoch, lease_id, permission, expires_at, encrypted_secret_json,
         status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    )
    .bind(
      tokenId,
      metadata.repositoryId,
      metadata.installationId,
      metadata.instanceId,
      metadata.runtimeId,
      metadata.runtimeEpoch,
      metadata.leaseId,
      metadata.permission,
      Date.parse(expiresAt),
      JSON.stringify(encryptedSecret),
      now,
      now,
    )
    .run();
  return { tokenId, expiresAt };
}

async function seedRunningOperation(database, input) {
  const now = Date.now();
  await database
    .prepare(
      `INSERT INTO operations (
         operation_id, instance_id, repository_id, generation, runtime_epoch, kind,
         status, phase, attempt, lease_epoch, worker_id, lease_token, lease_expires_at,
         cluster_id, idempotency_scope, idempotency_key, request_hash, actor_id,
         authorization_revision, created_at, updated_at
       ) VALUES (?, ?, ?, 0, ?, 'stop', 'running', 'accepted', 1, 1, ?, ?, ?,
         'owned-partial-cluster', ?, ?, ?, 'owned-partial-probe', 1, ?, ?)`,
    )
    .bind(
      input.operationId,
      input.instanceId,
      input.repositoryId,
      input.runtimeEpoch,
      input.workerId,
      input.leaseToken,
      now + 60_000,
      `repo:${input.repositoryId}`,
      input.operationId,
      "a".repeat(64),
      now,
      now,
    )
    .run();
}

async function postProvisionerCheckpoint(miniflare, secret, input) {
  return miniflare.dispatchFetch("https://control-plane.test/internal/provisioner/checkpoint", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
  });
}

function syntheticWriterAbsenceProof(instanceId, repositoryId, retiredRuntimeEpoch, suffix) {
  return {
    instanceId,
    repositoryId,
    retiredRuntimeEpoch,
    providerObservationId: `synthetic-owned-census-${suffix}`,
    censusObservedAt: new Date().toISOString(),
    remainingWriters: 0,
    evidenceIdentities: [],
    source: "runtime-provider-census",
  };
}

test(
  "actual Control Plane Worker stores encrypted runtime credentials and fails closed until GitHub revocation is acknowledged (partial)",
  { timeout: 60_000 },
  async (t) => {
    const checkedHead = assertCleanProductionTree();

    const controlPlaneDirectory = path.join(repositoryRoot, "apps/control-plane");
    const workerConfigPath = path.join(controlPlaneDirectory, "wrangler.toml");
    const workerConfig = await readFile(workerConfigPath, "utf8");
    const dateMatch = workerConfig.match(/^compatibility_date\s*=\s*"(\d{4}-\d{2}-\d{2})"\s*$/mu);
    const flagsMatch = workerConfig.match(/^compatibility_flags\s*=\s*(\[[^\]]*\])\s*$/mu);
    assert.ok(dateMatch, "actual Control Plane Wrangler config declares a compatibility date");
    assert.ok(flagsMatch, "actual Control Plane Wrangler config declares compatibility flags");
    const compatibilityFlags = JSON.parse(flagsMatch[1]);
    assert.ok(compatibilityFlags.includes("nodejs_compat"));

    const bundleRoot = await mkdtemp(
      path.join(os.tmpdir(), "praetorium-runtime-credential-bundle-"),
    );
    const persistenceRoot = await mkdtemp(
      path.join(os.tmpdir(), "praetorium-runtime-credential-worker-"),
    );
    const gatewaySecret = randomBytes(32).toString("base64url");
    const retirementSecret = randomBytes(32).toString("base64url");
    const provisionerSecret = randomBytes(32).toString("base64url");
    assert.equal(new Set([gatewaySecret, retirementSecret, provisionerSecret]).size, 3);
    let miniflare;
    let githubServer;
    let serverAddress;
    let registryForRetirement;
    const githubRequests = [];
    const controlPlaneRequests = [];
    const gatewayServiceRequests = [];
    const gatewayService = async (request) => {
      const url = new URL(request.url);
      const authorization = request.headers.get("Authorization");
      const payload = await request.json();
      const authorized = authorization === `Bearer ${retirementSecret}`;
      gatewayServiceRequests.push({ origin: url.origin, path: url.pathname, authorized, payload });
      if (!authorized) return Response.json({ complete: false }, { status: 401 });
      if (!registryForRetirement) return Response.json({ complete: false }, { status: 503 });
      const result = await registryForRetirement.retire(payload);
      gatewayServiceRequests.at(-1).result = result;
      return Response.json(result);
    };

    try {
      await promisifiedExecFile(
        process.execPath,
        [
          path.join(controlPlaneDirectory, "node_modules/wrangler/bin/wrangler.js"),
          "deploy",
          "--dry-run",
          "--outdir",
          bundleRoot,
        ],
        {
          cwd: controlPlaneDirectory,
          env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
          timeout: 45_000,
          maxBuffer: 1024 * 1024,
        },
      );
      const workerBundle = await readFile(path.join(bundleRoot, "worker.js"), "utf8");
      assert.ok(workerBundle.length > 0, "Wrangler dry-run produces the real Worker bundle");

      miniflare = makeControlPlaneWorker(
        workerBundle,
        persistenceRoot,
        gatewaySecret,
        retirementSecret,
        provisionerSecret,
        gatewayService,
        dateMatch[1],
        compatibilityFlags,
      );
      await miniflare.ready;
      const bindings = await miniflare.getBindings();
      assert.ok(bindings.CONTROL_PLANE_DB, "the real Worker D1 binding is available");
      assert.ok(bindings.REPOSITORY_COORDINATOR, "the real Worker Durable Object is available");
      assert.equal(typeof bindings.GATEWAY_SERVICE?.fetch, "function");
      const wrongGatewayBindingAuth = await bindings.GATEWAY_SERVICE.fetch(
        "https://gateway.internal/internal/github/retire",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer wrong-owned-test-secret",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ repositoryId: 1, runtimeEpoch: 1 }),
        },
      );
      assert.equal(wrongGatewayBindingAuth.status, 401);
      assert.equal(gatewayServiceRequests.length, 1);
      gatewayServiceRequests.length = 0;
      const database = await miniflare.getD1Database("CONTROL_PLANE_DB");
      await migrate(database, path.join(controlPlaneDirectory, "migrations"));

      const repositoryId = 1_800_000_000 + randomBytes(3).readUIntBE(0, 3);
      const installationId = repositoryId + 1;
      const resolved = await postControlPlane(
        miniflare,
        "/v1/repositories/resolve",
        gatewaySecret,
        {
          repositoryId,
          installationId,
          owner: "praetorium-partial-test",
          name: `credential-retirement-${randomBytes(4).toString("hex")}`,
          authorizationRevision: 1,
          actorId: "owned-local-partial-probe",
          idempotencyKey: randomBytes(16).toString("hex"),
        },
      );
      assert.equal(resolved.response.status, 201);
      const instanceId = resolved.body.binding.instanceId;
      assert.equal(typeof instanceId, "string");

      const state = await database
        .prepare(
          `SELECT desired_state, observed_state, observed_runtime_epoch,
                  current_artifact_digest, reservation_state
             FROM logical_instances WHERE instance_id = ?`,
        )
        .bind(instanceId)
        .first();
      assert.deepEqual(state, {
        desired_state: "stopped",
        observed_state: "absent",
        observed_runtime_epoch: null,
        current_artifact_digest: null,
        reservation_state: "none",
      });

      // This synthetic released row only satisfies the real pending-query route's
      // historical-epoch check. It is not a runtime lease or writer-absence proof.
      await database
        .prepare(
          `INSERT INTO runtime_reservations (
             reservation_id, instance_id, repository_id, runtime_epoch, generation,
             cluster_id, status, capacity_snapshot_epoch, cpu_milli, memory_mib,
             ephemeral_storage_mib, created_at, updated_at
           ) VALUES (?, ?, ?, 1, 0, NULL, 'released', 1, 0, 0, 0, ?, ?)`,
        )
        .bind(`synthetic-released-${instanceId}`, instanceId, repositoryId, Date.now(), Date.now())
        .run();
      const released = await database
        .prepare(
          "SELECT status, cluster_id FROM runtime_reservations WHERE repository_id = ? AND runtime_epoch = 1",
        )
        .bind(repositoryId)
        .first();
      assert.deepEqual(released, { status: "released", cluster_id: null });

      const bindingLookup = await miniflare.dispatchFetch(
        `https://control-plane.test/internal/runtime-bindings/${repositoryId}`,
        { headers: gatewayHeaders(gatewaySecret) },
      );
      assert.equal(
        bindingLookup.status,
        404,
        "the actual runtime binding reader reports no active binding",
      );
      const unauthenticated = await miniflare.dispatchFetch(
        "https://control-plane.test/internal/runtime-credentials/pending",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ repositoryId, runtimeEpoch: 1 }),
        },
      );
      assert.equal(unauthenticated.status, 401, "credential routes require Gateway service auth");
      const wrongServiceAuth = await miniflare.dispatchFetch(
        "https://control-plane.test/internal/runtime-credentials/pending",
        {
          method: "POST",
          headers: gatewayHeaders(randomBytes(32).toString("base64url")),
          body: JSON.stringify({ repositoryId, runtimeEpoch: 1 }),
        },
      );
      assert.equal(
        wrongServiceAuth.status,
        401,
        "incorrect Gateway service auth is rejected by the Worker",
      );

      let githubMode = "204";
      githubServer = createServer((request, response) => {
        githubRequests.push({
          mode: githubMode,
          method: request.method,
          path: request.url,
          authorization: request.headers.authorization,
        });
        if (githubMode === "timeout") return;
        if (githubMode === "network-failure") {
          request.socket.destroy();
          return;
        }
        response.statusCode = githubMode === "401" ? 401 : 204;
        if (githubMode === "401") {
          response.setHeader("content-type", "application/json");
          response.end("{}");
        } else {
          response.end();
        }
      });
      await new Promise((resolve, reject) => {
        githubServer.once("error", reject);
        githubServer.listen(0, "127.0.0.1", resolve);
      });
      serverAddress = githubServer.address();
      assert.ok(serverAddress && typeof serverAddress === "object");

      const [
        { createTokenVault, importTokenEncryptionKey },
        { createGitHubRestClient },
        { createGitHubInstallationTokenRevoker },
        { createRuntimeCredentialRegistry },
      ] = await Promise.all([
        import(path.join(repositoryRoot, "packages/auth/dist/token-vault.js")),
        import(path.join(repositoryRoot, "plugins/github/dist/api.js")),
        import(path.join(repositoryRoot, "plugins/github/dist/installation-token.js")),
        import(
          path.join(repositoryRoot, "apps/gateway/dist/adapters/runtime-credential-registry.js")
        ),
      ]);
      const realGitHubClient = createGitHubRestClient({
        requestTimeoutMs: 200,
        fetchImpl: async (input, init) => {
          const url = new URL(input);
          assert.equal(
            url.origin,
            "https://api.github.com",
            "actual client pins GitHub API origin",
          );
          assert.equal(url.pathname, "/installation/token");
          assert.equal(init.method, "DELETE", "the actual revoker uses DELETE");
          return fetch(`http://127.0.0.1:${serverAddress.port}${url.pathname}`, init);
        },
      });
      const revoker = createGitHubInstallationTokenRevoker({ client: realGitHubClient });
      const encryptionKey = await importTokenEncryptionKey(randomBytes(32));
      const tokenVault = createTokenVault(
        [{ id: "owned-partial-test-key", key: encryptionKey }],
        "owned-partial-test-key",
      );
      const controlPlane = {
        async fetch(input, init) {
          const url = new URL(input instanceof Request ? input.url : input);
          assert.equal(
            url.origin,
            "https://control-plane.internal",
            "actual Gateway registry pins the CP origin",
          );
          assert.equal(
            url.search,
            "",
            "Control Plane credential requests never put values in a URL",
          );
          const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
          const body =
            input instanceof Request ? await input.clone().text() : String(init?.body ?? "");
          const auth = headers.get(gatewayAuthHeader);
          const recordedRequest = { path: url.pathname, auth, body };
          controlPlaneRequests.push(recordedRequest);
          assert.equal(
            auth,
            gatewaySecret,
            "Gateway sends its bound service auth to the real CP Worker",
          );
          const response = await miniflare.dispatchFetch(
            `https://control-plane.test${url.pathname}`,
            {
              ...(input instanceof Request ? { method: input.method } : {}),
              ...init,
              headers,
              ...(input instanceof Request && input.method !== "GET"
                ? { body: await input.clone().text() }
                : {}),
            },
          );
          recordedRequest.status = response.status;
          return response;
        },
      };
      const registry = createRuntimeCredentialRegistry({
        controlPlane,
        controlPlaneGatewayAuth: gatewaySecret,
        tokenVault,
        revoker,
        timeoutMs: 500,
        now: () => new Date(),
      });
      registryForRetirement = registry;

      const identity = {
        repositoryId,
        installationId,
        instanceId,
        runtimeId: "synthetic-runtime-id",
        runtimeEpoch: 1,
        leaseId: "synthetic-lease-id",
      };
      const makeCredential = (token) => ({
        token,
        expiresAt: new Date(Date.now() + 3_000_000).toISOString(),
        installationId,
        repositoryId,
        permission: "read",
      });
      const token204 = `ghs_owned_partial_204_${randomBytes(18).toString("hex")}`;
      githubMode = "204";
      assert.equal(await registry.recordIssued(identity, makeCredential(token204)), false);
      const firstRow = await database
        .prepare(
          "SELECT status, encrypted_secret_json FROM runtime_git_credentials WHERE token_id = ?",
        )
        .bind(await sha256Hex(token204))
        .first();
      assert.equal(firstRow.status, "revoked", "inactive registration is revoked before returning");
      assert.ok(!firstRow.encrypted_secret_json.includes(token204));

      const tokenPending = `ghs_owned_partial_pending_${randomBytes(18).toString("hex")}`;
      githubMode = "401";
      await assert.rejects(
        registry.recordIssued(identity, makeCredential(tokenPending)),
        (error) => error?.status === 401,
      );
      await assertCredentialState(database, tokenPending, "revocation_pending");

      githubMode = "timeout";
      assert.deepEqual(await registry.retire({ repositoryId, runtimeEpoch: 1 }), {
        complete: false,
      });
      await assertCredentialState(database, tokenPending, "revocation_pending");

      githubMode = "network-failure";
      assert.deepEqual(await registry.retire({ repositoryId, runtimeEpoch: 1 }), {
        complete: false,
      });
      await assertCredentialState(database, tokenPending, "revocation_pending");

      githubMode = "204";
      const completed = await registry.retire({ repositoryId, runtimeEpoch: 1 });
      if (!completed.complete) {
        t.diagnostic(
          JSON.stringify({
            pendingRouteStatuses: controlPlaneRequests.map(({ path, status }) => ({
              path,
              status,
            })),
            remainingRows: (
              await database
                .prepare(
                  "SELECT status, expires_at FROM runtime_git_credentials WHERE repository_id = ?",
                )
                .bind(repositoryId)
                .all()
            ).results,
            githubResponseModes: githubRequests.map((request) => ({
              mode: request.mode,
              token: request.authorization?.endsWith(token204)
                ? "first"
                : request.authorization?.endsWith(tokenPending)
                  ? "pending"
                  : "unknown",
            })),
          }),
        );
      }
      assert.deepEqual(completed, { complete: true });
      await assertCredentialState(database, tokenPending, "revoked");

      assert.ok(githubRequests.length >= 5);
      assert.ok(
        githubRequests.every(
          (request) => request.method === "DELETE" && request.path === "/installation/token",
        ),
      );
      assert.ok(
        githubRequests.some(
          (request) => request.mode === "401" && request.authorization === `Bearer ${tokenPending}`,
        ),
      );
      assert.ok(
        githubRequests.some(
          (request) =>
            request.mode === "timeout" && request.authorization === `Bearer ${tokenPending}`,
        ),
      );
      assert.ok(
        githubRequests.some(
          (request) =>
            request.mode === "network-failure" &&
            request.authorization === `Bearer ${tokenPending}`,
        ),
      );
      assert.ok(githubRequests.some((request) => request.authorization === `Bearer ${token204}`));
      assert.ok(
        githubRequests.some((request) => request.authorization === `Bearer ${tokenPending}`),
      );
      assert.ok(controlPlaneRequests.length >= 8);
      assert.ok(controlPlaneRequests.every((request) => request.auth === gatewaySecret));
      assert.ok(
        controlPlaneRequests.every(
          (request) => !request.body.includes(token204) && !request.body.includes(tokenPending),
        ),
      );

      const credentialRows = await database
        .prepare(
          "SELECT token_id, encrypted_secret_json, status FROM runtime_git_credentials WHERE repository_id = ?",
        )
        .bind(repositoryId)
        .all();
      const stored = JSON.stringify(credentialRows.results ?? []);
      assert.ok(
        !stored.includes(token204) && !stored.includes(tokenPending),
        "D1 contains no plaintext bearer token",
      );
      assert.equal((credentialRows.results ?? []).length, 2);

      const absenceToken = `ghs_owned_absence_barrier_${randomBytes(18).toString("hex")}`;
      await seedActiveRuntimeCredential(database, tokenVault, {
        token: absenceToken,
        repositoryId,
        installationId,
        instanceId,
        runtimeId: "synthetic-old-runtime",
        runtimeEpoch: 1,
        leaseId: "synthetic-old-lease",
      });
      await assertCredentialState(database, absenceToken, "active");

      const absenceOperationId = `op_owned_absence_${randomBytes(8).toString("hex")}`;
      const absenceLeaseToken = randomBytes(32).toString("base64url");
      await seedRunningOperation(database, {
        operationId: absenceOperationId,
        instanceId,
        repositoryId,
        runtimeEpoch: 1,
        workerId: "owned-partial-provisioner",
        leaseToken: absenceLeaseToken,
      });
      const writerAbsenceProof = syntheticWriterAbsenceProof(
        instanceId,
        repositoryId,
        1,
        "known-epoch",
      );
      const absenceCheckpoint = {
        schemaVersion: 1,
        lifecycle: {
          instanceId,
          repositoryId,
          phase: "old-writer-absent",
          writerAbsenceProof,
        },
        writerAbsenceProof,
      };
      githubMode = "401";
      const deniedCheckpoint = await postProvisionerCheckpoint(miniflare, provisionerSecret, {
        operationId: absenceOperationId,
        workerId: "owned-partial-provisioner",
        leaseToken: absenceLeaseToken,
        leaseEpoch: 1,
        expectedCheckpointSequence: 0,
        phase: "old-writer-absent",
        checkpoint: absenceCheckpoint,
      });
      const deniedBody = await jsonResponse(deniedCheckpoint);
      if (deniedCheckpoint.status !== 503)
        t.diagnostic(
          JSON.stringify({
            deniedStatus: deniedCheckpoint.status,
            deniedBody,
            gatewayBinding: await miniflare.getBindings().then((env) => ({
              exists: Boolean(env.GATEWAY_SERVICE),
              type: typeof env.GATEWAY_SERVICE,
              fetchType: typeof env.GATEWAY_SERVICE?.fetch,
            })),
            gatewayServiceCalls: gatewayServiceRequests,
            operation: await database
              .prepare(
                "SELECT phase, status, lease_epoch, checkpoint_sequence FROM operations WHERE operation_id = ?",
              )
              .bind(absenceOperationId)
              .first(),
            credential: await database
              .prepare("SELECT status FROM runtime_git_credentials WHERE token_id = ?")
              .bind(await sha256Hex(absenceToken))
              .first(),
          }),
        );
      assert.equal(
        deniedCheckpoint.status,
        503,
        "the actual Provisioner checkpoint route denies the zero-census checkpoint while a known token remains pending",
      );
      assert.equal(deniedBody.error.code, "UPSTREAM_UNAVAILABLE");
      await assertCredentialState(database, absenceToken, "revocation_pending");
      const persistedAbsence = await database
        .prepare(
          "SELECT phase, checkpoint_sequence, checkpoint_json FROM operations WHERE operation_id = ?",
        )
        .bind(absenceOperationId)
        .first();
      assert.equal(persistedAbsence.phase, "old-writer-absent");
      assert.equal(persistedAbsence.checkpoint_sequence, 1);
      assert.deepEqual(
        JSON.parse(persistedAbsence.checkpoint_json).writerAbsenceProof,
        writerAbsenceProof,
      );
      assert.deepEqual(gatewayServiceRequests.at(-1), {
        origin: "https://gateway.internal",
        path: "/internal/github/retire",
        authorized: true,
        payload: { repositoryId, runtimeEpoch: 1 },
        result: { complete: false },
      });
      assert.equal(githubRequests.at(-1).mode, "401");
      assert.equal(githubRequests.at(-1).authorization, `Bearer ${absenceToken}`);

      githubMode = "204";
      const acceptedCheckpoint = await postProvisionerCheckpoint(miniflare, provisionerSecret, {
        operationId: absenceOperationId,
        workerId: "owned-partial-provisioner",
        leaseToken: absenceLeaseToken,
        leaseEpoch: 1,
        expectedCheckpointSequence: 1,
        phase: "old-writer-absent",
        checkpoint: absenceCheckpoint,
      });
      assert.equal(acceptedCheckpoint.status, 200);
      assert.equal((await jsonResponse(acceptedCheckpoint)).phase, "old-writer-absent");
      await assertCredentialState(database, absenceToken, "revoked");
      assert.equal(gatewayServiceRequests.length, 2);
      assert.deepEqual(gatewayServiceRequests.at(-1).result, { complete: true });
      assert.equal(githubRequests.at(-1).mode, "204");
      assert.equal(githubRequests.at(-1).authorization, `Bearer ${absenceToken}`);

      const nullEpochToken = `ghs_owned_null_epoch_${randomBytes(18).toString("hex")}`;
      await seedActiveRuntimeCredential(database, tokenVault, {
        token: nullEpochToken,
        repositoryId,
        installationId,
        instanceId,
        runtimeId: "synthetic-null-epoch-runtime",
        runtimeEpoch: 1,
        leaseId: "synthetic-null-epoch-lease",
      });
      const nullEpochOperationId = `op_owned_null_epoch_${randomBytes(8).toString("hex")}`;
      const nullEpochLeaseToken = randomBytes(32).toString("base64url");
      await seedRunningOperation(database, {
        operationId: nullEpochOperationId,
        instanceId,
        repositoryId,
        runtimeEpoch: 1,
        workerId: "owned-partial-provisioner",
        leaseToken: nullEpochLeaseToken,
      });
      const nullEpochProof = syntheticWriterAbsenceProof(
        instanceId,
        repositoryId,
        null,
        "null-epoch",
      );
      const nullEpochCheckpoint = {
        schemaVersion: 1,
        lifecycle: {
          instanceId,
          repositoryId,
          phase: "old-writer-absent",
          writerAbsenceProof: nullEpochProof,
        },
        writerAbsenceProof: nullEpochProof,
      };
      const gatewayCallCountBeforeNullEpoch = gatewayServiceRequests.length;
      const noEpochCheckpoint = await postProvisionerCheckpoint(miniflare, provisionerSecret, {
        operationId: nullEpochOperationId,
        workerId: "owned-partial-provisioner",
        leaseToken: nullEpochLeaseToken,
        leaseEpoch: 1,
        expectedCheckpointSequence: 0,
        phase: "old-writer-absent",
        checkpoint: nullEpochCheckpoint,
      });
      assert.equal(noEpochCheckpoint.status, 200);
      assert.equal((await jsonResponse(noEpochCheckpoint)).phase, "old-writer-absent");
      await assertCredentialState(database, nullEpochToken, "active");
      assert.equal(
        gatewayServiceRequests.length,
        gatewayCallCountBeforeNullEpoch,
        "a null retired epoch does not invoke the Gateway retirement service",
      );

      const allCredentialRows = await database
        .prepare(
          "SELECT token_id, encrypted_secret_json, status FROM runtime_git_credentials WHERE repository_id = ?",
        )
        .bind(repositoryId)
        .all();
      const allStored = JSON.stringify(allCredentialRows.results ?? []);
      assert.ok(
        ![token204, tokenPending, absenceToken, nullEpochToken].some((token) =>
          allStored.includes(token),
        ),
        "all synthetic bearer tokens remain encrypted at rest",
      );
      assert.equal((allCredentialRows.results ?? []).length, 4);

      t.diagnostic(
        JSON.stringify({
          checkedHead,
          actualControlPlaneWorker: true,
          migrations: 4,
          actualControlPlaneCredentialRoutes: true,
          actualGatewayRegistryAndTokenVault: true,
          actualGitHubRestClientAndInstallationTokenRevoker: true,
          githubTransport: "owned localhost HTTP server; synthetic responses only",
          cases: [
            "no-active-binding registration stays pending",
            "204 acknowledgement revokes",
            "401 stays pending",
            "timeout stays pending",
            "network failure stays pending",
            "successful retry clears pending",
            "actual zero-census old-writer-absent checkpoint is denied until known token is revoked",
            "null retired epoch skips the barrier without calling Gateway",
          ],
          syntheticHistoricalReservation:
            "released row inserted only to satisfy pending-route history check",
          limitations: [
            "no active runtime binding",
            "no writer-absence proof",
            "no runtime lease",
            "no artifact or producer acceptance",
            "no live GitHub App or GitHub API call",
            "no Gateway HTTP broker issuance/auth-route proof",
            "absence proof and two preexisting credential rows are synthetic test inputs",
            "no actual Kubernetes provider census or live runtime writer",
          ],
        }),
      );
    } finally {
      if (miniflare) await miniflare.dispose();
      if (githubServer) {
        githubServer.closeAllConnections?.();
        await new Promise((resolve) => githubServer.close(resolve));
      }
      await rm(bundleRoot, { recursive: true, force: true });
      await rm(persistenceRoot, { recursive: true, force: true });
    }
  },
);

async function assertCredentialState(database, token, expectedStatus) {
  const tokenId = await sha256Hex(token);
  const record = await database
    .prepare("SELECT status, encrypted_secret_json FROM runtime_git_credentials WHERE token_id = ?")
    .bind(tokenId)
    .first();
  assert.equal(record?.status, expectedStatus);
  assert.ok(record && !record.encrypted_secret_json.includes(token));
}

async function sha256Hex(value) {
  const bytes = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
