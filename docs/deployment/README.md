# Deployment and disposable infrastructure

T12 adds three separate layers. NixOS host modules configure the private K3s runtime host and the isolated BuildKit host. Flux owns only static controllers and the shared platform overlay. The explicit Kind inventory and scripts provide a disposable local path for planning, preflight, and reviewable application. No file contains an old host address, account ID, device path, secret value, or production context.

## Inventory and gates

`infrastructure/test/disposable-inventory.json` is the local test input. It is validated by `infrastructure/scripts/inventory.mjs` and its strict schema at `infrastructure/schemas/deployment-inventory.schema.json`. It names a Kind cluster and derived context, local-only Control Plane D1 and Gateway KV identifiers, domain and GitHub App locators, public builder keys and bounded build/runtime policy, secret locators, immutable image digests, and an mTLS BuildKit endpoint with worker client CIDRs. Secret values are supplied by the owning environment outside this repository.

The checked-in inventory deliberately leaves image digests, the HTTPS Control Plane URL, BuildKit endpoint and repositories, worker CIDRs, the HTTPS Gateway origin and Pod-reachable Gateway URL, Gateway owner/App/OAuth identifiers, Build Worker signing ID and Ed25519 public key, build target platform, and ACME contact unavailable. The validator reports those missing inputs as blockers. Replace them only with resources owned by the disposable environment; infrastructure `apply` rejects blockers, placeholder strings, remote Cloudflare mode, and any environment other than `disposable-test`. Worker `preflight` reports the same canonical-input blockers; `apply-local` remains limited to explicit local D1 migrations. The test inventory is not a production inventory.

Before infrastructure application, create the referenced service credentials out of band in their listed namespaces. Use `Opaque` Secrets for the provisioner credential, Instance Access service auth, Build Worker control-plane token, Build Worker Ed25519 private key, BuildKit input/output Docker config (`config.json`), and Build Worker registry-read credential (`credential.json` containing strict `{"username":"…","password":"…"}` JSON). Those two registry files are separate: the Docker config is read by BuildKit and the simple credential file is read by the Node Build Worker. Use a `kubernetes.io/tls` Secret for BuildKit's client CA/certificate/key and a `kubernetes.io/dockerconfigjson` pull Secret with `.dockerconfigjson` in each workload namespace (`praetorium-system`, `praetorium-build`, and `praetorium-observability`). The Provisioner and Build Worker read their control-plane credentials from mounted files. The K8s apply preflight checks only each Secret's type and data-key names; it does not print or persist secret data. The Control Plane's `REGISTRY_PULL_CREDENTIAL` is a separate Cloudflare Worker secret with strict JSON `{"username":"…","password":"…"}` for OCI admission reads; it is not either Kubernetes registry credential. Secret provisioning is deliberately not automated here.

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

Application requires `kind`, `kubectl`, a successful render of the base, controller, deployment and disposable Kustomize targets, the cert-manager and Traefik CRDs, ready immutable service images, all BuildKit mTLS inputs, and the namespace-local operator-managed Secrets above. It applies only the rendered `overlays/disposable` static shared resources to the named inventory cluster, checks the four fixed deployments, and rejects unresolved tokens or any `praetorium-instances-*` namespace. It never invokes Flux prune or applies dynamic instance resources. The static ServiceAccount has no RBAC binding. The Node Provisioner currently stays unready and claims no operation because Scriptorium's S03 assignment ABI and S02 grant-probe transport are unavailable. Runtime namespace/workload/RBAC creation remains gated until those production ports and permissions are implemented and reviewed.

The deployment script resolves tools from `PATH`, or from explicit executable paths in `PRAETORIUM_KIND_BIN`, `PRAETORIUM_KUBECTL_BIN`, and `PRAETORIUM_KUSTOMIZE_BIN`. When standalone Kustomize is absent, it validates and renders the four checked-in targets with `kubectl kustomize`. The preflight performs only client-version and local-render checks; it does not inspect or contact the current Kubernetes context.

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

`infrastructure/workers/*.template.json` declare the current bindings and public variables. Both use the pinned `2026-07-30` Workers compatibility date. Control Plane owns the single `CONTROL_PLANE_DB` binding to `praetorium-platform` and `REPOSITORY_COORDINATOR`, with its three SQL migrations in `apps/control-plane/migrations`. Gateway has no D1 database: `USER_AUTH_STATE` and `EPHEMERAL_CODES` are its auth stores, `GATEWAY_KV` stores bounded indexes/rate limits and the public signing-key registry, and `CONTROL_PLANE` is its service binding to the Control Plane Worker.

