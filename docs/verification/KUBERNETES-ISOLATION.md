# T14 Kubernetes isolation runner

Status: **BLOCKED / NOT_CHECKED**. The checked-in acceptance inventory currently declares `kubernetes-isolation` missing and has no private cluster reference. The aggregate command `node scripts/verify-integration.mjs --environment infrastructure/test/acceptance-inventory.json` returned exit 2 with `status=BLOCKED` and `effectsExecuted=false`: `owner.identity` is still the provisioning placeholder and the category is declared missing. The verifier therefore did not start any category runner. A direct provider-case invocation with the verifier's environment variables also stopped during inventory validation, before loading private credentials or creating Kubernetes transports, because the owner, category resource and private reference are unavailable. Neither command attempted a Kubernetes connection. The runner has not been run against a Kubernetes cluster. No workload or namespace was created for this implementation task.

The fixed category command is `node scripts/verify-integration.mjs --environment <explicit-owned-acceptance-inventory>`. The verifier runs `tests/integration/kubernetes-isolation.test.mjs` only when the inventory marks this category available. A direct run also requires the verifier-provided `PRAETORIUM_T14_INVENTORY_PATH` and `PRAETORIUM_T14_CATEGORY=kubernetes-isolation`; absent, expired, unowned, production, incomplete, or unsafe inputs fail before Kubernetes writes.

## Private category input

The acceptance inventory's `resources.kubernetes-isolation.reference` must be an absolute path to an operator-owned JSON file. Keep that file mode `0600` or stricter. It must be a regular non-symlink file owned by the current operator. Its exact schema is:

```json
{
  "schemaVersion": 1,
  "inventory": {
    "inventoryId": "<same inventoryId as the acceptance inventory>",
    "ownerIdentity": "<same owner.identity as the acceptance inventory>",
    "environmentName": "<same environment.name as the acceptance inventory>",
    "expiresAt": "<same explicit timezone-bearing expiry as the acceptance inventory>"
  },
  "cluster": {
    "id": "<clu_ plus 26 Crockford Base32 characters>",
    "provider": "kind",
    "name": "praetorium-t14-<owned disposable cluster slug>",
    "context": "kind-<exact cluster name>",
    "confirmation": "<exact cluster name repeated by the operator>",
    "apiHost": "127.0.0.1",
    "apiPort": "<explicit local API port>",
    "namespacePrefix": "praetorium-instances",
    "ingressNamespace": "traefik",
    "instanceAccessNamespace": "praetorium-system",
    "maximumResources": {
      "cpuMilli": "<operator-supplied test ceiling>",
      "memoryMiB": "<operator-supplied test ceiling>",
      "ephemeralStorageMiB": "<operator-supplied test ceiling>"
    },
    "resourceProfile": {
      "id": "<test-only profile ID>",
      "cpuMilli": "<operator-supplied test request>",
      "memoryMiB": "<operator-supplied test request>",
      "ephemeralStorageMiB": "<operator-supplied test request>"
    }
  },
  "credentials": {
    "directory": "<private operator-owned credential directory>",
    "controllerTokenPath": "<disposable test-controller token path below that directory>",
    "providerTokenPath": "<Provisioner ServiceAccount token path below that directory>",
    "caPath": "<explicit Kubernetes API CA path below that directory>"
  },
  "probe": {
    "repositoryId": "<numeric disposable test-repository identity>",
    "imageRef": "<registry/repository>@sha256:<immutable index digest>",
    "imageDigest": "sha256:<same immutable index digest>",
    "platformManifestDigest": "sha256:<immutable selected child digest>",
    "httpPort": "<probe server listener port>"
  },
  "network": {
    "hostnameSuffix": "<owned wildcard test DNS suffix>",
    "ingressAddress": "<explicit ingress IP address>",
    "ingressPort": "<explicit ingress TCP port>",
    "ingressCaPath": "<explicit ingress CA path below credentials.directory>",
    "publicEgressUrl": "https://<owned public marker endpoint>/...",
    "publicEgressMarker": "<exact single-line response body>"
  },
  "timeouts": {
    "requestMs": "<1000..20000>",
    "readinessMs": "<10000..600000>",
    "networkProbeMs": "<2000..30000>",
    "totalMs": "<60000..1200000, less than time remaining on the inventory>"
  }
}
```

