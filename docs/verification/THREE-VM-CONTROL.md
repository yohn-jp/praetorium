# Three-VM Control Plane Integration Evidence

**Evidence cut:** `main@2e13d91627ef546ebd3cf183ad6d8d1b43363b66` (2026-10-20). This records the Control Plane work-hint integration, the provisioned private VPC path, and Management-host verification including an authorized localhost hint probe. It does not certify a Control Plane-to-host VPC notification or complete three-VM acceptance.

## Work-hint contract

The Control Plane emits the canonical `WorkNotificationSchema` payload after durable work registration: version 1, kind `build` or `operation`, and an optional instance ID for operation hints. Existing routes schedule delivery with `waitUntil`; durable request results do not depend on delivery success. The hint carries no work authority: the recipient wakes and checks D1, where claim, lease, attempt fencing, and accepted outcomes remain authoritative.

This change adds an optional Cloudflare Workers VPC Service binding named `COORDINATION_SERVICE`, authenticated with the existing per-kind Worker secret: `BUILD_WORK_NOTIFICATION_TOKEN` for builds and `PROVISIONER_WORK_NOTIFICATION_TOKEN` for operations. It sends the same contract to `POST /internal/work-available`. A successful VPC response ends delivery. A failed or unavailable VPC path falls back to the matching existing per-kind HTTPS URL and token. Redirects are not followed, response bodies are discarded, and each outbound attempt has a 3-second timeout. Duplicate hints remain safe because they carry no claim authority and claims are fenced in D1.

The rootless Coordination service is running on the Management host. It validates that the incoming per-kind token matches the hint kind, then sends the hint once to the corresponding existing Build Worker or Provisioner listener with that target's existing token. A valid local Build Worker probe is recorded below; no operation-kind notification was sent.

## Current recovery and recurring work, checked against code

- `apps/provisioner/src/worker.ts` defaults missed-notification recovery to 300,000 ms and waits on process-local `WorkAvailability` between claims.
- `apps/build-worker/src/config.ts` defaults build reconciliation to 300,000 ms; `packages/application/src/builds/worker.ts` waits on process-local `WorkAvailability` between claims.
- `packages/contracts/src/work-notification.ts` explicitly defines the payload as a coalescible hint, not an assignment or grant. Durable claim APIs and lease heartbeats are unchanged by this patch.
- `apps/control-plane/wrangler.toml` retains its `*/5 * * * *` scheduled invocation. `apps/control-plane/src/worker.ts` runs credential expiry cleanup and the existing optional release recovery there. This timer is not the empty Build/Operation claim loop.
- Existing work creation paths continue to call the canonical notifier, including build admission, configuration, idle wake, operation administration, and release composition.

These source checks show that the code has bounded missed-hint recovery and event-triggered work hints. They do not measure deployed Worker/D1 counts, validate production environment variables, or establish a cost reduction.

## VPC binding setup and rollout state

Cloudflare's current Workers VPC documentation configures a service binding with `[[vpc_services]]`, `binding`, and a provisioned `service_id`. VPC binding `fetch()` requires an absolute URL; the URL host becomes the request Host (and SNI for HTTPS), while the configured VPC Service fixes the actual destination. The Worker uses an absolute internal HTTP URL because the coordinator listener is a private Management-host service.

The initial read-only Cloudflare API inventory on 2026-10-20 found one existing VPC Service, `majiwari-gateway` (`01a02e7e-7491-7421-a124-0ac59c1b6851`), using HTTP `127.0.0.1:8787` through local-config tunnel `64ab5a69-8db1-4637-b9b8-8ec0cf9e94e5`; that tunnel reports `down`. The other healthy account tunnels serve unrelated Arcadia and Stardomain origins. The existing Praetorium tunnel config points `*.instances.praetorium.yohn.jp` to the private Runtime HTTPS endpoint and is separate. The initial deployed `praetorium-control-plane` Worker settings had no VPC binding; a later deployment added the dedicated service binding described below.

After an explicit infrastructure authorization, a dedicated remotely managed Tunnel and Workers VPC Service were created through the Cloudflare API on 2026-10-20:

