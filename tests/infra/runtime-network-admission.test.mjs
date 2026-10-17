import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Exercise the committed renderer source; a leftover dist must not supply evidence.
const compiledRenderer = await build({
  entryPoints: [
    fileURLToPath(new URL("../../plugins/kubernetes/src/kubernetes/renderer.ts", import.meta.url)),
  ],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  target: "node24",
});
const { createKubernetesResourceRenderer } = await import(
  `data:text/javascript;base64,${Buffer.from(compiledRenderer.outputFiles[0].contents).toString("base64")}`
);

const clusterId = "cluster-a";
const hostSuffix = "instances.example.test";
const instanceId = "ins_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const repositoryId = 4815162342;
const releaseId = "revision_A1";
const listenerPort = 3847;
const writer = "system:serviceaccount:praetorium-system:praetorium-provisioner";

const renderer = createKubernetesResourceRenderer({
  namespacePrefix: "praetorium-instances",
  clusterId,
  ingressNamespace: "traefik",
  instanceAccessNamespace: "praetorium-system",
  instanceAccessService: "instance-access",
  controlNamespace: "praetorium-system",
  controlService: "provisioner",
  maximumResources: { cpuMilli: 2000, memoryMiB: 2048, ephemeralStorageMiB: 2048 },
});

const digest = `sha256:${"a".repeat(64)}`;
const spec = {
  instanceId,
  repositoryId,
  runtimeEpoch: 7,
  generation: 12,
  clusterId,
  release: {
    releaseId,
    artifactRef: `ghcr.io/praetorium/scriptorium@${digest}`,
    imageDigest: digest,
    platformManifestDigest: digest,
  },
  resourceProfile: {
    id: "core",
    request: { cpuMilli: 250, memoryMiB: 384, ephemeralStorageMiB: 256 },
  },
  hostname: `ins-${instanceId.slice(4).toLowerCase()}.${hostSuffix}`,
  runtimeConfig: {},
  application: {
    httpPort: listenerPort,
    livenessPath: "/health/live",
    readinessPath: "/health/ready",
    metadataPath: "/metadata",
    shutdownPath: "/api/platform/v1/shutdown",
    shutdownTimeoutSeconds: 30,
    platformControlPaths: {
      status: "/api/platform/v1/status",
      quiesce: "/api/platform/v1/quiesce",
      resume: "/api/platform/v1/resume",
    },
  },
};

const resources = renderer.renderRunning(spec);
const networkPolicy = resources.find((resource) => resource.kind === "NetworkPolicy");
const stoppedNetworkPolicy = renderer
  .renderStopped({ ...spec, release: null })
  .find((resource) => resource.kind === "NetworkPolicy");
const ingressRoute = renderer.renderEndpoint(spec);
assert.ok(networkPolicy, "the production renderer must emit a tenant NetworkPolicy");
assert.ok(stoppedNetworkPolicy, "the production renderer must emit a stopped tenant NetworkPolicy");

const namespaceName = networkPolicy.metadata.namespace;
const namespaceObject = {
  apiVersion: "v1",
  kind: "Namespace",
  metadata: {
    name: namespaceName,
    labels: {
      "arcadia.io/platform": "arcadia-platform",
      "app.kubernetes.io/managed-by": "arcadia-provisioner",
      "arcadia.io/instance-id": instanceId,
      "praetorium.io/repository-id": String(repositoryId),
      "arcadia.io/ownership-version": "v1",
      "arcadia.io/runtime-cluster-id": clusterId,
      "kubernetes.io/metadata.name": namespaceName,
    },
  },
};

function scenario(name, allow, object) {
  return {
    name,
    allow,
    object,
    oldObject: null,
    namespaceObject: structuredClone(namespaceObject),
    request: { userInfo: { username: writer } },
    params: null,
  };
}

function rejected(name, object, mutate) {
  const changed = structuredClone(object);
  mutate(changed);
  return scenario(name, false, changed);
}

