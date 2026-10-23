# Praetorium

Praetorium provides repository-scoped Scriptorium instances with GitHub App authorization, selected-module immutable OCI composition, safe on-demand runtime lifecycle, and direct stable-origin access.

**Product authority:** [Initial Epic #1](https://github.com/yohn-jp/praetorium/issues/1) plus the owner's latest explicit instructions. The existing source tree and historical design documents are *not* presumed to be correct merely because they are implemented. CI is permitted under the current instruction; release publication and production deployment remain separate actions.

## Architecture: read these first

1. [Management/Coordination/Execution](docs/architecture/MANAGEMENT-PLANE.md) — the accepted three-VM responsibilities and the three-VM topology. Runtime hosts the Agent and tenant workloads; Builder keeps rootless BuildKit; Management owns k3s Server and Coordination.
2. [Admin Plane architecture](docs/architecture/ADMINISTRATION.md) — **accepted target**: independent `apps/admin` Worker/`admin.praetorium.yohn.jp`, existing Gateway OAuth/DO identity authority, Control Plane/D1 state, read-only three-VM observability, desktop/mobile and migration gates. The Worker split is **not implemented** in the existing Gateway implementation.
3. [Migration/verification gates](docs/architecture/MANAGEMENT-PLANE-MIGRATION.md) — dated actual evidence vs unverified Hosted/notification/Admin gates.

Older source-cut traces remain available: [System actors](docs/architecture/SYSTEM.md), [Execution](docs/architecture/EXECUTION.md), [Audit](docs/architecture/REVIEW.md) (legacy implementation references, **not the target VM topology**).

[Full documentation index](docs/README.md) classifies current explanations, producer wire contracts, deployment runbooks, migration history and dated verification evidence. Historical [PLATFORM.md](docs/architecture/PLATFORM.md), [SCRIPTORIUM-CONTRACT.md](docs/architecture/SCRIPTORIUM-CONTRACT.md), and [migration plan](docs/migration/PLAN.md) remain available as references rather than being a competing source of product requirements.

## Code and tooling

Requires Node 24.21.0+ (less than 25) and pnpm 11.18.0:

```sh
corepack pnpm@11.18.0 install --frozen-lockfile
corepack pnpm@11.18.0 check
```

The control metadata API runs in Workers/D1/DO; Scriptorium's normal editing traffic reaches its K3s instance origin directly. Runtime Pod health belongs to Kubernetes, while desired state and authorization are separate. Older code-cut traces and current implementation are not interchangeable; consult the exact `main` source and dated evidence for polling/notification and running versions.

## Acceptance / deployment status

The [Three-VM bootstrap evidence](docs/verification/THREE-VM-INFRA.md) confirms a new Management k3s Server, Runtime Agent and independent Builder, plus documented recovery checks; it **does not** certify Hosted Scriptorium. The [Hosted integration evidence](docs/verification/HOSTED-ACCEPTANCE-a669f5c.json) and [GOAL G1–G9](docs/GOAL.md) still require source-cut-specific product acceptance.

A clean build or CI pass is not a license to apply Cloudflare resources, change production cluster state, rotate keys, publish an artifact, or delete user/legacy data. For explicit preflight, owned inventory and deployment operations, see [deployment runbooks](docs/deployment/REPRODUCIBLE-DEPLOYMENT.md).
