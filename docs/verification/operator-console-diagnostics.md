# Operator console diagnostics implementation

Authority: latest owner request, [committed implementation plan](../design/OPERATOR-CONSOLE-DIAGNOSTICS-UX-PLAN.md), [mobile contract](../design/OPERATOR-CONSOLE-MOBILE-V2.md), Issues [#31](https://github.com/yohn-jp/praetorium/issues/31) and [#26](https://github.com/yohn-jp/praetorium/issues/26). Base: `48ab361786d216610bca99cbeb905e722c715609`. This is an implementation/verification record, not a new product plan.

## Actual v0.3.3 incident

A read-only remote D1 query through the existing Wrangler configuration found job `sr_54a61e4d-088c-453e-98ca-6be8588a4e1f`, published tag `v0.3.3`, immutable SHA `2656531a098591fa2691e258f9a927f9f4da2c96`: state `failed`, attempt 1, revision 0, lease epoch 1, failure `SOURCE_BUILD_FAILED`, `progress_json = null`. The matching existing audit event contains only failure code, attempt and epoch. Both queries reported zero rows written and `changed_db: false`. See [bounded readback evidence](operator-console-diagnostics-20261023.json).

**Underlying cause: evidence unavailable.** The old Worker discarded BuildKit diagnostic context and reported the canonical failure enum; D1 retained no stage or diagnostic body. Neither a compiler error nor an infrastructure error can be reconstructed from these rows. Another release's failure is not evidence of this job's cause. No SSH, production retry, manual row update, tag movement, release publication or service deployment was performed for this investigation.

## Execution and authority

The existing Source Worker claims the existing D1 job through the authenticated Control Plane Worker route. Each claim is fenced by worker ID, opaque lease token, monotonically increasing lease epoch, revision and lease expiry. Producer execution remains isolated in the existing BuildKit provider. Reports/proof still pass existing cryptographic and immutable artifact verification before canonical Admission; Canary and Stable retain their existing authority.

New diagnostics use the same authenticated Worker→Control Plane route and the existing D1 database. Migration `0008_source_build_diagnostics.sql` adds one attempt row per claim epoch. It does not backfill invented evidence or alter existing jobs/releases. Explicit retries retain prior attempt records, use the existing revision/idempotency receipt, and revalidate the published Release/tag/SHA at Gateway before queue mutation.

Operator detail/history is an authenticated Gateway→Control Plane Service Binding read. Browser routes remain restricted to the exact admin origin, current GitHub OAuth session and configured numeric admin allowlist. Same-origin CSRF remains mandatory on mutations. Browser responses contain neither service tokens nor worker lease credentials. No arbitrary filesystem, shell, log-file or SQL endpoint was added.

The diagnostic DTO allowlists actual execution stage and exit reason. Unknown/not recorded is explicit. A bounded sanitized excerpt is optional; arbitrary summaries are replaced with canonical reason copy. Authentication headers, command/environment lines, URLs containing credentials, key blocks and credential-shaped strings are excluded. The Worker and Control Plane both enforce sanitation and byte bounds. An unavailable status read is shown as unavailable; it never invents a Build failure.

Evidence expires after 30 days. Reads withhold expired diagnostic content; the existing scheduled maintenance clears bounded batches of expired payloads. Attempt identity, timestamps, stage and canonical outcome remain as history. There is no new polling controller or second state authority. Gateway requests ten attempts per page to remain within its 256,000-byte response limit; both API and UI use bounded cursors.

Desktop has independent Overview/Releases/Builds/Audit screens, a persistent navigation rail and dedicated Build detail. Mobile uses its own cards, bottom tabs, full-screen detail and deliberate touch recovery action. Explicit Desktop/Mobile selection reuses the normal UI preference cookie. Notifications do not displace content. Release selection returns an authoritative queued job and redirects to its dedicated status/evidence route; it does not claim admission or Stable.

## Verification results

BuildKit transport regression: upstream [`buildctl` sends its progress printer to stderr](https://github.com/moby/buildkit/blob/master/cmd/buildctl/build.go), and the raw JSON display encodes the typed SolveStatus events ([display implementation](https://github.com/moby/buildkit/blob/master/util/progress/progressui/display.go)). The previous adapter parsed only stdout and flushed an unterminated last event only on success. A child-process regression reproducing stdout/stderr and final-newline/no-final-newline combinations failed 3/4 cases before the fix (`diagnostic: undefined`) and passed all four afterward. The complete Buildctl test file passed 10/10. Streams now have separate bounded UTF-8 framing; non-JSON stderr and raw command text are never returned as diagnostics.

Implementation reviewed and verified at `383fee0d09c8dda713438dffc49625d02a374fdf`; keyboard/touch browser assertions were then committed as `1019f10e297b3bee3a54c83926204f1d26c6dbc9` without changing implementation. The PR's required CI checks bind the final delivery HEAD, including this evidence record. Local fixtures establish implementation behavior only; they do not certify hosted producer, registry or browser acceptance.

| Gate | Actual result |
| --- | --- |
| Node / pnpm | Node `v24.21.0`, pnpm `11.18.0` |
| `corepack pnpm@11.18.0 install --frozen-lockfile` | PASS; lockfile unchanged |
| `corepack pnpm@11.18.0 check` | PASS: build, lint, typecheck, 1,023 tests, provider boundaries and generated JSON-schema parity. Changed packages: Gateway 229, Control Plane 225, Worker 49, BuildKit 24, contracts 21. |
| `node --test tests/deployment/*.test.mjs` | PASS 58/58; additive 0008 preserves existing rows, historical receipt order and migration preflight. |
| `node --test tests/e2e/operator-console-diagnostics.test.mjs` | PASS; both independent modes perform published Release selection → queued → building → failed → explicit retry → admitted → canonical release workflow. Desktop uses keyboard activation; mobile uses touch activation. Back/forward/reload, escaped diagnostics, status-unavailable distinction and non-displacing notices are checked. |
| Rendered widths | PASS: Mobile 320/375/390/430px and Desktop 1440px, no horizontal overflow. Final desktop heading is 1,062px wide and 46px high; the portal CSS name collision seen during visual inspection was fixed and guarded by browser geometry assertions. |
| Independent review | Read-only Luna Max review of `383fee0`; no remaining actual blocker. The reviewer ran no tests. Findings corrected: sanitizer short-credential exclusion, reachable bounded history, accurate filter/legacy/queued copy, setup-stage failures and admission-only retry copy. |
| Production incident readback | PASS read-only; exact job/SHA/code/attempt/epoch persisted, zero writes. Underlying failure cause remains unavailable. |
| Hosted producer / registry / OAuth / Canary / Stable / lifecycle | BLOCKED / NOT_CHECKED as listed below; neither unit fixtures nor CI are hosted acceptance. |

The exact Corepack check initially exposed the machine's outer-v11/nested-v12 pnpm dispatch mismatch in isolated workers. The integrated run prepended temporary Corepack shims under `/data/praetorium-console-bin` so nested scripts also use 11.18.0; it then passed with the literal required command. No repository package-manager version or engine check was relaxed. BuildCTL transport regression results are recorded above.

Committed [browser measurements and screenshot hashes](operator-console-browser-20261024.json) label the synthetic boundary. Local screenshots/results are in `/data/praetorium-console-verification/browser`; CI runs the same browser command and uploads a synthetic evidence artifact with seven-day retention. Full local logs are under `/data/praetorium-console-verification`. The authoritative final HEAD/check-run links are included in the PR.

## Deployment and remaining production acceptance

**NOT_CHECKED:** production application of migration 0008, activated Control Plane/Gateway/Build Worker, real admin OAuth/browser readback of new diagnostics and a subsequent explicitly authorized source attempt. Production rollout requires separate owner approval through the existing regular deployment path. Preserve the current job and historical evidence; do not automatically retry it.

Migration 0008 is additive and must follow all existing migrations, including recovery 0007. Existing remote 0007 history remains a compatible preflight subset. New code must not run against a missing diagnostics table: return explicit metadata/schema unavailability and correct the regular deployment inputs. Keep existing credential-epoch rollback floors and immutable artifacts. A code rollback retains the additive table and existing failure history; do not drop it or rewrite migration receipts. Prefer the Control Plane migration/routes before Worker activation. During an overlap, `/diagnostics` 404 or transport failure is unavailable telemetry; it does not replace heartbeat or final-report fencing. If an old strict Control Plane rejects the optional failure diagnostic with 400, Worker retries once with identical worker/token/epoch/code and no diagnostic, returning `diagnosticRecorded: false`. It does not retry on authorization failure or lease conflict. The old Control Plane retains only the canonical failure code, so evidence remains not recorded. No deployment scripts changed.

**BLOCKED:** this job's real Source→OCI proof→Admission→Canary→Stable acceptance, pending successful authorized build/diagnostic capture and existing producer/registry/runtime gates. **NOT_CHECKED:** real hosted MCP/Wake, writer exclusion, quiesce, stop/resume and persistence. Passing unit/browser fixtures or CI does not resolve those gates. No merge, production deploy or Issue #31 closure is authorized by this PR.
