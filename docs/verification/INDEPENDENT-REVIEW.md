# Independent review record

Historical broad production evidence cut: `27142b0ab28e6c7323af3e2c11ed6121bf830574`, branch `main`. Reviewers were separate read-only agents. Subsequent production deltas have their separately scoped review records below. This records local review and unresolved acceptance gates, not complete-system certification.

The runtime reviewer traced the actual Node executor, Kubernetes adapter, renderer and runtime binding. Missing node-health tolerations allowed default 300-second eviction to erase a partitioned writer from the API census. `17b40ff` adds indefinite not-ready/unreachable NoExecute tolerations. Forced Pod deletion or node removal still needs independent process-termination evidence; API disappearance alone cannot prove process death. No force deletion was performed.

The security reviewer found that installation selection narrowing can have an empty removed-repository list. `ebf65f4` forwards the signed selection signal and invalidates that installation; `762e46a` rejects missing or invalid selection. Fourteen focused tests passed, including signed Gateway processing, invalidation, deduplication and missing-field rejection. Root's real Worker/D1/DO runner also exercises empty-list narrowing.

The runtime identity review found old authority surviving the start of retirement. `d029989` fences unresolved matching-epoch retirement checkpoints after terminal reports, lease expiry or a newer desired operation. Authority returns only after a later same-operation accepted checkpoint explicitly clears the quiesce request and receipt. `3936a26` persists that clear only after confirmed matching resume. The reviewer traced the clear sites and repeated resume tests.

The known-token retirement review covered the actual Gateway context, encrypted registry, CP routes/store, atomic checkpoint transition, private Gateway callback and GitHub revoker. A separate security review on `94bf6df` passed 44 tests without an actionable auth/crypto/deadline/redaction finding. That review was limited to its requested path; it did not certify the whole lifecycle.

A runtime review then found the zero-writer census branch skipped token retirement. `6bf79ec` atomically marks the proof's exact non-null old epoch pending; `12f0135` awaits the same barrier for `old-writer-absent`; `487ff55` withholds target authority while exact old-epoch credentials remain active or pending and unexpired. The reviewer rechecked actual recovery: a failed checkpoint response leaves the durable absent phase, the journal does not advance local state, and retry repeats census/checkpoint/barrier before target start. Focused CP 38, persistence 16 and Gateway 18 tests, and their typechecks, passed. The original reachable retirement defect is closed.

The identity issuer first reads the gated binding, then validates the target operation lease. Those reads do not constitute an atomic guarantee against future credential registration. A target identity JWT is not a GitHub bearer: the actual Gateway broker checks the live binding again and CP registration checks it before allowing token return. The reviewer found no current writer-capability bypass in that sequence. This does not claim instantaneous global revocation.

The partial actual-Worker credential probe also exposed inconsistent remaining-count semantics: the registry required the pre-revocation pending count to be zero. `094719b` uses the authoritative post-revocation empty list/count instead. Local unit fixtures now reflect the real CP count semantics. See [the narrow Worker evidence](RUNTIME-CREDENTIALS-PARTIAL.md) for its scope and injected local GitHub transport.

An independent cache review verified the actual D1 one-statement snapshot, current/desired/rollback pins, conflict quarantine, strict explicit policy, 32-candidate/8192-byte audit bounds and production scheduled invocation. Three focused cache tests and six deployment tests passed. No actionable cache finding remained. The reviewer did not execute the scheduled Worker probe; root ran it against an explicitly owned expiring local inventory and verified its advisory D1 audit. No registry deletion or storage reclamation is claimed.

Root reran required frozen install and full `check` at clean `27142b0`, including provider boundaries and generated schemas. The fixed T14 harness verified only Worker/D1/DO and returned exit 2 for six blocked categories. Gateway Chromium and actual Provisioner-process checks are partial, as described in [ACCEPTANCE.md](ACCEPTANCE.md).

