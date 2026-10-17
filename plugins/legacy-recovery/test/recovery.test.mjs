import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  buildLegacyImportPlan,
  createD1ResticBackup,
  createLegacyPvcSnapshot,
  decryptMetadataBackup,
  encryptMetadataBackup,
  stageLegacyD1ResticRestore,
} from "../src/recovery.ts";
import { validateOffHostResticDestination } from "../src/restic-destination.ts";

const DATABASE_ID = "c89db32e-83f4-4e62-8cd7-7c8f97659029";
const REVISION = "534b6868432cd2e62df04d22f1e3dac6341b9aaf";
const INSTANCE_A = "ins_0123456789ABCDEFGHJKMNPQRS";
const INSTANCE_B = "ins_1123456789ABCDEFGHJKMNPQRS";
const VOLUME_UID = "e3cbf4e4-6252-4c89-a1ea-7787ca8f37e5";
const IMAGE_DIGEST = `sha256:${"b".repeat(64)}`;
const SNAPSHOT_ID = "a".repeat(64);
const PASSPHRASE = "fixture-recovery-passphrase-opaque";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function platformExport() {
  return {
    format: "praetorium.legacy-platform-export.v1",
    source: { system: "arcadia-platform", exportId: "export-17", revision: REVISION },
    users: [
      { id: "usr_a", role: "admin", permissions: ["read", "write"] },
      { id: "usr_b", role: "owner", permissions: ["read", "write"] },
    ],
    instances: [
      { id: INSTANCE_A, origin: "https://old-a.example.test", userIds: ["usr_a"] },
      { id: INSTANCE_B, origin: "https://old-b.example.test", userIds: ["usr_b"] },
    ],
    releases: [
      { id: "rel_0123456789ABCDEFGHJKMNPQRS", instanceId: INSTANCE_A },
      { id: "rel_1123456789ABCDEFGHJKMNPQRS", instanceId: INSTANCE_B },
    ],
    auditEvents: [
      { id: "audit-a", instanceId: INSTANCE_A },
      { id: "audit-b", instanceId: INSTANCE_B },
    ],
  };
}

function producerManifests(overrides = {}) {
  return [
    {
      format: "praetorium.legacy-producer-manifest.v1",
      exportId: "producer-a",
      sourceInstanceId: INSTANCE_A,
      repositories: [
        {
          repositoryId: "12345",
          owner: "sophia",
          name: "notes",
          installationId: "991",
          publicationState: "published",
        },
      ],
    },
    {
      format: "praetorium.legacy-producer-manifest.v1",
      exportId: "producer-b",
      sourceInstanceId: INSTANCE_B,
      repositories: [
        {
          repositoryId: "12345",
          owner: "sophia",
          name: "notes",
          installationId: "991",
          publicationState: "producer-exported",
        },
      ],
    },
  ].map((manifest, index) => (index === 1 ? { ...manifest, ...overrides.manifestB } : manifest));
}

async function tempDir(t, prefix = "praetorium-legacy-recovery-test-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("offline import plan splits per repository, deduplicates shared repository IDs, and records origin/provenance without grants", () => {
  const platform = platformExport();
  const manifests = producerManifests();
  const origins = { 12345: "https://new-instance.example.test" };
  const first = buildLegacyImportPlan({
    platform,
    producerManifests: manifests,
    targetOrigins: origins,
  });
  const second = buildLegacyImportPlan({
    platform,
    producerManifests: manifests,
    targetOrigins: origins,
  });

  assert.equal(first.planId, second.planId, "repeating an offline plan must be deterministic");
  assert.equal(first.mode, "offline-dry-run");
  assert.equal(first.writesPerformed, false);
  assert.equal(first.summary.repositoryBindingCount, 1);
  assert.equal(first.summary.deduplicatedBindingCount, 1);
  assert.equal(first.summary.reviewStatus, "ready-for-review");
  assert.deepEqual(
    first.bindings[0].sourceInstances.map((entry) => entry.instanceId),
    [INSTANCE_A, INSTANCE_B],
  );
  assert.deepEqual(first.bindings[0].sourceOrigins, [
    "https://old-a.example.test",
    "https://old-b.example.test",
  ]);
  assert.equal(first.bindings[0].targetBindingKey, "repo:12345");
  assert.equal(first.bindings[0].targetInstanceId, null);
  assert.equal(first.bindings[0].targetOrigin, origins["12345"]);
  assert.equal(first.bindings[0].browserStorageMigrated, false);
  assert.equal(first.bindings[0].legacyAclImported, false);
  assert.equal(first.bindings[0].accessTokensImported, false);
  assert.equal(first.bindings[0].applicationData.disposition, "producer-exported");
  assert.deepEqual(
    first.originMappings.map((entry) => entry.targetOrigin),
    [origins["12345"], origins["12345"]],
  );
  assert.equal(first.access.reauthenticationRequired, true);
  assert.equal(JSON.stringify(first).includes("permissions"), false);
  assert.equal(JSON.stringify(first).includes('"admin"'), false);
  assert.equal(JSON.stringify(first).includes("access_token"), false);
});

