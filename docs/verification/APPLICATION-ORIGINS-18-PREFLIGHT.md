# Application origins implementation preflight — Issue #18 / PR #19

Status: **BLOCKED before implementation**, 2026-10-19. This is a dependency
report, not implementation or deployment evidence. The approved architecture in
[APPLICATION-ORIGINS.md](../architecture/APPLICATION-ORIGINS.md) remains the target.

Praetorium inspected at `8c7152891339ea71cb4610d5ddd5a7dbeccb3b53`.
Remote main refreshed at `cc726923816e89dc106fae33a71c415b410cdd4b`.
The implementation branch retains both original documentation commits,
`6006baf197450e6eba5958ea81d9c0712ce7727a` and `8c71528`.
Work was isolated in `/home/sophia/src/praetorium-origin-18`; main was not edited.

## Blocking dependency: recovery across the origin change

The source and target origins differ:

```text
https://ins-<legacy-logical-id>.instances.praetorium.yohn.jp
  -> https://<repository_id>.scriptorium.yohn.jp
```

Browser IndexedDB is scoped to the origin. Preserving D1 rows, the repository,
or server-side quiesce receipts does not move unpublished browser records to the
new origin. A redirect, CNAME, new TLS certificate, successful Handoff, or fresh
runtime epoch cannot prove those records have been recovered. Offline browsers
cannot be inventoried by a server-side migration.

Read-only inspection of Scriptorium local HEAD and remote main found both at
`3189a85bfa28ddd160600a0188ab3ccfa91755e4`. No Scriptorium files were changed.
The following are source findings, not a claim about a deployed producer image:

