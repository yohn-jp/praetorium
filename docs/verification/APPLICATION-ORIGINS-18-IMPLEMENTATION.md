# Application origins — implementation and review handoff

Issue #18 / PR #19, 2026-10-19. This report supersedes the active blocker in
[the historical preflight](APPLICATION-ORIGINS-18-PREFLIGHT.md). The owner's
subsequent instruction permits invalidating old URLs/bookmarks, abandoning
old-origin IndexedDB without migration, and requiring application-cookie
reauthentication. It does not waive server-side unpublished-work protection,
GitHub authorization, or single-writer safety.

## Implemented path

Only the registered `scriptorium` application is admitted. Its stable binding
key is `(scriptorium, numeric GitHub repository_id)` and its public origin is
`https://<repository_id>.scriptorium.yohn.jp`. Owner/name changes do not change
the origin. Gateway entry is `/entry/scriptorium/<repository_id>`.

Legacy SQL `instance_id` foreign keys and the private operation/lifecycle
`instanceId` fields retain their **logical binding-key** meaning for compatible
history, namespace ownership and all-epoch writer census. They are not renamed
or reinterpreted as physical identities. The additive `application_bindings`
view exposes the logical `binding_id` separately from its observed physical
`instance_id`. Repository bindings record the registered `app_identity` with a
unique `(app_identity, repository_id)` index; other applications are rejected.

New physical IDs have an injective encoding
`run_<opaque-binding-ULID>_<monotonic-runtime-epoch>`. Their DNS labels are
`<lowercase-ULID>-<epoch>`, without `ins-`, under
`instances.praetorium.yohn.jp`. Allocation is deterministic for operation
retries, unique across replacement/rollback epochs, and independent of a user
session or repository name. Kubernetes Pod UIDs remain separate provider census
evidence. The existing lifecycle, rather than Pod readiness or DNS, admits a
replacement writer.

`legacy_runtime_epoch` records the source runtime at migration. The producer
assignment and control protocol retain its original identity and old audience
until it is safely retired. New assignments, runtime identity JWTs, browser
grants, mutation receipts and Git broker authority use the new physical ID.
The private runtime-binding metadata carries both identities explicitly.
An omitted migration marker is accepted as the legacy private wire shape;
new persistence projections always supply an explicit null or source epoch.

Gateway entry detects a still-current legacy runtime and requests a fenced
redeploy instead of issuing it a new-origin Handoff. Existing failed runtimes
require an explicit dashboard retry. The lifecycle retains artifact admission,
quiesce, server-work checks, credential retirement, all-epoch writer absence,
readiness/authentication/persistence evidence, and rollback compatibility.
Credential-retirement SQL covers both source logical IDs and encoded physical
IDs. A compatible rollback receives another fresh physical ID and retains the
current public-origin policy while restoring the compatible prior artifact.

The Kubernetes namespace, ownership selectors and writer census remain scoped
to the durable binding. The projected producer Secret and Pod annotation carry
the physical identity. This keeps predecessor Pods in the same writer census;
changing namespace per physical ID would lose that safety scope.

## Routing, authentication and failure behavior

- Dynamic tenant routes match the original **public application Host**, at
  priority 10. Admission independently checks that this Host corresponds to the
  repository label of the owned tenant namespace. Requests retain their Host
  through Caddy and Traefik.
- Static public-app routes send `/_platform` to Instance Access at priority
  1000 and stopped/unmatched runtime routes at priority 1. Physical and legacy
  instance hosts are not accepted by Instance Access for browser sessions.
- Instance Access `instance-access/v2` sends the registered application and
  numeric repository identity to Gateway. Gateway resolves current authority;
  it does not trust Host or the CNAME as authorization. Arbitrary apps,
  host aliases, unsafe IDs, mismatched origins and unknown contract fields fail.
- One-time Handoff, access/refresh grants, JWT audiences, CSRF and CSP form action
  bind to the exact public origin. Cookies remain host-only, Secure and protected
  by their existing HttpOnly/SameSite rules. Handoff/refresh require a ready
  nonlegacy runtime and current GitHub access. A stale physical identity or epoch
  cannot be refreshed onto its replacement.
- Stopped navigation returns through the authenticated Gateway entry and its
  existing bounded wake/wait path. Non-navigation request bodies are not replayed.
  Ready-but-fallback returns 503 with explicit retry/dashboard links. Instance
  Access authentication and routing errors have bounded error pages with manual
  recovery; they do not automatically repeat Handoff.
- The browser proceeds to the application only after authenticated entry. No
  persistent browser connection state was added. Handoff, CNAME configuration,
  and Kubernetes Ready are not reported as a confirmed application response.

The Provisioner's event-driven DNS publisher runs inside the existing route
activation effect: it first activates and verifies the target Kubernetes route,
then publishes the individual CNAME to the physical hostname. It rechecks the
operation fence around effects and performs a single bounded configuration
readback. It refuses ambiguous/foreign records and sets `proxied=false`, TTL 60.
No idle DNS polling or stop-time record deletion was added. Publication failure
withdraws the ready route to the protected fallback; retries reconcile the same
record. DNS readback proves record configuration only.

Cloudflare's record API does not provide an atomic transaction with D1 or
Traefik. An interrupted/late provider request therefore remains a reconciliation
case, not a completion receipt. All physical targets must continue resolving to
the same managed public ingress during TTL/late-response overlap; routing and
authorization use the public Host and current physical identity. A stale DNS
answer cannot select an old tenant writer. Explicit retry reconciles the record
after a failed operation; this implementation does not add continuous polling.

## Migration and separately authorized deployment prerequisites

