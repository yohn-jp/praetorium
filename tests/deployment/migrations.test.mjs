import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
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
