# Commercial UI V1 verification

Status: **READY_FOR_REVIEW** for the local UI scope. This is implementation and browser evidence, not a deployment or Hosted product certification.

Tested implementation/runner commit: `841823ebb4b86f0517d019e19c23b882a8b976fc`. The following evidence-only commit adds this record, raw logs and screenshots. Gateway source is identical to `3652083d6e78de9a0ab762361bbadb06d0dfc948`, which was also tested through the actual Worker security fixture. Production source remains unchanged after these tests.

Text evidence removes trailing line whitespace for review; the [manifest](../verification/commercial-ui-v1/manifest.json) records both original log hashes and committed file hashes.

## Scope and integration

Continued `feat/commercial-ui-v1` from `a4f346c89fd13bcf0a96732b7b90215dd28f7c67` in an isolated worktree. Fetched main initially at `1abfcaa`, then again at `abbfb09`. Its newer OCI verification, hosted browser runner and deployment evidence changes do not conflict with this UI slice. Main was not merged or modified.

Read the authority, implementation plan, architecture ledgers and Epic #1. Opened the committed HTML specimen in Chromium at Desktop 1440×900 and Mobile 390×844, then compared the production-renderer captures against its typography, surfaces, spacing and hierarchy. The specimen's account, fixture data, example endpoints and disabled commands were not copied into production.

D1 was committed/pushed first as `24a7f30`: typed presentation context, strict mode/preference resolution, local URLs and document/style extraction. Six focused cases were added before changing behavior: initial result 5 failed / 18 passed; foundation result 23 passed. Independent Desktop/Mobile workers then used separate worktrees and only owned their composition/test files. Their source commits were integrated as `6eef2d4` and `f731201`. Shared handler, styles, configuration, operation controls and final wiring had one integration owner. No dependency/lockfile, service, auth policy, provider or schema changes were needed.

The renderer now selects one composition, with no duplicate editable state. Desktop aligns repository fields and compares Current/Desired side by side. Mobile orders one repository/task vertically. Exact artifacts and technical operation IDs remain in native disclosures. Configuration uses repeated labelled `moduleIds` checkboxes; required dependencies stay separate. Native section anchors preserve the mounted draft. Mode switches retain repository/section and use the browser's unsaved-navigation confirmation. Editing pauses the existing bounded refresh; mode changes execute no command.

Authoritative errors retain submitted choices, including choices that disappeared from the current catalog, without labelling an older preview as validation of the submitted draft. Service-supplied permission, generation, idempotency and admission decisions remain authoritative. Sign-out, connect/open, configure/preview, stop, redeploy and retry keep their existing methods/fields.

Browser testing found that the old portal document's `Referrer-Policy: no-referrer` produces `Origin: null` on native form POSTs. The portal document now uses `same-origin`, retaining exact-origin CSRF validation and suppressing cross-origin Referer disclosure. The auth/session endpoints were not changed. Styling still uses exact per-mode SHA-256 hashes; scripts still require the request nonce. No unsafe-inline/eval or browser-API patch was introduced.

## Executed gates

Environment: Node `v24.21.0`, Corepack `0.36.0`, pnpm `11.18.0`.

