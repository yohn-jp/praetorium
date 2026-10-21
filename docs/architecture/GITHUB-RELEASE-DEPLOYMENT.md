# GitHub Release selection → Verified Stable pipeline (Issue #28)

Authority: latest owner direction on 2026-10-21, Epic #1, current Operator Admission and signed Scriptorium Producer contracts. This document describes the new implementation, not a claim of production certification.

## Operator behavior

The administrator selects an **existing published GitHub Release** from a configured service's source repository, not a branch, raw commit, image tag, or hand-written manifest. GitHub Releases that are drafts are absent. A published prerelease is labeled; non-SemVer evidence releases appear as informational only, as the ReleaseCandidate v1 contract demands SemVer. The normal UI no longer asks for raw Producer manifests (the separately authenticated API remains available for machine operators).

On POST the Gateway re-fetches the selected Release **by numeric ID**, confirms the repository against a validated server-side service registration and resolves the tag ref to a commit object SHA (dereferencing an annotated tag, if necessary). Neither the client-supplied tag nor the client-supplied SHA is trusted. The source SHA is passed as an immutable `workflow_dispatch` input to that service's **registered, exact** Producer workflow on Praetorium main. No arbitrary workflow path, repository, URL, ref or build script is accepted from the browser. The workflow independently rechecks `refs/tags/<tag>` against that SHA **before building** and validates the SemVer contract.

A one-shot, bounded Durable Object claim protects the initial dispatch against double clicks and ambiguous network retries. GitHub Actions is the job/execution authority and provides its real workflow-run evidence; the Control Plane's D1 Release Candidate / Canary / Stable channel remains the lifecycle authority. This does not introduce another scheduler or shadow release table.

## Producer and admission path

The existing Scriptorium Producer (container BuildKit + metadata validation + OIDC Sigstore bundle + digest-preserving public GHCR copy) runs for the selected immutable source revision. Remove the old `008d5c4...` source revision pins from **producer workflow and validators**; preserve all pinning of **trust roots, known binary/tool digests and workflow signing identities**.

After successfully verifying publication, the trusted Publisher publishes the exact Sigstore bundle to a public immutable-versioned evidence GitHub Release asset in the Praetorium repository. It does not modify that bundle. The public evidence URI is used for `signatureRef` and `provenanceRef` and must remain fetchable without GitHub credentials. The Publisher constructs `ReleaseCandidateManifest` from the signed `build-catalog.json`, `runtime-metadata.json`, selected semantic version, immutable public `imageRepository`, and provenance URI. It authenticates to the **existing** Control Plane `POST /v1/operator/releases` using a dedicated GitHub Actions secret `PRAETORIUM_RELEASE_OPERATOR_TOKEN` provisioned with the existing operator release credential. No credential, manifest, provenance bundle or GitHub Action token is put in the browser.

Operator Admission still verifies Registry / OCI digest, Sigstore signer allowlist, signed producer catalog/metadata subjects and the duplicate/fencing rules. Candidate → Canary → Stable is already scheduled by the Control Plane; failure stays blocked, and the UI never claims promotion based on dispatch success. There is no direct stable mutation in the new flow. A selected Release appearing in Actions does not mean it is available in the runtime.

## Setup and boundaries

- The Gateway service-source registry is explicit public Wrangler config (`PRAETORIUM_RELEASE_SOURCES_JSON`), currently Scriptorium. Each entry identifies one allowed GitHub source repository, one exact Praetorium-owned Producer workflow and its adapter ID. The UI and service registry are generic; the first actual trusted Producer adapter remains Scriptorium. A future service must supply an equivalent signed producer compatible with the platform contract. No arbitrary web URL is fetched.
- Gateway uses an existing **encrypted GitHub OAuth user token** issued to the authenticated Admin principal for read/dispatch, subject to GitHub App permissions (`Contents: read`, `Actions: write` on the Praetorium workflow repository). Missing GitHub permission must produce an actionable fail-closed error. GitHub workflow job uses repository Actions credentials for GHCR and evidence asset publication.
- `SCRIPTORIUM_PRODUCER_RECIPIENT_CERT_B64` is a **public repository Actions variable** containing the preapproved recipient certificate. Its original fingerprint check remains enforced. The secret `PRAETORIUM_RELEASE_OPERATOR_TOKEN` is required for final admission; provisioned only by the administrator and never committed. Failing either preflight blocks the workflow, not bypasses it.
- The build / signing identity continues to be `scriptorium-producer-verification.yml@refs/heads/main`, enforced by Control Plane signer policy. The publishing workflow runs only on the trusted main ref. GitHub Release source tag and SHA match again in both build and signer jobs.
- Existing user repository configuration, pinned instance behavior, writer-exclusivity, source repository secrets and admin OAuth/CSRF remain unchanged.
- Historical verification records are audit evidence and keep their original pinned SHA unchanged; production code and workflows must not use that SHA as the active source selection.

## Verification and operational gates

1. The Source Release list excludes drafts, refuses non-SemVer deployment, safely renders notes, and is empty/error-distinct from all registered releases.
2. CSRF and current Admin identity on every GET/POST; refetch by release ID, matching tag commit and generic trusted service source, with idempotent dispatch. An invalid GitHub response or unauthorized Actions permission never returns a successful deploy status.
3. Changing the tag between selection and CI execution fails closed. No source revision is hardcoded in the active producer scripts, signer or publisher; the OCI image digest and signed subjects remain grounded in the exact selected source.
4. A published and verified evidence asset feeds the existing operator admission and Canary; no stable pointer is assigned by the GitHub workflow.
5. `pnpm check`, script syntax, unit tests, CI image verification and an actual operator browser/source release deployment. Passing fixtures or image compilation is not equivalent to successful production Canary/Stable.

No deployment, secret provisioning, GitHub App permission changes or source repository edits are authorized by this PR.
