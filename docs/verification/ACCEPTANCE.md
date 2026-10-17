# T14 integrated acceptance record

Status: **BLOCKED** at production source cut `27142b0ab28e6c7323af3e2c11ed6121bf830574` (2026-10-17). This is a partial acceptance record. It does not certify the full Platform or deployment readiness.

The fixed command `node scripts/verify-integration.mjs --environment /tmp/praetorium-t14-workers-inventory.json` returned exit 2, errors `[]`, at `2026-10-17T00:30:29.367Z`. Its explicitly owned local inventory supports only `workers-d1-do`. The owner is `sophia uid=1000`; expiry is `2026-10-17T00:52:16.149799Z`. The temporary D1/DO resources are removed in the runner's `finally` block. The checked-in acceptance inventory remains an unprovisioned draft; it was not used as ownership proof.

| Category             | Status / proof        | Evidence or blocker                                                                                                                                                                      |
| -------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| workers-d1-do        | VERIFIED / VERIFIED   | Actual Wrangler-bundled Control Plane Worker, four migrations, ephemeral Miniflare D1 and persistent SQLite RepositoryCoordinator DO.                                                    |
| github-access        | BLOCKED / NOT_CHECKED | No owned App, authorized test users, repository or live scoped credential lifecycle.                                                                                                     |
| buildkit-registry    | BLOCKED / NOT_CHECKED | No current producer composition/artifact; fresh disposable launcher failed at `newuidmap: Operation not permitted` before image pull. Historical scratch results are not producer proof. |
| kubernetes-isolation | BLOCKED / NOT_CHECKED | No owned disposable cluster. Earlier node-image extraction failed with ENOSPC before cluster creation.                                                                                   |
| browser-entry        | BLOCKED / NOT_CHECKED | Local Gateway Chromium probe is partial; no successful App login, stable origin, actual Instance Access/producer flow.                                                                   |
| producer-recovery    | BLOCKED / NOT_CHECKED | S01–S05 hosted contracts and immutable producer artifact remain unavailable; artifact digest is null.                                                                                    |
| stable-rollout       | BLOCKED / NOT_CHECKED | No two compatible producer artifacts, real canary/health window or stable/pinned rollout evidence.                                                                                       |

At the historical cut above, six blocked categories lacked their fixed executable runners. At `0fcf16a`, the Kubernetes runner is implemented/reviewed but lacks its owned environment; five other fixed runners remain absent. Supplying resources alone does not complete them: the real runners must be implemented against the delivered producer ABI and owned environment, then executed. The harness reports these categories as blocked before attempting execution. No missing runner is counted as passing or skipped proof.

The Worker run verifies concurrent repository resolution to one instance, durable restart/idempotency, public-operation redaction, service authorization, public-only runtime JWKS, webhook invalidation/deduplication/conflict handling, and actual audit pagination. It constructs the actual release admission services with local keys and rejects a malformed manifest; it does not fabricate an admitted producer release. It also invokes the real scheduled entry with explicit cache-retention policy, confirms a durable advisory audit event, and keeps missing T11 release bindings visibly unavailable. No cache row or OCI manifest is deleted.

A separate same-cut Worker run passed 1/1 in 3201.90 ms (3469.93 ms process duration). Required frozen pnpm 11.18.0 install and full `check` passed at that clean source cut, including all 29 test-stage Turbo tasks, provider boundaries and generated schemas. The test stage took 5.056 seconds with cached tasks; this is not a product latency measurement.

The Gateway partial browser test passed 1/1 at `42e7246` in 2865.99 ms; its Gateway sources are unchanged through the evidence cut. It uses the actual local Worker/DO/KV with Chromium to exercise redirect/query redaction, secure nonce/session cookies, duplicate-cookie rejection and unauthenticated API/public JWKS behavior. It intentionally fails closed at Control Plane and does not exercise the full entry path. The actual compiled Provisioner process test passed in 390.17 ms: health 200, readiness 503, zero claims while producer capabilities are unavailable, and graceful SIGTERM.

