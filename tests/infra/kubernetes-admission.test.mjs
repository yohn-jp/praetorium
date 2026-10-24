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
const ingressRoutePolicyDocuments = parseYamlDocuments(
  "infrastructure/kubernetes/policies/provisioner-ingressroute.yaml",
);
const historyPvcPolicyDocuments = parseYamlDocuments(
  "infrastructure/kubernetes/policies/provisioner-history-pvc.yaml",
);
const traefikHelmDocuments = parseYamlDocuments(
  "infrastructure/kubernetes/controllers/helm-releases.yaml",
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
const runtimeResourcePolicy = namespaceDocuments.find(
  (document) => document.metadata.name === "praetorium-provisioner-runtime-resources",
);
const runtimeResourceBinding = namespaceDocuments.find(
  (document) =>
    document.kind === "ValidatingAdmissionPolicyBinding" &&
    document.metadata.name === "praetorium-provisioner-runtime-resources",
);
const runtimeResourceDeletePolicy = namespaceDocuments.find(
  (document) =>
    document.metadata.name === "praetorium-provisioner-runtime-resource-delete" &&
    document.kind === "ValidatingAdmissionPolicy",
);
const runtimeResourceDeleteBinding = namespaceDocuments.find(
  (document) =>
    document.metadata.name === "praetorium-provisioner-runtime-resource-delete" &&
    document.kind === "ValidatingAdmissionPolicyBinding",
);
const ingressRoutePolicy = ingressRoutePolicyDocuments.find(
  (document) =>
    document.kind === "ValidatingAdmissionPolicy" &&
    document.metadata.name === "praetorium-provisioner-tenant-ingressroute",
);
const historyPvcPolicy = historyPvcPolicyDocuments.find(
  (document) =>
    document.kind === "ValidatingAdmissionPolicy" &&
    document.metadata.name === "praetorium-provisioner-history-pvc",
);
const historyPvcBinding = historyPvcPolicyDocuments.find(
  (document) =>
    document.kind === "ValidatingAdmissionPolicyBinding" &&
    document.metadata.name === "praetorium-provisioner-history-pvc",
);

test("history PVC admission is bound to one stable, owned local-path claim", () => {
  assert.ok(historyPvcPolicy);
  assert.ok(historyPvcBinding);
  assert.equal(historyPvcPolicy.spec.failurePolicy, "Fail");
  assert.deepEqual(historyPvcBinding.spec.validationActions, ["Deny"]);
  assert.equal(historyPvcBinding.spec.policyName, historyPvcPolicy.metadata.name);
  assert.deepEqual(historyPvcPolicy.spec.matchConstraints.resourceRules, [
    {
      apiGroups: [""],
      apiVersions: ["v1"],
      operations: ["CREATE", "UPDATE"],
      resources: ["persistentvolumeclaims"],
    },
  ]);
  assert.match(
    historyPvcPolicy.spec.matchConditions[0].expression,
    /system:serviceaccount:praetorium-system:praetorium-provisioner/u,
  );
  const expressions = historyPvcPolicy.spec.validations.map(({ expression }) => expression);
  assert.match(
    expressions[0],
    /namespaceObject\.metadata\.labels\["arcadia\.io\/runtime-cluster-id"\] == "@@CLUSTER_ID@@"/u,
  );
  assert.match(expressions[1], /-history"/u);
  assert.match(expressions[1], /praetorium\.io\/history-contract/u);
  assert.match(expressions[1], /!\("praetorium\.io\/runtime-epoch" in object\.metadata\.labels\)/u);
  assert.match(expressions[1], /!\("arcadia\.io\/generation" in object\.metadata\.labels\)/u);
  assert.match(expressions[1], /!\("arcadia\.io\/release-id" in object\.metadata\.labels\)/u);
  assert.match(expressions[2], /storageClassName == "local-path"/u);
  assert.match(expressions[2], /accessModes == \["ReadWriteOnce"\]/u);
  assert.match(expressions[2], /dataSourceRef/u);
  assert.match(expressions[3], /request\.operation != "UPDATE"/u);
  assert.match(expressions[3], /requests\["storage"\]/u);
});

test("tenant IngressRoute deny-list covers the pinned Traefik CRD object fields", () => {
  const traefikRelease = traefikHelmDocuments.find(
    (document) => document.kind === "HelmRelease" && document.metadata.name === "traefik",
  );
  assert.ok(traefikRelease);
  assert.equal(traefikRelease.spec.chart.spec.version, "41.6.1");

  const expression = ingressRoutePolicy.spec.validations[1].expression;
  // This inventory is from the v41.6.1 IngressRoute CRD; a chart-pin change requires review here.
  const crdFields = {
    "object.spec": ["entryPoints", "ingressClassName", "parentRefs", "routes", "tls"],
    "object.spec.routes[0]": [
      "kind",
      "match",
      "middlewares",
      "observability",
      "priority",
      "services",
      "syntax",
    ],
    "object.spec.routes[0].services[0]": [
      "healthCheck",
      "kind",
      "middlewares",
      "name",
      "namespace",
      "nativeLB",
      "nodePortLB",
      "passHostHeader",
      "passiveHealthCheck",
      "port",
      "responseForwarding",
      "scheme",
      "serversTransport",
      "sticky",
      "strategy",
      "weight",
    ],
    "object.spec.tls": ["certResolver", "domains", "options", "secretName", "store"],
  };
  const allowedFields = {
    "object.spec": ["entryPoints", "routes", "tls"],
    "object.spec.routes[0]": ["kind", "match", "priority", "services"],
    "object.spec.routes[0].services[0]": ["name", "port"],
    "object.spec.tls": [],
  };
  const expectedForbidden = Object.entries(crdFields)
    .flatMap(([path, fields]) =>
      fields
        .filter((field) => !allowedFields[path].includes(field))
        .map((field) => `${path}.${field}`),
    )
    .sort();
  const actualForbidden = [...expression.matchAll(/!has\((object\.spec[^)]*)\)/gu)]
    .map((match) => match[1])
    .sort();

  assert.deepEqual(actualForbidden, expectedForbidden);
  for (const field of Object.entries(allowedFields).flatMap(([path, fields]) =>
    fields.map((name) => `${path}.${name}`),
  )) {
    assert.ok(expression.includes(`has(${field})`), `missing required field ${field}`);
  }
  assert.doesNotMatch(
    expression,
    /object\.spec\.size\(\)|routes\[0\]\.size\(\)|services\[0\]\.size\(\)|tls\.size\(\)/u,
  );
  assert.match(expression, /object\.spec\.routes\.size\(\) == 1/u);
  assert.match(expression, /object\.spec\.routes\[0\]\.services\.size\(\) == 1/u);
});

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
    "pod-security.kubernetes.io/enforce-version",
    "pod-security.kubernetes.io/audit-version",
    "pod-security.kubernetes.io/warn-version",
  ]) {
    assert.ok(currentIdentity.includes(`object.metadata.labels["${key}"]`), `missing ${key}`);
    if (!key.endsWith("-version")) {
      assert.ok(
        oldIdentity.includes(`oldObject.metadata.labels["${key}"]`),
        `old object missing ${key}`,
      );
    }
  }
  for (const key of [
    "pod-security.kubernetes.io/enforce-version",
    "pod-security.kubernetes.io/audit-version",
    "pod-security.kubernetes.io/warn-version",
  ]) {
    assert.ok(currentIdentity.includes(`"${key}" in object.metadata.labels`));
    assert.ok(currentIdentity.includes(`object.metadata.labels["${key}"] == "latest"`));
    assert.ok(oldIdentity.includes(`"${key}" in oldObject.metadata.labels`));
    assert.ok(oldIdentity.includes(`oldObject.metadata.labels["${key}"] == "latest"`));
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
  assert.match(namespaceIdentity, /pod-security\.kubernetes\.io\/enforce/u);
  assert.match(namespaceIdentity, /pod-security\.kubernetes\.io\/audit/u);
  assert.match(namespaceIdentity, /pod-security\.kubernetes\.io\/warn/u);
  for (const mode of ["enforce", "audit", "warn"]) {
    const versionKey = `pod-security.kubernetes.io/${mode}-version`;
    assert.ok(namespaceIdentity.includes(`"${versionKey}" in namespaceObject.metadata.labels`));
    assert.ok(
      namespaceIdentity.includes(`namespaceObject.metadata.labels["${versionKey}"] == "latest"`),
    );
  }
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
  for (const mode of ["enforce", "audit", "warn"]) {
    assert.ok(
      namespaceIdentity.includes(
        `namespaceObject.metadata.labels["pod-security.kubernetes.io/${mode}"] == "restricted"`,
      ),
    );
  }
});

