# T14 producer-recovery feasibility and handoff

**Status at Praetorium `ebb9f23a`: unimplemented / NOT_CHECKED.** No fixed producer-recovery runner is present. The missing producer ABI prevents the real Gateway → Control Plane → Provisioner → Kubernetes → Scriptorium recovery path from executing; a preflight-only file or passing local fixture would not provide acceptance evidence.

## Production-path evidence

The Control Plane can resolve an admitted revision into the structured `RuntimeAssignment` from repository binding, immutable artifact statement, runtime metadata and the operation's epoch in [`runtime-context.ts`](../../apps/control-plane/src/runtime-context.ts#L75). It includes repository ID/locator, image and composition digests, enabled module IDs, credential broker locator, and the grant/control service issuer policies. The same module returns the current and target runtime assignments in the claimed operation context. This is the producer's intended input, not proof that the producer receives it.

The Provisioner production startup explicitly wires `UnavailableRuntimeAssignmentTransport` and `UnavailableRuntimeAuthAcceptanceProbe` in [`main.ts`](../../apps/provisioner/src/main.ts#L108). The executor's `canExecute` requires both transports, and returns a blocked result before lifecycle effects when either is unavailable in [`lifecycle-executor.ts`](../../apps/provisioner/src/lifecycle-executor.ts#L113) and [the capability checks](../../apps/provisioner/src/lifecycle-executor.ts#L160). The production worker therefore remains unready and claims no operations.

The Kubernetes renderer receives structured assignment identity and release data but sets `runtimeConfig: {}`. Its comment says that the T07 renderer does not consume the assignment and that no undocumented environment map is synthesized in [`kubernetes-lifecycle-adapter.ts`](../../apps/provisioner/src/kubernetes-lifecycle-adapter.ts#L93). Inventing an environment variable, file mount, ConfigMap, or runtime callback in a test would make that test exercise a new ABI rather than the production path.

There is a real Platform HTTP client for the producer's proposed control endpoints. [`ScriptoriumControlHttpClient`](../../apps/provisioner/src/scriptorium-control-client.ts#L381) validates status and quiesce response binding, and [`request()`](../../apps/provisioner/src/scriptorium-control-client.ts#L500) mints an operation-bound service credential for each exact payload and restricts the endpoint to the assignment's Kubernetes Service. It can run only after the assignment is bound and the Control Plane can issue the credential. It cannot create an assignment or prove the producer implements those routes.

At Praetorium checkpoint `ebb9f23a`, canonical [`PRODUCER-STATUS.json`](../../docs/migration/PRODUCER-STATUS.json) still reports S01–S05 as `missing` / `BLOCKED` and `artifactDigest` as `null`. The later read-only [`PRODUCER-3f7b174.md`](PRODUCER-3f7b174.md) audit verifies public Core (`sha256:e6c024378f5d09efc24f9b771382ebba0b4cc25e11ec17e61640553663bea3b1`) and Full (`sha256:12737394de690dfeef541fb614e9595c057ae7aed1b41c693e3ba48657d07684`) preset images. Those published presets improve image availability, but have no hosted assignment/composition binding and are not an accepted configuration-specific artifact; S01–S04 and S05 stable-origin recovery remain incomplete. No owner-provided cluster/browser inventory was available for an integrated recovery run.

## Acceptance scenarios that remain unimplemented

- An active API/MCP mutation, active job, unpublished checkpoint, uncertain publication, or `unknown`/late quiesce must keep the old writer and origin intact. The current lifecycle state machine has unit-level guards, but no real Scriptorium status/quiesce surface is available to trigger and observe these cases.
- A clean quiesce must re-clone only confirmed remote state at the same repository and stable origin, then reconcile the original browser journal without silent overwrite or publication. No hosted repository credential provider, producer assignment delivery, or stable-origin reconstruction evidence is available.
- A replacement must keep the old runtime serving until the new immutable image is built and verified, prove old-writer absence through an all-epoch Kubernetes census, and only then activate the route. The production lifecycle path contains these fences, but the Provisioner cannot claim an operation with its current unavailable transports.
- A same-digest redeploy must retain the digest while starting a new epoch. A stopped-origin API/MCP write must not be replayed automatically on wake. The Gateway has a real authenticated redeploy UI action, but no live provisioner/producer flow is available to complete and observe it.
- The recovered runtime's image, repository, epoch, composition and enabled module identity must match the admitted assignment; browser-journal state must be observed through a real browser at the stable origin. No accepted artifact or owned browser/runtime deployment was available.

Existing unit tests and producer-local container recovery runs are component evidence only; none proves this Platform integration. Do not create a fake producer, in-memory provider, static token, fixture image, or synthetic positive sidecar to fill this gap.

## Minimum handoff to implement the real runner

The existing Scriptorium coordinator must publish and demonstrate the missing versioned S01–S05 inputs recorded in [`SCRIPTORIUM-CONTRACT.md`](../../docs/architecture/SCRIPTORIUM-CONTRACT.md#6-exact-producer-acceptance-handoff):

1. An immutable artifact built from an accepted arbitrary composition, with a versioned assignment delivery method and observed producer metadata bound to repository, image digest, composition digest, modules and runtime epoch. The published Core/Full preset images do not satisfy this requirement.
2. Hosted grant verification and a callable positive/negative authorization probe; assignment-bound renewable repository credentials for clone/fetch and recovery.
3. Authenticated status/activity plus operation-and-epoch-bound quiesce/resume behavior, with actual pending checkpoint, job, uncertain publication, duplicate request and stale request evidence.
4. A disposable stable-origin replacement run that re-clones confirmed repository state and reconciles the browser journal for that exact artifact.

Praetorium then needs to wire the published assignment and auth-probe contracts through the existing production Provisioner and Kubernetes renderer. Once that path is runnable, a fixed runner can use an owner-only T14 inventory whose `producer-recovery` resource identifies the owned artifact/runtime/browser inputs, drive the authenticated Gateway action, poll the durable operation, and corroborate results from the live Kubernetes provider, actual Scriptorium endpoints, and stable-origin browser. It must require current-UID private files, sufficient inventory expiry and real S02–S05 evidence before any write or replacement. The concrete private owner-input schema should be defined against those delivered inputs at that time; no producer runtime ABI is inferred here.

The runner's positive cases must observe live responses and resource identities. It must not use local fixtures as successful acceptance, resend uncertain API/MCP writes, treat an expired operation lease as proof the old writer stopped, or tear down a runtime with unknown producer state. Full T14 acceptance remains BLOCKED until the real run and its measurements are recorded.