| Gate                                                                  | Result                                                                                                        | Raw evidence                                                                                                                  |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `corepack pnpm@11.18.0 install --frozen-lockfile`                     | PASS, exit 0 on `3652083`; no dependency changes afterward                                                    | [install.log](../verification/commercial-ui-v1/install.log)                                                                   |
| `corepack pnpm@11.18.0 check`                                         | PASS, exit 0 on `841823e`: build, lint, typecheck, tests, boundaries, schema drift; 29 Turbo tasks successful | [check.log](../verification/commercial-ui-v1/check.log)                                                                       |
| Focused portal/composition cases                                      | PASS: 25 portal + 4 Desktop + 4 Mobile; Gateway package totals 132 passing tests                              | Root check log                                                                                                                |
| `node --test tests/e2e/gateway-worker-security.partial.test.mjs`      | PASS, exit 0 on `3652083`; exact same Gateway source tree as final runner commit                              | [gateway-security.log](../verification/commercial-ui-v1/gateway-security.log)                                                 |
| Production handler/renderer over loopback HTTP, Chromium 156.0.8078.4 | PASS, exit 0 on `841823e`                                                                                     | [chromium.json](../verification/commercial-ui-v1/chromium.json), [browser log](../verification/commercial-ui-v1/chromium.log) |
| Same local UI fixture, WebKit 26.6 / Playwright 1.63.0                | PASS, exit 0 on `841823e`                                                                                     | [webkit.json](../verification/commercial-ui-v1/webkit.json), [browser log](../verification/commercial-ui-v1/webkit.log)       |
| WebKit 27.2 / repository Playwright 1.64.1                            | FAIL: native SELECT emits CSP `style-src-attr` events with no application inline style; not counted as PASS   | [failure log](../verification/commercial-ui-v1/webkit-27.2-failure.log)                                                       |

The initial root-check attempt stopped before build because nested `pnpm` resolved to host pnpm 12.10.1. Subsequent required commands used a temporary Corepack shim directory first in PATH (`corepack enable --install-directory /tmp/praetorium-ui-toolchain`), without repository configuration changes. An early direct Gateway typecheck before dependency build failed for missing workspace declarations; the root check builds those first. Worker checks also passed; they do not replace the integrated checks above. Final Turbo cache reuse is recorded in the log rather than described as an uncached rerun.

The UI browser fixture reuses the unit portal data in `apps/gateway/src/ui/portal.fixtures.ts`, bundles the real `createPortalHandler`, and provides an explicitly owned synthetic session/service over an ephemeral loopback server. It verifies actual HTTP CSP and exact-origin/token checks at that fixture boundary. The separate Miniflare probe bundles the real Gateway Worker and exercises local KV/DO/session, duplicate cookie, OAuth redirect, CSRF and query-redaction paths. Neither substitutes for a real GitHub/producer/registry integration.

Both browser runs assert populated, blocked, empty, failed and read-only behavior; 320/390/768px and Desktop 1440px widths; 460px low-height layouts; long names/reasons and expanded full digests; unique IDs, labels, checkbox selection, keyboard focus/Tab and 44px Mobile buttons; local draft navigation; Stay/Discard; mode/cookie/section/reload/back/forward; measured progress and dirty refresh pause; valid/unsupported previews and stale-generation feedback; actual configure/stop/redeploy/retry/enter form commands and fencing fields; no commands on mode changes; no-JavaScript preview; blocked untrusted script/style insertion. Observed text/action/status contrast pairs have a minimum ratio of 5.72:1, above the 4.5:1 assertion threshold. These are sampled rendered pairs, not an independent accessibility certification.

## Reproduction and captures

Run `node tests/e2e/commercial-ui.test.mjs` after installing the browser runtimes. Optional environment variables select browsers (`PRAETORIUM_UI_BROWSERS=chromium|webkit`), output directory (`PRAETORIUM_UI_EVIDENCE_DIR`), Chromium launch environment JSON (`PRAETORIUM_UI_CHROMIUM_ENV`: `executablePath`/`LD_LIBRARY_PATH`) and a separate browser driver package (`PRAETORIUM_UI_PLAYWRIGHT_PACKAGE`). No production credentials or external disposable infrastructure are required for this local fixture.

Executed Chromium command:

```sh
PRAETORIUM_UI_BROWSERS=chromium \
PRAETORIUM_UI_CHROMIUM_ENV=/tmp/praetorium-browser-env.json \
PRAETORIUM_UI_EVIDENCE_DIR=/tmp/praetorium-ui-delivery-chromium \
node tests/e2e/commercial-ui.test.mjs
```

