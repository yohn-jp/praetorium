# Real producer build evidence

[CI run 39084601122](https://github.com/yohn-jp/praetorium/actions/runs/39084601122)
succeeded on Praetorium `4e615d89b64ae112b4a0c7df15de4bca78dcbe85`, using canonical
Scriptorium `008d5c429ec279a424cafd5b8c4cbee70a613b8e`. It built the unchanged
Runtime Base and Build Kit targets and real Core/Story gateway compositions.
BuildKit metadata, loopback registry manifests and OCI archive descriptors had
to agree on each image digest. The four OCI archives were encrypted as a
732,414,335-byte CMS artifact; no plaintext image or public registry publication.

The separate metadata-only signer validated exact source/recipe/lock digests and
subjects before GitHub OIDC signing. A local pinned Cosign 3.1.3 verification
returned `Verified OK` for the catalog against identity
`https://github.com/yohn-jp/praetorium/.github/workflows/scriptorium-producer-verification.yml@refs/heads/main`
and issuer `https://token.actions.githubusercontent.com`.

Preserve the exact bytes of these JSON evidence files. The canonical statement
binds Runtime Base, catalog and runtime metadata; Build Kit is a resolved
dependency. Core/Story digests and ciphertext hash are in the **unsigned** build
report from this identified CI run, rather than signed statement subjects.
The report does not replace image/blob readback and composition verification.

This is real build/signature evidence, **not G4 completion**, Control Plane
admission, cache-reuse proof, hosted browser acceptance or production deployment.
The build's loopback repository names remain truthful. Import must preserve exact
manifest digests. Immutable raw URLs for these committed public proof files must
pass no-redirect HTTP 200 and exact SHA-256 readback before admission.
