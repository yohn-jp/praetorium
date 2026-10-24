# Runtime authority: recovery and migration verification

This is local verification evidence for [PR #67](https://github.com/yohn-jp/praetorium/pull/67), not production acceptance or deployment authorization. The reviewed revision was `d83bedff853a7970b95c26da437419487a84abdb`, based on `f03e239`. The PR records the final tested revision and GitHub Actions result.

## Checkpoint, revocation and publication boundaries

The transaction that saves a retirement checkpoint also withdraws the current grant and marks known credentials pending. The following revocation and grant publication are separate operations. Safety therefore depends on remaining fenced across failures and accepting an exact checkpoint replay under the same live lease.

[`runtime-authority-recovery.test.ts`](../../apps/control-plane/src/runtime-authority-recovery.test.ts) uses actual SQLite-backed D1 stores, `OperationService`, provisioner HTTP routes, the retirement barrier, credential routes/store and the conditional publication SQL. Only the external GitHub revocation service and failure points are controlled test doubles.

| Injected boundary / interleaving | Required result asserted |
| --- | --- |
| Gateway fails after checkpoint commit | Exactly one checkpoint; old credential pending; no current grant |
| A stale registration arrives after the retirement batch snapshot | Registration is pending; partial batch returns 202; no grant until a later batch drains it |
| Publication SQL is unavailable after checkpoint and retirement succeed | Grant stays absent; the same checkpoint can finish publication on retry |
| Publication commits but its response is lost | Replay returns success without another checkpoint or reactivating revoked credentials |
| Operation lease expires during final retirement | Conditional publication is rejected; grant remains absent even though old tokens were revoked |
| Old-runtime registration arrives after target publication | Row is pending and cannot be reused; only the exact target tuple registers active |
| Confirmed observed resume publishes but its response is lost | Exact `accepted` replay succeeds; no additional checkpoint or token reactivation |

The last scenario reproduced a recovery defect on the reviewed revision: the first `accepted` request committed its checkpoint and observed grant, then the injected response loss returned 500; the exact retry returned 409. Retirement phases already supported replay, but `accepted` did not. The fix adds only `accepted` to that same replay path, retaining live worker/lease, sequence, phase and identical payload checks. It does not broaden admission to arbitrary checkpoints.

[`runtime-credential-registry.test.ts`](../../apps/gateway/test/runtime-credential-registry.test.ts) additionally delays successful registration and reuse responses across a completed retirement. The earlier response may still return its old bearer, but the revocation stub has already invalidated that bearer before replacement can be admitted. These tests exercise response timing separately from SQL status transitions.

The linearization points are explicit: registration chooses active/pending within its INSERT statement; retirement withdraws authority and marks rows within one batch transaction; publication checks the operation fence and outstanding old credentials within one conditional UPDATE. Responses cannot reactivate a row or manufacture another grant.

## Migration outcomes

[`migrations.test.mjs`](../../tests/deployment/migrations.test.mjs) applies the real `0009_runtime_authority.sql` to pre-migration fixtures. It checks these outcomes and preserves the original checkpoint rows:

| Pre-migration state | Authority after migration |
| --- | --- |
| Observed ready writer without retirement | Its observed reservation |
| Confirmed observed resume after quiesce | Its observed reservation |
| Quiesce without confirmed resume | None |
| Old writer with an absence checkpoint | None |
| Live in-flight target with matching durable absence proof | Target reservation and operation lease |
| Target with an outstanding retired-epoch credential | None |
| Target with expired operation lease | None, with no fallback to the retired writer |
| Target whose latest proof differs from its absence checkpoint | None |

The migration is a one-time evidence check, not an authentication-time reconstruction. Malformed historical absence evidence can conservatively deny bootstrap; outstanding revocation, expired leases and inconsistent evidence require lifecycle recovery rather than granting a writer speculatively. No production migration or rollback was executed.

## Evidence scope

The integrated local check covers build, lint, typecheck, tests, package boundaries and schema drift. Production Control Plane code also passes the owned local Workerd/D1/DO fixture, including checkpoint publication, target identity, wrong/expired leases, registration, reuse, wrong scope and late registration after fencing. The PR records actual commands and results.

[D1 workload findings](../../tests/benchmarks/runtime-authority-d1.findings.md) and [raw measurements](../../tests/benchmarks/runtime-authority-d1.local-evidence.json) compare identical synthetic inputs and identify exact source hashes. They do not establish production 24-hour savings.

**NOT_CHECKED:** hosted producer/Kubernetes lifecycle, real GitHub bearer revocation, registry/browser acceptance in an owned hosted environment, and production migration availability/performance. Read-only production D1 SQL returned API error 7500. Local SQLite/Workerd tests and successful CI cannot certify those external gates or prove every possible distributed failure.
