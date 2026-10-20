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
- Tenant Pod UID stayed `5e78235c-e177-4c26-9e91-6995aebaca72`, Ready, restart count 0.

This demonstrates continued identity renewal beyond the original five-minute
identity lifetime. It does not certify a GitHub push or browser session refresh.
The pinned Scriptorium source rereads the projected identity on each Git
credential operation; it does not require a tenant restart to consume renewal.
Separate `idle_observation_unavailable` errors remain under investigation.

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
