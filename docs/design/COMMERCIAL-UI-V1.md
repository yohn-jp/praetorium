# Praetorium Commercial UI V1

Status: implementation design; production implementation and acceptance are not yet complete.
Goal ID: `PRAETORIUM-COMMERCIAL-UI-V1`
Branch: `feat/commercial-ui-v1`
Inspected/base commit: `b22d129ee3b68784e800db71a072b13618778738`
Owner instruction: 2026-10-18, create a branch, document browser/mobile UI architecture first, then implement or hand the implementation to Codex.

## 1. Finish line and authority

Replace the portal's card-heavy presentation with a deliberate operations interface. Desktop supports scanning and comparing repositories and deployments; Mobile supports checking one repository and completing one operation at a time. Both present the same authenticated product state and preserve existing commands. Deliver the real portal, not only a CSS recolor, a static specimen, an empty dashboard, or a framework installation.

The owner's instructions and Epic #1 remain product authority. This document fixes this UI campaign's presentation and delivery scope; it does not redefine lifecycle, permissions or artifact admission. Follow `AGENTS.md` and current organization governance. Work only on the named branch or isolated child worktrees. No main writes, merge, release, infrastructure changes, production deployment, key rotation or Scriptorium changes are authorized here.

## 2. Actual implementation baseline

The current portal is **Gateway server-rendered TypeScript/HTML**, not a React application:

- `apps/gateway/src/ui/types.ts`: `PortalRepositoryList`, `PortalRepositoryDashboard`, `PortalCommand`, `PortalService` and session view contracts.
- `apps/gateway/src/ui/render.ts`: shared HTML document, embedded stylesheet and its CSP hash, repository list/dashboard, configuration fields, operations, errors and handoff. Its broad `section` rule makes nested structural sections into bordered/shadowed cards.
- `apps/gateway/src/ui/handler.ts`: authenticated routes, bounded form parsing, CSRF, generation/idempotency inputs and service execution.
- `apps/gateway/src/services/portal-service.ts`: application projection and command adapter; not a second UI-owned authority.
- `apps/gateway/src/ui/portal.test.ts`: existing portal behavior/security tests.
- `tests/e2e/browser-entry.test.mjs`, `tests/e2e/gateway-worker-security.partial.test.mjs`: existing browser/security integration surfaces, with their existing fixture boundaries.

Current public portal routes are `/` and `/repositories/:repositoryId`; commands POST to `/repositories/:repositoryId/actions`. Logout remains POST `/auth/logout`. Keep these routes, methods, input names and handoff semantics. Repository identity remains the service-supplied numeric GitHub identity, not a UI-generated slug.

Current states include `blocked`. An unbuilt repository must not be made to look as though a build is running. Null current/desired artifacts, unknown permission and unavailable resource limits are meaningful, not zeros or healthy states. The old screenshots are visual anti-references, not current runtime evidence.

## 3. Architecture decisions

### 3.1 Preserve the server and separate presentation

Retain the Gateway SSR delivery and native form baseline. Do not migrate this operations portal to React, Radix or Ionic merely because Scriptorium uses those libraries. Scriptorium's two SPA builds are a separate decision. This campaign shares design principles with it, not its runtime or package dependencies.

Introduce one presentation model and two composition functions:

```text
Gateway session + PortalService (existing authorities)
                |
        Portal* view contracts
                |
      shared presentation projection
         /                     
 desktop composition       mobile composition
         \                     /
       common document / controls / theme
                |
       existing authenticated POST actions
```

Render **one** selected composition per request. Do not ship two active forms, duplicate IDs, competing polling loops, or hidden copies of editable state. Native labels/buttons/links/disclosures are the initial accessible primitives. Layout styles belong to the selected composition; formatting, command fields, escape rules and state mapping are shared.

### 3.2 Explicit presentation selection, same content URLs

