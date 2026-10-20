# Production identity renewal follow-up

Times below are UTC on 2026-10-20 (2026-10-21 in Japan).

The owner reported that the HTTPS warning disappeared in a fresh Chrome
incognito context, but that the browser session expired quickly. Authenticated
browser refresh remains **NOT_CHECKED**: no authenticated browser state is
available to the operator, and bounded Gateway tails did not capture a refresh
request. This report does not certify that the browser symptom is resolved.

## Runtime Git identity: repaired and deployed

The Provisioner idle controller compared a physical runtime ID with the logical
instance ID and therefore skipped ongoing identity renewal. The mounted
epoch-3 identity was observed expired. Commit `dc7b082` resolves the expected
physical ID with the existing legacy-epoch contract while retaining repository,
cluster, suspension, desired-state and runtime-epoch checks. It also includes
the separately reviewed reclaim recovery in `c512fc0`.

- Exact service source: `dc7b082626a6d71b47616d75789ea7e376271a6d`.
- Publication: [run 39444806923](https://github.com/yohn-jp/praetorium/actions/runs/39444806923), all verification/publication jobs passed.
- Provisioner OCI index: `sha256:4ec3bb9414a889bc87b37ae32546489657731b839cda42abf5fcb81225917f87`.
- Linux/amd64 manifest: `sha256:b1ec0d6536ea4bfd9d13f6f36cdecc1c3381357c8aa6c691fa9d2a5cef4ce96d`.
- Index, child/config digests and SLSA source/subject were verified before deployment.
- Canonical `scripts/deploy-k3s.mjs` deployment completed successfully, using the existing staged inventory and `Recreate` strategy.
- New Provisioner started at `15:07:56Z`, UID `97d09add-c5ec-420a-8566-e60e25ee5952`.
- No manual identity renewal was performed after the bounded recovery at `15:03:03Z`.
- Autonomous renewal counter advanced to 1, 2, then 3 by approximately `15:16Z`; no identity refresh failure counter was observed.
- The second renewal reached the mounted file at `15:12:49Z`, with epoch 3 and expiry `15:16:28Z`.
- The third renewal was mounted by `15:16:00.826Z`, with expiry `15:20:04Z`.
- Tenant Pod UID stayed `5e78235c-e177-4c26-9e91-6995aebaca72`, Ready, restart count 0.

This demonstrates continued identity renewal beyond the original five-minute
identity lifetime. It does not certify a GitHub push or browser session refresh.
The pinned Scriptorium source rereads the projected identity on each Git
credential operation; it does not require a tenant restart to consume renewal.
The separate idle observation error was subsequently identified below.

## Browser refresh: diagnostic evidence still required

Runtime Git identity and browser access grants use separate verification paths.
The Gateway session is configured for 12 hours; write-capable repository access
decisions limit individual browser grants to 30 seconds. Those short grants
should refresh transparently and do not justify repeated interactive login.

Commit `036bd3b` adds a bounded `instance_access_refresh_rejected` event with
only the closed refresh error code. It records no credentials, request contents,
user/session identifiers or raw error messages; the existing generic client
response is unchanged. Gateway version
`51412a47-c746-4da1-875e-07d4459fd9d4` was deployed by `15:10:49Z`.
Control Plane source `dc7b082` was deployed as version
`8d29af81-521b-404c-aadb-f4079ebba9d3` without a schema migration.

For both code changes, `corepack pnpm@11.18.0 install --frozen-lockfile` and
`corepack pnpm@11.18.0 check` passed, using the pnpm 11 shim for nested commands.
Independent read-only reviews found no material defect. The diagnostic commit's
[main CI run](https://github.com/yohn-jp/praetorium/actions/runs/39446004424)
also passed, including Kubernetes admission and all four candidate image builds.

## Idle stop and retained legacy canary metadata

The safe Provisioner error diagnostic in `5519c9a` passed frozen install, full
check and independent review. Publication [39447799693](https://github.com/yohn-jp/praetorium/actions/runs/39447799693)
passed. Source, OCI hashes and SLSA subject/source were verified before the
canonical deployment completed. The current Provisioner index is
`sha256:0fbd24700dde7aa9ec5bf7ca1ff1b5346da981e310f4709fa9c12c95ff07323b`
(amd64 `sha256:15325716ace52f690b347881aa401e28915e667bd27812611c9a8a5690c04e18`),
Ready at `15:27:21Z`.

Natural retries then exposed `409 idle_stop_fence_conflict`. Read-only D1
inspection established that a retained `canary_observing` workflow referred to
a succeeded generation-2/epoch-1 operation. The current instance was
generation 4/epoch 3. All other inspected stop predicates passed. The health
scheduler correctly excluded the old tuple, while the atomic idle-stop fence
continued to protect the logical binding from stopping during that old workflow.

Under the owner's explicit instruction to discard the entire old environment,
the operator administratively blocked this one pre-reset workflow. Its full
row was backed up. A fresh Kubernetes and Runtime-host census confirmed one
Ready epoch-3 writer, no epoch-1 workload, no legacy Pod UID/process/cgroup, and
no old K3s Server. The review covered a narrowly fenced workflow update and
same-batch audit, using the existing transaction sentinel. The exact updated
row revision, lease tuple, old succeeded operation, current ready tuple,
released old reservation, reserved current reservation, and absence of active
operations were checked atomically. The result changed one workflow row and
inserted one audit event: workflow revision 403 → 404, state `blocked`, reason
`owner_authorized_legacy_environment_discarded`.

This is an administrative legacy abort. `canary_cleanup_complete` remains 0
and cleanup evidence remains null; no normal canary cleanup or promotion is
certified. The batch did not change the current instance, runtime, reservation,
operation or artifact admission. The existing stale canary cleanup code must
not be used to stop a replacement runtime.

The normal Provisioner timer subsequently requested idle stop at
`15:47:21.676Z`, creating `op_01M5CZXVCASQG1MG32CNF09QAY`, generation 5/epoch 3.
At `15:48:54Z` it remained pending with attempt/lease epoch 0. Natural
notification delivery and stop completion were still **NOT_CHECKED**; no
manual wake-up hint had been sent for this operation.

The missed-notification recovery poll claimed the stop at `15:52:29Z`. The
first attempt persisted `quiescing-old`, then returned the Control Plane error
`upstream_unavailable`. Attempt 2 checkpointed `unknown` at `15:57:34Z`, with
`producer_remote_preflight_unverified`. No old-quiesced, writer-absence or
physical stop checkpoint was observed. The mounted Git identity expired at
`15:55:04Z`; a persisted quiesce request intentionally closes further observed
identity issuance until matching resume and a cleared accepted checkpoint.

A read-only count at `16:03:22Z` found 378 unexpired `revocation_pending`
Git credentials and eight revoked records for epoch 3. The Gateway retires
at most eight credentials per call, while the post-checkpoint Control Plane
barrier requires the authoritative pending count to reach zero. Resumable
retirement and recovery after this durable checkpoint are under repair.
The producer's quiesce route does not emit `upstream_unavailable`; the first
error came from the Control Plane API. Stop/Wake acceptance remains incomplete.

## Observed Cloudflare traffic

A valid buffered JSON tail capture covered `15:25:32–15:30:38Z` (306 seconds):
Control Plane had 236 HTTP requests and one scheduled invocation; Gateway had
94 HTTP requests. Control Plane returned twelve 409 responses in the aggregate;
Gateway HTTP responses were all 200. The streams were visibly receiving
structured events. An earlier collector that incorrectly parsed multiline
JSON one line at a time was discarded.

The window crosses the Provisioner rollout, and user activity is unknown. It
therefore does **not** certify an idle baseline or reduced unnecessary traffic.
Broad route buckets do not establish individual causes; CPU/D1/DO consumption
and receiver-side request counts were not checked.

## Retirement repair: staged rollout requirement

The first repair (`4e26fc1`) makes each bounded retirement batch resumable:
Gateway returns batch progress, Control Plane rechecks the authoritative D1
pending count, and the Provisioner repeats the identical checkpoint under its
live lease. Exact checkpoint replay retains the existing sequence and rejects
changed lease/payload/phase. The in-lease journal no longer reloads an older
checkpoint from the immutable claim. Frozen install and the full check passed.
The later deployment and actual results are recorded below.

Independent review found a cross-version constraint: the old Provisioner
accepts any 2xx checkpoint response and would ignore the new pending field.
Therefore deploy the new Provisioner first using `Recreate`, verify it is the
only controller, then deploy Gateway, then Control Plane. The old Control Plane
continues returning a fail-closed error until that last step. Rollback must
restore Control Plane before restoring the old Provisioner. A passing unit
suite alone does not establish safe mixed-version rollout.

One manual, coalescible hint through Management's loopback Coordination endpoint
returned HTTP 202; that relay response requires a downstream Provisioner 2xx.
This verifies this one manual transport path. It does not certify natural
Control Plane/VPC notification delivery or operation completion.

## Conditional cross-tab refresh failure

A synthetic local test using the actual Instance Access handler reproduced a
shared-cookie race. Separate browser tabs can submit the same one-use refresh
credential because the pinned client's refresh promise is local to each tab.
One rotation succeeds; the losing tab receives 401 and navigates to
`/_platform/reauth`, which clears the shared access, refresh and CSRF cookies,
including the winner's newly rotated cookies. The saved disposable test passed
(1 test); its SHA-256 is
`8fe64c2cc41d1e171b128d75f45b436b5c6a9058af2dbf40b31db9097edee9f5`.

This confirms a conditional failure mode, not the cause of the owner's report.
No authenticated production browser was used, and no authentication behavior
was changed. The single-tab early-expiry symptom remains unresolved.

## Deployed retirement and quiesce recovery — 16:42 UTC

Source `33248126af14c05ea54fdcf10c2d347aabe2180f` passed frozen install,
full check and independent review. The review's legacy-physical-identity omission
was fixed with a regression shown to fail before the fix and pass afterward.
The earlier publication of `bd32cbd` was cancelled; it was not deployed.
[Publication 39458937755](https://github.com/yohn-jp/praetorium/actions/runs/39458937755)
passed verification and all four publication jobs. Registry index, amd64
manifest/config and SLSA source/subject digests were verified.

Provisioner index:
`sha256:0c8049ae543447176dd66e207e0d9f5fa0722a0e59d8d1aa87dbc61dfe3354bc`.
Canonical deployment completed successfully using `Recreate`; one new Ready
Provisioner with UID `66cc5195-5351-4a95-80f1-b4a661b6e248` was verified before
Gateway version `7ff0b6e3-ea9d-407e-895a-4bcdbdc594c6` and Control Plane version
`3d088d70-acee-4f33-b15a-a3c7b9815c5c` were deployed in that order. No schema
migration was used. A normal coalescible recovery hint returned HTTP 202.

The 16:38:01 D1 baseline had 96 unexpired pending credentials. At 16:42:21,
there were 60 future-expiry revoked credentials and no pending credentials;
30 new active credentials also had future expiry. The operation reached a
durable `accepted` checkpoint at sequence 13 with its quiesce request cleared.
This demonstrates multi-batch retirement and recovery into normal credential
issuance. It does not certify stop completion.

The normal lifecycle subsequently checkpointed `unknown` at sequence 14,
16:42:53, with `producer_remote_preflight_unverified` and null quiesce request,
receipt and writer-absence proof. The tenant remained Running/Ready. A bounded,
fetch-only Core observation on an owned temporary workspace copy returned
`fresh`, remote commit `c1d9c951965c225d4325dbb873b9d142ccef3c58`, pending count 0.
The copy excluded inherited `.locks` markers; the original workspace was not
changed. This checks the Git read path, not the running producer's persistence
census or Writer absence. Stop/Wake and authenticated browser acceptance remain
incomplete.

## Producer census timing confirmed — 16:53 UTC

A read-only probe used the current normal worker lease and a newly issued,
scoped status credential for each request. Three adjacent GETs returned 200:

1. 3,953 ms: unknown persistence, no remote revision (the in-flight placeholder).
2. 3,194 ms: verified persistence, commit `c1d9c951965c225d4325dbb873b9d142ccef3c58`, remote observation `16:53:28.790Z`, status observation `16:53:28.819Z`.
3. 3,937 ms: a new unknown placeholder after the completed census was discarded.

All runtime identity, image, composition and module comparisons matched.
The pinned producer discards its shared census when it finishes. If the initial
adjacent retry budget was spent before the renewed Secret reached the Pod,
subsequent single reads separated by five seconds could repeatedly miss the
completed census. Commit `c78f678` resets the adjacent-read budget after each
bounded delayed wait. Its regression, frozen install, full check and independent
review passed. Publication 39461853805 and canonical deployment subsequently passed;
the next normal attempt still failed freshness checking, as explained below.
This timing repair does not certify authenticated browser session renewal.


## Logical identity correction and actual safety block — 17:17 UTC

The retry path compared the producer's physical instance ID with a predicate
that expects the logical instance ID. Commit `a4cf009` keeps the strict wire
physical-ID/repository/epoch check, then normalizes the status before checking
freshness. A regression covers a nonlegacy physical epoch and an immediately
verified response. Frozen install, full check and independent review passed.

[Publication 39463844698](https://github.com/yohn-jp/praetorium/actions/runs/39463844698)
passed verification and all four publication jobs. OCI index, amd64 manifest,
config and SLSA source/subject were verified before the canonical deployment:

- Source: `a4cf0096c008543b10e6cdc820c059d34d67f87a`.
- Provisioner index: `sha256:4e3b9fb3723ad5657662c84a0edbc7755c32ec528f98e982d763a6a6f235c157`.
- Linux/amd64 manifest: `sha256:7d15ec5b365d787465319f68ae58d6637d4bfdf4ebd8bca9efc6102533562222`.
- Sole Ready Provisioner Pod UID: `47ef4419-41f7-4a15-9e61-6a38c79cdf55`.

The normal worker's attempt 18 reached producer quiesce. At `17:17:17Z`, the
operation was terminal `blocked`, with `producer_quiesce_blocked` at checkpoint
23. The producer was resumed and the accepted checkpoint cleared the quiesce
request before recording the block. There is no writer-absence proof. The
instance remains desired stopped at generation 5, observed ready at generation
4/epoch 3; the original tenant writer continues running. Stop/Wake has **not**
passed.

A bounded, fetch-only Core census on an owned scratch copy returned a fresh
remote observation, zero pending checkpoints, zero pending proposals, and
`localWorkspaceDirty: true`. The original workspace and locks were unchanged.
This is current workspace evidence, not a recovery of the producer's historical
quiesce reason array or its in-memory activity counters. The dirty category is
under investigation; no user work has been discarded.

A further defect was identified: the Provisioner drops desired-stopped
candidates from identity renewal even when a blocked stop retains the observed
Ready writer. The existing Control Plane observed-writer issuer can renew after
a matching resume and durable quiesce clear, subject to the current binding,
reservation and nonretirement fences. A scheduler repair is in progress. Browser
session expiry remains a separate unresolved acceptance gate.


## Clean workspace and producer predicate false positive

A subsequent read-only check of the live repository used the pinned producer's
exact Git status predicate, including ignored files. It returned zero records.
The branch is `main`, HEAD equals the observed remote commit, ahead/behind is
0/0, there are no tags or additional remote branches, and no reflog commit lies
outside the current history. The symbolic `refs/remotes/origin/HEAD` is present.
Its target is `refs/remotes/origin/main` followed by a newline.

In pinned producer `008d5c429ec279a424cafd5b8c4cbee70a613b8e`, the Git helper
returns raw stdout, but `hasUnknownLocalDurabilityRefs` compares the symbolic
reference target without trimming. The normal trailing newline therefore
causes a false positive for this clean repository. No Git references or
workspace files were deleted to bypass the producer predicate. This explains
a concrete workspace-dirty contribution; it does not recover the historical
quiesce receipt's complete reason list.

The private read-only predicate evidence has SHA-256
`a1ea13e5773814aaf1aa02aa1b0e6c96e519a1205c5b10f50ce2e146e961aad4`.

A replacement producer alone does not prove safe retirement of the current
writer: the current immutable producer must still satisfy the existing
quiesce/writer-absence contract. Producer-source repair and a supported
recovery path remain separate pending work.


## Retained writer renewal and conditional browser repair — staged

The retained-writer scheduler repair returns stopped, unsuspended bindings
without active operations using their observed Ready generation and epoch.
Running candidates still require desired/observed generation equality. The
Provisioner keeps only the identity-expiry timer for a retained writer and
removes idle/status/canary timers and the idle deadline. Renewal continues to
use the existing observed-writer authority reader and issuer; no status-only
credential guard or quiesce/retirement fence was relaxed.

Instance Access also repairs the reproduced cross-tab race by leaving shared
authentication cookies intact on reauth navigation. The existing Gateway entry
requires a current Gateway session and fresh repository authorization before
issuing a one-use handoff that replaces the cookies. Explicit logout continues
to revoke and clear them. A successful refresh restores the deterministic CSRF
cookie along with access and refresh cookies.

An initial correlation-marker implementation was rejected during review:
a reauth request carrying old cookies could still return its clearing response
after a successful refresh had installed newer cookies. Avoiding cookie writes
on reauth removes that response-order race without adding correlation state.

Actual-handler tests cover reauth responses delivered after the winning
refresh, multiple stale tabs, navigation guards and the existing logout/CSRF
checks. Both repairs and the narrow stale-running-candidate 409 revalidation
passed independent read-only review. On combined source `755b167`, root ran
`corepack pnpm@11.18.0 install --frozen-lockfile` and
`PATH=/tmp/praetorium-pnpm11-bin:$PATH corepack pnpm@11.18.0 check`; both passed.
Deployment is pending. These checks do not certify authenticated hosted refresh
or resolution of the owner's symptom.


## Production deployment and sustained renewal — 17:49–18:04 UTC

[Publication 39468579199](https://github.com/yohn-jp/praetorium/actions/runs/39468579199)
passed verification and all four publication jobs at exact source
`fb81de593f8892f4d20f223a42860cbbe91128d1`. Registry index, amd64 manifest/config,
source-tag consistency and SLSA source/subject were verified for both services:

- Provisioner index: `sha256:bee35f2f63e6b4b98d02cc41c9a793203d311e43e377ae72247fd40608cb7848`.
- Instance Access index: `sha256:9e8b5acc836cb99cad78ef28762545de6fbbff134698e72af4f4d38eb32f180d`.

Control Plane was deployed first as version
`a775718b-cd97-4d98-a394-8e88ea58267a`: the previous Provisioner safely ignores
stopped candidates, while the new Provisioner needs the new candidate reader
at startup. The canonical K3s deployment then completed successfully, changing
only the two service image pins. Provisioner Pod UID
`7ffcf30c-108a-459a-8300-9c085c62d747` and Instance Access Pod UID
`57f7762c-e53e-4e35-a0af-8e1d6500b17f` were Ready with no restarts. The tenant
retained its original Pod UID and restart count zero.

Normal Provisioner startup renewed the retained writer's identity without a
manual issuance. At `17:49:30`, the mounted epoch-3 proof expired at `17:53:40`.
The next proof expired at `17:57:10`; its projection changed at `17:53:03.301`,
before the previous proof expired. At `18:04:00`, the normal renewal counter was
5, with no refresh-failure metric present, and the mounted proof remained valid
until `18:07:40`. This demonstrates renewal across multiple five-minute proof
lifetimes while the desired state remains stopped and the writer remains Ready.

A public same-origin HTML navigation to `/_platform/reauth` returned 302 to the
canonical Gateway entry with TLS verification result 0 and no `Set-Cookie`.
Authenticated Chrome refresh remains **NOT_CHECKED**; the owner was asked to
retest login, wait over a minute, then edit/save after the actual deployment.
The conditional race repair alone does not prove the original browser symptom
is resolved.

## Current writer metadata maintenance and rollback evidence

The current writer was repaired without changing its immutable image or source.
The optional `origin/HEAD` symbolic alias pointed to the already retained
`origin/main`; removing that alias changes no commit or worktree content
([Git remote documentation](https://git-scm.com/docs/git-remote)). The operation
used the exact pinned CoreStore's real cross-process project lock. Lock
contention or a stale lock would abort; no existing lock was evicted.

The complete project-workspace backup contains 27 files / 64 entries / 18,817
bytes, excluding the live lock directory. The usage directory was independently
verified to be `/data/history`, outside this workspace. The persisted backup's
content manifest is
`49f227c826189bf1a2b1259991ef80141beb71242bea8c932652ac6ac5da1bee`.
Every file's bytes were verified and restored in an owned local scratch before
maintenance.

The first exact-ref guard aborted before mutation because the initial inventory
had omitted Core's checkpoint/reconciled refs. Both actually pointed to the
expected remote commit. The corrected guard requires exactly those five refs
and pins all relevant heads to that commit. A second attempt deleted only the
alias/reflog but failed its postcheck when the container's Git also pruned their
empty parent directories. The scratch preflight had checked file bytes and refs
but missed directory presence. That attempt was rolled back under the real
Core lock: the original manifest, including all file bytes, modes, uid/gid and
directories, was restored exactly. It remains a failed attempt in the record.

Independent review and five comparison cases then verified a narrow allowance
for empty ancestor directories containing only the two allowed metadata files.
The final guarded attempt succeeded. It removed only the redundant alias, its
own reflog and their two empty parent directories. HEAD, origin/main, both Core
heads, index, worktree and every other file remained unchanged. No D1 lifecycle
row was edited and no runtime was force-stopped.

A subsequent fetch-only census using the pinned Core on an owned scratch copy
returned fresh remote commit `c1d9c951965c225d4325dbb873b9d142ccef3c58`, zero
pending checkpoints, zero proposals, and `localWorkspaceDirty: false`. This is
copy-based diagnostic evidence; it is not a live quiesce receipt or writer
absence proof. At `18:04:22`, read-only D1 inspection still showed desired
stopped generation 5, observed Ready generation 4/epoch 3, zero active
operations, and the original terminal blocked stop. A newly authorized normal
retry/wake and actual stop/reconnect remain pending. Idle traffic acceptance
has not been measured on a stopped instance.

The permanent producer correction is prepared separately as a one-line trim
plus symbolic-HEAD regression patch. It was checked and applied only in an
owned disposable fixture containing the exact pinned source files. The
separately coordinated Scriptorium checkout was not changed; its build/tests,
publication and admission for a corrected producer remain **NOT_CHECKED**.
Workspaces containing this valid optional alias, including imported or restored
checkouts, still require the source correction or explicit maintenance.


## Permanent correction validated in isolation

The verification derivative patch has SHA-256
`f8a1e6bc2406b3b68a1f54a222466883d80cb34420207a90d95cc4c8277eae0f`.
It was tested in an owned `git archive` snapshot of exact producer `008d5c4`;
no producer branch/worktree or existing checkout was changed. The original
assertion-only fixture lacked `origin/HEAD`, so the derivative explicitly creates
that valid alias before testing the census. With this same fixture, unpatched
source reports dirty and fails; the one-line `target.trim()` correction passes.
Frozen install with the producer's pnpm 12.10.1 contract, Core build, typecheck
and all 70 Core tests passed. Full producer workspace checks, image publication,
admission and hosted acceptance were not run. Source integration remains with
the separately coordinated Scriptorium owner; a handoff decision is pending.

The [main CI run for `371684a`](https://github.com/yohn-jp/praetorium/actions/runs/39471719454)
completed successfully, including source verification, four candidate image
builds and Kubernetes admission. Its publication job was skipped as expected
for a push; production images remain the explicitly published `fb81de5` cut.

A read-only release-path audit found no safe operator-only shortcut around the
current lifecycle state. The same admitted artifact deduplicates to the old
terminal blocked candidate. Operator retry covers only pristine pre-runtime
canary build failures; this workflow already has a prior runtime and operation.
Canary health also requires a running assignment with a matching current tuple.
The normal authenticated lifecycle recovery/wake prerequisite remains pending;
no private Gateway retry route was called with a fabricated principal.
