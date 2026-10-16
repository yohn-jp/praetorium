# Praetorium

Repository-scoped Scriptorium orchestration with GitHub App access, immutable composition builds and safe runtime replacement.

The implementation campaign is governed by [Epic #1](https://github.com/yohn-jp/praetorium/issues/1), [architecture](docs/architecture/PLATFORM.md), [producer contract](docs/architecture/SCRIPTORIUM-CONTRACT.md) and [migration plan](docs/migration/PLAN.md). See the coverage ledger for current evidence; planning documents do not certify a deployment.

Requires Node 24.21.0 and pnpm 11.18.0:

```sh
corepack pnpm@11.18.0 install --frozen-lockfile
corepack pnpm@11.18.0 check
```

Normal authoring traffic goes directly to instance ingress. Platform control metadata uses Workers/D1/DO; independent Node workers perform builds and runtime reconciliation. No production deployment is authorized by local verification.
