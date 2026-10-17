# Kubernetes provisioner admission boundary

This policy pair limits the dynamic Kubernetes writes made by the provisioner
service account. `provisioner-boundary.yaml` covers per-instance Namespace
creation and ownership-preserving updates. `provisioner-rolebinding.yaml`
covers every RoleBinding request from the provisioner, including bootstrap
creation in arbitrary namespaces. They intentionally are not wired into a
Kustomize overlay here; the root integrator owns composition after the paired
RBAC review.

The protected principal is
`system:serviceaccount:praetorium-system:praetorium-provisioner`, matching the
provider and Deployment service account. The actual provider derives a tenant
namespace as `praetorium-instances-` plus the lower-case 26-character suffix of
an `ins_` instance ID. The Namespace must carry the provider-emitted Arcadia
platform, managed-by, instance, ownership-version, and runtime-cluster labels,
plus a positive safe-integer repository ID. `@@CLUSTER_ID@@` uses the existing
inventory render substitution. A paired runtime identity change is adding the
three Namespace Pod Security labels (`enforce`, `audit`, and `warn`) with the
value `restricted`; the policy requires them on create/update and preserves
them on update. Do not wire this policy until that provider change is
integrated. Namespace updates require the old identity and security labels to
be present and unchanged; fields such as resourceVersion, UID, timestamps,
annotations, and managedFields are not compared.

The provider only reads and creates Namespaces; it never patches or deletes
them. The admission policy permits an ownership-preserving update for safe
future metadata maintenance but denies Namespace deletion for this principal.
Instance namespace retirement therefore remains an explicit operator
operation.

The provider creates, patches, and deletes only
`praetorium-provisioner-runtime` in the instance namespace. The RoleBinding
policy requires the namespace name and ownership labels to be valid, requires
the binding's instance/repository/cluster labels to match that Namespace, and
allows only the fixed ClusterRole
`praetorium-provisioner-tenant-runtime` with the single subject
`praetorium-system/praetorium-provisioner`. Runtime epoch and generation labels
must be positive safe integers, and the provider's `release-id=none` label is
required. Updates validate both the prior and resulting binding; deletes
validate `oldObject`. The binding applies to all RoleBindings requested by the
provisioner, not only label-selected namespaces: RBAC cannot name-scope
RoleBinding creation, so a namespace selector would leave a path for the
provisioner to create a grant in a namespace without the expected ownership
labels.

The paired RBAC policy grants bootstrap Namespace `get/create`, read-only
capacity and resource observations, and the named tenant RoleBinding
`get/patch/delete` plus `create` and `bind` on the single runtime ClusterRole.
The per-instance grant lists Pods and manages only Deployments, IngressRoutes,
NetworkPolicies, LimitRanges, ResourceQuotas, ServiceAccounts, and Services.
It grants no Secret, ConfigMap, PVC, Job, or Pod-write access. Admission
restricts the bootstrap `create` and the fixed tenant binding shape; it does
not replace the separate RBAC policy or the provider's runtime ownership
checks.

This unit does not admit or constrain application Pods, NetworkPolicies,
IngressRoutes, routes, ports, network topology, or arbitrary in-namespace
runtime resources. It also adds no legacy PVC or data-deletion-marker flow.
Those are outside this namespace and RoleBinding bootstrap boundary.

## Kubernetes API baseline and evidence

ValidatingAdmissionPolicy is stable in Kubernetes v1.30 and uses
`admissionregistration.k8s.io/v1`; it exposes `oldObject` for update/delete
requests and `namespaceObject` in validation expressions. The policy therefore
requires a Kubernetes API server at v1.30 or newer. The current deployment
inventory does not record a Kubernetes server version, and no target or
disposable API server was available in this worktree. The version prerequisite
must be checked during deployment preflight before these policies are wired or
applied. See the Kubernetes project's [GA announcement for v1.30](https://kubernetes.io/blog/2024/04/24/validating-admission-policy-ga/)
and its [Validating Admission Policy reference](https://kubernetes.io/docs/reference/access-authn-authz/validating-admission-policy/).

`tests/infra/kubernetes-admission.test.mjs` parses the YAML documents and checks
the binding-to-policy relationships, provider identity/label names,
operation coverage, old-object guards, cluster-ID parameter, and omitted
legacy/runtime resources. These are manifest contract checks, not a Kubernetes
CEL execution test. No local Kubernetes API server or CEL evaluator was
available here, so CEL compilation and real admission outcomes remain
unverified. Run server-side dry-run and positive/negative admission cases on an
explicitly disposable Kubernetes v1.30+ cluster before treating this policy as
operationally validated.
