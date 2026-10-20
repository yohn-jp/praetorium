# Three-VM production migration acceptance

Status: IN PROGRESS. No production acceptance claim.

Owner instruction: 2026-10-20 attached migration objective, preserving all
`docs/GOAL.md` G1–G9 gates. The owner expressly authorizes main commits/push,
Ansible provisioning, service-controlled artifact publication and production
migration/deployment. This supersedes earlier documents' permission limits for
these actions; data deletion, key rotation and unrelated work are not authorized.

Starting refreshed main: `59449ffd65a9210435b882504933cbaf57db1418`.
The worktree was clean. GitHub Epic #1 and Issue #24 were read live.

## Evidence collected 2026-10-20

- SSH configuration resolves Management, Runtime and Builder to the configured
  private hosts. All three authenticated SSH connections succeeded. The initial
  Management timeout was transient; its first-use host key was subsequently
  accepted. Host discovery is assigned to `THREE-VM-INFRA.md`.
- Runtime Kubernetes reports one Ready `runtime` node, K3s
  `v1.35.9+k3s1`, with control-plane and embedded-etcd roles. A live Scriptorium
  Deployment exists. No migration or retirement is inferred safe from Ready.
- Public certificate verification for
  `https://1423923158.scriptorium.yohn.jp` failed with curl exit 60 (SAN mismatch).
  Gateway HTTPS answered with a valid TLS connection; HEAD `/` returned 404.
- Live Cloudflare Worker settings were read through the API. Both Gateway
  `GATEWAY_INSTANCE_HOSTNAME_SUFFIX` and Control Plane `INSTANCE_HOST_SUFFIX`
  use the physical-runtime suffix `instances.praetorium.yohn.jp`; this is
  deliberately separate from the public `scriptorium.yohn.jp` namespace and
  must remain intact. Live Certificate/fallback/Ready routes still omit the
  public namespace; those resources require the already implemented application-
  origin deployment. No work-notification endpoints were configured
  in the inspected Control Plane settings. Settings were backed up privately.
- Protected operator inventory and eleven-role credential manifest exist at the
  established `/data/praetorium/production/` location on the control workstation.
  Their existence does not prove current provider credentials or admission.
- D1 `praetorium-platform` was exported remotely with pinned Wrangler. The
  211074-byte SQL export SHA-256 is
  `6512600a38364f1a2abe1955690c1d5eccc760573c56e962191da08a417bb02b`.
  An isolated SQLite restore loaded all 26 tables and returned
  `PRAGMA integrity_check = ok`. Evidence and raw backups are private under
  `/data/praetorium/production/backups/20261020/`. This is a local SQL restore,
  not a hosted D1 restoration test or K3s/PVC recovery proof.
- D1 at export time reports the canary repository `1423923158` at generation 3,
  runtime epoch 2, desired running and observed ready; its redeploy operation
  remained claimed at attempt/lease epoch 243. Lifecycle investigation must
  establish actual work and writer state before migration.

## Source validation

At starting main, `corepack pnpm@11.18.0 install --frozen-lockfile` passed.
The first `corepack pnpm@11.18.0 check` failed because nested bare `pnpm`
resolved to the host's pnpm 12.10.1. Repeating the exact required command with a
temporary PATH shim that runs bare pnpm through `corepack pnpm@11.18.0` passed:
29/29 Turbo tasks, provider-boundary validation and contract-schema validation.
The shim is outside the repository; no package-manager requirement was changed.
This baseline result does not certify later implementation or hosted behavior.

## Completion gates

Every row must be demonstrated on the final source/artifact cut. NOT_CHECKED
means no suitable current evidence yet; no fixture or CI result substitutes.

