# Delivery verification cut: 4f52afd

Clean main source cut `4f52afd5de0d45ccc51d1b87db7ec95d71b2140f` was pushed to
origin/main. All production files under apps/packages/plugins/infrastructure/scripts
are identical to reviewed `b3fbe6d`; later changes are verification code and docs.
The delivery HEAD can include subsequent documentation reconciliation; inspect
`git rev-parse HEAD` and the remote main ref for that enclosing commit.

The coverage ledger preserves all 59 parent entries and 65 expanded handler
mappings. Partial/unverified entries retain their individual blockers; mapping
completeness does not establish real runtime acceptance.

Root fresh verification:

| Check                                             | Result                                                                         | Limit                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Required frozen install and full `check`          | PASS; test stage 29/29 Turbo tasks, 29 cached                                  | Local build/lint/typecheck/tests/boundaries/schema, not deployed acceptance |
| Explicit new-file ESLint                          | PASS                                                                           | Includes both new integration probes and actual apply wiring                |
| Infra and coverage/mapping tests                  | 56 passed,0 failed/skipped                                                     | Actual local canonical Kustomize render; no cluster                         |
| Kubernetes identity/admission/health/config tests | 4 passed                                                                       | Synthetic response/input cases, not API-server enforcement                  |
| GitHub partial probe                              | 6 local tests passed;1 live test skipped/BLOCKED                               | No owner config, no GitHub request or Git write                             |
| Fixed T14 harness                                 | Worker/D1/DO VERIFIED; six categories BLOCKED/NOT_CHECKED, errors `[]`, exit 2 | Actual local Wrangler/Miniflare/D1/DO only                                  |
| Unconfigured full Kubernetes file                 | exit 1 at missing inventory                                                    | Before transport construction; actual acceptance NOT_CHECKED                |

The fixed report was generated `2026-10-17T02:07:01.714Z` using inventory
`praetorium-t14-miniflare-4f52afd`, owned by `sophia uid=1000`, explicitly
nonproduction/disposable and expiring `2026-10-17T02:36:58.766984+00:00`.
Only the local Worker resource was available. Its temporary persistence was
created and removed by the fixed runner; no Cloudflare call occurred.

Logs are `/tmp/praetorium-4f52afd-{install,check,extra-lint}.log`,
`/tmp/praetorium-4f52afd-infra-mapping.log`,
`/tmp/praetorium-4f52afd-kube-{local,unconfigured}.log`,
`/tmp/praetorium-4f52afd-github-local.log`, and
`/tmp/praetorium-4f52afd-acceptance.{json,stderr}`. Local validation fixtures
used `TMPDIR=/dev/shm` after a reviewer observed ENOSPC on the root filesystem;
no unrelated data was removed. This does not establish off-host durability.

The real local synthetic-metadata Restic restore remains pinned to `b3fbe6d`:
11217.63 ms test / 11285.77 ms process, 1 pass. Its production source and migrations
are unchanged here. Other historical browser/credential/process measurements
retain their separately named cuts. No real composition build/cache-hit/start/
redeploy/resource-use measurement exists.

Independent reviews closed the Kind/admission apply/defaulting and Traefik
priority findings, plus the Kubernetes runner's namespace, health ownership,
metadata positive-control, cleanup and actual upstream denial-format defects.
The GitHub partial probe was separately reviewed through worker `0ad7d3f3`:
owner files use bounded descriptor checks, lifetime guards apply to each new
external operation, cleanup remains available, and uncertain pushes fail with
sanitized recovery records even if a later ref snapshot is absent. Only explicit
completed HTTP 403/404 fatal responses can count as expected negative pushes;
invalid credentials and hook output cannot. The live probe was not executed.

The full migration remains incomplete. T06 needs a concrete OCI/module-closure
inspector and smoke executor after the producer ABI; T09 needs evidence-backed
rollback compatibility. Five fixed real-category runners remain absent. The
Kubernetes runner is implemented but requires an owned cluster, separate tokens,
probe image, ingress/public markers and owned metadata canary. The GitHub partial
probe is deliberately not registered as the fixed `github-access` runner and
cannot certify expiry-backed runtime credential renewal.

Observed producer checkpoint is `fc4eea880ef895decf6161bf4f45cc958e9700b3`;
accepted Platform artifactDigest is null. S01–S04 hosted contracts and S05 hosted
composition/conformance remain missing. Local Core/full component digests and
limitations are recorded in [PRODUCER-fc4eea8.md](PRODUCER-fc4eea8.md). Supplying
those contracts plus explicitly owned environments is required before the
remaining implementations and real gates can finish. T15 full certification is
blocked. No production deployment, key change, release/package publication or
legacy-data retirement occurred.