The angle-bracketed strings above are schema documentation, not runnable values. Do not copy guessed limits, image identities, URLs, cluster names, or credentials into the private input. The runtime namespace prefix is fixed to `praetorium-instances` and ingress namespace to `traefik`, because the deployed tenant admission policies and provider must agree on those values; random instance IDs make concrete test namespaces unique. The private hostname suffix must match the deployed Instance Access ConfigMap and admission-approved route. The runtime API host must be an explicit loopback IP. Both distinct bearer-token files and both CA files must resolve below the private credential directory; token permissions must be private to the current operator. `controllerTokenPath` is the operator's test-controller credential for read-only target checks and run-owned probe Pod creation, observation and conditional cleanup in the explicitly disposable cluster, including the actual `praetorium-system`, `praetorium-observability`, ingress, and tenant namespaces. Scope it to the smallest permissions needed for those reads and Pod operations. `providerTokenPath` must authenticate as `system:serviceaccount:praetorium-system:praetorium-provisioner`; the runner checks that using Kubernetes SelfSubjectReview before any workload mutation. It also verifies with SelfSubjectAccessReview that this product identity cannot directly create Pods or delete namespaces. All production provider reads and writes use this exact ServiceAccount credential. The probe fixture credential does not authorize provider mutations. The ingress and public egress addresses are explicit test inputs, not inferred from the ambient shell, kube context, or DNS search configuration.

The runner creates two Kubernetes transports using only the private file's host, port, token and CA. It does not read `KUBECONFIG`, kubeconfig contexts, ambient Kubernetes service variables, or credentials from the operator's home. The cluster identity must be a disposable Kind environment whose name and context are confirmed in the private file and whose acceptance inventory is explicitly disposable and nonproduction. Before mutation, the runner verifies the target `praetorium-system` and `praetorium-observability` namespaces' platform labels and restricted Pod Security Admission settings; compares the live Provisioner ConfigMap's cluster ID, namespace prefix, peers, ingress and resource ceilings plus the Instance Access ConfigMap hostname suffix with the private input; and checks the actual Instance Access, Provisioner and Prometheus Service/Deployment/ServiceAccount selectors. It does not create, relabel or delete any shared namespace.

## Probe image contract

The operator supplies a test-owned image by immutable OCI index and selected platform-manifest digests. The image must be pullable by the disposable cluster and support `/bin/sh`, `curl` (including `--disable`), `grep`, `getent`, and `sleep` as non-root UID/GID 65532. Its default runtime entry point must serve the configured `httpPort` and return these exact responses:

| Request                                                                | Required response                        |
| ---------------------------------------------------------------------- | ---------------------------------------- |
| `GET /healthz`                                                         | HTTP 200                                 |
| `GET /readyz`                                                          | HTTP 200, body `t14-probe-ready-v1`      |
| `GET /__t14/auth` with `Authorization: Bearer t14-owned-probe-auth-v1` | HTTP 200, body `t14-probe-auth-ok-v1`    |
| `GET /__t14/ingress`                                                   | HTTP 200, body `t14-probe-ingress-ok-v1` |

The auth value and routes are test-only. They do not model or certify Scriptorium authentication, grants, assignment delivery, or the S02 producer contract. The server must not require a mounted token or a configuration secret. The same immutable image is used for short-lived shell probe Pods; those Pods receive fixed scripts from the committed test and validated URL/marker values as environment entries. The private config cannot supply commands or Pod specifications.

The provider's runtime Deployment must report the selected platform digest through the actual Pod container `imageID`; an environment value or configured image string does not count. The runner separately checks the shell probe Pod's actual `imageID` before accepting any probe result. If this cluster's runtime reports an image ID the provider cannot resolve to the selected child digest, acceptance fails.

## What the runner exercises

The runner checks input ownership, explicit API TLS/authentication, a complete live Node/Pod capacity snapshot, the configured ingress namespace and Ready Traefik source label, random runtime namespace absence, ingress TLS reachability, and the public marker endpoint before its first Kubernetes write. It then uses the production `KubernetesRuntimeProvider`, `KubernetesApiClient`, `InClusterKubernetesTransport`, and resource renderer.

