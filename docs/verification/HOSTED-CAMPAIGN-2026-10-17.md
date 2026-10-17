# Hosted campaign evidence — 2026-10-17

The implementation source cuts are Praetorium `a669f5c16faa85d5fcc162241b793eab734d46c2` and Scriptorium `008d5c429ec279a424cafd5b8c4cbee70a613b8e`. Both were committed and pushed by Sol. This record describes bounded verification; the Hosted campaign is not certified complete and no production infrastructure was applied.

## Actual artifacts and operations

[The machine-readable artifact record](HOSTED-ARTIFACTS-008d5c4.json) contains immutable registry digests, source cuts, build keys, composition receipt digests and actual inspector outputs. Images were published only to the explicitly owned disposable TLS registry. Native BuildKit used the existing owned mTLS endpoint and its `/data` storage extension. No repository manuscript or Git credential input was supplied to these builds.

From a clean producer checkout, the existing module resolver/profile packager and real BuildKit gateway produced Runtime Base, Build Kit, Core, Story and MCP. Story and MCP are distinct legal non-preset selections. Packaging ran offline in the network-disabled composition solve after the Build Kit's exact deployment-policy cache was primed.

Sol then used the production `ScriptoriumBuildCandidateReceiptReader`, `GhcrCandidateVerifier`, `ScriptoriumCompositionArtifactInspector` and `BuildKitImageRootfsExporter` against each exact composition digest. All three passed immutable OCI config/all-layer verification, embedded catalog/runtime/lock/composition bindings, physical pnpm runtime closure, server/browser/native dependency checks and the actual `/health/ready` startup smoke. Core has no addon entries; Story has server and browser entries; MCP has a server entry and no browser contribution. These three images declare no native addon dependencies, and inspection confirmed that absence.

The registry composition receipts were published and cryptographically read back. These are **unsigned candidate verification statements**. No Sigstore-signed source release was admitted into Control Plane, no builder-signed queue result was registered as an accepted release, and no full queue/cache or Hosted product acceptance is inferred.

Sol also cryptographically verified every layer of Runtime Base, Build Kit, Provisioner, Build Worker, Instance Access and Prometheus through the production registry client. Build Worker was rebuilt at `6cd9d267bb26af4052f80688e84c3a38cf948a84` to include the corrected lifecycle module. Provisioner was then rebuilt at `a669f5c16faa85d5fcc162241b793eab734d46c2` with that lifecycle fix and the canonical empty-queue response fix. Instance Access source and its dependency paths are unchanged from its `94d3902` build. Prometheus uses the immutable upstream digest recorded in the artifact JSON.

The producer's new `hosted-attestation.mjs statement` command ran successfully in the clean `008d5c4` checkout using the actual canonical catalog and the metadata sidecar extracted from the published Core image. It recomputed source/recipe/lock bindings and emitted canonical SLSA v1 with the exact Runtime Base/catalog/runtime-metadata subjects. This output is unsigned. Cosign v3.1.3's official binary checksum, version, pinned path and relevant signing/verification options were checked; actual OIDC signing/publication was not run.

## Fresh source verification

- Praetorium: literal `corepack pnpm@11.18.0 install --frozen-lockfile` and `corepack pnpm@11.18.0 check`, with the owner-private Corepack shim ensuring nested pnpm remains 11.18.0. All 29 tasks, provider boundaries and canonical schema generation passed. The application suite passed 72 tests; recovery passed 12. An earlier whole check caught a missed Wrangler environment-filter integration; the missing line was copied, and the corrected whole check passed.
- Scriptorium `008d5c4`: `corepack pnpm@12.10.1 install --frozen-lockfile`, `typecheck`, `test`, `build`, and `audit:core` all passed. Test totals were 361 cases: 360 passed, one optional semantic CPU-model integration skipped, zero failed. Core dependency audit scanned 70 production dependency versions.
- Earlier standalone browser runs at `a03ba9b`: Core 15 passed / 3 expected selection skips; Full 18 passed. The app/API/Core/module source paths are unchanged through `008d5c4`, verified by Git diff. These used a local bare-Git fixture and do not prove Hosted GitHub App entry or GitHub save.
- The [current actual aggregate report](HOSTED-ACCEPTANCE-a669f5c.json) records Worker/D1/DO `VERIFIED`, six categories `BLOCKED` / `NOT_CHECKED`, `errors=[]`, and process exit 2 at `a669f5c`. This executed the real bundled local Worker with all five migrations and persistent DO. No full Hosted acceptance is inferred.
- All seven fixed runner paths are implemented and connected to `verify-integration.mjs`. The new BuildKit, producer-recovery and stable-rollout runners passed syntax/ESLint. Their full live product gates remain unverified.

