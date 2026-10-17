# Read-only Scriptorium audit at `3f7b174`

Audit date: 2026-10-17. Target baseline: Praetorium main
`7bf2609d935f60c15da9b0e300ecf473c910533d`. Arcadia source remains
`b96a03a8734bfff2e5b965e6966007c45a2c7dc9`.

## Producer source delta

Remote Scriptorium `main`, tag `v0.1.0`, and the public Actions run all identify
commit `3f7b174ef6667b004c21e24a9ed89b8329d04c04`, tree
`b399ba06cfd24a6b300e40e6b8f428312e93873d`. The previous audited producer
revision was `eab0fad7c811aeedabe29fcd214598dc5207c178`. The `eab0fad7..3f7b174`
diff adds `.github/workflows/publish-oci.yml` and
`docs/verification/OCI-RELEASE.md`; it also updates producer campaign and review
documents. It changes no application, API, module-runtime, profile, package
manifest, lockfile or Dockerfile source. The preceding `9942b45` campaign-closure
commit records the producer's Epic 7 ledger review; it does not close Praetorium
Epic #1 or implement an S01–S05 interface.

The audit fetched the producer remote ref in the existing owned observer clone
while leaving its frozen detached `fc4eea880ef895decf6161bf4f45cc958e9700b3`
checkout untouched. No producer worktree, storage, workflow or image was changed
or run by this audit.

## Published release evidence

The remote `v0.1.0` tag resolves to the audited commit. GitHub reports the
existing tag-push workflow run `38997859921` as completed successfully at head
SHA `3f7b174...`; both independent `Publish core` and `Publish full` jobs have
successful image verification and publication steps. This is observation of the
producer's existing run, not an audit-triggered CI execution. The public run is
[here](https://github.com/yohn-jp/scriptorium/actions/runs/38997859921), and the
workflow source is
[publish-oci.yml at the audited revision](https://github.com/yohn-jp/scriptorium/blob/3f7b174ef6667b004c21e24a9ed89b8329d04c04/.github/workflows/publish-oci.yml).
There is no GitHub Release object in the repository's releases listing; the
published images came from the pushed semver tag.

Both GHCR tags resolve anonymously. For each profile, the raw registry manifest
was fetched by tag and again by digest; the SHA-256 of the raw manifest body
matched the registry `Docker-Content-Digest` and the digest reference. The raw
config blob SHA-256 also matched the manifest's config descriptor.

| Published tag | Image manifest digest | Config digest | Descriptor |
| --- | --- | --- | --- |
| `ghcr.io/yohn-jp/scriptorium/core:v0.1.0` | `sha256:e6c024378f5d09efc24f9b771382ebba0b4cc25e11ec17e61640553663bea3b1` | `sha256:e71411421f19daefed6703c54ffd7dd03e8a3c9b1ee51b44aad258202d009d24` | Docker schema 2 image manifest; `linux/amd64`; 8 layers |
| `ghcr.io/yohn-jp/scriptorium/full:v0.1.0` | `sha256:12737394de690dfeef541fb614e9595c057ae7aed1b41c693e3ba48657d07684` | `sha256:0dac8d53d31840ee371133b7b447eaaf65b8992c92af8e2cfa93d7c0a0672e24` | Docker schema 2 image manifest; `linux/amd64`; 8 layers |

These are single-platform image-manifest digests, not multi-platform index
digests. The image configs have no `org.opencontainers.image.revision`, source or
version labels. The source association is evidenced by the tag target and
workflow run's exact `head_sha`, not embedded in the config. The inspected
workflow does not generate or publish a provenance/SBOM attestation. Operators
should pin the manifest digest instead of relying on the release tag.

The workflow checks the built profile image before pushing that same local
image: health and declared startup/readiness/version/static assets, included
profile modules, UID 1000, a write/remove in `/data`, and successful TERM
shutdown. Its verifier is
[`scripts/verify-oci-http.mjs` at the audited revision](https://github.com/yohn-jp/scriptorium/blob/3f7b174ef6667b004c21e24a9ed89b8329d04c04/scripts/verify-oci-http.mjs).
The checked `profile-build.mjs` still accepts only `core` or `full`;
`profiles/core.json` selects no modules and `profiles/full.json` selects all
eight. The Dockerfile pins the Node base image digest but uses pnpm 12.10.1 and
installs OS packages after `apt-get update`, so this release recipe is not the
versioned immutable Runtime Base/Build Kit catalog required by Praetorium.

## Contract status and handoff

No hosted S01–S04 contract was added in this delta: there is still no arbitrary
selection catalog/receipt and composition-closure contract, hosted grant and
role verifier, assignment-bound renewable Git credential interface, or hosted
status/quiesce/resume protocol. The successful GHCR release is real evidence for
two producer preset images, but it does not prove a Praetorium-admitted
composition build.

S05 has new evidence for public image publication at the two digests above. It
remains incomplete: the images have no hosted assignment/composition binding,
the release workflow did not exercise stable-origin replacement and recovery,
and no Platform conformance was performed. Praetorium's accepted Platform
`artifactDigest` therefore remains `null`; these producer preset-image digests
must not be substituted for a verified composition artifact digest.

The existing coordinator handoff in
[`SCRIPTORIUM-CONTRACT.md`](../architecture/SCRIPTORIUM-CONTRACT.md) remains:
deliver S01's versioned arbitrary resolver/catalog, immutable recipe and
independently verifiable closure receipt; S02/S03 hosted authorization and
repository-scoped renewable credential acceptance; S04 fenced activity and
quiesce/resume; and S05 assignment-bound runtime metadata plus stable-origin
reconstruction against the exact digest. Praetorium must then implement and
verify its own artifact inspector/smoke and consumer integration. This note does
not edit canonical coverage or producer status ledgers.
