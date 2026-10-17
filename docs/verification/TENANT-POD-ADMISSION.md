# Tenant Pod admission policy

The ValidatingAdmissionPolicy targets Pods in namespaces carrying the platform and managed-by labels emitted by the Kubernetes provider. It fails closed on Pod creation and updates, denying host namespace sharing, service-account token automount, host paths and host ports. Containers and init containers must use a digest-addressed image, have CPU, memory and ephemeral-storage requests and limits, and meet the restricted security-context checks.

These checks retain the security properties already emitted by the target Deployment renderer. The renderer creates a single Scriptorium container, sets non-root and `RuntimeDefault` seccomp, disables privilege escalation, makes the root filesystem read-only and drops all capabilities. It uses sized `emptyDir` workspace and temporary volumes, emits resource requests and limits, and does not create PVCs, host paths or host ports. The policy requires resource bounds to be present; it does not invent per-tenant maximums.

Run the focused structural and renderer-source check with:

```sh
node --test tests/infra/tenant-pod-policy.test.mjs
```

That check is not a Kubernetes API-server or CEL execution test. The policy and binding still need to be included by the root-owned static Kustomize wiring, validated against the supported Kubernetes API/CEL implementation, and exercised in an explicitly owned disposable cluster before deployment. No cluster apply or live admission result is claimed here.