Private logs remain in the owned environment, including `/tmp/praetorium-008d-final-image-inspection.log`, `/tmp/praetorium-a669f5c-final-{frozen,check}.log` and `/tmp/scriptorium-008d5c4-{frozen,typecheck,test,build,audit}.log`. The artifact record contains the actual inspector-log digest. Private owner inputs and credentials are not committed.

## Independent review and corrections

Independent read-only reviewers were separate from implementers. Current source reviews covered producer grants and Git credential/publish authorization, repository/instance/epoch fences, artifact/source provenance, OCI/config/composition bounds, physical dependency closure, lifecycle retirement and persistence compatibility, fixed runners, and off-host recovery destination validation.

Concrete findings were corrected and affected checks rerun:

- Runtime Base lacked a packaged metadata sidecar; attestation instructions now extract it from the immutable composed Core image. Both Cosign commands explicitly use the consumer-supported protobuf bundle format and reject affected/unsupported versions.
- The actual OCI inspector requested 8 MiB config reads from a 4 MiB registry client. The client now permits 8 MiB config reads while composition manifests remain explicitly bounded to 4 MiB.
- The actual MCP dependency `debug@4.4.3` contains orphan optional peer metadata. The closure validator accepts its shape without creating a dependency edge, while required peers and extra physical packages remain enforced.
- Historical safe quiesce receipts could survive a producer restart whose in-memory mutation gate reopened. Every retirement attempt now requires fresh assignment-bound remote status and re-quiesces the same operation with a renewed deadline. Pending work blocks stop; stale/unknown remote evidence retains the existing journal fence and performs no stop/start or implicit resume.
- The Control Plane returns JSON `null` for an empty operation queue; Provisioner incorrectly rejected it and failed real deployment readiness. The client now accepts the canonical response while malformed non-null claims remain rejected; 53 Provisioner tests passed, and the rebuilt exact image became Ready in the owned cluster.
- A remote protocol alone was treated as off-host proof. Recovery now binds the exact protected owner-approved Restic URI, rejects exposed local/loopback destinations and conflicting repository-file input, follows Restic S3 bucket/path semantics and fingerprints the destination. This is configuration validation, not proof of a real off-host storage operation.

The fresh relevant suites and independent reviews found no remaining concrete code blocker in those corrected scopes. Full product certification remains blocked by actual acceptance evidence.

## Remaining acceptance inputs and gates

The existing local Worker, registry, BuildKit and Kind cluster are owned disposable environments. Sol independently observed the actual final Provisioner Pod (`5f1c9d98-4199-43d8-9cd8-3e684bcbca23`, image `c66e8c…`) Ready/Running with zero restarts and the exact Prometheus Pod Ready. Both Control Plane public control/runtime-identity JWKS returned 200 with one public ES256/P-256 key and no private `d` field. A fresh TLS handshake through the owned Traefik Service port-forward verified successfully for `probe.instances.praetorium.test`; HTTP 404 is expected because no instance route exists. Full T07 remains unexecuted: the actual Gateway/Instance Access binding and complete fixed-runner configuration require the owner App/OAuth inputs. The canonical inventory marks that complete category input missing; this does not mean the already used cluster or TLS substrate is absent. Historical API/CNI packet observations retain their older bounded scope.

Required external inputs are the owned GitHub App ID/private key and OAuth client configuration, installation and permissions for disposable numeric repositories, authorized writer/read-only/unauthorized user login states and callback origins; an allowed Sigstore OIDC signing identity/issuer and real signed source bundle; and, for T13, disposable remote D1/Cloudflare access plus a genuine approved off-host Restic destination, password and protected recovery key (with applicable source exports/PVC inputs). Existing local service/JWKS/builder keys are locally provisionable and are not classified as missing external credentials.

Until those inputs and their real fixed-runner operations pass, multi-user Hosted entry, repository/epoch denial, App credential rotation and authorized clone/fetch/push, Hosted browser edit→Checkpoint→GitHub save/conflict/recovery, admitted build cache/stale reports, Stable/Pinned canary/rollback, stopped-origin wake and remote metadata recovery remain unverified. Accepted Platform `artifactDigest` remains null. Production deployment, public release and legacy deletion were not performed.

Use [the deployment runbook](HOSTED-INTEGRATION-RUNBOOK.md), the exact artifact record, and the existing fixed runners for the remaining operations.