The Gateway variables are `GATEWAY_ORIGIN`, its session/handoff/access-grant TTLs, `GATEWAY_INSTANCE_HOSTNAME_SUFFIX`, `GATEWAY_ALLOWED_REPOSITORY_OWNER`, `GITHUB_APP_ID`, `GITHUB_OAUTH_CLIENT_ID`, and `GATEWAY_TOKEN_ENCRYPTION_KEY_ID`. `CONTROL_PLANE_GATEWAY_AUTH` is the same shared secret on Gateway and Control Plane. Gateway also requires `GITHUB_OAUTH_CLIENT_SECRET`, `INSTANCE_ACCESS_SERVICE_AUTH_TOKEN`, the three digest peppers, `GATEWAY_TOKEN_ENCRYPTION_KEY`, and `GATEWAY_SIGNING_KEY`. The last value is JSON containing a private P-256 JWK and key ID. The KV namespace must contain the matching active public key record before Gateway serves requests.

Control Plane's `BUILD_POLICY_JSON` is generated from the explicit inventory when its output repository, target platform and public builder keys are supplied. It must match the strict `apps/control-plane/src/build-composition.ts` policy: HTTPS registry origin, repository allowlist and output repository, image and request limits, target platform, Ed25519 builder public keys, and runtime resource limits. The output repository is the only repository in the generated admission allowlist. `BUILD_WORKER_ID` is derived from the explicit cluster ID. `BUILD_WORKER_AUTH_TOKEN` enables build routes only when the policy is configured, and matches the Build Worker's mounted service token. `REGISTRY_PULL_CREDENTIAL` is an optional, separate registry read credential. Values for `CONTROL_PLANE_ORIGIN`, `GATEWAY_ORIGIN`, `INSTANCE_HOST_SUFFIX`, and `RUNTIME_REGISTRY_HOST` are only inputs for runtime policy; the current T12 inventory leaves its missing origins blocked.

`RUNTIME_CONTROL_SIGNING_KEY` is a strict private P-256 JWK for short-lived runtime-control credentials. It is separate from Gateway's `GATEWAY_SIGNING_KEY` and Build Worker's Ed25519 signing key. Do not set the optional `PROVISIONER_AUTH_TOKEN` route while the actual producer assignment and grant-probe ports are unavailable. Its eventual policy also requires `PROVISIONER_WORKER_ID`, `PROVISIONER_CLUSTER_ID`, the Gateway and Control Plane origins, `INSTANCE_HOST_SUFFIX`, `RUNTIME_REGISTRY_HOST`, and `GIT_CREDENTIAL_BROKER_LOCATOR`. The Worker plan reports names and public policy metadata only; it never reads or prints secret values. Secret provisioning and remote Worker/D1/KV provisioning remain separate operations.

```sh
node scripts/deploy-workers.mjs plan --inventory infrastructure/test/disposable-inventory.json
node scripts/deploy-workers.mjs preflight --inventory infrastructure/test/disposable-inventory.json
node scripts/deploy-workers.mjs apply-local --inventory infrastructure/test/disposable-inventory.json --confirm praetorium-t12-local
```

`apply-local` applies only these Control Plane Wrangler D1 migrations with `--local` and a persistence path under `/tmp/praetorium-t12-workers/<cluster-name>`: `0001_repository_platform.sql`, `0002_stable_release_rollouts.sql`, and `0003_staged_configurations.sql`. It targets the `praetorium-platform` database declared in the Control Plane template. Gateway's Durable Objects and KV are binding declarations only here; this command does not start a Worker emulator, provision or modify Gateway storage, or run a Gateway D1 migration. The script refuses remote Cloudflare mode and requires the confirmation string to match the explicitly owned disposable cluster name. It does not deploy a Worker or use account credentials. Remove that directory when the disposable inventory expires. Remote Worker/D1/KV provisioning and secret provisioning remain separate, authorized operations.

The Node Provisioner receives the actual `PROVISIONER_*` names, including the HTTPS Control Plane URL, cluster/worker identity, runtime service locations, maximum CPU/memory/ephemeral-storage values and capacity age. `PROVISIONER_CREDENTIAL_PATH` is `/var/run/secrets/control-plane/credential`, matching the read-only Secret mount. The runtime limits come from `buildPolicy.runtimeResourceLimits`, so the Control Plane's build policy and Provisioner use the same caps. The Provisioner startup wires the actual operation client but currently supplies unavailable S03 runtime-assignment and S02 grant-probe transports; `/readyz` stays 503 and no operation is claimed.

