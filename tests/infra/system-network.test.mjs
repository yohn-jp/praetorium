import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

function policyDocument(text, name) {
  const document = text
    .split(/^---\s*$/mu)
    .find((candidate) => new RegExp(`^  name: ${name}$`, "mu").test(candidate));
  assert.ok(document, `missing NetworkPolicy ${name}`);
  assert.match(document, /^apiVersion: networking\.k8s\.io\/v1$/mu);
  assert.match(document, /^kind: NetworkPolicy$/mu);
  assert.match(document, /^  namespace: praetorium-system$/mu);
  assert.match(document, /^  policyTypes:\n    - Ingress\n    - Egress$/mu);
  return document;
}

test("static system policies select actual Praetorium service peers and ports", async () => {
  const [policy, platform, metrics] = await Promise.all([
    read("infrastructure/kubernetes/policies/system-network.yaml"),
    read("infrastructure/kubernetes/base/platform-services.yaml"),
    read("infrastructure/kubernetes/base/metrics.yaml"),
  ]);
  const provisioner = policyDocument(policy, "praetorium-provisioner-network");
  const instanceAccess = policyDocument(policy, "praetorium-instance-access-network");

  assert.match(provisioner, /app\.kubernetes\.io\/name: provisioner/u);
  assert.match(provisioner, /kubernetes\.io\/metadata\.name: praetorium-observability/u);
  assert.match(provisioner, /app\.kubernetes\.io\/name: prometheus/u);
  assert.match(provisioner, /protocol: TCP\n\s+port: 8080/u);
  assert.match(
    platform,
    /name: praetorium-provisioner[\s\S]*?app\.kubernetes\.io\/name: provisioner/u,
  );
  assert.match(
    metrics,
    /targets: \["praetorium-provisioner\.praetorium-system\.svc\.cluster\.local:8080"\]/u,
  );

  assert.match(instanceAccess, /app\.kubernetes\.io\/name: instance-access/u);
  assert.match(instanceAccess, /kubernetes\.io\/metadata\.name: traefik/u);
  assert.match(instanceAccess, /app\.kubernetes\.io\/name: traefik/u);
  assert.match(instanceAccess, /protocol: TCP\n\s+port: 8080/u);
  assert.match(
    platform,
    /name: praetorium-instance-access[\s\S]*?app\.kubernetes\.io\/name: instance-access/u,
  );

  for (const document of [provisioner, instanceAccess]) {
    assert.match(document, /kubernetes\.io\/metadata\.name: kube-system/u);
    assert.match(document, /k8s-app: kube-dns/u);
    assert.match(document, /protocol: UDP\n\s+port: 53/u);
    assert.match(document, /protocol: TCP\n\s+port: 53/u);
  }
});

test("Provisioner reaches only the owned Scriptorium listener for runtime control", async () => {
  const [policy, renderer, provider, labels] = await Promise.all([
    read("infrastructure/kubernetes/policies/system-network.yaml"),
    read("plugins/kubernetes/src/kubernetes/renderer.ts"),
    read("plugins/kubernetes/src/kubernetes/provider.ts"),
    read("plugins/kubernetes/src/labels.ts"),
  ]);
  const provisioner = policyDocument(policy, "praetorium-provisioner-network");

  assert.match(provisioner, /arcadia\.io\/platform: arcadia-platform/u);
  assert.match(provisioner, /app\.kubernetes\.io\/managed-by: arcadia-provisioner/u);
  assert.match(provisioner, /namespaceSelector:[\s\S]*?arcadia\.io\/ownership-version: v1/u);
  assert.match(provisioner, /arcadia\.io\/runtime-cluster-id: "@@CLUSTER_ID@@"/u);
  assert.match(provisioner, /app\.kubernetes\.io\/name: scriptorium/u);
  assert.match(provisioner, /arcadia\.io\/ownership-version: v1/u);
  assert.match(provisioner, /protocol: TCP\n\s+port: http/u);
  assert.doesNotMatch(provisioner, /3847/u);

  assert.match(renderer, /port: app\.httpPort/u);
  assert.match(renderer, /name: "http", containerPort: app\.httpPort/u);
  assert.match(renderer, /const APPLICATION_LABEL_KEY = "app\.kubernetes\.io\/name"/u);
  assert.match(renderer, /const APPLICATION_LABEL_VALUE = "scriptorium"/u);
  assert.match(renderer, /\[APPLICATION_LABEL_KEY\]: APPLICATION_LABEL_VALUE/u);
  assert.match(
    provider,
    /return `http:\/\/\$\{serviceName\}\.\$\{namespaceName\}\.svc\.cluster\.local:\$\{httpPort\}`/u,
  );
  assert.match(labels, /MANAGED_BY_LABEL_VALUE = "arcadia-provisioner"/u);

  assert.match(policy, /^    # @@PROVISIONER_API_EGRESS_RULES@@$/mu);
  assert.match(policy, /^    # @@PROVISIONER_PRIVATE_CONTROL_PLANE_EGRESS_RULES@@$/mu);
});

test("Instance Access has Gateway egress and no tenant-runtime egress", async () => {
  const [policy, handler, platform] = await Promise.all([
    read("infrastructure/kubernetes/policies/system-network.yaml"),
    read("apps/instance-access/src/handler.ts"),
    read("infrastructure/kubernetes/base/platform-services.yaml"),
  ]);
  const instanceAccess = policyDocument(policy, "praetorium-instance-access-network");

  assert.doesNotMatch(instanceAccess, /scriptorium|arcadia\.io\/runtime-cluster-id/u);
  assert.match(instanceAccess, /^    # @@INSTANCE_ACCESS_PRIVATE_GATEWAY_EGRESS_RULES@@$/mu);
  assert.match(handler, /new URL\(path, config\.gatewayUrl\)/u);
  assert.match(handler, /\/internal\/instance-access\/(handoff|refresh|revoke)/u);
  assert.match(
    handler,
    /new URL\(`\/entry\/\$\{encodeURIComponent\(instance\.id\)\}`, config\.gatewayOrigin\)/u,
  );
  assert.match(
    platform,
    /GATEWAY_ORIGIN: "@@GATEWAY_ORIGIN@@"[\s\S]*?GATEWAY_URL: "@@GATEWAY_SERVICE_URL@@"/u,
  );
});

test("public HTTPS egress retains reserved and metadata IP exclusions", async () => {
  const policy = await read("infrastructure/kubernetes/policies/system-network.yaml");
  const exceptions = [
    "10.0.0.0/8",
    "100.64.0.0/10",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "172.16.0.0/12",
    "192.0.0.0/24",
    "192.168.0.0/16",
    "198.18.0.0/15",
    "168.63.129.16/32",
    "224.0.0.0/4",
    "240.0.0.0/4",
    "::/128",
    "::1/128",
    "::ffff:0:0/96",
    "2001:db8::/32",
    "fc00::/7",
    "fe80::/10",
    "ff00::/8",
  ];
  const publicHttpsRules = policy.matchAll(
    /    - to:\n        - ipBlock:\n            cidr: 0\.0\.0\.0\/0[\s\S]*?      ports:\n        - protocol: TCP\n          port: 443/gmu,
  );
  const rules = [...publicHttpsRules].map(([rule]) => rule);
  assert.equal(rules.length, 2, "both static system policies require one public HTTPS rule");
  for (const rule of rules) {
    for (const cidr of exceptions) {
      assert.match(rule, new RegExp(`- ${cidr.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "mu"));
    }
    assert.match(rule, /port: 443$/mu);
  }
});