test("one legacy instance with several repositories becomes separate target bindings", () => {
  const platform = platformExport();
  platform.instances = [platform.instances[0]];
  platform.releases = platform.releases.filter((release) => release.instanceId === INSTANCE_A);
  platform.auditEvents = platform.auditEvents.filter((event) => event.instanceId === INSTANCE_A);
  const manifest = {
    format: "praetorium.legacy-producer-manifest.v1",
    exportId: "multi-repository-producer",
    sourceInstanceId: INSTANCE_A,
    repositories: [
      {
        repositoryId: "12345",
        owner: "sophia",
        name: "notes",
        installationId: "991",
        publicationState: "published",
      },
      {
        repositoryId: "23456",
        owner: "sophia",
        name: "research",
        installationId: "991",
        publicationState: "producer-exported",
      },
    ],
  };
  const report = buildLegacyImportPlan({ platform, producerManifests: [manifest] });
  assert.equal(report.bindings.length, 2);
  assert.deepEqual(
    report.bindings.map((binding) => binding.targetBindingKey),
    ["repo:12345", "repo:23456"],
  );
  assert.deepEqual(report.sourceInstanceMappings[0].targetBindingKeys, [
    "repo:12345",
    "repo:23456",
  ]);
});

test("missing producer export preserves the source origin and creates an unresolved provenance record", () => {
  const report = buildLegacyImportPlan({
    platform: platformExport(),
    producerManifests: [producerManifests()[0]],
  });
  const unresolved = report.bindings.find(
    (binding) => binding.targetBindingKey === `unresolved:${INSTANCE_B}`,
  );
  assert.ok(unresolved);
  assert.equal(unresolved.status, "blocked");
  assert.equal(unresolved.sourceInstances[0].sourceOrigin, "https://old-b.example.test");
  assert.equal(unresolved.sourceInstances[0].sourceUserIds[0], "usr_b");
  assert.deepEqual(report.sourceInstanceMappings[1].targetBindingKeys, [
    `unresolved:${INSTANCE_B}`,
  ]);
  assert.equal(
    report.originMappings.find((mapping) => mapping.sourceInstanceId === INSTANCE_B).repositoryId,
    null,
  );
});

test("offline import report blocks installation conflicts and unresolved local work", () => {
  const manifests = producerManifests({
    manifestB: {
      repositories: [
        {
          repositoryId: "12345",
          owner: "sophia",
          name: "notes",
          installationId: "992",
          publicationState: "pending",
        },
      ],
    },
  });
  const report = buildLegacyImportPlan({
    platform: platformExport(),
    producerManifests: manifests,
  });
  assert.equal(report.summary.reviewStatus, "blocked");
  assert.equal(report.bindings[0].installationId, null);
  assert.equal(report.bindings[0].applicationData.unresolvedLocalWork, true);
  assert.equal(report.bindings[0].applicationData.disposition, "retain-legacy-data");
  assert.deepEqual(
    new Set(report.bindings[0].conflicts.map((entry) => entry.code)),
    new Set(["installation-conflict", "unresolved-local-work"]),
  );
});

test("import refuses credential-bearing fields and reports an unmapped target origin", () => {
  const noTarget = buildLegacyImportPlan({
    platform: platformExport(),
    producerManifests: producerManifests(),
  });
  assert.equal(noTarget.summary.reviewStatus, "requires-target-origin");
  assert.equal(noTarget.summary.missingTargetOriginCount, 1);
  assert.equal(noTarget.originMappings[0].targetOrigin, null);
  assert.throws(
    () =>
      buildLegacyImportPlan({
        platform: { ...platformExport(), access_token: "must-not-enter-a-migration" },
        producerManifests: producerManifests(),
      }),
    /credential-bearing/,
  );
});

