#!/usr/bin/env node
// Exercises retained-history admission against the disposable Kind API server.
// The only persisted test objects live in the CI-only praetorium-ci cluster.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(resolve(root, "package.json"));
const yaml = require(resolve(root, "node_modules/.pnpm/node_modules/js-yaml"));
const [runtimePath] = process.argv.slice(2);
const clusterId = "ci-owned-cluster";
const provisioner = "system:serviceaccount:praetorium-system:praetorium-provisioner";

if (!runtimePath) throw new Error("usage: verify-history-admission.mjs RUNTIME_RENDER.json");

function kubectl(args, { input, expectedPolicy, expectedError } = {}) {
  const result = spawnSync("kubectl", args, {
    cwd: root,
    encoding: "utf8",
    input,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw new Error(`kubectl failed to start (${result.error.code ?? "unknown"})`);
  if (expectedPolicy) {
    assert.notEqual(result.status, 0, `expected admission rejection by ${expectedPolicy}`);
    assert.ok(
      result.stderr.includes(expectedPolicy),
      `request failed without the expected admission policy ${expectedPolicy}`,
    );
    return;
  }
  if (expectedError) {
    assert.notEqual(result.status, 0, `expected rejection containing ${expectedError}`);
    assert.ok(
      result.stderr.includes(expectedError),
      `request failed without the expected rejection ${expectedError}`,
    );
    return;
  }
  if (result.status !== 0) {
    throw new Error(`kubectl ${args[0]} failed (${result.status ?? "signal"})`);
  }
  return result.stdout;
}

function loadYaml(path) {
  return yaml.loadAll(readFileSync(resolve(root, path), "utf8"));
}

function applyObjects(objects) {
  kubectl(["apply", "-f", "-"], {
    input: JSON.stringify({ apiVersion: "v1", kind: "List", items: objects }),
  });
}

function createObject(
  object,
  { dryRun = false, asProvisioner = false, expectedPolicy, expectedError } = {},
) {
  const args = [];
  if (asProvisioner) args.push(`--as=${provisioner}`);
  args.push(
    "create",
    ...(dryRun ? ["--dry-run=server"] : []),
    "--validate=strict",
    "-f",
    "-",
    "-o",
    "name",
  );
  return kubectl(args, { input: JSON.stringify(object), expectedPolicy, expectedError });
}

function admissionPod(deployment) {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      ...deployment.spec.template.metadata,
      name: "history-admission-positive",
      namespace: deployment.metadata.namespace,
    },
    spec: deployment.spec.template.spec,
  };
}

function expectPodDenied(pod, policy = "praetorium-tenant-pods-restricted") {
  createObject(pod, { dryRun: true, expectedPolicy: policy });
}

const context = kubectl(["config", "current-context"]).trim();
assert.equal(context, "kind-praetorium-ci", "refusing to run outside the CI-owned Kind cluster");

const runtime = JSON.parse(readFileSync(resolve(runtimePath), "utf8"));
const rendered = runtime.kind === "List" ? runtime.items : [];
const deployment = rendered.find((item) => item.kind === "Deployment");
const pvc = rendered.find((item) => item.kind === "PersistentVolumeClaim");
const quota = rendered.find((item) => item.kind === "ResourceQuota");
assert.ok(deployment, "runtime renderer did not emit a Deployment");
assert.ok(pvc, "runtime renderer did not emit the stable history PVC");
assert.ok(quota, "runtime renderer did not emit a ResourceQuota");

const instanceId = deployment.spec.template.metadata.labels["arcadia.io/instance-id"];
const repositoryId = deployment.spec.template.metadata.labels["praetorium.io/repository-id"];
const suffix = instanceId.slice(4).toLowerCase();
const namespace = deployment.metadata.namespace;
assert.equal(namespace, `praetorium-instances-${suffix}`);
assert.equal(pvc.metadata.name, `arcadia-ins-${suffix}-history`);
assert.equal(pvc.metadata.labels["app.kubernetes.io/name"], "scriptorium");
assert.equal(pvc.metadata.annotations["praetorium.io/history-contract"], "v1");
assert.equal(pvc.spec.storageClassName, "local-path");
assert.deepEqual(pvc.spec.accessModes, ["ReadWriteOnce"]);
assert.equal(quota.spec.hard.persistentvolumeclaims, "1");
assert.equal(quota.spec.hard["requests.storage"], pvc.spec.resources.requests.storage);

const seedSecret = {
  apiVersion: "v1",
  kind: "Secret",
  metadata: {
    name: `arcadia-ins-${suffix}-history-seed`,
    namespace,
    labels: { ...pvc.metadata.labels },
    annotations: { "praetorium.io/history-contract": "v1" },
  },
  type: "Opaque",
  immutable: true,
  data: {
    "snapshot.json": Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        sourcePodUid: "ci-owned-pod-uid",
        manifestSha256: "a".repeat(64),
        files: [],
      }),
    ).toString("base64"),
  },
};

