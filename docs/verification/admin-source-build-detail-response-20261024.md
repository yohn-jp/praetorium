# Source Build detail and execution recovery — 2026-10-24

Target job: `sr_730c616f-329c-4d2f-aabb-d143eaa2db01`.
Deployed source: main `1930131e6858e5d9035abe1dcd82d4ae654c622d` (PR #41).

## Result

The explicitly authorized retry of the same immutable v0.3.4 source succeeded:
job state **admitted**, revision 2, attempt 1, lease epoch 3, error null,
admitted Release `rel_ab7dfafe-3f59-4f55-b2c2-6100b2a5d585`.
The attempt is **produced**, with stage verification, reason completed,
evidence available and summary `Execution stage completed.` Epochs 1 and 2
remain failed / unknown / not_recorded; their missing evidence was not invented.
This is real hosted Source execution and admission, not a fixture result.
Canary, Stable, tenant lifecycle and full product acceptance are outside this
verification; admitted must not be described as Stable.

## Causes

1. **Detail response deployment mismatch:** Gateway
   `360917d9-996d-4d73-8025-d29ce65291fb` required strict
   `SourceBuildDetailSchema`, but Control Plane
   `1b1b8265-fff2-4a4f-892d-c84c6032e4c1` still returned only `{ job }`.
   D1 also lacked migration 0008 and its attempt table. Missing fields fail at
   `["attempts"]`, `["nextCursor"]`, `["evidence"]`. The old response structure
   was reconstructed from the downloaded deployed handler and a live D1 row;
   an authenticated HTTP 200 response was not captured before correction.
2. **Missing diagnostics capture:** the running Build Worker image
   `sha256:bfb4eec09b48e5bff065659959b7cbe6ff063bd08668318b3d61bf83b2109c81`
   contained no stage/diagnostic reporting support. Its retained stdout was empty.
   D1/Admin evidence was absent, but this did not mean all execution logs were lost.
3. **Actual build failure:** retained BuildKit records for immutable revision
   `588eddcfff20fa2fc76aa8eae54c9551e0c6048b` show Go frontend compilation
   failing while fetching Go modules from proxy.golang.org with 502 Bad Gateway.
   Builder Squid logs at the matching execution timestamps show CONNECT requests
   denied with TCP_DENIED/403. The dependency hosts were absent from its allowlist.
   Retained logs were read; no lost logs were restored or backfilled into D1.

Read-only SSH used the existing Management, Runtime and Builder host settings.
All raw responses/logs and credentials remain outside Git; private evidence is
under `/tmp/praetorium-admin-detail-evidence`.

## Applied correction

Main already contains the correct API and diagnostic implementation. No runtime
source changes or schema relaxation were needed.

- Applied canonical additive `0008_source_build_diagnostics.sql` with the existing
  `deploy-cloudflare.mjs --migrate`, then verified exact migration history.
- Reused the existing guarded Squid update procedure: baseline/candidate hashes,
  candidate parse, backup, reload and active-state checks. Only the approved_inputs
  dstdomain line changed, adding exact hosts proxy.golang.org, sum.golang.org and
  storage.googleapis.com (module archive redirects). Existing client/port/private
  destination restrictions remain. Baseline hash:
  `a474862834b715ee468bf9de6caad9e6b629d71aaddc04bb8c8e9416450c8688`;
  resulting hash:
  `3a352073be0ac0a184b9ca8419af41f4a95d9ff6829ebab916522487de52d3e4`.
  The failing module's .mod, .zip including redirects, and checksum lookup all
  returned HTTP 200 through the proxy after correction; CONNECT previously failed.
- After the owner's explicit authorization of re-execution and production rollout,
  existing `deploy-platform.mjs --check` and `--apply` completed using the owned
  inventory, secret references, kubeconfig, Management inventory and existing mTLS
  Builder through SSH tunnels. Canonical publication verified source/CI and all
  image digests before inventory admission and rollout. New Build Worker:
  `ghcr.io/yohn-jp/praetorium/build-worker@sha256:d741a57884cbc1e2fdc08c5f65977f0ac5d6f02f312f824fb34f7f3fc027036d`.
  Its live compiled modules now contain stage/error/diagnostic reporting.
- Updated the Gateway→Control Plane internal credential in both Workers through
  secret files and tracked Wrangler configs under the owner's expanded authority.
  The value is privately managed outside Git and was never printed. Control Plane:
  `64e5a313-2dd2-4e6d-9081-eaa3743f6f64`; Gateway:
  `5f17f485-4429-46b7-927e-ca7f83d357e0`.
- Revalidated published GitHub Release 422035682 / v0.3.4 and exact tag SHA before
  retry. Authenticated GitHub principal 213253858 matches the configured operator.
  The existing authenticated retry API used expectedRevision 1 and a fresh
  persisted idempotency key; HTTP 202, duplicate false, same job ID, revision 2.
  No manual D1 repair, signature bypass or historical evidence backfill was used.

The real retry passed the previously failing praetorium-buildkit target (all 20
steps completed, no error), metadata production, artifact verification and
admission. Diagnostic snapshots progressed through buildkit and metadata to
verification/completed, while preserving older not_recorded attempts.

## Verification

- Node 24.21.0; `corepack pnpm@11.18.0 install --frozen-lockfile`: PASS, no lock drift.
- `corepack pnpm@11.18.0 check`: PASS for main and the final captured-response
  regression, covering build/lint/types/tests/provider boundaries/schema parity.
  Existing Corepack shims resolve the machine's nested pnpm dispatch mismatch.
- Deployed main [CI 39978156500](https://github.com/yohn-jp/praetorium/actions/runs/39978156500):
  all seven verification jobs passed for the exact deployed source.
- Management/K3s rollout: PASS. Notification endpoints: HTTPS 202. Cloudflare
  health/login/JWKS checks: PASS. These checks alone are not hosted acceptance.
- Actual authenticated detail GET: HTTP 200 and SourceBuildDetailSchema.safeParse
  success, zero issues, both before and after the authorized retry.
- Committed production fixture is the actual sanitized terminal detail DTO,
  captured after admission, without credentials or unbounded log content.
  Regression round-trips it through migrated local SQLite and the operator route,
  checks strict schema validation, and pages new available evidence separately
  from both historical not_recorded attempts. The legacy-shape regression still
  rejects all three missing fields. Local tests are not production certification.
- Owner browser readback confirms that the same job detail opens, its timeline
  section is visible, reload retains the same job, and the new attempt shows
  Produced. Explicit readback of the new completed diagnostic text and the two
  historical not_recorded entries remains pending; the API evidence is confirmed.

No PR merge was performed. This PR carries regression coverage and the operational
record; its runtime correction was already present on main and is now deployed.
