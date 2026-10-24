import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  applyMigrationsWithPreflight,
  assertCompatibleMigrationHistory,
  assertMigrationReadback,
  compareMigrationNames,
  orderedMigrationFiles,
  parseAppliedMigrationReadback,
} from "../../scripts/deployment-migrations.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migrationDirectory = path.join(root, "apps/control-plane/migrations");

test("deployment migration order includes all source migrations and preserves duplicate 0004 names", () => {
  const files = orderedMigrationFiles(migrationDirectory);
  assert.deepEqual(files, [
    "0001_repository_platform.sql",
    "0002_stable_release_rollouts.sql",
    "0003_staged_configurations.sql",
    "0004_runtime_git_credentials.sql",
    "0004_source_release_builds.sql",
    "0005_runtime_health_observations.sql",
    "0006_application_origins.sql",
    "0007_source_release_recovery.sql",
    "0008_source_build_diagnostics.sql",
    "0009_runtime_authority.sql",
  ]);
  assert.ok(compareMigrationNames("0004_runtime_git_credentials.sql", "0004_source_release_builds.sql") < 0);
});

test("Wrangler JSON readback accepts complete historical receipts with duplicate-prefix order retained", () => {
  const expected = orderedMigrationFiles(migrationDirectory);
  const historicReceipts = [
    "0001_repository_platform.sql",
    "0002_stable_release_rollouts.sql",
    "0003_staged_configurations.sql",
    "0004_runtime_git_credentials.sql",
    "0005_runtime_health_observations.sql",
    "0006_application_origins.sql",
    "0004_source_release_builds.sql",
    "0007_source_release_recovery.sql",
    "0008_source_build_diagnostics.sql",
    "0009_runtime_authority.sql",
  ];
  const output = JSON.stringify([{ success: true, results: historicReceipts.map((name) => ({ name })) }]);
  const applied = parseAppliedMigrationReadback(output);
  assert.deepEqual(applied, historicReceipts);
  assert.equal(assertMigrationReadback(expected, applied), true);
});

test("migration readback rejects missing, extra, duplicate, malformed and prerequisite-breaking history", () => {
  const expected = orderedMigrationFiles(migrationDirectory);
  assert.throws(() => assertMigrationReadback(expected, expected.slice(0, -1)), /not applied/u);
  assert.throws(() => assertMigrationReadback(expected, [...expected, "0008_unknown.sql"]), /unknown applied/u);
  const recoveryBeforeSource = expected.filter((name) => name !== "0007_source_release_recovery.sql");
  recoveryBeforeSource.splice(recoveryBeforeSource.indexOf("0004_source_release_builds.sql"), 0,
    "0007_source_release_recovery.sql");
  assert.throws(() => assertMigrationReadback(expected, recoveryBeforeSource), /before prerequisite 0004_source_release_builds/u);
  assert.throws(() => parseAppliedMigrationReadback("not JSON"), /invalid JSON/u);
  assert.throws(() => parseAppliedMigrationReadback(JSON.stringify([{ success: false, results: [] }])), /successful query/u);
  assert.throws(() => parseAppliedMigrationReadback(JSON.stringify([{ success: true, results: [{ name: "0001_ok.sql" }, { name: "0001_ok.sql" }] }])), /duplicate migration/u);
  assert.throws(() => parseAppliedMigrationReadback(JSON.stringify([{ success: true, results: [{ name: "unexpected" }] }])), /invalid migration/u);
});

test("remote preflight accepts pending known migrations and the historical late source 0004", () => {
  const expected = orderedMigrationFiles(migrationDirectory);
  assert.equal(assertCompatibleMigrationHistory(expected, []), true);
  assert.equal(assertCompatibleMigrationHistory(expected, expected.slice(0, 4)), true);
  assert.equal(assertCompatibleMigrationHistory(expected, [
    "0001_repository_platform.sql",
    "0002_stable_release_rollouts.sql",
    "0003_staged_configurations.sql",
    "0004_runtime_git_credentials.sql",
    "0005_runtime_health_observations.sql",
    "0006_application_origins.sql",
    "0004_source_release_builds.sql",
  ]), true);
  assert.throws(() => assertCompatibleMigrationHistory(expected, [
    ...expected.slice(0, 4), "0009_unknown.sql",
  ]), /unknown migrations/u);
  assert.throws(() => assertCompatibleMigrationHistory(expected, [
    "0001_repository_platform.sql",
    "0002_stable_release_rollouts.sql",
    "0003_staged_configurations.sql",
    "0004_source_release_builds.sql",
  ]), /missing or precedes prerequisite 0004_runtime_git_credentials/u);
  assert.throws(() => assertCompatibleMigrationHistory(expected, [
    ...expected.slice(0, 4), "0007_source_release_recovery.sql",
  ]), /missing or precedes prerequisite/u);
});

