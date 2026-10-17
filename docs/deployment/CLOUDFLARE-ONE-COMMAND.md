# Cloudflare Worker deployment from the canonical inventory

Praetorium's live Cloudflare deploy uses the repository's `infrastructure/workers/*.template.json` and a validated, nonsecret deployment inventory. The script generates temporary, private Wrangler JSON files next to the templates so relative module and migration paths resolve correctly. The generated configs are deleted after each run.

```sh
node scripts/deploy-cloudflare.mjs --inventory /private/deployment.json --secret-files /private/secret-files.json --check
node scripts/deploy-cloudflare.mjs --inventory /private/deployment.json --secret-files /private/secret-files.json --apply
```

The controller uses the workspace-pinned Wrangler from pnpm 11.18.0. It targets only the existing account from `inventory.cloudflare.accountId`, existing D1/KV IDs, the Gateway and Control Plane Worker names and their declared Custom Domains. Secret names and the active public Gateway JWK are checked without reading stored Cloudflare Worker Secret values. The script uploads the exact operator-supplied cross-plane runtime credential files to their matching Worker Secrets and K3s uses those same files, avoiding independently generated but mismatched credentials.

Apply: frozen install → monorepo build → five D1 migrations → Control Plane deploy → Gateway deploy → health and JWKS HTTPS probes. If a step fails, subsequent steps do not run; incomplete prior external effects must be reconciled before retry.

The tracked `apps/{gateway,control-plane}/wrangler.toml` files declare known initial bindings, but **do not** encode a full active inventory, cluster/build release policy or private tokens. The generated deploy configs are the reproducible deployment authority. Keep the Cloudflare Git-connected Workers configured to run the same inventory-based deploy command if builds are to be automatically deployed; a default Wrangler deploy from the repository root does **not** substitute for the validated inventory and may replace correct deployment variables with incomplete ones.

Worker Secrets remain in Cloudflare; values are never committed. The operator must prepare the private secret-files manifest and Cloudflare CLI token once. A Cloudflare API token may be injected from a local protected file through `scripts/deploy-platform.mjs --cloudflare-token-file`. The account token is not the GitHub App private key.

This Cloudflare Worker command does not provision K3s, BuildKit or dynamic product instances. Use the [full reproducible deployment](REPRODUCIBLE-DEPLOYMENT.md) to include Kubernetes.
