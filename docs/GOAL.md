# Praetorium — Immutable Hosted Completion Goal

**Status:** ACTIVE — completion not yet demonstrated  
**Established:** 2026-10-18  
**Repository:** [yohn-jp/praetorium](https://github.com/yohn-jp/praetorium)  
**Starting baseline:** `5011ee22328c494603bbbbdcda79fcb6614c3ac4` (refresh `main` on execution)  
**Product authority:** [Original Epic #1](https://github.com/yohn-jp/praetorium/issues/1), superseded only by explicit later owner decisions (including CI permission).  
**Producer:** [yohn-jp/scriptorium](https://github.com/yohn-jp/scriptorium), through its existing coordinator and versioned interface.

> **Immutable objective — one outcome:** Complete Praetorium as an operational, publicly reachable Scriptorium Hosted service. A GitHub-authorized user must be able to select a repository, obtain its single persistent logical instance, enter Scriptorium at a stable HTTPS origin (including wake from stopped state), write and persist work to GitHub, then safely stop, resume, change its approved composition, update, and recover without routine manual operator intervention. Fulfill **all** original Epic #1 acceptance criteria with real integrated evidence. No source code, build/CI pass, local smoke, documentation, dashboard screenshot, host availability, or partial milestone substitutes for the operational outcome.

## 1. Goal invariants (do not move)

- **Scope is fixed:** Original Epic #1's requirements, the immutable objective above, and explicit owner safety/cost instructions. No generic PaaS, billing, HA, new authoring/NLP features, third-party plugin marketplace, or unrelated refactor.
- **Completion cannot be redefined:** The coordinator and subagents may change implementation tactics, file ownership, estimates, or ordering, **never acceptance criteria**. Only the owner can explicitly amend this goal.
- **Progress is cumulative:** Integrate verified work continuously. One defect blocks only its dependent delivery path or unsafe deployment, not other independent implementation streams.
- **Safety is not optional:** Preserve GitHub authorization, one repository → one logical instance, no overlapping Git writer, epoch/CAS and lease fencing, immutable artifact admission, quiesce, pending-unpublished-work protection, token separation, and rollback/recovery evidence.
- **Economics is a product constraint:** Home Runtime/Build VMs may remain on; **Cloudflare billable work must not scale with empty per-second/per-minute polling or recurring full acceptance probes.** Measure Worker requests/CPU, D1 reads/writes, Durable Object usage, scheduled invocations, and idle behavior at representative load. No unbounded paid-service loops.
- **No misleading completion:** An unexecuted or BLOCKED acceptance case stays unexecuted or BLOCKED. Final status remains GOAL UNMET until the entire gate below passes.

## 2. Definition of Done — one release cut, all gates

All checks must use pinned Praetorium commit, pinned Scriptorium source/recipe, exact OCI artifact digests, and an identified authorized deployment environment. Store commands, timestamps, outcomes, and sanitized evidence. A new feature or additional test cannot replace a missing gate.

| Gate | Required real outcome and evidence |
| --- | --- |
| **G1 — GitHub access and tenancy** | At least two authorized GitHub users resolving the same repository land on one logical instance; read/write/admin separation, revoked/changed installation or user permission, and unauthorized access are enforced. Runtime Git credentials are repository-scoped and do not leak. |
| **G2 — Public Hosted entry** | Publicly trusted HTTPS for Gateway and stable instance origin; browser login, repo selection, new/existing resolution, stopped direct-bookmark wake, one-use handoff, cookie refresh/logout, live UI/API/MCP, bounded API/MCP retry without replaying writes. Regular manuscript traffic does not traverse Cloudflare Workers. |
| **G3 — Author work durability** | Real Scriptorium edit → authenticated GitHub commit/push → reload/reconnect retains confirmed content; long-lived active session survives short-lived credential expiry/renewal. Pending/unpublished data and browser recovery are not silently discarded. |
| **G4 — Composition and Build** | At least two operator-approved module selections produce real OCI compositions; same immutable input reuses an admitted cache artifact and different inputs produce distinct correct results. Only the service-controlled, revision-pinned Producer/Recipe/Catalog and their declared module dependencies may execute: no user Dockerfile, arbitrary package, URL, command, or build argument. The trusted Builder enforces the approved selection during composition. Praetorium binds the resulting OCI manifest/platform digest, compact Composition Manifest and configured builder signature to the persisted Build Input, without re-exporting or re-hashing rootfs contents or repeating Producer's package/closure/startup checks. Actual K3s Runtime Readiness/Canary validates deployment. Preserve secret isolation; failed/stale builds never replace a serving runtime. |
| **G5 — Lifecycle and single writer** | Configurable 15-minute meaningful idle deadline, safe quiesce and stop, wake/resume, redeploy including same-digest new epoch, existing/new writer census, and absence evidence. Active work, pending checkpoints, uncertain publication or stale evidence forbids unsafe retirement. |
| **G6 — Release and recovery** | Stable and pinned policies, verified canary promotion, compatible rollouts, failure preservation, retries across worker/VM restarts, lease expiry, stale reports, actual Kubernetes resource drift, network interruption. No silent pinned change, unintended wake, or overlapping writer. |
| **G7 — Authorization and infrastructure isolation** | Actual Kubernetes Pod/admission/network/capacity checks, BuildKit isolation and rootless mTLS, GitHub App/broker secret separation, permission revalidation, configuration/metadata backup and recovery (and preservation of legacy unpublished work). |
| **G8 — Cost and trigger correctness** | Remove empty-work periodic 1s Build claim, 2s Operation claim, idle full D1 scan, recurring full Hosted probe and needless unchanged GC audit from the normal path. Persist meaningful deadlines; separate notification from claim authority, lease renewal, and outage recovery. Record idle/active/failed-notification Cloudflare counts and bound fallback reconciliation. VM-local K8s health monitoring does not trigger paid Control Plane polling. |
| **G9 — Operational release** | CI and full source checks green; seven real Hosted acceptance categories verified (Workers/D1/DO, GitHub access, BuildKit/registry, Kubernetes isolation, browser entry, producer recovery, stable rollout); one integrated review of release candidate; approved deployment and actual public user journey accepted, with rollback and operations documentation. |

**Production authority gate:** Creating this goal does **not** authorize new production changes, public image publishing, key rotation, domain/certificate changes or deletion of data by itself. Work independently with owned disposable environments; when a specific irreversible/external production action requires owner approval, report its exact command, target and risk, request that approval, and proceed with unaffected work. Do not declare G9 passed without that approval and execution. CI is expressly allowed.

## 3. Operating policy — how Codex pursues the immutable goal

The coordinator owns the goal, critical path, integration, shared interfaces, status evidence and final whole-cut review. **Delegate independent implementation, not five duplicate architectural investigations.** Assign one exclusive source owner per domain with its already-known code pointers; agents must not repeat another agent's exploratory audit.

| Owner | Exclusive area | Deliverable linked to goal gates |
| --- | --- | --- |
| **A — Control Plane and persistence** | `apps/control-plane`, `packages/persistence`, global operation/release scheduling contract | Event/notification-triggered work availability with D1 as sole logical state authority, bounded recovery, release/GC due-work scheduling, authoritative CAS/lease without idle storm — G5/G6/G8 |
| **B — Runtime / lifecycle** | `apps/provisioner`, `plugins/kubernetes`; one coordinated producer interface with Scriptorium owner | Safe idle-deadline lifecycle; identity renewal decoupled from full probes; fenced stop/start/redeploy and failure recovery — G3/G5/G7 |
| **C — Build and artifact** | `apps/build-worker`, `plugins/buildkit`, `plugins/ghcr` and owned build integration | Two real verified compositions, cache reuse, async Build trigger integration, safe failure — G4/G8 |
| **D — Gateway / Hosted access** | `apps/gateway`, `apps/instance-access`, auth entry/broker interfaces | Real login→repo→wake→one-use handoff→UI/API/MCP and Git publish path; bounded KV/DO access — G1/G2/G3 |
| **E — Deployment / integrated acceptance** | `infrastructure`, `scripts/deploy-*`, `tests/e2e` and production evidence | Existing two-VM/static platform reachability, trustworthy HTTPS/Ingress, first browser edit→Git push, final exact-cut acceptance — G2/G7/G9 |

**Cross-cutting files** (`packages/contracts`, root manifests/lockfile, D1 migrations, shared interfaces and this goal) have **one integration owner**. If a worker needs a change there, submit a small interface proposal and keep independent tasks moving. No two agents edit the same scope. Producer changes remain under the Scriptorium coordinator: do not launch competing producer worktrees.

**Execution priorities:**
1. Start A–E concurrently from refreshed main, based on [SYSTEM](architecture/SYSTEM.md), [EXECUTION](architecture/EXECUTION.md), [REVIEW](architecture/REVIEW.md) and Epic #1. E opens the current public Hosted path immediately; C produces a real admitted image, D opens entry, B prepares Runtime. A removes the idle traffic design defect concurrently. Don't make architecture perfection a prerequisite for first user journey.
2. **First integrated proof:** public login → real running Scriptorium → edit → GitHub push → reload. No mock, fixture, or bypass of security. Continue other domains regardless of one local failure.
3. Complete safe lifecycle, stable/pinned, interruption recovery, credential renewal and cost measurement; integrate tested slices frequently.
4. Conduct **one integration-level review** of a coherent combined cut and **one final release-candidate review**. Local owner tests and CI on each integrated change are appropriate; independent microscopic reviews per fix are not.
5. Run final G1–G9 acceptance on one release cut, save evidence, deliver live service and recovery runbook. Finish only when all gates are verified.

**Progress / issue handling:** On each iteration report: integrated commit, newly demonstrated G-gates, active streams, blockers with exact owner/impact, next dependency-unblocking change, and actual request/cost measurements when available. Log discovered root causes once in a shared ledger. If a bug blocks G4, continue G1/G2/G5/G8 where safe; **never halt all workers for one bug**. Stop only the unsafe effect of a security, single-writer, data-loss or unbounded-cost flaw. Prefer local containment and clear interface contracts. No fake PASS, no arbitrary scope expansion, no retroactive change to this Goal.

## 4. Existing references and initial truth

- Authority: [Epic #1](https://github.com/yohn-jp/praetorium/issues/1)
- Architecture ownership: [SYSTEM.md](architecture/SYSTEM.md)
- Runtime/control paths: [EXECUTION.md](architecture/EXECUTION.md)
- Known defects: [REVIEW.md](architecture/REVIEW.md)
- Hosted runbook: [HOSTED-INTEGRATION-RUNBOOK.md](verification/HOSTED-INTEGRATION-RUNBOOK.md)
- Verified host substrate, **not Hosted**: [Ubuntu 26.04 evidence](verification/UBUNTU-2604-20261017.md)
- Previous partial Hosted acceptance, **not GOAL ACHIEVED**: [HOSTED-ACCEPTANCE-a669f5c.json](verification/HOSTED-ACCEPTANCE-a669f5c.json)

Any new evidence must identify its exact source cut. The goal is deliberately **outcome-fixed and implementation-flexible**: changes to sprint order, agent assignment, tooling or retry implementation do not alter the accepted user outcome.