| Requirement | Current result | Required evidence |
| --- | --- | --- |
| Full three-host inventory, CPU/memory/cgroups/OOM/cache baseline | IN PROGRESS | Sanitized per-host measurements and datastore/network/secret references |
| K3s token/CA/datastore/PVC backup and independent recovery | VERIFIED datastore/journal/Git restore slices; workspace pending | Actual restored identities, resources and durable data; rollback rehearsal |
| Management host-systemd K3s Server; Runtime Agent | NOT_CHECKED | Live node roles, CA/cluster continuity and systemd state |
| Rootless independent Quadlet Coordination | VERIFIED running with K3s inactive; reboot pending | Dedicated UID, digest, reboot recovery and health with K3s stopped |
| Management tenant exclusion and future Agent placement | NOT_CHECKED | Node taint/labels and rendered/observed tenant affinity |
| Existing BuildKit/cache preserved and bounded | IN PROGRESS | Version/cache identity, actual build peak, GC and resource limits |
| Authenticated private work delivery and recovery | NOT_CHECKED | Duplicate/lost hint, coordinator restart, D1 fencing and bounded recovery |
| Issue #24 HTTPS, SNI, DNS-01, default TLSStore | VERIFIED TLS slice; Issue #24 remains open | Trusted external TLS and observed Caddy/Traefik/cert-manager path |
| Ready/stopped handoff routing and auth rejection | VERIFIED unauthenticated entry/rejection only | Real POST, Origin, 303, cookies, replay/expiry and unauthorized checks |
| GitHub login, two principals and access revocation | NOT_CHECKED | Real browser/session/permission evidence (G1/G2) |
| Real edit, checkpoint, GitHub save and reload | NOT_CHECKED | Confirmed remote commit/content and browser recovery (G3) |
| Two admitted compositions and identical-input cache reuse | VERIFIED provider builds/reuse; admission NOT_CHECKED | Producer/build-input revisions, OCI digests/signature and runtime readiness (G4) |
| Stop/wake/redeploy, pending work protection, writer absence | NOT_CHECKED | Current-epoch quiesce and actual writer census (G5) |
| Stable/pinned rollout and fault recovery | NOT_CHECKED | Real release/canary/retry/interruption evidence (G6) |
| Infrastructure/credential/network isolation | NOT_CHECKED | Actual RBAC/admission/network/build isolation (G7) |
| Cloudflare idle/active/outage request counts and VM measurements | NOT_CHECKED | Observed counts and before/after resources, not theoretical estimates (G8) |
| Exact release cut, CI, independent review and reproducible deployment | NOT_CHECKED | Green final checks, reviewed immutable digests and actual operational release (G9) |

Final report must include main HEAD, each VM's live state, deployed digests,
actual E2E results, remaining requirements, and recovery/runbook paths. Keep
this campaign active until all owner requirements and original G1–G9 pass.

## Integrated slices and live changes

