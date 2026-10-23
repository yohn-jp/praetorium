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

Results will be finalized on the integrated PR HEAD. Local fixtures establish implementation behavior only; they do not certify hosted producer, registry or browser acceptance.

## Deployment and remaining production acceptance

**NOT_CHECKED:** production application of migration 0008, activated Control Plane/Gateway/Build Worker, real admin OAuth/browser readback of new diagnostics and a subsequent explicitly authorized source attempt. Production rollout requires separate owner approval through the existing regular deployment path. Preserve the current job and historical evidence; do not automatically retry it.

Migration 0008 is additive and must follow all existing migrations, including recovery 0007. Existing remote 0007 history remains a compatible preflight subset. New code must not run against a missing diagnostics table: return explicit metadata/schema unavailability and correct the regular deployment inputs. Keep existing credential-epoch rollback floors and immutable artifacts. A code rollback retains the additive table and existing failure history; do not drop it or rewrite migration receipts. Prefer the Control Plane migration/routes before Worker activation. During an overlap, `/diagnostics` 404 or transport failure is unavailable telemetry; it does not replace heartbeat or final-report fencing. If an old strict Control Plane rejects the optional failure diagnostic with 400, Worker retries once with identical worker/token/epoch/code and no diagnostic, returning `diagnosticRecorded: false`. It does not retry on authorization failure or lease conflict. The old Control Plane retains only the canonical failure code, so evidence remains not recorded. No deployment scripts changed.

**BLOCKED:** this job's real Source→OCI proof→Admission→Canary→Stable acceptance, pending successful authorized build/diagnostic capture and existing producer/registry/runtime gates. **NOT_CHECKED:** real hosted MCP/Wake, writer exclusion, quiesce, stop/resume and persistence. Passing unit/browser fixtures or CI does not resolve those gates. No merge, production deploy or Issue #31 closure is authorized by this PR.
