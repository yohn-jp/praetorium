# Hosted completion progress — 2026-10-18

Status: **ACTIVE / GOAL UNMET**. [GOAL.md](../GOAL.md), including G1–G9,
is unchanged. Source checks do not certify Hosted acceptance.

## Latest operational result — public editor and GitHub save (2026-10-18)

This section supersedes the current-state claims in the historical snapshots
below. **G1–G9 are not collectively passed.** The owner requested a stop after
the public save and performance investigation; no performance fix or change to
the checkpoint/save product contract was implemented during that investigation.

### Integrated and deployed source

- Praetorium main: `bfef9e199a99d03636446ac31fc03db9086d254a`.
  Frozen install and `corepack pnpm@11.18.0 check` passed all 29 tasks,
  provider boundaries and contract schema checks. GitHub
  [CI 39134970974](https://github.com/yohn-jp/praetorium/actions/runs/39134970974)
  passed. These are source checks, not all-gate acceptance.
- Gateway: source `bfef9e1`, deployed version
  `3e39c05d-2386-4f29-8b54-9f3fd0336a89`. Repository action GETs redirect to
  the canonical dashboard. Handoff uses a `strict-origin` document policy as
  well as a response header, because the public path supplied a `same-origin`
  response header. The intermediate page now uses the current Evidence Ledger
  design rather than the legacy portal navigation and colors. Chromium checked
  origin behavior and the rendered design with disposable inputs; the owner
  confirmed entry into the real Scriptorium editor.
- Control Plane: deployed source
  `019eb506669ea4229f02a667ef70f7a03aea3948`, including pre-ready target binding,
  admitted-revision reuse across lifecycle generations, report timestamp parsing
  and live-lease recovery of a completion checkpoint.
- Provisioner: source `229cb7befcf83f5ce24c6ba4fcf4c104c6cec59a`, image
  `ghcr.io/yohn-jp/praetorium/provisioner@sha256:68cb9d69cce07236637c938b93142ba6418c68ff690e2eecf1851739ea784cce`.
  Its canonical K3s apply completed successfully. Grant times are validated at
  receipt, and recovered auth probes renew the existing fenced Runtime identity
  before remote reads. Automatic projected identity renewal was observed after
  the initial proof's expiry; signing keys were not rotated.
- Running Scriptorium Producer source remains
  `008d5c429ec279a424cafd5b8c4cbee70a613b8e`; it is not later Scriptorium main.
  The admitted application image is
  `ghcr.io/yohn-jp/praetorium/candidates@sha256:446a6a8a6703ebe54cc2ef924f71a885eabccf35b0397be6177cebb2f776ce99`,
  with composition digest
  `sha256:988f9f58a69c145d934a26ac170d9ae0d6c39bb407579e001bf9c34f9f00e613`
  and no optional modules selected.

### Real Hosted outcome

The owner-authorized disposable repository is
`yohn-jp/praetorium-hosted-validation-20261018`, numeric repository ID
`1423923158`, installation `172344438`. Its logical instance is
`ins_01M56ESTANTNHV8BA5J1PCNNQJ` in cluster
`clu_01M552J5HCXXJAPCCPN480JSJN`.

- Gateway: `https://praetorium.yohn.jp/`.
- Stable instance origin:
  `https://ins-01m56estantnhv8ba5j1pcnnqj.instances.praetorium.yohn.jp`.
- Normal canary operation `op_01M57D1J5AQ3SJVHKAGEQEM03G` reached `succeeded`;
  Control Plane observed `ready`, generation 2, Runtime epoch 1. Recovery used
  the normal issuer/provider and operation reporting, without direct D1 failure
  row rewrites.
- The owner completed GitHub login, selected the repository, entered the editor,
  edited and eventually completed **Save to GitHub**. The independent GitHub
  read confirmed main moved from `edf0730a3d6b8cdae7e613d72d40ecabd3973d40`
  to [commit c1d9c951](https://github.com/yohn-jp/praetorium-hosted-validation-20261018/commit/c1d9c951965c225d4325dbb873b9d142ccef3c58),
  committed at `2026-10-18T14:29:53Z`. Local checkpoint/publication refs alone
  were not treated as remote save evidence.
- Reload/reconnect retention and long-lived browser-session acceptance were
  **NOT_CHECKED**. Editor entry and one confirmed push do not pass all of G3.
- Headlamp was deployed Ready behind an internal ClusterIP and SSH forwarding;
  no public admin ingress or new cluster-admin grant was added. Admin login
  remained **NOT_CHECKED**.

### Remaining performance issue; no fix claimed

The owner reported long snapshot loading and a save that appeared unresponsive
before eventually succeeding. One read-only canonical observed-writer probe
returned HTTP 200 for the snapshot in 149 ms inside the Runtime network. This
was a warm read, not the complete browser scene-loading or save duration.
The bounded, redacted Gateway trace observed credential issuance around
0.9–1.7 seconds per request, with repeated serial requests. The deployed editor
has a 15-second foreground refresh and overlapping proposal imports; publication
also performs multiple remote observations/reconciliations. These are concrete
latency contributors to investigate, not a measured complete attribution of the
user's wait. No exact end-to-end save duration was recorded.

No latency correction, checkpoint-semantics change, Scriptorium source edit or
new Producer deployment resulted from this investigation. The owner's later
request to record implementation status concerns this document, not changing
the save implementation.

### G1–G9 acceptance remainder

| Gate | Current evidence and remaining acceptance |
| --- | --- |
| G1 | One real authorized user/repository path demonstrated. Multiple users, permission separation and revocation cases remain unverified. |
| G2 | Public login, repository entry, one-use handoff and editor demonstrated. Stopped-bookmark wake, refresh/logout and the full API/MCP retry cases remain incomplete; an absent optional MCP route is not live MCP acceptance. |
| G3 | Real edit and GitHub commit/push demonstrated. Reload/reconnect retention, long-lived sessions and unpublished/recovery-data protection still need complete evidence. |
| G4 | One real admitted composition is running. Two approved selections and real cache reuse remain incomplete. |
| G5 | Runtime startup/recovery reached Ready. The complete idle/quiesce/stop/resume/redeploy/single-writer acceptance sequence remains incomplete. |
| G6 | Canary startup succeeded. No completed canary promotion, full Stable/Pinned rollout or complete failure/recovery acceptance is claimed. |
| G7 | Existing infrastructure and isolation evidence remains scoped to its recorded checks. Full isolation, backup/restore and legacy preservation acceptance is incomplete. |
| G8 | Source trigger changes do not replace cost evidence. Idle/active/failed-notification Cloudflare measurements and removal of remaining unnecessary recurring work are incomplete. |
| G9 | Latest source CI and the initial public user journey have evidence. One coherent release-cut acceptance across all categories, final integrated review and full operational release remain incomplete. |

Sanitized deployment/probe records are retained in the owner-private
`/data/praetorium/production/verification/` directory, including
`hosted-ready-540bb57.json`, `229cb7b-provisioner-image-pin.json`,
`handoff-document-origin-d670734.json` and `handoff-design-bfef9e1.json`.
Credentials, cookies, bearer tokens, raw tail events and authored manuscript
contents are not copied into this repository. Historical failures below are
preserved as historical evidence, not overwritten with PASS.

## Historical snapshots

The following sections describe their recorded earlier cuts and conditions;
they do not describe the latest deployed state above.

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


## Canary Build recovery (2026-10-18 07:40 UTC)

The owner read the remote D1 state through their own refreshed Wrangler login.
Candidate `rel_28a87a55-f1b3-4675-b57a-d9f3cca5cb6b` is blocked with
`canary_build_failed`; Build `build_2f92619e-66d7-4b20-ac89-f461418ddd06`
failed its first attempt with `BUILD_FAILED`. The BuildKit journal identifies the
underlying GHCR token TLS failure: `x509: certificate signed by unknown authority`.
The Build Worker image lacked an OS CA store for Go buildctl; Node's bundled roots
alone do not provide that filesystem store.

`db8e4ca` adds the public CA roots from the existing digest-pinned Node build
image. Its publication succeeded in
[39107905774](https://github.com/yohn-jp/praetorium/actions/runs/39107905774).
The first replacement Pod failed before startup because the copied CA directory
was not traversable by its non-root identity. `bef4eb7` corrects directory modes
and validates CA loading after switching to the runtime user. Its publication
[39108408228](https://github.com/yohn-jp/praetorium/actions/runs/39108408228)
is pending; no successful replacement or Canary retry is claimed here.

A narrowly scoped Operator status/retry route is integrated with the canonical
D1 store. It only retries the designated failed pre-runtime Canary Build, with
unchanged candidate, pinned selection and binding, absent Runtime effects,
transactional revision checks and advancing lease epochs. Failed attempt rows
remain intact. Exact authenticated replays use a read-only durable receipt
lookup before external re-verification; new retries preserve all existing
registry, provenance and producer checks. A newly pending Build receives the
existing authenticated work hint. No new migration, credential rotation, CPU
budget change or direct remote D1 repair is used.

Frozen install and all 29 check tasks pass (28 cached, one changed Control Plane
task per phase); focused coverage includes 18 operator route tests and 11
SQLite-backed rollout-store tests. Separate read-only review confirmed the
replay fix and found no remaining actionable defect in this scoped change.
These source results do not certify a successful real Canary or Hosted browser
session. The remaining sequence is replacement Build Worker readiness, normal
Operator retry, actual Build/Canary/Runtime progression, then authoring acceptance.


## Recovery deployment and D1 compatibility (2026-10-18 07:55 UTC)

The CA-directory correction publication succeeded. The canonical Runtime deploy
completed with exit code 0 at 07:44:22 UTC. The replacement Build Worker is Ready
with zero restarts and can parse the 181,305-byte public CA bundle under its
actual UID 10001. Only its image pin changed; no credentials changed.
[Live deployment receipt](RUNTIME-BUILD-WORKER-CA-bef4eb7.json).

The Operator status API is deployed and returns the existing candidate and
blocked workflow. A normal retry passed authentication, persisted candidate
loading and external immutable evidence verification, then failed inside D1.
The durable workflow remained blocked at revision 3 and the failed Build attempt
was retained. A fresh local Miniflare D1 reproduction identified the initial
retry UPDATE's 60-term conjunction exceeding D1's expression-depth limit of 100.
This was a limitation missed by the Node SQLite test adapter, not missing
Cloudflare configuration or credentials.

The canonical SQL fix groups the same predicates into four parenthesized groups.
It preserves every gate and placeholder order; separate read-only review found
no defect. Fresh Miniflare D1 then accepted the retry, let the ordinary queue
claim attempt 2 at lease epoch 3, and accepted the exact duplicate without another
mutation. This uses synthetic local inputs and proves D1 compatibility only;
it is not a real Hosted Build or browser acceptance result.
[Bounded local D1 result](CANARY-RETRY-D1-DEPTH-20261018.json).
The next action is deploy this source correction and retry the same real
candidate through the Operator API; no remote SQL repair is required.


## Real retry and GHCR receipt upload (2026-10-18 08:08 UTC)

The SQL correction is deployed. At 07:57:14 UTC the real Operator retry returned
HTTP 202, retained the original candidate, and moved the workflow from blocked
revision 3 to `canary_building` revision 4. The durable scheduler then advanced
revision 5. An authenticated direct work hint returned 202 and the ordinary
Build Worker claimed attempt 2. Cloudflare's automatic hint delivery remains
unconfirmed; direct hint acceptance is not evidence of those Worker bindings.
[Source CI 39109487290](https://github.com/yohn-jp/praetorium/actions/runs/39109487290)
passed on `8710ef1054b733d42e08f2a61373880c22ae4991`.

Attempt 2 reached successful BuildKit solve and rootfs export. The image was
published at `sha256:446a6a8a6703ebe54cc2ef924f71a885eabccf35b0397be6177cebb2f776ce99`.
It then failed before candidate admission. Only the existing image's 49,279-byte
metadata layer was read to recover the embedded 1,877-byte Composition receipt.
Its schema, build-input key and composition bindings validate against the
original Build Key; no image rebuild or admission bypass was used.

The canonical receipt publication reproduced the failure: token exchange 200,
absent-blob HEAD 404, upload-start POST 202, followed by local rejection of the
returned Location. GHCR returns the same-origin, same-repository
`/blobs/upload/<opaque-id>` path, while this client only permits
`/blobs/uploads/<opaque-id>`. No upload URL, credential or remote response body
is recorded here. The [OCI POST/PUT contract](https://github.com/opencontainers/distribution-spec/blob/main/spec.md#post-then-put)
requires using the returned Location; the plural form is an example, not the
only valid shape. The scoped fix retains all authority, origin, repository,
opaque-ID and query bounds while accepting GHCR's singular form.

Canary promotion, a tenant Pod, and real browser editing/Git save/reload remain
unproven. Receipt upload repair and a normal idempotent Canary retry are next;
failed D1 rows have not been rewritten by hand.


The singular upload fix passed all 29 source-check tasks and 70 GHCR tests;
read-only review confirmed all target/authority bounds remain intact. The fixed
canonical client then completed the real receipt POST/PUT (202/201). A separate
pull-credential readback returned 404. Read-only comparison across read pull,
write pull, and write pull/push tokens found matching HEAD 200 but GET
`BLOB_UNKNOWN` in every case; the repository also has no tags/manifests. This
rules out the read credential as the cause and suggests the unreferenced blob
needs an OCI artifact manifest before GHCR will serve it. That remains an
inference until the canonical retention correction is exercised. A metadata
storage fix is being prepared inside the existing GHCR provider; the public
blob reference, payload bytes, credentials, application-image admission and
Release/Canary contracts remain unchanged. No new image publication or Build
retry is started while this retrieval issue remains unresolved.


## Metadata retention confirmed (2026-10-18 08:22 UTC)

The same real receipt now has a deterministic OCI artifact manifest in its
existing GHCR repository. Manifest PUT returned 201, and the separate read
credential fetched byte-identical receipt content through the canonical
redirect/digest-checked reader. This confirms the missing-reference diagnosis.
The blob digest and 1,877 payload bytes did not change. The metadata manifest is
not a runnable Runtime image or candidate admission bypass.
[Actual retention and canonical replay evidence](GHCR-RECEIPT-RETENTION-20261018.json).

The existing GHCR provider now ensures that artifact reference when publishing
metadata, including an already-uploaded orphan blob. The raw uploader preserves
all previous authority and redirect restrictions; a private helper uploads the
payload and standard two-byte empty config. The SHA-derived tag is checked
against deterministic manifest bytes before writing, and its stored digest and
size are verified afterward. Identical calls reuse the same manifest; an observed
conflicting tag is refused. The registry tag check/write is not an atomic CAS
against a different authorized writer; blob content hashes remain authoritative.
No public API, configuration, credential or admission contract changed.
Frozen install, all 29 source-check tasks and the GHCR suite pass; read-only
review found no scoped auth/hash/redirect regression.

With the existing receipt available, the normal Operator API accepted a new
retry at 08:15:43 UTC using expected workflow revision 6. It moved the same
candidate to revision 7 and Build attempt 3. The Build Worker reached publishing
99%; at 08:19:45 UTC it remained running. Process inspection identifies a
BuildKit local rootfs export before startup inspection, not a proven successful
artifact admission. Source/image publication continues independently; the
active Build Worker will not be replaced during a live attempt.

## Published correction; active export isolated (2026-10-18 08:33 UTC)

Main `63ad9c82bb4fe637f3acb9ca2c6cc4a7eadd4828` passed the publication
workflow's frozen installation and full repository verification, and all three
service image publication jobs succeeded in [run 39111222707](https://github.com/yohn-jp/praetorium/actions/runs/39111222707).
The prepared Build Worker pin is recorded in
[SERVICE-PUBLICATION-63ad9c8.json](SERVICE-PUBLICATION-63ad9c8.json).
Only the Build Worker image was changed in the private next-deployment Inventory;
other service pins and all credentials were preserved. Canonical K3s `--check`
passed for that Inventory without changing Kubernetes objects.

The live Build Worker remains on `bef4eb7` while attempt 3 is active. At 08:29 UTC
the normal Operator status API reported `canary_building`, workflow revision 9,
Build `running`, publishing 99%, and no Canary Runtime operation. The active
BuildKit local rootfs export started at 08:16:05 UTC. One bounded process/network
inspection found no capacity pressure, no queued TCP data, and both endpoints
waiting without substantive file transfer. The client reports BuildKit v0.30.0;
the daemon reports v0.34.0. These observations do not establish a version bug or
an exact root cause. No daemon was restarted, no live Worker was replaced, no
credential was changed, and no failed D1 row was reset.

The immediate remaining path is export completion or a concrete repair, delivery
of the published Build Worker, normal Canary Runtime start, then actual browser
editing/Git save/reload. This is not the entire G1–G9 remainder: composition/cache,
permission changes, lifecycle/writer fencing, release/recovery, off-host metadata
recovery and Cloudflare cost acceptance still require their missing real outcomes.
Previously passed ingress, registry receipt and CI checks are reused rather than
rerun to substitute for those outcomes.
