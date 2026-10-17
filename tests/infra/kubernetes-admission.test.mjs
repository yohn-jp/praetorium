import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(resolve(repositoryRoot, "package.json"));
const yaml = require(resolve(repositoryRoot, "node_modules/.pnpm/node_modules/js-yaml"));

function parseYamlDocuments(relativePath) {
  return yaml.loadAll(readFileSync(resolve(repositoryRoot, relativePath), "utf8"));
}

const namespaceDocuments = parseYamlDocuments(
  "infrastructure/kubernetes/policies/provisioner-boundary.yaml",
);
const roleBindingDocuments = parseYamlDocuments(
  "infrastructure/kubernetes/policies/provisioner-rolebinding.yaml",
);
const namespacePolicy = namespaceDocuments.find(
  (document) => document.kind === "ValidatingAdmissionPolicy",
);
const namespaceBinding = namespaceDocuments.find(
  (document) => document.kind === "ValidatingAdmissionPolicyBinding",
);
const roleBindingPolicy = roleBindingDocuments.find(
  (document) => document.kind === "ValidatingAdmissionPolicy",
);
const roleBindingPolicyBinding = roleBindingDocuments.find(
  (document) => document.kind === "ValidatingAdmissionPolicyBinding",
);

test("Namespace policy uses the v1 policy API and rejects unowned or retired namespaces", () => {
  assert.equal(namespacePolicy.apiVersion, "admissionregistration.k8s.io/v1");
  assert.equal(namespacePolicy.spec.failurePolicy, "Fail");
  assert.deepEqual(namespacePolicy.spec.matchConstraints.resourceRules[0].operations, [
    "CREATE",
    "UPDATE",
    "DELETE",
  ]);
  assert.deepEqual(namespaceBinding.spec.validationActions, ["Deny"]);
  assert.equal(namespaceBinding.spec.policyName, namespacePolicy.metadata.name);
  assert.match(
    namespacePolicy.spec.matchConditions[0].expression,
    /system:serviceaccount:praetorium-system:praetorium-provisioner/u,
  );

  const [deleteGuard, currentIdentity, oldIdentity] = namespacePolicy.spec.validations.map(
    ({ expression }) => expression,
  );
  assert.match(deleteGuard, /request\.operation != "DELETE"/u);
  assert.match(currentIdentity, /praetorium-instances-/u);
  assert.match(currentIdentity, /substring\(4\)\.lowerAscii\(\)/u);
  assert.match(currentIdentity, /ins_\[0-9A-HJKMNP-TV-Z\]\{26\}/u);
  assert.match(currentIdentity, /@@CLUSTER_ID@@/u);
  assert.match(
    currentIdentity,
    /int\(object\.metadata\.labels\["praetorium\.io\/repository-id"\]\)/u,
  );

  for (const key of [
    "arcadia.io/platform",
    "app.kubernetes.io/managed-by",
    "arcadia.io/instance-id",
    "praetorium.io/repository-id",
    "arcadia.io/ownership-version",
    "arcadia.io/runtime-cluster-id",
    "pod-security.kubernetes.io/enforce",
    "pod-security.kubernetes.io/audit",
    "pod-security.kubernetes.io/warn",
  ]) {
    assert.ok(currentIdentity.includes(`object.metadata.labels["${key}"]`), `missing ${key}`);
    assert.ok(
      oldIdentity.includes(`oldObject.metadata.labels["${key}"]`),
      `old object missing ${key}`,
    );
  }
  assert.match(oldIdentity, /request\.operation != "UPDATE"/u);
});

