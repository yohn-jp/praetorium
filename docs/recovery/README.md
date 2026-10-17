# Explicit legacy recovery tools

`@praetorium/legacy-recovery` is an operator tool package. It is not a dependency of Gateway, Control Plane, Provisioner, Instance Access, or the build worker, and it has no startup hook. Its only metadata operations are offline planning, encrypted export, authenticated verification, and staging into a new isolated directory. It never writes a D1 database, migrates an ACL/token, or removes a PVC or old application work.

## Source capabilities retained

The read-only campaign source snapshot contains three recovery paths that remain relevant until a separately authorized retirement:

- `scripts/recovery/d1-restic.mjs` uses `wrangler d1 info`, explicit `wrangler d1 export --remote`, migration checksums, source revision and D1 identity, then stores the export in an off-host encrypted Restic repository. Its restore stages and verifies SQL but does not execute the SQL.
- `packages/runtime/src/kubernetes/provider.ts` implements `RuntimeRecoveryProvider.createRecoveryPoint`. It verifies the existing PVC UID and ownership/generation before making a bounded recovery Job. The Job mounts the exact `/data` PVC read-only, reuses a uniquely matching tagged Restic snapshot or creates one, verifies snapshot host/path/tags, runs a full Restic data check, and reports the source volume/schema plus target release/image identity. The Provisioner removes only its temporary Job and credential Secret after a terminal result; it does not delete the PVC.
- `infrastructure/nixos/modules/backup.nix` retains the operator's off-host Restic timer for persistent data. Its repository and password file are deployment inputs outside the Nix store.

The new `pvc-backup` command keeps the legacy Restic identity/tag format and snapshot verification available for a recovery Pod that already has the exact old `/data` PVC mounted read-only. The CLI itself does not create a Kubernetes Job or establish that a supplied volume UID matches a live PVC. Run it only inside a recovery Pod whose source volume UID and ownership were checked by the existing Provisioner/Kubernetes recovery path, or by an equivalent explicitly authorized operator procedure. A local directory or a writable mount fails the CLI's mount check. This package does not claim a live Kubernetes recovery drill.

## Offline repository import plan

The plan command accepts an explicit sanitized Platform export, producer manifests, and an optional repository-ID-to-target-origin map. Input formats are `praetorium.legacy-platform-export.v1` and `praetorium.legacy-producer-manifest.v1`; the fixtures under `test/` show their shape.

```sh
pnpm --filter @praetorium/legacy-recovery recovery -- import-plan \
  --platform-export /protected/input/platform-export.json \
  --producer-manifests /protected/input/producer-manifests.json \
  --origin-map /protected/input/target-origins.json
```

Every repository is keyed by immutable GitHub repository ID. If several old instances refer to that ID, the report emits one target binding and retains the source instance/user, origin, release, audit-event, and producer-export references as provenance. An old instance with multiple repositories is split into one planned binding per repository. Conflicting owner/name locators, installations, target origins, missing producer manifests, or unresolved local state block that binding and are named in `conflicts`.

The plan records old-origin-to-new-origin mappings; if the target origin was not supplied it remains null and the report requires operator mapping. `browserStorageMigrated` is always false. Users are included only as source provenance; old ACLs and bearer tokens are never accepted into the target plan. The current GitHub user and App access must be reauthenticated after migration. A `pending` or `unknown` producer publication state retains the old application data and blocks that binding until the producer has published or exported the work. Running the command repeatedly on the same input produces the same plan ID and no writes.

## Platform metadata backup and restore

The archive uses scrypt with a random 16-byte salt to derive an AES-256-GCM key. Format, KDF parameters, salt, algorithm and nonce are authenticated as associated data; ciphertext changes fail authentication. `source.json`, the D1 export, migration checksum manifest, and platform config are held only inside the encrypted payload. The archive is written with mode `0600`; restored directories use `0700`, and files use `0600`. The key file must be readable only by its owner and contain a passphrase of at least 16 bytes.

For a prepared export directory, `source.json` has this shape:

```json
{
  "format": "praetorium.metadata-source.v1",
  "source": {
    "environment": "operator-selected-label",
    "databaseName": "operator-selected-name",
    "databaseId": "c89db32e-83f4-4e62-8cd7-7c8f97659029",
    "sourceRevision": "full-40-or-64-character-git-sha"
  }
}
```

The directory also contains non-empty `d1-export.sql`, `migration-checksums.json`, and `platform-config.json` files. Create an encrypted archive, authenticate it without writing files, and stage it into a new directory outside the checkout:

```sh
pnpm --filter @praetorium/legacy-recovery recovery -- metadata-backup \
  --input-dir /protected/input/export \
  --output /protected/output/platform.prmeta \
  --key-file /protected/keys/platform-recovery.key

pnpm --filter @praetorium/legacy-recovery recovery -- metadata-verify \
  --archive /protected/output/platform.prmeta \
  --key-file /protected/keys/platform-recovery.key

pnpm --filter @praetorium/legacy-recovery recovery -- metadata-restore \
  --archive /protected/output/platform.prmeta \
  --destination /protected/restore/platform-verified \
  --key-file /protected/keys/platform-recovery.key
```

