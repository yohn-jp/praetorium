# Operational convergence — 2026-10-25

Status: ACTIVE. No final production acceptance is claimed.

Owner: Sol. Authority: latest owner Goal; AGENTS.md; docs/GOAL.md G1–G9; Issues #31/#66; Epic #1; UX-CONTRACT.md; accepted Management/Admin architecture.

## Shared refreshed baseline

Main: `d3c8e3321bc6664ae2c5b56b7eb15e7a9f2db555` (clean). PR #68 refreshed head: `93f299f175701b9e25f51d8dd23f3080818d3ac0`. Its actual PR changes are merged locally into pinned integration base `04ada1b53ba062709c560280d01a5078886023e6`; no main merge or production deployment performed. This preserves the current main runtime credential changes. Main CI run 40105731186 succeeded. PR #68 verify, Kubernetes admission, candidate images, external MCP checks succeeded; Source fixture was still running at initial readback. Published Scriptorium latest is v0.3.7 (2026-10-24T11:52:16Z).

| Component | Expected SHA/digest/config | Actual | Health | Discrepancy | Owner |
| --- | --- | --- | --- | --- | --- |
| Gateway | pinned candidate plus #68 | version 665338f1-f6d6-4cb8-9484-b929c7a57b89; minimal live module patches recorded in #68 | public ingress previously proven; refreshed probe pending | exact reproducible candidate bundle not yet deployed | D / Sol |
| Control Plane | candidate; automatic 60-second real Canary | version 2209b804-5bd7-4d8e-a19f-c2aaa87d12e1; Cron */5; default Canary 10 min | API deployment readback PASS | source/config change needed for bounded automatic progression | A / Sol |
| Admin | independent Worker + Gateway identity broker + Observer | version 86b1edcf-b519-47f5-a535-66c203acd83f; bindings present | readback PASS | authenticated end-to-end acceptance unverified | E |
| D1 / DO / KV | canonical migration history, retained identities | migrations through 0008_source_build_diagnostics.sql; Gateway and CP DO/KV bindings present | read-only query PASS | candidate migration reconciliation pending | A / Sol |
| Management | K3s server, rootless Coordination/Observer | manage Ready, control-plane/etcd, v1.35.9+k3s1; both user services active; tunnel active | PASS observations | exact service image readback pending | F |
| Runtime | K3s Agent | runtime Ready; k3s inactive, k3s-agent active; v1.35.9+k3s1 | PASS observations | writer/lifecycle acceptance pending | B |
| Build Worker | inventory digest | sha256:09aacb9f48eeef765c1f3acccd4d378e67100e6017d91c8845d0aa48a4c496ce | 1/1 Ready | exact final source cut pending | C |
| Provisioner | inventory digest | sha256:25cd6902063ba0ce6afaa435e76744c19d6feac531145b277a3b17850398a3b0 | 1/1 Ready | exact final source cut pending | B |
| Instance Access | inventory digest | sha256:533023bcd254e07a0b15787a68c39cb9dd5d914dfc82482df21709e49f041b78 | 1/1 Ready | exact final source cut pending | B / D |
| BuildKit | existing rootless mTLS builder | praetorium-buildkit.service active, private 10.7.0.32:1234 | listener/service PASS | solve/registry acceptance pending | C / F |
| Routing / TLS | existing Caddy L4 → Traefik direct app path | Traefik 2/2, certificates Ready; one tenant ingress; stopped fallback present | partial PASS | independent refreshed HTTPS + authenticated MCP pending | D / F |
| Scriptorium | verified admitted artifact | running digest sha256:2d21804e6a3686ff141afc4299259d60c245a3395d312c943a436ef25dd2e6f4; separate canary stopped | 1/1 Ready | actual Release/author/GitHub journey unverified | all / Sol |
| Browser identities | owned test principals and disposable resources | prior record explicitly BLOCKED_NO_AUTHENTICATED_SESSION | NOT_CHECKED current access | no authenticated production browser proof yet | Sol / F |

Source defects, config drift and unverified gates above are distinct. Historical Issue #31 image permission incidents and #66 WAN/CIMD/consent causes already have evidence and are not reopened without a new failure. Protected private inventory/credentials/backups are under `/data/praetorium/production`; raw new Worker snapshots are in mode-0700 `/tmp/praetorium-convergence-private`. They must not be committed.

Toolchain: Node 24.21.0, corepack 0.36.0, pnpm 11.18.0 frozen install PASS. Shared host filesystem had 21 GiB available; Runtime 23 GiB; Builder 12 GiB. Existing worktrees preserved. GitHub authenticated as yohnark; Cloudflare readback and SSH to all three VM aliases work. No credentials emitted. Browser executable/owned authenticated inputs still being checked.

## Fixed implementation ownership

All six workers start from the pinned integration base. A: apps/control-plane and packages/persistence (migration changes require Sol assignment). B: apps/provisioner, apps/instance-access, plugins/kubernetes. C: apps/build-worker, plugins/buildkit, plugins/ghcr, plugins/scriptorium source composition integrations. D: apps/gateway, packages/auth and Gateway-only browser tests. E: apps/admin and Admin-only browser tests. F: infrastructure, scripts/deploy-* and operational acceptance harnesses (excluding D/E-owned tests). Shared contracts, migration numbering, root manifests/lockfile, shared wiring, deployment and final acceptance belong to Sol. No worker merges or deploys production.

