# Kubernetes provisioner RBAC

`infrastructure/kubernetes/policies/provisioner-rbac.yaml` separates the Provisioner's bootstrap authority from the per-instance runtime grant. The existing `praetorium-system/praetorium-provisioner` ServiceAccount receives the bootstrap ClusterRole. The Provisioner creates the fixed `praetorium-provisioner-runtime` RoleBinding inside each runtime namespace, binding only `praetorium-provisioner-tenant-runtime` to that ServiceAccount.

The bootstrap role can create runtime namespaces, observe capacity (cluster-wide Node and Pod lists), discover managed Deployments, and read runtime objects. The global reads are needed for complete observation after a runtime RoleBinding is removed during cleanup. It can create RoleBindings and patch/delete only the fixed RoleBinding name; its `bind` permission is limited to the tenant ClusterRole. Runtime writes are in the tenant ClusterRole and become effective only in namespaces where the dynamic RoleBinding exists. The target grants no Secret, ConfigMap, PVC, or Job access and no namespace deletion.

The target was compared with the read-only Arcadia source policy at `infrastructure/kubernetes/infrastructure/policies/provisioner-rbac.yaml`. It intentionally omits source permissions unused by the current runtime provider, including legacy backup-credential access, broad Secret/ConfigMap/PVC/Job access, namespace deletion, and broad tenant-object watches. Source policy names and rights were not copied as a default.

## Authorization boundary

Kubernetes RBAC cannot express a namespace-name prefix, a name pattern, or a resource name on `create`. The bootstrap role therefore cannot by itself constrain namespace creation or RoleBinding creation to the generated runtime namespace. Its RoleBinding `create` rule is cluster-wide; `bind` prevents binding arbitrary ClusterRoles but does not constrain the subject or namespace. The exact RoleBinding name restriction on `get`, `patch`, and `delete` also does not restrict the namespace. The provider validates ownership and roleRef before managing objects, but that check is not an authorization boundary against a compromised Provisioner credential.

Before applying this policy to a live cluster, deploy and verify an admission policy that allows namespace creation only for validated generated instance namespaces with the expected ownership labels, and allows the dynamic RoleBinding only in those namespaces with the exact name, tenant ClusterRole reference, sole Provisioner ServiceAccount subject, and expected ownership labels. It must reject attempts to create or alter other bindings or subjects. Confirm that the cluster's admission implementation covers create and update/patch paths. This repository change does not add or certify that admission policy and does not make RBAC alone enforce namespace ownership.

The static base includes the policies directory, composing these roles with the namespace, RoleBinding and runtime-resource admission boundaries and the aligned Provisioner principal. Local manifest and generic CEL review are recorded separately; target-server admission and live authorization remain unverified.

## Verification

Run the offline policy graph and provider-path tests with:

```sh
node --test tests/infra/provisioner-rbac.test.mjs
```

These tests parse the checked-in RBAC rules and check the ServiceAccount, provider principal, resource/verb graph, and explicit privilege exclusions. They do not prove Kubernetes API authorization or admission behavior. No cluster apply or live `kubectl auth can-i` check was run for this change.
