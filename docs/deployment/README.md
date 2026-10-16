# Deployment and disposable infrastructure

T12 adds three separate layers. NixOS host modules configure the private K3s runtime host and the isolated BuildKit host. Flux owns only static controllers and the shared platform overlay. The explicit Kind inventory and scripts provide a disposable local path for planning, preflight, and reviewable application. No file contains an old host address, account ID, device path, secret value, or production context.

## Inventory and gates

`infrastructure/test/disposable-inventory.json` is the local test input. It is validated by `infrastructure/scripts/inventory.mjs` and its strict schema at `infrastructure/schemas/deployment-inventory.schema.json`. It names a Kind cluster and derived context, local-only D1 identifiers, the domain suffix, secret locators, image digests, and an mTLS BuildKit endpoint with worker client CIDRs. Secret values are supplied by the owning environment outside this repository.

The checked-in inventory deliberately leaves image digests, the BuildKit endpoint, worker CIDRs, and the ACME contact unavailable. The validator reports those missing inputs as blockers. Replace them only with resources owned by the disposable environment; `apply` rejects blockers, placeholder strings, remote Cloudflare mode, and any environment other than `disposable-test`. The test inventory is not a production inventory.

Before application, create the referenced service credentials out of band in their listed namespaces. Use `Opaque` Secrets for the credential, service-auth, registry-push, and Build Worker auth locators; use a `kubernetes.io/tls` Secret for BuildKit's client CA/certificate/key; and use a `kubernetes.io/dockerconfigjson` pull Secret with `.dockerconfigjson` in each workload namespace (`praetorium-system`, `praetorium-build`, and `praetorium-observability`). The apply preflight checks only each Secret's type and data-key names; it does not print or persist secret data. Secret provisioning is deliberately not automated here.

The T14 harness consumes the separate `infrastructure/test/acceptance-inventory.json`. It follows the exact seven-category owned inventory schema and currently marks every category missing. Its owner identity is explicitly unresolved. `scripts/preflight-integration.mjs` reads that file without consulting the current Kubernetes context, never executes resource-provided commands, and reports missing resources as `BLOCKED` / `NOT_CHECKED`.

## Disposable Kind flow

Run all commands from the repository root. `plan` and `preflight` do not mutate a cluster. Every command names its inventory explicitly:

```sh
node scripts/deploy-infrastructure.mjs plan --inventory infrastructure/test/disposable-inventory.json
node scripts/deploy-infrastructure.mjs preflight --inventory infrastructure/test/disposable-inventory.json
node scripts/deploy-infrastructure.mjs create --inventory infrastructure/test/disposable-inventory.json --confirm praetorium-t12-local
```

`create` creates only the Kind cluster named by that inventory and labels its control-plane node with the inventory cluster ID and `praetorium.io/disposable=true`. It uses a separate owner-only kubeconfig under `/tmp/praetorium-t12-<uid>/<cluster-name>.yaml`, refuses to overwrite an existing inventory kubeconfig, and never reads or writes the operator's configured kubeconfig or current context. The subsequent `apply` uses that explicit file plus the derived context and rechecks every node's ownership labels before contacting the API server.

After `create`, bootstrap the namespaces required for operator-managed credentials using only that explicit kubeconfig and context:

```sh
kubectl --kubeconfig "/tmp/praetorium-t12-$(id -u)/praetorium-t12-local.yaml" --context kind-praetorium-t12-local create namespace praetorium-system
kubectl --kubeconfig "/tmp/praetorium-t12-$(id -u)/praetorium-t12-local.yaml" --context kind-praetorium-t12-local create namespace praetorium-build
kubectl --kubeconfig "/tmp/praetorium-t12-$(id -u)/praetorium-t12-local.yaml" --context kind-praetorium-t12-local create namespace praetorium-observability
```

Then provision the listed Secrets out of band. The deployment-only Cloudflare DNS token reference belongs in the cert-manager namespace when using the deployment overlay.

Bootstrap Flux against the explicit disposable context and configure its `flux-system` Git source to the reviewed, sanitized repository revision. Flux's controller Kustomization installs pinned Traefik and cert-manager Helm releases. The platform Kustomization is suspended in this template; keep it suspended until the inventory has real inputs and a rendered platform overlay has been reviewed. Then run:

```sh
node scripts/deploy-infrastructure.mjs apply --inventory infrastructure/test/disposable-inventory.json --confirm praetorium-t12-local
```

Application requires `kind`, `kubectl`, standalone Kustomize or `kubectl kustomize`, the cert-manager and Traefik CRDs, ready immutable service images, all BuildKit mTLS inputs, and the namespace-local operator-managed Secrets above. It applies only the rendered `overlays/disposable` static shared resources to the named inventory cluster, checks the four fixed deployments, and rejects unresolved tokens or any `praetorium-instances-*` namespace. It never invokes Flux prune or applies dynamic instance resources. Per-instance namespace, workload, volume, route, and lifecycle ownership remains with the Provisioner/runtime adapter; the Provisioner ServiceAccount intentionally has no RBAC binding until that adapter's exact resource permissions are defined and reviewed.

