# Source Build detail production version mismatch

Target: `sr_730c616f-329c-4d2f-aabb-d143eaa2db01`. Source: main
`1930131e6858e5d9035abe1dcd82d4ae654c622d` (PR #41).

## Cause and evidence

Read-only SSH reached the existing Management and Runtime hosts. Cloudflare's
existing authenticated management API provided deployed Worker bundles, settings,
deployment history, and read-only D1 results. Credentials and raw bundles remain
outside Git in private evidence under `/tmp/praetorium-admin-detail-evidence`.

Gateway version `360917d9-996d-4d73-8025-d29ce65291fb` requires the strict
`SourceBuildDetailSchema`. Control Plane version
`1b1b8265-fff2-4a4f-892d-c84c6032e4c1` still implements the old detail handler,
returning only `{ job: publicSourceJob(job) }`. D1 had migrations through 0007
and no `source_release_build_attempts` table. This is a deployment mismatch;
main already implements the new detail endpoint. No runtime code or schema
relaxation is required.

The actual D1 row identifies Scriptorium v0.3.4, release 422035682, immutable
commit `588eddcfff20fa2fc76aa8eae54c9551e0c6048b`, failed / SOURCE_BUILD_FAILED,
attempt 1, revision 0, epoch 1. The read reported zero writes.

Applying `SourceBuildDetailSchema.safeParse` to the response structure
reconstructed from that row and the downloaded old handler fails at
`["attempts"]`, `["nextCursor"]`, and `["evidence"]` (missing fields).
**NOT_CHECKED:** authenticated live Control Plane detail-response capture and
schema validation. The historical credential available locally returned 401;
the reconstruction must not be described as an actual HTTP 200 response capture.

## Scoped production correction

Existing Cloudflare preflight passed. The existing `deploy-cloudflare.mjs
--migrate` path applied only canonical additive migration
`0008_source_build_diagnostics.sql`, then verified the complete migration history.
The tracked Control Plane Wrangler configuration deployed the existing main
through Wrangler; current version is
`a9cf68b8-0527-4b60-a618-a6e00f954601`. Existing secrets and retained variables
were preserved. Gateway, service images, Kubernetes workloads, keys and DNS
were not changed. There was no job retry, manual data repair or history backfill.

After rollout, Control Plane and Gateway `/healthz` returned 200. Unauthenticated
detail API access returned 401 and Admin detail access returned 403. D1 readback
still shows the same failed job, attempt 1, revision 0, epoch 1, with zero recorded
attempt rows. Its evidence must therefore remain `not_recorded`; no lost logs
were recovered and the original build failure cause remains unknown.

## Verification and remaining gates

- Node 24.21.0; frozen pnpm 11.18.0 install passed without lockfile changes.
- Main workspace `corepack pnpm@11.18.0 check` passed. The first run hit the
  machine's nested pnpm 12 dispatch; rerunning with existing Corepack shims
  on PATH passed without changing repository configuration.
- Main CI [39978156500](https://github.com/yohn-jp/praetorium/actions/runs/39978156500)
  passed all seven jobs for the exact deployed SHA.
- Regression workspace `corepack pnpm@11.18.0 check` passed, including build,
  lint, typecheck, tests, provider boundaries and generated schema parity.
  The initial test compilation needed an explicit `SourceJobInput` annotation;
  the final complete rerun passed.
- Regression fixture uses the real D1 identity/state with migrated local SQLite.
  It checks strict detail validation, empty history / `not_recorded`, unchanged
  job revision/history, and rejection of the old response with the three paths.
  This is local coverage, not hosted acceptance.
- Owner readback after rollout reports: "Diagnostic evidence was not recorded
  for this attempt." This confirms that missing-evidence text was visible for
  the target URL; it does not certify all requested acceptance criteria.
- **NOT_CHECKED:** complete authenticated production Admin detail, Attempt and
  stage timeline, all diagnostic rendering, and reload of the same job. No
  authenticated browser is available in this agent session. No recorded
  diagnostic body exists for this job in D1.

The production acceptance goal remains incomplete until the same job is verified
in authenticated Admin. The regression PR does not require merging to activate
this correction: the deployed runtime change was already on main. Do not merge
this PR without explicit owner approval.
