# Legacy metadata recovery: owned local partial run

This is a bounded local execution check for the metadata archive and staging path. It does not certify T13 migration or disaster recovery.

## Reproduce

Prerequisites are Node 24, the repository's installed Wrangler CLI, and the official Restic 0.19.1 Linux/amd64 binary. The test requires `RESTIC_BIN`; without it Node reports the integration test as skipped. It makes a private temporary tree under the system temp directory and removes it after the test.

The run used Restic release [v0.19.1](https://github.com/restic/restic/releases/tag/v0.19.1). The downloaded `restic_0.19.1_linux_amd64.bz2` SHA-256 was `f415415624dcc452f2a02b8c33641791a8c6d6d3b65bbb3543fcf9a25151585c`, matching that release's `SHA256SUMS` entry. Stage the binary under a disposable directory; no system profile or global executable is changed:

```sh
restic_dir="$(mktemp -d /tmp/praetorium-t13-restic.XXXXXX)"
trap 'rm -rf "$restic_dir"' EXIT
curl --fail --location --silent --show-error \
  https://github.com/restic/restic/releases/download/v0.19.1/restic_0.19.1_linux_amd64.bz2 \
  --output "$restic_dir/restic_0.19.1_linux_amd64.bz2"
curl --fail --location --silent --show-error \
  https://github.com/restic/restic/releases/download/v0.19.1/SHA256SUMS \
  --output "$restic_dir/SHA256SUMS"
(
  cd "$restic_dir"
  grep 'restic_0.19.1_linux_amd64.bz2' SHA256SUMS | sha256sum --check -
)
bzip2 --decompress --keep "$restic_dir/restic_0.19.1_linux_amd64.bz2"
chmod 700 "$restic_dir/restic_0.19.1_linux_amd64"

RESTIC_BIN="$restic_dir/restic_0.19.1_linux_amd64" \
WRANGLER_BIN="$PWD/node_modules/.bin/wrangler" \
node --test tests/integration/legacy-metadata-restore.partial.test.mjs
```

The test explicitly runs Wrangler `d1 migrations apply`, `d1 execute`, and `d1 export` with `--local` against a config and state directory created under that temporary root. It applies all four checked-in Control Plane migrations, inserts one synthetic repository binding into this disposable database, and exports the resulting D1 SQL. No Cloudflare token is passed to Wrangler; its `HOME` points to an empty temporary directory and the test disables Wrangler metrics.

The test then invokes the actual `legacy-recovery` metadata backup, verify, and restore CLI processes. It initializes a real local Restic repository with a generated password file, snapshots only the encrypted archive, runs `restic check --read-data`, restores the snapshot, and verifies byte identity. The staged SQL remains inert in the recovery CLI. To verify that the export is recoverable, the test executes those staged bytes only in Node's in-memory SQLite database and checks the synthetic Platform binding and all four migration records. A modified ciphertext is rejected by the authenticated archive check before any restore destination is created. All local database state, credentials, archives, repositories, and restore outputs are deleted by the test teardown.

The only data row is synthetic test metadata; no producer state, legacy user export, source credential, production record, old PVC, or unpublished application data is used. The test does not call the `d1-backup` command because that command intentionally requires `--remote` and an off-host Restic backend; the test composes the existing local export, archive, and Restic CLIs directly.

## Result and limits

At the test commit, the one integration test passed with Restic 0.19.1 and the pinned workspace Wrangler 4.118.0. This proves a local D1 SQL export can be authenticated, stored in an encrypted local Restic repository, restored, staged with restrictive permissions, and independently opened in an isolated SQLite connection. It also proves the archive's authentication tag stops a tampered restore before staging.

This does not test a real Cloudflare D1 export, off-host Restic storage, legacy source snapshots or PVCs, Platform user/source-data imports, producer checkpoint resolution, key escrow, target binding creation, application data publication, cutover, or old-data retirement. It is not a production backup, disaster-recovery, migration, or T14 acceptance result. Those gates remain unverified.
