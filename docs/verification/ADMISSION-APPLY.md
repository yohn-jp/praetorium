# Admission policy deployment gate

The infrastructure apply path installs and verifies the admission guards
before it grants the provisioner the broad bootstrap ClusterRoleBinding.
`scripts/deploy-infrastructure.mjs` uses `applyGuardedBundle` from
`infrastructure/scripts/guarded-apply.mjs` with explicit owned-cluster kubectl
clients and the read-only checks in `admission-readiness.mjs`:

1. Require API discovery for both `admissionregistration.k8s.io/v1`
   `validatingadmissionpolicies` and
   `validatingadmissionpolicybindings`.
2. Render the complete Kustomize bundle once and server-side dry-run that exact
   bundle.
3. Extract and apply only the seven ValidatingAdmissionPolicies and their
   seven same-name ValidatingAdmissionPolicyBindings.
4. Poll the live objects until every policy's current generation has been
   observed with completed type checking and no expression warnings, and every
   binding points to its same-name policy with only `validationActions: Deny`.
5. Apply the complete rendered bundle, which includes the bootstrap RBAC grant.

The policies are `praetorium-provisioner-instance-namespaces`,
`praetorium-provisioner-runtime-resources`,
`praetorium-provisioner-runtime-resource-delete`,
`praetorium-provisioner-instance-rolebindings`,
`praetorium-provisioner-tenant-ingressroute`,
`praetorium-provisioner-tenant-networkpolicy`, and
`praetorium-tenant-pods-restricted`. The binding for each policy has the same
name. `selectAdmissionGuards(bundle)` accepts the canonical Kustomize output,
requires this exact set without duplicate or unknown admission documents, and
returns only those 14 documents. It is deliberately a narrow document-header
reader, not a general-purpose YAML parser; callers must pass the trusted output
of the repository's renderer, not arbitrary YAML.

`assertAdmissionApi(discovery)` checks the APIResourceList before any apply.
`waitForAdmissionGuards` reads the named policies and bindings concurrently.
The readers should return parsed JSON from live `kubectl get` calls; map only
Kubernetes NotFound to `null` while an apply is propagating and let other
errors fail the gate. The default wait is 30 seconds with 250 millisecond
polls. Incorrect object identity, failure policy, writer identity, resource
scope, binding action, or expression warnings fail immediately. Missing
objects, missing status, stale `observedGeneration`, or absent type-checking
status are retried until the bounded deadline.

This status gate establishes that the API server has observed and type-checked
the stored policy generation. It does not establish that the admission plugin
is enabled or enforcing requests, validate policy behavior through the API
server, or prove CNI enforcement. Those require a disposable target cluster and
positive and negative server-side admission cases; no live cluster or
production apply is claimed here.

The upstream API defines `observedGeneration`, `typeChecking`, and
`expressionWarnings` on the ValidatingAdmissionPolicy status:
[Kubernetes admissionregistration v1 API types](https://github.com/kubernetes/api/blob/v0.35.5/admissionregistration/v1/types.go).
