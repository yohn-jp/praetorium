# Continuous integration and service image publication

`.github/workflows/publish-services.yml` runs on pull requests and pushes to
`main`. It installs the frozen workspace, runs `pnpm check` and deployment
regressions, and validates Kubernetes admission using an ephemeral Kind cluster.
Pull requests build service images without publication and have read-only
permissions. On main, the separate `publish-images` matrix builds and pushes
the five platform service images to GHCR with `source-<commit>` tags and maximum
BuildKit provenance. Only this main-only job receives `packages: write` and the
ephemeral `GITHUB_TOKEN`; no runtime operator credential is available to CI.

Observer publishes to `ghcr.io/yohn-jp/praetorium/management-observer`; the
other four services retain `ghcr.io/yohn-jp/praetorium/<service>`. The existing
`praetorium/observer` package rejected this repository's workflow token. The
dedicated package is created by Actions with the canonical source label so
GitHub can associate it with this repository. Receipts record the actual image
repository and reject mismatches. Existing deployed Observer digests remain
valid; changing its Management deployment is a separate Ansible rollout using
the new immutable digest. All five publications remain required by the deploy
CI gate.

Each image job uploads a `service-image-<service>` receipt binding the workflow
run, commit, repository and immutable OCI digest. `deploy-platform.mjs` consumes
these receipts from the successful workflow for current main, rereads the exact
GHCR digests and source labels, and stages the existing guarded inventory. It
does not rebuild or push service images, and does not need Builder connectivity
for platform delivery. Scriptorium Source Producer execution remains on Builder.

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
