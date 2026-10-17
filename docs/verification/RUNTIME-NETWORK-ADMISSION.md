# Tenant network and route admission

The Provisioner ValidatingAdmissionPolicies constrain only its `CREATE` and
`UPDATE` requests for tenant NetworkPolicies and Traefik IngressRoutes. The
writer identity is the checked-in `praetorium-system/praetorium-provisioner`
ServiceAccount. The policies match the request identity rather than a mutable
object label, so an extra label cannot exempt a Provisioner write. Static Flux
resources and unrelated Kubernetes clients do not match this writer condition.

The accepted resource names, namespace name, and ownership labels follow the
current Kubernetes provider and renderer. The resource instance ID must be a
canonical Praetorium ID; the namespace suffix and `arcadia-ins-…` resource
name must be derived from that ID. Namespace and resource repository identity
must agree. The namespace must carry the platform, manager, instance, numeric
repository, ownership-version, and configured cluster labels. Each dynamic
resource must carry the renderer's exact ten labels, including positive runtime
epoch and generation and a valid release ID (or the NetworkPolicy's `none`
value while stopped). These checks are in addition to the provider's existing
fences and ownership checks.

The NetworkPolicy permits ingress only from Traefik in `traefik`, Instance
Access in `praetorium-system`, and Provisioner in `praetorium-system`. Each
peer receives the same single TCP listener port. The existing producer contract
and renderer bound that listener to 1–65535; the policies enforce that same
range without choosing a new port. DNS is limited to the `kube-dns` Pods in
`kube-system`; IP egress is limited to TCP 443 and uses the same explicit
reserved, metadata, and non-public CIDR exclusions as the static system
policies. This includes IPv4-compatible (`::/96`) and mapped
(`::ffff:0:0/96`) destinations, IPv6 site-local (`fec0::/10`), documentation,
unspecified and multicast ranges, IPv4 multicast/reserved (`224.0.0.0/4`,
`240.0.0.0/4`), and `168.63.129.16/32`.

The IngressRoute accepts one `websecure` host derived from the stable
`ins-<instance-id>` hostname and one service with the exact local runtime
service name. Its priority is exactly 10: this is above the static stopped
instance catch-all at priority 1 and below the reserved `/_platform` route at
priority 1000. The service object may contain only its name and listener
port, so a namespace override, middleware, alternate route, or Traefik TLS
secret override is rejected. The static platform fallback still owns
`/_platform` and stopped-instance routing; this policy does not add a second
dynamic route or a cross-namespace Instance Access service.

Both manifests use the deployment renderer's existing `@@CLUSTER_ID@@` and
`@@INSTANCE_HOSTNAME_SUFFIX@@` substitutions. The normal infrastructure
preflight must render these placeholders before applying manifests. These
policies use the Kubernetes CEL extended string functions already available
with the ValidatingAdmissionPolicy v1 API on Kubernetes 1.30 and later.

## Verification

Build the real Kubernetes provider package, then run the focused test:

```sh
corepack pnpm@11.18.0 --filter @praetorium/kubernetes build
node --test tests/infra/runtime-network-admission.test.mjs
```

The test obtains its positive NetworkPolicy and IngressRoute objects from
`createKubernetesResourceRenderer`, then emits positive and negative cases for
the real CEL policy evaluator when `PRAETORIUM_CEL_SCENARIOS` is set to a JSON
output path. The reviewer-side cel-go check compiles both policy expressions
and evaluates those scenarios. It is a local policy check, not an API-server,
Kind, CNI, Traefik, or production admission run.

These ValidatingAdmissionPolicies validate each admission object separately.
They cannot compare the dynamic route's port with another submitted Service,
Deployment, or producer metadata object. The trusted assignment and renderer
remain responsible for binding those values together; admission enforces the
existing listener range and the exact rendered object shapes. These policies
also do not prove runtime writer absence or authorize deletion. Lifecycle
fencing and the Provisioner's narrowly scoped RBAC remain responsible for
those operations. This change makes no live-cluster or producer acceptance
claim and does not assert how a CNI routes traffic to excluded destinations.
