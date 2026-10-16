# T14 integrated acceptance record

Status: **BLOCKED** at `4538bc3cdbc998b5b9aaefd67692ce15b79bd41e` on 2026-10-17. This is an evidence cut, not a certification of the integrated system.

The T12 inventory at `infrastructure/test/acceptance-inventory.json` is still an unprovisioned draft. Its owner identity is `operator-supplied before provisioning`, and all seven required categories are declared missing. The explicit `--plan` invocation returned exit code 2 with `BLOCKED` / `NOT_CHECKED` for every category and `effectsExecuted: false`.

A fixed Control Plane acceptance runner now targets only `apps/control-plane/src/worker.ts`. It bundles that source with esbuild, applies the actual checked-in D1 migrations to ephemeral Miniflare D1 storage, and exercises concurrent repository binding through `RepositoryCoordinator`, desired-state idempotency, an unclaimable instance without an admitted artifact, and D1/DO persistence after a Worker restart. It requires a valid T14 inventory and fails if the production Worker entry is absent; it does not substitute an app fixture. The entry is not present at this evidence cut, so the runner was not executed.

An explicitly owned local substrate proved a generic `FROM scratch` BuildKit push and a generic OCI Distribution client round-trip against the disposable registry bound to loopback. BuildKit pushed `127.0.0.1:39567/praetorium-substrate/smoke:probe-nocache` at `sha256:ea44323dade82d7a22a7b3bdfdf0ed244fdd91f26fc539e61ae12fa13caaf141`. The T05 GHCR client resolved `praetorium-t05/probe:t05-roundtrip` to `sha256:e86e73bd4bf12b319b27847b1cd184e67f6e0722a7cdab758e74f44d4137df8d`; a fresh T14 read verified the manifest, 228-byte config, and 141-byte layer against their SHA-256 digests. These substrate probes use no Scriptorium artifact and do not verify composition admission or S01-S05.

The local Chromium capability smoke passed with Chrome `156.0.8078.4` and loaded only a local `data:` page. There is no integrated Gateway/Instance Access Worker route or owned stable browser origin. A kind image extraction attempt failed with `ENOSPC` before cluster creation. No GitHub App credentials, authorized users, or test repository were configured. Producer handoff [PRODUCER-STATUS.json](../migration/PRODUCER-STATUS.json) still marks S01-S05 missing and blocked.

The handler inventory in [SOURCE-HANDLERS.json](../migration/SOURCE-HANDLERS.json) maps 65 legacy handler surfaces across 28 source files at immutable Arcadia revision `b96a03a8734bfff2e5b965e6966007c45a2c7dc9`. This is source reconciliation, not runtime acceptance. The nine harness tests pass and cover strict inventory validation, effect-free planning, rejection of executable inventory fields, environment isolation, and mapping handler surfaces to the current migration coverage ledger.

At this evidence cut, `corepack pnpm@11.18.0 install --frozen-lockfile` fails because the lockfile lacks workspace dependency entries for the newly integrated Build Worker and BuildKit packages. `pnpm check` passed after pnpm locally resolved those entries; I restored the lock diff because the root lockfile is Sol-owned. The frozen install must pass after root synchronizes the lockfile before treating workspace verification as reproducible.

| Required category      | Status  | Proof status | Current evidence or blocker                                                                                |
| ---------------------- | ------- | ------------ | ---------------------------------------------------------------------------------------------------------- |
| `workers-d1-do`        | BLOCKED | NOT_CHECKED  | Fixed runner exists; production Worker entry and actual D1/DO run are absent.                              |
| `github-access`        | BLOCKED | NOT_CHECKED  | No owned test GitHub App, users, repository, or credentials.                                               |
| `buildkit-registry`    | BLOCKED | NOT_CHECKED  | Generic local BuildKit/OCI substrate round-trips passed; actual producer composition/admission is missing. |
| `kubernetes-isolation` | BLOCKED | NOT_CHECKED  | No cluster; kind image extraction stopped with `ENOSPC`.                                                   |
| `browser-entry`        | BLOCKED | NOT_CHECKED  | Browser capability passed; integrated route and stable test origin are absent.                             |
| `producer-recovery`    | BLOCKED | NOT_CHECKED  | S01-S05 and real producer artifact/recovery evidence are missing.                                          |
| `stable-rollout`       | BLOCKED | NOT_CHECKED  | Integrated rollout proof, disposable cluster, producer artifact, and canary evidence are absent.           |

The fixed runner paths for the remaining six categories are not present at this HEAD. Their inventory entries remain blocked; the harness never treats missing runners as successful skips. Continue with an explicitly owned environment inventory and actual product runners when the corresponding application entry points and resources are integrated. Do not use production credentials, an inferred host/cluster, or generic fixtures as producer acceptance.
