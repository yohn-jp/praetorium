# Praetorium — Repository-scoped application platform

> **Historical design reference, not the current product authority.** Begin with [SYSTEM.md](SYSTEM.md) for verified actor responsibilities, [EXECUTION.md](EXECUTION.md) for actual trigger/traffic paths, and [REVIEW.md](REVIEW.md) for deviations. The original [Epic #1](https://github.com/yohn-jp/praetorium/issues/1) and later explicit owner decisions define the product; historical implementation choices in this file must be re-evaluated. CI is now allowed by the owner.

Status: execution design for Epic #1, based on the owner's agreed product decisions. This document specifies the target; it does not certify current code, a producer artifact or a live deployment.

Companions: [producer contract](SCRIPTORIUM-CONTRACT.md), [implementation plan](../migration/PLAN.md), [coverage ledger](../migration/COVERAGE.json), [Sol dispatch](../migration/SOL-GOAL.md).

## 1. Product and scope

Praetorium authenticates a GitHub user, authorizes access to a repository, resolves that repository's logical Scriptorium instance, starts it when necessary, and connects the user to its stable HTTPS origin. Its management UI selects the approved application release and add-ons, requests a composition build, and deploys or redeploys the resulting immutable artifact.

This is a complete migration/refactoring campaign, not another minimal scaffold. Reuse Arcadia Platform's real identity, release, reconciliation, runtime and infrastructure assets. Extract its provider-specific code into explicit packages. Do not copy the old monolith, entire Git history, private operational values or an unbounded roadmap.

The accepted changes supersede the source's per-user instance ownership, mandatory retained application PVC and prohibition on application composition builds. They do not remove authentication, single-writer safety, immutable release admission or explicit production authorization.

Non-goals: generic customer Dockerfiles, arbitrary package installation, plugin marketplace, new authoring/NLP features, billing, HA/multi-cluster expansion and production cutover without separate authorization.

## 2. Authorities and identity

| State | Authority |
| --- | --- |
| User identity and repository access | GitHub App user authorization and current GitHub repository permissions |
| Canonical work and confirmed commits | GitHub work repository |
| Provisional author changes | Scriptorium's browser recovery and checkpoint contract |
| Repository binding, instance configuration, builds, operations, observations | Praetorium Control Plane/D1 |
| Login sessions, handoff codes and refresh credentials | Gateway auth storage; no second session database |
| Static host/cluster configuration | Nix/Flux plus deployment inventory |
| Dynamic namespace/workload/route/Secret and temporary workspace | Runtime provider under Provisioner |
| Trusted recipe, module catalog and application behavior | Scriptorium producer |
| Verified derived image | OCI registry artifact addressed by digest |

For the initial github.com service, `repository_id -> instance_id` is unique. Repository ID is the durable key; owner/name and installation ID are revalidated locators. Users are access principals, not a partition of the instance key. The database retains who requested an operation for audit, not a competing access-control list.

Concurrent first access resolves or creates the same binding atomically. A transfer, installation removal/suspension or installation change cannot reuse stale repository credentials. Suspend new grants/operations until the current installation and access are revalidated. Never allocate a second writer to bypass a failed binding.

## 3. Authentication, authorization and credentials

Use one GitHub App with its user-authorization web flow; a separate OAuth App is not required. User access tokens and refresh tokens stay encrypted on the Platform side. Enumerate the user's accessible installations/repositories through the user-token APIs and intersect with the App's active installation and operator service policy.

A successful App installation is not user authorization. A public repository is not automatically a service-access grant. Initial roles: read permits entry/read; write permits checkpoint/proposal approval/publish; maintain/admin permits instance configuration, redeploy and removal. Operator release admission is separate from repository maintain permission. No independent invitations/ACL editor is introduced.

Revalidate permissions when entering/refreshing a grant and before durable mutation/configuration authorization. Polling and verified webhooks invalidate cached access. Read grants have a five-minute maximum lifetime; lost webhook delivery must not create indefinite access. Mutation authorization is a fresh Platform decision using the user's current GitHub access, not the stronger installation token. Errors/rate limits return a bounded unavailable result rather than silently retaining write permission. Do not claim instantaneous global revocation.

Preserve existing session, CSRF, PKCE, one-use code, key rotation, logout-all and MCP-credential primitives where compatible. Hosted application grants bind issuer, user, repository, instance, runtime epoch, permission set, session/authorization revision, issuance and expiry. Allowlisted signature algorithms and JWKS are validated by Scriptorium; request headers are not trusted identity.

The browser receives a one-use, 60-second handoff code and submits it to the exact instance origin's `/_platform/handoff` endpoint. Redeem through an authenticated Gateway service call; bind the code to the intended browser handoff, host and instance. The access service sets a Secure, HttpOnly, host-only cookie. No GitHub token or reusable application grant in query strings, fragments, local storage, form history or logs. Refresh/logout use the same origin and the canonical Gateway session authority. Cookie-based writes require CSRF protection; MCP Bearer follows the same application authorization, without silently overriding an ambiguous cookie.

Repository Git operations use App installation tokens restricted to that single repository and necessary Contents permission. The App key never leaves the trusted credential service. Provisioner establishes a runtime-bound service identity; credential renewal checks binding, installation, runtime epoch and active instance lease. Fetch can obtain read authority; publish additionally requires a current user mutation authorization. Never inject a permanent owner-wide token or permit a caller to choose an unrelated installation/repository.

Installation tokens are bearer capabilities, not branch locks. Stop issuing/revoke known tokens during retirement, but do not infer that an expired Platform lease proves the old process can no longer push. Prove old-writer termination before replacement.

Registry credentials are independent. Outside GitHub Actions, the GHCR adapter uses its supported operator-owned registry credential, not a GitHub App installation token assumed to support package publishing. Keep build push and runtime pull credentials separate; runtime cannot publish images. Treat token formats as opaque.

### Gateway browser authentication cache (Issue #57)

The opaque `__Host-praetorium_session` and UserAuthState DO remain the session authority. Ordinary portal reads can use `__Host-praetorium_session_cache`, a host-only `Secure; HttpOnly; SameSite=Lax; Path=/` cookie with no Domain attribute. The Gateway signs it with the existing active ES256 signing key and registry. Its versioned type, origin, session digest, user ID, session revision, issued-at, cache expiry and original session expiry are signed; raw session IDs, GitHub tokens and secrets are excluded. Its lifetime is at most 300 seconds and never exceeds the authoritative session expiry observed at issuance.

| Route / operation | Session resolution |
| --- | --- |
| `GET /`, `GET /repositories/:numericRepositoryId` (including bounded presentation/poll query parameters) | Verify cache signature, active key, origin, timestamps and binding to the unique opaque session cookie; valid hits perform zero DO `/sessions/get` calls |
| Missing, invalid, expired or substituted cache on those reads | Resolve through the existing DO path once, then issue a replacement after successful authentication |
| `GET /api/session` | Authoritative resolution and existing debounced 300-second activity touch/sliding expiry; cache reads do not replace or extend this behavior |
| Every POST, credential listing/creation/revocation, admin identity/entry, OAuth, direct entry/wake, handoff/refresh, GitHub writes and mutation authorization | Existing authoritative authentication and authorization paths; cache cannot supply a resolved session |
| Mixed Authorization/Cookie inputs | Cache disabled; existing Bearer/Cookie policies still apply |

The real call graph for eligible reads is Portal handler → `listRepositories` or `getRepository` → current GitHub access and Control Plane reads. Repository-detail authorization, installation matching and dashboard binding checks remain in place. Cached identity is never a repository permission or a Runtime Grant. The `/repositories/:id/actions` GET only redirects and does not authenticate; its POST uses the DO. New routes are ineligible unless explicitly classified.

Hits never renew the cache. Concurrent requests retain separate authentication results and response cookies. A cache or key-metadata verification failure falls back to the DO; cache issuance failure leaves a successful authoritative read available without a cache. DO failures keep the original unauthenticated/unavailable behavior on authoritative paths. Key rotation uses the existing bounded registry, without a new key store: only active keys verify browser caches; next, unknown, retired and compromised keys trigger authoritative resolution and replacement under the current active key. Existing KV registry location-cache/eventual-consistency limits still apply; sensitive operations do not depend on cache-key revocation.

Logout and logout-all use the authoritative session plus the existing Origin/CSRF checks, revoke the session(s), and clear the session, CSRF and cache cookies. A copied cache alone grants no access without its bound opaque session cookie. Theft of both cookies permits replay of eligible read identity until cache expiry (at most 300 seconds); revocation, session rotation or concurrency eviction cannot be observed by a valid cache sooner. Sensitive operations recognize authoritative revocation immediately. The signed session revision records the authoritative revision at issuance; it does not claim to revalidate that revision without the DO. GitHub permission revalidation, refresh synchronization, session concurrency, MCP Bearer and Runtime authentication contracts remain unchanged.

Local measurement uses the real Gateway DO client with disposable in-memory RPC backing, not production traffic: the representative sequence `/`, repository detail, detail poll, `/`, mobile detail performs **5** `/sessions/get` calls through the original authoritative resolver, **1** with a cold cache (the first read), and **0** with a warm cache. Ten concurrent warm reads also perform **0** calls. These counts concern session reads only; GitHub authorization/token-vault and Control Plane access remain. Reproduce with `corepack pnpm@11.18.0 --filter @praetorium/gateway exec vitest run test/session-cache.test.ts`. Hosted DO, real browser/OAuth, producer and registry acceptance are **NOT_CHECKED** by this fixture.

## 4. Topology and routing

```text
Browser / MCP client -> Gateway (GitHub login, access, repository/instance resolution)
                     -> Control Plane (configuration, desired state, build/operation catalog)

Build worker -> claim approved composition -> isolated BuildKit -> verified OCI artifact
Provisioner  -> claim runtime operation -> Kubernetes provider -> Scriptorium runtime

Browser -> stable instance HTTPS origin -> cluster ingress
  ready:       normal UI/API/MCP directly to Scriptorium
  unavailable: Platform Instance Access waiting/maintenance/wake handler
  /_platform/* always to Platform Instance Access
```

Normal manuscript bodies/streams do not traverse Workers or a generic Platform content proxy. Only authenticated control metadata crosses those boundaries.

Direct bookmarks must wake a stopped instance too; login through the portal is not the sole entry path. The stable ingress has an always-present Platform fallback when no ready application backend exists. HTML navigation receives login/start/wait/error UX. API/MCP callers receive a bounded `INSTANCE_STARTING`/maintenance error and Retry-After; the Platform does not buffer or automatically replay writes. Preserve the stable origin across builds/restarts so browser recovery remains reachable.

Wake, polling and grants require access checks and rate limits. A guessed instance host, health probe or bot must not indefinitely start/keep alive workloads. UI presence, real authenticated API/MCP activity and active application jobs feed activity state; monitoring probes do not.

## 5. Language and package boundaries

Keep the source's TypeScript/Node 24, pnpm/Turbo, Vitest and Hono foundations. Keep Workers/D1/Durable Objects, a Node Provisioner, NixOS/K3s/Flux and native BuildKit. A rewrite in Go/Rust/Python is not justified by an inspected bottleneck or required integration. BuildKit itself supplies the native build engine; do not reimplement it.

Retain the source Node 24 / pnpm 11.18.0 baseline unless a reproducible incompatibility requires a coherent pin change. Scriptorium's build kit supplies its own toolchain/lockfile; do not force the producer to share Praetorium's pnpm version. No indiscriminate dependency upgrade.

The management portal remains server-rendered TypeScript with small browser components in `apps/gateway/src/ui`; extract the existing home page rather than add a second SPA framework solely for forms and progress. JSON and UI operations call the same application services.

```text
apps/gateway/             login, repository list, configuration UI, grant authority
apps/control-plane/       HTTP/Worker adapters and scheduling entry points
apps/instance-access/     same-origin handoff, refresh, maintenance and wake
apps/provisioner/         bounded runtime reconciliation worker
apps/build-worker/        bounded composition worker, no runtime credentials
packages/domain/         identities, state machines and invariants
packages/contracts/      versioned serialized schemas and neutral ports
packages/application/    repository/build/release/lifecycle services
packages/auth/           provider-neutral sessions, grants and cryptography
packages/persistence/    D1 repositories, migrations and durable coordination adapters
packages/config/         validated configuration and secret references
packages/observability/  bounded audit, logs, metrics and correlation
plugins/github/          GitHub App login, access, installation and credential adapter
plugins/ghcr/            OCI registry and immutable identity/provenance adapter
plugins/buildkit/        bounded BuildProvider implementation
plugins/kubernetes/      RuntimeProvider, rendering, observation and capacity
plugins/scriptorium/     producer metadata/build/runtime normalization only
plugins/legacy-recovery/ explicit legacy data-export/restore tooling, not default runtime
infrastructure/         sanitized Nix/Flux/inventory and disposable validation setup
```

Plugins are trusted, explicitly selected workspace packages implementing neutral ports. Application/domain code must not import a concrete provider. Composition roots choose providers statically; no arbitrary dynamic code loading. Cloudflare-only code remains in Worker adapters, Kubernetes objects in its provider. The deployment selects identity, registry, builder, runtime and application adapters through per-process composition roots. Each process loads only its required providers; a missing required provider fails startup instead of bypassing its security function. Legacy recovery is an optional tool dependency, absent from normal runtime/build-worker closures.

This Platform provider modularity is distinct from Scriptorium authoring add-ons. Praetorium stores selection and deployment intent; the producer owns add-on algorithms, initialization, dependencies, models and internal data.

## 6. Immutable composition and resources

There are three different artifacts: a Runtime Base, a Build Kit and a Composed Image. The Build Kit contains the approved recipe, exact product source/artifact inputs, module catalog and lock/toolchain information. It must produce both server and browser composition; appending `npm install` to a runtime image is not the build contract.

The UI selects an approved base release and requested modules. Resolve transitive requirements from the versioned producer catalog, validate compatibility and show requested versus included modules. Unsupported combinations fail before build. Module releases are pinned to producer-approved artifact digests; version text alone is insufficient.

`build_key = SHA256(canonical BuildInput)`, containing contract/schema version, runtime-base digest, build-kit/recipe digest, source/lock digests, sorted resolved module artifact identities, target OS/architecture and all output-affecting build options. Neither user/repository IDs nor secrets enter this input. The same immutable inputs share a build across repositories. If shared output could contain repository-specific information, reject the recipe rather than put that information in a shared cache.

Resource allocation is a separate deployment input unless it changes build output. Use a producer-declared validated resource profile for the resolved closure, including shared model pools and worker maxima; do not naively sum duplicate model budgets. Platform enforces operator limits and reserves CPU/memory/ephemeral disk for both builds and runtime. Unknown/stale capacity is not infinite capacity.

The Control Plane owns Build records and canonical artifact admission. A uniqueness/lease claim coalesces duplicate requests; leases have epochs and late reports cannot replace a newer attempt. The isolated build worker runs only approved recipes with bounded arguments, time, memory, disk, output and egress. No work repository checkout, Git token, App private key or runtime-cluster administration in build context, cache or output. No privileged host Docker socket in an application container.

Use a dedicated rootless BuildKit service on the build host with authenticated control transport and restricted secret mounts. Reuse sanitized source build-host provisioning where suitable, without installing a GitHub Actions runner. Validate the actual host's supported rootless/user-namespace configuration; do not weaken runtime Pod isolation to make builds work.

The Ubuntu build-host deployment uses the existing ext4 OS filesystem for `/var/lib/praetorium-buildkit`, with a BuildKit GC cache target and minimum free-space target plus systemd CPU/memory/task limits. GC and these process limits do not guarantee a hard disk-usage ceiling. A periodic free-space monitor must report pressure to operator alerting; running builds and other OS data can still fill the filesystem. The NixOS XFS deployment retains its own storage contract.

Build trust boundary: the service-owned Builder and version-pinned Producer/Recipe are trusted. Prevent unapproved user builds before execution: Control Plane accepts only approved Catalog selections and dependency closure; the Builder independently resolves the same fixed modules and rejects user-supplied packages, commands, Dockerfiles, repositories, URLs and arbitrary build arguments. After build, bind the OCI digest and selected platform, bounded Producer composition metadata, and operator Builder signature to persisted Build Input. Do not re-export/re-hash the complete rootfs, rescan installed packages and server/browser closure, or repeat Producer's pre-deploy startup smoke. Actual deployment Readiness/Canary is the runtime gate. Derived artifacts retain operator-configured key-backed Builder signatures and pinned public verification keys; no assumption of GitHub Actions keyless identity. Provision/rotate real signing keys only through separately authorized operations; disposable test keys remain test-only. A cache hit still needs valid admission, compatibility and retrievable content. Build cache GC cannot delete artifacts pinned by running, desired or rollback revisions; bounded retention/size is explicit.

A new configuration can take time to build. Keep the current application running until the replacement is admitted. The first use of a previously unbuilt configuration shows build progress before startup. Never promise a cache hit or zero-wait first launch.

## 7. Desired state, updates and single-writer lifecycle

D1 records RepositoryBinding, LogicalInstance, DeploymentRevision, Build, Artifact, Operation, RuntimeCluster/Reservation and AuditEvent. A DeploymentRevision binds repository, base release, selected/resolved modules, build key, admitted artifact digest, resource allocation and contract versions. Runtime epoch distinguishes recreations, including the same digest/configuration.

Repository-scoped coordination replaces user-scoped lifecycle serialization. D1 remains desired-state authority; a Durable Object serializes transitions but is not a second copy of that authority. Unique constraints, compare-and-set generations, durable idempotency and lease/report sequence checks are required even after worker restarts.

Stable follows approved base releases and rebuilds the repository's existing module selection before rollout. It is not the newest mutable registry tag. Pinned preserves its exact deployment revision until an explicit image/module/configuration change creates a new pin. Automatic stable update must not silently remove an incompatible module, change a pinned revision or wake intentionally stopped instances.

Restart requests the same admitted artifact/configuration. Redeploy creates a new runtime epoch even when the digest is unchanged. Update selects a different admitted deployment revision. All use the same safe transition; no direct Kubernetes mutation from the UI.

Initial idle timeout is 15 minutes of authenticated inactivity, configurable within operator policy. Both idle stop and redeploy first quiesce the producer: reject new mutations, settle in-flight operations/jobs and inspect pending unpublished state. By default, any pending checkpoint or unknown durability blocks automatic discard/replacement. Do not auto-push, reset a clone, or regard a browser disconnection as a recovery proof. An explicit producer-proven recovery disposition can be added only through the versioned contract.

The runtime workspace uses disk-backed ephemeral storage with size limits; GitHub-confirmed data is re-cloned. Platform metadata and build artifacts are persistent separately. Ephemeral workspaces do not mean a local checkpoint is durable or that legacy PVCs can be deleted.

Deployment transition: validate desired revision -> build/admit if needed -> reserve target capacity -> quiesce -> prove old writer absent -> start target -> verify repository/epoch/image/module/auth/readiness evidence -> activate route -> commit observation/release prior reservation. A lease timeout, RWO volume, ready Deployment or echoed environment variable is not proof of writer absence or actual image identity. Unknown/partitioned old runtime blocks replacement. External GitHub writers remain possible; Scriptorium still enforces revision/non-fast-forward safety.

Failure leaves explicit failed/blocked/unknown observations. Never mark the desired revision observed because a command was sent. Recover by inspecting real resources and operation phase before repeating side effects. Compatible rollback reuses a previously admitted artifact through the same fences; it never resets GitHub history.

## 8. Migration, recovery and public repository

Full migration is capability/data coverage, not identical file layout. [COVERAGE.json](../migration/COVERAGE.json) maps every inspected Gateway route, Control Plane route group, infrastructure/runtime capability and required new feature to a task. Workers expand their bounded group into actual handlers before changing it and attach target/proof references. No silent removal because a legacy path is inconvenient.

Per-user multi-repository instances require an explicit offline import plan. Preserve immutable repository identities, audit provenance and configuration where meaningful; split per-repository bindings and flag duplicate bindings. Do not copy old user grants into a new ACL. Reauthenticate through GitHub. Instance ID/origin mapping must be explicit; no assumption that an old origin's browser storage transfers to a new host.

Source application PVCs and unpushed commits are not disposable. Keep legacy Restic/export/restore functionality in the explicit recovery tool until an operator-approved migration proves data publication or a producer-owned recovery export. Platform treats application data as opaque; it does not implement a manuscript merger. No live import, old data deletion or old-service shutdown in the coding campaign.

Preserve Platform D1/configuration backup, encrypted secret handling, restore verification and audit export. Replacing application PVCs does not make Platform identity/configuration storage ephemeral. Operational tests cover stale workers, failed builds, unavailable registry, revoked access, capacity shortage and restore into an isolated environment.

T00 supplies accurate README, MIT license/attribution for owned code, SECURITY, CONTRIBUTING, concise AGENTS and ignore rules. Verify third-party provenance; the absence of a source root LICENSE is not proof that every dependency can be relicensed. Do not copy private addresses, SSH material, account IDs, old environment files or entire operational runbooks. Use validated external inventory, not fabricated production values.

## 9. Execution and acceptance

Only Praetorium is an implementation write target. Sol integrates to main under the owner's same-as-Scriptorium campaign permission; workers have isolated write areas. Source repositories remain read-only, and producer changes go through Scriptorium's existing coordinator. No arbitrary three-worker/session cap and no new backlog exploration; execute the fixed T00–T15 plan.

CI/GitHub Actions and organization template addition/synchronization/execution remain excluded; Build Service is product functionality, not CI. Local verification and independent review are required. Production DNS/Cloudflare/D1/NixOS/K3s changes, real key rotation, public package publication and old data deletion remain separately authorized operations.

Passing mocks or source historical checks does not certify the producer, BuildKit, workerd, D1/DO, ingress, CNI or Kubernetes. Final evidence identifies code SHA, artifact digest, exact environment, commands and outcomes. Distinguish implementation, local integration certification, deployment readiness and production deployment.

## 10. Verified external constraints

- GitHub App user-token access is limited to the intersection of user and App permissions: [GitHub user-token documentation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app).
- Installation tokens can be repository/permission scoped and expire after one hour: [installation authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation).
- GHCR authentication is distinct from repository Git access: [Container registry authentication](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).
- The native engine supports caching and non-root operation: [BuildKit](https://github.com/moby/buildkit). Actual host isolation must still be verified.

These references constrain implementation; they do not prove that this repository already implements the target.