- Tunnel: `praetorium-management`, ID `37e42176-7e62-4da5-8e99-2bd4b7831cee`, `config_src=cloudflare`.
- VPC Service: `praetorium-management`, ID `01a158fc-ef0d-7d11-8976-af6247908574`, type `http`, target `127.0.0.1:8789`, bound to the dedicated tunnel above.
- Tunnel configuration readback had no ingress rules or hostname routes. No DNS route or public hostname was created.
- The tunnel token is stored only at `/data/praetorium/production/secrets/coordination-tunnel/tunnel-token`, with directory mode 0700 and file mode 0600. Infra's Ansible interface consumes it as `coordination_tunnel_token_src` and installs it at `/var/lib/praetorium/credentials/coordination-tunnel.token` for `cloudflared --token-file`; the credential value is deliberately absent from repository files and logs.
- The production Control Plane deployment record and generated config show exactly one VPC binding, `COORDINATION_SERVICE`, targeting service `01a158fc-ef0d-7d11-8976-af6247908574`. The record is `/data/praetorium/production/verification/control-plane-retained-status-deploy-20261020.log`; the generated config is `/data/praetorium/production/ansible/control-plane-retained-status-config.json`. The latter was parsed for binding name and service ID only; no Worker secret values were read. `apps/control-plane/wrangler.toml` intentionally keeps a commented placeholder because the provisioned service ID is supplied by the production config. A separate read-only Worker settings API request returned HTTP 401 with the available local Wrangler OAuth, so direct live API readback is **NOT_CHECKED**.
- SSH read-only inspection of `manage.praetorium.vm` at 2026-10-20 11:52 UTC found the `praetorium-coordination-tunnel.service` active and four `Registered tunnel connection` log records for the day, all using QUIC. The rootless `praetorium-coordination.service` was active, running image `ghcr.io/yohn-jp/praetorium/coordination@sha256:bf43bed86b8eca82f6bd6dfe2cd6b3ad4382975b6783de2681950edfa1916ced`, while `k3s` was inactive. Local `GET /healthz` returned HTTP 200 `{"status":"ok"}` and `GET /readyz` returned HTTP 200 `{"status":"ready"}`, confirming the service is independent of K3s availability.
- The first Podman inspection found the container **unhealthy** despite the successful endpoint checks. The generated shell command had been parsed as `CMD-SHELL node -e "fetch('http://127.0.0.1:8789/readyz')..."`; it exited 1 with `/bin/sh: 1: Syntax error: Unterminated quoted string`. The owner corrected the source to an exec-form health command in `infrastructure/ansible/roles/coordination/templates/praetorium-coordination.container.j2:16`, avoiding the shell parsing failure. The subsequent bootstrap health-repair log reports `ok=76 changed=2 unreachable=0 failed=0 skipped=3`: `/data/praetorium/production/verification/management-bootstrap-health-repair-20261020.log`. Independent post-repair inspection found the container **running healthy** with failing streak 0, and an explicit `podman healthcheck run praetorium-coordination` exited 0. Fresh `GET /healthz` and `GET /readyz` checks both returned HTTP 200 while `k3s` remained inactive. The repair changed host configuration; this evidence check did not change it.
- The 2026-10-20 bootstrap idempotence rerun log reports `ok=74 changed=0 unreachable=0 failed=0 skipped=3`: `/data/praetorium/production/verification/management-bootstrap-idempotence-20261020.log`.
- Cloudflare OAuth preflight showed `account:read` and `connectivity:admin` scopes; reads confirmed no existing resource with either dedicated name before creation. The tunnel and service create calls both succeeded.

The production deployment record confirms the binding configuration; no Cloudflare deployment was performed for this evidence update. HTTPS fallback remains available. Localhost probes to `127.0.0.1:8789/internal/work-available` read the existing tokens in process memory and printed only status codes:

- Invalid token with a valid build hint: HTTP **401**.
- Existing Provisioner token with a build hint: HTTP **401** (kind/token mismatch).
- Existing Build Worker token with a build hint: HTTP **202**. The coordinator returns 202 only after its selected downstream target responds successfully; source routes a build hint to the Build Worker only. Provisioner fanout was zero for this build-kind probe. No D1 endpoint or operation-creation route was called; the Build Worker may wake to inspect and claim any already-persisted work.

The following gates remain unverified:

- Cloudflare Worker through the deployed VPC binding to Management loopback using a legitimate durable notification: **NOT_CHECKED**. No D1 row or operation was created directly by this check; the local build hint may have woken the Build Worker to inspect or claim already-persisted work.
- Operation-kind notification to Provisioner and its downstream acknowledgement: **NOT_CHECKED**.
- Direct Worker settings API readback: **NOT_CHECKED** (the available OAuth request returned HTTP 401); deployment record and generated config show the service binding.
- Management coordinator health and readiness endpoints plus configured Podman healthcheck: **PASS** after the owner-applied exec-form fix; repair recap and fresh host checks are recorded above.
- Deployed HTTPS fallback configuration and measured notification-loss recovery: **NOT_CHECKED**.
- Idle/active Worker, D1, and notification counts: **NOT_CHECKED**.
- Three-VM deployment and production E2E: **NOT_CHECKED**.

Cloudflare references checked 2026-10-20: [Workers VPC Services](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/), [Workers VPC Binding API](https://developers.cloudflare.com/workers-vpc/api/), [Create a Cloudflare Tunnel](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/methods/create/), [Get a Cloudflare Tunnel token](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/subresources/token/methods/get/), and [Create a Workers VPC Service](https://developers.cloudflare.com/api/resources/connectivity/subresources/directory/subresources/services/methods/create/).

## Local verification

Required repository checks completed in the isolated worktree:

- `corepack pnpm@11.18.0 install --frozen-lockfile`: **PASS**; lockfile unchanged.
- `corepack pnpm@11.18.0 check`: **PASS** (build, lint, typecheck, all tests, boundary checks, and contract schema drift checks).
- The check command ran with a temporary `pnpm` shim that removes inherited `COREPACK_ROOT`; without it, nested package scripts selected the globally installed pnpm 12 instead of repository-pinned pnpm 11.18.0. Turbo emitted its existing warning that `patchedDependencies.@sigstore/core@4.0.1` is a string where its workspace parser expects a mapping; all check tasks still passed.
- Focused Control Plane notification tests: **PASS**, 9/9, including VPC authentication, per-kind token selection, HTTPS fallback on HTTP failure, and HTTPS fallback on connection error.

The retained-status code change was checked in the integration run at `main@9f93763`; the full frozen install and `pnpm check` passed there. This evidence-only update ran `git diff --check`. Local tests and Management-host localhost probes do not establish the complete Cloudflare VPC-to-host path, operation fanout, or production recovery behavior.