Known-token retirement is now implemented: encrypted D1 registry, scoped installation-token revoker, atomic pending transitions for quiescing and already-absent writers, checkpoint revocation barrier, and suppression of target identity while matching unexpired active/pending credentials remain. Focused tests are local unit/SQLite evidence. [The partial credential Worker probe](RUNTIME-CREDENTIALS-PARTIAL.md) additionally exercises actual Worker/D1 routes with a local HTTP transport. The fresh extended probe passed at `37f187c`: actual CP checkpoint/D1 returns 503 while a synthetic old-epoch token is pending, then 200 after local 204/revocation acknowledgement; null epoch skips the callback. It does not prove real writer census, live GitHub App revocation or producer integration.

Deployment plan/preflight recognizes migrations 0001–0004 and both private Worker service bindings; template problems are empty. Preflight returns exit 2 for unresolved operator inputs, with `remoteCalls=false` and no secret values inspected. Six infrastructure deployment tests pass. Follow [deployment instructions](../deployment/README.md); no production apply has occurred.

[ACCEPTANCE.json](ACCEPTANCE.json) preserves the machine-readable category report, current measurements, runner implementation limits and explicitly labeled historical evidence. [LOCAL-ENVIRONMENT.json](LOCAL-ENVIRONMENT.json) records substrate attempts and limits. No actual composition build/cache-hit/start/redeploy performance or resource measurement is available.

The Build Worker closure inspector/smoke runner and evidence-based compatible rollback checker also remain unimplemented. They need the producer ABI/evidence and Platform implementation/wiring; external resource availability alone does not finish them. See [FINAL.md](FINAL.md).

## Composed infrastructure checkpoint

At clean main source `b3fbe6d`, root reran required frozen install/check, all local
infra tests (47/47), actual owned local Worker/D1/DO (VERIFIED), and actual local
D1/Restic restore with synthetic metadata (1/1). The fixed aggregate returned
exit 2 with six categories BLOCKED/NOT_CHECKED and errors `[]`. This newer local
cut supplements the historical broader report above. No actual cluster admission,
Traefik/CNI enforcement or producer conformance was run. Exact logs, measurements,
independent review and limitations: [PLATFORM-SECURITY-DELTA.md](PLATFORM-SECURITY-DELTA.md).
Producer audit at that checkpoint: [539375c](PRODUCER-539375c.md), accepted artifactDigest null.

## Kubernetes runner implementation

Main `0fcf16a` integrates the real provider-backed Kubernetes category runner and
strict separate controller/provider credentials, exact owned metadata canary,
health Deployment/ReplicaSet/Pod ownership chain, packet controls and conditional
cleanup. Independent review found no remaining blocking defects; root local tests
passed 4/4 and required frozen install/check passed. Full-file invocation with no
inventory exits1 before transport construction. This is NOT_CHECKED acceptance,
not a cluster pass. The fresh fixed harness at this cut VERIFIED only actual local
Worker/D1/DO, returning exit 2 with six blocked categories and errors `[]`.
See [the required owned inputs](KUBERNETES-ISOLATION.md).


## Fixed runner outcome protocol

At verifier checkpoint `d1f5d37`, each fixed runner receives a fresh
`PRAETORIUM_T14_RESULT_PATH` inside its isolated temporary home. Missing owner or
producer prerequisites can be distinguished from failed assertions by writing
one strict JSON object and exiting nonzero:

```json
{"reportVersion":1,"category":"github-access","status":"BLOCKED","reasonCode":"OWNER_INPUT_MISSING"}
```

Only `reportVersion`, the exact fixed `category`, `status` and `reasonCode` are
accepted. Public reasons come from a closed code table, never exception text,
secret values, owner paths or URLs. The BLOCKED codes are `OWNER_INPUT_MISSING`,
`OWNED_ENVIRONMENT_UNAVAILABLE`, `PRODUCER_CONTRACT_MISSING`,
`RUNTIME_UNAVAILABLE`, `BROWSER_UNAVAILABLE` and `INSUFFICIENT_LIFETIME`.
`ACCEPTANCE_ASSERTION_FAILED` is valid only with status FAILED. Unknown fields,
codes, category/status mismatches, malformed or unsafe files, process signals,
and a non-success report paired with exit zero fail acceptance. No sidecar can
promote a nonzero exit to VERIFIED. The file is bounded, opened without following
symlinks or blocking on FIFOs, and must be a current-user regular file without
group/other write permission. The result is removed with the isolated home.

Runners without sidecars retain the existing exit-status contract. Each full
runner must assert every required live path before exit zero; local guard tests,
fixtures, skips and partial probes cannot certify a fixed category. The new
protocol itself is harness behavior, not proof of any live category.