Preserve explicit user selection rather than User-Agent or viewport Shell selection. An allowlisted `ui=desktop|mobile` query parameter selects the presentation at `/` and `/repositories/:id`; store an explicit choice in a presentation-only cookie, never in the authentication cookie. Without a valid choice use Desktop and expose Mobile in the header. No `/desktop` or `/mobile` route families are needed for this SSR portal.

Resolve presentation in the handler and pass a typed mode to the renderer. Propagate it to internal links and POST action URLs so preview/errors return to the same presentation. Do not add UI metadata to `PortalCommand` or to the strict POST body allowlist. Normalize invalid/duplicate values to the last valid preference/default without reflecting raw text. Cookie values are only the two enum literals; use Path=/, SameSite=Lax and Secure on HTTPS. It grants no access and contains no repository/user data.

The switch preserves repository and section location. When a configuration has unsaved edits, do not silently navigate or discard it: keep the form mounted during local section navigation; before a full mode/page navigation, warn with a Stay/Discard choice or an existing equivalent guard. No automatic configuration save, build, stop or entry operation on mode selection. Responsive CSS may adapt a selected composition locally, but may not silently change it to the other composition.

### 3.3 Source layout and minimal extraction

Within `apps/gateway/src/ui/`, target:

```text
render.ts                    existing exported render facade
presentation.ts              allowlisted UI mode / view formatting only
styles.ts                    tokens + common + selected layout styles
views/document.ts            header, navigation, error and page envelope
views/repositories.ts        Desktop rows and Mobile summaries
views/repository.ts          Desktop detail and Mobile task composition
views/configuration.ts       shared fields, preview and submission UI
views/operations.ts          measured progress and action feedback
```

These are planned paths, not files already present at the baseline. Extract the touched render responsibilities, not the service layer or the whole repository. Keep the exported render functions compatible where possible. Preserve the exact existing CSRF/idempotency/generation fields through canonical helpers; a view cannot create another authorization rule.

## 4. Browser / Desktop design

Direction: a quiet, precise operations console. Neutral ink and surfaces, a reserved blue action accent, compact readable data, one obvious next action. No decorative KPI cards, fictional throughput, animated hero, or oversized welcome block.

### Repository overview

Use a compact global header: Praetorium, Repositories, explicit UI switch, account/logout. Represent global GitHub connection once, as a compact status strip; expand it into an actionable alert only when unavailable/pending/suspended. Repository-specific installation state remains visible where it differs or matters; do not erase real per-repository information.

The content header is `Repositories` plus the real count. Use a single structured list with aligned desktop columns: repository identity, runtime state, access, latest operation, actions. Repository names are real detail links. Current/desired full digests are secondary disclosure data, not repeated boxed facts. Do not add search/filter endpoints; local filtering is optional only if the existing list warrants it and requires no new backend authority.

```text
Praetorium    Repositories                         Desktop | Mobile    Account
GitHub connection: Active
Repositories                                                   4 available
Repository                  Runtime       Access     Latest operation    Action
example/novel               Ready         Admin      Complete            Manage / Open
example/notes               Blocked       Maintain   No operation        Configure
example/drafts              Starting      Write      In progress         Details
example/archive             Stopped       Read       Complete            Open
```

Rows above are synthetic layout examples, not production state. The actual available action must come from the existing service/renderer conditions. Preserve connect, manage and entry distinctions; never infer a start/build capability from a label.

### Repository detail

A breadcrumb and repository identity lead. A state line contains runtime state, reason, current permission and the allowed primary action. When no approved configuration exists, show the existing configuration-required explanation and next step; do not offer a decorative retry.

Below it, arrange content as an overview workspace: Current deployment and Desired deployment in adjacent columns, with shared field ordering for release label, requested/included modules, allocation and expandable exact digests. Render None/Not built/Unavailable distinctly. Current may remain healthy while desired is building; never collapse those two truths into a single green status.

Section navigation: Overview, Configuration, Activity. These name sections of the current repository, not invented global pages. Keep long configuration work separate from the overview. Activity uses compact rows and expandable technical identifiers rather than one card per field. Operator limits are supporting details adjacent to configuration, not invented usage telemetry.