test("import-plan CLI reads explicit exports and emits a dry-run only", async (t) => {
  const root = await tempDir(t);
  const platformPath = join(root, "platform-export.json");
  const producerPath = join(root, "producer-manifests.json");
  const originsPath = join(root, "target-origins.json");
  await writeFile(platformPath, JSON.stringify(platformExport()), { mode: 0o600 });
  await writeFile(producerPath, JSON.stringify(producerManifests()), { mode: 0o600 });
  await writeFile(originsPath, JSON.stringify({ 12345: "https://new-instance.example.test" }), {
    mode: 0o600,
  });
  const cli = resolve("src/cli.ts");
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      cli,
      "import-plan",
      "--platform-export",
      platformPath,
      "--producer-manifests",
      producerPath,
      "--origin-map",
      originsPath,
    ],
    { cwd: resolve("../.."), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode, "offline-dry-run");
  assert.equal(report.writesPerformed, false);
  assert.equal(report.summary.repositoryBindingCount, 1);
  assert.equal(report.bindings[0].sourceInstances.length, 2);
});

test("metadata archive encrypts its contents, authenticates tampering, and checks payload files", () => {
  const files = {
    "d1-export.sql": Buffer.from("CREATE TABLE fixture(id TEXT);"),
    "migration-checksums.json": Buffer.from('{"0001_init.sql":"abc"}'),
    "platform-config.json": Buffer.from('{"d1Database":"cp-db"}'),
  };
  const archive = encryptMetadataBackup(
    files,
    {
      environment: "test",
      databaseName: "cp-db",
      databaseId: DATABASE_ID,
      sourceRevision: REVISION,
    },
    PASSPHRASE,
    "2026-10-17T00:00:00.000Z",
  );
  assert.equal(archive.includes(files["d1-export.sql"]), false);
  assert.equal(archive.toString("utf8").includes("CREATE TABLE"), false);
  const recovered = decryptMetadataBackup(archive, PASSPHRASE);
  assert.equal(recovered.manifest.source.databaseId, DATABASE_ID);
  assert.equal(digest(recovered.files["d1-export.sql"]), digest(files["d1-export.sql"]));
  assert.throws(
    () => decryptMetadataBackup(archive, "wrong-recovery-passphrase"),
    /authentication failed/,
  );
  const tampered = Buffer.from(archive);
  tampered[tampered.indexOf(Buffer.from('"ciphertext":"')) + 15] ^= 1;
  assert.throws(
    () => decryptMetadataBackup(tampered, PASSPHRASE),
    /authentication failed|not valid JSON/,
  );
});

