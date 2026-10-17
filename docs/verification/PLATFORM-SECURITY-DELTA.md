# Composed infrastructure and local verification checkpoint

Source cut: clean main `b3fbe6dcfb586b8f6aa28f5e06fa71ae89733061`, pushed to
origin/main. This record supplements the historical `27142b0` broader checkpoint;
it does not replace missing product acceptance.

The base Kustomization now includes static minimal Provisioner RBAC, seven
ValidatingAdmissionPolicies and seven Deny bindings, and system NetworkPolicies.
Tenant namespace ownership/PSA, RoleBinding scope, emitted resource ownership,
Pod restrictions, exact network rules and exact route shape are composed. API,
private Control Plane and private Gateway egress require explicit validated
inventory endpoints. No credentials, image digests or owner origins are inferred.

The production apply command renders the canonical bundle once, requires v1
admission discovery, performs a full strict server dry-run, applies only the
14 guards, waits for current-generation type-check status and the exact binding
scope, then applies the full bundle including bootstrap RBAC. Kubernetes' neutral
server defaults are accepted without allowing restrictive selector/scope changes.
Kind create/apply require v0.31.0, with a digest-pinned Kubernetes 1.35.0 image;
preflight reports this pair. Render is local and independent of Kind.

Traefik now watches per-instance namespaces with cluster-scoped CRD RBAC, while
cross-namespace and ExternalName references remain disabled. Renderer, provider
pre/post-write checks and the route VAP require priority 10. The reserved platform
route has 1000 and stopped-instance fallback 1, resolving the previous priority
tie. Tests compile the committed renderer source rather than stale dist output.

Root fresh verification at this cut:

- Required frozen install and `check`: passed; test stage 29/29 Turbo tasks,
  29 cached. Build/lint/typecheck, provider boundaries and generated schemas passed.
- `node --test tests/infra/*.test.mjs` with cached Kustomize: 47 passed,
  zero failures/skips. Includes actual local canonical render and failure-order
  regressions. Logs: `/tmp/praetorium-defaulted-infra.log` and
  `/tmp/praetorium-b3fbe6d-{install,check}.log`.
- Fixed T14 harness with newly owned expiring local inventory:
  Worker/D1/DO VERIFIED; six other categories BLOCKED/NOT_CHECKED, errors `[]`,
  aggregate exit 2. Report generated `2026-10-17T01:37:09.461Z` at
  `/tmp/praetorium-b3fbe6d-acceptance.json`. Only local temporary Miniflare state
  was created and cleaned; migrations 0001–0004 were exercised.
- Actual local D1/Restic restore: 1 passed, 11217.63 ms test / 11285.77 ms
  process, synthetic metadata only. Log `/tmp/praetorium-b3fbe6d-restore.log`.

Separate read-only reviewers traced the composed production path. The apply
sequence/Kind guard review at `ee33c38` found no bypass; its focused checks passed
22/22. The composed route review at `b3fbe6d` found the priority tie resolved,
with fresh infra 8/8 and Kubernetes package 34/34. The server-default compatibility
review at `b3fbe6d` found no weakening; its broader cached-tool infra run passed
53/53. These scopes differ from root's 47-test invocation and are not summed.

No live Kubernetes discovery, dry-run, policy status, admission denial, rollout,
Traefik traffic, CNI packet enforcement, producer composition or production apply
was executed. Status/type-checking does not prove the admission plugin enforces
requests, and CRD expressions are not completely type-checked by Kubernetes.
The pinned kindnet controller is fail-open; packet probes remain mandatory.
T12/T14/T15 full acceptance remains blocked on the explicit owned environments,
producer contracts/artifacts and remaining runner implementations.
