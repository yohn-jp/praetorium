# Operator Console and Mobile UX — Issue #26

Status: implementation contract for PR; production rollout is separate.
Authority: latest owner instruction (2026-10-21) > Issue #26 > existing Operator Admission, Gateway session and Platform lifecycle contracts. This supersedes the former Headlamp-only scope exclusion in ADMINISTRATION.md **only for the release console**, not Kubernetes/provider administration.

## Operator identity and deployment
- Register `admin.praetorium.yohn.jp` as an additional exact custom domain on the **existing Gateway Worker**, not a new API plane. Public, non-secret Wrangler config: `PRAETORIUM_ADMIN_ORIGIN=https://admin.praetorium.yohn.jp` and `PRAETORIUM_ADMIN_GITHUB_USER_IDS=213253858`. No mailbox-based privilege checks or hardcoded GitHub admin membership.
- Login uses the existing GitHub App OAuth callback at `praetorium.yohn.jp`. The admin host does not share session cookies with the primary Gateway origin. After verified Gateway session + admin-ID check, the Gateway issues a 60-second, one-use, hashed-key Durable Object handoff code via an auto-submitted cross-origin POST. Only the admin host can consume it, validates current session, then creates an independent Host-only/HttpOnly/Secure admin-origin session cookie and a CSRF cookie. Logout revokes only this admin-origin session.
- Operator requests validate admin-origin, current session and allowlist on **every** request. Form mutations require same-origin CSRF. No admin routes on the public Gateway host other than the session-authorized handoff entry, and no public Gateway routes exposed through the admin host.
- Gateway accesses Control Plane via the existing authenticated Worker service binding. Control Plane recognizes the registered Operator actor only when both the *existing* trusted Gateway service secret and exact configured Operator actor ID are presented; it reuses the canonical Operator Admission router and authorizes no new infrastructure API. Existing `RELEASE_OPERATOR_TOKEN` remains independently valid for machine operators, and never reaches a browser or the Gateway runtime.
- An unavailable optional release composition remains a 503 state, never a fake available release.

## Release UI
- Primary landing shows approved and candidate releases via a **bounded read-only list** of existing ReleaseAdmissionRepository candidates, with attached read-only workflow summaries from the current retry/status authority. No new DB or release-state writer.
- Manifest submission uses a bounded JSON textarea (the canonical immutable producer manifest, not an invented simplified form) and forwards to the existing `POST /v1/operator/releases`. Candidate admission does not imply stable promotion. Retry uses `POST /v1/operator/releases/:id/retry` with its actual CAS `expectedRevision` and idempotency key. Current version/Canary status/failure is displayed without optimistic success.
- Auditable outcomes come from the current Operator status/retry and Audit Events in the existing D1 authority; no independent "admin operations" table.
- In particular, registration does not bypass Registry verification, Sigstore provenance, BuildKit, Canary, health window, promotion or follower rollout.

## Portal UI
- Foundation `PORTAL_STYLES` uses the live Evidence Ledger forest green/ivory palette. Login remains an ordinary Gateway-authenticated GitHub OAuth page; no alternative login or exposed provider credentials.
- Mobile selection is explicit; server default remains Desktop. For a first visit lacking an explicit preference, render a *CSS-only* mobile/touch first-visit bottom sheet with Mobile/Keep Desktop choices. Each link uses the existing `ui` allowlist and persists the normal `praetorium_ui` Cookie; no UA sniffing or repeated prompts. The manual Desktop/Mobile control remains.
- Mobile detail is a task-first single-panel composition, selected by hash navigation (Overview, Configuration, Activity) with fixed bottom tabs. Never duplicate submit forms, hide active state to fake progress, auto-run a mutation, or suppress the existing dirty-form navigation warning. Desktop composition unchanged beyond foundation tokens.
- Strict CSP style hashes are recomputed from the **exact** assembled output for both modes.

## Verification
- Gateway/Control Plane tests for anonymous/nonadmin/expired origin access, one-use handoff, CSRF rejection, zero operator-token browser disclosure, canonical Operator Admission forwarding and read/status/retry effects.
- Existing portal mode tests extended for first-visit choices and persistence; CSS narrow screen and CSP hash tests, existing mobile and desktop e2e. 
- `pnpm check` on PR HEAD and production image/Ingress verification in existing CI. Real GitHub OAuth/Cloudflare custom-domain creation, stable release and Canary runtime are NOT_CHECKED until deployment.
- PR only: no merge, image publication, DNS apply, runtime administration or secret rotation.
