# T14 integrated acceptance record

Status: **BLOCKED**. This record reflects the Praetorium product checkout at `6884c185e542b9a64ea2fc2591cdf989729d6180` on 2026-10-17. It records a capability and source inventory check, not an integrated-runtime run.

The checkout contains Gateway UI, GitHub access, Scriptorium adapter, GHCR client and legacy recovery source, but no deployable Worker or Control Plane bundle, local D1/DO binding configuration, BuildKit or owned OCI registry setup, disposable Kubernetes setup, or browser test origin. The local runtime probe found Node `v24.21.0` and pnpm `11.18.0`; the workspace has Wrangler `4.118.0`, Miniflare `4.20260730.0`, and Playwright `1.64.1`. Global Wrangler, Docker, Podman, BuildKit, nerdctl, kubectl, k3d and kind were absent from the shell `PATH`. A cached Playwright Chromium executable runs with the local library overlay, reports Chrome `156.0.8078.4`, and has no unresolved shared libraries in that environment. A browser capability smoke loaded only a local `data:` URL; no product page or product process was started.

At the preceding candidate `219bd8e`, frozen pnpm 11.18.0 install passed, but workspace `check` failed during lint on two integrated GitHub-auth-package errors: `packages/auth/src/access-grant.ts:2` requires `import type`, and `packages/auth/src/oauth/flow.ts:84` uses a forbidden `import()` type annotation. At the recorded HEAD `6884c18`, the frozen install fails because `pnpm-lock.yaml` omits eight dependencies declared by `plugins/ghcr/package.json`, so `check` was not rerun at this evidence cut. I reported both root-owned findings to Sol and did not change those files.

T12 supplied a separate-worktree draft at `infrastructure/test/acceptance-inventory.json`. The T14 plan runner read it explicitly and returned exit code 2 with `BLOCKED`; the owner identity is still `operator-supplied before provisioning` and all seven resources are declared missing. The effect plan ran in plan-only mode and executed no effects. The draft is not an owned environment.

The producer handoff at `docs/migration/PRODUCER-STATUS.json` marks S01–S05 `missing` and `BLOCKED`, with no artifact digest. Fixtures and the T01 schema are not producer proof. The exact legacy handler map expanded for reconciliation is in [SOURCE-HANDLERS.json](../migration/SOURCE-HANDLERS.json), pinned to source revision `b96a03a8734bfff2e5b965e6966007c45a2c7dc9`.

Eight harness tests using fixture-only inventory data passed for fail-closed behavior, strict inventory shape, structured missing gates, no-effect planning, command-field rejection, credential isolation, and explicit production rejection. They verify the harness only. They do not exercise any product acceptance criterion. The fixed category runner files are also absent at this HEAD, so no real acceptance suite was started.

| Required category      | Status  | Proof status | Current blocker                                                                               |
| ---------------------- | ------- | ------------ | --------------------------------------------------------------------------------------------- |
| `workers-d1-do`        | BLOCKED | NOT_CHECKED  | No production Worker bundles, local D1/DO bindings or owned inventory.                        |
| `github-access`        | BLOCKED | NOT_CHECKED  | No explicitly owned test GitHub App, authorized test users or test repository.                |
| `buildkit-registry`    | BLOCKED | NOT_CHECKED  | No local BuildKit runtime or owned disposable OCI registry with immutable producer artifacts. |
| `kubernetes-isolation` | BLOCKED | NOT_CHECKED  | No disposable cluster/ingress or Kubernetes runtime tooling.                                  |
| `browser-entry`        | BLOCKED | NOT_CHECKED  | No integrated Gateway/Instance Access route or explicitly owned stable test origin.           |
| `producer-recovery`    | BLOCKED | NOT_CHECKED  | Producer gates S01–S05 remain missing; no real producer image or recovery proof.              |
| `stable-rollout`       | BLOCKED | NOT_CHECKED  | No integrated rollout implementation, cluster, registry or canary evidence.                   |

Run the inventory plan after T12's inventory is integrated and an operator fills its owner identity and owned resources. The command emits a fixed effect plan and performs no effects:

```sh
node scripts/verify-integration.mjs --plan --environment infrastructure/test/acceptance-inventory.json
```

The inventory requires a named owner and identity, a `t14-disposable-test` environment, an explicit disposable/non-production declaration, a future expiry, and cleanup instructions. Each available category repeats the owner and disposable/non-production declarations and gives a resource reference. Missing categories may have a null reference, but remain blocked. References identify resources only; the schema has no command or executable field.

The execution form validates the same ownership and lifetime fields before running fixed repository-local test paths in a fresh home directory without inheriting ambient credentials or tool configuration. It never evaluates inventory-provided commands. Missing categories exit nonzero and retain `BLOCKED` / `NOT_CHECKED` results. A plan result does not certify acceptance.

T14 remains incomplete until the production Worker bundle passes against local D1/DO, real BuildKit/OCI and disposable Kubernetes are exercised, the browser and repository flows use explicitly owned resources, and an actual Scriptorium composition passes S01–S05 recovery and rollout checks. Record candidate SHAs, image digests, environment inventory ID, measurements and failures in `ACCEPTANCE.json` after that attempt. Do not use production credentials or inferred host/cluster context.
