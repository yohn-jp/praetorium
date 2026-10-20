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
| K3s token/CA/datastore/PVC backup and independent recovery | NOT_CHECKED | Actual restored identities, resources and durable data; rollback rehearsal |
| Management host-systemd K3s Server; Runtime Agent | NOT_CHECKED | Live node roles, CA/cluster continuity and systemd state |
| Rootless independent Quadlet Coordination | NOT_CHECKED | Dedicated UID, digest, reboot recovery and health with K3s stopped |
| Management tenant exclusion and future Agent placement | NOT_CHECKED | Node taint/labels and rendered/observed tenant affinity |
| Existing BuildKit/cache preserved and bounded | IN PROGRESS | Version/cache identity, actual build peak, GC and resource limits |
| Authenticated private work delivery and recovery | NOT_CHECKED | Duplicate/lost hint, coordinator restart, D1 fencing and bounded recovery |
| Issue #24 HTTPS, SNI, DNS-01, default TLSStore | FAILED public TLS | Trusted external TLS and observed Caddy/Traefik/cert-manager path |
| Ready/stopped handoff routing and auth rejection | NOT_CHECKED | Real POST, Origin, 303, cookies, replay/expiry and unauthorized checks |
| GitHub login, two principals and access revocation | NOT_CHECKED | Real browser/session/permission evidence (G1/G2) |
| Real edit, checkpoint, GitHub save and reload | NOT_CHECKED | Confirmed remote commit/content and browser recovery (G3) |
| Two admitted compositions and identical-input cache reuse | NOT_CHECKED | Producer/build-input revisions, OCI digests/signature and runtime readiness (G4) |
| Stop/wake/redeploy, pending work protection, writer absence | NOT_CHECKED | Current-epoch quiesce and actual writer census (G5) |
| Stable/pinned rollout and fault recovery | NOT_CHECKED | Real release/canary/retry/interruption evidence (G6) |
| Infrastructure/credential/network isolation | NOT_CHECKED | Actual RBAC/admission/network/build isolation (G7) |
| Cloudflare idle/active/outage request counts and VM measurements | NOT_CHECKED | Observed counts and before/after resources, not theoretical estimates (G8) |
| Exact release cut, CI, independent review and reproducible deployment | NOT_CHECKED | Green final checks, reviewed immutable digests and actual operational release (G9) |

Final report must include main HEAD, each VM's live state, deployed digests,
actual E2E results, remaining requirements, and recovery/runbook paths. Keep
this campaign active until all owner requirements and original G1–G9 pass.