test("runtime resource admission covers the renderer's exact kinds and delete oldObject", () => {
  assert.ok(runtimeResourcePolicy);
  assert.ok(runtimeResourceBinding);
  assert.ok(runtimeResourceDeletePolicy);
  assert.ok(runtimeResourceDeleteBinding);
  assert.equal(runtimeResourcePolicy.kind, "ValidatingAdmissionPolicy");
  assert.equal(runtimeResourceDeletePolicy.kind, "ValidatingAdmissionPolicy");
  assert.equal(runtimeResourcePolicy.spec.failurePolicy, "Fail");
  assert.equal(runtimeResourceDeletePolicy.spec.failurePolicy, "Fail");
  assert.deepEqual(runtimeResourceBinding.spec.validationActions, ["Deny"]);
  assert.deepEqual(runtimeResourceDeleteBinding.spec.validationActions, ["Deny"]);
  assert.equal(runtimeResourceBinding.spec.policyName, runtimeResourcePolicy.metadata.name);
  assert.equal(
    runtimeResourceDeleteBinding.spec.policyName,
    runtimeResourceDeletePolicy.metadata.name,
  );
  assert.equal(runtimeResourceBinding.spec.matchResources, undefined);
  assert.equal(runtimeResourceDeleteBinding.spec.matchResources, undefined);

  const writes = runtimeResourcePolicy.spec.matchConstraints.resourceRules;
  const deletes = runtimeResourceDeletePolicy.spec.matchConstraints.resourceRules;
  assert.deepEqual(
    writes.map(({ apiGroups, apiVersions, operations, resources }) => ({
      apiGroups,
      apiVersions,
      operations,
      resources,
    })),
    [
      {
        apiGroups: [""],
        apiVersions: ["v1"],
        operations: ["CREATE", "UPDATE"],
        resources: ["limitranges", "resourcequotas", "secrets", "serviceaccounts", "services"],
      },
      {
        apiGroups: ["apps"],
        apiVersions: ["v1"],
        operations: ["CREATE", "UPDATE"],
        resources: ["deployments"],
      },
      {
        apiGroups: ["networking.k8s.io"],
        apiVersions: ["v1"],
        operations: ["CREATE", "UPDATE"],
        resources: ["networkpolicies"],
      },
      {
        apiGroups: ["traefik.io"],
        apiVersions: ["v1alpha1"],
        operations: ["CREATE", "UPDATE"],
        resources: ["ingressroutes"],
      },
    ],
  );
  assert.deepEqual(
    deletes.map(({ apiGroups, apiVersions, operations, resources }) => ({
      apiGroups,
      apiVersions,
      operations,
      resources,
    })),
    writes.map(({ apiGroups, apiVersions, resources }) => ({
      apiGroups,
      apiVersions,
      operations: ["DELETE"],
      resources,
    })),
  );

  const source = readFileSync(
    resolve(repositoryRoot, "plugins/kubernetes/src/kubernetes/renderer.ts"),
    "utf8",
  );
  for (const kind of [
    "ServiceAccount",
    "Service",
    "Secret",
    "LimitRange",
    "ResourceQuota",
    "Deployment",
    "NetworkPolicy",
    "IngressRoute",
  ]) {
    assert.ok(source.includes(`kind: "${kind}"`), `renderer does not emit ${kind}`);
  }
  assert.match(source, /metadata\(spec, ns, `\$\{name\}-app`\)/u);
  assert.match(source, /metadata\(spec, ns, `\$\{name\}-network`\)/u);
  assert.match(source, /metadata\(spec, ns, `\$\{name\}-quota`\)/u);
  assert.match(source, /metadata\(spec, ns, `\$\{name\}-limits`\)/u);
  assert.match(source, /metadata\(spec, ns, name\)/u);
  const naming = readFileSync(resolve(repositoryRoot, "plugins/kubernetes/src/naming.ts"), "utf8");
  assert.match(naming, /`arcadia-\$\{instanceId\.replace\("_", "-"\)\.toLowerCase\(\)\}`/u);

  const expressions = runtimeResourcePolicy.spec.validations.map(({ expression }) => expression);
  assert.match(expressions[0], /namespaceObject != null/u);
  assert.match(expressions[0], /@@CLUSTER_ID@@/u);
  assert.match(expressions[1], /request\.resource\.resource/u);
  assert.match(expressions[1], /arcadia-ins-/u);
  assert.match(expressions[1], /object\.metadata\.labels\["praetorium\.io\/repository-id"\]/u);
  assert.match(expressions[1], /object\.metadata\.labels\["praetorium\.io\/runtime-epoch"\]/u);
  assert.match(expressions[1], /object\.metadata\.labels\["arcadia\.io\/generation"\]/u);
  assert.match(expressions[1], /request\.resource\.resource == "secrets"/u);
  assert.match(expressions[1], /request\.resource\.resource == "services"/u);
  assert.match(expressions[1], /-control/u);
  assert.match(expressions[1], /-runtime/u);
  assert.match(expressions[1], /-image-pull/u);
  assert.match(expressions[2], /publishNotReadyAddresses/u);
  assert.match(expressions[2], /praetorium\.io\/runtime-epoch/u);
  assert.match(expressions[2], /arcadia\.io\/generation/u);
  assert.match(expressions[2], /dyn\(object\)\.spec/u);
  assert.doesNotMatch(expressions[2], /object\.spec/u);
  assert.match(expressions[3], /dyn\(object\)\.type == "Opaque"/u);
  assert.match(expressions[3], /dyn\(object\)\.data\.size\(\) == 2/u);
  assert.match(expressions[3], /dyn\(object\)\.data\.size\(\) == 1/u);
  assert.doesNotMatch(expressions[3], /object\.(?:type|data)/u);
  assert.doesNotMatch(expressions[3], /stringData/u);
  assert.match(expressions[3], /runtime-assignment\.json/u);
  assert.match(expressions[3], /runtime-identity\.jwt/u);
  assert.match(expressions[3], /kubernetes\.io\/dockerconfigjson/u);
  assert.match(expressions[3], /\.dockerconfigjson/u);
  assert.match(expressions[4], /request\.operation != "UPDATE"/u);
  assert.match(expressions[4], /oldObject\.metadata\.labels\["arcadia\.io\/instance-id"\]/u);

  const deleteExpressions = runtimeResourceDeletePolicy.spec.validations.map(
    ({ expression }) => expression,
  );
  assert.match(deleteExpressions[0], /namespaceObject != null/u);
  assert.match(deleteExpressions[0], /@@CLUSTER_ID@@/u);
  assert.match(deleteExpressions[1], /oldObject\.metadata\.labels\["arcadia\.io\/instance-id"\]/u);
  assert.match(
    deleteExpressions[1],
    /oldObject\.metadata\.labels\["praetorium\.io\/repository-id"\]/u,
  );
  for (const [expressionSet, source] of [
    [expressions, "namespaceObject"],
    [deleteExpressions, "namespaceObject"],
  ]) {
    for (const key of [
      "pod-security.kubernetes.io/enforce-version",
      "pod-security.kubernetes.io/audit-version",
      "pod-security.kubernetes.io/warn-version",
    ]) {
      assert.ok(expressionSet[0].includes(`"${key}" in ${source}.metadata.labels`));
      assert.ok(expressionSet[0].includes(`${source}.metadata.labels["${key}"] == "latest"`));
    }
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
  for (const mode of ["enforce", "audit", "warn"]) {
    assert.ok(provider.includes(`"pod-security.kubernetes.io/${mode}": "restricted"`));
  }
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
    ...runtimeResourcePolicy.spec.validations.map(({ expression }) => expression),
    ...runtimeResourceDeletePolicy.spec.validations.map(({ expression }) => expression),
  ].join("\n");
  for (const key of sourceLabelKeys) {
    assert.ok(expressions.includes(key), `admission policies do not cover provider label ${key}`);
  }
});

