# Scriptorium producer contract for Praetorium

Status: required cross-repository contract, not a claim of producer implementation. Authority: Epic #1 and [PLATFORM.md](PLATFORM.md). Only Scriptorium's coordinator publishes its producer implementation. Praetorium implements a consumer adapter, never an authentication bypass or a private fork of the writer.

## 1. Observed producer and closure rule

Inspected `yohn-jp/scriptorium@5ee8f0f0f0b9ee63b4920f2a73f3d76baa2cef1a`:

| Source path                        | Observed                                                                      | Required delta                                                                                                        |
| ---------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `scripts/profile-build.mjs`        | Only `--profile core                                                          | full`; resolves declared module dependency closure and emits server/browser registries                                | Serialized arbitrary validated selection; immutable build-kit output contract |
| `Dockerfile`                       | Node multi-stage build, port 3000, `/data`, static copied application outputs | Published Runtime Base/Build Kit plus actual composition build of all selected backend/browser assets                 |
| `packages/api/src/server.ts`       | `authToken: string`, local sessions; module runtime composition options       | Hosted grant verifier, per-request principal/permission, repository/runtime binding; standalone mode remains separate |
| `packages/core` and module-runtime | Current in-flight checkpoint/recovery and module work                         | Verified scoped credential renewal, status/activity and quiesce result used by Platform                               |

These observations establish specific missing seams, not a full current Scriptorium review. Refresh the producer SHA and actual public interfaces at T01. Any capability already delivered by that point is consumed, not reimplemented.

Record each required capability as `available` with source/artifact/proof, `in_progress` with the producer's existing work reference, or `missing` with exact field/action. Fixtures permit consumer development, not live certification. Do not declare the Platform complete using a fixture image or a shared static owner token.

## 2. Build protocol — `scriptorium-build/v1`

The producer publishes an immutable, approved catalog and two image/artifact identities:

- Runtime Base: minimum OS/runtime/Core host inputs, addressed by digest.
- Build Kit: trusted recipe/entry point plus exact product source or prebuilt packages, lockfile, toolchain, module artifacts and schemas, addressed by digest.

The recipe never reads an author's repository. Build authentication is only for approved product inputs/registry output and never becomes a layer. No branch tip, floating module version or network-selected latest package is an immutable input.

Praetorium consumes a versioned `BuildCatalog`:

```text
contractVersion, producerRevision, runtimeBaseDigest, buildKitDigest, recipeDigest,
lockDigest, supportedPlatforms[],
modules[{id, version, artifactDigest, requires[], conflicts[], contractRange,
         exclusiveResources, sharedResourceGroupIds[], workerLimits}],
baseResources{cpuMilli,memoryMiB,ephemeralStorageMiB},
sharedResourceGroups[{id,resources{cpuMilli,memoryMiB,ephemeralStorageMiB}}],
resourceProfiles[{id,cpuMilli,memoryMiB,ephemeralStorageMiB}]
```

T01 serializes these fields into JSON Schema with producer fixtures. Minimum declared resource demand is baseResources plus each resolved module's exclusiveResources plus each referenced sharedResourceGroup exactly once. All quantities are nonnegative integers in the named units; unknown groups, overflow or a chosen profile below the minimum are rejected. These are declared admission requirements, not guarantees of actual memory use; runtime limits and measurement remain required. Unknown versions, modules, dependencies, cycles or incompatible pairs are rejected. Use the producer's public resolution rules and conformance fixtures; do not create a second incompatible module resolver.

`BuildRequest` contains a request/attempt identity and canonical `BuildInput`: contract version, all above immutable identity inputs, requested and resolved module identities, target platform and output-affecting options. Praetorium controls registry destination separately. Resource allocation and repository/user identity are not build inputs unless a declared option truly changes public product bytes.

`BuildResult` binds build key, attempt lease, producer revision, actual manifest/platform digests, composition-manifest digest, selected/resolved modules, contract versions, SBOM/provenance references and verification results. Build worker output is untrusted until the Control Plane verifies its binding and registry bytes. Equal input is a deduplication identity, not an untested guarantee of bit-for-bit output; enforce deterministic recipe inputs and investigate divergent results rather than silently overwrite the admitted result.

Required producer checks: selected server and browser entries exist in the deployed artifact; unselected module/native runtime dependencies are absent; required shared modules are counted once; startup loads no excluded workers/models; image metadata matches the composition. Core/Full remain presets, not the only legal combinations.

## 3. Hosted runtime protocol — `scriptorium-platform/v1`

The producer declares listener/probe/metadata/shutdown paths and versions. Do not reuse Loom's port 3847 assumptions: the inspected Scriptorium image uses 3000. The adapter consumes declared, validated values rather than hard-coding undocumented endpoints.

Proposed private control surface for the versioned producer contract:

- `GET /api/platform/v1/status`: repository/runtime identity, image/composition identity, runtime readiness, activity, jobs, pending checkpoints and last confirmed remote revision.
- `POST /api/platform/v1/quiesce`: fence new mutations/jobs for a named operation/runtime epoch, settle existing operations and return a stable stopping disposition.
- `POST /api/platform/v1/resume`: idempotently release that quiesce only if operation/epoch still matches.

These names are new required interfaces, not existing endpoints. T01 serializes and tests them against the producer's implementation before real consumption. Normal public liveness must not reveal credentials, repository content or author activity details. Control endpoints require runtime-scoped service authentication and are not public user commands.

`RuntimeAssignment` contains instance ID, numeric GitHub repository ID, expected canonical locator/default-branch policy, runtime epoch, admitted image/composition identity, enabled module set, credential-broker locator and issuer/JWKS policy. This is deployment control configuration, not an arbitrary environment map. Resolve and verify the repository ID before clone; registration/mutation of unrelated repositories is forbidden in hosted mode. Standalone multi-repository behavior may continue outside hosted mode.

