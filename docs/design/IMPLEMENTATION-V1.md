# Commercial UI V1 implementation handoff

## Authority and current delivery

Read [COMMERCIAL-UI-V1.md](COMMERCIAL-UI-V1.md) before changing production code. The architecture was committed first in `a37a2ece86d1c487f3e65a8a3f5b243d620b90d1`; the self-contained [visual specimen](portal-specimen.html) followed in `07d0d26f5ff8ad356ebcf2aaf7e66f52189832c6`.

Repository: `yohn-jp/praetorium`. Continue on `feat/commercial-ui-v1`, created from `b22d129ee3b68784e800db71a072b13618778738`. Inspect newer main changes only for relevant conflicts; do not overwrite them or restart platform discovery. Main, deployment and releases remain unchanged by this UI branch.

**Completed:** architecture and a standalone design specimen. **Not completed:** production Gateway UI integration, repository checks, production browser acceptance and PR review. The specimen's synthetic data and disabled runtime buttons are not production implementations or authority for actions.

## Implementation sequence

### D1 — shared presentation and mode boundary

Owner: coordinator/shared-UI implementer. Inspect `apps/gateway/src/ui/{render,handler,types,portal.test}.ts` and only the service calls that the changed rendering consumes.

Add the planned `presentation.ts`, `styles.ts` and `views/document.ts`. Keep `render.ts` as the existing exported facade. Define one `PortalUiMode = "desktop" | "mobile"`; resolve allowlisted query/preference at the handler and pass it as presentation context. Reuse `PortalRepositoryList` and `PortalRepositoryDashboard`, without a duplicated mutable domain store. Centralize local URL construction and preserve existing POST field names and route methods.

Before implementation, add focused failures to the existing portal tests for direct mode selection, invalid/duplicate mode fallback, mode preservation through preview/error, unchanged permission enforcement and a matching stylesheet CSP hash. No dependency additions should be needed for this layer. Run the focused tests after the minimal implementation and commit the accepted producer seam before parallel view work.

### D2 — Desktop and Mobile composition

Owners: one Desktop worker and one Mobile worker after D1 signatures are committed. Shared view fields/actions are coordinated by D1's owner; workers do not race on handler.ts, types.ts, package manifests or lockfiles.

Implement `views/repositories.ts` and `views/repository.ts` with explicit desktop/mobile composition boundaries. Follow the architecture's field hierarchy and the specimen's spacing/type/surface vocabulary, while retaining real capabilities omitted from the specimen (logout, connect/open, exact digests, stop/redeploy/retry and all authoritative errors). Do not hardcode fixture states or derive permission from a color/label. Native section navigation must not destroy a dirty configuration form. Both modes must render meaningful empty, blocked, unavailable and populated states.

Add only the render/interaction checks required to prove these changes. Preserve escaping, labels and unique DOM IDs. Commit the view work; do not merge main.

### D3 — configuration, activity and integration

Owner: shared-UI implementer. Extract `views/configuration.ts` and `views/operations.ts` from the actual renderer. Use labelled checkbox rows for repeated `moduleIds`: `handler.ts` already reads this field with `FormData.getAll`. Preserve requested-versus-required modules, authoritative preview, expectedGeneration, idempotencyKey and CSRF.

Keep Current and Desired separate, including null/current-ready/desired-building combinations. Retain real operation percentages only. Ensure active-operation refresh stays bounded and cannot reload over dirty configuration. Mode navigation must not implicitly execute any command. Never replace existing policy guards with presentation logic.

### D4 — final verification and PR

Use the repository's required Node 24 range and pnpm 11.18.0. Run:

```sh
corepack pnpm@11.18.0 install --frozen-lockfile
corepack pnpm@11.18.0 check
```

Exercise the changed portal through its production renderer/handler with owned synthetic fixtures in Chromium and WebKit. Reuse the existing portal/security integration paths where relevant. Capture Desktop and Mobile populated/configuration/blocked/empty cases, check 320/390/768px and Desktop 1440px layout, native keyboard/focus, long identifiers, UI choice, dirty form navigation, preview/error paths and real CSP enforcement. Do not replace product/security assertions with screenshots.

Check final diff against the architecture and surrounding code. Fix in-scope failures and rerun only affected checks plus required final verification. Record exact HEAD, executed commands/exits, accessible screenshots and limits. Missing live Hosted infrastructure is separate from the local UI gate and does not authorize deployments. Publish a reviewable implementation PR; mark READY_FOR_REVIEW only when required gates pass. No merge, deployment or release.

## Specimen usage and evidence

Open `portal-specimen.html` in a browser. Desktop/Mobile buttons switch the explicit fixture layout; repository links open details; Overview/Configuration/Activity show the specimen's views. Query options include `ui=desktop|mobile`, `screen=list|detail|configuration|activity|empty` and `repo=novel|notes|drafts|archive`. These are specimen parameters, not new production routes.

Fixture file Git blob: `b588e8969c2e17b38c919d3488b554b67cb3261a`.
SHA-256: `c8bebaf313c7c876aed7f1673164b0143397e5cafa5ad871a553ba71c6fad654`.

Validation performed on that exact HTML: JavaScript syntax check (`node --check`) passed. System Chromium 144.0.7559.96 with Playwright rendered ten cases via `page.set_content`: Desktop list/detail/configuration at 1440x1000; Mobile list/blocked-detail/configuration/empty at 390x844; Mobile list/configuration at 320x740; Desktop list at 768x1000. All had no uncaught script error or document horizontal overflow. List fixture counts and local configuration-preview feedback were also asserted. Desktop list/detail and Mobile blocked-detail captures were visually inspected, and repeated empty-deployment blocks and a misleading activity dot were corrected before the final rerun.

The test runtime blocks file/localhost navigation; these captures used in-memory HTML with fixed query input. **Navigation/back/forward, the browser unload confirmation, actual HTTP CSP, production authorization, live Gateway state, WebKit and physical mobile hardware are NOT_CHECKED by this specimen run.** This does not claim production acceptance or a production UI deployment. Do not copy the specimen's inline script/style policy into the Gateway; the Gateway must retain its verified hash/nonce CSP.

## Ready-to-paste Codex goal

```text
/goal Praetorium Commercial UI V1を、コミット済みの設計と画面見本に従って実装し、検証済みのPRとして納品する。

Repository: yohn-jp/praetorium
Branch: feat/commercial-ui-v1
Authority: docs/design/COMMERCIAL-UI-V1.md
Plan: docs/design/IMPLEMENTATION-V1.md
Visual reference: docs/design/portal-specimen.html

最新の対象ブランチとmainを取得し、分離worktreeで既存ブランチを継続する。文書の設計・受入条件・対象外を固定し、D1→D4を実行する。既存Gateway SSR・PortalService・認証・CSP・CSRF・generation/idempotencyを維持する。Desktop/Mobileの見せ方は分離し、機能や操作権限を二重実装しない。

共有境界を先にコミットし、独立したDesktop/Mobile作業だけサブエージェントへ分担する。重複探索、再選定、未依頼のバックエンド改修は禁止。見本の架空データや無効ボタンを本番実装にしない。既存機能を落とさず、実画面で確認する。

AGENTS.mdのfrozen installとcheck、計画のブラウザ検証を実行し、意味のある単位でcommit・push、最後にPRを作成する。未実施をPASSにしない。main直接変更・merge・release・deploy・他リポジトリ変更は禁止。

設計説明だけで停止せずD1から着手する。完了報告はPR、HEAD、視覚変更、実行した検証と未確認事項を分ける。
```
