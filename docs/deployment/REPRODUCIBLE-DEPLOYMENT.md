# Reproducible Praetorium deployment

> **Current 2-VM runbook (not the target 3-VM procedure).** The 2026-10-20 accepted Management VM + rootless Podman Quadlet + Runtime k3s Agent + Builder VM topology is documented in [MANAGEMENT-PLANE.md](../architecture/MANAGEMENT-PLANE.md); migration gates are [MANAGEMENT-PLANE-MIGRATION.md](../architecture/MANAGEMENT-PLANE-MIGRATION.md). Existing bootstrap scripts still deploy the old topology. Do not apply this runbook as if it implemented the new topology.
>
> **Runbook for operator-authorized deployment.** System ownership and the split between D1, DO, K3s, Build Worker and BuildKit are mapped in [SYSTEM.md](../architecture/SYSTEM.md). Passing a host preflight or this static deploy does not certify end-to-end Hosted login/edit/save/recovery. Historical architectural assumptions in this runbook are under review in [REVIEW.md](../architecture/REVIEW.md).

This is the operator runbook for **NixOS or dedicated Ubuntu 24.04 / 26.04 guest roles**, the Cloudflare Workers and the K3s application plane. It does not use SOPS, require Proxmox host modifications, install a new GitHub App, or deploy from locally edited source files. Every deploy is tied to a checked-out Git commit, a complete owner-supplied nonsecret inventory and private file-backed credentials. Use [SECRETS.md](SECRETS.md) for canonical private file names, source authority, provider-managed Worker values, cross-plane synchronization, and recovery/rotation handling.

## 0. Bootstrap sequence (one-time)

On Proxmox create two independent Linux VMs:

| Guest | Function | Suggested initial allocation |
| --- | --- | --- |
| runtime | Ubuntu or NixOS, K3s, Flux, cert-manager, Traefik, Praetorium deployments | 2–4 vCPU, 4–8 GiB RAM, persistent OS disk |
| build | Ubuntu or NixOS, rootless mTLS BuildKit | 2–4 vCPU, 4–8 GiB RAM; Ubuntu uses its ext4 OS disk with GC and free-space monitoring; NixOS retains its separate XFS cache device |

The numbers are starting estimates, not tested sizing limits. A single-VM BuildKit+runtime arrangement is deliberately disallowed by the current BuildKit role; do not bypass its no-K3s assertion. Proxmox itself remains untouched. Follow [NixOS initial install](NIXOS-INSTALL.md) on each VM, or the isolated [Ubuntu 24.04 / 26.04 bootstrap](UBUNTU-2404.md) on fresh Ubuntu guests. Ubuntu uses its own root-owned JSON inputs and does not use `bootstrap-linux.sh` or NixOS modules.

Clone the repository on each guest at **the same reviewed immutable commit** (replace `COMMIT` with the actual merged/released commit):

```sh
git clone https://github.com/yohn-jp/praetorium.git /opt/praetorium
cd /opt/praetorium
git checkout --detach COMMIT
```

**Only for NixOS guests:** Prepare an operator-specific role module **outside Git**. Copy the relevant sample from `infrastructure/nixos/examples/` to `/root/praetorium-runtime.nix` or `/root/praetorium-build.nix`, fill required source CIDRs, admin public key, cluster ID and role-specific resources. The Runtime `clusterId` must exactly match `inventory.clusterId`. Supply the BuildKit XFS device and certificate paths; the script does not format devices or mint private trust roots. Never put private key contents in Nix source.

```sh
sudo bash scripts/bootstrap-linux.sh runtime /root/praetorium-runtime.nix --check
sudo bash scripts/bootstrap-linux.sh runtime /root/praetorium-runtime.nix --apply
# On the separate build guest:
sudo bash scripts/bootstrap-linux.sh build /root/praetorium-build.nix --check
sudo bash scripts/bootstrap-linux.sh build /root/praetorium-build.nix --apply
```

`--check` generates/pins the host flake under `/etc/nixos` (if not already bootstrap-managed) and builds it but does not switch the operating system. `--apply` explicitly switches to the built role. Existing unrelated `/etc/nixos/flake.nix` is not overwritten. The source flake follows the repository's pinned `infrastructure/nixos/flake.lock`. Preserve `/etc/nixos` (including its generated `flake.lock`) and the source checkout revision for reproducibility.

**For Ubuntu guests, use the corresponding Python commands in [UBUNTU-2404.md](UBUNTU-2404.md) instead of the NixOS commands above.**

The runtime node has the `praetorium.io/cluster-id` label from the selected host role's `clusterId` setting; K3s deploy will refuse an unlabeled/different cluster. The NixOS role installs the required kubectl/Kustomize/Flux and Node 24 tools. Ubuntu operators supply pinned tools on the deployment workstation as described in the Ubuntu runbook. Start/restart the VM and check `systemctl status k3s`, `kubectl get nodes`, and on the build host `systemctl status praetorium-buildkit`. These services must be operational before the deployment command can succeed.

