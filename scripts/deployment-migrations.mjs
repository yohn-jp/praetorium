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

/**
 * Validate an existing remote history before applying anything. A database can
 * be behind this checkout, and older deployments may have recorded the second
 * 0004 migration after 0005/0006. Every other migration must form a valid
 * ordered prefix; the recovery migration is only compatible after all of its
 * prerequisites are already recorded.
 */
export function assertCompatibleMigrationHistory(expectedFiles, appliedFiles) {
  const expected = [...expectedFiles];
  const applied = [...appliedFiles];
  const missingKnown = expected.filter((name) => !applied.includes(name));
  const unexpected = applied.filter((name) => !expected.includes(name));
  if (unexpected.length) {
    throw new Error("D1 migration history has unknown migrations: " + unexpected.join(", "));
  }
  if (new Set(applied).size !== applied.length) {
    throw new Error("D1 migration history contains duplicate migrations");
  }
  const sourceMigration = "0004_source_release_builds.sql";
  const recoveryMigration = "0007_source_release_recovery.sql";
  const coreExpected = expected.filter((name) => name !== sourceMigration && name !== recoveryMigration);
  const coreApplied = applied.filter((name) => name !== sourceMigration && name !== recoveryMigration);
  if (coreExpected.slice(0, coreApplied.length).join("\0") !== coreApplied.join("\0")) {
    throw new Error("D1 migration history is not a compatible ordered prefix");
  }
  if (applied.includes(sourceMigration)) {
    const requiredBeforeSource = coreExpected.slice(0, 4);
    const sourcePosition = applied.indexOf(sourceMigration);
    const missingPrerequisite = requiredBeforeSource.find((name) => !applied.includes(name));
    const latePrerequisite = requiredBeforeSource.find((name) => applied.indexOf(name) > sourcePosition);
    if (missingPrerequisite || latePrerequisite) {
      throw new Error(
        "D1 migration " + sourceMigration + " is missing or precedes prerequisite " +
        (missingPrerequisite ?? latePrerequisite),
      );
    }
  }
  if (applied.includes(recoveryMigration)) {
    const recoveryPosition = applied.indexOf(recoveryMigration);
    const prerequisite = expected.find((name) =>
      migrationNumber(name) < migrationNumber(recoveryMigration) && !applied.includes(name),
    );
    const laterPrerequisite = expected.find((name) =>
      migrationNumber(name) < migrationNumber(recoveryMigration) && applied.indexOf(name) > recoveryPosition,
    );
    if (prerequisite || laterPrerequisite) {
      throw new Error(
        "D1 migration " + recoveryMigration + " is missing or precedes prerequisite " +
        (prerequisite ?? laterPrerequisite),
      );
    }
  }
  for (const name of applied.filter((item) => migrationNumber(item) >= 8)) {
    const position = applied.indexOf(name);
    const prerequisite = expected.find((item) => migrationNumber(item) < migrationNumber(name) &&
      (!applied.includes(item) || applied.indexOf(item) > position));
    if (prerequisite) throw new Error("D1 migration " + name + " is missing or precedes prerequisite " + prerequisite);
  }
  // Force a read of all known names, including pending migrations, so malformed
  // expected sets cannot silently pass this pre-mutation gate.
  if (missingKnown.some((name) => !MIGRATION_NAME.test(name))) {
    throw new Error("D1 migration checkout contains an invalid migration name");
  }
  return true;
}

/** Read, validate, mutate, and verify as one ordered deployment operation. */
export function applyMigrationsWithPreflight(expectedFiles, readApplied, apply) {
  assertCompatibleMigrationHistory(expectedFiles, readApplied());
  apply();
  assertMigrationReadback(expectedFiles, readApplied());
}
