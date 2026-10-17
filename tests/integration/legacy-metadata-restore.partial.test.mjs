import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migrationDirectory = path.join(repositoryRoot, "apps/control-plane/migrations");
const cliPath = path.join(repositoryRoot, "plugins/legacy-recovery/src/cli.ts");
const ownedEvidencePaths = [
  "tests/integration/legacy-metadata-restore.partial.test.mjs",
  "docs/verification/LEGACY-METADATA-PARTIAL.md",
];
const resticPath = process.env.RESTIC_BIN;
const wranglerPath =
  process.env.WRANGLER_BIN ?? path.join(repositoryRoot, "node_modules/.bin/wrangler");
const maxOutputBytes = 8 * 1024 * 1024;

function assertCleanProductionTree() {
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
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
}

async function run(command, args, options) {
  try {
    return await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: "utf8",
      maxBuffer: maxOutputBytes,
      timeout: 120_000,
    });
  } catch (error) {
    const detail = String(error.stderr ?? error.stdout ?? error.message ?? "unknown error").trim();
    throw new Error(`${path.basename(command)} ${args[0] ?? ""} failed: ${detail}`, {
      cause: error,
    });
  }
}

async function runExpectingFailure(command, args, options) {
  try {
    await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: "utf8",
      maxBuffer: maxOutputBytes,
      timeout: 120_000,
    });
  } catch (error) {
    return String(error.stderr ?? error.stdout ?? error.message ?? "");
  }
  assert.fail(`${path.basename(command)} ${args[0] ?? ""} unexpectedly succeeded`);
}

async function requireExecutable(file, label) {
  assert.ok(file, `${label} must be configured`);
  await access(file, constants.X_OK).catch(() => {
    assert.fail(`${label} is not executable: ${file}`);
  });
}

async function findFiles(directory, filename) {
  const matches = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && entry.name === filename) matches.push(candidate);
    }
  }
  return matches;
}