## Acceptance ledger

G1–G9, F01–F14, R01–R07 and P-A01–P-A12: NOT_CHECKED on the final deployed cut. Component observations above do not close these gates. Real Release → Build → OCI → Admission → Canary → Stable, editor Save/Git readback, OAuth/MCP and recovery remain mandatory.


## Integrated candidate and actual operations

PR #68 was independently merged to main at 2026-10-24T15:35:37Z as `ee9aeedebd71c1edbd2f54029f8d217c5f3ee73e` while this campaign was running. Its identical source changes were reconciled without rewriting history. All six worktrees began at `45ade9494138fea6e78a81d1f332d032578a56e8`, which contains the recorded integration base plus this baseline.

| Observed defect | Cause / correction | Integrated commit | Regression / actual result |
| --- | --- | --- | --- |
| Canary cannot normally complete a one-minute observation | shared default was ten minutes; D1 sample deadline five minutes | `940fe25`, `64b67c7` | CP 67 focused tests, promotion 14 tests; normal post-write callback, full-minute boundary, outage resets window and cleanup-before-Stable tested; Hosted timed progression NOT_CHECKED |
| Drifted HTTP route displayed as HTTPS runtime endpoint | inspection accepted Host plus Service without the secure route structure | `2484bd7` | Kubernetes 54 tests; drift from websecure/TLS suppresses endpoint |
| Admin Release detail contradicts current Stable list | detail skipped canonical catalog read and substituted null Stable pointer | `3369b48` | Admin 74 tests; real pre-fix contradiction reproduced; browser regression covers pointer plus upstream unavailable; deployed correction NOT_CHECKED |
| Local Gateway security browser runner cannot start / follows stale entry contract | missing Workers test stub, required RateLimit bindings and obsolete entry/login path | `08c2d74` | actual local browser runner PASS, Gateway 311 and Auth 43 tests PASS; fixture only |

At code candidate `021b3f7a46e5c682ffbe92a47aef640a1844729a`, frozen install and full `check` PASS with nested pnpm pinned to 11.18.0 using an existing temporary PATH shim (host bare pnpm is 12.10.1). Independent read-only review of the complete diff against refreshed main found no blocking changed-code defect, but explicitly withheld operational acceptance pending the live startup failure and deployment. No production code rollout has occurred yet.

Shared persistent Playwright was discovered at the operator's configured profile. The actual GitHub session successfully authenticated user 213253858. Separate isolated contexts performed real Admin navigation at desktop 1440/1920 and mobile 320/375/390/430, including keyboard/touch/back/forward and Source/Release/Operation drilldown, with no horizontal overflow and no operator mutations. The failing source, attempt history and guarded retry were visible. These observations precede the final deployed cut and do not close all UX scenarios.

Real authenticated MCP on running instance repository 1289100245: published discovery, public DCR, authorization code + S256 PKCE, read consent, token exchange, initialize (2025-03-26) and tools/list (33 tools) PASS; invalid bearer rejected 401. No tool execution, manuscript read or write was performed. On owned canary repository 1423923158, valid initialize truthfully returned 503 INSTANCE_STARTING / Retry-After 5. External probe from SSH host stardomain independently passed HTTPS, anonymous MCP challenge, resource/issuer discovery and CIMD login redirect. Path-specific protected-resource /mcp metadata remains 404; the canonical advertised root metadata works.

Owned repository 1423923158 was stopped at readback. A real Start through Gateway accepted operation `op_01M5Q9CFZ1CAGVZKG4KVSC2Z1N` at 15:45Z; the resulting Pod failed startup with `A repository-scoped Git credential could not be issued`, exit 1 and CrashLoopBackOff. This is a blocking actual result, not a successful startup. Runtime owner is tracing the identity/broker boundary. Existing user manuscript data is protected.

Current public latest Scriptorium is still v0.3.7 / GitHub Release 422701682, already Stable in the actual Admin. A new eligible published source is required to demonstrate a fresh automatic 60-second promotion without modifying canonical history; the separately coordinated Scriptorium owner has been informed. No release or Stable state was fabricated.

Before pending migration 0009, a fresh remote D1 export was captured in the protected production backup directory, restored into isolated local SQLite (integrity_check ok; two logical instance rows retained), and migration-rehearsed there. Rehearsal preserves the evidence-backed running writer's authority and leaves an unverified canary target without authority. Export and migration checksums were encrypted with the repository artifact tool; authenticated decryption matched the original tar SHA256. This proves a local snapshot/restore rehearsal, not off-host Restic backup or production rollback. Production migration, immutable rollout and actual forward recovery remain NOT_CHECKED.

Observed console errors include Cloudflare-injected analytics scripts rejected by the existing CSP. Both available Cloudflare credentials received 403 when reading account RUM settings. Preserve CSP; exact RUM/edge injection setting and reconciliation remain BLOCKED on the necessary account-settings permission. No app policy was weakened to silence this error. Raw session state, tokens, SQL, settings, traces and manuscript data remain private; only sanitized observations are recorded here.
