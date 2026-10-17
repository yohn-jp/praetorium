# Kubernetes provisioner admission boundary

This policy pair limits the dynamic Kubernetes writes made by the provisioner
service account. `provisioner-boundary.yaml` covers per-instance Namespace
creation and ownership-preserving updates. `provisioner-rolebinding.yaml`
covers every RoleBinding request from the provisioner, including bootstrap
creation in arbitrary namespaces. The static base includes these policies and
the paired RBAC graph through the policies Kustomization. The generic resource
ownership boundaries below cover the provider-emitted runtime objects.

The protected principal is
`system:serviceaccount:praetorium-system:praetorium-provisioner`, matching the
provider and Deployment service account. The actual provider derives a tenant
namespace as `praetorium-instances-` plus the lower-case 26-character suffix of
an `ins_` instance ID. The Namespace must carry the provider-emitted Arcadia
platform, managed-by, instance, ownership-version, and runtime-cluster labels,
plus a positive safe-integer repository ID. `@@CLUSTER_ID@@` uses the existing
inventory render substitution. The paired runtime provider emits the
three Namespace Pod Security labels (`enforce`, `audit`, and `warn`) with the
value `restricted`; the policy requires them on create/update and preserves
them on update, matching the provider's namespace renderer and existing
namespace validation. Namespace updates require the old identity and security
labels to be present and unchanged; fields such as resourceVersion, UID,
timestamps, annotations, and managedFields are not compared. Per-mode Pod Security version
labels may be absent (the provider shape) or `latest`; older minor-version
pins are denied on create and update, and existing values must remain
unchanged. Kubernetes documents these per-mode labels as version pins; current
Restricted policy changes also apply to host probe/lifecycle fields, so a
provisioner-controlled downgrade would weaken the namespace boundary. See the
[Pod Security Admission reference](https://kubernetes.io/docs/concepts/security/pod-security-admission/)
and the [v1.34 Restricted host-probe change](https://kubernetes.io/blog/2025/08/27/kubernetes-v1-34-release/).

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

`provisioner-boundary.yaml` also covers CREATE/UPDATE/DELETE for the provider's
ServiceAccount, Service, LimitRange, ResourceQuota, Deployment,
NetworkPolicy, and IngressRoute resources. It checks each object's fixed name,
namespace, instance, repository, generation, runtime epoch, release, and
cluster ownership labels against the namespace. Updates require the prior
object to have the same instance/repository/cluster owner; epoch, generation,
and release can change to the new valid values during a provider transition.
Delete checks `oldObject`. These generic rules do not inspect workload
templates or route/network policy specs; route/port and network topology
policy stays with the separate gateway/network policy unit. Resource DELETE
admission does not prove writer-process death; the provider's lifecycle fence
and writer census remain responsible for that decision. No legacy PVC or
data-deletion-marker flow is included.

## Kubernetes API baseline and evidence

ValidatingAdmissionPolicy is stable in Kubernetes v1.30 and uses
`admissionregistration.k8s.io/v1`; it exposes `oldObject` for update/delete
requests and `namespaceObject` in validation expressions. The policy therefore
requires a Kubernetes API server at v1.30 or newer. The current deployment
inventory does not record a Kubernetes server version, and no target or
disposable API server was available in this worktree. The version prerequisite
must be checked during deployment preflight before these policies are applied. See the Kubernetes project's [GA announcement for v1.30](https://kubernetes.io/blog/2024/04/24/validating-admission-policy-ga/)
and its [Validating Admission Policy reference](https://kubernetes.io/docs/reference/access-authn-authz/validating-admission-policy/).

`tests/infra/kubernetes-admission.test.mjs` parses the YAML documents and checks
the binding-to-policy relationships, provider identity/label names,
operation coverage, renderer resource kinds/names, old-object guards,
cluster-ID parameter, and omitted legacy/data operations. These are manifest
contract checks, not a Kubernetes API server test. An independent CEL
evaluator review is tracked separately; no Kubernetes API server was available
in this worktree. Run server-side dry-run and positive/negative admission cases
on an explicitly disposable Kubernetes v1.30+ cluster before treating this
policy as operationally validated.
