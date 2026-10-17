# Read-only producer preflight: fc4eea8

The fresh detached snapshot `/tmp/praetorium-producer-audit-fc4eea` is clean at
`fc4eea880ef895decf6161bf4f45cc958e9700b3`, tree
`7a56bd432597b7f31588af69f12a4e3a14243b46`; remote main matched this checkpoint.
The prior audited `539375c` is an ancestor. No producer worktree or source was
modified. Arcadia remains pinned to `b96a03a8734bfff2e5b965e6966007c45a2c7dc9`.

The relevant production delta is `modules/semantic/src/browser.ts`: progress
polling is serialized and stops on completion/error/abort, with listener and
cleanup removal. It addresses overlapping browser status requests, not the S04
hosted status/activity or quiesce/resume protocol. No versioned S01 build
catalog/Build Kit/receipt, S02 grant verifier, S03 renewable credential contract,
or S04 replacement-control interface was added. S01–S04 remain missing/BLOCKED.

The refreshed `docs/verification/P13-MODEL-OCI-LIFECYCLE.md` records a real local
full-profile model/worker run: source `8804edc9afb17fcd66b605ebfb70589007519dfa`,
tree `45809bd25cfb888a1f3aa15531458adfc0d74f0f`, linux/amd64 manifest
`sha256:510d8398fcee71015bcd3be2489ff69fd7976bb4c06d0e852c47579c81e427bf`,
image ID `f5def569f7fa98e0c71807730afb999c42c057a86c71557f812b41eae3755172`.
It reports 1/1 pass in 159242.4 ms with actual model/tokenizer/Lindera use,
shared Diagnostics/Semantic inference, lease cancellation/rebuild and container
replacement. It remained local. Those image inputs matched the earlier 539375c
checkpoint; fc4eea8 includes the subsequent production browser fix, so this is
not final-fc4 image evidence. The report retains inconsistent size observations
for the same image identity; no cause or size improvement is inferred here.

Core browser recovery evidence remains the separately scoped local
`sha256:79d59260c436dfa98b9e250eba9ee616058a756b7d62935b71d5dd5740b7f0b0`
at source `f3ef4d34`. No current-fc4 published locator or hosted assignment and
composition binding is recorded. S05 remains incomplete and the accepted
Platform `artifactDigest` stays null. These are useful producer component results,
not Praetorium conformance. Historical unauthenticated 401 replies do not prove
registry absence.

Root also inspected the committed P00/CAMPAIGN record: the corrected whole
verification on 539375c stopped with 16/18 full-profile browser tests passing,
before P12. The source now contains the polling fix, while that record still
calls it in progress. The separate direct P12 run has no terminal result recorded.
No successful whole verification or current-fc4 P12 acceptance is claimed.
Existing producer ownership and the precise hosted handoffs remain unchanged.