## 1. Deployment input files

Create an owner-only inventory at `/root/praetorium/deployment.json`, starting from `infrastructure/deployment/inventory.example.json`. This nonsecret file records:

- `environment=deployment`, `ownership.provider=k3s`, `ownership.disposable=false`, exact cluster name and kubeconfig context, and numeric/opaque cluster identity;
- the real Cloudflare account, D1 and KV IDs and the exact Gateway/Control Plane HTTPS origins;
- the approved BuildKit endpoint, image/registry repositories, allowed network CIDRs, resource/cache bounds and producer/builder public signing keys;
- actual **registry@sha256** identities for Provisioner, Build Worker, Instance Access and Prometheus;
- immutable release approval/canary policy and the cluster-side Secret **names and keys**; no secret bytes.

The example is intentionally **not deployable**: null fields and missing cryptographic identities require resolution. Never replace unknown inputs with a fabricated manifest, a static owner token or a mutable `:latest` image.

Create `/root/praetorium/secret-files.json` from `infrastructure/deployment/secret-files.example.json`, specifying absolute paths to private files for each Kubernetes Secret. Grant each file and this manifest mode 0600, owned by the invoking deployment user, with parent directories mode 0700. No SOPS, YAML secret values or secrets in Git. The BuildKit TLS files and repository credentials must come from the selected trusted provider. If `releaseOperatorToken` is set, its value is also uploaded as the Control Plane's distinct `RELEASE_OPERATOR_TOKEN`.

The one-command deploy copies these file contents to the exact namespace Secrets expected by the Kustomize manifests and sends the same operator-supplied `INSTANCE_ACCESS_SERVICE_AUTH_TOKEN`, `PROVISIONER_AUTH_TOKEN`, `BUILD_WORKER_AUTH_TOKEN` and registry read credential to the appropriate Cloudflare Workers. It **never silently rotates an existing Kubernetes Secret**; if existing contents differ, reconcile/rotate explicitly first. Gateway/App secrets already registered in Workers remain intact. The Gateway private signer must match the active public JWK in KV key `gateway-signing-key-registry`.

Obtain the explicit administration kubeconfig from the K3s guest, copy it to a private mode-0600 path, and set its API `server` to the reachable management address. Set its `current-context` to the inventory's exact value. Never point it at another user/production cluster by accident. The script requires the server to report K3s and **every Node** to have the expected cluster identity label.

For noninteractive Cloudflare CLI access, use an already authorized Wrangler login on the operator machine **or** supply a private mode-0600 Cloudflare API token file with `--cloudflare-token-file`. This is an operator credential, not a GitHub App private key. The token should be scoped to exactly the selected account/zone, D1, KV and two Workers. The script uses the pinned workspace Wrangler, not `npx latest`.

## 2. One-command Cloudflare + Kubernetes delivery

Run from a clean checkout of the exact released commit **on the operator workstation** that has Node 24, `kubectl`, the pinned Flux CLI and reachability to the K3s management API. The actual VM role bootstrap above is one-time. Both Cloudflare and cluster preflights run **before any remote mutation**:

```sh
node scripts/deploy-platform.mjs \
  --inventory /root/praetorium/deployment.json \
  --secret-files /root/praetorium/secret-files.json \
  --kubeconfig /root/praetorium/kubeconfig \
  --confirm praetorium-runtime --check

node scripts/deploy-platform.mjs \
  --inventory /root/praetorium/deployment.json \
  --secret-files /root/praetorium/secret-files.json \
  --kubeconfig /root/praetorium/kubeconfig \
  --confirm praetorium-runtime --apply
```

Optionally append `--cloudflare-token-file /root/praetorium/cloudflare-token` to both calls.

The controller performs these actions in order, stopping on first failure:

1. Validate complete inventory, all private credential file permissions, real K3s identity/context, Kustomize production bundle, canonical Owner labels, available tools and Cloudflare Secret names/public JWK.
2. Install/build the pinned workspace packages.
3. Upload **only** the explicitly operator-supplied cross-plane runtime secrets; apply the five remote Control Plane D1 migrations.
4. Deploy Control Plane and Gateway from generated Wrangler JSON based on the canonical `infrastructure/workers/*.template.json`; verify HTTPS health and published Gateway JWKS against the KV key. Temporary configs contain no secret values and are deleted.
5. Ensure the fixed Praetorium system namespaces and install Flux controllers from the pinned Flux CLI. Apply the pinned Traefik and cert-manager HelmRelease/HelmRepository declarations and wait for both to become Ready. Verify their actual API CRDs.
6. Create missing operator-owned namespace Secrets from the named private files, refusing mismatched existing Secrets.
7. Render the **deployment** Kustomize overlay from the same validated inventory. Run Kubernetes server dry-run, apply Admission guards first, wait for enforcement, then apply static policies and application resources using `applyGuardedBundle`.
8. Wait for Provisioner, Instance Access, Build Worker and Prometheus Deployments to become Ready and for cert-manager's instance Certificate to report Ready.

