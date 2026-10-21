import { readdirSync } from "node:fs";

const MIGRATION_NAME = /^\d{4}_[a-z0-9][a-z0-9_-]*\.sql$/u;

function migrationNumber(name) {
  return Number.parseInt(name.slice(0, name.indexOf("_")), 10);
}

/** Match Wrangler's migration ordering while retaining duplicate historical prefixes. */
export function compareMigrationNames(left, right) {
  const leftNumber = migrationNumber(left);
  const rightNumber = migrationNumber(right);
  if (leftNumber !== rightNumber) return leftNumber - rightNumber;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Return every top-level SQL migration in the same order Wrangler applies them. */
export function orderedMigrationFiles(directory) {
  const entries = readdirSync(directory, { withFileTypes: true });
  const invalid = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql") && !MIGRATION_NAME.test(entry.name))
    .map((entry) => entry.name);
  if (invalid.length) {
    throw new Error("invalid D1 migration filename(s): " + invalid.sort().join(", "));
  }
  const files = entries
    .filter((entry) => entry.isFile() && MIGRATION_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort(compareMigrationNames);
  if (!files.includes("0004_source_release_builds.sql")) {
    throw new Error("D1 migration set is missing 0004_source_release_builds.sql");
  }
  if (new Set(files).size !== files.length) {
    throw new Error("D1 migration filenames must be unique");
  }
  return files;
}

/** Parse Wrangler's `d1 execute --json` result for a migration-table readback. */
export function parseAppliedMigrationReadback(output) {
  let value;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error("D1 migration readback returned invalid JSON");
  }
  if (!Array.isArray(value) || value.length !== 1 || value[0]?.success !== true ||
      !Array.isArray(value[0]?.results)) {
    throw new Error("D1 migration readback did not return one successful query result");
  }
  const names = value[0].results.map((row) => row?.name);
  if (names.some((name) => typeof name !== "string" || !MIGRATION_NAME.test(name))) {
    throw new Error("D1 migration readback contains an invalid migration name");
  }
  if (new Set(names).size !== names.length) {
    throw new Error("D1 migration readback contains duplicate migration names");
  }
  return names;
}

/**
 * Require complete migration-history parity without rewriting historical receipt order.
 * Older D1 databases can have duplicate-prefix migrations recorded in an order that
 * differs from a clean install. New migrations still must follow their prerequisites.
 */
export function assertMigrationReadback(expectedFiles, appliedFiles) {
  const expected = [...expectedFiles];
  const applied = [...appliedFiles];
  const missing = expected.filter((name) => !applied.includes(name));
  const unexpected = applied.filter((name) => !expected.includes(name));
  if (missing.length || unexpected.length) {
    const parts = [];
    if (missing.length) parts.push("not applied: " + missing.join(", "));
    if (unexpected.length) parts.push("unknown applied migrations: " + unexpected.join(", "));
    throw new Error("D1 migration history does not match this checkout (" + parts.join("; ") + ")");
  }
  const recoveryMigration = "0007_source_release_recovery.sql";
  if (expected.includes(recoveryMigration)) {
    const appliedPosition = new Map(applied.map((name, index) => [name, index]));
    const recoveryPosition = appliedPosition.get(recoveryMigration);
    const prerequisites = expected.filter((name) =>
      name !== recoveryMigration && migrationNumber(name) < migrationNumber(recoveryMigration));
    const laterPrerequisite = prerequisites.find((name) => appliedPosition.get(name) > recoveryPosition);
    if (laterPrerequisite) {
      throw new Error(
        "D1 migration " + recoveryMigration + " was applied before prerequisite " + laterPrerequisite,
      );
    }
  }
  return true;
}