At integrated source `0b5532ee919dd2e83e9de3db1ce93b1d6dc533ee`, the frozen
install and full check passed (30 Turbo tasks plus boundaries/schema checks).
[Main CI](https://github.com/yohn-jp/praetorium/actions/runs/39412425385) and
[explicit source image publication](https://github.com/yohn-jp/praetorium/actions/runs/39412481019)
succeeded. The new service image was read back from GHCR by its immutable digest:
`ghcr.io/yohn-jp/praetorium/coordination@sha256:bf43bed86b8eca82f6bd6dfe2cd6b3ad4382975b6783de2681950edfa1916ced`.
Publication alone does not mean the service is deployed.

Independent read-only review of that slice found no defect in the focused relay,
per-kind authentication, D1 authority or bounded notification/fallback path. It
identified missing Coordination inclusion in the separately encrypted candidate
archive builder. That builder now includes the fourth image, its metadata,
archive, size accounting and report; shell syntax validation passed. The
separately encrypted four-image job has not been executed in this campaign.

The canonical deployment inventory/Worker renderer now accepts a provisioned
`workNotifications.coordinationVpcServiceId` and projects it to the Control
Plane `COORDINATION_SERVICE` binding only when notifications are enabled. The
new private Management Tunnel and VPC Service have been created; the connector
and binding still require actual deployment. Existing unrelated tunnels were
not reused. See `THREE-VM-CONTROL.md`.

The owner identified OPNsense as the public gateway and supplied its configured
SSH alias. Read-only inspection confirmed Caddy running on OPNsense with Layer 4
support and an SNI proxy to Runtime TCP/443 before its TLS listener wrapper.
Its configuration was backed up privately. No OPNsense/Caddy mutation was needed.
This supersedes the earlier uncertainty about the gateway's management path.

Existing committed Certificate, TLSStore/default, fallback IngressRoute and
Traefik HelmRelease were rendered with the protected inventory, backed up,
server-dry-run checked, then applied. No tenant Deployment was changed by this
step. cert-manager completed DNS-01 and the new certificate is Ready. Strict
public HTTPS verification now succeeds for `1423923158.scriptorium.yohn.jp`;
public and direct Runtime connections present the same certificate. See the
exact SAN, validity and fingerprint in `THREE-VM-ACCESS.md`.

Instance Access alone was then conditionally updated from its recorded old
digest to the verified source-36574d1 image:
`ghcr.io/yohn-jp/praetorium/instance-access@sha256:68914e8dffccee11a6ad9cbb9a7b30b7eddfdf6aab6d66c7391f4fd6fc68c8b5`.
The dry-run and actual patch both tested the old digest before replacement;
Deployment rollout completed and the private inventory now pins the result.
Empty handoff POST is 400, fake-code POST is 401, unauthenticated browser
navigation reaches Gateway entry/login, and API-style GET remains bounded 503
`INSTANCE_STARTING`. Authenticated handoff/Ready routing is not yet proved.

The active writer's unpushed commit has been protected by an encrypted off-host
Git bundle, restored in an isolated tmpfs bare repository and matched against
the source commit. This does not protect uncommitted/pending producer work by
itself. The old claimed lifecycle operation remains a migration gate. Migration
`0006_application_origins.sql` explicitly refuses active operations; it has not
been bypassed or applied over the unresolved claim.

The first K3s restore rehearsal used an insufficiently isolated filesystem and
rewrote the operator kubeconfig endpoint. It was stopped; the kubeconfig was
restored byte-for-byte. The production API and workloads stayed live. That
attempt is FAILED, not acceptance evidence. A subsequent independent rehearsal
on empty Management used both private mount and network namespaces, restored
the snapshot/token/CA and authenticated the restored API. Detailed scope and
Secret time-delta comparisons belong in `THREE-VM-INFRA.md`; the successful
rehearsal does not retire the live writer or prove its pending workspace safe.

The owner will perform the real authenticated browser edit/save journey once the
service is ready. No GitHub browser authentication state is available to this
agent. That manual gate remains NOT_CHECKED until actual results are recorded.

## Measured Cloudflare windows and operator preflight

Read-only analytics captured these API-returned adaptive Worker counts:

| UTC window, 2026-10-20 | Control Plane requests / subrequests / errors | Gateway requests / subrequests / errors |
| --- | --- | --- |
| 10:52–10:57 | 4 / 13 / 0 | 1 / 0 / 0 |
| 11:09–11:14 | 5 / 13 / 0 | 3 / 2 / 0 |

These are sampled/adaptive analytics windows containing active claimed work and
operator probes, not an empty/stopped idle acceptance run or a monthly forecast.
D1 whole-day aggregates were 2456 reads, 275 writes, 8638 rows read and 550 rows
written. Available Durable Object data was account-wide and includes unrelated
services, so it cannot certify Praetorium DO cost. Raw CPU fields retain API
units without speculative conversion. Exact queries, scope, timestamps,
measurement overhead and limitations are saved privately at
`/data/praetorium/production/verification/three-vm-cost-20261020.json`.
G8 remains unproved until suitable final-cut idle/active/outage windows pass.

## Management bootstrap and diagnostic deployment, 11:50 UTC

Source `9f9376314efc4bd63cb70d21df88d4bf6894d3b5` passed the required frozen
install and full check (30 Turbo tasks, provider boundaries and contract schema).
The retained-runtime observation issuer now permits a 30-second status-only
credential for the exact retained observed tuple when no operation is active;
mutation credentials and lifecycle fences are unchanged. Control Plane was
deployed from the canonical rendered inventory as version
`44ca3532-8ce9-45c6-a644-cbf9f535e704`, retaining the Coordination VPC binding.
Producer status and pending-work disposition still require a successful live
request; source tests alone do not establish those facts.

Canonical Gateway rendering previously omitted production authentication rate
limit bindings and environment configuration. The corrected renderer and
deployment probe were integrated and tested. Gateway-only deployment version
`ee5b55dc-9a5d-4d1f-809d-dd644f1e2272` returns HTTP 200 from `/auth/login` with
strict TLS verification. This is login-page availability, not a completed
GitHub OAuth or handoff journey.

The Management Ansible bootstrap installed rootless Coordination at the
verified `bf43bed8…` digest under dedicated UID 2001 and started its separate
Cloudflare Tunnel system service. A direct readiness request returned
`{"status":"ready"}` while Management's K3s service was inactive. The connector
registered four QUIC connections. A complete repeat apply returned
`ok=74 changed=0 failed=0`; the actual logs are protected under
`/data/praetorium/production/verification/management-bootstrap-*.log`.
The initial failed ACL and working-directory attempts remain recorded as failed
attempts. They are superseded by the successful corrected apply, not counted
as acceptance. Management reboot recovery and end-to-end VPC notification
delivery remain NOT_CHECKED.

The read-only recovery-artifact verifier also passed on the corrected encrypted
K3s bundle and its protected manifest, checking ciphertext size/SHA-256 and key
metadata without reading key contents. Full workspace preservation, quiesce,
writer absence, a fresh cutover snapshot, and Runtime Server-to-Agent conversion
remain pending. The retained writer has not been replaced.

The real three-host Ansible `ansible.builtin.ping --become` preflight succeeded
on all hosts with `changed=false`, using isolated ansible-core 2.20.10 and each
host's `/usr/bin/python3.14`. Canonical Cloudflare deployment `--check` with the
private inventory and secret manifest also passed: Worker secret names,
resources and active public-key registry are present, with no remote mutation.
This does not check the unregistered notification Worker secrets or execute the
still-gated D1 migration. Private inventory now includes the observed live
canary probe principal and the provisioned Coordination VPC service ID.