A complete execution reports explicit success at the *Cloudflare + static K3s deployment* layer. It is **not** the same as verified Hosted login/editor/MCP/renewal/replacement or the application's dynamic per-repository runtime rollout. Run `node scripts/verify-integration.mjs --environment ...` with the real owner inventory to establish those gates separately. Never mark the full product complete because a readiness probe passed.

### External connectivity is an explicit deployment prerequisite

**2026-10-20 application-origin decision:** DNS has a static DNS-only
`*.scriptorium.yohn.jp CNAME gateway.yohn.jp` wildcard. Per-repository
CNAME writes are no longer part of Provisioner. cert-manager's
`praetorium-system/praetorium-instance-origin` Certificate includes
`*.scriptorium.yohn.jp` and the existing `*.instances...` SAN. The
single Traefik `TLSStore/default` in `praetorium-system` selects its
`@@TLS_SECRET_NAME@@` for dynamic tenant `tls: {}` routes across namespaces;
the Helm provider restricts default TLS resources to that namespace.
Do not supply the old `praetorium-application-dns` Provisioner Secret.

The owner will configure the **public Caddy separately**. It must route TLS
at layer 4 without terminating it, preserving the original browser SNI and
HTTP Host until Traefik terminates TLS. The old Caddy HTTP `tls dns ...` /
`reverse_proxy https://...` config is obsolete. Ordinary Caddy HTTP reverse
proxy cannot fulfill the requirement, and Caddy TLS passthrough generally
requires a layer4-capable build or another TCP proxy. Before claiming hosted
acceptance, check: DNS-only wildcard resolution, `ClusterIssuer Ready`,
`Certificate Ready`/SANs/Secret keypair in k3s, Traefik's one default TLSStore,
browser `openssl s_client`/TLS chain via public SNI, exact Host routing to
Scriptorium, and stopped fallback. Never disable TLS verification to compensate
for a missing SNI route.


This project does not provision a VPS/tunnel endpoint or Proxmox bridge. The instance hostname suffix in the sample is `instances.praetorium.yohn.jp`; its multi-label wildcard needs the matching TLS certificate in K3s **and** a reachable external edge. A Cloudflare Tunnel cannot use the K3s certificate to satisfy browser-facing Cloudflare Edge TLS. Select and configure the approved public tunnel/VPS termination mode before claiming end-to-end HTTPS and ChatGPT MCP ingress. The deployment script fails if the cert-manager Certificate cannot become Ready; it does not invent a route.

Similarly, a Cloudflare Worker Custom Domain can provision its individual HTTPS certificate, but the Control Plane and Gateway origins must be independently routable before Gateway login succeeds. The Worker Custom Domains are registered by the inventory-derived Wrangler configuration; no dashboard step is part of the automated deployment.

## 3. Updates, recovery and ownership

Upgrade by reviewing a new Git commit and image digest set, regenerating the approved private inventory, and rerunning the same `--check` then `--apply` commands. Do not retag immutable releases. Runtime instance names, user work, PVCs and old backups are **not** reconciled/deleted by the static Kustomize application. An operation that fails after an external effect leaves explicit partial state; rerun after reconciling it, rather than force-deleting a workload or retrying blind pushes.

Provisioner admission depends on the live producer contract and signed composition artifact, not solely on a Ready Pod. Keep old writer termination, unpublished drafts/commits and credential revocation as separate safety conditions. The fixed T14 acceptance suite (including real GitHub App, two composition profiles, direct-origin wake, writer fencing, Stable/Pinned rollback and off-host restore) is still required for full certification.

### Files to preserve

- Public: immutable repository revision, NixOS flake.lock when applicable, nonsecret deployment inventory, versioned container image digests, Kustomize/controller manifests and executable scripts.
- Private: OS-specific host configuration (NixOS /etc/nixos or Ubuntu /etc/praetorium), private deployment inventory when it carries operator endpoints, permission-protected Secret files and manifest, Cloudflare/BuildKit/registry credentials, recovery keys, kubeconfig.
- Remote: Cloudflare D1/KV/DO and Workers Secrets; GHCR/OCI artifacts; selected K3s cluster state.

No Proxmox host SSH, Proxmox API, container-volume deletion, disk formatting, secrets in Nix store or public release publication is performed by these scripts.
