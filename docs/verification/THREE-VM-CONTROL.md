# Three-VM Control Plane Integration Evidence

**Source cut:** branch `migration/control`, based on `main@59449ffd65a9210435b882504933cbaf57db1418` (2026-10-20). This records the Control Plane work-hint integration only; it does not certify a deployed VPC path or the complete three-VM migration.

## Work-hint contract

The Control Plane already emits the canonical `WorkNotificationSchema` payload after durable work registration: version 1, kind `build` or `operation`, and an optional instance ID for operation hints. Existing routes schedule delivery with `waitUntil`; durable request results do not depend on delivery success. The hint only wakes a worker to inspect D1. Claim, lease, attempt fencing, and accepted outcomes remain under the existing D1-backed APIs.

This change adds an optional Cloudflare Workers VPC Service binding named `COORDINATION_SERVICE`, authenticated with the existing per-kind Worker secret: `BUILD_WORK_NOTIFICATION_TOKEN` for builds and `PROVISIONER_WORK_NOTIFICATION_TOKEN` for operations. It sends the same contract to `POST /internal/work-available`. A successful VPC response ends delivery. A failed or unavailable VPC path falls back to the matching existing per-kind HTTPS URL and token. Redirects are not followed, response bodies are discarded, and each outbound attempt has a 3-second timeout. Duplicate hints remain safe because they carry no claim authority and claims are fenced in D1.

The coordinator implementation is being developed separately. It has confirmed this endpoint and token contract, will validate the matching per-kind token, and will fan the hint to the existing build and Provisioner listeners using the same corresponding token.

## Current recovery and recurring work, checked against code

- `apps/provisioner/src/worker.ts` defaults missed-notification recovery to 300,000 ms and waits on process-local `WorkAvailability` between claims.
- `apps/build-worker/src/config.ts` defaults build reconciliation to 300,000 ms; `packages/application/src/builds/worker.ts` waits on process-local `WorkAvailability` between claims.
- `packages/contracts/src/work-notification.ts` explicitly defines the payload as a coalescible hint, not an assignment or grant. Durable claim APIs and lease heartbeats are unchanged by this patch.
- `apps/control-plane/wrangler.toml` retains its `*/5 * * * *` scheduled invocation. `apps/control-plane/src/worker.ts` runs credential expiry cleanup and the existing optional release recovery there. This timer is not the empty Build/Operation claim loop.
- Existing work creation paths continue to call the canonical notifier, including build admission, configuration, idle wake, operation administration, and release composition.

These source checks show that the code has bounded missed-hint recovery and event-triggered work hints. They do not measure deployed Worker/D1 counts, validate production environment variables, or establish a cost reduction.

## VPC binding setup and rollout state

Cloudflare's current Workers VPC documentation configures a service binding with `[[vpc_services]]`, `binding`, and a provisioned `service_id`. VPC binding `fetch()` requires an absolute URL; the URL host becomes the request Host (and SNI for HTTPS), while the configured VPC Service fixes the actual destination. The Worker uses an absolute internal HTTP URL because the coordinator listener is a private Management-host service; the service ID and port remain infrastructure-owned.

Read-only Cloudflare API inventory on 2026-10-20 found one existing VPC Service, `majiwari-gateway` (`01a02e7e-7491-7421-a124-0ac59c1b6851`), using HTTP `127.0.0.1:8787` through local-config tunnel `64ab5a69-8db1-4637-b9b8-8ec0cf9e94e5`; that tunnel reports `down`. The other healthy account tunnels serve unrelated Arcadia and Stardomain origins. The existing Praetorium tunnel config points `*.instances.praetorium.yohn.jp` to `https://10.7.0.31:443` and is separate. The deployed `praetorium-control-plane` Worker settings contain no VPC binding. No Management coordinator VPC Service or Tunnel is present.

The Wrangler file therefore documents the optional binding without reusing an unrelated service or inventing an ID. HTTPS fallback remains available during rollout. The following gates remain unverified:

- Dedicated Management VPC Service and Tunnel creation/configuration: **NOT_CHECKED**.
- Cloudflare binding deployment and authenticated request to the rootless coordinator: **NOT_CHECKED**.
- Coordinator-to-build/Provisioner fanout and restart recovery: **NOT_CHECKED**.
- Deployed HTTPS fallback configuration and measured notification-loss recovery: **NOT_CHECKED**.
- Idle/active Worker, D1, and notification counts: **NOT_CHECKED**.
- Three-VM deployment and production E2E: **NOT_CHECKED**.

Cloudflare references checked 2026-10-20: [Workers VPC Services](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/) and [Workers VPC Binding API](https://developers.cloudflare.com/workers-vpc/api/).

## Local verification

Required repository checks completed in the isolated worktree:

- `corepack pnpm@11.18.0 install --frozen-lockfile`: **PASS**; lockfile unchanged.
- `corepack pnpm@11.18.0 check`: **PASS** (build, lint, typecheck, all tests, boundary checks, and contract schema drift checks).
- The check command ran with a temporary `pnpm` shim that removes inherited `COREPACK_ROOT`; without it, nested package scripts selected the globally installed pnpm 12 instead of repository-pinned pnpm 11.18.0. Turbo emitted its existing warning that `patchedDependencies.@sigstore/core@4.0.1` is a string where its workspace parser expects a mapping; all check tasks still passed.
- Focused Control Plane notification tests: **PASS**, 9/9, including VPC authentication, per-kind token selection, HTTPS fallback on HTTP failure, and HTTPS fallback on connection error.

These checks exercise local code and fixtures only. They do not establish a deployed Cloudflare service binding or production recovery behavior.

