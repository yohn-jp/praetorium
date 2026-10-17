# Platform migration delivery checkpoint

The full migration is **not complete**. Implementation, local verification, deployment readiness and production deployment have different states. This checkpoint preserves integrated work and identifies the remaining acceptance and implementation gates; it does not close Epic #1.

| State                         | Result                                                                                                                                                                                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production implementation     | Repository identity/auth/build/lifecycle/UI/provider paths are integrated. Producer-dependent transports fail closed. Build closure inspection/smoke and compatible rollback checks remain unimplemented; T14 has six missing real-category runners. |
| Local verification            | Required frozen install and full check pass at production cut `27142b0ab28e6c7323af3e2c11ed6121bf830574`. Actual Worker/D1/DO category passes; narrower browser/process/credential evidence has explicit limits.                                     |
| Integrated product acceptance | BLOCKED: no complete login → producer composition → running instance → reconnect/reconfigure/redeploy proof.                                                                                                                                         |
| Deployment ready              | No. Required operator inputs, immutable service images, owned disposable acceptance and producer contracts/artifact remain missing.                                                                                                                  |
| Production deployed           | No production Cloudflare, D1, DNS, K3s or NixOS application occurred.                                                                                                                                                                                |

Authority remains [Epic #1](https://github.com/yohn-jp/praetorium/issues/1), [PLATFORM.md](../architecture/PLATFORM.md), [PLAN.md](../migration/PLAN.md), and [the task/coverage ledger](../migration/COVERAGE.json). Planning PR #2 is merged at `f81f13c`; no unmerged planning change was found. Arcadia source remains pinned to `b96a03a8734bfff2e5b965e6966007c45a2c7dc9` and was read-only. Scriptorium was also read-only; its current preflight is `1950ba5b729e5c1611124abe78722c70362c08b2`. S01–S05 remain BLOCKED and current-main artifact digest is null. The producer's local candidate `sha256:7a2e4fd5d00b36f90a19cfe90b30c6c0c5e01df4f922650696be813abd006b07` belongs to isolated source `e85c173a`, not the current producer main or a published/admitted Platform artifact.

## Task and coverage evidence

[task-status.json](../migration/task-status.json) records T00–T15 individually; [COVERAGE.json](../migration/COVERAGE.json) preserves source capability dispositions and target/proof paths. T00 local foundation and T03 owned local Worker/D1/DO semantics have passed their stated local scope. T01/T04 and the producer-dependent parts of T02/T05–T12 remain blocked. T06 still defaults to `UnavailableCompositionArtifactInspector`; its concrete digest-backed image-closure inspector/smoke runner must be implemented and wired after S01 supplies the recipe/receipt ABI. T09 intentionally returns false for rollback compatibility; a real compatibility check is still required after the producer evidence is defined. Neither gap is resolved merely by supplying an environment. T13's offline tooling is implemented and locally tested, but no real source export/backup/restore was provided. T14 is partial; T15 has independent local review and corrected findings, with full certification blocked by the real gates.

The current Worker test covers all four migrations, persistent repository DO coordination, one instance across concurrent resolution, service-role separation, webhook invalidation, public-field redaction, audit pagination and scheduled advisory cache-retention auditing. Equal-build-key/cache/admission/lifecycle/rollout state machines have local tests; they do not prove actual producer image closure, cache reuse or rollout.

[ACCEPTANCE.json](ACCEPTANCE.json) embeds the fixed category results and measurements. [INDEPENDENT-REVIEW.md](INDEPENDENT-REVIEW.md) records findings, fixes and reviewer scope. Previously issued tokens are now tracked encrypted and retired on both quiescing and already-absent-writer paths. Physical writer termination remains independently required. Local simulated GitHub revocation is not real App acceptance.

## Measurements

| Check                                                        | Observed result                                | Scope                                                                                     |
| ------------------------------------------------------------ | ---------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Same-cut actual Worker test                                  | 1/1 pass, 3201.90 ms test / 3469.93 ms process | Local Wrangler/workerd/D1/DO, explicit owned temporary inventory                          |
| Full workspace test stage                                    | 29/29 Turbo tasks, 5.056 s with cache          | Local source verification; not product latency                                            |
| Actual Gateway Chromium probe                                | 1/1 pass, 2865.99 ms                           | Local cookie/session/redirect security only                                               |
| Actual Provisioner process                                   | 1/1 pass, 390.17 ms                            | Health 200/readiness 503, zero claims without producer capability                         |
| Actual credential checkpoint probe                           | 1/1 pass, 3417.45 ms test / 3736.85 ms process | Actual local Worker/D1, synthetic absence and local GitHub/Gateway transport at `37f187c` |
| Real composition build/cache-hit/start/redeploy/resource use | NOT_CHECKED                                    | Requires real producer artifacts and owned execution environment                          |

Historical generic BuildKit/OCI substrate results are retained in [LOCAL-ENVIRONMENT.json](LOCAL-ENVIRONMENT.json). The fresh launcher failed at host user-namespace setup before a build; no historical scratch digest is represented as producer acceptance.

## Preflight and remaining unblock conditions

Follow [deployment instructions](../deployment/README.md). From a clean checkout:

```sh
corepack pnpm@11.18.0 install --frozen-lockfile
corepack pnpm@11.18.0 check
node scripts/deploy-workers.mjs plan --inventory infrastructure/test/disposable-inventory.json
node scripts/deploy-workers.mjs preflight --inventory infrastructure/test/disposable-inventory.json
node scripts/deploy-infrastructure.mjs plan --inventory infrastructure/test/disposable-inventory.json
node scripts/deploy-infrastructure.mjs preflight --inventory infrastructure/test/disposable-inventory.json
node scripts/verify-integration.mjs --environment /absolute/path/to/owned-test-inventory.json
```

The checked-in inventory intentionally leaves owner-specific origins, App locators, trust keys, cache bounds and immutable images unset. Plan/preflight must remain non-success while required inputs are missing. The Worker preflight recognizes migrations 0001–0004 and both private service bindings, reports no template problem, makes no remote calls and inspects no secret value. It does not inspect applied remote D1 state.

The minimum remaining work is:

1. Existing Scriptorium coordinator delivers the versioned S01 build catalog/recipe and immutable closure evidence, S02 hosted grants, S03 assignment/renewable repository-scoped credentials, S04 status/quiesce/resume and S05 conformance artifacts. Handoff details are in [SCRIPTORIUM-CONTRACT.md](../architecture/SCRIPTORIUM-CONTRACT.md); there is no compatibility token or fabricated artifact fallback.
2. An owner supplies an explicit disposable App/users/repository, registry credentials and supported BuildKit host, Kubernetes namespace/cluster and stable test origin. The current host denies rootless `newuidmap`; prior cluster image extraction exhausted disk. Production resources must not be substituted.
3. Implement/wire the Build Worker closure inspector and smoke runner, and evidence-based rollback compatibility after the producer ABI is supplied. Implement and run the six fixed real-category runners against those actual contracts/resources, including two producer configurations and releases, cache hit, Git operations, browser wake/handoff/UI, safe replacement/recovery, isolation/capacity and stable/pinned behavior. They are presently absent, not successful fixture tests.
4. Provide explicit source metadata/producer exports and an isolated target to verify legacy backup/restore without touching old PVCs or unpublished work; complete independent acceptance review after these real gates.

No source history was rewritten, existing producer ownership changed, App key rotated, public package/release published, legacy PVC/data deleted, or GitHub Actions/template/Inari workflow executed. Final delivery HEAD is the enclosing main commit and must be checked with `git rev-parse HEAD` / `git ls-remote origin refs/heads/main`; the production test cut above remains explicit.
