# Read-only producer observation: eab0fad

Remote main and the fetched immutable object resolve to
`eab0fad7c811aeedabe29fcd214598dc5207c178`, tree
`0721e2441b3f680a3c6785e73d5f8b70857e87ef`. Inspection used the existing owned
observer clone `/tmp/praetorium-producer-audit-fc4eea` without changing its detached
fc4 checkout or any producer working tree. The fc4..eab delta changes docs,
evidence and `scripts/verify-migration-ledger.mjs`; packages, modules, app,
profiles and packaging recipes are unchanged. The verifier script is in Docker's
build context, so this is not a claim of byte-identical complete build inputs or
an image built at eab. The packaged application code remains the frozen fc4 code.

No S01 build catalog/Runtime Base/Build Kit/receipt, S02 hosted grant verifier,
S03 renewable repository credential interface, or S04 hosted status/quiesce/resume
protocol was added. Those hosted gates remain missing/BLOCKED.

The new committed `docs/verification/FINAL-MIGRATION.md`, P12/P13 evidence and
model lifecycle report materially strengthen producer component evidence:

| Local Linux/amd64 image          | Recorded manifest digest                                                  |
| -------------------------------- | ------------------------------------------------------------------------- |
| Final Core                       | `sha256:8661aa25c6a0e2f3f6ef517f094d9edc03909c927ee9b2c749f88a8fc5d238d1` |
| Full startup acceptance          | `sha256:03cb0ddc2426ec7fe9e03cba814f33a1dc30e3185fbfc12a7f99bee04ce10834` |
| Exact-tree Full model acceptance | `sha256:ac8aaf8f17843b91b3168c69e02bfdf9169deef8895c6ae5093cbb83c5edde48` |

The real-model image was tested at `95711fb4b00df7cf20ee24aaa3a00fbe909194e5`,
whose complete tree matches frozen fc4 tree `7a56bd432597b7f31588af69f12a4e3a14243b46`.
It reports 1/1 pass in 158877.3 ms and actual NLP/model, shared-worker, cancellation,
release and container-replacement observations. Unlike the earlier 8804 candidate,
this includes the Semantic browser polling fix. Core/browser recovery has scoped
application-byte equivalence recorded separately, with pnpm metadata differences;
no byte-identical OCI claim is made.

P12 now records composed migration acceptance passed at fc4, 462244.406498 ms.
The whole producer verify passed its listed stages through P12, then hit ENOSPC
in its final Full OCI stage. That unchanged stage was rerun after bounded cleanup
and passed. This proves the listed stages; the original whole command did not
exit zero. The producer's final ledger/review records close its own migration
scope; that scope explicitly excludes Platform implementation and registry
publication.

All three images remained local. The producer records cleanup of completed
recovery/duplicate startup images, retaining final Core and exact-tree model
images; tested digests do not promise host-cache availability. No published
locator, versioned hosted assignment/composition binding, or Praetorium conformance
is supplied. S05 hosted acceptance therefore remains incomplete and the accepted
Platform `artifactDigest` remains null. Historical unauthenticated registry401
responses do not establish absence. Existing producer ownership and the precise
hosted/closure/compatibility handoffs remain unchanged.