WebKit 26.6 was installed in `/tmp/praetorium-ui-webkit-runner` using `corepack pnpm@11.18.0 add --save-exact playwright@1.63.0` and that package's `playwright install webkit`. This did not change repository dependencies. It ran inside the existing Nix FHS browser environment with its GL library path:

```sh
PRAETORIUM_UI_BROWSERS=webkit \
PRAETORIUM_UI_PLAYWRIGHT_PACKAGE=/tmp/praetorium-ui-webkit-runner/node_modules/playwright \
PRAETORIUM_UI_EVIDENCE_DIR=/tmp/praetorium-ui-delivery-webkit \
PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1 \
/nix/store/payhw0jwnz96dizmq85drai2398l3a9s-scriptorium-webkit-fhs/bin/scriptorium-webkit-fhs \
-c 'export LD_LIBRARY_PATH=/nix/store/jvq8nlprvmwi0qpk46iay198qzcav962-libglvnd-1.7.0/lib; node tests/e2e/commercial-ui.test.mjs'
```

Only Playwright's distro-package preflight was skipped for Nix; the actual WebKit executable, all UI assertions and real CSP enforcement ran. WebKit 27.2's failure matches the independently reported [Playwright #43497](https://github.com/microsoft/playwright/issues/43497). The repository-pinned 1.64.1/default WebKit path therefore still fails this strict fixture; use the explicitly recorded 26.6 runtime to reproduce the passing gate. No CSP exception or error filtering hides it.

There are 36 committed screenshots: six states × two modes × two engines at Desktop 1440×900 / Mobile 390×844, plus long-identifier captures at 320/390/768×460 for both modes and engines. The six named states are viewport captures (configuration/activity anchors selected where appropriate); long cases capture the full document after expanding digests. Visually reviewed Desktop list/detail/configuration, Mobile list/configuration/blocked/empty and narrow long-identifier captures against the opened specimen. State/security assertions are independent of screenshots.

| Capture                   | Desktop                                                                      | Mobile                                                                      |
| ------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Chromium list             | [image](../verification/commercial-ui-v1/chromium-desktop-list.png)          | [image](../verification/commercial-ui-v1/chromium-mobile-list.png)          |
| Chromium configuration    | [image](../verification/commercial-ui-v1/chromium-desktop-configuration.png) | [image](../verification/commercial-ui-v1/chromium-mobile-configuration.png) |
| Chromium blocked          | [image](../verification/commercial-ui-v1/chromium-desktop-blocked.png)       | [image](../verification/commercial-ui-v1/chromium-mobile-blocked.png)       |
| Chromium empty            | [image](../verification/commercial-ui-v1/chromium-desktop-empty.png)         | [image](../verification/commercial-ui-v1/chromium-mobile-empty.png)         |
| WebKit detail             | [image](../verification/commercial-ui-v1/webkit-desktop-detail.png)          | [image](../verification/commercial-ui-v1/webkit-mobile-detail.png)          |
| WebKit failure/activity   | [image](../verification/commercial-ui-v1/webkit-desktop-failure.png)         | [image](../verification/commercial-ui-v1/webkit-mobile-failure.png)         |
| WebKit 320px / low height | [image](../verification/commercial-ui-v1/webkit-desktop-long-320.png)        | [image](../verification/commercial-ui-v1/webkit-mobile-long-320.png)        |

## Limits

WebKit 27.2 strict-CSP clean-load acceptance is not passed; physical iOS/Android, real OS IME, screen readers and live Hosted GitHub/Instance Access/producer/registry/build/lifecycle acceptance are **NOT_CHECKED** by this campaign. No owned live Hosted inputs were supplied to this UI runner. Existing broader Hosted evidence is outside this local gate and was not upgraded by these tests. CI status is recorded in the PR independently. No merge, release, deployment, service-image publication, key rotation, data deletion, template synchronization or other-repository modification was performed.
