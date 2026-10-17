# Traefik runtime route watch

The Traefik CRD provider now has an empty `providers.kubernetesCRD.namespaces`
allowlist, which means it watches all namespaces. This is required for the
production renderer's per-instance `IngressRoute`, whose namespace is
`praetorium-instances-` followed by the lower-case instance ID suffix. The
existing stopped-instance fallback remains in `praetorium-system`, which is
also covered by the all-namespace watch.

The provider still rejects cross-namespace references and ExternalName
Services. The generated runtime route resolves its Scriptorium Service in the
same per-instance namespace. The static fallback resolves `instance-access` in
its own `praetorium-system` namespace. The pinned chart's cluster-scoped RBAC
mode is explicit because the provider must read CRDs and Services across
namespaces; the chart renders its ClusterRole and ClusterRoleBinding in this
mode. The dashboard route remains disabled.

The values behavior was checked against the official Traefik Helm chart
[v41.6.1 values](https://github.com/traefik/traefik-helm-chart/blob/v41.6.1/traefik/values.yaml)
(`providers.kubernetesCRD.namespaces` and `rbac.namespaced`) and its exact
[ClusterRole template](https://github.com/traefik/traefik-helm-chart/blob/v41.6.1/traefik/templates/rbac/clusterrole.yaml)
and
[ClusterRoleBinding template](https://github.com/traefik/traefik-helm-chart/blob/v41.6.1/traefik/templates/rbac/clusterrolebinding.yaml).
The empty namespace list is documented to watch all namespaces, and
`rbac.namespaced: false` selects cluster-scoped RBAC. No live Helm release or
cluster behavior was applied or observed here.

The focused test uses the production Kubernetes renderer with bounded test
input to verify the emitted tenant route shape and parses the actual static
fallback manifest. It verifies controller values alongside both route paths;
it is not producer or cluster acceptance evidence.

Run the focused check with:

```sh
node --test tests/infra/traefik-runtime-watch.test.mjs
```
