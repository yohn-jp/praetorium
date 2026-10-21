# Published GitHub Releases → Praetorium-owned Source Build → Canary → Stable

Current target implementation: owner correction on 2026-10-21. This supersedes the former GitHub Actions deployment design merged by PR #29. CI verification workflows remain allowed; **GitHub Actions is not the deploy execution plane**.

## Operator contract

Admin users may select only a **published GitHub Release** from a trusted configured service source. Draft Releases are absent. Non-SemVer evidence/prerelease tags are displayed for information, but source builds require SemVer as enforced by the canonical release contract. GitHub authorizes source discovery; the browser does not receive any Build Worker or Operator credentials.

The Gateway re-fetches the selected Release by numeric ID with its existing encrypted OAuth user credential, resolves the Git tag to an immutable commit SHA (including annotated tags), and submits `{sourceId, githubReleaseId, sourceTag, sourceRevision, releaseVersion}` through the existing authenticated Gateway→Control Plane Worker service binding. Source registration is an explicit Wrangler public configuration, initially the **Scriptorium v1 adapter**. It does not accept an arbitrary repository/Workflow path or tag-provided SHA from the browser.

## Durable execution

- Control Plane persists immutable source build intent in `source_release_builds` D1 (migration 0004), unique by service/source GitHub Release ID; updates with a changed tag/SHA fail closed. Repeated button presses return the existing job instead of creating a second build.
- The existing authenticated Build Worker HTTP client claims source work with a fenced lease, token and epoch. The source build and the existing composition builder share the worker process, reconciliation and work notification. Lost hints are repaired by polling; stale Worker reports cannot commit a result.
- Worker independently re-fetches the published GitHub Release and verifies its exact tag/commit. It checks out that immutable source and invokes the pre-existing rootless remote BuildKit endpoint to build Scriptorium's `runtime-base` and `buildkit` Dockerfile targets, then derives catalog/runtime metadata from the source through an isolated BuildKit metadata stage. Source code is **not executed in the Worker host process**.
- The existing Builder Ed25519 signing key produces a Source Producer statement that binds GitHub Release ID/tag/commit, OCI image manifest digests, catalog digest and runtime metadata digest. A new verifier validates that signature against the existing approved Builder key policy, rereads both exact OCI digests from Registry and verifies the job's immutable identity before recording `produced` in D1. This is distinct from the legacy GitHub Actions **Sigstore SLSA** signer; source-build proofs use an explicitly distinguished predicate.
- Control Plane turns a `produced` source record into a canonical ReleaseCandidateManifest, invokes the **existing** Operator Admission service with its signed metadata and provenance verifier, and only then transitions to `admitted`. The existing Canary and Stable work is unchanged. Neither the admin click, Builder success nor the source job's `admitted` state guarantees Stable promotion.

## Security / source boundaries

- The browser never calls GitHub Actions `workflow_dispatch` and requires **no GitHub App Actions:write permission**. GitHub Actions' producer verification scripts remain historical/disposable CI verification, not the runtime deployment authority.
- Tenant-specific repository GitHub credentials, Build Worker service token, Builder signing key and OCI registry credentials remain separate. Source image pushes use the existing BuildKit registry identity, not GitHub OAuth tokens.
- The new source Producer currently supports only `yohn-jp/scriptorium` as a trusted source adapter. Generic admin source registration is a presentation and orchestration contract, not proof that other sources can be built without a supported adapter.
- Existing D1 Release Candidate, Canary health evidence window, Stable CAS, follower rollout and writer-absence fencing are never bypassed.
- New D1 migration must be applied **before** deploying source-build enabled Control Plane/Build Worker. No migration, GitHub App permissions, secrets, production builds, cluster changes or Cloudflare deployment are performed by this code change.

## Validation gates

CI must establish type/build/lint/test and reproducible container build. Full deployment acceptance additionally requires a migration readback, a real published Scriptorium tag build on the owned remote BuildKit daemon, GHCR digest readback, Builder proof verification, D1 source lifecycle, Operator Admission, Canary health evidence and successful Stable promotion. An OCI image build in CI alone does not certify these production gates. Preserve separate VERIFIED and NOT_CHECKED states.