test("metadata CLI backs up, verifies, and stages an isolated restore without importing SQL", async (t) => {
  const root = await tempDir(t);
  const input = join(root, "input");
  await (await import("node:fs/promises")).mkdir(input, { mode: 0o700 });
  const sql =
    "CREATE TABLE metadata_fixture(id TEXT);\nINSERT INTO metadata_fixture VALUES ('opaque');\n";
  await writeFile(
    join(input, "source.json"),
    JSON.stringify({
      format: "praetorium.metadata-source.v1",
      source: {
        environment: "test",
        databaseName: "cp-db",
        databaseId: DATABASE_ID,
        sourceRevision: REVISION,
        recoveryPointId: "76b8dd8b-fd4e-4fb5-9576-c31531e52303",
      },
    }),
    { mode: 0o600 },
  );
  await writeFile(join(input, "d1-export.sql"), sql, { mode: 0o600 });
  await writeFile(join(input, "migration-checksums.json"), '{"0001_init.sql":"abc"}\n', {
    mode: 0o600,
  });
  await writeFile(join(input, "platform-config.json"), '{"d1":"cp-db"}\n', { mode: 0o600 });
  const keyFile = join(root, "recovery.key");
  await writeFile(keyFile, `${PASSPHRASE}\n`, { mode: 0o600 });
  const archivePath = join(root, "metadata.prmeta");
  const restored = join(root, "isolated-restore");
  const cli = resolve("src/cli.ts");
  const packageRoot = resolve(".");
  const checkoutRoot = resolve("../..");
  const invoke = (...args) =>
    spawnSync(process.execPath, ["--experimental-strip-types", cli, ...args], {
      cwd: packageRoot,
      encoding: "utf8",
    });

  const backup = invoke(
    "metadata-backup",
    "--input-dir",
    input,
    "--output",
    archivePath,
    "--key-file",
    keyFile,
  );
  assert.equal(backup.status, 0, backup.stderr);
  const receipt = JSON.parse(backup.stdout);
  assert.equal(receipt.encrypted, true);
  assert.equal(receipt.sourceDatabaseId, DATABASE_ID);
  const archive = await readFile(archivePath);
  assert.equal(archive.toString("utf8").includes(sql), false);

  const verify = invoke("metadata-verify", "--archive", archivePath, "--key-file", keyFile);
  assert.equal(verify.status, 0, verify.stderr);
  assert.equal(JSON.parse(verify.stdout).authenticated, true);

  const restore = invoke(
    "metadata-restore",
    "--archive",
    archivePath,
    "--destination",
    restored,
    "--key-file",
    keyFile,
  );
  assert.equal(restore.status, 0, restore.stderr);
  assert.equal(JSON.parse(restore.stdout).sqlImported, false);
  assert.equal(await readFile(join(restored, "d1-export.sql"), "utf8"), sql);
  assert.equal((await stat(restored)).mode & 0o777, 0o700);
  assert.equal((await stat(join(restored, "d1-export.sql"))).mode & 0o777, 0o600);

  const inCheckout = join(packageRoot, "must-not-be-restored");
  const refused = invoke(
    "metadata-restore",
    "--archive",
    archivePath,
    "--destination",
    inCheckout,
    "--key-file",
    keyFile,
  );
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /outside the source checkout/);

  const legacyRefused = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      cli,
      "legacy-d1-restore",
      "--remote",
      "--snapshot-id",
      "a".repeat(64),
      "--destination",
      join(checkoutRoot, "plugins/legacy-recovery/legacy-must-not-be-restored"),
    ],
    {
      cwd: packageRoot,
      env: {
        ...process.env,
        RESTIC_REPOSITORY: "s3:s3.amazonaws.com/legacy-cli-test",
        PRAETORIUM_OFFHOST_RESTIC_REPOSITORY: "s3:s3.amazonaws.com/legacy-cli-test",
        RESTIC_PASSWORD: "legacy-cli-test-secret",
      },
      encoding: "utf8",
    },
  );
  assert.equal(legacyRefused.status, 1);
  assert.match(legacyRefused.stderr, /outside the source checkout/);

  const changedArchive = Buffer.from(archive);
  const ciphertextStart =
    changedArchive.indexOf(Buffer.from('"ciphertext":"')) + Buffer.byteLength('"ciphertext":"');
  changedArchive[ciphertextStart] = changedArchive[ciphertextStart] === 65 ? 66 : 65;
  const tamperedPath = join(root, "tampered.prmeta");
  await writeFile(tamperedPath, changedArchive, { mode: 0o600 });
  const tamperedDestination = join(root, "tampered-restore");
  const tampered = invoke(
    "metadata-restore",
    "--archive",
    tamperedPath,
    "--destination",
    tamperedDestination,
    "--key-file",
    keyFile,
  );
  assert.equal(tampered.status, 1);
  assert.match(tampered.stderr, /authentication failed/);
  await assert.rejects(stat(tamperedDestination));
});

