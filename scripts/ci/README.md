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

No service image is pushed to a public registry, and no release, Cloudflare,
D1, DNS or Kubernetes deployment is performed by this workflow.
