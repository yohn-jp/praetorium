# Cloudflare one-command deployment

From the repository root on Windows PowerShell or Linux:

```sh
node scripts/deploy-cloudflare.mjs --check
node scripts/deploy-cloudflare.mjs --apply
```

The command validates the existing account's D1/KV IDs, Worker Secret **names**, Gateway signing-key registry and non-secret Wrangler settings. `--apply` builds all workspace packages, applies the five remote D1 migrations, deploys Control Plane then Gateway, and probes the Gateway HTTPS health/JWKS endpoints. It stops at the first failure; it never claims success from a secret-upload deployment record. It does not print or read Worker Secret values.

Prerequisites: Cloudflare CLI credentials with permission to the ZENPRAX account; the existing Worker Secrets and active Gateway public-key registry; the live Cloudflare resource IDs and Gateway custom domain declared in the Wrangler files; a routable HTTPS Gateway. Do not run this against a different Cloudflare account. The script does not rotate secrets or create credentials. Repeated invocations reuse existing resources.

The current script uses Wrangler for Worker builds/deploys because the repository is a Wrangler project. The `cf` CLI is still beta; `cf deploy` ignores `wrangler.toml` until the separate `cf migrate` conversion is completed. Do not run `cf deploy` against an unmigrated repository.

**Not included:** Provisioner/BuildKit/K3s/Proxmox provisioning, Control Plane public TLS routing, producer image admission, full Hosted acceptance, or runtime instance traffic. Those require the owned runtime inventory and separate deployment path. A successful Cloudflare deploy is not a fully deployed Praetorium.
