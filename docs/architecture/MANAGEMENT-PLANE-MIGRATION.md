# Praetorium — Management Plane / Admin Worker Migration Contract

> **Status:** ACCEPTED ARCHITECTURE MIGRATION GATES. This document specifies prerequisites and acceptance criteria, not a deployment history or a claim of completion. The canonical topology and management design are [MANAGEMENT-PLANE.md](MANAGEMENT-PLANE.md) and [ADMINISTRATION.md](ADMINISTRATION.md). Deployment observations belong in [verification](../verification/README.md).
> **Authority:** Latest owner instructions, [Epic #1](https://github.com/yohn-jp/praetorium/issues/1), [GOAL.md](../GOAL.md), and relevant implementation Issues. This document grants no production-change authority.

## Invariants

- Management owns host k3s Server, independent Coordination, and read-only infrastructure observability; Runtime owns k3s Agent and tenant workload; Builder owns rootless BuildKit and OCI cache.
- Cloudflare Control Plane/D1 remains authoritative for repository binding, desired state, Build/Operation/Release and audit. Kubernetes owns observed resources; GitHub owns permissions and confirmed source history.
- Preserve authentication, immutable artifact admission, generation/epoch/CAS, leases, idempotency, quiesce and single-writer evidence.
- Admin Worker has its own custom domain and deployment, but uses Gateway’s existing OAuth/Session authority through private, bounded service-binding RPC; no new identity database or leaked browser credentials.
- Observer remains read-only and separate from Coordination work notifications. No unrestricted SSH, Kubernetes mutation, arbitrary BuildKit command, or direct D1 mutation.
- Changes to an existing live cluster require preflight readback and environment-specific backup/restore evidence. Previous bootstrap or migration activity does not authorize new destructive operations.

## Implementation and acceptance gates

| Gate | Required outcome |
| --- | --- |
| Infrastructure inventory | All host roles, services, private endpoints, Kubernetes nodes, Cloudflare bindings and ownership resolve to the intended infrastructure |
| Recovery | Cluster datastore/token/CA and application persistence are restorable without violating writer safety |
| Work notification | Persisted D1 work survives lost/duplicate hints, VM/Worker restarts, lease expiry and retry; no duplicate side effects |
| Identity broker | One-use Admin handoff, session expiry/revocation, operator allowlist, CSRF and scoped GitHub Source verification preserve current behavior |
| Admin isolation | Separate `apps/admin` Worker and exclusive Admin custom domain; anonymous/non-admin calls denied and Gateway tenant routing unaffected |
| Observability | Management/Runtime/Builder inventory, host metrics, service status and dependency checks work with bounded read-only privileges, stale/unavailable distinguished |
| Operator UX | Desktop/mobile interfaces present independent task flows, diagnostic details and only canonical, authorized release/build retry actions |
| Rollout/rollback | Preview tests, explicit domain ownership transfer, production Browser/API checks, rollback to prior Worker without erasing sessions or D1 data |
| Cost | No new high-frequency empty Cloudflare polling; actual Worker/D1/DO and host resource usage measured |
| Hosted completion | [GOAL G1–G9](../GOAL.md) and relevant issue acceptance proven separately from Admin and infrastructure availability |

## Failure behavior

Gateway identity unavailable: Admin authorization fails closed. Admin Worker unavailable: Gateway and Scriptorium continue independently. Control Plane unavailable: Work and Release information is unavailable rather than an empty successful result. Management unavailable: the UI displays unreachable status and last known observation separately from the canonical D1 state. k3s unavailable: Coordination and Observer remain independently diagnosable. Runtime/Builder unavailable: only the affected hosts and dependent work are marked degraded or unknown; execution is not automatically retried without canonical authorization.

## Domain migration

Validate new Admin Worker without attaching the production domain first. Verify handoff, cookies, CSRF, session rejection, Source/Release operations, and Gateway user flows. Transfer `admin.praetorium.yohn.jp` to the Admin Worker as its sole owner and remove the matching Gateway route. Perform real Browser/API readback. If validation fails, restore the former Gateway domain route and previous Worker deployment while preserving existing DO/D1 state and user data.

## Evidence storage

Record commit and image digests, deployed Worker bindings and domains, observed states, timestamps, browser results, outages and recovery evidence in [verification](../verification/README.md), not in this architecture contract. Unsupported cases remain NOT_CHECKED rather than presumed successful.