test("off-host Restic destination validation binds owner-approved remote identity and rejects local targets", () => {
  assert.throws(
    () =>
      validateOffHostResticDestination({
        RESTIC_REPOSITORY: "s3:s3.amazonaws.com/praetorium/recovery",
        RESTIC_PASSWORD: "opaque-test-password",
      }),
    /exactly match the owner-approved/,
  );
  assert.throws(
    () =>
      validateOffHostResticDestination({
        RESTIC_REPOSITORY: "rest:http://127.0.0.1:8000/recovery",
        PRAETORIUM_OFFHOST_RESTIC_REPOSITORY: "rest:http://127.0.0.1:8000/recovery",
        RESTIC_PASSWORD: "opaque-test-password",
      }),
    /loopback or local endpoint/,
  );
  assert.throws(
    () =>
      validateOffHostResticDestination({
        RESTIC_REPOSITORY: "rest:http://[::ffff:7f00:1]:8000/recovery",
        PRAETORIUM_OFFHOST_RESTIC_REPOSITORY: "rest:http://[::ffff:7f00:1]:8000/recovery",
        RESTIC_PASSWORD: "opaque-test-password",
      }),
    /loopback or local endpoint/,
  );
  assert.throws(
    () =>
      validateOffHostResticDestination({
        RESTIC_REPOSITORY: "s3:/tmp/recovery",
        PRAETORIUM_OFFHOST_RESTIC_REPOSITORY: "s3:/tmp/recovery",
        RESTIC_PASSWORD: "opaque-test-password",
      }),
    /local filesystem path/,
  );
  assert.throws(
    () =>
      validateOffHostResticDestination({
        RESTIC_REPOSITORY: "s3:127.0.0.1:9000/recovery",
        PRAETORIUM_OFFHOST_RESTIC_REPOSITORY: "s3:127.0.0.1:9000/recovery",
        RESTIC_PASSWORD: "opaque-test-password",
      }),
    /loopback or local endpoint/,
  );
  assert.throws(
    () =>
      validateOffHostResticDestination({
        RESTIC_REPOSITORY: "s3:localhost/recovery",
        PRAETORIUM_OFFHOST_RESTIC_REPOSITORY: "s3:localhost/recovery",
        RESTIC_PASSWORD: "opaque-test-password",
      }),
    /loopback or local endpoint/,
  );
  assert.throws(
    () =>
      validateOffHostResticDestination({
        RESTIC_REPOSITORY: "sftp:operator@localhost:recovery",
        PRAETORIUM_OFFHOST_RESTIC_REPOSITORY: "sftp:operator@localhost:recovery",
        RESTIC_PASSWORD: "opaque-test-password",
      }),
    /loopback or local endpoint/,
  );
  assert.throws(
    () =>
      validateOffHostResticDestination({
        RESTIC_REPOSITORY: "s3:http://localhost:9000/recovery",
        PRAETORIUM_OFFHOST_RESTIC_REPOSITORY: "s3:http://localhost:9000/recovery",
        RESTIC_PASSWORD: "opaque-test-password",
      }),
    /loopback or local endpoint/,
  );
  assert.throws(
    () =>
      validateOffHostResticDestination({
        RESTIC_REPOSITORY: "s3:s3.amazonaws.com/praetorium/recovery",
        PRAETORIUM_OFFHOST_RESTIC_REPOSITORY: "s3:s3.amazonaws.com/praetorium/recovery",
        RESTIC_REPOSITORY_FILE: "/protected/alternate-repository",
        RESTIC_PASSWORD: "opaque-test-password",
      }),
    /RESTIC_REPOSITORY_FILE is an unsupported conflicting configuration/,
  );
  assert.throws(
    () =>
      validateOffHostResticDestination({
        RESTIC_REPOSITORY: "s3:s3.amazonaws.com/other/recovery",
        PRAETORIUM_OFFHOST_RESTIC_REPOSITORY: "s3:s3.amazonaws.com/approved/recovery",
        RESTIC_PASSWORD: "opaque-test-password",
      }),
    /exactly match the owner-approved/,
  );

  const repository = "s3:s3.amazonaws.com/praetorium/recovery";
  assert.deepEqual(
    validateOffHostResticDestination({
      RESTIC_REPOSITORY: repository,
      PRAETORIUM_OFFHOST_RESTIC_REPOSITORY: repository,
      RESTIC_PASSWORD: "opaque-test-password",
    }),
    {
      backend: "s3",
      endpoint: "s3.amazonaws.com",
      repositoryScope: "praetorium/recovery",
      fingerprint: digest(repository),
      destinationIdentityFingerprint: digest(
        JSON.stringify({
          format: "praetorium.offhost-restic-destination.v1",
          backend: "s3",
          endpoint: "s3.amazonaws.com",
          repositoryFingerprint: digest(repository),
        }),
      ),
    },
  );

  const customRepository = "s3:https://backup-owned.example.test/recovery-bucket/praetorium";
  assert.deepEqual(
    validateOffHostResticDestination({
      RESTIC_REPOSITORY: customRepository,
      PRAETORIUM_OFFHOST_RESTIC_REPOSITORY: customRepository,
      RESTIC_PASSWORD: "opaque-test-password",
    }),
    {
      backend: "s3",
      endpoint: "https://backup-owned.example.test",
      repositoryScope: "recovery-bucket/praetorium",
      fingerprint: digest(customRepository),
      destinationIdentityFingerprint: digest(
        JSON.stringify({
          format: "praetorium.offhost-restic-destination.v1",
          backend: "s3",
          endpoint: "https://backup-owned.example.test",
          repositoryFingerprint: digest(customRepository),
        }),
      ),
    },
  );

  const portRepository = "s3:backup-owned.example.test:9000/recovery-bucket/praetorium";
  assert.deepEqual(
    validateOffHostResticDestination({
      RESTIC_REPOSITORY: portRepository,
      PRAETORIUM_OFFHOST_RESTIC_REPOSITORY: portRepository,
      RESTIC_PASSWORD: "opaque-test-password",
    }),
    {
      backend: "s3",
      endpoint: "backup-owned.example.test:9000",
      repositoryScope: "recovery-bucket/praetorium",
      fingerprint: digest(portRepository),
      destinationIdentityFingerprint: digest(
        JSON.stringify({
          format: "praetorium.offhost-restic-destination.v1",
          backend: "s3",
          endpoint: "backup-owned.example.test:9000",
          repositoryFingerprint: digest(portRepository),
        }),
      ),
    },
  );

  const sftpRepository = "sftp:operator@backup.example.test:relative/recovery";
  assert.deepEqual(
    validateOffHostResticDestination({
      RESTIC_REPOSITORY: sftpRepository,
      PRAETORIUM_OFFHOST_RESTIC_REPOSITORY: sftpRepository,
      RESTIC_PASSWORD: "opaque-test-password",
    }),
    {
      backend: "sftp",
      endpoint: "backup.example.test",
      repositoryScope: "relative/recovery",
      fingerprint: digest(sftpRepository),
      destinationIdentityFingerprint: digest(
        JSON.stringify({
          format: "praetorium.offhost-restic-destination.v1",
          backend: "sftp",
          endpoint: "backup.example.test",
          repositoryFingerprint: digest(sftpRepository),
        }),
      ),
    },
  );
});