The extended real Worker probe found that native workerd rejects `Request` redirect mode `error`; the CP retirement callback failed before fetching. `42e7246` uses supported `manual` mode in the CP barrier and Gateway broker/registry; `9df54f9` applies the same fix to all five GHCR/Sigstore request paths imported by the CP Worker. Each path rejects non-OK responses and does not follow Location. Independent reviewers found no defect in those deltas: CP/Gateway focused tests 27/27 and GHCR 37/37 passed, with relevant typechecks. These provider tests use injected fetch; a separate tiny native-runtime probe confirms mode compatibility but is not producer artifact acceptance. The official runtime behavior is documented in [Cloudflare Request redirect handling](https://developers.cloudflare.com/workers/runtime-apis/request/).

Root then reran the extended credential probe on clean `37f187c`, whose production sources are identical to `27142b0`. Actual Wrangler CP Worker and D1 routes persist the synthetic absent-writer checkpoint and return 503 when local GitHub responds 401; after a local 204 and durable acknowledgement, retry returns 200. A null retired epoch leaves the unrelated seeded token unchanged and skips the callback. This closes the observed native-runtime callback failure; it does not prove real Kubernetes writer census, GitHub App revocation, the full Gateway HTTP path or producer acceptance.

The final campaign audit also identified two outstanding target implementation gaps: the production Build Worker still defaults to `UnavailableCompositionArtifactInspector`, and automatic compatible rollback is disabled by `isRollbackCompatible():false`. Both remain explicitly incomplete, dependent on real S01/compatibility evidence before their missing implementations can be wired. The absent six T14 runners are a separate implementation gap. Safe refusal is not completion.

S01–S05 producer contracts/artifact, live App credential lifecycle, real BuildKit composition, Kubernetes isolation/termination, stable-origin browser entry, recovery and stable/pinned rollout remain unverified. Six fixed real-category runner files are also absent; delivering credentials alone is insufficient to finish T14. T15 is reviewed locally and remains partial pending those gates. No production infrastructure, secret rotation, package publication or legacy data deletion was performed.

## Kubernetes principal and local recovery delta

At worker `9778d93`, the security reviewer verified the actual tenant grant creation, strict existing-grant validation, deletion and remaining-resource census. Integrated `2bfc296` changes the old Arcadia principal to `praetorium-system/praetorium-provisioner` and uses the matching Praetorium tenant role and binding names. The reviewer found no production-path defect. Follow-up `120b007` also ties the regression directly to the named Provisioner Deployment namespace and `serviceAccountName`; the reviewer reran the 25 provider tests, while root's full Kubernetes package check passed all 29 tests. Static bootstrap RBAC and admission remain separate unfinished infrastructure work; this principal correction does not authorize a running cluster by itself.

A separate read-only recovery reviewer checked clean main `0cdf51e36d1c2fac894c3a9fc5fcf4b61347a48f`, confirmed the scoped files match worker `c3d8ddc`, independently verified the official Restic archive checksum and reran the actual local restore test: 1 pass, 0 failures, 0 skipped. The reviewer traced explicit local Wrangler configuration and isolated child environments, encrypted archive and real Restic operations, restrictive file modes, in-memory SQLite validation and authentication failure before staging modified ciphertext. No actionable defect was found. This is local synthetic Platform metadata evidence only, with no remote D1, off-host storage, source data, producer, cutover or retirement acceptance. See [LEGACY-METADATA-PARTIAL.md](LEGACY-METADATA-PARTIAL.md).

## Composed static infrastructure and route corrections

Separate read-only reviewers checked the minimal bootstrap/tenant RBAC graph,
namespace/RoleBinding/resource guards, Pod security and PSA, and exact network/route
policies during their isolated implementation. Root assembled these in the same
canonical Kustomize path used by render and apply.

At `ee33c38`, an independent reviewer traced the real CLI version checks and
apply order: discovery, strict full server dry-run, 14 guards only, current live
policy/binding readiness, then the full bootstrap bundle. Focused checks passed
22/22; no order bypass was found. Root then fixed a real API compatibility issue:
Kubernetes injects match-all selectors and `scope: "*"`. At `b3fbe6d` a separate
reviewer confirmed those neutral defaults are accepted while restrictive scopes,
nonempty selectors and changes to the Pod namespace selector remain rejected.
Their cached-tool infra run passed 53/53, distinct from root's 47/47 invocation.

The route reviewer found that all-namespace Traefik watch exposed a priority tie
between live tenant routes and the stopped fallback. The composed `b3fbe6d`
renderer, provider pre/post-write matcher, wired VAP and watch configuration now
agree on reserved 1000 > runtime 10 > fallback 1. The independent reviewer reran
infra8/8 and Kubernetes34/34 on this exact clean main and found the defect closed.
These are source/local-tool checks, not live Helm, API/defaulting or traffic proof.
See [the source-cut record](PLATFORM-SECURITY-DELTA.md). Full T15 remains partial.

## Kubernetes acceptance runner review

At exact clean worker `a52ee5ef11f441e43d8b540a16cc000f98be356d`, the separate
acceptance reviewer closed the metadata-positive-control, live health-target
ownership, pending cleanup and namespace-generation findings. Sol independently
found the namespace helper had interpolated a config object; the correction now
uses the exported production naming API and compares results to the actual
renderer. Health follows the real Deployment→ReplicaSet→Pod UID chain and exact
ServiceAccount. The owned metadata fixture requires unique exact marker and
image/object identity, with an early positive route test and same-node tenant
control. Controller RBAC is honestly resource/namespace scoped; generated names,
run labels and UID/resourceVersion checks constrain runner cleanup. Product
ServiceAccount privileges remain separate.

The reviewer reran frozen install, full check and 4/4 local tests. Sol integrated
only the runner/docs commits through `0fcf16a` and reran required install/check,
local 4/4, and the fixed owned Worker harness. Worker/D1/DO passed; six environment
gates remained BLOCKED/NOT_CHECKED. Unconfigured Kubernetes acceptance exits1
before transport construction. Neither reviewer nor Sol executed live Kubernetes
acceptance; implementation review does not close that gate.

Sol's subsequent upstream-source check found two real response-format mismatches
in the Kubernetes denial reader: default validation failures are 422/Invalid, and
`Status.message` wraps the VAP text with the resource/name. Main `8f6ef1a` includes
the ordered worker corrections through `33df138`; the independent reviewer
verified both against Kubernetes v1.35.5 dispatcher, admission.NewForbidden and
apimachinery constructors. The reader now binds resource/group/name, the exact
wrapped message, and the exact inner policy/binding/validation cause; generic 403,
binding-less and evaluation/configuration errors fail. Root's four focused tests
pass at this composed main. These fixtures follow the documented upstream error
construction; no actual API server response or enforcement is claimed.

## GitHub partial probe review

The separate reviewer checked clean worker `0ad7d3f3ce8327a7c84d3cdbfc00b69313a8d14f`
and closed the owner-input, expiry and uncertain-push findings. Descriptor reads
reject symlink/unsafe/mutable inputs and blocking FIFOs; the effective owner-file
expiry gates every new outbound operation while cleanup remains available.
Unknown pushes never gain deletion authority and retain sanitized repository/ref/
expected-commit recovery records even if a subsequent snapshot is absent. Only
completed Git fatal HTTP 403/404 responses count as expected permission denials;
401 and untrusted remote text stay uncertain. Fresh reviewer tests passed 6/6;
the live test skipped/BLOCKED without owner config, and no network was used.
Sol integrated the four isolated commits through `4f52afd`, reran the 6 local tests,
and confirmed that, at historical cut `4f52afd`, the fixed GitHub runner was absent. It has since been integrated; real acceptance remains blocked as described in the follow-up below. This is review of the
partial probe implementation, not real App/broker renewal or T14 certification.

## Delivery ledger and producer observation review

The separate read-only reviewer verified clean, pushed main
`a8fd6210c9fb69bc53e7a7d66051a0a9196ebf4b`. The delta from `7c5c4e7` is limited
to eight documentation files; production paths match `b3fbe6d`. The previous
coverage-cut finding is closed: `historicalEvidenceCut` preserves the former
cut verbatim, while the current cut names verification source `4f52afd` and
observed producer `eab0fad`. All 128 coverage entries and 65 source-handler
mappings remain present with their incomplete dispositions. The quiet-lint
proof gap is closed by the explicit command/HEAD/exit-code record at
`/tmp/praetorium-final-explicit-lint.json` (exit 0 at `ba0b3a7`). Mapping tests
passed 9/9 after reconciliation.

The reviewer checked the producer's remote ref, clean detached observer and
fc4..eab diff. New Core/Full local OCI and P12 evidence is accurately separated
from missing hosted contracts and null Platform artifactDigest. Docker build
context differences and the original whole-verify ENOSPC/stage-only retry remain
explicit. No Platform conformance or publication is inferred.

Sol reran required frozen install and full check at exact `a8fd621` (exit 0;
29/29 cached test-stage tasks; boundary/schema checks passed), with logs
`/tmp/praetorium-a8fd621-{install,check}.log`. Effect-free Worker preflight
returned exit 2 for missing canonical operator inputs, with templateProblems=[],
remoteCalls=false and secretValuesInspected=false. Infrastructure preflight,
using cached Kind/Kubectl/Kustomize, returned exit 2 with sideEffects=[] and
missing owned inputs. The acceptance plan remained BLOCKED, effectsExecuted=false,
with unresolved owner/resources. These are preflight records, not live acceptance.

The reviewer identified additional independent work: fixed GitHub access and
browser-entry harnesses can exercise current Platform contracts while keeping
producer/runtime-dependent acceptance blocked. Sol dispatched those two isolated
implementation areas. Their future commits require their own review and current
verification; this ledger review does not certify them or close T14/T15.

## Fixed GitHub and browser implementation review closure

The separate browser reviewer closed exact clean worker `ff7cea8` after checking
the real Gateway UI, Instance Access and current verifier. The reviewed fixes
match the actual redeploy 200 response, enforce owner lifetime on actions and
requests, avoid cookie-value diagnostics, compare actual module IDs, and bracket
an app GET with old digest/Ready/active-build observations. Sol integrated the
ordered browser commits through `164ae3b`; root focused lint, syntax and actual
fixed-environment missing-input classification passed. No live browser ran.

The separate GitHub reviewer closed exact clean worker `f33ba36` after the
ordered recovery corrections through `265ccf1` and `1b2be60`. All partial-probe
push sites now fsync PENDING recovery tuples before writes and recheck expiry
immediately before Git. Exact force-with-lease cleanup records CLEANED only
after readback observes absence. The journal survives fixed temporary HOME
cleanup; only bounded repository/ref/commit fields are retained. Actual producer
client renewal remains unavailable; partial or skipped tests cannot verify the
fixed category. The reviewer ran no live calls.

Sol integrated these GitHub corrections through `d23b9af`. Fresh root mandatory
frozen install and full check passed at that exact HEAD (29/29 cached test-stage
tasks plus boundaries/schema); partial tests passed 7 local/1 live SKIP-BLOCKED,
and fixed GitHub local guards passed 3/3 on the immediately preceding unchanged
fixed-runner source. No live App/CP/Gateway operations ran. Application/deployment
paths still match `b3fbe6d`; among apps/packages/plugins/infrastructure/scripts,
only the separately reviewed integration verifier differs. Subsequent owned
BuildKit/registry environment investigation is a separate T12 substrate scope,
not producer composition acceptance or final T15 certification.

## Integrated Pod resource CEL review

A separate read-only reviewer audited clean main `7bf2609` and the unchanged Pod policy from `137bc17`. Source YAML and both expression hashes match the owned API probe report (`9da37813…df7`). Review confirmed the binding-specific readiness canary preceded the matrix, API-defaulted requests were inspected, no Pods persisted, and exact candidate cleanup completed. The reviewer identified the init-case summary-classifier defect and two stale documentation claims; the evidence caveat and scoped documentation are corrected without rewriting the original report. This closes the scoped policy/evidence review, not canonical Kubernetes deployment or T14/T15 certification.

Root verification at exact `137bc17`: required frozen install and full check passed (29/29 cached test-stage tasks plus provider boundaries/schema); actual Kustomize infra tests passed 47/47 with no skips; integration-verifier tests passed 10/10. Focused Pod-test ESLint and changed-file formatting passed. An earlier infra invocation lacked Kustomize and reported 45 passed/2 skipped; it was superseded by the configured 47/47 run. Logs are `/tmp/praetorium-137bc17-{install,check,infra-render,verifier}.log`. These checks are local source proofs, not the full live category.

## Owned Build Worker init and constructor evidence review

The separate read-only reviewer checked exact main `a2fda845e31488799d7deb10ead4edb0a4f67815` against parent `0c65573`. The committed sanitized run-four API Pod recursively matches every requested field of the committed run-two request; all evidence-bundle SHA-256 entries verify. The reviewer found no inline Secret data or private-key material in the snapshot and no blocking findings. The snapshot intentionally omits unrelated status fields, including node/Pod addresses. Original submitted run-four byte identity remains unverified, and the disputed run-one request-hash field remains explicitly qualified without changing its original summary.

Sol independently observed the successful live Pod and constructor-only log before UID-precondition cleanup; this is actual init/constructor evidence with synthetic credentials, not a queue, BuildKit job, producer handshake, full infrastructure deployment or T14 pass. T07/T12 remain partial or blocked; T14/T15 remain blocked.

Required literal `corepack pnpm@11.18.0 install --frozen-lockfile` and `corepack pnpm@11.18.0 check` passed at exact `a2fda84` with the pinned toolchain PATH shim and TMPDIR. The test stage completed 29/29 cached tasks; provider boundaries and generated schemas passed. Logs are `/tmp/praetorium-a2fda84-{install,check}.log`. Application, package, provider and infrastructure sources have no diff from the image source `431dbe1`. The subsequent `4705422` change only labels the snapshot as sanitized. These checks do not certify producer acceptance or deployment readiness.