The test creates two random instance identities against a test-controller reservation source. That in-memory source represents only the reservation-controller port required by the provider test; it records fresh provider-observed Node and Pod resource versions and actual represented reservations. It is not Control Plane, D1, OperationService, or producer acceptance evidence. The provider must still use its live, complete cluster capacity observation and exact target reservation to admit each workload. The test checks two writers fit, that the live capacity snapshot includes both, and that an actual unscheduled probe Pod makes capacity unavailable until the exact Pod is removed. The Kubernetes provider itself runs as the exact Provisioner ServiceAccount; a separate controller credential creates and removes only per-run probe Pods, so the fixture authority cannot make missing product-provider RBAC pass.

Both runtime endpoints are activated only after a run-owned helper Pod in the actual `praetorium-system` namespace, carrying the `provisioner` NetworkPolicy source label, successfully makes real HTTP readiness and test-auth requests to the internal Services. This source is allowed by the deployed system egress policy to contact correctly labeled tenant runtime Pods. The helper Pod is subject to the deployed restricted Pod Security policy, has no API token, and is tracked by unique name, UID, run label and inventory label. The provider's own fresh writer census and container `imageID` must agree with the recorded HTTP observations. The runner then sends TLS requests to the explicit ingress IP with the generated hostname as SNI and Host, verifies the test app marker, and repeats after the workload stop/start transitions. A separate restricted helper Pod in `praetorium-observability`, carrying the exact `prometheus` source label, establishes that the Provisioner process's private `/healthz` endpoint returns its live response from the only source allowed by the system ingress policy. Both helper namespaces retain restricted Pod Security settings. This check does not require or claim Provisioner Deployment readiness; producer-dependent application readiness remains a separate gate.

For full writer census, the runner stops one provider-managed workload and creates a real Pod with the provider's selector and stable namespace-ownership labels plus runner-owned labels. It deliberately omits the managed runtime epoch and generation. The provider must report the Pod in its complete all-epoch namespace census and return pending rather than start a replacement. The Pod is removed by the separate test-controller identity with its captured UID and freshly read resourceVersion before restart; the Provisioner identity has no direct Pod-create permission.

For policy checks, each source runtime is stopped to honor the rendered one-Pod namespace quota. A real shell Pod with the tenant's instance and `scriptorium` selector labels then runs in that tenant namespace while the peer runtime remains ready. The fixed script confirms peer-Service DNS and Kubernetes API DNS resolve, verifies cross-instance HTTP packets do not reach the known-ready peer, verifies unauthenticated requests cannot reach the Kubernetes API or the live Provisioner Pod's private health endpoint, verifies packets to `169.254.169.254` fail, and confirms the allowed public HTTPS marker endpoint succeeds. The private endpoint is observed from the control Pod IP returned by the explicitly authenticated API. A restricted helper carrying the actual allowed `prometheus` source label must receive the live `/healthz` response immediately before and after each tenant probe, with the same Provisioner Pod UID, so a stopped or replaced endpoint cannot turn a failed connection into a false isolation pass. The configured health port is checked against the live ConfigMap. It runs in both directions. This measures packets from actual tenant-selected Pods; reading the NetworkPolicy object alone is not accepted.

Every short-lived Pod is removed using the captured UID and a freshly read resourceVersion; cleanup waits for the exact Pod UID to disappear before restarting a writer or taking a recovered capacity snapshot. Provider cleanup runs only for the two random instance identities created by this test and retains the provider-owned tenant namespaces as required by T07. The runner never creates or removes a shared platform namespace. Cleanup failures fail the category and are reported rather than hidden.

## Acceptance boundary

A passing execution verifies the provider against the exact explicitly owned disposable cluster, selected test image, ingress endpoint, and tested CNI paths for this run. It does not certify Scriptorium producer image/runtime semantics, real user authorization, S02 grants, Control Plane/D1 reservation behavior, BuildKit/registry admission, failover under node partition, production capacity, or production deployment. The test-controller reservation adapter is deliberately identified as a local boundary.

No cluster was available in the checked-in inventory at this source cut. Therefore no cluster execution, image pull, ingress, CNI packet result, actual Pod image observation, capacity acceptance, or runtime cleanup result is claimed. T14 and its producer gates remain blocked until a separately owned disposable environment is provided and this complete category passes there.