## 5. Mobile design

Mobile is not the Desktop table made narrow. Use a compact top bar with back navigation on repository detail, repository name and explicit UI switch. The list uses vertically ordered repository summaries: name first; runtime state and access next; reason/latest operation when present; then one clear detail/entry action. Separate records with whitespace and a single boundary, not a card inside a card.

Repository detail order: identity -> actual runtime state/reason -> allowed next action -> Current/Desired summary -> Configuration -> Activity. A short section navigator anchors these tasks. Mobile configuration and operation details are full-width, not dialogs floating over a desktop dashboard. Preserve draft form state when switching local sections. Native back/forward, direct links and refresh must remain meaningful.

Configuration fields use the same submitted names and values as Desktop. Replace the Ctrl/Command multi-select instruction with labelled checkbox rows using repeated `moduleIds` fields, supported by the existing FormData contract. Requested modules are editable; resolved required dependencies are separately labelled, not additional silently checked requested modules. Retain release policy, approved release, resource profile, Preview selection, and Save configuration and build. Do not add a wizard that changes the command contract or automatically submits on a step change.

Primary actions have a 44px design target for touch height, clear labels and a secondary cancellation/return path. Sticky navigation/action areas must leave focused fields, validation messages and the last row reachable with the keyboard open and safe-area insets. No swipe-only operation, hover-only explanation, forced zoom disable or horizontal table scrolling as the mobile design.

## 6. Visual system

This is a proposed implementation palette, not a claim of measured accessibility yet. Validate final foreground/background pairs in the rendered UI.

| Token / role | Starting value |
| --- | --- |
| Canvas / surface / subtle surface | `#F6F7F9` / `#FFFFFF` / `#F0F2F5` |
| Primary ink / secondary ink | `#18212F` / `#526071` |
| Quiet border / stronger boundary | `#DFE4EB` / `#BBC5D2` |
| Primary action / hover | `#244FC6` / `#1C3EA0` |
| Positive / positive surface | `#16664B` / `#ECF6F0` |
| Attention / attention surface | `#875507` / `#FFF6E6` |
| Error / error surface | `#AA3037` / `#FFF0F0` |

Use the existing system sans stack with suitable Japanese fallbacks; no font installation, CDN or font license assumption. Base UI text 14px Desktop / 16px Mobile, detail labels 12–13px, page title 26–28px, section title 18px, line-height 1.45–1.6. Keep small-text contrast usable. Monospace is for identifiers/digests, not all labels. No all-caps eyebrow above every block.

Spacing scale: 4/8/12/16/24/32/48px. Desktop content max-width 1280px, 32px horizontal working padding, header 56px, repository rows approximately 76px with content-driven height. Mobile content padding 16px; controls do not shrink below the touch target to fit a row. Radius: 6px controls, 10px grouped surfaces, pill only for state badges. No box shadow on every section. Remove broad element rules that make all `section` elements look like cards; style semantic regions explicitly.

Light is the existing supported appearance. A new dark-theme preference is not a prerequisite or extra feature in this campaign. State colors always accompany text; unknown is never represented as success. Motion is limited to relevant feedback and honors reduced motion.

## 7. State, security and interaction invariants