// The test namespace is owned only by this disposable CI fixture. It mirrors
// the runtime owner labels so the production policies evaluate real CEL.
kubectl(["create", "namespace", namespace]);
kubectl([
  "label",
  "namespace",
  namespace,
  "arcadia.io/platform=arcadia-platform",
  "app.kubernetes.io/managed-by=arcadia-provisioner",
  `arcadia.io/instance-id=${instanceId}`,
  `praetorium.io/repository-id=${repositoryId}`,
  "arcadia.io/ownership-version=v1",
  `arcadia.io/runtime-cluster-id=${clusterId}`,
  "pod-security.kubernetes.io/enforce=restricted",
  "pod-security.kubernetes.io/audit=restricted",
  "pod-security.kubernetes.io/warn=restricted",
]);
kubectl(["create", "namespace", "praetorium-system"]);
kubectl(["create", "serviceaccount", "praetorium-provisioner", "-n", "praetorium-system"]);
applyObjects([quota]);
applyObjects(loadYaml("infrastructure/kubernetes/policies/provisioner-rbac.yaml"));

const binding = {
  apiVersion: "rbac.authorization.k8s.io/v1",
  kind: "RoleBinding",
  metadata: { name: "praetorium-provisioner-runtime", namespace },
  roleRef: {
    apiGroup: "rbac.authorization.k8s.io",
    kind: "ClusterRole",
    name: "praetorium-provisioner-tenant-runtime",
  },
  subjects: [
    { kind: "ServiceAccount", name: "praetorium-provisioner", namespace: "praetorium-system" },
  ],
};
applyObjects([binding]);

const ownerPolicies = loadYaml("infrastructure/kubernetes/policies/provisioner-boundary.yaml").map(
  (document) => JSON.parse(JSON.stringify(document).replaceAll("@@CLUSTER_ID@@", clusterId)),
);
const relevantOwnerPolicies = ownerPolicies.filter((document) =>
  [
    "praetorium-provisioner-runtime-resources",
    "praetorium-provisioner-runtime-resource-delete",
  ].includes(document.metadata?.name),
);
applyObjects(relevantOwnerPolicies);
applyObjects(loadYaml("infrastructure/kubernetes/policies/provisioner-history-pvc.yaml"));
applyObjects(loadYaml("infrastructure/kubernetes/policies/tenant-pod-policy.yaml"));

// Exercise one valid PVC through admission and persist it only in this ephemeral
// cluster so the immutable request size can be evaluated on UPDATE.
createObject(pvc, { dryRun: true, asProvisioner: true });
createObject(pvc, { asProvisioner: true });
createObject(seedSecret, { dryRun: true, asProvisioner: true });

const wrongOwnerPvc = structuredClone(pvc);
wrongOwnerPvc.metadata.labels["arcadia.io/instance-id"] = "ins_00000000000000000000000002";
createObject(wrongOwnerPvc, {
  dryRun: true,
  asProvisioner: true,
  expectedPolicy: "praetorium-provisioner-history-pvc",
});

const wrongClassPvc = structuredClone(pvc);
wrongClassPvc.spec.storageClassName = "standard";
createObject(wrongClassPvc, {
  dryRun: true,
  asProvisioner: true,
  expectedPolicy: "praetorium-provisioner-history-pvc",
});

const oversizedPvc = structuredClone(pvc);
oversizedPvc.spec.resources.requests.storage = "2Gi";
createObject(oversizedPvc, {
  dryRun: true,
  asProvisioner: true,
  expectedError: "exceeded quota",
});

const wrongNameSeed = structuredClone(seedSecret);
wrongNameSeed.metadata.name += "-other";
createObject(wrongNameSeed, {
  dryRun: true,
  asProvisioner: true,
  expectedPolicy: "praetorium-provisioner-runtime-resources",
});

const wrongOwnerSeed = structuredClone(seedSecret);
wrongOwnerSeed.metadata.labels["praetorium.io/repository-id"] = "999";
createObject(wrongOwnerSeed, {
  dryRun: true,
  asProvisioner: true,
  expectedPolicy: "praetorium-provisioner-runtime-resources",
});

const extraDataSeed = structuredClone(seedSecret);
extraDataSeed.data.unexpected = Buffer.from("extra").toString("base64");
createObject(extraDataSeed, {
  dryRun: true,
  asProvisioner: true,
  expectedPolicy: "praetorium-provisioner-runtime-resources",
});

const badSizePatch = JSON.stringify({ spec: { resources: { requests: { storage: "512Mi" } } } });
kubectl(
  [
    `--as=${provisioner}`,
    "patch",
    "persistentvolumeclaim",
    pvc.metadata.name,
    "-n",
    namespace,
    "--type=merge",
    `--patch=${badSizePatch}`,
    "--dry-run=server",
    "-o",
    "name",
  ],
  { expectedPolicy: "praetorium-provisioner-history-pvc" },
);

const pod = admissionPod(deployment);
createObject(pod, { dryRun: true });

const wrongPodClaim = structuredClone(pod);
wrongPodClaim.spec.volumes.find(
  (volume) => volume.name === "history",
).persistentVolumeClaim.claimName = "arcadia-ins-unrelated-history";
expectPodDenied(wrongPodClaim);

const wrongPodPath = structuredClone(pod);
wrongPodPath.spec.initContainers
  .find((container) => container.name === "history-restore")
  .volumeMounts.find((mount) => mount.name === "history").mountPath = "/tmp/history";
expectPodDenied(wrongPodPath);

process.stdout.write(
  "PASS: real API-server admission accepted the owned history PVC, seed Secret, and Pod; rejected wrong owner/class/name, extra seed data, changed PVC size, wrong Pod claim, and wrong mount path.\n",
);
