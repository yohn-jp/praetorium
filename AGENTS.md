# Praetorium

Authority: Epic #1, current owner instructions, docs/architecture/PLATFORM.md and docs/migration/PLAN.md.
Use TypeScript/Node 24, pnpm 11.18.0 and explicit provider packages. Repository identity is numeric GitHub repository ID; user membership is never an independent instance ACL.
Sol integrates main; implementation workers use isolated worktrees; reviewers are read-only and separate from implementers. Root manifests/lockfile, contracts, D1 migration order and final wiring are Sol-owned.
No GitHub Actions, template sync or Inari. Source Arcadia and producer Scriptorium are read-only; missing producer contracts are explicit handoffs.
Do not apply production infrastructure, rotate keys, publish releases/packages or delete legacy data. Tests use explicitly owned disposable environments. Record blocked and unexecuted gates accurately.
Run `corepack pnpm@11.18.0 install --frozen-lockfile` and `corepack pnpm@11.18.0 check`. Never treat unit fixtures as real producer acceptance.
