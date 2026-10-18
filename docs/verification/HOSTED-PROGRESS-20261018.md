# Hosted completion progress — 2026-10-18

Status: **ACTIVE / GOAL UNMET**. [GOAL.md](../GOAL.md), including G1–G9,
is unchanged. Source checks do not certify Hosted acceptance.

## Integrated source and checks

Repository identity is GitHub numeric ID `1422456736` (`yohn-jp/praetorium`).
The campaign started from `e7926f472e12e5f0ec30db88e459328dd08ca58d`.
The latest integrated product source is `c47a074`; image publication below records
its own exact source cut. Product checks remain distinct from real Hosted proof.
The disposable producer and service-image workflows provide separate evidence;
neither publishes production images. The separate service publication workflow now
accepts an exact main revision and uses its existing scoped GitHub Actions token;
manual publication of `e6dcf87` succeeded as
[39090471416](https://github.com/yohn-jp/praetorium/actions/runs/39090471416).
Frozen install, full check (29 tasks), actionlint, eight deployment reproducibility
tests and four extracted publication-guard cases passed before dispatch.

- Build and Provisioner use authenticated, coalesced local work notifications
  and five-minute recovery claims, replacing one- and two-second empty claims.
  Hints grant no execution authority; D1 claim/CAS, leases, attempts, generation,
  runtime epoch, quiesce and writer-absence requirements remain authoritative.
  Failed delivery cannot undo durable work. Generic operation hints wake claims;
  instance hints refresh one assignment rather than scan the fleet.
- Runtime deadlines survive restart in a bounded local journal. Identity renewal
  follows expiry, ordinary full health evidence is deduplicated, and active
  canaries use stable health due tokens. Canary progression has unique lease
  owners and bounded retries. Idle-stop is atomically fenced for the designated
  active canary; Runtime preserves its idle deadline and refreshes its assignment
  when canary health ends, including when the transition notification is lost.
- Optional notification deployment derives exact HTTPS POST routes and isolates
  receiver credentials from claim and all matching registry credential entries.
  Deployment validates receiver readiness and HTTP 202 before Worker delivery
  bindings. Those live probes can wake pending work and have not been run.
- Gateway health avoids unrelated KV reads; credential/key loading is lazy.
  Token refresh locks compare the stored revision. Configured KV/JWKS caching is
  30 seconds; KV global eventual consistency is not a strict revocation bound.
- Scheduled maintenance no longer inserts unchanged advisory GC plans; absent
  optional release configuration does not fail unrelated credential cleanup.
- On exact product cut `c709470`: Node 24.21.0 / pnpm 11.18.0 frozen install and
  full check passed (29 test tasks; Control Plane 120, Provisioner 86, Gateway
  108 tests). Deployment tests passed 15/15. Actual bundled Workers/D1/DO passed;
  six external categories remain BLOCKED, so the aggregate correctly exits 2.
  [Exact-cut report](HOSTED-ACCEPTANCE-c709470.json).
- Earlier check failure at `0f4e29c` was ENOSPC, not a passing check. Verification
  temporary files and Node caches now use `/data`; the above checks are the
  successful rerun. Corepack shims ensure nested `pnpm` uses 11.18.0.
- With the disposable producer-CI harness added, frozen install and full check
  passed again. Direct ESLint, Node syntax, Bash syntax and actionlint 1.7.12
  passed. All four action commit pins resolve at their canonical GitHub
  repositories. Integrated review found no remaining product-code issue and
  identified an artifact naming collision on workflow reruns; names now include
  the build attempt, and the signer receives the successful build's exact
  metadata artifact name through its job output. The corrected actual producer CI
  succeeded; see the real evidence below.
  The first run, [39084385532](https://github.com/yohn-jp/praetorium/actions/runs/39084385532),
  passed certificate/tool pins and producer frozen install, then failed because
  the host build's nested `pnpm` command had no PATH shim. The harness now creates
  its own Corepack pnpm shim before invoking the unchanged producer build.
- [CI 39083200410](https://github.com/yohn-jp/praetorium/actions/runs/39083200410)
  passed on `9d4a1d9`; service-image publication was skipped. Later source still
  needs its own CI result. No release tag or production deployment was made.

## Environment and disk

Gateway health and public JWKS return HTTP 200 with verified TLS after the
owner's edge-rule change. OAuth start redirects to GitHub with the configured
client ID. Authenticated browser entry, edit, push and reload remain unverified.
Existing App private-key and OAuth-secret binding references are known; missing
local key files do not prove the deployed Worker lacks them. Wrangler explicitly
reports unauthenticated, so management secret presence/deployment history remain
NOT_CHECKED. See [environment evidence](HOSTED-ENVIRONMENT-20261018.md).

Runtime has one Ready K3s node and no Traefik/Praetorium deployment. Its existing
admin kubeconfig and live context `default` are known through authorized SSH;
cluster identity/confirmation is separate. Build's existing endpoint and client
certificate location are also known. Inventory JSON and a local kubeconfig copy
are constructible rather than missing owner input. Outstanding inputs concern
final immutable service images, admitted producer artifacts, public Runtime
L4/DNS/TLS reachability and unresolved service credential references.

The owned Build VM harness built and read back unsigned Runtime Base digest
`sha256:25549b5b5901216b42a579f8914712013c5f2a61248c072e6a6b61fbb8910b2a`
from canonical Scriptorium `008d5c429ec279a424cafd5b8c4cbee70a613b8e`.
That exact commit remains fetchable from GitHub despite later main commits.
The unchanged Build Kit Dockerfile's Corepack fetch fails behind the VM proxy;
Node requires proxy opt-in inside the build step, which daemon environment alone
does not supply. Producer source and production proxy were not modified.
The manual [producer CI 39084601122](https://github.com/yohn-jp/praetorium/actions/runs/39084601122)
succeeded on `4e615d8`, producing real Runtime Base, Build Kit, Core and Story
images. Local pinned Cosign verification passed. Exact signed metadata and the
unsigned CI build report are preserved in [producer evidence](producer-008d5c4-39084601122/README.md);
all public proof files were read back from immutable commit `a263f6a` with HTTP
200, no redirects and identical bytes. The 732,414,335-byte ciphertext was
downloaded and its SHA-256 verified before transfer to the owned Build VM.
All four image archives were authenticated-decrypted, checked against the build
report and OCI manifest digests, imported with preserved digests into the owned
test registry, and read back over verified TLS with matching digests. Control
Plane admission, cache reuse and Hosted acceptance remain separate checks. No
public service image was published.

Expired owned disposable harness data was copied to `/data`, verified with
checksum and metadata comparison, then removed from `/tmp`; compatibility
symlinks retain old references. Evidence and worktrees were preserved. Only
regenerable campaign caches were discarded. At the last check the root disk had
18 GiB free and `/data` had 141 GiB free. Unrelated application/user data was not
removed; archived expired inventories are not current acceptance inputs.

## Independent readiness since the producer build

- A real bundled Control Plane Worker on owned loopback HTTPS has local D1 and
  SQLite DO bindings; migrations 0001–0005 were applied. A synthetic repository
  resolved to the same instance after process restart. This is not real GitHub
  authorization. Its canary/release state will not be bypassed for Build tests.
- A new owned rootless Kind cluster passed actual Kubernetes policy checks:
  host networking was denied, and a restricted digest-pinned Pod became Ready,
  was deleted and observed absent. This is not a Scriptorium runtime acceptance.
- A fresh Chromium profile with strict TLS followed the public Gateway OAuth
  flow to GitHub’s signed-out login page, with state and S256 PKCE. No human
  login, consent, repository operation or authenticated Hosted acceptance ran.
- The owned test registry and SSH/BuildKit namespace forwarding use the same
  HTTPS loopback URI. Build Worker now loads distinct mounted publisher
  credentials for configured registries; a regression checks separation from
  pull and notification credentials. Frozen install and full check passed.
  The fixed runner accepts the existing explicit anonymous HTTPS loopback flag;
  its restrictions to loopback and disposable ownership remain in force.
- Disposable service-image CI
  [39085782483](https://github.com/yohn-jp/praetorium/actions/runs/39085782483)
  passed on `98758e8`, producing Provisioner, Instance Access and Build Worker
  OCI archives. Ciphertext and archive hashes, BuildKit metadata and OCI digests
  were checked; all three were imported and read back from the owned TLS
  registry with preserved digests. Later fixes require new candidate images;
  these are neither final release candidates nor publicly published images.
- Control Plane stateless health now avoids unrelated configuration and D1
  initialization, with both unit and actual bundled Worker checks. Registry and
  provenance clients bind the platform fetch receiver; the previous unbound
  invocation failed in actual Workerd. The real producer bundle initially failed
  admission: Workerd throws for Sigstore's omitted-digest ECDSA verification,
  whereas Node 24 verifies the same input. Explicit SHA-256 verifies that exact
  Rekor signature in Workerd. A narrow pinned upstream patch now preserves
  Node's implicit SHA-256 behavior for EC keys; explicit hashes and non-EC keys
  remain unchanged. Clean Wrangler output from exact source `3ec80b5`, without
  a manual bundle patch, returned 201 for the real producer proof and 422
  `RELEASE_CANDIDATE_DENIED` for its tampered Rekor SET, using separate fresh
  D1/DO state to prevent duplicate acceptance from bypassing verification.
  GHCR tests pass
  51/51, including real-bundle tamper rejection and Ed25519 preservation.
  Frozen install and full check pass on integrated `3ec80b5` (29 tasks).
  Fresh service-image verification
  [39087477892](https://github.com/yohn-jp/praetorium/actions/runs/39087477892)
  passed on that cut. Its ciphertext was downloaded and its size and SHA-256
  checked; registry import/readback is a separate step. Source CI also passed
  on `3ec80b5` and documentation cut `6596ac6`. The latter's actual bundled
  Workers/D1/DO runner passed; six other categories remain BLOCKED/NOT_CHECKED,
  so the aggregate correctly exited 2. No canary success was fabricated.
- All three `3ec80b5` service archives were authenticated-decrypted, checked
  against their reports and imported with preserved digests into the owned
  registry. Strict-TLS raw-manifest and registry-header readback matched all
  three candidate digests. No public GHCR publication occurred.
- The actual Build Worker claimed the canary job and built an image, but its
  terminal report initially returned 503. The owned BuildKit registry needed
  explicit HTTPS for its loopback host; that configuration was corrected
  without changing the production daemon. A separate real D1 exception exposed
  a missing literal NULL for audit `request_id` in `D1BuildStore.recordReport`,
  causing a parameter-binding count mismatch. `5ca00e2` fixes the SQL and adds
  an actual transactional SQLite regression. Frozen install, full check and
  [source CI 39088779771](https://github.com/yohn-jp/praetorium/actions/runs/39088779771)
  passed. The actual Workers/D1/DO category, now including the Workerd crypto
  regression, also passed on that cut; six other categories remain unverified.
- On clean `5ca00e2` Workerd, the real Build Worker success report returned
  HTTP 200 with `accepted=true`. API and read-only D1 readback confirmed build
  `succeeded` and an admitted revision with image digest
  `sha256:51d699ab516f6c57df54745530384821fc2934db173b4cdeb10d8bcf6deb36d2`.
  Normal scheduled-handler progression created the ordinary canary redeploy
  operation; no reservation, assignment or health result was fabricated.
  Runtime execution and healthy canary completion remain separate checks.
- The owned Kind cluster now has the pinned Traefik controller (2/2 Ready)
  and established IngressRoute CRD. The fresh Provisioner image passed verified
  CP HTTPS, actual ServiceAccount Kubernetes API access and PodIP reachability
  checks using a bounded local network fixture. The exact candidate image was
  pulled into containerd with strict TLS and its manifest digest preserved.
  These are readiness proofs, not a running assigned Scriptorium or public
  ingress acceptance. Kind packet-policy enforcement remains NOT_CHECKED.
- The actual Provisioner entrypoint subsequently reached its first normal
  claim, which returned 409 `RUNTIME_CONTEXT_UNAVAILABLE` before assignment,
  reservation or Pod creation. The private harness omitted two runtime-policy
  bindings. The registry host is known from strict-TLS readback; the broker
  reference is also known from Gateway code:
  `https://praetorium.yohn.jp/internal/github/credential`. These are not missing
  owner-provided URLs. What remains unverified is real broker trust and GitHub
  authorization for the canary's synthetic repository/installation IDs. No
  authorized real test repository or browser principals had been established at
  that earlier snapshot. A private, explicitly owned disposable repository has
  since been created; its GitHub App installation authorization remains unverified.
  The utility worker was stopped; no assignment or broker authority was forged,
  and the blocked operation was not reset through direct D1 writes.
- The real Core image declares user `node` (UID/GID 1000). Kubernetes rejected
  the earlier nonnumeric identity with `runAsNonRoot`. The renderer now sets
  UID/GID and volume group 1000. An owned live-policy Pod using the exact image
  verified writable `/data` and `/tmp`; the application still requires a real
  Control Plane assignment. Frozen install and full check passed on `3ab22dd`
  (29 tasks). Earlier CI
  [39086431028](https://github.com/yohn-jp/praetorium/actions/runs/39086431028)
  passed on `fcff970`; service publication was skipped.
- Independent G8 measurement used the actual Build Worker entrypoint and a
  separate empty local Workerd/D1 instance with no release policy or jobs.
  Startup produced one authenticated claim (HTTP 204); a measured 90.192-second
  idle window produced zero additional claims. One authenticated receiver POST
  returned 202 and triggered exactly one additional claim (HTTP 204). BuildKit
  and registry were not contacted. This demonstrates local trigger behavior;
  production Cloudflare request, CPU, D1/DO and outage measurements remain open.
  Existing active Build traces record 30 monitored queue requests across four
  separate bounded attempts: four claimed jobs, one empty claim, 21 heartbeats,
  three 503 reports and one accepted report. The successful claim-to-report
  window was 18.101 seconds. Earlier attempts were stopped manually; these
  traces do not certify automatic outage recovery or total platform cost.
- Production inventory preflight actually ran and stopped at validation. After
  deriving routine fields, outstanding validator inputs are Cloudflare account
  identity, the verified existing production builder public key, three final
  immutable service image references and ACME contact. The already tracked
  Prometheus digest was verified against Docker Hub, including its Linux/amd64
  child manifest. Runtime public L4/DNS/TLS,
  management/secret references and authorized real browser principals remain
  separate external gates. Latest public Gateway and Control Plane `/healthz`
  probes both return HTTP 200, superseding the earlier Control Plane 503. Remote
  revision/configuration remains unknown. Root has not deployed the source
  health fix, and no production apply ran.

- After the two known runtime-policy bindings were applied, a normal authenticated
  Provisioner claim returned HTTP 200 and resolved the admitted artifact, runtime
  epoch and broker locator. No direct D1 reset was used. Provider startup was
  withheld because the old canary binding names synthetic GitHub IDs: canonical
  Scriptorium startup would immediately request a real Git credential. The lease
  expired naturally, with no reservation, Pod or broker call. This proves context
  resolution, not a running Hosted application.

- Service publication [39090471416](https://github.com/yohn-jp/praetorium/actions/runs/39090471416)
  succeeded for all three services at `e6dcf87`. Anonymous strict-TLS GHCR pulls
  verified index bytes/headers, Linux/amd64 child manifests, config blobs and
  attached BuildKit provenance content bindings. These provenance content checks
  do not establish a cryptographic signature. The immutable refs are recorded in
  [the image ledger](SERVICE-IMAGES-e6dcf87-39090471416.json).
- `50b5014` fixes another deployment boundary: the canonical Control Plane
  projection now derives the required Git credential broker locator from the
  configured Gateway origin. Frozen install, full check (29 tasks) and the eight
  deployment reproducibility tests passed. This is independent of the current
  public JWKS 503: owner dashboard inspection confirms three runtime public
  variables were absent and both existing signing secrets are registered. Owner
  application is pending; the confirmed nonsecret values are now declared in
  `apps/control-plane/wrangler.toml`, with `keep_vars=true` preserving other
  existing remote policy variables. Frozen install, full check (29 tasks) and
  the actual Wrangler dry-run bundle passed. Keys are preserved.
- Actual Runtime K3s packet-policy testing passed: both restricted test sources
  reached an owned target before policy, deny-all blocked both, and the exact
  allowed-source rule restored only that source. The owned namespace was removed
  with a UID-preconditioned API deletion and confirmed absent. This is one G7
  dataplane case, not full cluster/build/recovery acceptance.
- Separate actual Provisioner startup on an empty owned local CP produced one
  normal claim. A 90.195-second idle interval produced zero additional claims;
  one authenticated operation notification returned 202 and triggered exactly
  one additional claim. All five queue/binding/reservation table counts stayed
  zero, no provider/external effect ran, and the harness shut down. This interval
  does not cover the default five-minute recovery claim.
- A fresh actual Workerd scheduled no-work invocation also completed, made zero
  outbound calls and left all 24 application table row counts unchanged. Its
  five D1 API calls / six SQL statements are source-derived, not measured SQL
  counters or Cloudflare billing. Together these local measurements complement
  the earlier Build Worker evidence without certifying full G8.

- Public Control Plane control and runtime-identity JWKS now both return HTTP
  200 after its automatic build. The actual Cloudflare check for `98ea9e5`
  identifies the Control Plane deployment; Gateway check metadata identifies
  `49407db`. Their provider-issued dashboard links resolve to the same account,
  which is now filled in the private inventory without requesting a credential.
- A real owner browser initially reached a GitHub 404. Public GitHub App metadata
  showed the tracked OAuth client ID was mistyped. `49407db` fixes Gateway and
  inventory from the App API value; public redirect readback matched it after
  automatic deployment. The owner then reported opening the repository
  list/management page. This is owner-confirmed login progress, not the G1
  multi-principal test or an editing/push proof.
- `370a0a1` adds responsive repository/management views and a fenced stop action;
  `c47a074` uses one shared configuration form for preview/save and shortens only
  digest display. Frozen install and full check passed (29 tasks, Gateway 116
  tests). Six synthetic-fixture browser views at desktop/mobile widths passed
  CSP, browser-error and overflow checks. The public error renderer exposes the
  same hashed stylesheet, and Cloudflare's actual `c47a074` Gateway build plus
  GitHub CI succeeded. Authenticated management still needs real journey tests.
- Existing production BuildKit port 1234 accepted the existing mTLS client and
  returned one worker; a request without its client certificate was TLS-rejected.
  The existing daemon unit invokes rootlesskit. Runtime kubeconfig and these
  existing client files are prepared privately, with verified cluster/TLS/key
  identity. No production platform apply or key rotation occurred.
- Private deployment input preparation now has four of eleven roles ready:
  existing BuildKit client material, valid anonymous application-image pull
  config, and two inactive new dedicated notification tokens. Seven private
  roles remain unresolved; the full deploy cannot run from that partial manifest.
  Inventory validation has zero errors and two blockers: trusted production
  Build Worker public key and ACME contact. Actual public ingress/DNS remains
  a separate prerequisite.
- The operator-approved producer publisher in `95da17f` uses a separate
  packages-write job after source validation and Sigstore signing. Six guard
  tests include digest/subject/DSSE rejection before copy and a nonzero blocked
  result when anonymous pull fails. Actual run
  [39092494296](https://github.com/yohn-jp/praetorium/actions/runs/39092494296)
  built and signed successfully but stopped at the pinned Skopeo version-string
  guard before any image push. The exact signed artifacts are retained for a
  scoped retry; public producer availability is not established by that run.
- `fb35759` fixes the guard against the actual pinned image output and adds a
  trusted publisher-only retry. Frozen install, all 29 check tasks, six publisher
  guard tests and actionlint passed. Retry
  [39093546534](https://github.com/yohn-jp/praetorium/actions/runs/39093546534)
  succeeded using the original run's signed metadata and OCI archives without
  rebuilding. Sigstore verification and digest-preserving publication passed;
  independent anonymous HTTPS manifest readback at 03:28:11 UTC verified both
  exact digests in `ghcr.io/yohn-jp/praetorium/scriptorium-producer`:
  Runtime Base `sha256:93bb59a32e85d9891b1a4d4ece15845d93af677330935fce56e71b79e9875c52`
  and BuildKit `sha256:b0d99ef773188fa451f9aef1a03b52fb26871c152bb7eaebb1863c0cc44bf888`.
  Public producer inputs are now available; this does not establish admitted
  compositions, cache reuse or full G4.
- `b2f91e6` records the existing file-backed/Cloudflare-managed secret contract
  in [SECRETS.md](../deployment/SECRETS.md), including exact consumers, initial
  issuance conditions, synchronized registration, activation and recovery.
  Four prepared roles now have byte-verified copies under the durable private
  root `/data/praetorium/production`; independent review found no ownership,
  file-mode or symlink errors. Seven inputs remain incomplete; remote presence
  not inspected is explicitly `NOT_CHECKED`, not assumed absent or present.
  No independent protected backup has yet been verified. Existing Runtime
  ingress, DNS token source and real ACME contact could not be established from
  the checked settings. No production secret registration or rotation occurred.
- The owner subsequently confirmed `PROVISIONER_AUTH_TOKEN`,
  `BUILD_WORKER_AUTH_TOKEN` and `INSTANCE_ACCESS_SERVICE_AUTH_TOKEN` absent in
  their respective Workers. Targeted read-only Runtime checks also found the
  three corresponding Kubernetes Secrets absent. Three distinct initial
  256-bit auth values are now staged privately, distinct from notification
  tokens; the partial manifest now supplies seven of eleven roles. No values
  or secret hashes were recorded in evidence. A private registration helper
  refuses existing target names and uploads only these Worker secrets from
  stdin; its read-only preflight stopped at unavailable Cloudflare management
  authentication before any write. Actual registration remains pending an
  authorized Wrangler login on this terminal. Frozen install and all 29 check
  tasks passed after preparation. Builder trust, registry read/write and DNS
  token inputs remain unresolved, along with ingress and ACME contact.
- Subsequent owner correction established an existing Gateway Instance Access
  credential; its initial candidate was excluded until the owner explicitly
  approved the one-credential cutover after confirming no recoverable source.
  It is now restored as an approved candidate pending operator registration.
  Initial builder trust and its matching private signer are also prepared,
  bringing staged roles to eight of eleven; GHCR read/write and DNS inputs
  remain absent. The private interactive collector accepts these three inputs
  and optional ACME contact without displaying entered credentials.
- `a71d622` supplies actual Wrangler Build policy and fixes its canonical OCI
  allowlist to include the producer inputs and composition metadata as well as
  candidate outputs. Frozen install, all 29 check tasks, 15 deployment tests and
  Wrangler dry-run passed. Its Cloudflare build succeeded. Read-only public
  probes at 03:55:22 UTC now return 401 without the Build credential and 405 for
  authenticated GET to the POST-only claim route; Build auth is verified and
  the earlier 503 is resolved without making a claim. Provisioner auth also
  passed earlier. This is service/configuration readiness, not a real build or
  Runtime acceptance result.

## Current integration state (2026-10-18 05:56 UTC)

The integrated source is `1abfcaa2acdb2b9d4a5588c12ac9521bfc6f6e36`.
Its frozen install, all 29 check tasks, 67 GHCR tests, and
[GitHub CI verification](https://github.com/yohn-jp/praetorium/actions/runs/39101243664)
passed. Admission validates immutable Index/Manifest and Config bytes, platform,
layer descriptors and total size, producer signatures/provenance, and metadata
bindings. It no longer downloads and re-hashes layer bodies; the actual image
puller owns that work. No CPU-budget or paid-plan change is required by this fix.

| Path | Observed result | Remaining connection |
| --- | --- | --- |
| Gateway login and repository management | Owner confirmed successful GitHub login and repository management UI | Authenticated application entry after Runtime is ready |
| Deployment inputs | All eleven Runtime secret roles are complete; existing credentials were preserved except the explicitly approved Instance Access cutover | No further secret collection is currently required |
| Runtime platform | Four application Deployments available; two ACME certificates Ready; actual Build Worker to BuildKit mTLS connection passed | Per-repository workload from the admitted composition |
| Public release admission | HTTP 201 at 05:43:58 UTC created candidate `rel_28a87a55-f1b3-4675-b57a-d9f3cca5cb6b`; the normal idempotent retry returned HTTP 200 for the same candidate | Normal Canary build/start/health/promotion; no D1 state rewrite |
| Owned authoring repository | Repository ID `1423923158` has synthetic project/volume/chapter/scene/manuscript files in setup commit `edf0730` | Actual browser edit, Checkpoint, GitHub save, and reload; the setup push is not that proof |
| Public Runtime ingress | Owner-configured Caddy; all three sampled hostnames pass trusted public HTTPS; both authenticated notification routes return 202; stopped-instance navigation redirects to Gateway | Running tenant Pod and actual authenticated application entry; no Cloudflare Tunnel is needed |

The accepted producer source remains Scriptorium
`008d5c429ec279a424cafd5b8c4cbee70a613b8e`, with Runtime Base
`sha256:93bb59a32e85d9891b1a4d4ece15845d93af677330935fce56e71b79e9875c52`
and BuildKit
`sha256:b0d99ef773188fa451f9aef1a03b52fb26871c152bb7eaebb1863c0cc44bf888`.
The [public admission receipt](RELEASE-ADMISSION-1abfcaa.json) records the actual
signed source-release admission. Producer status now identifies that admitted
source digest, without changing any product gate to PASS. Successful candidate
admission does not establish a built composition or Stable promotion. Runtime service image publication for this integrated source is
completed in [run 39101922331](https://github.com/yohn-jp/praetorium/actions/runs/39101922331).
The canonical K3s deploy completed at 05:55:30 UTC with exit code 0.
[Actual rollout metadata](RUNTIME-SERVICES-1abfcaa.json) records the three
configured digest pins and Ready replacement Pods. The existing Prometheus
Deployment and both certificates also passed the deployment readiness gates.
No credentials were rotated and no Cloudflare management operation was run.

## Remaining acceptance

The full G1–G9 outcome remains unproven. The owner-configured Caddy public
route now passes the [actual public ingress checks](PUBLIC-INGRESS-CADDY-20261018.json).
Both notification receivers accepted their authenticated hints. The instance
currently returns `INSTANCE_STARTING`, and browser navigation redirects to its
Gateway entry. No tenant Pod was present at the observation; the next dependency
is normal Release/Canary/Build progression, not public Tunnel setup.
Previously passed checks and measurements are retained as evidence and are not
repeated without a changed input or concrete failure.

The next product path is normal Canary composition/build and Runtime startup,
then the real browser edit → Checkpoint → Save to GitHub → same-origin reload.
The browser runner now performs those actual authoring assertions, including
the numeric repository identity, the single synthetic manuscript path, confirmed
publication receipt and remote commit, remote content, and reload persistence.
Its live run still awaits a running tenant and actual browser authentication; a
dashboard, setup Git push, fixture, or source check cannot substitute for it.

After that path, the remaining real outcomes are distinct approved compositions
and cache reuse, safe stop/resume and writer fencing, permission changes and
credential renewal, Stable/Pinned rollout and recovery, off-host metadata
recovery, and bounded Cloudflare operation counts. Existing successful substrate
and admission evidence is reused; only missing product outcomes require new
execution.

The owner has explicitly authorized publication and production delivery.
Cloudflare management remains owner-operated. The static K3s platform has
actually been deployed; an all-in-one `deploy-platform --apply` is not required
to repeat those completed effects. No production approval is inferred from CI
alone. Final completion requires the remaining actual product outcomes on the
identified release cut, with no fabricated PASS or direct D1 failure reset.
