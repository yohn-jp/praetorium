import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const yaml = require(path.join(root, "node_modules/.pnpm/node_modules/js-yaml"));
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

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function documents(relativePath) {
  return yaml.loadAll(read(relativePath));
}

const release = documents("infrastructure/kubernetes/controllers/helm-releases.yaml").find(
  (document) => document?.kind === "HelmRelease" && document.metadata?.name === "traefik",
);

const instanceId = "ins_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const repositoryId = 4815162342;
const digest = `sha256:${"a".repeat(64)}`;
const runtimeSpec = {
  instanceId,
  repositoryId,
  runtimeEpoch: 7,
  generation: 12,
  clusterId: "cluster-a",
  release: {
    releaseId: "revision_A1",
    artifactRef: `ghcr.io/praetorium/scriptorium@${digest}`,
    imageDigest: digest,
    platformManifestDigest: digest,
  },
  resourceProfile: {
    id: "core",
    request: { cpuMilli: 250, memoryMiB: 384, ephemeralStorageMiB: 256 },
  },
  hostname: `${repositoryId}.scriptorium.yohn.jp`,
  runtimeConfig: {},
  application: {
    httpPort: 3847,
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

const renderer = createKubernetesResourceRenderer({
  namespacePrefix: "praetorium-instances",
  clusterId: "cluster-a",
  ingressNamespace: "traefik",
  instanceAccessNamespace: "praetorium-system",
  instanceAccessService: "instance-access",
  controlNamespace: "praetorium-system",
  controlService: "provisioner",
  maximumResources: { cpuMilli: 2000, memoryMiB: 2048, ephemeralStorageMiB: 2048 },
});
const runtimeRoute = renderer.renderEndpoint(runtimeSpec);

test("Traefik CRD provider watches generated instance routes and the system fallback", () => {
  assert.ok(release, "the managed Traefik HelmRelease exists");
  assert.equal(release.spec.chart.spec.version, "41.6.1");
  assert.equal(release.spec.targetNamespace, "traefik");
  assert.equal(release.spec.values.providers.kubernetesIngress.enabled, false);
  assert.deepEqual(release.spec.values.providers.kubernetesCRD, {
    enabled: true,
    allowCrossNamespace: false,
    allowExternalNameServices: false,
    allowEmptyServices: false,
    namespaces: [],
  });
  assert.deepEqual(release.spec.values.rbac, { namespaced: false });

  const runtimeNamespace = `praetorium-instances-${instanceId.slice(4).toLowerCase()}`;
  assert.equal(runtimeRoute.kind, "IngressRoute");
  assert.equal(runtimeRoute.metadata.namespace, runtimeNamespace);
  assert.equal(runtimeRoute.metadata.name, "arcadia-ins-01arz3ndektsv4rrffq69g5fav");
  assert.deepEqual(runtimeRoute.spec.entryPoints, ["websecure"]);
  assert.deepEqual(runtimeRoute.spec.routes, [
    {
      kind: "Rule",
      match: "Host(`" + repositoryId + ".scriptorium.yohn.jp`)",
      priority: 10,
      services: [{ name: runtimeRoute.metadata.name, port: 3847 }],
    },
  ]);
  assert.deepEqual(runtimeRoute.spec.tls, {});
  assert.equal(Object.hasOwn(runtimeRoute.spec.routes[0].services[0], "namespace"), false);
  assert.equal(Object.hasOwn(runtimeRoute.spec.routes[0], "middlewares"), false);

  const fallback = documents("infrastructure/kubernetes/base/stopped-instance-fallback.yaml").find(
    (document) => document?.kind === "IngressRoute",
  );
  assert.ok(fallback, "the static Instance Access fallback exists");
  assert.equal(fallback.metadata.namespace, "praetorium-system");
  assert.deepEqual(fallback.spec.entryPoints, ["websecure"]);
  assert.equal(fallback.spec.routes.length, 2);
  assert.deepEqual(
    fallback.spec.routes.map((route) => route.priority),
    [1000, 1],
  );
  assert.match(fallback.spec.routes[0].match, /PathPrefix\(`\/_platform`\)/u);
  assert.doesNotMatch(fallback.spec.routes[1].match, /PathPrefix\(`\/_platform`\)/u);
  assert.ok(
    fallback.spec.routes[0].priority > runtimeRoute.spec.routes[0].priority &&
      runtimeRoute.spec.routes[0].priority > fallback.spec.routes[1].priority,
    "the reserved platform route wins, then the exact runtime host, then the catch-all",
  );
  assert.deepEqual(
    fallback.spec.routes.map((route) => route.services),
    [[{ name: "instance-access", port: 8080 }], [{ name: "instance-access", port: 8080 }]],
  );
  assert.ok(fallback.spec.routes.every((route) => !Object.hasOwn(route, "middlewares")));
});
