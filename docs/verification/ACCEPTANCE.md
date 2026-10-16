# T14 integrated acceptance record

Status: **BLOCKED** at Praetorium main `d029989dbc6b78024bd401ed37e07e63336c1f6c` (2026-10-17). The report is an evidence cut, not integrated-system certification.

The fixed acceptance command returned exit 2 with an aggregate BLOCKED report and no runner errors. Its explicitly owned, expiring local inventory made only `workers-d1-do` available. That fixed runner passed against the actual Control Plane Worker entry; the remaining six categories were declared missing and stayed BLOCKED / NOT_CHECKED. The checked-in `infrastructure/test/acceptance-inventory.json` remains an unprovisioned draft.

## Required categories

| Category | Status | Proof status | Evidence or blocker |
| --- | --- | --- | --- |
| `workers-d1-do` | VERIFIED | VERIFIED | The fixed runner bundled `apps/control-plane/src/worker.ts` with the actual Wrangler dry-run bundler, applied all three checked-in D1 migrations to owned ephemeral Miniflare D1, and exercised the production `RepositoryCoordinator` Durable Object with SQLite-backed persistence. |
| `github-access` | BLOCKED | NOT_CHECKED | No owned test GitHub App, authorized users, test repository, or scoped credentials. |
| `buildkit-registry` | BLOCKED | NOT_CHECKED | No current producer composition or product artifact admission. Fresh rootless launcher attempt stopped at `newuidmap: Operation not permitted` before pulling an image; old generic substrate evidence is historical only. |
| `kubernetes-isolation` | BLOCKED | NOT_CHECKED | No disposable cluster was created. A prior kind image extraction failed with ENOSPC before cluster creation; that attempt was not repeated at this evidence cut. |
| `browser-entry` | BLOCKED | NOT_CHECKED | A local Gateway source-execution browser probe passed as partial evidence only. There is no stable owned origin, actual Instance Access path, successful GitHub App login, or producer artifact. |
| `producer-recovery` | BLOCKED | NOT_CHECKED | Scriptorium S01-S05 remain BLOCKED at producer revision `4c163a3c8162b5d7bc4becb63f00a04617cab5dc`; artifact digest is null. |
| `stable-rollout` | BLOCKED | NOT_CHECKED | No real producer artifact, disposable cluster, integrated canary, or stable/pinned rollout evidence. |

## Verified Worker scope

The fresh runner report is at `/tmp/praetorium-campaign-d029989-acceptance.json`, generated at 2026-10-16T23:52:21.516Z. It used inventory `praetorium-t14-miniflare-d029989`, owned by `sophia uid=1000`, disposable and non-production, with expiry 2026-10-17T00:52:16.149799Z. The fixed runner removed its temporary D1/DO persistence root in `finally`; the run did not declare any persistent cloud resource.

The runner read production compatibility settings from `apps/control-plane/wrangler.toml`, produced a dry-run bundle from the real Worker entry, and applied migrations `0001_repository_platform.sql`, `0002_stable_release_rollouts.sql`, and `0003_staged_configurations.sql` to temporary D1. It verified table creation, authenticated health and JWKS behavior, private route authorization, concurrent first repository resolution, stable binding identity, desired-state idempotency, public dashboard/release/operation projections, and omission of `leaseToken`, `checkpoint`, and `workerId`. It also checked the no-admitted-image claim gate, Worker restart persistence across the same temporary D1/DO storage, and local webhook metadata deduplication/conflict handling. The release-constructor check used local generated keys and a malformed manifest; no producer manifest or artifact was introduced.

These are actual Worker runtime tests with test-owned local values. They do not constitute GitHub App acceptance, a real signed GitHub delivery, producer build/admission, Kubernetes, or release rollout evidence. The runner report does not publish a per-test duration.

## Partial source execution

The actual Gateway browser probe passed 1 test with 0 failures on source commit `f82227a9b35702e33a28bc25f62911f86a351767`. The committed Gateway and Instance Access trees at the current evidence cut are byte-identical to those in that source cut. Chromium 156.0.8078.4 and Miniflare 4.20260730.0 exercised Host-header redirect handling, query-secret removal from redirects and logs, OAuth callback and nonce-cookie construction, locally seeded session resolution through actual Gateway DO/KV bindings, duplicate-cookie rejection, unauthenticated session behavior, and public-only JWKS. The measured test duration was 6.094 seconds; the process duration was 6.819 seconds. Full scope and limitations are recorded in [T14 partial Gateway source execution](../migration/tasks/T14-gateway-partial.md).

A separate actual Node Provisioner executable probe passed 1 test with 0 failures at the current d029989 source cut (477.618 ms process duration). Against a local Control Plane test server returning 503, liveness was 200, readiness was 503, no claim request was made, the service credential was absent from logs, and SIGTERM exited cleanly. This is an ancillary executable capability-gate check, not a Kubernetes or producer integration result.

The required frozen install and `pnpm check` both passed at d029989. The check completed 29/29 Turbo tasks in 8.006 seconds; package boundaries and contract schemas passed. Within that run, the 10 runtime-binding and 7 runtime-identity route tests passed. Those focused tests cover retirement fencing and fresh identity issuance; they do not establish immediate or global revocation of previously issued stateless bearer tokens. The installation-token validator permits returned expiries up to 3605 seconds, so an already-issued token may remain valid until expiry or explicit provider revocation.

## Remaining evidence and non-claims

The current fresh disposable-environment launcher attempt is recorded in [LOCAL-ENVIRONMENT.json](LOCAL-ENVIRONMENT.json). It stopped during rootless Podman setup because the host denied `newuidmap`, before registry pull, BuildKit startup, inventory creation, or digest production. Its temporary root was cleaned and no live processes remain. Earlier generic scratch BuildKit and OCI round-trips are retained there as historical substrate results; they were not rerun or re-fetched at this evidence cut and are not Scriptorium artifacts or product admission proof.

A prior kind node-image extraction attempt ended with ENOSPC before cluster creation. It is historical only; the current category inventory still marks Kubernetes unavailable. The source handler inventory maps 65 handler surfaces across 28 Arcadia files at immutable source revision `b96a03a8734bfff2e5b965e6966007c45a2c7dc9`; this is source reconciliation, not runtime proof.

No production credentials, external GitHub service, production cluster, stable product origin, producer build, release publication, or recovery operation was used. T14 remains blocked until the missing owned resources and producer contracts/artifact evidence are supplied and the relevant fixed product runners pass.
