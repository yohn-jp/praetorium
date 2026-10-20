# Cloudflare Wrangler deployment

The canonical production bindings for the existing ZENPRAX Cloudflare resources are in `apps/gateway/wrangler.toml` and `apps/control-plane/wrangler.toml`. Cloudflare Workers Builds is connected to `yohn-jp/praetorium` main for both existing Workers. Set the root directory to the repository root and use the following commands for **each** Worker:

Build: `corepack enable && corepack pnpm@11.18.0 install --frozen-lockfile && corepack pnpm@11.18.0 build`

Deploy Gateway: `corepack pnpm@11.18.0 exec wrangler deploy --config apps/gateway/wrangler.toml`

Deploy Control Plane: `corepack pnpm@11.18.0 exec wrangler deploy --config apps/control-plane/wrangler.toml`

The Control Plane TOML now pins the provisioned `COORDINATION_SERVICE` VPC binding. Direct/Git-connected deployments must preserve it. This tracked config does not include the full active deployment inventory: production operations should use the [inventory-based deploy](CLOUDFLARE-ONE-COMMAND.md), requiring the same VPC Service ID. Neither path may silently remove the binding.

Apply the five D1 migrations separately with `corepack pnpm@11.18.0 exec wrangler d1 migrations apply praetorium-platform --remote --config apps/control-plane/wrangler.toml` after reviewing the target database and pending migrations. Do not run remote migrations implicitly in both parallel Worker build jobs.

Secrets remain Worker Secrets managed with Wrangler, not Git. Existing secrets must be preserved. The Gateway signing private key must match the active public JWK at KV key `gateway-signing-key-registry`. The Cloudflare Git integration must use the same account and existing Worker names. The Gateway custom domain is `praetorium.yohn.jp`. The declared `control.praetorium.yohn.jp` and `*.instances.praetorium.yohn.jp` are multi-label subdomains: default Universal SSL for `yohn.jp` does not cover them. These origins are NOT TLS-ready or routed by this PR. Before using them, explicitly provision suitable certificate coverage (e.g. Cloudflare Advanced Certificate Manager or a different single-level hostname plan) and routes, and verify HTTPS. Do not treat an origin string as a deployed endpoint. No runtime/BuildKit infrastructure is deployed by this change. Do not claim end-to-end readiness from Worker deployment alone.

The legacy `infrastructure/workers/*.template.json` and disposable inventory remain for isolated testing; they are not the live Git-connected Wrangler configurations. No secret values are committed.
