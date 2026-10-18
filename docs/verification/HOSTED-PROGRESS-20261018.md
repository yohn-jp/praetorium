# Hosted completion progress — 2026-10-18

Status: **ACTIVE / GOAL UNMET**. [GOAL.md](../GOAL.md), including G1–G9,
is unchanged. Source checks do not certify Hosted acceptance.

## Integrated source and checks

Repository identity is GitHub numeric ID `1422456736` (`yohn-jp/praetorium`).
The campaign started from `e7926f472e12e5f0ec30db88e459328dd08ca58d`.
The latest integrated and pushed product source is `5ca00e2`.
The disposable producer and service-image workflows provide separate evidence;
neither publishes production images.

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
18 GiB free and `/data` had 147 GiB free. Unrelated application/user data was not
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
  separate external gates. Public Control Plane `/healthz` returns 503; remote
  revision/configuration is unknown. The source health-route correction is
  integrated but has not been deployed. No production apply ran.

## Remaining acceptance

No G1–G9 gate has newly passed. G1/G3 require an owned disposable GitHub repository
and authorized writer/reader browser identities. G2 requires Runtime ingress,
workloads and real authenticated UI/API/MCP entry. G4 requires real compositions,
registry readback, signature/admission and reuse/failure evidence. G5/G6 require
real lifecycle, recovery, stable/pinned, canary and rollback evidence. G7 requires
cluster/build isolation and off-host recovery. G8 implementation is integrated,
but actual Cloudflare request/CPU/D1/DO measurements and outage recovery remain.
G9 requires the exact final cut, all seven real categories, independent integrated
and RC review, approved deployment and the public editing journey.

Production `deploy-platform --apply` remains unexecuted. Its concrete effect is
K3s controllers, secrets, certificates and platform services, receiver wake
probes, then Cloudflare migration/Worker deployment. The environment record
identifies targets and effects; approval must apply to resolved concrete inputs.
Implementation and verification continue independently of those production gates.
