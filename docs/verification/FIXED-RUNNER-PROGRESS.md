# Fixed runner implementation checkpoint

> Historical report from before the Hosted Integration Completion campaign. Its missing-source and read-only statements describe that earlier cut. Current implementation and acceptance state are tracked in [the migration ledger](../migration/task-status.json), [producer status](../migration/PRODUCER-STATUS.json), and [the Hosted runbook](HOSTED-INTEGRATION-RUNBOOK.md). This report is not current campaign certification.

Source cut `164ae3b` adds the fixed GitHub and browser-entry harnesses to the
previous Worker and Kubernetes runners. Three fixed files remain absent:
BuildKit/registry, producer recovery and stable rollout. Their real semantics
remain bound to the missing producer ABI/artifacts. No fixed live category was
certified by creating a file or running its local guards.

The browser implementation review closed at worker `ff7cea8` after correcting
actual UI response status, owner expiry, cookie diagnostics, module identity and
active-build observation. At this cut, GitHub implementation review was still open for the
reused partial probe's pre-write durable recovery and verified deletion readback.
The direct broker path already records a pending recovery tuple before push;
those records remain outside temporary HOME and contain no credentials. Both
harnesses use the strict reason-code outcome protocol reviewed at `d1f5d37`.

Fresh root verification at exact `164ae3b`:

| Check                                  | Result                                                              | Scope                                           |
| -------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------- |
| Required frozen install and full check | PASS;29/29 cached test tasks,boundaries/schema                      | Local workspace only                            |
| Infra and mapping                      | 57 passed,no failures/skips                                         | Local canonical render and mappings             |
| Kubernetes local guards                | 4 passed                                                            | No live API server                              |
| GitHub fixed local guards              | 3 passed                                                            | Ownership/schema/recovery files only            |
| GitHub partial                         | 6 passed,1 live SKIP/BLOCKED                                        | No live App/resources                           |
| New fixed runner environment contract  | Both exit1 and map BLOCKED/OWNER_INPUT_MISSING                      | Actual verifier env+sidecar, missing input only |
| Fixed harness                          | Local Worker/D1/DO VERIFIED;six BLOCKED/NOT_CHECKED;exit2;errors=[] | Actual local Wrangler/Miniflare/D1/DO only      |
| Focused ESLint and syntax              | PASS                                                                | Verifier and implemented probes                 |

Logs are `/tmp/praetorium-164ae3b-{install,check,infra-mapping,kube-local,github-fixed-local,github-partial-local,lint}.log`,
`/tmp/praetorium-164ae3b-fixed-blocked.json` and
`/tmp/praetorium-164ae3b-acceptance.{json,stderr}`. The local inventory was owned
by sophia uid1000, disposable/nonproduction, with expiry
`2026-10-17T03:02:33.951729+00:00`; report generation was
`2026-10-17T02:42:36.759Z`. Its runner created and removed its own temporary
persistence. This records a completed scoped run, not continuing environment
availability after expiry.

Application/deployment sources match `b3fbe6d`; among apps/packages/plugins/
infrastructure/scripts, only `scripts/verify-integration.mjs` changed. Producer
observation remains `eab0fad`, frozen application tree fc4, and Platform
artifactDigest remains null; [component digests and limits](PRODUCER-eab0fad.md)
are unchanged. Direct Platform token-broker expiry assertions cannot replace
actual producer client renewal; the fixed GitHub harness stays BLOCKED for that
missing S03 step. T06 closure/smoke implementation, T09 compatible rollback and
all real acceptance requirements remain unresolved. No production apply occurred.

## Reviewed recovery follow-up

The GitHub findings are closed at worker `f33ba36`, integrated through main
`d23b9af`. The partial child now persists/syncs its own PENDING journal before
every push, rechecks owner expiry after that write, and verifies deletion absence
before marking CLEANED. Direct instrumentation in the actual child preserves
real Git; no interposer or alternate transport was introduced. Root reran the
partial suite: 7 local passed, 1 live skipped/BLOCKED; fixed local guards remained
3/3. Required frozen install and full check passed at exact `d23b9af`.
Independent review closure is recorded in [INDEPENDENT-REVIEW.md](INDEPENDENT-REVIEW.md).
The older table above remains the `164ae3b` observation; live gates did not pass.

Further T12 work corrected the generic launcher and reached a real owned Kind
API. [ENVIRONMENT-RECHECK.md](ENVIRONMENT-RECHECK.md) records the scoped generic
OCI proof. Real API validation found canonical NetworkPolicy/Pod CEL type errors;
those corrections and their enforcement proof are a separate in-progress unit,
not proof that these four fixed category implementations all ran successfully.
