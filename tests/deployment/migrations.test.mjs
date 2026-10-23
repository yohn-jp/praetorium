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
