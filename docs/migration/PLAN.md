# Praetorium Full Migration Implementation Plan

> **Historical T00–T15 implementation plan.** This is not the current product specification and does not establish that the present architecture is correct. Use [architecture/SYSTEM.md](../architecture/SYSTEM.md), [EXECUTION.md](../architecture/EXECUTION.md), [REVIEW.md](../architecture/REVIEW.md) and [the migration index](README.md). Only [Epic #1](https://github.com/yohn-jp/praetorium/issues/1) and current explicit owner instructions authorize product behavior. The owner now permits CI, superseding prior no-GitHub-Actions instructions.

For agentic workers: use the available plan-execution/subagent workflow for the fixed tasks below. Sol coordinates the complete campaign; implementation workers and independent read-only reviewers are separate. Do not impose a stop/reconfirmation after each task.

Goal: migrate Arcadia Platform into a deployable, repository-scoped Praetorium with GitHub App access, selected-module OCI composition and safe on-demand Scriptorium routing.
Architecture: [PLATFORM.md](../architecture/PLATFORM.md); shared producer contract: [SCRIPTORIUM-CONTRACT.md](../architecture/SCRIPTORIUM-CONTRACT.md).
Tech stack: existing TypeScript/Node 24, pnpm/Turbo/Vitest, Hono/Workers/D1/DO, Node workers, BuildKit, NixOS/K3s/Flux.
Authority: Epic #1 and current explicit owner instructions. Coverage: [COVERAGE.json](COVERAGE.json). Dispatch: [SOL-GOAL.md](SOL-GOAL.md).

## 1. Inspected truth, not inherited completion claims

Campaign update (2026-10-17): S01-S05 implementation is committed at Scriptorium `008d5c429ec279a424cafd5b8c4cbee70a613b8e`; consumer/lifecycle/recovery implementation is committed at Praetorium `a669f5c16faa85d5fcc162241b793eab734d46c2`. Actual final-source Runtime Base, Build Kit, Core, Story and MCP candidates were generated in the owned registry; all three compositions passed production unsigned artifact inspection and startup smoke. See [artifact evidence](../verification/HOSTED-ARTIFACTS-008d5c4.json) and [deployment runbook](../verification/HOSTED-INTEGRATION-RUNBOOK.md). Signed source admission and real GitHub/Hosted lifecycle/browser/canary/off-host recovery acceptance remain BLOCKED, so accepted `artifactDigest` stays null. Older observations below are historical.

| Repository | Pinned main | Observation |
| --- | --- | --- |
| `yohn-jp/praetorium` | `a062b67aa028894422f68ed54717109f583871f9` | Public, README-only initial tree; no existing Issues at inspection |
| `yohn-jp/arcadia-platform` | `b96a03a8734bfff2e5b965e6966007c45a2c7dc9` | PR #138 merged; usable-service candidate, not live-certified |
| `yohn-jp/scriptorium` | `5ee8f0f0f0b9ee63b4920f2a73f3d76baa2cef1a` | In-flight full migration; current producer contract gaps listed separately |

The source README/current-plan describes older observations, not all of current main. Actual `apps/provisioner/src/main.ts` now binds `createLoomRuntimeExecutor` and the Kubernetes provider; do not implement a replacement for the old `failClosedExecutor` merely because an old document mentions it.

PR #138 records source-local root checks passing at its earlier HEAD, but explicitly leaves scheduled discovery/canary/persisted rollout, authoritative capacity and real runtime/recovery gates incomplete. Its merge does not certify these. Current code inspection here did not rerun them. The current root manifest is Node >=24.21.0 <25 and pnpm 11.18.0, not the old README's Node 22 baseline.

Gateway `src/router.ts` declares 27 routes and Control Plane `src/app.ts` mounts eight route groups; both are mapped in the ledger. The source has eight package boundaries: auth, config, contracts, domain, loom-adapter, observability, persistence and runtime. Existing home UI is minimal SSR, not a completed configuration console. Source root `LICENSE` lookup returned 404; verify third-party attribution before imports.

Read-only inspection used the GitHub connector. Direct local `git ls-remote` failed DNS resolution in this planning environment. No product install/build/test, worker, registry push, Kubernetes apply or live authentication was run for this planning change.

Pinned evidence (all source paths use the source SHA above): `package.json`, `AGENTS.md`, `apps/provisioner/src/main.ts`, `apps/control-plane/src/app.ts`, `apps/control-plane/src/adapters/cloudflare.ts`, `apps/gateway/src/router.ts`, `apps/gateway/src/routes/home.ts`, `packages/auth/src/index.ts`, `packages/runtime/src/types.ts`, `packages/runtime/src/index.ts`, `docs/implementation/current-plan.md`, and PR #138. Producer evidence: `Dockerfile`, `scripts/profile-build.mjs`, `packages/api/src/server.ts` at the producer SHA.

## 2. Global constraints and review focus

- Praetorium main commit/push is authorized for the dispatched Sol campaign. Sol is the only integration writer; workers use isolated paths/worktrees. No mandatory leaf PRs, force-push, history rewrite or unowned working-tree changes.
- Arcadia Platform/Loom remain read-only. Scriptorium S01–S05 implementation is part of this campaign and shares the canonical contract in `SCRIPTORIUM-CONTRACT.md`; no further producer-ownership handoff is pending.
- No CI/GitHub Actions or organization-template synchronization/addition/execution. Product build orchestration is in scope. No Inari.
- Local/test environments must be explicitly owned and disposable. Production application of Cloudflare/D1/DNS/K3s/NixOS, public artifact release, credential rotation and legacy deletion is not authorized.
- Never copy private infrastructure values/operational secrets or user work. Preserve source provenance and behavior without copying source Git ancestry.
- Test acceptance contracts, not hypothetical features. Record failed/not-run/blocked honestly. Independent review never shares the implementer's success claims as proof.

Review focus: (1) two users entering the same repository and stale authorization; (2) duplicated/stale build and runtime reports; (3) instance replacement with uncertain old writer or unpublished work; (4) incomplete producer/browser/module image closure; (5) stopped-origin requests, secret leakage and build/runtime isolation. Each has concrete tests below.

## 3. Frozen task graph and shared ownership

| Task | Deliverable | Dependencies |
| --- | --- | --- |
| T00 | Public baseline, source mapping and working local verification | none |
| T01 | Neutral contracts and producer preflight | T00 |
| T02 | GitHub App identity/authorization/credential broker | T01 |
| T03 | Repository registry, D1 operations and coordination | T01 |
| T04 | Scriptorium metadata/composition/runtime adapter | T01 |
| T05 | GHCR artifact catalog, verification and build cache | T01 |
| T06 | Isolated BuildKit worker and build lifecycle | T03,T04,T05 |
| T07 | Kubernetes runtime provider and capacity | T01 |
| T08 | Gateway/Instance Access, signed entry and wake | T02,T03,T04 |
| T09 | Provisioner idle/drain/redeploy/recovery | T03,T04,T07,T08 |
| T10 | Repository/image/add-on management UI | T02,T03,T04,T05 |
| T11 | Stable/pinned update, canary and persisted rollout | T06,T09,T10 |
| T12 | Sanitized deployable infrastructure/test environment | T01 |
| T13 | Legacy import and Platform metadata recovery | T03 |
| T14 | Integrated real-runtime acceptance | T06,T07,T08,T09,T10,T11,T12,T13 |
| T15 | Independent final review, corrections and certification | T14 |

Dispatch every ready non-overlapping task; no artificial batch of three. Cross-repository source work proceeds in the coordinated campaign; acceptance runs against exact final committed source and artifact cuts, never sibling uncommitted code. Shared root manifests/lockfile, contract schemas, D1 migration ordering and top-level wiring are Sol-owned. Workers submit bounded changes to those files for serialized integration rather than independently replacing them.

Private helper naming may change, but the following neutral ports and producer wire schemas are frozen at T01. Consumers run a seam preflight against exact exports/versions before deep implementation.

```text
AccessProvider.authorize(user, repositoryId, action) -> AccessDecision
GitCredentialBroker.issue(runtimeIdentity, operation, authorizationReceipt?) -> ScopedCredential
InstanceService.resolveOrCreate(repositoryId, actor, idempotencyKey) -> LogicalInstance
ConfigurationService.plan(instanceId, expectedGeneration, selection) -> DeploymentPlan
BuildProvider.execute(verifiedBuildRequest, signal, beforeEffect) -> BuildResult
RegistryProvider.resolve/verify/readAdmission(artifactRef) -> VerifiedArtifact
ApplicationAdapter.resolveBuild/resolveRuntime/parseObservation -> bounded contracts
RuntimeProvider.inspect/ensureRunning/ensureStopped/ensureRelease/
  ensureRuntimeDeleted/listManagedInstances/getCapacitySnapshot -> neutral observations
LifecycleService.request/claim/report -> generation/lease-fenced Operation
```

Reuse source RuntimeProvider semantics where they still fit. Retained-data deletion/recovery moves to an explicit legacy capability; normal ephemeral runtime does not gain authority to delete old PVCs. No new universal provider meta-framework.

## 4. Task packets

### T00 — Public, runnable baseline

Own: root package/workspace/lock/tool configuration, README/LICENSE/SECURITY/CONTRIBUTING/AGENTS, ignore rules, baseline checks and `docs/migration/BASELINE.json`. Source: root tooling, boundary/schema checks and the package roots in §1.

- [ ] Import only the source scaffolding/direct dependencies needed by the named packages; rename package namespace consistently to `@praetorium/*`. Preserve relevant tests, not old agent restrictions that conflict with this campaign.
- [ ] Establish Node 24 and source pnpm/Turbo/Vitest baseline. Keep producer build tooling self-contained. Remove references to excluded Actions jobs from new verification, not real behavioral assertions.
- [ ] Run frozen install and root check once; fix proven shared baseline failures centrally. Record historical versus freshly executed evidence.
- [ ] Complete public-source/provenance review and coverage seed; commit/push the runnable foundation. Root LICENSE/metadata absence does not authorize copying third-party assets without their notices.

Proof: `pnpm install --frozen-lockfile`; `pnpm check`; changed-file format check; repository secret/provenance scan with bounded approved inputs. No source/runtime completion is claimed by this baseline.

### T01 — Shared contracts and producer preflight

Own: `packages/contracts/src/{access,repository,build,artifact,lifecycle,provider,producer}.ts`, generated schemas, `packages/domain`, `docs/migration/PRODUCER-STATUS.json` and fixed interface fixtures. Source: existing contracts/domain/runtime neutral types and auth wire shapes.

- [ ] Record the exact source cut and classify S01–S05 from their current source paths separately from artifact and product acceptance. The campaign implementation exposes the existing canonical versioned producer contracts; fixtures stay labeled fixtures.
- [ ] Define D1 identities/generations, build input canonicalization, provider ports, permissions, runtime epoch and stopping dispositions. Reject unknown fields/versions that could alter execution.
- [ ] Tests: normalized module order shares a build key; differing artifact/recipe/platform changes key; tenant data rejected; wrong host/repository/epoch grant rejected; invalid module graph/resource profile rejected.
- [ ] Verify schema drift and direct consumers compile. Sol owns shared contract changes and root manifests; producer implementations are in the same campaign. Do not add a parallel ABI, static-token fallback or arbitrary-build path.

### T02 — GitHub App access and broker

Own: `plugins/github`, provider-neutral `packages/auth` changes, Gateway identity adapters/routes, credential broker service; excludes portal configuration UI. Source: `packages/auth/src/{oauth,session,credential,keys,handoff,refresh}`, Gateway context/DO/session/OAuth handlers.

- [ ] Reuse App user-authorization OAuth flow, sessions, refresh/key rotation, PKCE/CSRF and logout/MCP credentials; do not create a second OAuth App or independent ACL.
- [ ] Implement user/App repository intersection, role mapping, transfer/install revalidation, webhook verification/dedup and bounded access expiry.
- [ ] Implement repository/epoch-scoped installation-token renewal. Publish issuance requires a fresh actor authorization. Keep App, registry and runtime credentials separate.
- [ ] Tests: App access without user access, read versus write, revoked authorization, stale installation, wrong repository/epoch, expiry/renewal, replayed webhook and secret redaction. Exercise real owned GitHub App/test-repository flow at T14; unit fixtures alone are not certification.

### T03 — Repository identity and durable operation state

Own: `packages/application/src/{instances,configurations,operations}`, D1 repository adapters and Sol-serialized migrations; source Control Plane instance/user/operation/provisioner routes, repositories and UserCoordinator.

- [ ] Replace user-owned lookup with unique RepositoryBinding and repo-scoped coordination. Preserve actor audit without using old owner ACL as authority.
- [ ] Implement atomic resolve-or-create, expected-generation configuration changes, desired/observed separation, runtime epochs, admission/reservation state and idempotent claims/reports.
- [ ] Tests: two users/requests resolve one instance; duplicate desired updates; stale completion after retry; transfer/reinstall fence; D1 migration upgrade and rollback-plan behavior. DO storage must not become a competing desired-state database.
- [ ] Run real local D1 migrations/DO contention tests; commit consumer-ready services.

### T04 — Scriptorium adapter

Own: `plugins/scriptorium` and adapter fixtures/tests. Source: `packages/loom-adapter` and known producer manifests/probes, not Scriptorium application source imports.

- [ ] Normalize declared build catalog/module/resource rules and runtime/probe/auth requirements. Consume S01–S05 through versioned formats.
- [ ] Replace Loom-specific port/image/data/auth assumptions with exact producer metadata. Distinguish immutable image identity from echoed configuration.
- [ ] Tests: unsupported producer version, incompatible/unknown module, wrong closure/digest, missing auth/quiesce evidence and distinct 3000-versus-old-3847 profiles. Labeled fixtures cover consumer unit cases; exact-image Core and two non-preset source compositions require real conformance at T14.
- [ ] Producer and consumer source now implement the versioned hosted interfaces; retain labeled fixtures for unit coverage, and keep real-image acceptance blocked until exact-image conformance is run.

### T05 — Registry, artifact admission and cache

Own: `plugins/ghcr`, `packages/application/src/{artifacts,build-cache}`, Control Plane registry/release adapters; source GHCR/Sigstore clients and release/channel repositories.

- [ ] Implement immutable base/build-kit/catalog discovery, content/digest verification, trusted builder/signer admission and same-key artifact lookup. Retain source provenance/signature protections with non-Actions producer identities.
- [ ] Add monotonic artifact admission; cached content must still exist and meet policy. Use supported dedicated GHCR push credentials rather than App installation tokens.
- [ ] Tests: mutable tag changes, manifest/child mismatch, bad signer, missing cached blob, conflicting same-key results and cross-repository cache reuse without author data. GC respects running/desired/rollback references.
- [ ] Prove push/pull/admission against an owned disposable OCI registry; actual GHCR proof requires its explicitly configured test credentials.

### T06 — Build Service and worker

Own: `apps/build-worker`, `plugins/buildkit`, `packages/application/src/builds`, build request/status/cancel routes; source worker claim/report patterns and sanitized build-host tooling.

- [ ] Claim coalesced immutable BuildInput, run the trusted producer recipe in isolated BuildKit, capture bounded progress and verify result before registering an artifact.
- [ ] Build worker has no runtime kube credential or work-repository token. Implement cancellation, resource/disk/time bounds, cleanup and attempt fencing.
- [ ] Tests: concurrent equal configs create one admitted result; worker crash/retry/late report; changed module makes distinct input; canceled obsolete selection does not deploy; build secret absent from layers/cache/logs; Core/backend/browser closure verified.
- [ ] The composition artifact inspector, runtime package closure and declared smoke path are implemented in the current source cut. Real BuildKit plus registry round-trip and actual image dependency inspection are still required before admission. Build current app replacement before draining the old runtime.

### T07 — Kubernetes runtime and capacity

Own: `plugins/kubernetes`; source `packages/runtime/src/{kubernetes,labels,naming,errors,types}`. Sol mediates neutral interface changes.

- [ ] Extract Kubernetes JSON/client/render/observation into the provider. Retain deterministic ownership labels, before-effect fences and instance/cluster validation.
- [ ] Use bounded disk-backed ephemeral workspace for new Scriptorium, single writer, non-root/read-only rootfs, explicit service identity and no workload administration token. Retained legacy PVCs are untouched.
- [ ] Implement authoritative resource capacity/reservations using fresh node/workload observations; unknown capacity refuses admission rather than staying an unexplained permanent zero or assuming infinity.
- [ ] Tests: wrong ownership, duplicate generation, late API completion, unknown old writer, stale capacity, size/quota constraints, cross-instance and metadata/management egress denial. Verify actual container image identity, not env values. Real cluster isolation/observation is a T14 gate.

### T08 — Authenticated entry, stable-origin handoff and wake

Own: Gateway entry/repository/open routes and `apps/instance-access`; source Gateway router/handoff and Instance Access service.

- [ ] Resolve repository binding through authorized services; start/wait existing or absent instance without allocating per-user duplicates.
- [ ] Implement one-use POST handoff, host-only grants, refresh/logout and stable fallback routing. Direct bookmarks on stopped origins must reach the wake path.
- [ ] Tests: wrong origin/repository/user/epoch, code replay, CSRF, duplicate wake, unauthorized guessed hostname, direct bookmark when stopped, expired grant and MCP request during startup. Never replay the caller's POST or route application bodies through Workers.
- [ ] Verify actual Worker/DO/service binding and browser cookie behavior together with the Scriptorium grant verifier; source implementation alone does not pass the hosted browser gate.

### T09 — Lifecycle, idle and safe replacement

Own: `apps/provisioner` and `packages/application/src/lifecycle`; source real runtime-executor/worker/control-plane-client/health/metrics and update recovery paths.

- [ ] Reuse the real executor; bind the new providers and repository epoch. Implement activity observation, 15-minute configurable idle decision, quiesce, restart/redeploy/update and resume-on-abort.
- [ ] Old instance stays running while a new build is pending. Pending checkpoints/uncertain publication block retirement. No automatic push or force reset. Preserve stable identity/origin.
- [ ] Tests: in-flight checkpoint/job, unknown quiesce, stale resume, lease expiry without writer termination, crash after each irreversible step, failed new readiness and compatibility-evidence-backed rollback. The compatibility checker and lifecycle fences are implemented in the current source cut; rerun affected verification before treating rollback as accepted. Same-digest redeploy must create a new epoch.
- [ ] Observe writer absence and actual target artifact/auth/module/repository readiness before marking success; record blockers instead of weakening evidence.

### T10 — Complete management UI

Own: `apps/gateway/src/ui`, configuration/build/release/operation route presentation and browser tests. Source minimal `routes/home.ts`, existing instance/release/operation APIs.

- [ ] Provide repository list, App installation/access status, enter/wait/retry, current/desired image and modules, selected-versus-required dependencies, resource limits, build progress, stable/pinned and redeploy controls.
- [ ] Use the canonical configuration/authorization service; no raw Dockerfile, command, image registry free-for-all, privileged flag or arbitrary environment editor.
- [ ] Tests in a real browser: read-only controls denied server-side, selection preview, unsupported combination, existing cache reuse, build failure retaining current app, same-image redeploy and stopped direct-origin entry. Poll/backoff follows meaningful state; no permanent spinner hiding errors.
- [ ] UI fixtures are not a completed deployed service; integrate real T06/T09 before T14 acceptance.

### T11 — Release follow and safe rollout

Own: Control Plane scheduled entry points and `packages/application/src/{releases,rollouts}`; source release/channel CAS, GHCR verification and unfinished scheduler/canary paths.

- [ ] Finish bounded scheduled discovery (five-minute initial interval), durable cursor/dedup and verified base promotion. Compose every affected stable follower's existing add-on set before rollout.
- [ ] Run a disposable canary and bounded health window (source initial policy: ten minutes), then persist one-at-a-time runtime rollout per cluster. Pinned and stopped intent remain unchanged.
- [ ] Tests: scheduler restarts, out-of-order promotions, missing module in new base, failed canary/build, pinned preservation, newer desired config during old rollout and same-key reuse. Never mark candidate/latest as promoted merely because the registry contains it.
- [ ] Prove two actual compatible producer artifacts at T14; fixtures certify only the state machine.

### T12 — Infrastructure and deployment inputs

Own: `infrastructure`, Dockerfiles, Nix/Flux/inventory/preflight scripts, local integration launcher and operational configuration; source corresponding infrastructure and declared D1/Worker wiring.

- [ ] Provide static Gateway/Control Plane bindings, secret references, D1 migration application, ingress/TLS, access/provisioner, BuildKit/build-worker and metrics setup. No Actions runner/workflows.
- [ ] Keep build host separate from runtime privileges. Static Flux ownership excludes dynamic instance resources. Ensure stopped-instance fallback remains reachable.
- [ ] Externalize all host/account/domain/device identifiers; reject placeholders in an actual apply target. Preserve private management access without publishing old values or changing real network policy.
- [ ] Validate Nix/Kustomize/schema/policy and a disposable local environment. Produce `plan`, `preflight` and explicit operator `apply` procedures; never apply to an inferred home/production context.

### T13 — Legacy migration and Platform recovery

Own: `plugins/legacy-recovery`, offline import commands and metadata backup/restore tests/docs; source Restic recovery, D1 export/staging, persisted user/instance/release/audit schemas.

- [ ] Build offline dry-run import mapping from explicit exported Platform and producer manifests. Split per-user multi-repository instances; deduplicate repository bindings with an explicit conflict report. Reauthenticate rather than import stale ACL grants.
- [ ] Preserve source IDs/origin mappings and provenance in reports. Keep application backup opaque; unpublished Git/application state must be published/exported by the producer before old PVC retirement.
- [ ] Preserve encrypted Platform metadata/configuration backup and isolated restore verification. Legacy recovery is absent from normal application/provider startup closure.
- [ ] Tests: duplicate repo in multiple exports, unresolved local checkpoints, wrong installation, old browser-origin boundary, untouched old PVC, repeat import, tampered restore and recoverable D1 state. No live data deletion/cutover.

### T14 — Real integrated acceptance

Own: `tests/integration`, `tests/e2e`, `scripts/verify-integration.mjs`, `docs/verification/ACCEPTANCE.{md,json}` and task evidence consolidation. Product fixes return to the owning task and are re-integrated, not hidden in a test-only patch.

- [ ] Run production Worker bundles with local D1/DO, actual BuildKit/OCI registry, disposable Kubernetes/ingress and a real Scriptorium composition; record SHAs/digests/configuration.
- [ ] Prove GitHub App user authorization, two users to one repository instance, deny unrelated user/read-only mutations, scoped token renewal and real test-repository Git operations. Do not provision accounts or production App credentials implicitly.
- [ ] Prove two distinct module configurations, identical-config cache hit, UI selection/redeploy, failed-build preservation, Core exclusion, direct-origin wake, active jobs/pending checkpoints blocking stop, clean quiesce and re-clone at stable origin.
- [ ] Prove stable/pinned behavior, stale workers/reports, isolation/capacity, metadata restore and operator failure/recovery paths. Measure actual build/cache-hit/start/redeploy latency and resource use; no invented performance targets/results.
- [ ] Reconcile every ledger row with target paths/proofs; all required rows must be verified. S01–S05 source implementation is present, while image, hosted-flow, external App/signature, canary, full product and actual T13 off-host gates remain individually BLOCKED until evidenced; finish unaffected tasks but do not certify the full system.

### T15 — Independent review and delivery

Own: read-only final review plus Sol-coordinated corrections, `docs/verification/FINAL.md`, updated product/security/deployment docs and final ledger.

- [ ] A reviewer not responsible for implementation traces authority, actual code, tests and observed environments. Findings require reachable failure, violated contract, cause and minimal correction.
- [ ] Fix accepted defects in the owning task, rerun affected focused tests and complete root/integration verification at final HEAD/artifact. Do not spend this phase inventing new requirements.
- [ ] Commit/push all scoped work to main with a clean, identified final state. Never leave finished worker work uncommitted because another external gate is blocked.
- [ ] Report implementation, local certification, deployment-ready and live-deployed separately. Stop after the fixed campaign is verified or with preserved work and exact external blockers; no recursively growing backlog.

## 5. Verification entry points and environment truth

T00 establishes the root commands `pnpm install --frozen-lockfile` and `pnpm check` from source semantics, adapted only to the new supported package layout. Each leaf runs its package `typecheck`, `test` and `build` scripts as defined in its manifest. T12/T14 add real integration entry points; do not describe them as already existing.

T14's `node scripts/verify-integration.mjs --environment <explicit-owned-test-inventory>` verifies context ownership before executing. Required integration categories are workers-d1-do, github-access, buildkit-registry, kubernetes-isolation, browser-entry, producer-recovery and stable-rollout. Missing required categories yield a non-success result and structured BLOCKED/NOT_CHECKED entries, not a green run with everything skipped. `--plan` must render intended external effects without executing them.

Local test inventory, a test GitHub App/authorized users/repository, registry credentials, producer artifacts and container/cluster capability are real inputs. Do not fabricate them or use production by default. Static Nix/schema checks are not live runtime proof. No CI synchronization is needed to complete this campaign.