test("migration apply never runs when the initial remote history is unknown", () => {
  const expected = orderedMigrationFiles(migrationDirectory);
  let applies = 0;
  assert.throws(() => applyMigrationsWithPreflight(
    expected,
    () => ["0001_repository_platform.sql", "0008_unrecognized.sql"],
    () => { applies += 1; },
  ), /unknown migrations/u);
  assert.equal(applies, 0);
});

test("0007 adds recovery defaults to an existing row written with the 0004 schema", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(path.join(migrationDirectory, "0004_source_release_builds.sql"), "utf8"));
  db.prepare(`INSERT INTO source_release_builds (
    job_id, source_id, github_release_id, source_repository, source_tag, source_revision,
    release_version, actor_id, state, attempt, lease_epoch, progress_json, result_json,
    created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "sr_11111111-1111-4111-8111-111111111111", "scriptorium", 416422590,
    "yohn-jp/scriptorium", "v0.2.1", "3189a85bfa28ddd160600a0188ab3ccfa91755e4",
    "0.2.1", "213253858", "produced", 2, 4,
    '{"stage":"producer","percent":100}', '{"proof":"unchanged"}', 1, 2,
  );
  db.exec(readFileSync(path.join(migrationDirectory, "0007_source_release_recovery.sql"), "utf8"));
  assert.deepEqual(
    { ...db.prepare(`SELECT job_id, source_id, github_release_id, source_repository, source_tag,
      source_revision, release_version, actor_id, state, attempt, lease_epoch,
      progress_json, result_json, created_at, updated_at, revision, admission_attempt,
      next_attempt_at FROM source_release_builds`).get() },
    {
      job_id: "sr_11111111-1111-4111-8111-111111111111",
      source_id: "scriptorium",
      github_release_id: 416422590,
      source_repository: "yohn-jp/scriptorium",
      source_tag: "v0.2.1",
      source_revision: "3189a85bfa28ddd160600a0188ab3ccfa91755e4",
      release_version: "0.2.1",
      actor_id: "213253858",
      state: "produced",
      attempt: 2,
      lease_epoch: 4,
      progress_json: '{"stage":"producer","percent":100}',
      result_json: '{"proof":"unchanged"}',
      created_at: 1,
      updated_at: 2,
      revision: 0,
      admission_attempt: 0,
      next_attempt_at: null,
    },
  );
  db.close();
});


test("diagnostic migration preserves old failed jobs without inventing historical evidence", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(readFileSync(path.join(migrationDirectory, "0004_source_release_builds.sql"), "utf8"));
    db.exec(readFileSync(path.join(migrationDirectory, "0007_source_release_recovery.sql"), "utf8"));
    db.prepare(`INSERT INTO source_release_builds(job_id,source_id,github_release_id,source_repository,
      source_tag,source_revision,release_version,actor_id,state,attempt,lease_epoch,failure_code,created_at,updated_at)
      VALUES(?, 'scriptorium',1,'yohn-jp/scriptorium','v0.3.3',?,'0.3.3','71','failed',1,1,'SOURCE_BUILD_FAILED',1,2)`)
      .run("sr_54a61e4d-088c-453e-98ca-6be8588a4e1f", "a".repeat(40));
    const before = db.prepare("SELECT * FROM source_release_builds").all();
    db.exec(readFileSync(path.join(migrationDirectory, "0008_source_build_diagnostics.sql"), "utf8"));
    assert.deepEqual(db.prepare("SELECT * FROM source_release_builds").all(), before);
    assert.equal(db.prepare("SELECT count(*) AS count FROM source_release_build_attempts").get().count, 0);
    const expected = orderedMigrationFiles(migrationDirectory);
    assert.equal(assertCompatibleMigrationHistory(expected, expected.slice(0, -1)), true);
    const misplaced = [...expected];
    misplaced.splice(misplaced.indexOf("0007_source_release_recovery.sql"), 1);
    misplaced.push("0007_source_release_recovery.sql");
    assert.throws(() => assertCompatibleMigrationHistory(expected, misplaced), /precedes prerequisite/u);
  } finally { db.close(); }
});

test("runtime authority migration grants only proven writers and preserves evidence", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(readFileSync(path.join(migrationDirectory, "0001_repository_platform.sql"), "utf8"));
    db.exec(readFileSync(path.join(migrationDirectory, "0004_runtime_git_credentials.sql"), "utf8"));
    db.exec(readFileSync(path.join(migrationDirectory, "0006_application_origins.sql"), "utf8"));
    const seedInstance = db.prepare(`INSERT INTO logical_instances (
      instance_id, repository_id, runtime_epoch, desired_state, observed_state,
      observed_runtime_epoch, observed_revision_id, current_artifact_digest, created_at, updated_at
    ) VALUES (?, ?, 4, 'running', 'ready', 4, 'revision-4', 'sha256:observed', 1, 1)`);
    const seedReservation = db.prepare(`INSERT INTO runtime_reservations (
      reservation_id, instance_id, repository_id, runtime_epoch, generation,
      cluster_id, status, capacity_snapshot_epoch, cpu_milli, memory_mib,
      ephemeral_storage_mib, created_at, updated_at
    ) VALUES (?, ?, ?, 4, 1, 'owned-test', 'allocated', 1, 1, 1, 1, 1, 1)`);
    for (let id = 1; id <= 4; id += 1) {
      seedInstance.run(`ins_${id}`, id);
      db.prepare(`INSERT INTO repository_bindings (repository_id, instance_id, installation_id, owner, name, created_at, updated_at)
        VALUES (?, ?, 1, 'owned', 'fixture', 1, 1)`).run(id, `ins_${id}`);
      seedReservation.run(`res_${id}`, `ins_${id}`, id);
    }
    for (const [id, phase, checkpoint] of [
      [2, "quiescing-old", { lifecycle: { quiesceRequest: { instanceId: "ins_2", runtimeEpoch: 4 } } }],
      [3, "old-writer-absent", { writerAbsenceProof: { instanceId: "ins_3", retiredRuntimeEpoch: 4 } }],
      [4, "accepted", { lifecycle: { quiesceRequest: null, quiesceReceipt: null } }],
    ]) {
      db.prepare(`INSERT INTO operations (operation_id, instance_id, repository_id, generation,
        runtime_epoch, kind, status, phase, idempotency_scope, idempotency_key, request_hash,
        actor_id, authorization_revision, created_at, updated_at)
        VALUES (?, ?, ?, 1, 5, 'redeploy', 'running', ?, ?, 'test', 'test', '1', 1, 1, 1)`)
        .run(`op_${id}`, `ins_${id}`, id, phase, `repo:${id}`);
      db.prepare(`INSERT INTO operation_checkpoints (operation_id, sequence, phase, runtime_epoch,
        checkpoint_json, actor_id, occurred_at) VALUES (?, 1, ?, 5, ?, 'test', 1)`)
        .run(`op_${id}`, phase, JSON.stringify(checkpoint));
    }
    db.exec("UPDATE operation_checkpoints SET sequence = 2 WHERE operation_id = 'op_4'");
    db.prepare(`INSERT INTO operation_checkpoints (operation_id, sequence, phase, runtime_epoch,
      checkpoint_json, actor_id, occurred_at) VALUES ('op_4', 1, 'quiescing-old', 5, ?, 'test', 1)`)
      .run(JSON.stringify({ lifecycle: { quiesceRequest: { instanceId: 'ins_4', runtimeEpoch: 4 } } }));
    const evidence = db.prepare("SELECT * FROM operation_checkpoints ORDER BY operation_id").all();
    db.exec(readFileSync(path.join(migrationDirectory, "0009_runtime_authority.sql"), "utf8"));
    assert.deepEqual(db.prepare(`SELECT runtime_authority_reservation_id AS grant_id,
      runtime_authority_operation_id AS operation_id FROM logical_instances ORDER BY repository_id`).all()
      .map((row) => ({ ...row })), [
      { grant_id: "res_1", operation_id: null },
      { grant_id: null, operation_id: null },
      { grant_id: null, operation_id: null },
      { grant_id: "res_4", operation_id: null },
    ]);
    assert.deepEqual(db.prepare("SELECT * FROM operation_checkpoints ORDER BY operation_id").all(), evidence);
  } finally {
    db.close();
  }
});

for (const scenario of ["live", "pending-token", "expired-lease", "changed-proof"]) {
  test(`runtime authority migration admits an existing target only with complete evidence (${scenario})`, () => {
    const db = new DatabaseSync(":memory:");
    try {
      for (const name of ["0001_repository_platform.sql", "0004_runtime_git_credentials.sql", "0006_application_origins.sql"])
        db.exec(readFileSync(path.join(migrationDirectory, name), "utf8"));
      const now = Date.now();
      const proof = { instanceId: "ins_1", repositoryId: 1, retiredRuntimeEpoch: 4,
        providerObservationId: "owned-census", censusObservedAt: new Date(now - 1000).toISOString(),
        remainingWriters: 0, evidenceIdentities: [], source: "runtime-provider-census" };
      const absence = JSON.stringify({ schemaVersion: 1, writerAbsenceProof: proof });
      const latest = JSON.stringify({ schemaVersion: 1, writerAbsenceProof: {
        ...proof, providerObservationId: scenario === "changed-proof" ? "different-census" : proof.providerObservationId,
      } });
      db.exec(`INSERT INTO logical_instances (instance_id, repository_id, generation, runtime_epoch,
        desired_state, observed_state, observed_runtime_epoch, observed_revision_id,
        current_artifact_digest, reservation_id, created_at, updated_at)
        VALUES ('ins_1', 1, 8, 5, 'running', 'ready', 4, 'old-revision', 'sha256:old', 'res_5', 1, 1);
        INSERT INTO repository_bindings (repository_id, instance_id, installation_id, owner, name, created_at, updated_at)
        VALUES (1, 'ins_1', 1, 'owned', 'fixture', 1, 1);`);
      for (const epoch of [4, 5])
        db.prepare(`INSERT INTO runtime_reservations (reservation_id, instance_id, repository_id,
          runtime_epoch, generation, cluster_id, status, capacity_snapshot_epoch, cpu_milli,
          memory_mib, ephemeral_storage_mib, created_at, updated_at)
          VALUES (?, 'ins_1', 1, ?, ?, 'owned-test', 'allocated', 1, 1, 1, 1, 1, 1)`)
          .run(`res_${epoch}`, epoch, epoch === 5 ? 8 : 7);
      db.prepare(`INSERT INTO operations (operation_id, instance_id, repository_id, generation,
        runtime_epoch, kind, status, phase, lease_expires_at, checkpoint_sequence, checkpoint_json,
        cluster_id, reservation_id, idempotency_scope, idempotency_key, request_hash,
        actor_id, authorization_revision, created_at, updated_at)
        VALUES ('op_5', 'ins_1', 1, 8, 5, 'redeploy', 'running', 'starting-target', ?, 2, ?,
          'owned-test', 'res_5', 'repo:1', 'test', 'test', '1', 1, 1, 1)`)
        .run(scenario === "expired-lease" ? now - 2000 : now + 60000, latest);
      const checkpoint = db.prepare(`INSERT INTO operation_checkpoints (operation_id, sequence, phase,
        runtime_epoch, checkpoint_json, actor_id, occurred_at) VALUES ('op_5', ?, ?, 5, ?, 'owned', 1)`);
      checkpoint.run(1, 'old-writer-absent', absence);
      checkpoint.run(2, 'starting-target', latest);
      if (scenario === 'pending-token')
        db.prepare(`INSERT INTO runtime_git_credentials (token_id, repository_id, installation_id,
          instance_id, runtime_id, runtime_epoch, lease_id, permission, expires_at,
          encrypted_secret_json, status, created_at, updated_at)
          VALUES (?, 1, 1, 'run_1_4', 'res_4', 4, 'res_4', 'read', ?, '{}', 'revocation_pending', 1, 1)`)
          .run('a'.repeat(64), now + 60000);
      db.exec(readFileSync(path.join(migrationDirectory, '0009_runtime_authority.sql'), 'utf8'));
      assert.deepEqual({ ...db.prepare(`SELECT runtime_authority_reservation_id AS grant_id,
        runtime_authority_operation_id AS operation_id FROM logical_instances`).get() },
        scenario === 'live' ? { grant_id: 'res_5', operation_id: 'op_5' }
          : { grant_id: null, operation_id: null });
    } finally { db.close(); }
  });
}
