# Tenant Pod admission policy

The ValidatingAdmissionPolicy targets Pods in namespaces carrying the platform and managed-by labels emitted by the Kubernetes provider. It fails closed on Pod creation and updates, denying host namespace sharing, service-account token automount, host paths and host ports. Containers and init containers must use a digest-addressed image, have CPU, memory and ephemeral-storage requests and limits, and meet the additional security-context checks.

This VAP complements Kubernetes Pod Security Admission set to `restricted` on every dynamic tenant namespace; it is not a replacement or complete reimplementation of the Restricted standard. The tenant namespace renderer must emit `pod-security.kubernetes.io/enforce`, `pod-security.kubernetes.io/audit`, and `pod-security.kubernetes.io/warn` with the value `restricted`. PSA remains responsible for Restricted controls this VAP does not express, including added capabilities and ephemeral-container security fields. The Kubernetes API handles ephemeral containers through the `pods/ephemeralcontainers` subresource, which this VAP's `pods` rule does not select. The integrated provider emits and validates those namespace labels, and the static base includes the paired policies. See the Kubernetes [Pod Security Standards](https://kubernetes.io/docs/concepts/security/pod-security-standards/) and [ephemeral container documentation](https://kubernetes.io/docs/concepts/workloads/pods/ephemeral-containers/).

The VAP checks retain the security properties already emitted by the target Deployment renderer. The renderer creates a single Scriptorium container, sets non-root and `RuntimeDefault` seccomp, disables privilege escalation, makes the root filesystem read-only and drops all capabilities. It uses sized `emptyDir` workspace and temporary volumes, emits resource requests and limits, and does not create PVCs, host paths or host ports. The VAP requires resource bounds to be present; it does not invent per-tenant maximums.

Run the focused structural and renderer-source check with:

```sh
node --test tests/infra/tenant-pod-policy.test.mjs
```

That structural check is separate from the [owned Kubernetes v1.35 API probe](OWNED-KUBERNETES.md). The probe used the exact policy bytes integrated at `137bc17`, with an isolated candidate name/selector and binding. After a binding-specific denial established readiness, valid Pod dry-runs passed and missing regular/init resource maps or limits were denied. Requests omitted from input were defaulted from limits by the API. No Pod persisted or image was pulled. The report SHA-256 is `9da37813c798d04decd840ac805305862aff57102abccf51d190ee542d501df7`. Canonical full-bundle application, workload execution, networking and full T14 acceptance remain unverified.