const networkPolicyScenarios = [
  scenario("actual-renderer-output", true, structuredClone(networkPolicy)),
  scenario("actual-stopped-renderer-output", true, structuredClone(stoppedNetworkPolicy)),
  (() => {
    const object = structuredClone(networkPolicy);
    for (const rule of object.spec.ingress) rule.ports[0].port = 1;
    return scenario("minimum-listener-port", true, object);
  })(),
  (() => {
    const object = structuredClone(networkPolicy);
    for (const rule of object.spec.ingress) rule.ports[0].port = 65535;
    return scenario("maximum-listener-port", true, object);
  })(),
  rejected("extra-ingress-rule", networkPolicy, (object) =>
    object.spec.ingress.push(structuredClone(object.spec.ingress[0])),
  ),
  rejected("extra-ingress-port", networkPolicy, (object) =>
    object.spec.ingress[0].ports.push({ protocol: "TCP", port: 8080 }),
  ),
  rejected("extra-ingress-peer", networkPolicy, (object) =>
    object.spec.ingress[0].from.push(structuredClone(object.spec.ingress[0].from[0])),
  ),
  rejected("selector-expression", networkPolicy, (object) => {
    object.spec.podSelector.matchExpressions = [
      { key: "arcadia.io/instance-id", operator: "Exists" },
    ];
  }),
  rejected("ingress-namespace-selector-expression", networkPolicy, (object) => {
    object.spec.ingress[0].from[0].namespaceSelector.matchExpressions = [
      { key: "kubernetes.io/metadata.name", operator: "Exists" },
    ];
  }),
  rejected("extra-resource-label", networkPolicy, (object) => {
    object.metadata.labels["attacker.example/extra"] = "true";
  }),
  rejected("wrong-app-label-on-stopped-policy", stoppedNetworkPolicy, (object) => {
    object.metadata.labels["app.kubernetes.io/name"] = "attacker";
  }),
  rejected("nonpositive-runtime-epoch", networkPolicy, (object) => {
    object.metadata.labels["praetorium.io/runtime-epoch"] = "0";
  }),
  rejected("listener-port-out-of-range", networkPolicy, (object) => {
    object.spec.ingress[1].ports[0].port = 65536;
  }),
  rejected("listener-port-mismatch", networkPolicy, (object) => {
    object.spec.ingress[2].ports[0].port = listenerPort + 1;
  }),
  rejected("private-egress-exception-removed", networkPolicy, (object) => {
    object.spec.egress[1].to[0].ipBlock.except = object.spec.egress[1].to[0].ipBlock.except.filter(
      (cidr) => cidr !== "168.63.129.16/32",
    );
  }),
  rejected("ipv4-multicast-egress-enabled", networkPolicy, (object) => {
    object.spec.egress[1].to[0].ipBlock.except = object.spec.egress[1].to[0].ipBlock.except.filter(
      (cidr) => cidr !== "224.0.0.0/4",
    );
  }),
  rejected("ipv4-reserved-egress-enabled", networkPolicy, (object) => {
    object.spec.egress[1].to[0].ipBlock.except = object.spec.egress[1].to[0].ipBlock.except.filter(
      (cidr) => cidr !== "240.0.0.0/4",
    );
  }),
  rejected("ipv4-compatible-ipv6-egress-enabled", networkPolicy, (object) => {
    object.spec.egress[1].to[1].ipBlock.except = object.spec.egress[1].to[1].ipBlock.except.filter(
      (cidr) => cidr !== "::/96",
    );
  }),
  rejected("ipv4-mapped-ipv6-egress-enabled", networkPolicy, (object) => {
    object.spec.egress[1].to[1].ipBlock.except = object.spec.egress[1].to[1].ipBlock.except.filter(
      (cidr) => cidr !== "::ffff:0:0/96",
    );
  }),
  rejected("site-local-ipv6-egress-enabled", networkPolicy, (object) => {
    object.spec.egress[1].to[1].ipBlock.except = object.spec.egress[1].to[1].ipBlock.except.filter(
      (cidr) => cidr !== "fec0::/10",
    );
  }),
  rejected("documentation-ipv6-egress-enabled", networkPolicy, (object) => {
    object.spec.egress[1].to[1].ipBlock.except = object.spec.egress[1].to[1].ipBlock.except.filter(
      (cidr) => cidr !== "2001:db8::/32",
    );
  }),
  rejected("multicast-ipv6-egress-enabled", networkPolicy, (object) => {
    object.spec.egress[1].to[1].ipBlock.except = object.spec.egress[1].to[1].ipBlock.except.filter(
      (cidr) => cidr !== "ff00::/8",
    );
  }),
  rejected("private-egress-peer-added", networkPolicy, (object) => {
    object.spec.egress[1].to.push({ ipBlock: { cidr: "10.0.0.0/8" } });
  }),
  rejected("private-egress-port-added", networkPolicy, (object) => {
    object.spec.egress[1].ports.push({ protocol: "TCP", port: 22 });
  }),
  rejected("wrong-control-peer", networkPolicy, (object) => {
    object.spec.ingress[2].from[0].podSelector.matchLabels["app.kubernetes.io/name"] =
      "instance-access";
  }),
  rejected("foreign-repository-label", networkPolicy, (object) => {
    object.metadata.labels["praetorium.io/repository-id"] = "99";
  }),
  rejected("foreign-cluster-label", networkPolicy, (object) => {
    object.metadata.labels["arcadia.io/runtime-cluster-id"] = "other-cluster";
  }),
  rejected("wrong-instance-namespace-label", networkPolicy, (object) => {
    object.metadata.labels["arcadia.io/instance-id"] = "ins_01ARZ3NDEKTSV4RRFFQ69G5FAW";
  }),
  rejected("foreign-namespace", networkPolicy, (object) => {
    object.metadata.namespace = "praetorium-system";
  }),
  (() => {
    const testCase = scenario(
      "namespace-repository-mismatch",
      false,
      structuredClone(networkPolicy),
    );
    testCase.namespaceObject.metadata.labels["praetorium.io/repository-id"] = "99";
    return testCase;
  })(),
];

