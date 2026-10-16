# Instance Access

Instance Access serves only Platform access routes on a stable instance
hostname. It validates the exact HTTPS host, derives the opaque instance ID
from that hostname, and accepts the Gateway's one use handoff only as a
same-origin form POST to `/_platform/handoff`. It sends the code to Gateway
over the service binding and sets host-only `Secure; HttpOnly; SameSite=Lax`
access and refresh cookies. The readable CSRF cookie is host-only, Secure and
SameSite=Lax; refresh is scoped to `/_platform`.

`POST /_platform/refresh` rotates the refresh credential through Gateway;
`POST /_platform/logout` revokes it. Both require the exact instance origin,
the CSRF cookie and matching `X-CSRF-Token` header. Ordinary HTML navigation
without a Platform handoff returns to Gateway's authenticated `/entry/:id`
route. API, MCP and other non-navigation requests get a bounded
`503 INSTANCE_STARTING` response with `Retry-After`. Instance Access never
reads or forwards those application bodies and never retries their writes.

## Cloudflare Worker configuration

Set these environment values and bind `GATEWAY` to the Gateway Worker in
`wrangler.toml`:

| Variable | Requirement |
| --- | --- |
| `INSTANCE_ACCESS_INSTANCE_HOSTNAME_SUFFIX` | Concrete DNS suffix owned by the deployment; example and localhost suffixes are rejected. |
| `INSTANCE_ACCESS_SERVICE_AUTH_TOKEN` | Strong random secret shared with Gateway's internal service-auth configuration. |
| `GATEWAY_ORIGIN` | Exact public HTTPS Gateway origin, with no path or trailing slash. |

The Worker fails closed while configuration or its service binding is
missing. `GET /healthz` and `/readyz` are process probes; they do not claim a
particular user, runtime or repository is ready.

## Node adapter

`src/server.ts` is a local/runtime adapter for `@praetorium/instance-access`.
It accepts the same suffix, service token and Gateway origin, plus
`INSTANCE_ACCESS_PORT` (default `8080`) and `GATEWAY_URL` for a trusted
server-to-server Gateway URL. Plain HTTP `GATEWAY_URL` is allowed only when
`NODE_ENV=test`; normal deployments should use the Worker service binding.
The adapter buffers at most 8 KiB for the handoff form. Other request bodies
are drained without buffering or being sent to Gateway.

Run focused checks and the local Worker with:

```sh
pnpm --filter @praetorium/instance-access check
pnpm --filter @praetorium/instance-access build
pnpm --filter @praetorium/instance-access dev
```

Package tests cover host/origin/form rejection, body non-replay, cookie
attributes, refresh/logout CSRF and configuration failure. They do not certify
deployed DNS, ingress routing or a live Gateway binding.
