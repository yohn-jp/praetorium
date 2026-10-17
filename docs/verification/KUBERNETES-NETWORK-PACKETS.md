# T07 rendered NetworkPolicy packet component unit

This bounded integration unit exercises packet filtering on an explicitly owned
disposable Kind cluster. It uses the current TypeScript
`createKubernetesResourceRenderer(...).renderStopped()` path and creates only
the resulting tenant `NetworkPolicy`, one owned tenant namespace, the canonical
`traefik` ingress namespace if and only if it is absent, two unique peer
namespaces, and six short probe Pods. If `traefik` already exists, the runner
records its name, UID, and labels and stops without changing it. It does not
create a Scriptorium workload or producer artifact, apply canonical
infrastructure, change CNI configuration, install a CNI, or claim full T14
acceptance.

The test requires an owner-private JSON inventory at
`PRAETORIUM_T07_PACKET_INVENTORY_PATH` and a new report path below the
inventory's owned evidence directory in `PRAETORIUM_T07_PACKET_REPORT_PATH`.
The inventory is accepted only when it is a regular mode-0600 file owned by the
current UID. The owner UID and username must match the current process. The
environment must be explicitly disposable, nonproduction, unexpired, and have
enough remaining lifetime for the bounded test and cleanup. The inventory
pins the exact Kind cluster name/context/ID, single node name/UID and
disposable label, Kubernetes/Kind versions, node image ref/image ID/container
ID, private kubeconfig path, exact CLI paths, and the immutable cached Node
image. Its kubeconfig file must be owner-private. The test never reads or
prints kubeconfig contents.

Inventory schema (values below are illustrative only and are not runnable):

```json
{
  "schemaVersion": 1,
  "inventoryId": "owned-kube-example-20261017",
  "owner": { "uid": 1000, "username": "operator" },
  "environment": {
    "name": "owned-disposable-kind",
    "purpose": "t07-networkpolicy-packets",
    "disposable": true,
    "production": false,
    "expiresAt": "2026-10-18T00:00:00Z"
  },
  "cluster": {
    "provider": "kind",
    "name": "praetorium-owned-kube-example",
    "context": "kind-praetorium-owned-kube-example",
    "id": "clu_01M53XVA9C0V0QKDWDSV50WGPD",
    "apiVersion": "v1.35.0",
    "nodeName": "praetorium-owned-kube-example-control-plane",
    "nodeUid": "00000000-0000-0000-0000-000000000000",
    "nodeContainerId": "0000000000000000000000000000000000000000000000000000000000000000",
    "nodeImageRef": "kindest/node:v1.35.0@sha256:0000000000000000000000000000000000000000000000000000000000000000",
    "nodeImageId": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
  },
  "tools": {
    "kubectlPath": "/absolute/path/to/kubectl",
    "kindPath": "/absolute/path/to/kind",
    "podmanPath": "/absolute/path/to/owned-podman-wrapper",
    "kubeconfigPath": "/absolute/path/to/private/kubeconfig"
  },
  "image": {
    "ref": "docker.io/library/node@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5",
    "digest": "sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5"
  },
  "evidenceDirectory": "/absolute/path/to/owned/evidence",
  "timeouts": {
    "commandMs": 10000,
    "podReadyMs": 120000,
    "probeMs": 1500,
    "convergenceMs": 45000,
    "cleanupMs": 90000,
    "totalMs": 480000
  }
}
```

From the repository root, with the frozen workspace dependencies installed:

```sh
PRAETORIUM_T07_PACKET_INVENTORY_PATH=/absolute/path/to/owner-private-inventory.json \
PRAETORIUM_T07_PACKET_REPORT_PATH=/absolute/path/to/owned/evidence/t07-network-packets-run.json \
node --test tests/integration/kubernetes-network-policy.partial.test.mjs
```

The test rechecks the active context, exact Kind cluster and node, Kubernetes
version, Podman node-container/image identity, node readiness and disposable
label, then verifies the live NetworkPolicy and tenant-Pod admission VAPs have
current zero-warning type-check status and Deny bindings. This component unit
does not claim producer-service-account authorization or NetworkPolicy VAP
match-condition acceptance: it creates the renderer output through the
explicit owner kubeconfig, while separately checking the live VAP's status and
binding. It compiles the
committed TypeScript renderer source in memory rather than importing a stale
`dist` artifact. It passes the canonical `traefik` namespace into the same
renderer option that selects the production ingress peer; the ingress probe
Pod has only the `app.kubernetes.io/name=traefik` selector label.

Each created namespace carries a unique run and inventory label. The tenant
namespace uses the runtime provider's ownership and restricted Pod Security
labels. Every probe Pod uses the pinned Node image with `imagePullPolicy:
Never`, UID/GID 10001, `runAsNonRoot`, `RuntimeDefault` seccomp, dropped `ALL`
capabilities, no privilege escalation, a read-only root filesystem, no
automounted service-account token, and matching CPU, memory and
ephemeral-storage requests and limits. Actual Pod `imageID` must match the
immutable image digest.

Before applying the renderer output, the test requires real successful packet
controls from the allowed peer, wrong-label peer, other namespace, and tenant
source to the private peer. It also checks DNS resolution. It then creates the
exact rendered NetworkPolicy and waits for dataplane convergence while
repeatedly requiring the allowed peer on TCP 8080 to keep working. The final
matrix requires:

- ingress from the configured ingress namespace and `traefik` Pod label to
  TCP 8080 succeeds;
- ingress from a wrong Pod label or a different namespace is denied;
- the same allowed ingress peer to TCP 8081 is denied while the target still
  answers on TCP 8080;
- tenant egress to the private peer Pod IP is denied, after that exact path
  succeeded before policy creation; and
- tenant DNS continues to resolve after policy creation.

The denied probes use direct Pod IPs, disable HTTP keep-alive, and count only
failed new TCP/HTTP connection establishment as a deny. They do not count an
unexpected HTTP response as a deny. Live allowed traffic is checked during
convergence and again before each negative case so a broken network or stopped
target cannot masquerade as policy enforcement. Convergence and all commands
have explicit deadlines.

Namespace cleanup uses the exact namespace UID recorded at creation as a
Kubernetes delete precondition and waits for NotFound. It never force-deletes
pods, nodes, or namespaces. The JSON report is created exclusively with mode
0600 and records the cluster/image identity, rendered policy hash and UID,
Pod UIDs/IPs/imageIDs, positive and negative packet results, and UID-precondition
cleanup results. If cleanup or report creation fails, the test fails.

Metadata-address egress and public HTTPS are deliberately `NOT_CHECKED` by
this component unit. No traffic is sent to `169.254.169.254`; that needs an
explicitly owned metadata canary and a successful positive control. Public
HTTPS needs an owner-controlled URL and response marker. The unit does not
replace full T14 ingress, Scriptorium artifact, runtime, recovery, capacity,
or production CNI validation. A passing result proves only the recorded
NetworkPolicy packet paths on the exact disposable Kind cluster.