const routeScenarios = [
  scenario("actual-renderer-output", true, structuredClone(ingressRoute)),
  rejected("ties-static-fallback-priority", ingressRoute, (object) => {
    object.spec.routes[0].priority = 1;
  }),
  rejected("claims-reserved-platform-priority", ingressRoute, (object) => {
    object.spec.routes[0].priority = 1000;
  }),
  (() => {
    const object = structuredClone(ingressRoute);
    object.spec.routes[0].services[0].port = 1;
    return scenario("minimum-listener-port", true, object);
  })(),
  (() => {
    const object = structuredClone(ingressRoute);
    object.spec.routes[0].services[0].port = 65535;
    return scenario("maximum-listener-port", true, object);
  })(),
  rejected("extra-route", ingressRoute, (object) =>
    object.spec.routes.push(structuredClone(object.spec.routes[0])),
  ),
  rejected("foreign-host", ingressRoute, (object) => {
    object.spec.routes[0].match = "Host(`other.instances.example.test`)";
  }),
  rejected("cross-namespace-service", ingressRoute, (object) => {
    object.spec.routes[0].services[0].namespace = "praetorium-system";
  }),
  rejected("extra-service-field", ingressRoute, (object) => {
    object.spec.routes[0].services[0].scheme = "http";
  }),
  rejected("middleware-route", ingressRoute, (object) => {
    object.spec.routes[0].middlewares = [{ name: "arbitrary", namespace: "praetorium-system" }];
  }),
  rejected("tls-secret-override", ingressRoute, (object) => {
    object.spec.tls.secretName = "foreign-secret";
  }),
  rejected("wrong-runtime-service-name", ingressRoute, (object) => {
    object.spec.routes[0].services[0].name = "instance-access";
  }),
  rejected("foreign-release-label", ingressRoute, (object) => {
    object.metadata.labels["arcadia.io/release-id"] = "none";
  }),
  rejected("extra-resource-label", ingressRoute, (object) => {
    object.metadata.labels["attacker.example/extra"] = "true";
  }),
  rejected("foreign-repository-label", ingressRoute, (object) => {
    object.metadata.labels["praetorium.io/repository-id"] = "99";
  }),
  rejected("foreign-namespace", ingressRoute, (object) => {
    object.metadata.namespace = "praetorium-system";
  }),
];

