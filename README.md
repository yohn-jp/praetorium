# Praetorium

Praetorium provides repository-scoped Scriptorium instances with GitHub App authorization, selected-module immutable OCI composition, safe on-demand runtime lifecycle, and direct stable-origin access.

**Product authority:** [Initial Epic #1](https://github.com/yohn-jp/praetorium/issues/1) plus the owner's latest explicit instructions. The existing source tree and historical design documents are *not* presumed to be correct merely because they are implemented. CI is permitted under the current instruction; release publication and production deployment remain separate actions.

## Architecture: read these first

1. [System map and responsibility boundaries](docs/architecture/SYSTEM.md) — what each actor owns: Cloudflare Workers, D1, Durable Objects, KV, Kubernetes, Provisioner, Build Worker, BuildKit, Scriptorium, GitHub, OCI registry, and infrastructure.
2. [End-to-end execution and triggers](docs/architecture/EXECUTION.md) — login/wake, handoff, build/admission, quiesce/redeploy, idle deadlines, token renewal, stable rollout, and Cloudflare call frequency.
3. [Requirement-based architecture review](docs/architecture/REVIEW.md) — verified code behavior, defects and unnecessary work, preserved safety mechanisms, open decisions.

[Full documentation index](docs/README.md) classifies current explanations, producer wire contracts, deployment runbooks, migration history and dated verification evidence. Historical [PLATFORM.md](docs/architecture/PLATFORM.md), [SCRIPTORIUM-CONTRACT.md](docs/architecture/SCRIPTORIUM-CONTRACT.md), and [migration plan](docs/migration/PLAN.md) remain available as references rather than being a competing source of product requirements.

## Code and tooling

Requires Node 24.21.0+ (less than 25) and pnpm 11.18.0:

```sh
corepack pnpm@11.18.0 install --frozen-lockfile
corepack pnpm@11.18.0 check
```

The control metadata API runs in Workers/D1/DO; Scriptorium's normal editing traffic reaches its K3s instance origin directly. Runtime Pod health belongs to Kubernetes, while desired state and authorization are separate. See the architecture trace for the actual current poll/cron implementation and its open issues.

## Acceptance / deployment status

The [Ubuntu 26.04 VM validation](docs/verification/UBUNTU-2604-20261017.md) records a working K3s host, separate rootless BuildKit host and real generic OCI build/reboot checks. It **does not** certify Hosted Scriptorium. The [Hosted integration evidence](docs/verification/HOSTED-ACCEPTANCE-a669f5c.json) still records unexecuted/blocked product categories at its named source cut.

A clean build or CI pass is not a license to apply Cloudflare resources, change production cluster state, rotate keys, publish an artifact, or delete user/legacy data. For explicit preflight, owned inventory and deployment operations, see [deployment runbooks](docs/deployment/REPRODUCIBLE-DEPLOYMENT.md).
