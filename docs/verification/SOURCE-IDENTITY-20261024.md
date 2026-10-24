# Source identity and Metadata context verification — 2026-10-24

This records diagnosis and pre-deployment verification. It does not certify a
production rollout, Canary, Stable, or browser acceptance.

## Observed cause

The production v0.3.7 job is `sr_b8b3a04d-e150-4347-ba99-19543966ca03`,
Release ID `422701682`, immutable source
`95a66c2c985a66bc2d535392dcc450d8c9df18d5`.
Retained BuildKit execution `fzf4lprkzhjpmvtzw16tlh4f6` completed the workspace
build and failed in resolver generation at `git rev-parse HEAD`.

Readback of the running Build Worker image
`sha256:08a25d7631ccd980e0dfe96bfeed7186b36b26d10ae56ec135e1b7ddcb54f67f`
showed that `sourceMetadataDockerfileIgnore()` still returned `Buffer.alloc(0)`.
The non-empty override already on main had not reached this deployed process.

Two actual solves on the owned remote BuildKit daemon used the same published
source and `docker/dockerfile:1.7` frontend
`sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e`:

- Empty Dockerfile-specific ignore: `.git` and `.git/HEAD` absent; Git installed;
  `git rev-parse HEAD` exited 128 with `not a git repository`.
- Non-empty comment override: `.git/HEAD` present and Git returned the exact
  immutable v0.3.7 revision. Full Metadata/Catalog/Runtime metadata generation
  also succeeded. This proved the immediate defect, but did not remove the
  ignore mechanism or the Producer's Git dependency.

## Repair boundary

The final path removes the Metadata ignore helper and its override entirely.
The Worker copies its fresh verified checkout into a separate named context,
under `checkout/`, alongside a platform-owned identity and verifier. The named
context root has no `.dockerignore`; Producer ignore files remain nested inside
the checkout. Metadata explicitly copies that complete snapshot. Its ordinary
image context retains the Producer's exclusions.

The Worker verifies the snapshot's commit/tree/clean status before execution.
The isolated adapter verifies the same identity before and after generation,
and the Worker requires exact exported identity equality and rechecks its host
checkout before signing. Existing catalog/runtime/resolver comparisons, image
digests, signing, registry verification, Admission and lease fences remain.
Identity mismatch during Metadata generation is a verification failure with a
bounded sanitized diagnostic.

Published v0.3.7 still requires Git in its native resolver/catalog generators.
This is an explicit compatibility adapter, **not a Git-free Producer contract**.
Removing that native requirement needs a coordinated Scriptorium implementation
and a newly published immutable Release; the consumer does not rewrite its
published scripts or replace clean checks with an arbitrary revision variable.

## Verification

- Node 24.21.0; frozen pnpm 11.18.0 install: PASS, no lockfile changes.
- `corepack pnpm@11.18.0 check`: PASS, using the existing Corepack PATH shims
  because the ambient nested pnpm command resolves to 12.10.1.
- Unit regression: PASS for modified tracked source, untracked source, wrong
  revision/tree and mismatched/extra/missing exported identity fields.
- Context regression: PASS with Producer ignore files excluding everything;
  Git files, tracked documentation and relative symlinks survive in the nested
  snapshot, without an ignore file at the named-context root.
- Actual v0.3.7 Metadata solve through the explicit named snapshot, with **no
  Dockerfile-specific ignore override**: PASS. Catalog/runtime schemas and their
  immutable revision/image digest bindings plus exported source identity passed.
  This was a metadata-only solve; the input image digests came from the retained
  production Runtime Base and BuildKit solves, not a newly certified full build.
- Required CI fixture now pins this same published v0.3.7 ID/tag/SHA. It exercises
  actual Runtime Base/BuildKit/metadata, disposable registry, source signature,
  canonical Admission and synthetic Stable CAS. Production Canary/Stable and
  browser acceptance remain NOT_CHECKED by this pre-deployment record.

Private working logs and test inputs are outside Git under
`/tmp/praetorium-source-contract-probe/`; no credentials are included here.

## Authorized production delivery

Executable source `4325be76406b3e11402568cf929724714e0f2cbe` was committed and
pushed to main, then deployed through the existing `deploy-platform.mjs --apply`
to the owned `praetorium-runtime` environment. The command completed its K3s,
Management Coordination and Cloudflare rollout. Admin Worker version:
`86b1edcf-b519-47f5-a535-66c203acd83f`.

CI run `40094023022` passed all eight required jobs on attempt 2. Attempt 1
completed real v0.3.7 build/proof/Admission/composition and synthetic Stable CAS,
then failed its disposable directory cleanup timeout; that failure is preserved.
The initial production image build also failed during Corepack's download with
`UND_ERR_SOCKET` through the internal BuildKit proxy. The subsequent deployment
attempt completed without changing egress policy, keys or data.

At the owner's request, no additional hosted acceptance or Source retry was
initiated after deployment. Their own v0.3.7 retry was distinct from this work.
Production Source/Canary/Stable acceptance therefore remains NOT_CHECKED here.

The owner subsequently designated CI as the canonical platform service image
publisher. The follow-up pipeline change makes main CI publish GHCR digests and
makes deployment consume its exact workflow receipts without rebuilding.
Additional local install/check runs for that change were omitted at the owner's
explicit instruction; the configured CI remains responsible for its normal jobs.