test("target admission covers the actual renderer's tenant policy and endpoint shapes", () => {
  assert.equal(networkPolicy.apiVersion, "networking.k8s.io/v1");
  assert.equal(ingressRoute.apiVersion, "traefik.io/v1alpha1");
  assert.equal(networkPolicy.metadata.name, "arcadia-ins-01arz3ndektsv4rrffq69g5fav-network");
  assert.equal(ingressRoute.metadata.name, "arcadia-ins-01arz3ndektsv4rrffq69g5fav");
  assert.equal(namespaceName, "praetorium-instances-01arz3ndektsv4rrffq69g5fav");
  assert.deepEqual(
    networkPolicy.spec.ingress.map(
      (rule) => rule.from[0].namespaceSelector.matchLabels["kubernetes.io/metadata.name"],
    ),
    ["traefik", "praetorium-system", "praetorium-system"],
  );
  assert.deepEqual(
    networkPolicy.spec.ingress.map(
      (rule) => rule.from[0].podSelector.matchLabels["app.kubernetes.io/name"],
    ),
    ["traefik", "instance-access", "provisioner"],
  );
  assert.deepEqual(
    networkPolicy.spec.ingress.map((rule) => rule.ports[0].port),
    [listenerPort, listenerPort, listenerPort],
  );
  assert.deepEqual(networkPolicy.spec.egress[1].to[0].ipBlock.except, [
    "10.0.0.0/8",
    "100.64.0.0/10",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "172.16.0.0/12",
    "192.0.0.0/24",
    "192.168.0.0/16",
    "168.63.129.16/32",
    "198.18.0.0/15",
    "224.0.0.0/4",
    "240.0.0.0/4",
  ]);
  assert.deepEqual(networkPolicy.spec.egress[1].to[1].ipBlock.except, [
    "::/128",
    "::1/128",
    "::/96",
    "::ffff:0:0/96",
    "2001:db8::/32",
    "fc00::/7",
    "fec0::/10",
    "fe80::/10",
    "ff00::/8",
  ]);
  assert.deepEqual(ingressRoute.spec.routes[0].services, [
    { name: ingressRoute.metadata.name, port: listenerPort },
  ]);
  assert.equal(ingressRoute.spec.routes[0].priority, 10);
  assert.deepEqual(Object.keys(ingressRoute.spec.routes[0].services[0]).sort(), ["name", "port"]);
  assert.equal(
    ingressRoute.spec.routes[0].match,
    "Host(`ins-" + instanceId.slice(4).toLowerCase() + "." + hostSuffix + "`)",
  );
});

test("CEL review scenarios include actual positive objects and admission-shape regressions", () => {
  assert.ok(networkPolicyScenarios.filter((testCase) => !testCase.allow).length >= 10);
  assert.ok(routeScenarios.filter((testCase) => !testCase.allow).length >= 8);
  assert.equal(
    networkPolicyScenarios[0].object.metadata.labels["praetorium.io/repository-id"],
    String(repositoryId),
  );
  assert.equal(
    networkPolicyScenarios.at(-1).namespaceObject.metadata.labels["praetorium.io/repository-id"],
    "99",
  );

  const networkManifest = readFileSync(
    "infrastructure/kubernetes/policies/provisioner-networkpolicy.yaml",
    "utf8",
  );
  const routeManifest = readFileSync(
    "infrastructure/kubernetes/policies/provisioner-ingressroute.yaml",
    "utf8",
  );
  for (const source of [networkManifest, routeManifest]) {
    assert.ok(source.includes("system:serviceaccount:praetorium-system:praetorium-provisioner"));
    assert.ok(source.includes("@@CLUSTER_ID@@"));
    assert.ok(source.includes("praetorium-instances-"));
    assert.ok(source.includes("failurePolicy: Fail"));
    assert.ok(source.includes("validationActions: [Deny]"));
    assert.ok(
      !source.includes("arcadia-loom"),
      "the historical Arcadia source selector must not bypass target checks",
    );
  }
  assert.ok(routeManifest.includes("@@INSTANCE_HOSTNAME_SUFFIX@@"));

  const scenarioPath = process.env.PRAETORIUM_CEL_SCENARIOS;
  if (scenarioPath) {
    writeFileSync(
      scenarioPath,
      JSON.stringify({
        "praetorium-provisioner-tenant-networkpolicy": networkPolicyScenarios,
        "praetorium-provisioner-tenant-ingressroute": routeScenarios,
      }),
    );
  }
});