test("the boundary excludes legacy data operations and unrelated runtime resource policies", () => {
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
    "jobs",
    "pods",
    "PathPrefix",
    "targetport",
    "ipblock",
    "entrypoints",
    "ports:",
  ]) {
    assert.ok(
      !policySources.toLowerCase().includes(forbidden.toLowerCase()),
      `unexpected ${forbidden}`,
    );
  }
  assert.equal(policySources.includes("${CLUSTER_ID}"), false);
});

test("the history seed Secret has a bounded create-once shape with stable ownership", () => {
  const identity = runtimeResourcePolicy.spec.validations[1].expression;
  const secretShape = runtimeResourcePolicy.spec.validations[3].expression;
  const update = runtimeResourcePolicy.spec.validations[4].expression;
  const deleteSecretShape = runtimeResourceDeletePolicy.spec.validations[1].expression;
  const normalizedIdentity = identity.replace(/\s+/gu, " ");
  assert.match(normalizedIdentity, /-history-seed/u);
  assert.match(
    normalizedIdentity,
    /!\("praetorium\.io\/runtime-epoch" in object\.metadata\.labels\)/u,
  );
  assert.match(normalizedIdentity, /!\("arcadia\.io\/generation" in object\.metadata\.labels\)/u);
  assert.match(normalizedIdentity, /!\("arcadia\.io\/release-id" in object\.metadata\.labels\)/u);
  assert.match(secretShape, /-history-seed/u);
  assert.match(secretShape, /history-contract"\] == "v1"/u);
  assert.match(secretShape, /dyn\(object\)\.immutable == true/u);
  assert.match(secretShape, /"snapshot\.json" in dyn\(object\)\.data/u);
  assert.match(secretShape, /snapshot\.json"\]\.size\(\) <= 1000000/u);
  assert.match(update, /oldObject\.metadata\.labels\["arcadia\.io\/ownership-version"\]/u);
  assert.match(update, /oldObject\.metadata\.labels\["arcadia\.io\/runtime-cluster-id"\]/u);
  assert.doesNotMatch(deleteSecretShape, /-history-seed/u);
  assert.equal(
    runtimeResourceDeletePolicy.spec.matchConstraints.resourceRules.some((rule) =>
      rule.resources.includes("persistentvolumeclaims"),
    ),
    false,
  );
});

test("the canonical Kind job runs real server-side history admission scenarios", () => {
  const workflow = readFileSync(
    resolve(repositoryRoot, ".github/workflows/publish-services.yml"),
    "utf8",
  );
  const runner = readFileSync(
    resolve(repositoryRoot, "scripts/ci/verify-history-admission.mjs"),
    "utf8",
  );
  assert.match(
    workflow,
    /node scripts\/ci\/verify-history-admission\.mjs \/tmp\/praetorium-runtime\.json/u,
  );
  assert.match(runner, /kind-praetorium-ci/u);
  assert.match(runner, /--dry-run=server/u);
  for (const expectedPolicy of [
    "praetorium-provisioner-history-pvc",
    "praetorium-provisioner-runtime-resources",
    "praetorium-tenant-pods-restricted",
  ]) {
    assert.ok(runner.includes(expectedPolicy), `Kind scenarios omit ${expectedPolicy}`);
  }
  assert.match(runner, /wrongOwnerPvc/u);
  assert.match(runner, /oversizedPvc/u);
  assert.match(runner, /badSizePatch/u);
  assert.match(runner, /wrongPodClaim/u);
  assert.match(runner, /wrongPodPath/u);
});