T07 owns each dynamic tenant NetworkPolicy. Its generated tenant Pod has `arcadia.io/platform=arcadia-platform` and `app.kubernetes.io/name=scriptorium`. The policy admits only the configured Traefik namespace with `app.kubernetes.io/name=traefik`, the configured Instance Access namespace and service label, and `praetorium-system` with `app.kubernetes.io/name=provisioner`; each ingress rule is limited to the producer-declared application HTTP port. T07 also owns the tenant egress rules. The static T12 overlay does not add a separate broad egress policy or change production defaults.

The Node Build Worker receives the application's `PRAETORIUM_*` variables and reads its service token, private Ed25519 signing key, BuildKit mTLS files, BuildKit Docker config and separate simple registry-read credential from mounted Secrets. Its registry origin and image/request limits come from the same inventory policy as Control Plane, with limits validated against both workers' accepted ranges. The inventory supplies the matching public signer key to `BUILD_POLICY_JSON`; its `keyId` must match `buildWorker.signingKeyId`. The Control Plane's registry pull secret, BuildKit input/output Docker auth, Build Worker's registry-read credential, application image-pull credential, Gateway secrets and runtime-control private key are separate credential surfaces. The worker uses the inventory's HTTPS Control Plane origin, GHCR origin, composition/frontend/output repository locators and absolute `buildctl` path. The Node Instance Access adapter receives `GATEWAY_URL`, `GATEWAY_ORIGIN`, `INSTANCE_ACCESS_INSTANCE_HOSTNAME_SUFFIX`, and `INSTANCE_ACCESS_SERVICE_AUTH_TOKEN`. `gatewayServiceUrl` must be reachable from its Pod; the checked-in disposable inventory leaves it missing. Only the disposable overlay sets `NODE_ENV=test` for the local HTTP Gateway URL allowed by that adapter.

## NixOS roles and BuildKit isolation

`infrastructure/nixos/flake.nix` exports `runtimeHost` and `buildHost` modules. A deployment host must compose one role with its reviewed hardware, boot, network, and operator inventory. No old hardware configuration or device UUID is copied here.

`infrastructure/docker/service-runtime.Dockerfile` keeps compilation and production runtime in separate stages. Its caller must pass immutable `NODE_BUILD_IMAGE` and `NODE_RUNTIME_IMAGE` references plus the workspace `SERVICE_PACKAGE`; the Dockerfile-specific ignore file excludes Git data, dependency trees, environment files, secrets, and generated outputs from the build context. The runtime stage does not include a Docker socket or copy registry credentials into the image.

The runtime role keeps SSH and the Kubernetes API closed except to explicit management CIDRs, disables bundled K3s Traefik, and leaves public ingress stopped by default. If public HTTP ingress is enabled in a reviewed deployment inventory, Traefik permanently redirects its web entrypoint to HTTPS. Its K3s datastore stays under `/var/lib/rancher/k3s`; an optional etcd snapshot directory must be separate.

The BuildKit role belongs on a separate host. It requires worker-only IPv4 source CIDRs, explicit registry/input egress CIDRs through a credential-free proxy, runtime mTLS certificate references, an operator-provisioned XFS mount with a hard project quota, and fixed systemd CPU, memory, and task limits. A root-owned preparation unit applies the XFS project hard limit and gives the dedicated state directory to the service user. RootlessKit creates a slirp4netns namespace, loopback access to the host is disabled, and systemd exposes only the TAP device required by slirp4netns. The daemon runs as the non-root `buildkit` user, and BuildKit parallelism is fixed to one. K3s, Docker, Kubernetes credentials, GitHub tokens, and runtime credentials are forbidden on this host.

Supply the BuildKit mTLS server key/certificate/client CA through the host's secret mechanism and provision the XFS device before enabling the role. The module never formats a device. Host deployment itself is not performed by the T12 scripts.

## Stable stopped-instance routing

The static Traefik IngressRoute always sends matching instance hosts to `instance-access`, including a higher-priority `/_platform` path. That service remains available while an instance is stopped, so its provider can return the durable stopped response without an instance workload or dynamic Flux object. The disposable overlay uses a self-signed wildcard certificate. The deployment overlay uses cert-manager DNS-01 with a Kubernetes secret reference to the Cloudflare token; the token itself is never stored here.

## Verification limits

Nix syntax and schema validation show that templates parse and reject incomplete input; they do not certify a live K3s, Flux, Worker, D1, ingress, registry, or BuildKit deployment. The checked-in inventory intentionally cannot pass infrastructure application or Worker preflight until an operator supplies owned disposable test resources, real Gateway/Control Plane locators, a public builder key and target platform, and immutable service image digests. Production DNS, Cloudflare, D1, NixOS, and K3s changes remain outside this task.