The deployment script resolves tools from `PATH`, or from explicit executable paths in `PRAETORIUM_KIND_BIN`, `PRAETORIUM_KUBECTL_BIN`, and `PRAETORIUM_KUSTOMIZE_BIN`. When standalone Kustomize is absent, it validates and renders overlays with the configured `kubectl kustomize` capability. The preflight performs only client-version and local-render checks; it does not inspect or contact the current Kubernetes context.

For local ingress verification, use an explicit context and forward the Traefik service without opening a host port:

```sh
kubectl --kubeconfig "/tmp/praetorium-t12-$(id -u)/praetorium-t12-local.yaml" --context kind-praetorium-t12-local -n traefik port-forward service/traefik 8443:443
```

Use an instance hostname beneath `instanceHostnameSuffix` and the self-signed certificate issued by the disposable overlay. The port-forward process is local to the operator; it does not change the cluster's public ingress policy.

When the disposable cluster is no longer needed, remove only the explicitly named Kind cluster after checking the recorded inventory and preserving any evidence required by the campaign:

```sh
kind delete cluster --name praetorium-t12-local --kubeconfig "/tmp/praetorium-t12-$(id -u)/praetorium-t12-local.yaml"
```

Do not substitute an operator's current Kubernetes context or a deployment cluster for this test inventory.

## Local Workers and D1

`infrastructure/workers/*.template.json` define separate Gateway and Control Plane deployments. Gateway owns its authentication D1 binding and uses a service binding to the Control Plane. Control Plane owns the platform D1 binding and its Durable Object namespace. Migration directories are explicit. The deployment plan prints no secret values and makes no Cloudflare API calls.

```sh
node scripts/deploy-workers.mjs plan --inventory infrastructure/test/disposable-inventory.json
node scripts/deploy-workers.mjs preflight --inventory infrastructure/test/disposable-inventory.json
node scripts/deploy-workers.mjs apply-local --inventory infrastructure/test/disposable-inventory.json --confirm praetorium-t12-local
```

`apply-local` applies only Wrangler's local D1 migrations with `--local` and a persistence path under `/tmp/praetorium-t12-workers/<cluster-name>`. It refuses remote Cloudflare mode and requires the confirmation string to match the owned cluster name. It does not deploy a Worker or use account credentials. Remove that directory when the disposable inventory expires. Remote Worker/D1 deployment and secret provisioning remain separate, explicitly authorized operations.

## NixOS roles and BuildKit isolation

`infrastructure/nixos/flake.nix` exports `runtimeHost` and `buildHost` modules. A deployment host must compose one role with its reviewed hardware, boot, network, and operator inventory. No old hardware configuration or device UUID is copied here.

`infrastructure/docker/service-runtime.Dockerfile` keeps compilation and production runtime in separate stages. Its caller must pass immutable `NODE_BUILD_IMAGE` and `NODE_RUNTIME_IMAGE` references plus the workspace `SERVICE_PACKAGE`; the Dockerfile-specific ignore file excludes Git data, dependency trees, environment files, secrets, and generated outputs from the build context. The runtime stage does not include a Docker socket or copy registry credentials into the image.

The runtime role keeps SSH and the Kubernetes API closed except to explicit management CIDRs, disables bundled K3s Traefik, and leaves public ingress stopped by default. If public HTTP ingress is enabled in a reviewed deployment inventory, Traefik permanently redirects its web entrypoint to HTTPS. Its K3s datastore stays under `/var/lib/rancher/k3s`; an optional etcd snapshot directory must be separate.

The BuildKit role belongs on a separate host. It requires worker-only IPv4 source CIDRs, explicit registry/input egress CIDRs through a credential-free proxy, runtime mTLS certificate references, an operator-provisioned XFS mount with a hard project quota, and fixed systemd CPU, memory, and task limits. A root-owned preparation unit applies the XFS project hard limit and gives the dedicated state directory to the service user. RootlessKit creates a slirp4netns namespace, loopback access to the host is disabled, and systemd exposes only the TAP device required by slirp4netns. The daemon runs as the non-root `buildkit` user, and BuildKit parallelism is fixed to one. K3s, Docker, Kubernetes credentials, GitHub tokens, and runtime credentials are forbidden on this host.

Supply the BuildKit mTLS server key/certificate/client CA through the host's secret mechanism and provision the XFS device before enabling the role. The module never formats a device. Host deployment itself is not performed by the T12 scripts.

## Stable stopped-instance routing

The static Traefik IngressRoute always sends matching instance hosts to `instance-access`, including a higher-priority `/_platform` path. That service remains available while an instance is stopped, so its provider can return the durable stopped response without an instance workload or dynamic Flux object. The disposable overlay uses a self-signed wildcard certificate. The deployment overlay uses cert-manager DNS-01 with a Kubernetes secret reference to the Cloudflare token; the token itself is never stored here.

## Verification limits

Nix syntax and schema validation show that templates parse and reject incomplete input; they do not certify a live K3s, Flux, Worker, D1, ingress, registry, or BuildKit deployment. The checked-in inventory intentionally cannot pass deployment preflight until an operator supplies owned disposable test resources and immutable service image digests. Production DNS, Cloudflare, D1, NixOS, and K3s changes remain outside this task.