test("remote D1 CLI path exports only the named remote database, keeps Restic secrets out of Wrangler, and verifies its archive", async (t) => {
  const root = await tempDir(t);
  const config = join(root, "wrangler.toml");
  const checksums = join(root, "checksums.json");
  const keyFile = join(root, "recovery.key");
  const output = join(root, "metadata.prmeta");
  await writeFile(config, 'name = "fixture"\n', { mode: 0o600 });
  const checksumsBytes = Buffer.from('{"0001_initial.sql":"checksum"}\n');
  await writeFile(checksums, checksumsBytes, { mode: 0o600 });
  await writeFile(keyFile, PASSPHRASE, { mode: 0o600 });
  const calls = [];
  const env = {
    PATH: process.env.PATH,
    RESTIC_REPOSITORY: "s3:s3.amazonaws.com/praetorium-recovery-test",
    PRAETORIUM_OFFHOST_RESTIC_REPOSITORY: "s3:s3.amazonaws.com/praetorium-recovery-test",
    RESTIC_PASSWORD: "restic-fixture-secret",
    CLOUDFLARE_API_TOKEN: "cloudflare-fixture-secret",
  };
  const run = async (command, args, options) => {
    calls.push({ command, args, env: options.env });
    if (command === "wrangler" && args[1] === "info")
      return { stdout: JSON.stringify({ uuid: DATABASE_ID, name: "cp-db" }) };
    if (command === "wrangler" && args[1] === "export") {
      const path = args
        .find((argument) => argument.startsWith("--output="))
        .slice("--output=".length);
      await writeFile(path, "CREATE TABLE remote_fixture(id TEXT);\n", { mode: 0o600 });
      return { stdout: "exported" };
    }
    if (command === "restic" && args[0] === "backup")
      return {
        stdout: `${JSON.stringify({ message_type: "summary", snapshot_id: SNAPSHOT_ID })}\n`,
      };
    if (command === "restic" && args[0] === "snapshots")
      return {
        stdout: JSON.stringify([
          {
            id: SNAPSHOT_ID,
            host: "operator",
            paths: [output],
            tags: ["praetorium-platform-metadata-v1"],
          },
        ]),
      };
    throw new Error(`unexpected process: ${command} ${args[0]}`);
  };
  const receipt = await createD1ResticBackup(
    {
      database: "cp-db",
      config,
      migrationChecksums: checksums,
      environment: "test",
      sourceRevision: REVISION,
      output,
      keyFile,
      remote: true,
    },
    { run, env, tempRoot: root, now: () => new Date("2026-10-17T00:00:00.000Z") },
  );
  assert.equal(receipt.snapshotId, SNAPSHOT_ID);
  const repositoryFingerprint = digest(env.RESTIC_REPOSITORY);
  assert.equal(
    receipt.destinationIdentityFingerprint,
    digest(
      JSON.stringify({
        format: "praetorium.offhost-restic-destination.v1",
        backend: "s3",
        endpoint: "s3.amazonaws.com",
        repositoryFingerprint,
      }),
    ),
  );
  assert.equal(JSON.stringify(receipt).includes("s3.amazonaws.com"), false);
  const info = calls.find((call) => call.command === "wrangler" && call.args[1] === "info");
  const exportCall = calls.find((call) => call.command === "wrangler" && call.args[1] === "export");
  const restic = calls.find((call) => call.command === "restic");
  const resticBackup = calls.find((call) => call.command === "restic" && call.args[0] === "backup");
  assert.ok(exportCall.args.includes("--remote"));
  assert.ok(resticBackup.args.includes("arcadia-platform-d1"));
  assert.ok(resticBackup.args.some((argument) => argument.startsWith("recovery-point:")));
  assert.equal(info.env.RESTIC_PASSWORD, undefined);
  assert.equal(restic.env.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(restic.env.PRAETORIUM_OFFHOST_RESTIC_REPOSITORY, undefined);
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  const decrypted = decryptMetadataBackup(await readFile(output), PASSPHRASE);
  assert.equal(decrypted.manifest.source.databaseId, DATABASE_ID);
  assert.equal(decrypted.files["migration-checksums.json"].toString(), checksumsBytes.toString());
});

test("legacy D1 Restic restore remains checksum-verified, isolated, and inert", async (t) => {
  const root = await tempDir(t);
  const checkout = join(root, "checkout");
  const destination = join(root, "legacy-restore");
  await (await import("node:fs/promises")).mkdir(checkout);
  const sql = Buffer.from("CREATE TABLE legacy_fixture(id TEXT);\n");
  const checksums = Buffer.from('{"0001_initial.sql":"legacy-checksum"}\n');
  const manifest = Buffer.from(
    JSON.stringify({
      format: "arcadia-platform.d1-recovery.v1",
      recoveryPointId: "76b8dd8b-fd4e-4fb5-9576-c31531e52303",
      environment: "test",
      source: {
        provider: "cloudflare-d1",
        databaseName: "cp-db",
        databaseId: DATABASE_ID,
        repositoryRevision: REVISION,
      },
      databaseExport: {
        file: "d1-export.sql",
        bytes: sql.byteLength,
        sha256: digest(sql),
      },
      migrationChecksums: {
        file: "migration-checksums.json",
        entries: 1,
        sha256: digest(checksums),
      },
    }),
  );
  const env = {
    RESTIC_REPOSITORY: "s3:s3.amazonaws.com/legacy-restore-fixture",
    PRAETORIUM_OFFHOST_RESTIC_REPOSITORY: "s3:s3.amazonaws.com/legacy-restore-fixture",
    RESTIC_PASSWORD: "restic-fixture-secret",
  };
  let tamperSql = false;
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, env: options.env });
    assert.equal(command, "restic");
    assert.equal(options.env.RESTIC_PASSWORD, env.RESTIC_PASSWORD);
    assert.equal(options.env.CLOUDFLARE_API_TOKEN, undefined);
    if (args[0] !== "restore") throw new Error(`unexpected Restic command: ${args[0]}`);
    assert.equal(args[1], SNAPSHOT_ID);
    const target = args[args.indexOf("--target") + 1];
    const nested = join(target, "tmp", "arcadia-d1-recovery");
    await (await import("node:fs/promises")).mkdir(nested, { recursive: true, mode: 0o700 });
    await writeFile(join(nested, "manifest.json"), manifest, { mode: 0o600 });
    await writeFile(join(nested, "d1-export.sql"), tamperSql ? "tampered\n" : sql, { mode: 0o600 });
    await writeFile(join(nested, "migration-checksums.json"), checksums, { mode: 0o600 });
    return { stdout: "restored" };
  };
  const report = await stageLegacyD1ResticRestore(
    { snapshotId: SNAPSHOT_ID, destination, remote: true },
    { run, env, repoRoot: checkout, tempRoot: root },
  );
  assert.equal(report.sourceDatabaseId, DATABASE_ID);
  assert.equal(report.d1ImportExecuted, false);
  assert.equal(await readFile(join(destination, "d1-export.sql"), "utf8"), sql.toString());
  assert.equal((await stat(destination)).mode & 0o777, 0o700);
  assert.equal((await stat(join(destination, "d1-export.sql"))).mode & 0o777, 0o600);

  tamperSql = true;
  const tamperedDestination = join(root, "tampered-legacy-restore");
  await assert.rejects(
    stageLegacyD1ResticRestore(
      { snapshotId: SNAPSHOT_ID, destination: tamperedDestination, remote: true },
      { run, env, repoRoot: checkout, tempRoot: root },
    ),
    /identity or checksum validation failed/,
  );
  await assert.rejects(stat(tamperedDestination));
  assert.equal(
    calls.some((call) => call.command === "wrangler"),
    false,
  );
});

