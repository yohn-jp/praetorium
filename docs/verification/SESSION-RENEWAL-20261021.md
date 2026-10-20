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
review passed. Publication/deployment verification for this follow-up is pending.
This timing repair does not certify authenticated browser session renewal.
