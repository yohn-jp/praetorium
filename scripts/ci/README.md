# Continuous integration verification

`.github/workflows/publish-services.yml` runs on pull requests and pushes to
`main`. It installs the frozen workspace, runs `pnpm check` and deployment
regressions, builds each service image into the disposable runner with
`push: false`, and validates Kubernetes admission using an ephemeral Kind
cluster. It grants no package-write or runtime operator credential.

The same workflow runs `scripts/ci/source-stable-fixture.mjs` on a Linux Node 24
runner with Docker, passwordless `sudo`, and at least 8 GiB free. It pins
BuildKit v0.34.0 and registry v3.0.0, creates an ephemeral mTLS BuildKit daemon,
loopback OCI registry, and signing key, then exercises the Source queue, real
Source proof and registry verification, canonical Admission, `gateway.v0`
composition, and T11 stable-channel CAS. The fixture's post-Admission health
and writer-absence observations are simulated. Its report records the produced
artifact digests and marks hosted producer, registry availability, and browser
acceptance `NOT_CHECKED`; it does not publish outside the disposable registry.

`.github/workflows/verify-service-images.yml` is an optional manual candidate
build. Its Build Worker image and sibling services are solved with pinned
BuildKit into a loopback OCI registry; it uploads encrypted image evidence and
a digest report. It does not publish to GHCR or deploy a service.

The hosted `buildkit-registry` and `stable-rollout` integration gates require
private owner-bound inventories, disposable runtime inputs, and enough
remaining lifetime for cleanup. CI fixtures do not satisfy those hosted gates.
Report a missing gate as `BLOCKED` or `NOT_CHECKED`, with the exact missing
inputs, rather than treating a passing unit test or local fixture as hosted
acceptance.
