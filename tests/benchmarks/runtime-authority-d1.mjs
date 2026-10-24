/*
 * Repeatable local D1 comparison for the runtime-authority reader and hot
 * exact-scope credential reuse path. It reads the baseline SQL from git, the
 * current SQL from the exported constant, and the reuse SQL from the store.
 * Miniflare owns every database and all rows are synthetic. This script never
 * uses Wrangler, Cloudflare credentials, production D1, GitHub, or a registry.
 *
 * Once the current SQL, migration 0009, and reuse store are integrated, run:
 *   node tests/benchmarks/runtime-authority-d1.mjs
 * To compare work-in-progress sources, pass the --current-sql-path,
 * --authority-migration-path, --credential-store-path, and current caller path
 * options. Output includes local D1 rows_read/rows_written metadata and
 * local-only EXPLAIN QUERY PLAN details.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migrationDirectory = path.join(repositoryRoot, "apps/control-plane/migrations");
const options = parseArguments(process.argv.slice(2));
const baselineRef = options.baselineRef ?? "f03e239";
const currentSqlPath = path.resolve(
  repositoryRoot,
  options.currentSqlPath ?? "packages/persistence/src/d1/runtime-authority.ts",
);
const credentialStorePath = path.resolve(
  repositoryRoot,
  options.credentialStorePath ?? "packages/persistence/src/d1/runtime-git-credentials-store.ts",
);
const currentCredentialRoutesPath = path.resolve(
  repositoryRoot,
  options.currentCredentialRoutesPath ?? "apps/control-plane/src/runtime-git-credential-routes.ts",
);
const currentGatewayBrokerPath = path.resolve(
  repositoryRoot,
  options.currentGatewayBrokerPath ?? "apps/gateway/src/adapters/runtime-git-broker.ts",
);
const currentGithubBrokerPath = path.resolve(
  repositoryRoot,
  options.currentGithubBrokerPath ?? "plugins/github/src/credential-broker.ts",
);
const authorityMigrationPath = options.authorityMigrationPath
  ? path.resolve(options.authorityMigrationPath)
  : path.join(migrationDirectory, "0009_runtime_authority.sql");
const iterations = positiveInteger(options.iterations ?? "100", "iterations");
const historyOperations = positiveInteger(options.historyOperations ?? "256", "history operations");
const historyCheckpoints = positiveInteger(
  options.historyCheckpoints ?? "8",
  "history checkpoints",
);
const credentialRows = positiveInteger(options.credentialRows ?? "5000", "credential rows");
const sourceIdentity = await collectSourceIdentity({
  baselineRef,
  currentSqlPath,
  credentialStorePath,
  currentCredentialRoutesPath,
  currentGatewayBrokerPath,
  currentGithubBrokerPath,
  authorityMigrationPath,
});
const now = 1_800_000_000_000;
const targetRepositoryId = 899_998_001;
const observedRepositoryId = 899_998_002;
const targetInstanceId = "ins_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const observedInstanceId = "ins_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const targetInstallationId = 899_998_101;
const targetRuntimeEpoch = 5;
const oldRuntimeEpoch = 4;
const targetReservationId = "res_d1-workload-target-5";
const targetOperationId = "op_d1-workload-target-5";
const repeatedTokenId = "f".repeat(64);

const legacySql = extractLegacyRuntimeSql(baselineRef);
const currentSql = await extractCurrentRuntimeSql(currentSqlPath);
const reusableSql = await extractReusableCredentialSql(credentialStorePath, currentSql);
const migrations = await readMigrations(authorityMigrationPath);
const scenarioFixtures = [
  {
    name: "production-cardinality",
    historyOperations: 12,
    historyCheckpoints: 14,
    historyCheckpointCounts: [...Array(11).fill(14), 13],
    backgroundCredentialRows: 0,
    targetCredentialRows: 354,
  },
  {
    name: "stress",
    historyOperations,
    historyCheckpoints,
    historyCheckpointCounts: null,
    backgroundCredentialRows: credentialRows,
    targetCredentialRows: 201,
  },
];
assert.deepEqual(fixtureSummary(scenarioFixtures[0]), {
  bindings: 2,
  operations: 13,
  checkpoints: 169,
  credentials: 354,
  historicalOperationsForTarget: 12,
  targetCredentialRows: 354,
  backgroundCredentialRows: 0,
});

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "praetorium-runtime-authority-d1-"));
try {
  const scenarios = [];
  for (const fixture of scenarioFixtures) {
    const before = await profile(
      `${fixture.name}-before`,
      { authoritySql: legacySql, reusableSql: null, mode: "mint-every-request" },
      migrations,
      path.join(tempRoot, `${fixture.name}-before`),
      fixture,
    );
    const after = await profile(
      `${fixture.name}-after`,
      { authoritySql: currentSql, reusableSql, mode: "reuse-exact-scope" },
      migrations,
      path.join(tempRoot, `${fixture.name}-after`),
      fixture,
    );

    assert.deepEqual(after.equivalence.target, before.equivalence.target);
    assert.deepEqual(after.equivalence.observed, before.equivalence.observed);
    assert.deepEqual(after.initialFixture, before.initialFixture);
    assert.equal(before.workload.iterations, iterations);
    assert.equal(after.workload.iterations, iterations);
    assert.equal(before.workload.credentialRowsCreated, iterations);
    assert.equal(after.workload.credentialRowsCreated, 0);
    assert.equal(before.workload.credentialRowsReturned, iterations);
    assert.equal(after.workload.credentialRowsReturned, iterations);
    scenarios.push({
      fixture: fixtureSummary(fixture),
      before,
      after,
      delta: compare(before.workload, after.workload),
    });
  }

  console.log(
    JSON.stringify(
      {
        scope: "LOCAL_SYNTHETIC_MINIFLARE_D1_ONLY",
        cloudflareRemote: false,
        sourceIdentity,
        iterationsPerScenario: iterations,
        workload: {
          measuredBoundary: "Local synthetic D1 authority and credential persistence only",
          metricsSource: "Miniflare local D1 metadata; not Cloudflare production analytics",
          sameInitialFixtureBeforeAndAfter: true,
          exactRuntimeAndPermissionTupleRepeated: true,
          afterIsWarmedReuseHitOnly: true,
          firstMintAndRenewal: "EXCLUDED",
          unchangedRepositoryFetchAccessAndAuthorizationChecksSigningAndGitHubNetwork:
            "NOT_MEASURED",
        },
        scenarios,
        gates: {
          hostedCloudflareD1: "NOT_CHECKED",
          productionQueryPlan: "NOT_CHECKED",
          hostedProducerAndRegistry: "NOT_CHECKED",
          browserAcceptance: "NOT_CHECKED",
        },
      },
      null,
      2,
    ),
  );
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

async function profile(name, workloadSpec, migrationSql, persistenceRoot, fixture) {
  const miniflare = new Miniflare({
    name: `praetorium-runtime-authority-${name}`,
    script: "export default { async fetch() { return new Response('local benchmark'); } }",
    modules: true,
    compatibilityDate: "2026-07-30",
    d1Databases: { BENCH_DB: `praetorium-runtime-authority-${name}` },
    d1Persist: persistenceRoot,
    defaultPersistRoot: path.join(persistenceRoot, "other-storage"),
  });

  try {
    await miniflare.ready;
    const db = await miniflare.getD1Database("BENCH_DB");
    await applyMigrations(db, migrationSql);
    await seedFixture(db, fixture);
    const initialFixture = await readInitialFixtureSnapshot(db, fixture);

    const target = await queryAuthority(db, workloadSpec.authoritySql, targetRepositoryId);
    const observed = await queryAuthority(db, workloadSpec.authoritySql, observedRepositoryId);
    const targetResult = publicAuthority(target);
    const observedResult = publicAuthority(observed);

    const plans = {
      runtimeAuthority: await queryPlan(
        db,
        workloadSpec.authoritySql,
        ...authorityBindings(workloadSpec.authoritySql, targetRepositoryId),
      ),
      scheduledCredentialPurge: await queryPlan(
        db,
        `DELETE FROM runtime_git_credentials
         WHERE token_id IN (
           SELECT token_id FROM runtime_git_credentials
           WHERE expires_at <= ? ORDER BY expires_at, token_id LIMIT ?
         )`,
        now,
        64,
      ),
      credentialReadback: await queryPlan(
        db,
        "SELECT * FROM runtime_git_credentials WHERE token_id = ?",
        repeatedTokenId,
      ),
      ...(workloadSpec.reusableSql
        ? {
            credentialReuse: await queryPlan(
              db,
              workloadSpec.reusableSql,
              ...reusableCredentialBindings(),
            ),
          }
        : {}),
    };

    const workload =
      workloadSpec.mode === "mint-every-request"
        ? await measureMintEveryRequest(db, workloadSpec.authoritySql)
        : await measureReuseExactScope(db, workloadSpec.authoritySql, workloadSpec.reusableSql);
    const scheduledMaintenance = await measureScheduledPurge(db);
    return {
      label: name,
      initialFixture,
      localPlans: plans,
      equivalence: { target: targetResult, observed: observedResult },
      requestMode: workloadSpec.mode,
      workload,
      scheduledMaintenance,
    };
  } finally {
    await miniflare.dispose();
  }
}

async function applyMigrations(db, migrationSql) {
  for (const migration of migrationSql) {
    for (const statement of splitSqlStatements(migration.sql)) {
      await db.prepare(statement).run();
    }
  }
}

async function readMigrations(authorityMigration) {
  const names = (await readdir(migrationDirectory)).filter((name) => name.endsWith(".sql")).sort();
  const migrationPaths = new Map(names.map((name) => [name, path.join(migrationDirectory, name)]));
  migrationPaths.set(path.basename(authorityMigration), authorityMigration);
  const paths = Array.from(migrationPaths.values());
  paths.sort((left, right) => path.basename(left).localeCompare(path.basename(right)));

  const migrations = [];
  for (const migrationPath of paths) {
    const sql = await readFile(migrationPath, "utf8");
    migrations.push({ name: path.basename(migrationPath), sql });
  }
  assert.ok(
    migrations.some((migration) => migration.name === "0009_runtime_authority.sql"),
    "the current runtime-authority projection migration must be applied to both local databases",
  );
  return migrations;
}

function splitSqlStatements(sql) {
  const executable = sql.replace(/^\s*--.*$/gmu, "");
  return executable
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

async function seedFixture(db, fixture) {
  await insertRows(db, "logical_instances", [
    [
      "instance_id",
      "repository_id",
      "generation",
      "runtime_epoch",
      "desired_state",
      "observed_runtime_epoch",
      "observed_state",
      "observed_revision_id",
      "current_artifact_digest",
      "reservation_state",
      "reservation_id",
      "runtime_authority_reservation_id",
      "runtime_authority_operation_id",
      "created_at",
      "updated_at",
    ],
    [
      targetInstanceId,
      targetRepositoryId,
      8,
      targetRuntimeEpoch,
      "running",
      oldRuntimeEpoch,
      "ready",
      "revision-d1-target-4",
      "sha256:local-target",
      "reserved",
      targetReservationId,
      null,
      null,
      now - 2_000,
      now - 1_000,
    ],
    [
      observedInstanceId,
      observedRepositoryId,
      3,
      9,
      "running",
      9,
      "ready",
      "revision-d1-observed-9",
      "sha256:local-observed",
      "allocated",
      "res_d1-workload-observed-9",
      null,
      null,
      now - 2_000,
      now - 1_000,
    ],
  ]);

  await insertRows(db, "repository_bindings", [
    [
      "repository_id",
      "instance_id",
      "installation_id",
      "owner",
      "name",
      "created_at",
      "updated_at",
    ],
    [
      targetRepositoryId,
      targetInstanceId,
      targetInstallationId,
      "local-fixture",
      "target",
      now - 2_000,
      now - 1_000,
    ],
    [
      observedRepositoryId,
      observedInstanceId,
      899_998_102,
      "local-fixture",
      "observed",
      now - 2_000,
      now - 1_000,
    ],
  ]);

  await insertRows(db, "runtime_reservations", [
    [
      "reservation_id",
      "instance_id",
      "repository_id",
      "runtime_epoch",
      "generation",
      "cluster_id",
      "status",
      "capacity_snapshot_epoch",
      "cpu_milli",
      "memory_mib",
      "ephemeral_storage_mib",
      "created_at",
      "updated_at",
    ],
    [
      "res_d1-workload-old-4",
      targetInstanceId,
      targetRepositoryId,
      oldRuntimeEpoch,
      7,
      "local-cluster",
      "allocated",
      1,
      100,
      256,
      128,
      now - 4_000,
      now - 3_000,
    ],
    [
      targetReservationId,
      targetInstanceId,
      targetRepositoryId,
      targetRuntimeEpoch,
      8,
      "local-cluster",
      "reserved",
      1,
      100,
      256,
      128,
      now - 2_000,
      now - 1_000,
    ],
    [
      "res_d1-workload-observed-9",
      observedInstanceId,
      observedRepositoryId,
      9,
      3,
      "local-cluster",
      "allocated",
      1,
      100,
      256,
      128,
      now - 2_000,
      now - 1_000,
    ],
  ]);
  await db
    .prepare(
      `UPDATE logical_instances SET runtime_authority_reservation_id = ?
       WHERE repository_id = ?`,
    )
    .bind("res_d1-workload-observed-9", observedRepositoryId)
    .run();

  const proof = {
    instanceId: targetInstanceId,
    repositoryId: targetRepositoryId,
    retiredRuntimeEpoch: oldRuntimeEpoch,
    providerObservationId: "local-provider-census",
    censusObservedAt: new Date(now - 1_000).toISOString(),
    remainingWriters: 0,
    evidenceIdentities: ["local-synthetic-evidence"],
    source: "runtime-provider-census",
  };
  const absenceCheckpoint = JSON.stringify({ schemaVersion: 1, writerAbsenceProof: proof });
  const targetCheckpoint = JSON.stringify({
    schemaVersion: 1,
    lifecycle: { phase: "starting-target", writerAbsenceProof: proof },
    writerAbsenceProof: proof,
  });

  await insertRows(db, "operations", [
    [
      "operation_id",
      "instance_id",
      "repository_id",
      "generation",
      "runtime_epoch",
      "kind",
      "status",
      "phase",
      "attempt",
      "lease_epoch",
      "worker_id",
      "lease_token",
      "lease_expires_at",
      "report_sequence",
      "checkpoint_sequence",
      "checkpoint_json",
      "cluster_id",
      "reservation_id",
      "idempotency_scope",
      "idempotency_key",
      "request_hash",
      "actor_id",
      "authorization_revision",
      "created_at",
      "updated_at",
    ],
    [
      targetOperationId,
      targetInstanceId,
      targetRepositoryId,
      8,
      targetRuntimeEpoch,
      "redeploy",
      "running",
      "starting-target",
      1,
      1,
      "local-provisioner",
      "local-fixture-lease",
      now + 300_000,
      0,
      2,
      targetCheckpoint,
      "local-cluster",
      targetReservationId,
      "repo:local-target",
      "target-op",
      "local-request-hash",
      "system:local-fixture",
      0,
      now - 2_000,
      now - 1_000,
    ],
  ]);
  await db
    .prepare(
      `UPDATE logical_instances
       SET runtime_authority_reservation_id = ?, runtime_authority_operation_id = ?
       WHERE repository_id = ?`,
    )
    .bind(targetReservationId, targetOperationId, targetRepositoryId)
    .run();

  const checkpointCountFor = (index) =>
    fixture.historyCheckpointCounts?.[index] ?? fixture.historyCheckpoints;
  const historicalOperations = Array.from({ length: fixture.historyOperations }, (_, index) => {
    const operationId = `op_d1-workload-history-${index}`;
    return [
      operationId,
      targetInstanceId,
      targetRepositoryId,
      7,
      oldRuntimeEpoch,
      "stop",
      "succeeded",
      "complete",
      1,
      1,
      "local-provisioner",
      null,
      null,
      0,
      checkpointCountFor(index),
      "{}",
      null,
      null,
      "repo:local-history",
      `history-${index}`,
      `history-hash-${index}`,
      "system:local-history",
      0,
      now - 100_000 + index,
      now - 90_000 + index,
    ];
  });
  await insertRows(db, "operations", [
    [
      "operation_id",
      "instance_id",
      "repository_id",
      "generation",
      "runtime_epoch",
      "kind",
      "status",
      "phase",
      "attempt",
      "lease_epoch",
      "worker_id",
      "lease_token",
      "lease_expires_at",
      "report_sequence",
      "checkpoint_sequence",
      "checkpoint_json",
      "cluster_id",
      "reservation_id",
      "idempotency_scope",
      "idempotency_key",
      "request_hash",
      "actor_id",
      "authorization_revision",
      "created_at",
      "updated_at",
    ],
    ...historicalOperations,
  ]);

  const checkpointRows = [
    [
      "operation_id",
      "sequence",
      "phase",
      "runtime_epoch",
      "checkpoint_json",
      "actor_id",
      "occurred_at",
    ],
    [
      targetOperationId,
      1,
      "old-writer-absent",
      targetRuntimeEpoch,
      absenceCheckpoint,
      "local-provisioner",
      now - 1_500,
    ],
    [
      targetOperationId,
      2,
      "starting-target",
      targetRuntimeEpoch,
      targetCheckpoint,
      "local-provisioner",
      now - 1_000,
    ],
  ];
  for (let operationIndex = 0; operationIndex < fixture.historyOperations; operationIndex += 1) {
    for (let sequence = 1; sequence <= checkpointCountFor(operationIndex); sequence += 1) {
      checkpointRows.push([
        `op_d1-workload-history-${operationIndex}`,
        sequence,
        "complete",
        oldRuntimeEpoch,
        "{}",
        "local-system",
        now - 100_000 + operationIndex + sequence,
      ]);
    }
  }
  await insertRows(db, "operation_checkpoints", checkpointRows);

  const backgroundRepositories = Math.ceil(fixture.backgroundCredentialRows / 64);
  const backgroundInstances = [];
  for (let index = 0; index < backgroundRepositories; index += 1) {
    const repositoryId = 910_000_000 + index;
    const instanceId = instanceIdFromIndex(index + 1);
    const reservationId = `res_d1-workload-background-${index}`;
    backgroundInstances.push({
      repositoryId,
      instanceId,
      reservationId,
      installationId: 920_000_000 + index,
    });
  }
  await insertRows(db, "logical_instances", [
    [
      "instance_id",
      "repository_id",
      "generation",
      "runtime_epoch",
      "desired_state",
      "observed_runtime_epoch",
      "observed_state",
      "observed_revision_id",
      "current_artifact_digest",
      "reservation_state",
      "reservation_id",
      "runtime_authority_reservation_id",
      "created_at",
      "updated_at",
    ],
    ...backgroundInstances.map((entry, index) => [
      entry.instanceId,
      entry.repositoryId,
      1,
      1,
      "running",
      1,
      "ready",
      `revision-background-${index}`,
      `sha256:background-${index}`,
      "allocated",
      entry.reservationId,
      null,
      now - 2_000,
      now - 1_000,
    ]),
  ]);
  await insertRows(db, "repository_bindings", [
    [
      "repository_id",
      "instance_id",
      "installation_id",
      "owner",
      "name",
      "created_at",
      "updated_at",
    ],
    ...backgroundInstances.map((entry, index) => [
      entry.repositoryId,
      entry.instanceId,
      entry.installationId,
      "local-fixture",
      `background-${index}`,
      now - 2_000,
      now - 1_000,
    ]),
  ]);
  await insertRows(db, "runtime_reservations", [
    [
      "reservation_id",
      "instance_id",
      "repository_id",
      "runtime_epoch",
      "generation",
      "cluster_id",
      "status",
      "capacity_snapshot_epoch",
      "cpu_milli",
      "memory_mib",
      "ephemeral_storage_mib",
      "created_at",
      "updated_at",
    ],
    ...backgroundInstances.map((entry) => [
      entry.reservationId,
      entry.instanceId,
      entry.repositoryId,
      1,
      1,
      "local-cluster",
      "allocated",
      1,
      100,
      256,
      128,
      now - 2_000,
      now - 1_000,
    ]),
  ]);
  for (const entry of backgroundInstances) {
    await db
      .prepare(
        `UPDATE logical_instances SET runtime_authority_reservation_id = ?
         WHERE repository_id = ?`,
      )
      .bind(entry.reservationId, entry.repositoryId)
      .run();
  }

  const credentials = [];
  const expires = (index) => (index % 5 === 0 ? now - 1_000 : now + 600_000 + index);
  for (let index = 0; index < fixture.backgroundCredentialRows; index += 1) {
    const entry = backgroundInstances[index % backgroundInstances.length];
    const statuses = ["active", "revocation_pending", "revoked"];
    credentials.push(
      credentialRow(index + 1, entry, 1, statuses[index % statuses.length], expires(index), now),
    );
  }
  for (let index = 0; index < fixture.targetCredentialRows - 1; index += 1) {
    const status = index % 2 === 0 ? "revoked" : "active";
    credentials.push(
      credentialRow(
        fixture.backgroundCredentialRows + index + 1,
        {
          repositoryId: targetRepositoryId,
          instanceId: targetInstanceId,
          installationId: targetInstallationId,
          reservationId: targetReservationId,
        },
        oldRuntimeEpoch,
        status,
        status === "active" ? now - 1_000 : now + 600_000 + index,
        now,
      ),
    );
  }
  credentials.push([
    repeatedTokenId,
    targetRepositoryId,
    targetInstallationId,
    `run_${targetInstanceId.slice(4)}_${targetRuntimeEpoch}`,
    targetReservationId,
    targetRuntimeEpoch,
    targetReservationId,
    "read",
    now + 300_000,
    JSON.stringify({
      version: 1,
      keyId: "local-fixture-key",
      iv: "CCCCCCCCCCCCCCCC",
      ciphertext: "same-local-reusable-token",
    }),
    "active",
    now - 10_000,
    now - 10_000,
  ]);
  await insertRows(db, "runtime_git_credentials", [
    [
      "token_id",
      "repository_id",
      "installation_id",
      "instance_id",
      "runtime_id",
      "runtime_epoch",
      "lease_id",
      "permission",
      "expires_at",
      "encrypted_secret_json",
      "status",
      "created_at",
      "updated_at",
    ],
    ...credentials,
  ]);
}

async function readInitialFixtureSnapshot(db, fixture) {
  const tableCounts = {};
  for (const table of [
    "logical_instances",
    "repository_bindings",
    "runtime_reservations",
    "operations",
    "operation_checkpoints",
    "runtime_git_credentials",
  ]) {
    const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first();
    tableCounts[table] = row.count;
  }
  const statusRows = await db
    .prepare(
      "SELECT status, COUNT(*) AS count FROM runtime_git_credentials GROUP BY status ORDER BY status",
    )
    .all();
  const credentialStatusCounts = Object.fromEntries(
    statusRows.results.map((row) => [row.status, row.count]),
  );
  const snapshot = {
    fixture: fixtureSummary(fixture),
    tableCounts,
    credentialStatusCounts,
  };
  return {
    ...snapshot,
    rowCountSnapshotSha256: sha256(JSON.stringify(snapshot)),
  };
}

function credentialRow(index, binding, runtimeEpoch, status, expiresAt, createdAt) {
  return [
    index.toString(16).padStart(64, "0"),
    binding.repositoryId,
    binding.installationId,
    binding.instanceId,
    binding.reservationId,
    runtimeEpoch,
    binding.reservationId,
    index % 2 === 0 ? "read" : "write",
    expiresAt,
    JSON.stringify({
      version: 1,
      keyId: "local-fixture-key",
      iv: "AAAAAAAAAAAAAAAA",
      ciphertext: "fixture-only",
    }),
    status,
    createdAt,
    createdAt,
  ];
}

async function insertRows(db, table, records) {
  const [columns, ...rows] = records;
  if (rows.length === 0) return;
  const chunkSize = 100;
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunk = rows.slice(offset, offset + chunkSize);
    const values = chunk.map((row) => `(${row.map(sqlLiteral).join(",")})`).join(",");
    await db.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES ${values}`).run();
  }
}

function sqlLiteral(value) {
  if (value === null) return "NULL";
  if (typeof value === "number") {
    assert.ok(Number.isFinite(value), "fixture numbers must be finite");
    return String(value);
  }
  assert.equal(typeof value, "string", "fixture values must be strings, numbers, or null");
  return `'${value.replace(/'/gu, "''")}'`;
}

async function measureMintEveryRequest(db, authoritySql) {
  const stats = createStats();
  const startedAt = performance.now();

  for (let request = 0; request < iterations; request += 1) {
    const firstBinding = await readAuthority(db, authoritySql, stats, "brokerBindingFirst");
    assertCurrentTarget(firstBinding);
    const secondBinding = await readAuthority(db, authoritySql, stats, "brokerBindingSecond");
    assertCurrentTarget(secondBinding);

    const purge = await db
      .prepare(
        `DELETE FROM runtime_git_credentials
         WHERE token_id IN (
           SELECT token_id FROM runtime_git_credentials
           WHERE expires_at <= ? ORDER BY expires_at, token_id LIMIT ?
         )`,
      )
      .bind(now, 64)
      .run();
    addStats(stats, "credentialPurge", purge.meta, 0);

    const token = makeMintedCredential(request);
    const insert = await db
      .prepare(
        `INSERT INTO runtime_git_credentials (
           token_id, repository_id, installation_id, instance_id, runtime_id,
           runtime_epoch, lease_id, permission, expires_at, encrypted_secret_json,
           status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
         ON CONFLICT(token_id) DO NOTHING`,
      )
      .bind(
        token.tokenId,
        token.repositoryId,
        token.installationId,
        token.instanceId,
        token.runtimeId,
        token.runtimeEpoch,
        token.leaseId,
        token.permission,
        token.expiresAt,
        token.encryptedSecret,
        now,
        now,
      )
      .run();
    addStats(stats, "credentialRegister", insert.meta, 0);

    const readback = await db
      .prepare("SELECT * FROM runtime_git_credentials WHERE token_id = ?")
      .bind(token.tokenId)
      .all();
    addStats(stats, "credentialReadback", readback.meta, readback.results.length);
    assert.equal(readback.results.length, 1);
    assert.equal(readback.results[0].status, "active");
    assert.equal(readback.results[0].encrypted_secret_json, token.encryptedSecret);

    const registrationBinding = await readAuthority(
      db,
      authoritySql,
      stats,
      "credentialRegistrationAuthority",
    );
    assertCurrentTarget(registrationBinding);
  }

  stats.wallClockMs = round(performance.now() - startedAt);
  stats.iterations = iterations;
  stats.credentialRowsCreated = await countMintedRows(db);
  stats.credentialRowsReturned = stats.byQuery.credentialReadback.resultRows;
  stats.currentAuthorityEvaluations =
    stats.byQuery.brokerBindingFirst.calls +
    stats.byQuery.brokerBindingSecond.calls +
    stats.byQuery.credentialRegistrationAuthority.calls;
  return stats;
}

async function measureReuseExactScope(db, authoritySql, reusableSql) {
  const stats = createStats();
  const startedAt = performance.now();

  for (let request = 0; request < iterations; request += 1) {
    const binding = await readAuthority(db, authoritySql, stats, "brokerBindingFirst");
    assertCurrentTarget(binding);

    const reused = await db
      .prepare(reusableSql)
      .bind(...reusableCredentialBindings())
      .all();
    addStats(stats, "credentialReuse", reused.meta, reused.results.length);
    assert.equal(reused.results.length, 1);
    assert.equal(reused.results[0].token_id, repeatedTokenId);
    assert.equal(reused.results[0].status, "active");
    assert.equal(reused.results[0].repository_id, targetRepositoryId);
    assert.equal(reused.results[0].installation_id, targetInstallationId);
    assert.equal(
      reused.results[0].instance_id,
      `run_${targetInstanceId.slice(4)}_${targetRuntimeEpoch}`,
    );
    assert.equal(reused.results[0].runtime_id, targetReservationId);
    assert.equal(reused.results[0].runtime_epoch, targetRuntimeEpoch);
    assert.equal(reused.results[0].lease_id, targetReservationId);
    assert.equal(reused.results[0].permission, "read");
  }

  stats.wallClockMs = round(performance.now() - startedAt);
  stats.iterations = iterations;
  stats.credentialRowsCreated = await countMintedRows(db);
  stats.credentialRowsReturned = stats.byQuery.credentialReuse.resultRows;
  stats.currentAuthorityEvaluations =
    stats.byQuery.brokerBindingFirst.calls + stats.byQuery.credentialReuse.calls;
  return stats;
}

async function measureScheduledPurge(db) {
  const stats = createStats();
  const result = await db
    .prepare(
      `DELETE FROM runtime_git_credentials
       WHERE token_id IN (
         SELECT token_id FROM runtime_git_credentials
         WHERE expires_at <= ? ORDER BY expires_at, token_id LIMIT ?
       )`,
    )
    .bind(now, 64)
    .run();
  addStats(stats, "scheduledCredentialPurge", result.meta, 0);
  stats.deletedRows = result.meta?.changes ?? null;
  return stats;
}

function makeMintedCredential(index) {
  const suffix = index.toString(16).padStart(2, "0");
  return {
    tokenId: `${"b".repeat(62)}${suffix}`,
    repositoryId: targetRepositoryId,
    installationId: targetInstallationId,
    instanceId: `run_${targetInstanceId.slice(4)}_${targetRuntimeEpoch}`,
    runtimeId: targetReservationId,
    runtimeEpoch: targetRuntimeEpoch,
    leaseId: targetReservationId,
    permission: "read",
    expiresAt: now + 300_000,
    encryptedSecret: JSON.stringify({
      version: 1,
      keyId: "local-fixture-key",
      iv: `D${suffix}`.padEnd(16, "D"),
      ciphertext: `local-synthetic-token-${suffix}`,
    }),
  };
}

async function readAuthority(db, sql, stats, name) {
  const result = await db
    .prepare(sql)
    .bind(...authorityBindings(sql, targetRepositoryId))
    .all();
  addStats(stats, name, result.meta, result.results.length);
  return result.results[0] ?? null;
}

function assertCurrentTarget(row) {
  assert.ok(row, "the local current-authority query must return the target");
  assert.equal(row.authority, "post-absence-target");
  assert.equal(row.repository_id, targetRepositoryId);
  assert.equal(row.runtime_epoch, targetRuntimeEpoch);
}

function reusableCredentialBindings() {
  return [
    targetRepositoryId,
    now,
    targetRepositoryId,
    targetInstallationId,
    `run_${targetInstanceId.slice(4)}_${targetRuntimeEpoch}`,
    targetReservationId,
    targetRuntimeEpoch,
    targetReservationId,
    "read",
    now + 30_000,
  ];
}

async function countMintedRows(db) {
  const result = await db
    .prepare(
      "SELECT COUNT(*) AS count FROM runtime_git_credentials WHERE substr(token_id, 1, 62) = ?",
    )
    .bind("b".repeat(62))
    .first();
  return result?.count ?? -1;
}

function createStats() {
  return {
    calls: 0,
    rowsRead: 0,
    rowsWritten: 0,
    durationMs: 0,
    resultRows: 0,
    rowsReadAvailable: true,
    rowsWrittenAvailable: true,
    byQuery: {},
    wallClockMs: 0,
  };
}

function addStats(stats, name, meta, resultRows) {
  const query = (stats.byQuery[name] ??= {
    calls: 0,
    rowsRead: 0,
    rowsWritten: 0,
    durationMs: 0,
    resultRows: 0,
    rowsReadAvailable: true,
    rowsWrittenAvailable: true,
  });
  stats.calls += 1;
  query.calls += 1;
  stats.resultRows += resultRows;
  query.resultRows += resultRows;
  for (const [key, property] of [
    ["rowsRead", "rows_read"],
    ["rowsWritten", "rows_written"],
  ]) {
    if (typeof meta?.[property] !== "number") {
      stats[`${key}Available`] = false;
      query[`${key}Available`] = false;
      continue;
    }
    stats[key] += meta[property];
    query[key] += meta[property];
  }
  if (typeof meta?.duration === "number") {
    stats.durationMs += meta.duration;
    query.durationMs += meta.duration;
  }
}

async function queryAuthority(db, sql, repositoryId) {
  const result = await db
    .prepare(sql)
    .bind(...authorityBindings(sql, repositoryId))
    .all();
  return result.results[0] ?? null;
}

function publicAuthority(row) {
  if (row === null) return null;
  return {
    authority: row.authority,
    repositoryId: row.repository_id,
    installationId: row.installation_id,
    instanceId: row.instance_id,
    physicalInstanceId: physicalInstanceId(
      row.instance_id,
      row.runtime_epoch,
      row.legacy_runtime_epoch,
    ),
    runtimeId: row.runtime_id,
    runtimeEpoch: row.runtime_epoch,
    leaseId: row.lease_id,
    clusterId: row.cluster_id,
  };
}

function physicalInstanceId(bindingId, epoch, legacyEpoch) {
  if (legacyEpoch === undefined) return bindingId;
  return epoch === legacyEpoch ? bindingId : `run_${bindingId.slice(4)}_${epoch}`;
}

function instanceIdFromIndex(index) {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let value = BigInt(index);
  let suffix = "";
  for (let digit = 0; digit < 26; digit += 1) {
    suffix = alphabet[Number(value & 31n)] + suffix;
    value >>= 5n;
  }
  return `ins_${suffix}`;
}

async function queryPlan(db, sql, ...bindings) {
  const result = await db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...bindings)
    .all();
  return result.results.map((row) => row.detail);
}

function authorityBindings(sql, repositoryId) {
  const placeholders = (sql.match(/\?/gu) ?? []).length;
  if (placeholders === 2) return [repositoryId, now];
  assert.equal(placeholders, 7, "unexpected runtime-authority SQL bind count");
  const nowText = new Date(now).toISOString();
  return [repositoryId, now, now, nowText, nowText, repositoryId, nowText];
}

function compare(before, after) {
  const delta = (key) => {
    const a = before[key];
    const b = after[key];
    return before[`${key}Available`] && after[`${key}Available`] ? b - a : null;
  };
  return {
    rowsRead: delta("rowsRead"),
    rowsWritten: delta("rowsWritten"),
    durationMs: round(after.durationMs - before.durationMs),
    wallClockMs: round(after.wallClockMs - before.wallClockMs),
  };
}

function fixtureSummary(fixture) {
  const historyCheckpoints = fixture.historyCheckpointCounts
    ? fixture.historyCheckpointCounts.reduce((sum, value) => sum + value, 0)
    : fixture.historyOperations * fixture.historyCheckpoints;
  return {
    bindings: 2 + Math.ceil(fixture.backgroundCredentialRows / 64),
    operations: 1 + fixture.historyOperations,
    checkpoints: 2 + historyCheckpoints,
    credentials: fixture.backgroundCredentialRows + fixture.targetCredentialRows,
    historicalOperationsForTarget: fixture.historyOperations,
    targetCredentialRows: fixture.targetCredentialRows,
    backgroundCredentialRows: fixture.backgroundCredentialRows,
  };
}

async function collectSourceIdentity(paths) {
  const baselineSha = execFileSync("git", ["rev-parse", `${paths.baselineRef}^{commit}`], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  const baselineFiles = [
    "apps/control-plane/src/runtime-binding.ts",
    "packages/persistence/src/d1/runtime-git-credentials-store.ts",
    "apps/control-plane/src/runtime-git-credential-routes.ts",
    "apps/gateway/src/adapters/runtime-git-broker.ts",
    "plugins/github/src/credential-broker.ts",
  ];
  const baseline = {};
  for (const file of baselineFiles) {
    const contents = execFileSync("git", ["show", `${baselineSha}:${file}`], {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    baseline[file] = sha256(contents);
  }

  const currentPaths = {
    "runtime-authority-source": paths.currentSqlPath,
    "credential-store-source": paths.credentialStorePath,
    "credential-routes-source": paths.currentCredentialRoutesPath,
    "gateway-broker-source": paths.currentGatewayBrokerPath,
    "github-broker-source": paths.currentGithubBrokerPath,
    "authority-migration": paths.authorityMigrationPath,
  };
  const current = {};
  for (const [name, file] of Object.entries(currentPaths)) {
    const contents = await readFile(file, "utf8");
    current[name] = {
      locator: path.relative(repositoryRoot, file),
      sha256: sha256(contents),
    };
  }

  return {
    baselineRef: paths.baselineRef,
    baselineCommit: baselineSha,
    baselineFilesSha256: baseline,
    currentFiles: current,
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function extractLegacyRuntimeSql(ref) {
  const source = execFileSync("git", ["show", `${ref}:apps/control-plane/src/runtime-binding.ts`], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  const start = source.indexOf("`WITH candidates AS (");
  const end = source.indexOf("`,\n        )", start);
  assert.ok(start >= 0 && end > start, `cannot extract baseline SQL from ${ref}`);
  let sql = source.slice(start + 1, end);
  sql = sql
    .replace(
      '${checkpointProofPredicate("latest", "i", "?")}',
      checkpointProofPredicate("latest", "i", "?"),
    )
    .replace(
      '${checkpointProofPredicate("absence", "i", "?")}',
      checkpointProofPredicate("absence", "i", "?"),
    )
    .replace(
      '${checkpointProofPredicate("retired_latest", "i", "?")}',
      checkpointProofPredicate("retired_latest", "i", "?"),
    )
    .replace(
      '${sameWriterAbsenceProof("latest", "absence")}',
      sameWriterAbsenceProof("latest", "absence"),
    )
    .replace(
      '${sameWriterAbsenceProof("retired_latest", "retired_absence")}',
      sameWriterAbsenceProof("retired_latest", "retired_absence"),
    );
  assert.ok(!sql.includes("${"), "baseline SQL interpolation must be fully expanded");
  assert.equal((sql.match(/\?/gu) ?? []).length, 7, "baseline SQL bind order changed");
  return sql;
}

async function extractCurrentRuntimeSql(sourcePath) {
  const source = await readFile(sourcePath, "utf8");
  const match = source.match(/export const CURRENT_RUNTIME_AUTHORITY_SQL\s*=\s*`([\s\S]*?)`;/u);
  assert.ok(match, `CURRENT_RUNTIME_AUTHORITY_SQL is missing from ${sourcePath}`);
  assert.equal((match[1].match(/\?/gu) ?? []).length, 2, "current SQL bind order changed");
  return match[1];
}

async function extractReusableCredentialSql(sourcePath, currentSql) {
  const source = await readFile(sourcePath, "utf8");
  const marker =
    "`WITH current_authority AS (${CURRENT_RUNTIME_AUTHORITY_SQL})\n         SELECT credential.* FROM runtime_git_credentials credential";
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `findReusable SQL is missing from ${sourcePath}`);
  const end = source.indexOf("`", start + 1);
  assert.ok(end > start, `cannot extract findReusable SQL from ${sourcePath}`);
  const sql = source.slice(start + 1, end).replace("${CURRENT_RUNTIME_AUTHORITY_SQL}", currentSql);
  assert.ok(!sql.includes("${"), "credential reuse SQL interpolation must be fully expanded");
  assert.equal((sql.match(/\?/gu) ?? []).length, 10, "credential reuse SQL bind order changed");
  return sql;
}

function checkpointProofPredicate(checkpoint, instance, nowSlot) {
  const proof = `${checkpoint}.checkpoint_json`;
  const pathFor = (field) => `$.writerAbsenceProof.${field}`;
  return `
    json_extract(${proof}, '$.schemaVersion') = 1
    AND json_extract(${proof}, '${pathFor("instanceId")}') = ${instance}.instance_id
    AND json_extract(${proof}, '${pathFor("repositoryId")}') = ${instance}.repository_id
    AND json_extract(${proof}, '${pathFor("source")}') = 'runtime-provider-census'
    AND json_type(${proof}, '${pathFor("remainingWriters")}') = 'integer'
    AND json_extract(${proof}, '${pathFor("remainingWriters")}') = 0
    AND json_type(${proof}, '${pathFor("providerObservationId")}') = 'text'
    AND length(json_extract(${proof}, '${pathFor("providerObservationId")}')) BETWEEN 1 AND 512
    AND json_type(${proof}, '${pathFor("censusObservedAt")}') = 'text'
    AND julianday(json_extract(${proof}, '${pathFor("censusObservedAt")}')) IS NOT NULL
    AND julianday(json_extract(${proof}, '${pathFor("censusObservedAt")}')) <= julianday(${nowSlot})
    AND json_type(${proof}, '${pathFor("evidenceIdentities")}') = 'array'
    AND NOT EXISTS (
      SELECT 1 FROM json_each(${proof}, '${pathFor("evidenceIdentities")}') evidence_identity
      WHERE evidence_identity.type <> 'text' OR length(evidence_identity.value) > 512
    )
    AND json_type(${proof}, '${pathFor("retiredRuntimeEpoch")}') IN ('integer', 'null')
    AND (
      json_type(${proof}, '${pathFor("retiredRuntimeEpoch")}') = 'null'
      OR abs(json_extract(${proof}, '${pathFor("retiredRuntimeEpoch")}')) <= 9007199254740991
    )
  `;
}

function sameWriterAbsenceProof(left, right) {
  const fields = [
    "instanceId",
    "repositoryId",
    "retiredRuntimeEpoch",
    "providerObservationId",
    "censusObservedAt",
    "remainingWriters",
    "evidenceIdentities",
    "source",
  ];
  return fields
    .map(
      (field) =>
        `json_extract(${left}.checkpoint_json, '$.writerAbsenceProof.${field}') IS json_extract(${right}.checkpoint_json, '$.writerAbsenceProof.${field}')`,
    )
    .join(" AND ");
}

function parseArguments(arguments_) {
  const parsed = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    assert.ok(argument.startsWith("--"), `unexpected argument: ${argument}`);
    const key = argument.slice(2).replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
    const value = arguments_[index + 1];
    assert.ok(value && !value.startsWith("--"), `missing value for ${argument}`);
    parsed[key] = value;
    index += 1;
  }
  return parsed;
}

function positiveInteger(value, label) {
  const number = Number(value);
  assert.ok(Number.isSafeInteger(number) && number > 0, `${label} must be a positive integer`);
  return number;
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}