test("legacy PVC Restic CLI requires a read-only /data mount and records the exact source identity", async (t) => {
  const root = await tempDir(t);
  const dataPath = join(root, "mounted-data");
  await (await import("node:fs/promises")).mkdir(dataPath);
  const mountInfo = `31 24 0:29 / ${dataPath} ro,relatime - ext4 /dev/legacy rw\n`;
  const tag = `arcadia-backup-v1:${INSTANCE_A}:7:${VOLUME_UID}:1.2:rel_0123456789ABCDEFGHJKMNPQRS:${IMAGE_DIGEST}`;
  const calls = [];
  const env = {
    RESTIC_REPOSITORY: "s3:https://backup.example.test/legacy",
    PRAETORIUM_OFFHOST_RESTIC_REPOSITORY: "s3:https://backup.example.test/legacy",
    RESTIC_PASSWORD: "restic-fixture-secret",
    PRAETORIUM_LEGACY_INSTANCE_ID: INSTANCE_A,
    PRAETORIUM_LEGACY_VOLUME_UID: VOLUME_UID,
    PRAETORIUM_LEGACY_SCHEMA_VERSION: "1.2",
    PRAETORIUM_LEGACY_GENERATION: "7",
    PRAETORIUM_LEGACY_RELEASE_ID: "rel_0123456789ABCDEFGHJKMNPQRS",
    PRAETORIUM_LEGACY_IMAGE_DIGEST: IMAGE_DIGEST,
  };
  const run = async (command, args, options) => {
    calls.push({ command, args, env: options.env });
    if (args[0] === "snapshots" && args.includes("--tag")) return { stdout: "[]" };
    if (args[0] === "backup")
      return {
        stdout: `${JSON.stringify({ message_type: "summary", snapshot_id: SNAPSHOT_ID })}\n`,
      };
    if (args[0] === "snapshots")
      return {
        stdout: JSON.stringify([
          {
            id: SNAPSHOT_ID,
            host: `arcadia-${INSTANCE_A.slice(0, 3)}-${INSTANCE_A.slice(4).toLowerCase()}`,
            paths: [dataPath],
            tags: [tag],
          },
        ]),
      };
    if (args[0] === "check") return { stdout: "checked" };
    throw new Error(`unexpected process: ${command} ${args[0]}`);
  };
  const receipt = await createLegacyPvcSnapshot({ run, env, mountInfo, dataPath });
  assert.equal(receipt.snapshotId, SNAPSHOT_ID);
  assert.equal(receipt.sourceVolumeUid, VOLUME_UID);
  assert.equal(receipt.readOnlyMountVerified, true);
  assert.equal(receipt.oldDataDeleted, false);
  const backup = calls.find((call) => call.args[0] === "backup");
  assert.deepEqual(backup.args.slice(-1), [dataPath]);
  assert.ok(backup.args.includes(tag));
  assert.equal(calls.at(-1).args[0], "check");
  await assert.rejects(
    createLegacyPvcSnapshot({
      run,
      env,
      dataPath,
      mountInfo: mountInfo.replace("ro,relatime", "rw,relatime"),
    }),
    /read-only/,
  );
});
