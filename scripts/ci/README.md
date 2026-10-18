# Disposable producer verification

`scriptorium-producer-verification.yml` is manual and restricted to main. It
fetches canonical Scriptorium commit `008d5c429ec279a424cafd5b8c4cbee70a613b8e`.
It builds the unchanged Runtime Base and Build Kit Dockerfile targets, then Core
and Story compositions with the actual `gateway.v0` producer frontend. Each
image must have matching BuildKit, loopback-registry and OCI archive digests.

The build job has no OIDC permission. Four OCI archives stream into CMS
AES-256-GCM encryption, capped at 4 GiB. Only ciphertext is uploaded as image
evidence, with one-day retention. The public certificate input is pinned by
fingerprint in the build script; its private key remains in the owned disposable
Build VM root. That root expires at 2026-10-18T23:21:58Z. The current workflow is
specific to that campaign; expired credentials must not be reused.

The separate signer job downloads JSON only and executes a Praetorium-owned
Node validator using built-ins. It fetches the producer source as data, without
installing dependencies or executing producer code. Source/recipe/lock digests,
metadata hashes, statement subjects and immutable image references are checked
before pinned Cosign uses GitHub OIDC. The public Sigstore bundle is verified
against the exact workflow identity and issuer. Rekor exposes source revision,
digests and the loopback repository locator. No production trust policy changes.

The producer statement binds Runtime Base, canonical catalog and runtime metadata;
Build Kit is a resolved dependency. Composition digests are in the build report,
not SLSA subjects. This evidence does not establish Control Plane admission,
Hosted browser acceptance or production deployment.

For later consumption, download evidence into an explicitly owned disposable
root. Check ciphertext SHA-256 against the build report; decrypt to staging and
discard **all** plaintext on any nonzero OpenSSL exit (GCM failure can follow
partial output). Verify the Sigstore bundle and metadata before importing image
bytes. Imported registry manifests must retain the exact recorded digest.
Actions artifacts expire and are not stable no-redirect evidence URLs. A public
proof committed to this repository still requires exact-byte readback from its
immutable commit URL before admission.

By default, no image is pushed to a registry. An explicit
`publish_public_producer_inputs` dispatch option enables a separate publication
path for only Runtime Base and Build Kit. The build job still has no OIDC or
package-write permission; it uploads those two plaintext OCI archives as
one-day artifacts (with a 1 GiB aggregate cap) alongside the ciphertext
evidence. Core and Story archives remain ciphertext-only. The signer continues
to receive JSON metadata only and has `id-token: write` without package-write
permission. A publisher job starts only after signer success, revalidates the
pinned source and report, verifies the exact Cosign identity, checks each OCI
archive descriptor against the signed catalog digest, and copies the exact
bytes with Skopeo `--preserve-digests` into
`ghcr.io/yohn-jp/praetorium/scriptorium-producer`. Its only write permission is
`packages: write`; it uses the short-lived `GITHUB_TOKEN` inside that job and
does not rewrite the signed metadata. Skopeo is pinned to
`quay.io/skopeo/stable@sha256:8342e1e8d7b12d0bd3bf53ce8f4fde7ed876277aa8e4345f53937a505309e6b5`
and checked as version 1.21.0.

The publisher records authenticated digest readback and separately checks
anonymous pull access. If an anonymous readback is blocked, the job writes the
HTTP result to its step summary and fails with
`PUBLIC_AVAILABILITY_BLOCKED`; it leaves the already-pushed images in place. A
new GHCR package can remain private after a successful push; a package owner
must set its visibility to Public before anonymous runtime pulls can pass.
This workflow does not change package visibility or perform a release,
Cloudflare, D1, DNS or Kubernetes deployment.

`verify-service-images.yml` separately builds the current exact Praetorium
commit's Provisioner, Instance Access and Build Worker Dockerfiles using the
existing pinned build arguments. It verifies BuildKit, OCI archive and loopback
registry digests, then uploads encrypted OCI evidence and a separate public
digest/hash report, each retained for one day. It uses the same pinned public
recipient certificate and four-GiB cap, with no OIDC permission or public image
push. These are candidates for later owned-runtime verification and review of
specific publication/deployment operations; this workflow grants no production
authority. Its public report is CI evidence, not a signed SLSA statement.