`metadata-restore` refuses an existing destination and any path inside the current checkout. It authenticates and verifies all file checksums before creating the destination, then writes the SQL as an inert file and reports `sqlImported: false`. A restore drill must use a disposable D1 instance and a separately reviewed import procedure; this command never imports SQL.

For a remote D1 backup in one explicit operation, `d1-backup` requires `--remote`, calls Wrangler `d1 info` and `d1 export --remote`, encrypts the export/config/checksum set, then uploads the encrypted archive to the approved remote Restic repository. It retains the source `arcadia-platform-d1` and `recovery-point:<id>` tags alongside the Praetorium format tag. Wrangler receives no Restic credentials, Restic receives no Cloudflare credentials, and the receipt contains the D1 ID, source revision, archive checksum, snapshot ID, repository fingerprint, and a fingerprint of the parsed repository identity; it does not contain the raw repository URI or endpoint.

Set both `RESTIC_REPOSITORY` and `PRAETORIUM_OFFHOST_RESTIC_REPOSITORY` from the owner's protected recovery configuration to the same exact repository URI. This binds the effective Restic repository to the destination approved for that recovery environment. Do not derive the approval value from an untrusted command argument. The validator also rejects local filesystem paths and exposed loopback/local hosts before starting Restic. A matching URI is configuration evidence; the real backup acceptance run must still use and verify the owner's actual remote storage account and destination.

For S3-compatible storage, put the actual endpoint directly in the repository URI, for example `s3:https://backup.example.test:9000/bucket`. The validator binds and checks that parsed endpoint. The command rejects `RESTIC_REPOSITORY_FILE`, which would introduce a second Restic repository source.

```sh
pnpm --filter @praetorium/legacy-recovery recovery -- d1-backup \
  --remote \
  --database "$PRAETORIUM_D1_NAME" \
  --config "$PRAETORIUM_WRANGLER_CONFIG" \
  --migration-checksums "$PRAETORIUM_MIGRATION_CHECKSUMS" \
  --environment "$PRAETORIUM_RECOVERY_ENVIRONMENT" \
  --source-revision "$PRAETORIUM_SOURCE_REVISION" \
  --output /protected/output/platform.prmeta \
  --key-file /protected/keys/platform-recovery.key
```

Supply Wrangler and Restic credentials through the approved secret mechanism. The approved-destination variable above is required for D1 backup, legacy D1 staging, and PVC backup. Restic repositories must use a supported remote scheme and exactly match that approved identity; local paths, loopback/local endpoints, and URL-embedded credentials are rejected. Restoring a new-format archive from Restic first requires retrieving it with `restic restore <snapshot-id> --target <isolated-staging>`, then passing that archive to `metadata-verify` and `metadata-restore`.

Existing source-format `arcadia-platform.d1-recovery.v1` snapshots can be restored directly to a protected isolated staging directory. This checks their SQL byte count and SHA-256 plus the migration checksum SHA-256 before writing anything, and never runs Wrangler `execute`:

```sh
pnpm --filter @praetorium/legacy-recovery recovery -- legacy-d1-restore \
  --remote \
  --snapshot-id "$PRAETORIUM_RESTIC_SNAPSHOT_ID" \
  --destination /protected/restore/legacy-d1-verified
```

Restic decrypts the old snapshot with its separately recovered repository password. The staged SQL is plaintext after verification, so keep the destination on a protected operator host and import only into an isolated D1 environment through a separately reviewed procedure.

The application PVC remains opaque. `pvc-backup` runs within a controlled read-only `/data` mount, requires full source volume UID/schema/generation/release/image identity from the operator environment, and writes or reuses the old `arcadia-backup-v1` Restic tag. It validates exactly one source snapshot and runs `restic check --read-data-subset=100%` before printing a receipt:

```sh
pnpm --filter @praetorium/legacy-recovery recovery -- pvc-backup
```

Required variables are `RESTIC_REPOSITORY`, `PRAETORIUM_OFFHOST_RESTIC_REPOSITORY`, `RESTIC_PASSWORD_FILE` or `RESTIC_PASSWORD`, `PRAETORIUM_LEGACY_INSTANCE_ID`, `PRAETORIUM_LEGACY_VOLUME_UID`, `PRAETORIUM_LEGACY_SCHEMA_VERSION`, `PRAETORIUM_LEGACY_GENERATION`, `PRAETORIUM_LEGACY_RELEASE_ID`, and `PRAETORIUM_LEGACY_IMAGE_DIGEST`. The repository and secret values do not appear in receipts. The command does not restore into or delete any old PVC.

Restore operator keys separately: Platform signing keys, Gateway/session and credential encryption keys, GitHub App private key, Restic access, and the metadata archive passphrase. A successful archive checksum cannot recover a missing external key.

## Scope and evidence

This package supplies dry-run mapping and local cryptographic/file verification. It does not connect to a live legacy cluster, verify an operator's PVC UID through the Kubernetes API, execute a D1 import, migrate an instance binding, publish producer-local work, change browser state, cut over traffic, or retire any old storage. Those remain operator actions outside this campaign. See [the T13 task record](../migration/tasks/T13.md) for tested behavior and exact limits.
