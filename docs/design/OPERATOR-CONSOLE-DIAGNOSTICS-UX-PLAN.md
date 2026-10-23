# Operator Console: Source Build diagnostics and operational UX

Status: implementation plan; no production behavior changed by this document.
Base: main `48ab361786d216610bca99cbeb905e722c715609` (2026-10-23).
Authority: owner instruction (browser-first operations, SSH break-glass only), Issue #31 real Source→Stable acceptance, Issue #26 operator authorization, `docs/design/OPERATOR-CONSOLE-MOBILE-V2.md`, existing Control Plane / Worker contracts.

## 1. Observed failure and outcome

Owner submitted Scriptorium v0.3.3 Source job `sr_54a61e4d-088c-453e-98ca-6be8588a4e1f`; admin UI displays `SOURCE_BUILD_FAILED` and attempt 1, but not the failed phase, sanitized BuildKit diagnostic or recovery decision. This is a **known visibility defect**, not evidence of a specific underlying v0.3.3 compiler/BuildKit cause. Do not assert the cause before inspecting the actual attempt. Older v0.3.0/v0.3.2 failures remain immutable historical evidence.

The operator must be able to open the failed job from the browser, see an attributable error and stage, distinguish transient from permanent failure, inspect bounded sanitized evidence, and retry only when the canonical queue permits it. No routine SSH, manual D1 mutation, tag movement, re-release or source rewrite is part of this flow.

## 2. Existing boundaries (verified)

- `apps/gateway/src/admin/console.ts`: single long server-rendered admin page with Release list, candidate ledger, Source queue and Audit. It forwards through authenticated Control Plane service binding; CSRF and admin-origin/session checks protect mutations.
- `apps/gateway/src/admin/release-sources.ts`: published GitHub Release selection and immutable source identity revalidation; Source view currently exposes state/attempt/revision/error/retryable/admittedReleaseId.
- `apps/control-plane/src/source-release-builds.ts`: D1 is authoritative for queue state, attempt/revision, failure code and idempotent fenced retry. Current failure request accepts a bounded enum, not arbitrary Worker error text.
- `apps/build-worker/src/source-producer-builder.ts`: isolated producer execution and verification; internal exception messages/build logs are not a public diagnostic contract.
- `docs/architecture/ADMINISTRATION.md`: admin console is an operator entrance, not a new control plane; existing Headlamp/Kubernetes and provider authority remain separate.

## 3. Target operational experience

**Desktop**: persistent left navigation (Overview, Releases, Builds, Audit); top context bar; Overview prioritizes active/failed jobs, current Stable and blocked releases. Builds shows a compact sortable/filterable table; clicking a row opens a dedicated detail view with a stage timeline and attempt history. Audit has its own bounded, paginated view. Release selection and immutable SHA/digest inspection live in Releases, not on the Overview page. Preserve the existing forest/ivory visual identity, with higher information density and legible status hierarchy.

**Mobile**: separate task-oriented navigation and composition, not a scaled desktop table. Overview displays active incident and next safe action first; Builds is a vertical list, with a full-screen job detail, stage/attempt sections and a fixed accessible action region. Audit is searchable/bounded and separate. No duplicated mutation forms.

**Interaction**: a queued response means accepted, not built. Each operation displays a stable job ID and an explicit authoritative state (`queued`, `building`, `produced`, `admitted`, `failed`, or `unknown/unavailable`). Status refresh must not move header height or discard focus/scroll; use a non-displacing toast or inline live region. Bounded polling while the job is visible (with backoff and visibility awareness) is an implementation option; never invent ETA or a percentage. Poll failures display `status unavailable`, not `failed`. On completion, keep the final evidence accessible. Retry requires a deliberate action, current revision and idempotency key; show the new attempt separately without erasing the prior failure.

## 4. Diagnostics contract and data flow

