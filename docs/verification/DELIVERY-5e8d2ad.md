# Bounded delivery verification at 5e8d2ad

Sol verified clean `main` and remote `main` at
`5e8d2ada441ba11482d2cabc635f2aa4e59f63ac` on 2026-10-17.
This records component evidence, not full T14 acceptance or deployment readiness.

## Fresh fixed Worker category

A newly declared, owner-only inventory authorized a fresh local Miniflare process,
temporary D1 and SQLite Durable Object storage. The expired 164ae3b inventory was
not reused. The current fixed verifier and runner executed against 5e8d2ad:

```sh
TMPDIR=/dev/shm PATH=/tmp/praetorium-bin:$PATH node scripts/verify-integration.mjs \
  --environment /tmp/praetorium-t14-workers-5e8d2ad-fresh.json
```

Report `/tmp/praetorium-5e8d2ad-acceptance.json`, generated
`2026-10-17T04:01:57.584Z`: Worker/D1/DO VERIFIED; six other categories
BLOCKED / NOT_CHECKED; aggregate exit 2; `errors=[]`. Stderr was empty.
The inventory declares those six full-category resources missing; the separate
Kind API and service-image component probes do not satisfy those categories.
The runner owns and removes its temporary persistence in its cleanup path.
No remote Cloudflare application or real producer was exercised.

## Independent image-content readback

Sol independently fetched all three service-image manifests by digest, their
configuration blobs and every layer from the owned anonymous loopback registry
`127.0.0.1:38841`. All descriptor sizes and SHA-256 hashes matched. Each image
is linux/amd64 with image user `node`. The Kubernetes deployment requires runtime
UID/GID 10001; runtime acceptance is separate from this content readback.

| Registry repository                   | Manifest SHA-256                                                   | Layers |
| ------------------------------------- | ------------------------------------------------------------------ | ------ |
| `praetorium/platform-provisioner`     | `00739c31e414da9494015e859b8ef1b0f2289ceef631274a1f953ef70c3e2e64` | 7      |
| `praetorium/platform-instance-access` | `daf3f8ff4a04d34e1894790cecd7bc330c7d771d90c9e641b1edc7e0c990de72` | 7      |
| `praetorium/platform-build-worker`    | `32d276e664d149a6452bf8ddfb09419972f33dc0f120e742609d77b75c58c09f` | 9      |

Image build source is clean `431dbe1c7c86251894efea3de2cf0ec94499ca10`.
`git diff 431dbe1..5e8d2ad -- apps packages plugins infrastructure scripts`
is empty. These are Platform service images, not admitted Scriptorium compositions.

The Build Worker OCI export for the owned Kind handoff has archive SHA-256
`aeeaaa5bdb99e7d1d96a7aec597b07ccacf25fdf935cc5d947570f399814135d`
and manifest digest
`sha256:8c682438aa40641e7765360bf1ac871c679d8f29dc2c958cafa9d4c15f2496fb`.
Conversion repacked layers and reordered configuration JSON, so this digest is
distinct from the registry image. Sol verified the archive hash, all nine layer
blob hashes and manifest/config blob hashes, and equality of the complete parsed
configuration with the registry configuration, including rootfs diff IDs.
This readback does not independently recompute uncompressed layer diff IDs.

Public metadata report: `/tmp/praetorium-root-431dbe1-image-verification.json`.
At this evidence cut, the real Pod private-copy/init/constructor check and the
launcher cleanup correction remain in progress. Content readback alone does not
prove runtime startup, Build Service composition, registry authentication or CNI.

## Required checks and outstanding acceptance

Required frozen install and full check passed at 79100a0; all 29 test-stage tasks
passed (26 cached), plus boundary/schema checks. The infra/verifier run passed
57 tests without skips. Changes from that check cut through 5e8d2ad are confined
to migration ledgers and the owned Kubernetes evidence document. Logs:
`/tmp/praetorium-79100a0-{install,check,infra-verifier}.log`.

Current producer observation remains 3f7b174 with verified published Core/Full
presets; accepted Platform `artifactDigest` remains null. Hosted S01–S04 and S05
composition/assignment/conformance gaps, target closure/smoke inspection and
compatible rollback implementation, and full owned integration inputs remain
open. See [producer status](../migration/PRODUCER-STATUS.json) and
[fixed-runner progress](FIXED-RUNNER-PROGRESS.md).
No production infrastructure, keys, releases/packages or legacy data changed.