- [BrowserJournal](https://github.com/yohn-jp/scriptorium/blob/3189a85bfa28ddd160600a0188ab3ccfa91755e4/app/src/storage/journal.ts#L12)
  uses database `scriptorium-recovery`, version 3, with `operations`, `scratch`,
  `proposals`, and `publicationReceipts` stores. Entries include author and
  repository scope, operation payloads and generations, checkpoint/publication
  state, and receipts. Copying only editor text would omit recovery semantics.
- [The journal open path](https://github.com/yohn-jp/scriptorium/blob/3189a85bfa28ddd160600a0188ab3ccfa91755e4/app/src/storage/journal.ts#L173)
  opens the current origin's IndexedDB. No supported export/import or transfer
  contract for these four stores was found in the inspected application source.
- [The existing export](https://github.com/yohn-jp/scriptorium/blob/3189a85bfa28ddd160600a0188ab3ccfa91755e4/app/src/application/SharedApplication.tsx#L1872)
  serializes `legacyDrafts`; it is not an export of the current four-store journal.
  The current [RecoveryList](https://github.com/yohn-jp/scriptorium/blob/3189a85bfa28ddd160600a0188ab3ccfa91755e4/app/src/application/SharedApplication.tsx#L2217)
  displays journal metadata without providing that transfer.
- [Hosted authentication](https://github.com/yohn-jp/scriptorium/blob/3189a85bfa28ddd160600a0188ab3ccfa91755e4/packages/api/src/hosted-policy.ts#L350)
  binds grants to the runtime assignment. Supporting recovery at the old origin
  alongside the new application origin therefore needs an explicit integration
  contract; forwarding a new-origin credential to the old origin is not a fix.

Completion needs a producer-supported way to recover current browser records
across this origin change, or an owner-approved migration procedure that keeps
old-origin recovery usable until its work is confirmed recovered. That procedure
must account for returning/offline browsers and authenticated recovery without
creating overlapping writers or sharing new-origin cookies/grants. The exact
mechanism is not chosen by this report. A producer interface must also be tied
to an admitted immutable artifact before live acceptance.

This is an implementation dependency, separate from permission to deploy DNS or
TLS. The current task excludes routine writes to the separately coordinated
Scriptorium source. Adding an unversioned copy of its private journal format to
Praetorium would create a new producer contract without producer ownership. No
such adapter, blanket migration acknowledgement, or data deletion was added.

## Existing interfaces and lifecycle seams inspected

| Boundary | Existing contract and required integration |
| --- | --- |
| Identity and persistence | `packages/contracts/src/repository.ts` and migration `0001_repository_platform.sql` bind numeric repository ID to a durable logical `ins_<ULID>` ID. Operations, revisions, reservations, configuration stages, rollouts and health observations refer to it. Preserve those historical references as logical binding identity; do not reinterpret them as physical runtime IDs. |
| Runtime authority | `apps/control-plane/src/runtime-binding.ts` resolves an observed writer or a post-absence target from reservation, epoch, live operation lease, durable checkpoints and credential-retirement predicates. The reservation ID currently supplies `runtimeId`; this is distinct from a future physical `instance_id`. |
| Runtime assignment | `apps/control-plane/src/runtime-context.ts` currently projects the logical ID into the producer assignment and derives its physical-style hostname and grant audience. Current and target assignments, control tokens, runtime identity and auth probes must migrate consistently. |
| Gateway | `apps/gateway/src/services/portal-service.ts` rechecks current repository access before Handoff; `router.ts` validates exact origin/host, consumes the one-time code, refreshes credentials, and bounds direct-entry waiting. All origin derivation and access validation must use the same canonical application binding. |
| Instance Access | `apps/instance-access/src/handler.ts` currently reconstructs a logical ID from an `ins-` hostname, sets host-only cookies and uses origin-bound CSRF. It redirects fallback navigation to Gateway with a routing-failure hint; it does not replay request bodies. Public host parsing must resolve the canonical binding rather than treat Host as authority. |
| Kubernetes renderer | `plugins/kubernetes/src/kubernetes/renderer.ts` requires producer assignment identity to equal provider identity, uses logical-ID namespaces/selectors for ownership, and renders one Host route at priority 10. Writer census spans all epochs of that logical identity. Changing just the ID or hostname would break these contracts. |
| Admission | `infrastructure/kubernetes/policies/provisioner-ingressroute.yaml` independently enforces the old `ins-` Host expression and exact tenant ownership. Updating the renderer alone would be denied; policy, renderer, fallback and fixtures must change together. |
| Fallback and TLS | `infrastructure/kubernetes/base/stopped-instance-fallback.yaml` sends `/_platform` to Instance Access at priority 1000 and unmatched instance hosts at priority 1. The deployment certificate template covers only the configured instance suffix. Both need the registered public app namespace. |
| DNS and public edge | No per-application CNAME lifecycle provider was found in the inspected runtime wiring. The existing cert-manager Cloudflare token reference is for DNS-01, not an application-record ownership API. Public Caddy configuration is owner-managed; historical ingress evidence covers only the old instance namespace. Application CNAME ownership, conditional updates, failure compensation, and public SNI/Host acceptance remain work. |
| Provisioner | `apps/provisioner/src/lifecycle-executor.ts`, `lifecycle-journal.ts`, `kubernetes-lifecycle-adapter.ts`, `runtime-identity.ts` and `scriptorium-control-client.ts` jointly bind claimed operations, projected assignments, control credentials, provider ownership and producer responses. Physical runtime identity must remain associated with its logical writer-census scope. |

The lifecycle in `packages/application/src/lifecycle/service.ts` resolves the
admitted build and capacity before retiring the current writer. It obtains fresh
producer state and quiesce evidence, checkpoints transitions, stops the writer,
proves absence, starts the target, verifies readiness/auth/persistence evidence,
and activates its route. Control Plane runtime-binding authority additionally
checks credential retirement. Recovery and compatible rollback use durable
evidence and fresh epochs. DNS publication must be integrated after target route
activation; DNS lookup or Kubernetes Ready cannot establish browser connectivity.

Browser connection states remain transient. The existing ready-but-fallback
entry branch returns 503 with manual retry, and stopped entry has bounded browser
refreshes. These mechanisms must be retained when changing entry identifiers.

## Verification and acceptance gates

No application code, schema, manifests, tests, production DNS, Cloudflare,
Caddy, K3s, secrets, or running instances were modified by this preflight.
No focused regression tests were added because implementation stopped at the
cross-repository recovery dependency. Local checks below assess the unchanged
implementation baseline only.

Local environment: Node `v24.21.0`, pnpm `11.18.0`.

- `corepack pnpm@11.18.0 install --frozen-lockfile`: **PASS**, exit 0.
- Initial `corepack pnpm@11.18.0 check`: **FAIL**, exit 1 before build. Nested
  scripts resolved the ambient pnpm `12.10.1`, causing `ERR_PNPM_BAD_PM_VERSION`.
  A temporary Corepack shim directory was placed first in PATH for the rerun;
  repository package-manager settings were not modified.
- Pinned-PATH rerun of `corepack pnpm@11.18.0 check`: **PASS**, exit 0. Build,
  lint, typecheck and tests passed, followed by provider-boundary verification
  and contract schema drift verification. This is baseline evidence only.

| Requested integrated gate | Actual result |
| --- | --- |
| GitHub login and repository authorization | NOT_CHECKED with real users/repositories for this task. |
| Application binding and initial provisioning | BLOCKED: target binding/identity model is not implemented. |
| Public URL, CNAME, TLS, Traefik, Scriptorium | BLOCKED: target routing is not implemented; external deployment and owned disposable inputs also required. |
| One-time Handoff and authenticated public app entry | NOT_CHECKED on the target origin. Baseline tests cannot certify it. |
| Stopped direct URL and bounded wake | NOT_CHECKED on the target origin. |
| Runtime replacement and writer safety | BLOCKED for origin migration by the recovery dependency above; no live replacement attempted. |
| Invalid Host, stale grants, unauthorized repositories, route failures | NOT_CHECKED for changed contracts because no implementation was made. |
| Desktop and mobile navigation | BLOCKED for final target acceptance; no owned disposable browser/repository environment was supplied or modified. |

Before this report, PR #19 at `8c71528` had successful GitHub Actions `verify`,
three candidate image builds and `kubernetes-admission`; publication was skipped.
The Cloudflare checks `Workers Builds: praetorium-control-plane` and
`Workers Builds: praetorium-gateway` were both **FAILURE**. Their causes were not
established by this inspection. Checks for the report commit must be read from
the live PR; earlier check results do not apply to a new HEAD.

Implementation completion, production deployment, and end-to-end certification
are all **not achieved**. PR #19 is blocked, not ready for implementation
acceptance. Stop here pending resolution of the recovery seam; do not merge or
deploy this branch.
