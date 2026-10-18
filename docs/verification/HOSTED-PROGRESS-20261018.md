# Hosted completion progress — 2026-10-18

Status: **ACTIVE / GOAL UNMET**. [GOAL.md](../GOAL.md), including G1–G9,
is unchanged. Source checks do not certify Hosted acceptance.

## Integrated source and checks

Repository identity is GitHub numeric ID `1422456736` (`yohn-jp/praetorium`).
The campaign started from `e7926f472e12e5f0ec30db88e459328dd08ca58d`.
The integrated and pushed product source cut is `c709470173b5e6eff1b57ae2d2fadec1339a5439`;
the disposable producer verification workflow is a separate verification addition.

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
  metadata artifact name through its job output. Actual producer CI is pending.
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
A manually dispatched disposable CI harness will exercise that exact producer,
two compositions and metadata signing without publishing service images.

Expired owned disposable harness data was copied to `/data`, verified with
checksum and metadata comparison, then removed from `/tmp`; compatibility
symlinks retain old references. Evidence and worktrees were preserved. Only
regenerable campaign caches were discarded. At the last check the root disk had
20 GiB free and `/data` had 158 GiB free. Unrelated application/user data was not
removed; archived expired inventories are not current acceptance inputs.

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