No migration or infrastructure deployment was executed by this task.

1. Arrange a maintenance window and stop new operation admission. Drain pending,
   claimed and running operations, including canary/rollout work. Back up D1 and
   retain the admitted source artifacts and recovery evidence. Migration 0006
   refuses a database with active operations; do not bypass that guard.
2. Apply migrations through `0006_application_origins.sql` under separate
   deployment authorization. It adds metadata/index/view only, retaining all
   logical rows, revisions, operation history and repository content. It records
   observed source epochs. Browser data is not read, exported, copied or deleted
   by this migration; old-origin recovery is intentionally not a prerequisite.
3. Upgrade Gateway, Control Plane, Provisioner, Instance Access, tenant admission
   and fallback configuration together. The v2 Instance Access contract is not
   compatible with an old Gateway/Instance Access pair. Old browser cookies and
   old MCP grants are not migrated onto the new origin.
4. Supply operator-owned Secret `praetorium-application-dns` in
   `praetorium-system` with keys `zone-id` and `token`. The token needs DNS record
   edit access for the `yohn.jp` zone. It is mounted only into Provisioner,
   separately from runtime and Git credentials. Existing deployment scripts do
   not create this new operator Secret. Provisioner fails startup without it;
   no legacy-runtime retirement is permitted without a DNS publisher.
5. Review/apply `infrastructure/caddy/application-origins.Caddyfile` to the
   owner-managed public Caddy, with its Cloudflare DNS module and separately
   supplied DNS-01 credential. Set `PRAETORIUM_TRAEFIK_ENDPOINT` and
   `PRAETORIUM_CADDY_DNS_TOKEN` in that deployment. The configuration preserves
   the public HTTP Host and verifies the upstream certificate using the existing
   `instances.praetorium.yohn.jp` SAN; it does not disable verification. Confirm
   issuance/renewal for `*.scriptorium.yohn.jp`. The Kubernetes certificate
   template now includes this wildcard and the DNS-01 zone selector is `yohn.jp`.
6. Ensure every physical `<id>.instances.praetorium.yohn.jp` target resolves to
   that ingress, including old cached CNAME targets throughout changeover.
   Existing physical wildcard infrastructure is a prerequisite, not created by
   the application-record publisher. Existing foreign app records require an
   operator ownership decision; the publisher refuses to adopt them silently.
7. Reopen admission and enter/redeploy each existing application through the
   normal lifecycle. Unpublished server work or uncertain durability still
   blocks retirement. Confirm public routing, authentication and application
   responses before considering the cutover accepted. Do not roll back metadata
   to old identity semantics while a new writer is present.

## Verification evidence and limits

Local environment: Node `v24.21.0`, pnpm `11.18.0`, isolated branch worktree.
A temporary Corepack shim directory leads PATH so nested scripts use the pinned
pnpm instead of the machine's ambient version. The new DNS adapter declares its
existing pinned Zod dependency explicitly; the lockfile changes only that importer.

- Frozen dependency installation: PASS.
- Repository `check` (build, lint, typecheck, tests, boundaries, schema drift):
  PASS. Final command exits and current-head CI are recorded in the PR summary.
- Focused regressions cover identity/host validation, real SQLite migration and
  source-history preservation, active-operation migration refusal, DNS ownership,
  publication fencing/idempotency/provider failure, physical producer projection
  with the original writer census, and Gateway-to-Instance-Access Handoff with
  physical claims, host-only cookies and replay rejection. Desktop/mobile user
  agent fixtures exercise the same HTTP path; they are not real browser evidence.
- Local workerd/Miniflare verification of production Worker modules, D1 and
  persistent Durable Objects: PASS, 2 tests. This is local component integration.
- Deployment reproducibility/Headlamp checks: PASS, 12 tests.
- Static admission/network/Traefik checks: PASS, 10 tests; 1 full render proof
  SKIPPED because standalone Kustomize is unavailable locally. CI's disposable
  Kubernetes admission check is a separate gate.

| Integrated acceptance gate | Result |
| --- | --- |
| Real GitHub login and current repository permissions | NOT_CHECKED with real task-owned users/repositories. Unit and component authorization regressions passed. |
| D1 migration and application binding | Local SQLite migration tests and local Worker/D1/DO checks passed. Production migration/provisioning NOT_CHECKED. |
| Public app CNAME → TLS/SNI → Traefik → Scriptorium | BLOCKED: deployment authorization, DNS Secret, public Caddy/TLS configuration, admitted image and explicitly owned disposable inputs are required. No production changes or public connectivity claim. |
| Handoff and authenticated application entry | Local Gateway/Instance Access integration passed. Real hosted application response NOT_CHECKED. |
| Stopped direct URL and bounded wake | Regression fixtures passed. Real hosted stopped-origin wake NOT_CHECKED. |
| Runtime replacement, unpublished server work and writer absence | Existing lifecycle regressions passed; physical identity, credential and provider regressions added. Real replacement/recovery BLOCKED on the owned integration environment. |
| Invalid Host, stale grants, unauthorized repositories and routing failure | Local regression coverage passed. External DNS/TLS failure acceptance NOT_CHECKED. |
| Desktop and mobile browser navigation | BLOCKED for real-browser hosted acceptance; request fixtures do not certify browser connectivity. |

No production DNS, Cloudflare configuration, Caddy, K3s, secrets or running
instances were modified, no image/release was published, and no PR was merged.
Scriptorium and Arcadia source were not edited. Main was not modified. The PR
records exact implementation commits and the actual current-head CI state.
Implementation review readiness is separate from production deployment and
end-to-end certification.
