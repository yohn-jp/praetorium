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
disposable label, Kubernetes API version, node image ref/image ID/container
ID, private kubeconfig path, exact CLI paths, and the immutable cached Node
image. The runner separately verifies the pinned Kind version. It also pins a
private, hash-verified report from a previous successful
Pod on this same Kind cluster, including the exact kubelet-observed `imageID`
for the Node digest and confirmation that kubelet pulled it. The test compares
new Pods against that observed runtime ID instead of assuming a CRI imageID is
the manifest digest. Its kubeconfig and image-evidence files must be
owner-private. The test never reads or prints kubeconfig contents.

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
    "digest": "sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5",
    "runtimeImageEvidencePath": "/absolute/path/to/owned/evidence/prior-kubelet-image-report.json",
    "runtimeImageEvidenceSha256": "0000000000000000000000000000000000000000000000000000000000000000"
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

The report hashes every local source input reported by esbuild for the renderer
bundle, the source NetworkPolicy admission manifest, and the live NetworkPolicy
admission expressions. It rejects dirty or untracked files in that bundle
input closure, the admission manifest, and the runner before using the output.
A live VAP's current
`observedGeneration` describes the object currently stored by the API server;
it does not prove that the object matches the current source manifest. The
runner records the source/live mapped-IPv4 exclusion values and their drift
without updating the canonical VAP. It also records that its owner-context
NetworkPolicy create does not prove producer ServiceAccount authorization or
the VAP's producer-only match condition.

Each created namespace carries a unique run and inventory label. The tenant
namespace uses the runtime provider's ownership and restricted Pod Security
labels. Every probe Pod uses the pinned Node image with `imagePullPolicy:
Never`, UID/GID 10001, `runAsNonRoot`, `RuntimeDefault` seccomp, dropped `ALL`
capabilities, no privilege escalation, a read-only root filesystem, no
automounted service-account token, and matching CPU, memory and
ephemeral-storage requests and limits. Each Pod's actual `imageID` must exactly
match the value read from the hash-verified prior kubelet evidence.

Before applying the renderer output, the test requires real successful packet
controls from the allowed peer to both tenant listeners, the wrong-label peer,
the other namespace, the tenant source to the private peer, and the allowed
peer to that same private target. It also checks DNS resolution. It then creates
the exact rendered NetworkPolicy and waits for dataplane convergence while
repeatedly requiring the allowed peer on TCP 8080 to keep working. The final
matrix requires:

- ingress from the configured ingress namespace and `traefik` Pod label to
  TCP 8080 succeeds;
- ingress from a wrong Pod label or a different namespace is denied;
- the same allowed ingress peer to TCP 8081 is denied while the target still
  answers on TCP 8080 and its local TCP 8081 listener remains live;
- tenant egress to the private peer Pod IP is denied while that same target
  remains reachable from an unprotected peer; and
- tenant DNS continues to resolve after policy creation.

The denied probes use direct Pod IPs, disable HTTP keep-alive, and count only
failed new TCP/HTTP connection establishment as a deny. They do not count an
unexpected HTTP response as a deny. Live allowed traffic is checked during
convergence and again before each negative case so a broken network or stopped
target cannot masquerade as policy enforcement. Convergence and all commands
have explicit deadlines. A denial counts only for `ECONNREFUSED`, `ECONNRESET`,
or the bounded `ETIMEDOUT` from a new direct-IP connection. DNS, malformed
responses, unrelated transport errors, and unexpected HTTP responses fail the
test.

If a namespace-create request has an ambiguous result, the runner follows up
with API reads and records any matching run-owned namespace UID for cleanup.
`NotFound` or a namespace without matching run ownership does not clear
uncertainty after an ambiguous write; cleanup remains incomplete and the test
fails without issuing an unconditioned delete.

Namespace cleanup sends HTTP DELETE over a Unix-domain `kubectl proxy` socket
inside a newly created mode-0700 owner-private directory. The proxy starts only
for cleanup, accepts only the exact recorded owned-namespace paths, and rejects
the standard non-DELETE HTTP methods; the socket is mode 0600. Each request has
`DeleteOptions.preconditions.uid` set to the exact namespace UID recorded at
creation, then waits for NotFound. It never uses a get-then-unconditional
delete, force-deletes pods, or deletes nodes. The JSON report is created
exclusively with mode 0600 and records the cluster/image identity, source and
live policy hashes/drift, rendered policy hash and UID,
Pod UIDs/IPs/imageIDs, positive and negative packet results, and UID-precondition
cleanup results. If cleanup or report creation fails, the test fails.

Metadata-address egress and public HTTPS are deliberately `NOT_CHECKED` by
this component unit. No traffic is sent to `169.254.169.254`; that needs an
explicitly owned metadata canary and a successful positive control. Public
HTTPS needs an owner-controlled URL and response marker. The unit does not
replace full T14 ingress, Scriptorium artifact, runtime, recovery, capacity,
or production CNI validation. A passing result proves only the recorded
NetworkPolicy packet paths on the exact disposable Kind cluster.
