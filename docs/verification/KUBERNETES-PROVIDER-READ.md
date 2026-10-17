# Kubernetes provider read-path probe (partial T07 evidence)

This probe invokes the production `createInClusterKubernetesRuntimeProvider`
export from the preserved Provisioner image, using a real projected Service
Account token in the explicitly owned disposable Kind cluster. It covers the
canonical bootstrap authorization needed by these two read paths:

- `listManagedInstances()` performs the real cluster-scoped Deployment list
  with Praetorium's managed labels and cluster ID.
- `inspect()` receives a generated, valid identity whose instance namespace
  was verified absent and returns an authoritative absent observation with a
  complete zero-Pod writer census.

The probe does not use a fake Kubernetes client, impersonation, `kubectl --as`,
static token, producer assignment ABI, or a capacity reservation callback. The
callbacks throw and are counted so an accidental capacity or D1 call fails the
probe. It does not exercise the existing-namespace Pod census path, capacity,
provisioning writes, application startup, a full Provisioner process, Scriptorium,
or end-to-end T07/T14 acceptance.

## Exact image and runtime configuration

The only image input is
`/tmp/praetorium-provider-read-path-artifact-20261017/provisioner-main-431dbe1.oci.tar`.
The runner requires its owner-private mode and SHA-256
`5173465b2d29b5d2123a89a696f65b5fb042e6b969f8f50ca82db08808c251a6`, and checks
the companion export report against the retained original Docker-schema2
manifest `sha256:00739c31e414da9494015e859b8ef1b0f2289ceef631274a1f953ef70c3e2e64`,
config `sha256:d6e3eeaa4253ea3157a9b25ef944e2a6e6c4c6ae14230809576ccb5b4398120d`,
seven verified layers, and `linux/amd64` platform. It imports this archive
without rebuilding, repacking, or using a registry. The Pod's `imageID` must
end in the preserved manifest or config digest.

The provider options are checked against the production Provisioner config
source. Namespace prefix, maximum capacity age, ingress namespace, and
instance-access namespace/service come from the canonical Provisioner
ConfigMap template; the cluster ID and runtime resource ceilings come from the
private owned inventory. Control namespace/service are the validated
production constants. The test uses the immutable image's actual Kubernetes
package export and actual projected credential files. It never emits token,
certificate, key, or kubeconfig contents.

## Ownership and cleanup

The runner is pinned to owner UID 1000, the private owner root
`/tmp/praetorium-owned-kube-fresh-1000-20261017`, cluster
`praetorium-owned-kube-fresh-20261017`, context
`kind-praetorium-owned-kube-fresh-20261017`, and cluster ID
`clu_01M53XVA9C0V0QKDWDSV50WGPD`. It checks the private owner/inventory/create
records, expiry, loopback TLS kubeconfig, one Ready disposable node, Kubernetes
1.35, Kind 0.31.0, and kubectl 1.36.1 before effects. The namespace, canonical
ServiceAccount, bootstrap ClusterRole/Binding, generated test identity
namespace, and unique probe Pod must all return HTTP 404 before the image load
or any Kubernetes create. Existing resources are never adopted.

The canonical Namespace, ServiceAccount, ClusterRole, and ClusterRoleBinding
are created from their exact source YAML documents. The unique probe Pod runs
as UID/GID 10001 with a read-only root filesystem, no privilege escalation,
all Linux capabilities dropped, and `RuntimeDefault` seccomp. Its only
credential is Kubernetes' projected ServiceAccount token; the test confirms
the token and CA files are present without printing their contents. The Pod
does not run the Provisioner service or receive its Control Plane credential.

Cleanup runs in reverse order. The runner re-reads each resource and sends an
HTTP `DeleteOptions` request with that resource's UID precondition, then waits
for a 404. It does not use unsupported kubectl UID-precondition flags. If a
create or delete result is uncertain, the runner reports failure and does not
guess ownership or claim cleanup complete; reconcile the exact resource before
retrying.

## Run procedure

Only run after the current owner of the Kubernetes API confirms its temporary
resources are UID-cleaned and Sol hands off the API writer slot. The environment
confirmation and API-write phrase are deliberate guards; without both, Node
reports the acceptance test as `BLOCKED` and performs no image import or API
write.

From the isolated Praetorium worktree, after that handoff:

```sh
PRAETORIUM_T07_PROVIDER_READ_OWNER_ROOT=/tmp/praetorium-owned-kube-fresh-1000-20261017 \
PRAETORIUM_T07_PROVIDER_READ_CONFIRMATION=praetorium-owned-kube-fresh-20261017 \
PRAETORIUM_T07_PROVIDER_READ_API_WRITE_CONFIRMATION='create canonical provisioner bootstrap and one read-only probe Pod in praetorium-system' \
node --test tests/integration/kubernetes-provider-read.partial.test.mjs
```

The runner invokes the private Podman wrapper to import the exact archive into
the owned cluster. It then creates only the four absent canonical bootstrap
resources and one unique read-only probe Pod. The result is successful only if
the actual image starts, reads the projected token, completes both production
provider reads, reports the absent census, and all UID-guarded cleanup reaches 404.

## Result

**BLOCKED / NOT_CHECKED.** The isolated implementation is prepared at base
`f7fdb88e8653ec30b737901920586d71e9b4cbd4`. The CNI packet runner still owns
the next disposable-cluster write slot; image import, canonical resource
creation, Pod execution, and cleanup have not run. No runtime acceptance is
claimed until the exact-image probe and UID-guarded cleanup complete after the
handoff.