1. Define a minimal **attempt-scoped** diagnostic DTO from existing source job/attempt authority: job ID, attempt, revision, immutable release SHA/tag, stage, timestamps, canonical status/failure code, retryable flag, and sanitized failure summary. Link to bounded detailed evidence only when it exists. Unknown stage/error is explicit, never fabricated.
2. Capture actual Worker failure context at the point of failure, including relevant BuildKit phase/exit classification, without exporting raw environment, tokens, OAuth headers, registry credentials, Git URLs containing auth, filesystem secrets or full unbounded stdout/stderr. Use allowlisted fields, redaction, byte caps and retention. Preserve source queue fencing/lease/epoch and immutable release binding; stale workers must not overwrite later attempts.
3. Reuse D1 for bounded diagnostic metadata and existing configured storage for larger sanitized evidence **only if already available**. Inspect existing R2/diagnostic storage and authorization before choosing it; do not introduce a second state authority, generic log ingestion system, or new provider solely for this feature. Missing/expired evidence remains a truthful `not available` state.
4. Add a read-only operator endpoint for single-job detail and its attempts, using existing admin-origin authorization and authenticated Gateway→Control Plane binding. Keep diagnostics inaccessible to ordinary tenants, unauthenticated users and public Gateway origin. No arbitrary filesystem/log/SQL read endpoint.
5. Render actionable failure classifications (source checkout, dependency/build, OCI export, verification, admission, infrastructure/unavailable) only where supported by actual recorded stage and code. Present canonical error code and attempt ID for escalation. A retryable flag comes from the existing canonical queue policy, not UI inference.
6. For the actual v0.3.3 job, retrieve any currently retained authoritative evidence and report the exact observed cause. If old raw evidence was never persisted, mark it unrecoverable via the UI and ensure the **next explicitly authorized attempt** captures diagnostics; do not claim to reconstruct lost logs or automatically retry.

## 5. Implementation waves and file ownership

### Wave A — independent discovery and contracts
- A1 (Control Plane/Worker): trace `sr_54a61e4d-088c-453e-98ca-6be8588a4e1f` failure lifecycle and existing diagnostic persistence; propose the smallest authoritative attempt DTO and storage.
- A2 (Gateway/UI): inventory existing console render/routing/styles/tests and design distinct Desktop/Mobile task flows, including loading/error/unknown/empty states.
- A3 (security): review operator auth/CSRF/service binding and diagnostic redaction/retention constraints. Read-only findings, no conflicting edits.

Coordinator fixes the shared DTO and endpoint contract before downstream implementation.

### Wave B — independent implementation
- B1 (Worker + queue persistence): bounded redacted attempt evidence, stale-attempt fencing, failure-stage recording and readback tests. Own Worker/queue persistence only.
- B2 (Control Plane API + authorization): read-only detail/list endpoints, pagination/limits, no cross-tenant leakage, typed DTO; own operator route and API tests.
- B3 (Desktop): Overview/Releases/Builds/Audit route composition, detailed build timeline and retry flow; own desktop view components/styles.
- B4 (Mobile): separate mobile navigation/cards/full-screen detail, touch/focus/safe-area behavior; own mobile components/styles.
- B5 (UX regression): browser contract tests for queued→failed→retry→success/unknown, non-displacing notifications, back/refresh, audit navigation, accessibility; own test files only.

Coordinator alone integrates shared Gateway route entrypoints, schemas and cross-component imports. Do not let sibling workers edit the same file concurrently; split sequentially where existing monolithic files require it.

### Wave C — integration and certification
- Exercise real request path: GitHub OAuth admin session → immutable Release selection → Source job → Worker diagnostic readback → guarded retry → OCI/Admission/Canary/Stable status, with a disposable failure fixture and explicit real-production evidence boundaries.
- Negative tests: unauthorized/non-admin/CSRF, oversized evidence, secret-bearing logs, stale attempt, failed storage, expired diagnostic, out-of-order callback, duplicate retry, polling outage, and browser reload.
- Verify `pnpm check`, relevant Gateway/Control Plane/Worker tests, CI, desktop and mobile rendered behavior (including 320/375/390/430px), keyboard and screen reader semantics.
- Deploy only through the approved existing deployment path after preflight. Verify real production readback and the next authorized job attempt; never equate simulated CI with hosted acceptance.
- Update `docs/verification/issue-31.md` with exact SHAs, attempt IDs, CI, real diagnosis and outstanding gates. Do not close #31 until real Source→Stable plus MCP/Wake/writer/persistence acceptance is proven.

## 6. Non-goals and safety

No new control plane, no new database authority, no generic Kubernetes shell/SSH console, no arbitrary BuildKit command execution, no bypass of proof/signature/source clean-tree validation, no silent retry, no automatic deployment, no weakening admin allowlist/CSRF or credential epoch rollback floor. Preserve immutable Release identity, historical failed attempts and current tenant data.

## 7. Acceptance

- A failed Source Build can be diagnosed from the authenticated browser using persisted, bounded, redacted, attempt-specific evidence, with stage, error, and next permitted action visible.
- Desktop and Mobile each provide a complete task-first workflow; Release list and Audit no longer bury the active failure.
- The current failure is diagnosed from retained evidence or explicitly marked `evidence unavailable`; a later authorized retry records the actual failure stage. No invented diagnosis.
- Unauthorized access to diagnostics is denied; retries remain fenced and idempotent.
- Existing successful Source→Stable behavior and all relevant CI gates remain intact; final production evidence is separately recorded.