test("RoleBinding policy closes broad create rights to one provider grant", () => {
  assert.equal(roleBindingPolicy.apiVersion, "admissionregistration.k8s.io/v1");
  assert.equal(roleBindingPolicy.spec.failurePolicy, "Fail");
  assert.deepEqual(roleBindingPolicy.spec.matchConstraints.resourceRules[0].operations, [
    "CREATE",
    "UPDATE",
    "DELETE",
  ]);
  assert.deepEqual(roleBindingPolicyBinding.spec.validationActions, ["Deny"]);
  assert.equal(roleBindingPolicyBinding.spec.policyName, roleBindingPolicy.metadata.name);
  assert.equal(roleBindingPolicyBinding.spec.matchResources, undefined);
  assert.match(
    roleBindingPolicy.spec.matchConditions[0].expression,
    /system:serviceaccount:praetorium-system:praetorium-provisioner/u,
  );

  const expressions = roleBindingPolicy.spec.validations.map(({ expression }) => expression);
  const namespaceIdentity = expressions[0];
  const bindingIdentity = expressions[1];
  const oldBindingIdentity = expressions[2];
  assert.match(namespaceIdentity, /namespaceObject != null/u);
  assert.match(namespaceIdentity, /@@CLUSTER_ID@@/u);
  assert.match(bindingIdentity, /request\.operation == "DELETE" \? oldObject : object/u);
  assert.match(bindingIdentity, /praetorium-provisioner-runtime/u);
  assert.match(bindingIdentity, /praetorium-provisioner-tenant-runtime/u);
  assert.match(bindingIdentity, /subjects\.size\(\) == 1/u);
  assert.match(bindingIdentity, /subjects\[0\]\.name == "praetorium-provisioner"/u);
  assert.match(bindingIdentity, /subjects\[0\]\.namespace == "praetorium-system"/u);
  assert.match(oldBindingIdentity, /request\.operation != "UPDATE"/u);
  assert.match(oldBindingIdentity, /oldObject\.roleRef\.name/u);
  assert.match(oldBindingIdentity, /oldObject\.metadata\.labels\["arcadia\.io\/instance-id"\]/u);

  for (const key of [
    "arcadia.io/platform",
    "app.kubernetes.io/managed-by",
    "arcadia.io/instance-id",
    "praetorium.io/repository-id",
    "arcadia.io/ownership-version",
    "arcadia.io/runtime-cluster-id",
  ]) {
    assert.ok(
      bindingIdentity.includes(`namespaceObject.metadata.labels["${key}"]`),
      `namespace missing ${key}`,
    );
  }
});

test("policy identity matches the provider principal and emitted ownership contract", () => {
  const provider = readFileSync(
    resolve(repositoryRoot, "plugins/kubernetes/src/kubernetes/provider.ts"),
    "utf8",
  );
  const labels = readFileSync(resolve(repositoryRoot, "plugins/kubernetes/src/labels.ts"), "utf8");
  const deployment = readFileSync(
    resolve(repositoryRoot, "infrastructure/kubernetes/base/platform-services.yaml"),
    "utf8",
  );

  assert.match(provider, /const PROVISIONER_NAMESPACE = "praetorium-system";/u);
  assert.match(provider, /const PROVISIONER_SERVICE_ACCOUNT = "praetorium-provisioner";/u);
  assert.match(
    provider,
    /const PROVISIONER_TENANT_ROLE = "praetorium-provisioner-tenant-runtime";/u,
  );
  assert.match(provider, /const name = "praetorium-provisioner-runtime";/u);
  assert.match(deployment, /PROVISIONER_NAMESPACE_PREFIX: praetorium-instances/u);
  assert.match(deployment, /serviceAccountName: praetorium-provisioner/u);

  const sourceLabelKeys = [
    "PLATFORM_LABEL_KEY",
    "MANAGED_BY_LABEL_KEY",
    "INSTANCE_LABEL_KEY",
    "REPOSITORY_LABEL_KEY",
    "OWNERSHIP_LABEL_KEY",
    "CLUSTER_LABEL_KEY",
  ].map((constant) => {
    const match = new RegExp(`export const ${constant} = "([^"]+)";`, "u").exec(labels);
    assert.ok(match, `missing provider label constant ${constant}`);
    return match[1];
  });
  const expressions = [
    ...namespacePolicy.spec.validations.map(({ expression }) => expression),
    ...roleBindingPolicy.spec.validations.map(({ expression }) => expression),
  ].join("\n");
  for (const key of sourceLabelKeys) {
    assert.ok(expressions.includes(key), `admission policies do not cover provider label ${key}`);
  }
});

test("the bootstrap boundary excludes unrelated legacy and runtime resource policies", () => {
  const policySources = [
    readFileSync(
      resolve(repositoryRoot, "infrastructure/kubernetes/policies/provisioner-boundary.yaml"),
      "utf8",
    ),
    readFileSync(
      resolve(repositoryRoot, "infrastructure/kubernetes/policies/provisioner-rolebinding.yaml"),
      "utf8",
    ),
  ].join("\n");
  for (const forbidden of [
    "persistentvolumeclaims",
    "data-deletion-state",
    "data-deletion-authorized",
    "configmaps",
    "secrets",
    "jobs",
    "networkpolicies",
    "ingressroutes",
    "PathPrefix",
    "targetPort",
  ]) {
    assert.ok(
      !policySources.toLowerCase().includes(forbidden.toLowerCase()),
      `unexpected ${forbidden}`,
    );
  }
  assert.equal(policySources.includes("${CLUSTER_ID}"), false);
});