test(
  "locally exports current D1 migrations, stores an encrypted Restic snapshot, and verifies an isolated restore",
  {
    skip: resticPath ? false : "set RESTIC_BIN to the pinned official Restic 0.19.1 binary",
    timeout: 180_000,
  },
  async (t) => {
    const committedHead = assertCleanProductionTree();
    await requireExecutable(resticPath, "RESTIC_BIN");
    await requireExecutable(wranglerPath, "WRANGLER_BIN or node_modules/.bin/wrangler");
    assert.match(
      process.versions.node,
      /^24\./u,
      "this partial run uses the declared Node 24 baseline",
    );

    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "praetorium-t13-owned-restore-"));
    await chmod(tempRoot, 0o700);
    t.after(async () => rm(tempRoot, { recursive: true, force: true }));

    const home = path.join(tempRoot, "home");
    const state = path.join(tempRoot, "wrangler-project");
    const archiveInput = path.join(tempRoot, "metadata-input");
    const snapshotRestore = path.join(tempRoot, "restic-restore");
    const stagedRestore = path.join(tempRoot, "metadata-staged");
    const repoPath = path.join(tempRoot, "restic-repository");
    await Promise.all(
      [home, state, archiveInput, snapshotRestore].map((directory) =>
        mkdir(directory, { mode: 0o700 }),
      ),
    );

    const childPath = [
      ...new Set(
        [
          ...(process.env.PATH ?? "").split(path.delimiter),
          path.dirname(process.execPath),
          path.dirname(wranglerPath),
          path.dirname(resticPath),
          "/usr/bin",
          "/bin",
        ].filter(Boolean),
      ),
    ].join(path.delimiter);
    const wranglerEnv = {
      PATH: childPath,
      HOME: home,
      TMPDIR: tempRoot,
      CI: "1",
      WRANGLER_SEND_METRICS: "false",
    };
    const recoveryPassphrase = randomBytes(32).toString("base64url");
    const keyPath = path.join(tempRoot, "metadata-recovery-key");
    await writeFile(keyPath, `${recoveryPassphrase}\n`, { mode: 0o600, flag: "wx" });
    const resticPasswordPath = path.join(tempRoot, "restic-password");
    await writeFile(resticPasswordPath, `${randomBytes(32).toString("hex")}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    const resticEnv = {
      ...wranglerEnv,
      RESTIC_REPOSITORY: repoPath,
      RESTIC_PASSWORD_FILE: resticPasswordPath,
      RESTIC_CACHE_DIR: path.join(tempRoot, "restic-cache"),
    };

    const version = await run(resticPath, ["version"], { cwd: tempRoot, env: resticEnv });
    assert.match(
      version.stdout,
      /^restic 0\.19\.1\b/u,
      "the documented official Restic binary is pinned",
    );

    const migrations = (await readdir(migrationDirectory))
      .filter((file) => file.endsWith(".sql"))
      .sort();
    assert.deepEqual(migrations, [
      "0001_repository_platform.sql",
      "0002_stable_release_rollouts.sql",
      "0003_staged_configurations.sql",
      "0004_runtime_git_credentials.sql",
    ]);

    const databaseName = `praetorium-t13-local-${process.pid}`;
    const databaseId = randomUUID();
    const wranglerConfig = path.join(state, "wrangler.toml");
    const wranglerConfigText = [
      'name = "praetorium-t13-owned-local-restore"',
      'compatibility_date = "2026-07-30"',
      "",
      "[[d1_databases]]",
      'binding = "CONTROL_PLANE_DB"',
      `database_name = "${databaseName}"`,
      `database_id = "${databaseId}"`,
      `migrations_dir = "${migrationDirectory}"`,
      "",
    ].join("\n");
    await writeFile(wranglerConfig, wranglerConfigText, { mode: 0o600, flag: "wx" });

    await run(
      wranglerPath,
      ["d1", "migrations", "apply", databaseName, "--local", "--config", wranglerConfig],
      { cwd: state, env: wranglerEnv },
    );

    // This synthetic row is confined to the disposable D1 created above. No producer or user state is imported.
    const seedSql = path.join(tempRoot, "synthetic-platform-binding.sql");
    const instanceId = "ins_t13_local_restore";
    const repositoryId = 7_413_001;
    await writeFile(
      seedSql,
      [
        "INSERT INTO logical_instances (instance_id, repository_id, generation, runtime_epoch, desired_state, policy, created_at, updated_at)",
        `VALUES ('${instanceId}', ${repositoryId}, 1, 0, 'stopped', 'stable', 1, 1);`,
        "INSERT INTO repository_bindings (repository_id, instance_id, installation_id, owner, name, created_at, updated_at)",
        `VALUES (${repositoryId}, '${instanceId}', 8413001, 't13-owned-test', 'metadata-restore', 1, 1);`,
        "",
      ].join("\n"),
      { mode: 0o600, flag: "wx" },
    );
    await run(
      wranglerPath,
      ["d1", "execute", databaseName, "--local", `--file=${seedSql}`, "--config", wranglerConfig],
      { cwd: state, env: wranglerEnv },
    );

    const exportPath = path.join(tempRoot, "d1-export.sql");
    await run(
      wranglerPath,
      [
        "d1",
        "export",
        databaseName,
        "--local",
        `--output=${exportPath}`,
        "--config",
        wranglerConfig,
      ],
      { cwd: state, env: wranglerEnv },
    );
    const exportedSql = await readFile(exportPath, "utf8");
    assert.match(exportedSql, /CREATE TABLE logical_instances/u);
    assert.match(exportedSql, /CREATE TABLE repository_bindings/u);

    const checksums = Object.fromEntries(
      await Promise.all(
        migrations.map(async (filename) => [
          filename,
          createHash("sha256")
            .update(await readFile(path.join(migrationDirectory, filename)))
            .digest("hex"),
        ]),
      ),
    );
    const migrationChecksumPath = path.join(archiveInput, "migration-checksums.json");
    await writeFile(migrationChecksumPath, `${JSON.stringify(checksums, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    const platformConfig = {
      format: "praetorium.owned-local-metadata-test-config.v1",
      name: "praetorium-t13-owned-local-restore",
      compatibilityDate: "2026-07-30",
      d1: {
        binding: "CONTROL_PLANE_DB",
        databaseName,
        databaseId,
        migrationsDirectory: migrationDirectory,
      },
    };
    await writeFile(path.join(archiveInput, "d1-export.sql"), exportedSql, {
      mode: 0o600,
      flag: "wx",
    });
    await writeFile(
      path.join(archiveInput, "platform-config.json"),
      `${JSON.stringify(platformConfig, null, 2)}\n`,
      { mode: 0o600, flag: "wx" },
    );
    await writeFile(
      path.join(archiveInput, "source.json"),
      `${JSON.stringify(
        {
          format: "praetorium.metadata-source.v1",
          source: {
            environment: "owned-local-partial-test",
            databaseName,
            databaseId,
            sourceRevision: committedHead,
            recoveryPointId: randomUUID(),
          },
        },
        null,
        2,
      )}\n`,
      { mode: 0o600, flag: "wx" },
    );

    const archivePath = path.join(tempRoot, "metadata-backup.praetorium");
    const cliArgs = ["--experimental-strip-types", cliPath];
    const backup = await run(
      process.execPath,
      [
        ...cliArgs,
        "metadata-backup",
        "--input-dir",
        archiveInput,
        "--output",
        archivePath,
        "--key-file",
        keyPath,
      ],
      { cwd: repositoryRoot, env: wranglerEnv },
    );
    assert.equal(JSON.parse(backup.stdout).encrypted, true);

    await run(resticPath, ["init"], { cwd: tempRoot, env: resticEnv });
    const resticBackup = await run(
      resticPath,
      ["backup", "--json", "--quiet", "--tag", "praetorium-t13-owned-local-partial", archivePath],
      { cwd: tempRoot, env: resticEnv },
    );
    const summary = resticBackup.stdout
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .findLast((event) => event.message_type === "summary");
    assert.match(summary?.snapshot_id ?? "", /^[0-9a-f]{64}$/u);
    const snapshotList = await run(resticPath, ["snapshots", "--json", summary.snapshot_id], {
      cwd: tempRoot,
      env: resticEnv,
    });
    const snapshots = JSON.parse(snapshotList.stdout);
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].id, summary.snapshot_id);
    assert.ok(snapshots[0].tags.includes("praetorium-t13-owned-local-partial"));
    assert.ok(
      snapshots[0].paths.some((entry) => path.basename(entry) === path.basename(archivePath)),
    );
    await run(resticPath, ["check", "--read-data"], { cwd: tempRoot, env: resticEnv });

    await run(resticPath, ["restore", summary.snapshot_id, "--target", snapshotRestore], {
      cwd: tempRoot,
      env: resticEnv,
    });
    const restoredArchives = await findFiles(snapshotRestore, path.basename(archivePath));
    assert.equal(restoredArchives.length, 1, "the actual Restic restore must contain one archive");
    assert.deepEqual(await readFile(restoredArchives[0]), await readFile(archivePath));

    const verified = await run(
      process.execPath,
      [...cliArgs, "metadata-verify", "--archive", restoredArchives[0], "--key-file", keyPath],
      { cwd: repositoryRoot, env: wranglerEnv },
    );
    assert.equal(JSON.parse(verified.stdout).authenticated, true);
    assert.equal(JSON.parse(verified.stdout).sqlImported, false);

    const staged = await run(
      process.execPath,
      [
        ...cliArgs,
        "metadata-restore",
        "--archive",
        restoredArchives[0],
        "--destination",
        stagedRestore,
        "--key-file",
        keyPath,
      ],
      { cwd: repositoryRoot, env: wranglerEnv },
    );
    const stagedReceipt = JSON.parse(staged.stdout);
    assert.equal(stagedReceipt.sqlImported, false);
    assert.equal(stagedReceipt.destinationIsolated, true);
    assert.equal((await stat(stagedRestore)).mode & 0o077, 0);
    for (const filename of [
      "d1-export.sql",
      "migration-checksums.json",
      "platform-config.json",
      "manifest.json",
    ]) {
      assert.equal((await stat(path.join(stagedRestore, filename))).mode & 0o777, 0o600);
    }

    // Execute only in Node's disposable in-memory SQLite connection; the CLI kept the SQL inert.
    const isolatedDb = new DatabaseSync(":memory:");
    try {
      isolatedDb.exec(await readFile(path.join(stagedRestore, "d1-export.sql"), "utf8"));
      assert.deepEqual(
        isolatedDb
          .prepare(
            "SELECT i.instance_id, i.repository_id, i.desired_state, b.owner, b.name FROM logical_instances i JOIN repository_bindings b USING (repository_id, instance_id)",
          )
          .all()
          .map((row) => ({ ...row })),
        [
          {
            instance_id: instanceId,
            repository_id: repositoryId,
            desired_state: "stopped",
            owner: "t13-owned-test",
            name: "metadata-restore",
          },
        ],
      );
      assert.deepEqual(
        isolatedDb
          .prepare("SELECT name FROM d1_migrations ORDER BY name")
          .all()
          .map((row) => ({ ...row })),
        migrations.map((name) => ({ name })),
      );
    } finally {
      isolatedDb.close();
    }

    const archiveObject = JSON.parse(await readFile(archivePath, "utf8"));
    const ciphertext = Buffer.from(archiveObject.ciphertext, "base64");
    ciphertext[Math.floor(ciphertext.length / 2)] ^= 1;
    archiveObject.ciphertext = ciphertext.toString("base64");
    const tamperedArchive = path.join(tempRoot, "tampered-metadata-backup.praetorium");
    await writeFile(tamperedArchive, `${JSON.stringify(archiveObject)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    const tamperFailure = await runExpectingFailure(
      process.execPath,
      [
        ...cliArgs,
        "metadata-restore",
        "--archive",
        tamperedArchive,
        "--destination",
        path.join(tempRoot, "must-not-restore-tampered-archive"),
        "--key-file",
        keyPath,
      ],
      { cwd: repositoryRoot, env: wranglerEnv },
    );
    assert.match(tamperFailure, /metadata archive authentication failed/u);
    await access(path.join(tempRoot, "must-not-restore-tampered-archive")).then(
      () => assert.fail("tampered restore must not create a destination"),
      () => undefined,
    );
  },
);