- `PortalService` remains the authority for permissions, configuration resolution, resources, generations, admission and operations. UI mode never changes those decisions.
- Keep escaping of repository names, service reasons, labels and all attribute values. No arbitrary HTML from returned data.
- Preserve current exact-origin CSRF checks, secure session behavior, one-use handoff and CSP. Existing `PORTAL_STYLE_HASH` is tied to exact CSS bytes: recompute through a build/test helper or use an equivalently strict verified mechanism. Never fix styling by adding unsafe-inline/unsafe-eval or by globally patching browser APIs.
- Preserve mutation methods, expectedGeneration and idempotencyKey. Stale-generation responses keep the user's actionable context; do not claim a configuration succeeded before its authoritative response.
- Show operation progress only when the backend provides a valid measured percentage. Queued/unknown progress has a textual state, not a fabricated bar or ETA.
- Keep the existing bounded active-operation polling ceiling. Do not add constant Cloudflare polling, parallel loops for two layouts, or automatic reload that wipes a dirty form. Pause refresh while editing and expose a deliberate refresh action.
- Preserve no-JavaScript core links/forms where currently supported. Optional navigation/dirty-state enhancement cannot replace server-side validation.
- Empty list, inactive installation, read-only, blocked/no configuration, failed retryable/nonretryable, unknown status, invalid preview and current-versus-desired divergence must all be deliberately composed.

## 8. Fixed delivery sequence

1. **D0 Architecture**: commit this design before production implementation. Read only the named render/handler/service dependencies needed for the next decision.
2. **D1 Shared presentation foundation**: extract styles/document and the minimal view formatting; preserve CSP and command fields. Add focused render-contract tests before changing the corresponding behavior.
3. **D2 Desktop and Mobile views**: independent composition, explicit mode handling and shared configuration/operation controls. Desktop and Mobile may be delegated in parallel only after the shared signatures are frozen; handler/security/manifest changes have one owner.
4. **D3 Integration and finish**: both compositions run through the real Gateway handler; reconcile real states, errors, unsaved inputs, CSP and navigation. Compare rendered captures against the visual specimen and this document.
5. **D4 Verification and PR**: required repository check, focused browser proof, final diff/contract review and reviewable PR. Stop at READY_FOR_REVIEW; no merge/deploy.

Do not dispatch a worker to redesign the architecture or to independently re-explore the same service layer. A local defect does not stop independent work, and a new unrelated backend issue does not expand this goal.

## 9. Acceptance and evidence

- Both Desktop and Mobile can list repositories, open details, inspect current/desired configuration, preview and submit permitted configuration, see actual operations, and reach the existing entry/retry/stop paths as authorized. No current user-visible capability silently disappears.
- Explicit presentation choice and repository/section identity survive internal navigation, POST preview/error responses and reload. No automatic UA/width-based mode switch. No silent loss of a dirty form or duplicate submissions on view changes.
- Screenshot review on populated/empty/failure states at Desktop 1440x900 and Mobile 390x844, plus overflow checks at 320px and 768px. Verify long repository names, full digests, multi-line reasons and low-height keyboard layouts. These are design targets, not statements about executed tests.
- Exercise keyboard focus, form labels, checkbox selection, visible validation, back/forward and touch alternatives. Use Chromium and WebKit for the changed UI paths; physical iOS/Android and real OS IME are separate evidence, not implied by browser automation.
- Required production-code checks: `corepack pnpm@11.18.0 install --frozen-lockfile` and `corepack pnpm@11.18.0 check`, with the repository's Node 24 range. Reuse existing portal/security/browser fixtures rather than inventing a second application harness. Add a bounded visual fixture only where needed to render the changed paths.
- Record exact tested commit, commands/exits, browser/viewport, screenshots and material limitations. Static HTML specimen validation is not production Gateway/auth/lifecycle validation. Historical green or a local machine path is not accessible raw evidence by itself.
- CI verification is allowed under AGENTS.md. No release workflow, image publishing, real Cloudflare/D1/DNS/K3s mutation, GitHub credential use or fixture deployment is implied by UI tests. Missing external acceptance inputs are NOT_CHECKED, not a code failure or permission to weaken guards.

## 10. Exclusions

No new platform features, global telemetry dashboard, invented account settings, new auth model, native app, PWA, React/Ionic migration, build/provider/lifecycle rewrite, backend schema migration, cross-repository design package publication, production release or rollout. Framework adoption can be a separate owner decision if an actual requirement later justifies it; it is not a design-quality substitute.

Visual fixtures and implementation instructions accompany this document as references. They cannot override product truth or grant mutation permissions beyond this scope.
