# Published Scriptorium producer inputs

The producer workflow [39092494296](https://github.com/yohn-jp/praetorium/actions/runs/39092494296) built the unchanged Scriptorium revision `008d5c429ec279a424cafd5b8c4cbee70a613b8e` on Praetorium source `95da17f276587586ec4c6a16200b3aaa7984ba21`. Its `build-producer` and `sign-producer-metadata` jobs succeeded. The workflow's first optional publication job failed before copying images at its pinned Skopeo version check; no image copy was made by that job.

The publisher-only workflow [39093546534](https://github.com/yohn-jp/praetorium/actions/runs/39093546534) consumed the exact successful build and signer artifacts from run `39092494296`, attempt 1. It revalidated the original source and metadata, verified the original Cosign bundle and GitHub Actions identity, and digest-preservingly copied only Runtime Base and Build Kit to `ghcr.io/yohn-jp/praetorium/scriptorium-producer`. Its anonymous strict-TLS readback verified both manifest digests. A separate anonymous readback recorded HTTP 200 and matching registry manifest digests for both references at 2026-10-18T03:28:11Z in [publication-readback.json](publication-readback.json).

The published references are:

- Runtime Base: `ghcr.io/yohn-jp/praetorium/scriptorium-producer@sha256:93bb59a32e85d9891b1a4d4ece15845d93af677330935fce56e71b79e9875c52`
- Build Kit: `ghcr.io/yohn-jp/praetorium/scriptorium-producer@sha256:b0d99ef773188fa451f9aef1a03b52fb26871c152bb7eaebb1863c0cc44bf888`

The raw catalog, runtime metadata, SLSA statement, and Sigstore bundle below are the original signed artifact bytes; they were not rewritten for the new registry namespace. The statement's subjects are the Runtime Base digest, catalog digest, and runtime metadata digest. Build Kit is bound as a resolved dependency and `buildKitImage` external parameter, not as a statement subject. The loopback URI strings in the signed statement therefore remain the truthful original producer references; publication preserves the same OCI manifest digests under the Praetorium-owned GHCR repository.

[build-report.unsigned.json](build-report.unsigned.json) is the producer CI report, identified by the workflow run but unsigned. Its Core and Story composition digests are not SLSA statement subjects. This evidence proves producer build/signature and public image availability only; it does not establish an admitted Control Plane release, G4 normal-queue completion, cache reuse, Runtime acceptance, or Hosted acceptance.

`publication-record.json` keeps the producer and publisher runs distinct and records the exact artifact hashes. The raw proof files are preserved byte-for-byte from the successful signer artifact. No OCI archive, CI log dump, credential, or secret is included.