`AccessGrant` contains issuer, subject, audience, instance ID, repository ID, runtime epoch, permissions, session/authorization revision, issued-at, not-before, expiry and token ID. Verify the signature and every binding before serving user data or actions. UI, REST and MCP share the verifier and permissions. Checkpoint/approval/publish cannot use installation-token power to bypass the acting user's authorization.

No refresh credential or GitHub token is accessible to application browser JavaScript. Browser handoff/refresh operates through Platform Instance Access and Gateway. Application routes receive and verify only the scoped grant. Control-plane mutations and repository publication revalidate current authorization through a metadata-only service call; the canonical authoring transaction stays in Scriptorium.

## 4. Repository credentials and writer boundary

Use a `GitCredentialProvider` capable of renewing repository-scoped installation tokens for clone/fetch/push. Do not read a startup environment token once and assume it remains valid. A credential request binds instance, repository, runtime epoch and intended operation; a publish request additionally carries the acting principal and a fresh signed mutation authorization receipt bound to subject, repository, instance/epoch, operation ID, payload digest and expiry. Derive the principal from verified authentication; never trust a posted user ID. Validate App installation/repository scope at the broker and producer.

The producer keeps tokens in memory/ephemeral credential-helper files, never remote URLs, Git config committed to source, command logs, browser state or build inputs. Handle actual expiration and renewal failure explicitly. Never downgrade to a static global credential.

Local application writes are serialized per repository; remote GitHub changes still require fetch/revision/non-fast-forward checks. A single hosted writer does not exclude direct GitHub edits. Platform replacement fencing does not replace Core conflict control.

## 5. Quiesce, idle and recovery

`QuiesceRequest = {operationId, instanceId, runtimeEpoch, reason, deadline}`.

The response binds that request plus a quiesce revision and reports active mutations/jobs, unpublished checkpoint count, uncertain publication, last confirmed remote revision and `disposition: safe | blocked | unknown` with bounded reason codes. The app enters quiesce before reporting safety and rejects new mutation admission until a matching resume or process termination.

Safe defaults: zero active mutation, no uncertain push, no unpublished checkpoints, and jobs stopped or proven restartable with preserved semantic data. Pending checkpoints block automatic teardown/redeploy. Platform does not auto-publish author drafts. A browser saying it is connected, or a field saying IndexedDB exists, is not proof that all provisional data is recoverable.

Involuntary runtime failure remains possible; Scriptorium's browser journal is the recovery owner. A new container re-clones confirmed GitHub state and then reconciles the original browser journal without silent overwrites. Platform keeps the same origin/repository identity. No new Platform manuscript backup or merge implementation is introduced.

`status` separates user activity from health/polling and reports active API/MCP work and module jobs, so idle stop cannot kill a long operation merely because the editor tab is quiet. Quiesce timeout is blocked/unknown, never safe.

## 6. Exact producer acceptance handoff

| ID  | Producer deliverable                                               | Proof required before consumer certification                                                                                                      |
| --- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| S01 | Immutable Runtime Base/Build Kit and arbitrary composition request | Build Core plus two differing legal non-preset module selections; exact backend/browser/native dependency closure                                 |
| S02 | Hosted grants and role enforcement                                 | Wrong issuer/repository/instance/epoch/expiry denied; read cannot checkpoint/publish/configure; no static-token fallback                          |
| S03 | Single-repository bootstrap and credential provider                | Fresh clone, repository-ID mismatch rejection, actual token expiry/renewal and App-authorized push on an owned test repository                    |
| S04 | Activity/quiesce/resume                                            | In-flight request/job, pending checkpoint, uncertain push, duplicate quiesce and stale resume are safe; healthy empty state permits replacement   |
| S05 | Disposable reconstruction and public runtime metadata              | Real image replacement at stable origin, confirmed data restored and browser journal reconciled; metadata corroborated by OCI/runtime observation |

Praetorium's Sol records this handoff in `docs/migration/PRODUCER-STATUS.json` and coordinates with the existing Scriptorium implementation session. It must not edit that session's main, lockfile or worktrees. Missing S01–S05 block only dependent real-image gates while all independent fixed Platform tasks continue. The full migration cannot be called integrated until those gates pass; source/fixture availability is not producer acceptance.

## 7. Execution preflight handoff (2026-10-17)

Consumer checkpoint: the normative parsers live in `packages/contracts/src/producer.ts`, `build.ts`, `access.ts` and `artifact.ts`. The emitted JSON Schema includes structural and expressible conditional constraints. It cannot replace semantic validation of module graph/resource closure, cross-field host/origin and time bindings, uniqueness by module/group ID or operation/epoch state. Implementations in another language must enforce those semantic rules too. A shape-only JSON Schema validation is not conformance.

The actual producer preflight at `c90e95d9711e859799f9674138b2db42efad6bc3` is recorded in `docs/migration/PRODUCER-STATUS.json`. Existing producer coordinator retains all producer implementation ownership. S01–S05 remain dependent acceptance gates; no Platform fork, shared owner token, inferred assignment environment names or invented readiness flag substitutes for delivery.

The producer handoff must include the approved recipe invocation, versioned arbitrary-selection resolver and compatibility semantics, versioned composition manifest binding actual server/browser/native closure, hosted runtime assignment transport, control-service authentication and quiesce/status endpoints. Platform owns derived-image signing and admission; that signing must follow verification of actual registry bytes and composition evidence, never simply sign a worker's echoed input.
