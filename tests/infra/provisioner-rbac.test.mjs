import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const policyPath = resolve(
  repositoryRoot,
  "infrastructure/kubernetes/policies/provisioner-rbac.yaml",
);
const policyText = readFileSync(policyPath, "utf8");

function yamlArray(value) {
  assert.match(value, /^\[[^\]]*\]$/u, `expected inline YAML array, got ${value}`);
  const contents = value.slice(1, -1).trim();
  if (contents.length === 0) return [];
  return contents.split(",").map((item) => item.trim().replace(/^['"]|['"]$/gu, ""));
}

function parseDocuments(text) {
  return text
    .split(/^---\s*$/mu)
    .map((source) => source.trim())
    .filter(Boolean)
    .map((source) => {
      const lines = source.split(/\r?\n/u);
      const scalar = (pattern, description) => {
        const match = lines.find((line) => pattern.test(line));
        assert.ok(match, `missing ${description}`);
        return pattern.exec(match)[1];
      };
      const rulesIndex = lines.indexOf("rules:");
      const rules = [];
      if (rulesIndex !== -1) {
        for (const line of lines.slice(rulesIndex + 1)) {
          const ruleStart = /^  - ([A-Za-z]+): (.+)$/u.exec(line);
          if (ruleStart !== null) {
            rules.push({ [ruleStart[1]]: yamlArray(ruleStart[2]) });
            continue;
          }
          const field = /^    ([A-Za-z]+): (.+)$/u.exec(line);
          if (field !== null) {
            assert.ok(rules.length > 0, "rule field preceded its rule");
            rules.at(-1)[field[1]] = yamlArray(field[2]);
          }
        }
      }
      const metadataIndex = lines.indexOf("metadata:");
      let name;
      let namespace;
      for (const line of lines.slice(metadataIndex + 1)) {
        if (!line.startsWith("  ")) break;
        const nameMatch = /^  name: (.+)$/u.exec(line);
        if (nameMatch !== null && name === undefined) name = nameMatch[1];
        const namespaceMatch = /^  namespace: (.+)$/u.exec(line);
        if (namespaceMatch !== null && namespace === undefined) namespace = namespaceMatch[1];
      }
      return {
        apiVersion: scalar(/^apiVersion: (.+)$/u, "apiVersion"),
        kind: scalar(/^kind: (.+)$/u, "kind"),
        name,
        namespace,
        rules,
        source,
      };
    });
}

const documents = parseDocuments(policyText);
const bootstrap = documents.find(
  (document) =>
    document.kind === "ClusterRole" && document.name === "praetorium-provisioner-bootstrap",
);
const tenant = documents.find(
  (document) =>
    document.kind === "ClusterRole" && document.name === "praetorium-provisioner-tenant-runtime",
);
const binding = documents.find(
  (document) =>
    document.kind === "ClusterRoleBinding" && document.name === "praetorium-provisioner-bootstrap",
);

function allows(document, apiGroup, resource, verb, resourceName) {
  return document.rules.some((rule) => {
    const groups = rule.apiGroups ?? [];
    const resources = rule.resources ?? [];
    const verbs = rule.verbs ?? [];
    if (!groups.includes("*") && !groups.includes(apiGroup)) return false;
    if (!resources.includes("*") && !resources.includes(resource)) return false;
    if (!verbs.includes("*") && !verbs.includes(verb)) return false;
    if (rule.resourceNames !== undefined) {
      return resourceName !== undefined && rule.resourceNames.includes(resourceName);
    }
    return true;
  });
}

function permissionSet(document) {
  return document.rules.flatMap((rule) =>
    rule.apiGroups.flatMap((apiGroup) =>
      rule.resources.flatMap((resource) =>
        rule.verbs.map((verb) => `${apiGroup}/${resource}:${verb}`),
      ),
    ),
  );
}

test("bootstrap binding uses the provisioner service account and fixed role", () => {
  assert.equal(documents.length, 3);
  assert.equal(bootstrap?.apiVersion, "rbac.authorization.k8s.io/v1");
  assert.equal(tenant?.apiVersion, "rbac.authorization.k8s.io/v1");
  assert.equal(binding?.apiVersion, "rbac.authorization.k8s.io/v1");
  assert.match(
    binding.source,
    /roleRef:\n  apiGroup: rbac\.authorization\.k8s\.io\n  kind: ClusterRole\n  name: praetorium-provisioner-bootstrap\nsubjects:\n  - kind: ServiceAccount\n    name: praetorium-provisioner\n    namespace: praetorium-system/u,
  );

  const platformManifest = readFileSync(
    resolve(repositoryRoot, "infrastructure/kubernetes/base/platform-services.yaml"),
    "utf8",
  );
  assert.match(
    platformManifest,
    /kind: ServiceAccount\nmetadata:\n  name: praetorium-provisioner\n  namespace: praetorium-system/u,
  );
  assert.match(
    platformManifest,
    /kind: Deployment\nmetadata:\n  name: praetorium-provisioner\n[\s\S]*?serviceAccountName: praetorium-provisioner/u,
  );

  const provider = readFileSync(
    resolve(repositoryRoot, "plugins/kubernetes/src/kubernetes/provider.ts"),
    "utf8",
  );
  assert.match(provider, /const PROVISIONER_NAMESPACE = "praetorium-system";/u);
  assert.match(provider, /const PROVISIONER_SERVICE_ACCOUNT = "praetorium-provisioner";/u);
  assert.match(
    provider,
    /const PROVISIONER_TENANT_ROLE = "praetorium-provisioner-tenant-runtime";/u,
  );
  assert.match(provider, /const name = "praetorium-provisioner-runtime";/u);
});

test("bootstrap grants only the provider's required cluster observation and fixed binding rights", () => {
  assert.ok(bootstrap);

  for (const [group, resource, verb] of [
    ["", "namespaces", "get"],
    ["", "namespaces", "create"],
    ["", "nodes", "list"],
    ["", "pods", "list"],
    ["apps", "deployments", "get"],
    ["apps", "deployments", "list"],
    ["", "services", "get"],
    ["", "serviceaccounts", "get"],
    ["", "limitranges", "get"],
    ["", "resourcequotas", "get"],
    ["networking.k8s.io", "networkpolicies", "get"],
    ["traefik.io", "ingressroutes", "get"],
    ["rbac.authorization.k8s.io", "rolebindings", "create"],
  ]) {
    assert.ok(allows(bootstrap, group, resource, verb), `missing ${group}/${resource}:${verb}`);
  }
  for (const verb of ["get", "patch", "delete"]) {
    assert.ok(
      allows(
        bootstrap,
        "rbac.authorization.k8s.io",
        "rolebindings",
        verb,
        "praetorium-provisioner-runtime",
      ),
      `missing named RoleBinding ${verb}`,
    );
    assert.ok(
      !allows(bootstrap, "rbac.authorization.k8s.io", "rolebindings", verb, "unrelated-binding"),
      `unexpected ${verb} for unrelated RoleBinding`,
    );
  }
  assert.ok(
    allows(
      bootstrap,
      "rbac.authorization.k8s.io",
      "clusterroles",
      "bind",
      "praetorium-provisioner-tenant-runtime",
    ),
  );
  assert.ok(
    !allows(bootstrap, "rbac.authorization.k8s.io", "clusterroles", "bind", "cluster-admin"),
  );

  for (const [group, resource, verb] of [
    ["", "namespaces", "delete"],
    ["", "nodes", "patch"],
    ["", "pods", "create"],
    ["apps", "deployments", "patch"],
    ["networking.k8s.io", "networkpolicies", "delete"],
    ["", "secrets", "get"],
    ["", "configmaps", "get"],
    ["", "persistentvolumeclaims", "delete"],
    ["batch", "jobs", "create"],
  ]) {
    assert.ok(!allows(bootstrap, group, resource, verb), `unexpected ${group}/${resource}:${verb}`);
  }
  assert.deepEqual(
    permissionSet(bootstrap).sort(),
    [
      "apps/deployments:get",
      "apps/deployments:list",
      "networking.k8s.io/networkpolicies:get",
      "rbac.authorization.k8s.io/clusterroles:bind",
      "rbac.authorization.k8s.io/rolebindings:create",
      "rbac.authorization.k8s.io/rolebindings:delete",
      "rbac.authorization.k8s.io/rolebindings:get",
      "rbac.authorization.k8s.io/rolebindings:patch",
      "traefik.io/ingressroutes:get",
      "/limitranges:get",
      "/namespaces:create",
      "/namespaces:get",
      "/nodes:list",
      "/pods:list",
      "/resourcequotas:get",
      "/serviceaccounts:get",
      "/services:get",
    ].sort(),
  );
  assert.ok(
    bootstrap.rules.every(
      (rule) =>
        !rule.apiGroups.includes("*") && !rule.resources.includes("*") && !rule.verbs.includes("*"),
    ),
  );
});

test("tenant Role grants per-instance runtime resource operations and no data or pod writes", () => {
  assert.ok(tenant);
  const runtimeResources = [
    ["", "limitranges"],
    ["", "resourcequotas"],
    ["", "serviceaccounts"],
    ["", "services"],
    ["apps", "deployments"],
    ["networking.k8s.io", "networkpolicies"],
    ["traefik.io", "ingressroutes"],
  ];
  for (const [group, resource] of runtimeResources) {
    for (const verb of ["get", "create", "patch", "delete"]) {
      assert.ok(allows(tenant, group, resource, verb), `missing ${group}/${resource}:${verb}`);
    }
  }
  assert.ok(allows(tenant, "", "pods", "list"));
  assert.ok(!allows(tenant, "", "pods", "get"));
  for (const [group, resource, verb] of [
    ["", "pods", "create"],
    ["", "pods", "patch"],
    ["", "pods", "delete"],
    ["", "secrets", "get"],
    ["", "configmaps", "get"],
    ["", "persistentvolumeclaims", "delete"],
    ["batch", "jobs", "create"],
    ["", "namespaces", "delete"],
    ["rbac.authorization.k8s.io", "rolebindings", "create"],
  ]) {
    assert.ok(!allows(tenant, group, resource, verb), `unexpected ${group}/${resource}:${verb}`);
  }
  assert.deepEqual(
    permissionSet(tenant).sort(),
    [
      "apps/deployments:delete",
      "apps/deployments:get",
      "apps/deployments:create",
      "apps/deployments:patch",
      "networking.k8s.io/networkpolicies:delete",
      "networking.k8s.io/networkpolicies:get",
      "networking.k8s.io/networkpolicies:create",
      "networking.k8s.io/networkpolicies:patch",
      "traefik.io/ingressroutes:delete",
      "traefik.io/ingressroutes:get",
      "traefik.io/ingressroutes:create",
      "traefik.io/ingressroutes:patch",
      "/limitranges:create",
      "/limitranges:delete",
      "/limitranges:get",
      "/limitranges:patch",
      "/pods:list",
      "/resourcequotas:create",
      "/resourcequotas:delete",
      "/resourcequotas:get",
      "/resourcequotas:patch",
      "/serviceaccounts:create",
      "/serviceaccounts:delete",
      "/serviceaccounts:get",
      "/serviceaccounts:patch",
      "/services:create",
      "/services:delete",
      "/services:get",
      "/services:patch",
    ].sort(),
  );
});

test("provider verbs and API paths remain covered by the RBAC graph", () => {
  const provider = readFileSync(
    resolve(repositoryRoot, "plugins/kubernetes/src/kubernetes/provider.ts"),
    "utf8",
  );
  const capacity = readFileSync(
    resolve(repositoryRoot, "plugins/kubernetes/src/kubernetes/capacity.ts"),
    "utf8",
  );
  const renderer = readFileSync(
    resolve(repositoryRoot, "plugins/kubernetes/src/kubernetes/renderer.ts"),
    "utf8",
  );
  const client = readFileSync(
    resolve(repositoryRoot, "plugins/kubernetes/src/kubernetes/client.ts"),
    "utf8",
  );

  assert.match(capacity, /api\.list\(kind, "", "", cursor, signal\)/u);
  assert.match(capacity, /kind: "Node" \| "Pod"/u);
  assert.match(provider, /\.list\(\n\s*"Deployment",\n\s*"",/u);
  assert.match(provider, /listAllPods\(this\.options\.api, namespaceName, signal\)/u);
  assert.match(provider, /this\.options\.api\.createNamespace\(namespace, signal\)/u);
  assert.match(provider, /this\.options\.api\.create\(binding, signal\)/u);
  assert.match(provider, /this\.options\.api\s*\.applyConditional\(\s*binding/u);
  assert.match(provider, /this\.options\.api\s*\.deleteConditional\(reference/u);
  const namespaceBootstrap = provider.slice(
    provider.indexOf("private async ensureNamespace"),
    provider.indexOf("private async ensureRuntimeRoleBinding"),
  );
  assert.match(namespaceBootstrap, /getNamespaceOptional/u);
  assert.match(namespaceBootstrap, /createNamespace/u);
  assert.doesNotMatch(namespaceBootstrap, /applyNamespaceConditional|deleteNamespaceConditional/u);
  const emittedKinds = [...renderer.matchAll(/kind: "([A-Z][A-Za-z]+)"/gu)]
    .map((match) => match[1])
    .filter((kind) => kind !== "Rule")
    .filter((kind, index, kinds) => kinds.indexOf(kind) === index)
    .sort();
  assert.deepEqual(
    emittedKinds,
    [
      "Deployment",
      "IngressRoute",
      "LimitRange",
      "NetworkPolicy",
      "ResourceQuota",
      "Service",
      "ServiceAccount",
    ].sort(),
  );
  assert.match(client, /async get\([\s\S]*?method: "GET"/u);
  assert.match(client, /async list\([\s\S]*?method: "GET"/u);
  assert.match(client, /async create\([\s\S]*?method: "POST"/u);
  assert.match(client, /async applyConditional\([\s\S]*?method: "PATCH"/u);
  assert.match(client, /async deleteConditional\([\s\S]*?method: "DELETE"/u);
  assert.match(client, /async createNamespace\([\s\S]*?method: "POST"/u);

  assert.ok(allows(bootstrap, "", "nodes", "list"));
  assert.ok(allows(bootstrap, "", "pods", "list"));
  assert.ok(allows(bootstrap, "apps", "deployments", "list"));
  assert.ok(allows(tenant, "", "pods", "list"));
});
