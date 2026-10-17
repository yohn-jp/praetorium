# T12 disposable Kind runtime

The T12 local disposable cluster uses this fixed runtime pair:

| Component       | Required value                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------------- |
| Kind CLI        | `v0.31.0`                                                                                      |
| Kind node image | `kindest/node:v1.35.0@sha256:452d707d4862f52530247495d180205e029056831160e22870e37e3f6c1ac31f` |

Kind's v0.31.0 release publishes that node-image tag and digest as its Kubernetes 1.35.0 default. Its `kindnetd` includes the upstream Kubernetes NetworkPolicy implementation. The checked-in cluster config keeps the default Kind network and pins the node image; it does not install a third-party CNI. See the [official Kind v0.31.0 release](https://github.com/kubernetes-sigs/kind/releases/tag/v0.31.0) and [v0.31.0 kindnetd source](https://github.com/kubernetes-sigs/kind/blob/v0.31.0/images/kindnetd/cmd/kindnetd/main.go).

The T12 create/preflight path must accept only the exact CLI version reported by `kind version`. `infrastructure/scripts/kind-runtime.mjs` exports `assertKindRuntimeVersion()`, `KIND_RUNTIME_VERSION`, and `NODE_IMAGE` for that guard. An unavailable or different Kind binary blocks cluster creation; the helper does not create, inspect, or apply to a cluster.

This pin selects a policy-capable disposable runtime; it is not packet-level acceptance. The upstream kindnetd controller is configured fail-open and may skip NetworkPolicy setup when it cannot initialize. No manifest, controller process, or inventory declaration proves that packets are being filtered. T14 must run real traffic probes in an explicitly owned disposable environment and record allowed and denied flows, cluster/runtime identity, and results. In particular, verify cross-tenant isolation and blocked metadata/private-management egress after policies converge. The source K3s configuration retains its embedded kube-router NetworkPolicy controller; this Kind pin does not replace or reconfigure that runtime.

This runtime pair is infrastructure test tooling only. It is not an application image, Scriptorium artifact, build recipe, or producer acceptance result.
