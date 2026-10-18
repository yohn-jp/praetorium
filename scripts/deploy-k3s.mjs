#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readInventory } from "../infrastructure/scripts/inventory.mjs";
import { renderPlatformBundle } from "../infrastructure/scripts/render-platform.mjs";
import { applyGuardedBundle } from "../infrastructure/scripts/guarded-apply.mjs";
import {
  validateWorkNotificationTokens,
  workNotificationEndpoints,
  workNotificationsEnabled,
} from "../infrastructure/scripts/work-notifications.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const options = {};
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (["--inventory", "--secret-files", "--kubeconfig", "--confirm"].includes(arg) && argv[i + 1]) {
    options[arg] = argv[++i];
  } else if (["--check", "--apply"].includes(arg)) {
    if (options.mode) throw new Error("choose one of --check and --apply");
    options.mode = arg;
  } else {
    throw new Error("Usage: node scripts/deploy-k3s.mjs --inventory <file> --secret-files <file> --kubeconfig <file> --confirm <clusterName> [--check|--apply]");
  }
}
for (const key of ["--inventory", "--secret-files", "--kubeconfig", "--confirm"]) {
  if (!options[key]) throw new Error("missing " + key);
}
options.mode ??= "--check";
const inventoryResult = readInventory(options["--inventory"]);
if (inventoryResult.errors.length || inventoryResult.blockers.length) {
  throw new Error("deployment inventory is incomplete: " + [...inventoryResult.errors, ...inventoryResult.blockers].join("; "));
}
const inventory = inventoryResult.inventory;
if (inventory.environment !== "deployment" || inventory.ownership.provider !== "k3s" ||
    inventory.ownership.disposable !== false || inventory.cloudflare.mode !== "remote") {
  throw new Error("production K3s deploy requires a non-disposable deployment/k3s/remote inventory");
}
if (options["--confirm"] !== inventory.ownership.clusterName) {
  throw new Error("cluster name confirmation differs from inventory");
}

function privateFile(filename, label) {
  if (!path.isAbsolute(filename)) throw new Error(label + " must be an absolute path");
  const meta = lstatSync(filename);
  if (!meta.isFile() || meta.isSymbolicLink()) throw new Error(label + " must be a regular non-symlink file");
  if (process.platform !== "win32" && ((meta.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && meta.uid !== process.getuid()))) {
    throw new Error(label + " must be owned by the invoking user and mode 0600");
  }
  return realpathSync(filename);
}
const kubeconfig = privateFile(options["--kubeconfig"], "kubeconfig");
const secretManifestPath = privateFile(options["--secret-files"], "secret-files manifest");
const supplied = JSON.parse(readFileSync(secretManifestPath, "utf8"));
if (supplied.apiVersion !== "praetorium.io/secret-files/v1" || !supplied.values ||
    typeof supplied.values !== "object" || Array.isArray(supplied.values) ||
    Object.keys(supplied).sort().join(",") !== "apiVersion,values") {
  throw new Error("invalid private secret-files manifest");
}
const refNames = Object.keys(inventory.secretRefs).sort();
const suppliedRoles = Object.keys(supplied.values).filter((name) => name !== "releaseOperatorToken").sort();
if (suppliedRoles.join(",") !== refNames.join(",")) {
  throw new Error("secret-files manifest must name exactly: " + refNames.join(", "));
}
const secretConfigs = [
  ["praetorium-system", "controlPlaneCredential", "Opaque"],
  ["praetorium-system", "instanceAccessServiceAuth", "Opaque"],
  ["praetorium-system", "applicationImagePull", "kubernetes.io/dockerconfigjson"],
  ["praetorium-build", "buildWorkerControlPlaneAuth", "Opaque"],
  ["praetorium-build", "buildWorkerSigningKey", "Opaque"],
  ["praetorium-build", "buildWorkerRegistryPush", "Opaque"],
  ["praetorium-build", "buildWorkerRegistryPull", "Opaque"],
  ["praetorium-build", "buildkitClient", "kubernetes.io/tls"],
  ["praetorium-build", "applicationImagePull", "kubernetes.io/dockerconfigjson"],
  ["praetorium-observability", "applicationImagePull", "kubernetes.io/dockerconfigjson"],
  ["cert-manager", "cloudflareDnsApiToken", "Opaque"],
  ...(workNotificationsEnabled(inventory)
    ? [
        ["praetorium-system", "provisionerWorkNotificationToken", "Opaque"],
        ["praetorium-build", "buildWorkerWorkNotificationToken", "Opaque"],
      ]
    : []),
];
const material = new Map();
for (const role of refNames) {
  const ref = inventory.secretRefs[role];
  const input = supplied.values[role];
  const properties = role === "buildkitClient" ? ["caKey", "certKey", "privateKey"] : ["key"];
  if (role === "buildkitClient") {
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).sort().join(",") !== properties.slice().sort().join(",")) {
      throw new Error(role + " requires caKey/certKey/privateKey file paths");
    }
  } else if (typeof input !== "string") {
    throw new Error(role + " must be a private file path");
  }
  const data = {};
  for (const field of properties) {
    const file = privateFile(role === "buildkitClient" ? input[field] : input, "secret file " + role);
    const bytes = readFileSync(file);
    if (!bytes.length) throw new Error("empty secret file for " + role);
    data[ref[field]] = bytes.toString("base64");
  }
  material.set(role, data);
}
const notificationEndpoints = workNotificationEndpoints(inventory);
if (notificationEndpoints) {
  const secretBytes = (role) => {
    const ref = inventory.secretRefs[role];
    return Buffer.from(material.get(role)[ref.key], "base64");
  };
  validateWorkNotificationTokens({
    provisioner: secretBytes("provisionerWorkNotificationToken"),
    build: secretBytes("buildWorkerWorkNotificationToken"),
    provisionerClaim: secretBytes("controlPlaneCredential"),
    buildClaim: secretBytes("buildWorkerControlPlaneAuth"),
    registryPull: secretBytes("buildWorkerRegistryPull"),
    registryPush: secretBytes("buildWorkerRegistryPush"),
    registryHost: new URL(inventory.buildPolicy.registryUrl).host,
  });
}
function run(command, args, { input, timeout = 180_000 } = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8", input, cwd: root, timeout,
    maxBuffer: 16 * 1024 * 1024,
    shell: process.platform === "win32" && command === "npx",
  });
  if (result.error || result.status !== 0) {
    // Never print captured stdout or stderr from commands receiving a Secret manifest.
    throw new Error(command + " " + (args[0] ?? "") + " failed: " +
      (result.error?.code ?? "exit " + result.status));
  }
  return result.stdout ?? "";
}
function kubectl(args, opts) {
  return run("kubectl", ["--kubeconfig", kubeconfig, "--context", inventory.ownership.context,
    "--request-timeout=30s", ...args], opts);
}
function getJson(args) {
  return JSON.parse(kubectl([...args, "-o", "json"]));
}
function readResource(kind, name, namespace) {
  try {
    return getJson([...(namespace ? ["-n", namespace] : []), "get", kind, name]);
  } catch (error) {
    // Fail safe: do not assume a network/authz failure means an object is absent.
    const list = getJson([...(namespace ? ["-n", namespace] : []), "get", kind]);
    if (!Array.isArray(list.items)) throw error;
    return list.items.find((item) => item.metadata?.name === name) ?? null;
  }
}
const currentContext = run("kubectl", ["--kubeconfig", kubeconfig, "config", "current-context"]).trim();
if (currentContext !== inventory.ownership.context) throw new Error("kubeconfig current context does not match inventory");
const serverVersion = JSON.parse(kubectl(["get", "--raw", "/version"]));
if (!/k3s/i.test(serverVersion.gitVersion ?? "")) throw new Error("refusing non-K3s Kubernetes server");
const nodes = getJson(["get", "nodes"]);
if (!nodes.items?.length || !nodes.items.every((node) =>
  node.metadata?.labels?.["praetorium.io/cluster-id"] === inventory.clusterId)) {
  throw new Error("K3s node cluster ownership labels do not match the inventory");
}
const fluxNamespace = readResource("namespace", "flux-system");
if (fluxNamespace && fluxNamespace.metadata?.labels?.["praetorium.io/bootstrap-cluster-id"] !== inventory.clusterId) {
  throw new Error("refusing to adopt existing Flux controllers not owned by this Praetorium cluster");
}
const buildTool = run("kubectl", ["version", "--client"]);
const fluxTool = run("flux", ["--version"]);
if (!buildTool || !fluxTool) throw new Error("kubectl and Flux CLI are required");
function buildKustomize(directory) { return run("kubectl", ["kustomize", directory]); }
const bundle = renderPlatformBundle(inventory, { overlay: "deployment", buildKustomize });
const controllerBundle = buildKustomize(path.join(root, "infrastructure/kubernetes/controllers"));
const namespaceManifest = readFileSync(path.join(root, "infrastructure/kubernetes/base/namespaces.yaml"), "utf8");
for (const name of ["praetorium-system", "praetorium-build", "praetorium-observability", "traefik", "cert-manager"]) {
  const existing = readResource("namespace", name);
  if (existing && existing.metadata?.labels?.["app.kubernetes.io/part-of"] !== "praetorium") {
    throw new Error("refusing to adopt an unowned namespace: " + name);
  }
}
const summary = { cluster: inventory.ownership.clusterName, context: inventory.ownership.context,
  inventory: inventoryResult.absolutePath, mode: options.mode,
  namespaces: 5, referencedSecretRoles: refNames,
  workNotifications: {
    enabled: notificationEndpoints !== null,
    endpoints: notificationEndpoints,
    secretRoles: notificationEndpoints
      ? ["provisionerWorkNotificationToken", "buildWorkerWorkNotificationToken"]
      : [],
    buildCertificate: notificationEndpoints
      ? "praetorium-build/praetorium-build-worker-notification-origin"
      : null,
  },
  deployments: ["praetorium-instance-access", "praetorium-provisioner",
    "praetorium-build-worker", "praetorium-prometheus"] };
console.log(JSON.stringify(summary, null, 2));
if (options.mode === "--check") {
  console.log("Preflight passed. No Kubernetes objects changed.");
  process.exit(0);
}

function applyManifest(input, dry = false) {
  return kubectl(["apply", ...(dry ? ["--dry-run=server"] : []),
    "--validate=strict", "-f", "-"], { input });
}
applyManifest(namespaceManifest, true);
applyManifest(namespaceManifest);
const fluxInstall = run("flux", ["install", "--export"], { timeout: 60_000 });
applyManifest(fluxInstall);
kubectl(["label", "namespace", "flux-system", "praetorium.io/bootstrap-cluster-id=" + inventory.clusterId, "--overwrite"]);
for (const controller of ["source-controller", "kustomize-controller", "helm-controller"]) {
  kubectl(["-n", "flux-system", "rollout", "status", "deployment/" + controller, "--timeout=300s"],
    { timeout: 330_000 });
}
applyManifest(controllerBundle, true);
applyManifest(controllerBundle);
for (const chart of ["traefik", "cert-manager"]) {
  kubectl(["-n", "flux-system", "wait", "--for=condition=Ready", "helmrelease/" + chart, "--timeout=900s"],
    { timeout: 930_000 });
}
for (const endpoint of ["/apis/cert-manager.io/v1", "/apis/traefik.io/v1alpha1"]) {
  kubectl(["get", "--raw", endpoint]);
}
for (const [ns, role, type] of secretConfigs) {
  const ref = inventory.secretRefs[role];
  const data = material.get(role);
  const existing = readResource("secret", ref.name, ns);
  if (existing) {
    if (existing.type !== type || Object.keys(existing.data ?? {}).length !== Object.keys(data).length ||
        !Object.entries(data).every(([key, value]) => existing.data?.[key] === value)) {
      throw new Error("existing Secret differs; refusing implicit rotation: " + ns + "/" + ref.name);
    }
    continue;
  }
  const secret = JSON.stringify({
    apiVersion: "v1", kind: "Secret",
    metadata: { name: ref.name, namespace: ns,
      labels: { "app.kubernetes.io/part-of": "praetorium" } },
    type, data,
  });
  applyManifest(secret, true);
  applyManifest(secret);
  console.log("Created Kubernetes Secret " + ns + "/" + ref.name);
}
const readGuard = (kind, name) => readResource(kind, name);
await applyGuardedBundle({
  bundle,
  discover: () => JSON.parse(kubectl(["get", "--raw", "/apis/admissionregistration.k8s.io/v1"])),
  serverDryRun: (manifest) => applyManifest(manifest, true),
  apply: (manifest) => applyManifest(manifest),
  readPolicy: (name) => readGuard("validatingadmissionpolicies.admissionregistration.k8s.io", name),
  readBinding: (name) => readGuard("validatingadmissionpolicybindings.admissionregistration.k8s.io", name),
});
for (const [ns, name] of [
  ["praetorium-system", "praetorium-instance-access"],
  ["praetorium-system", "praetorium-provisioner"],
  ["praetorium-build", "praetorium-build-worker"],
  ["praetorium-observability", "praetorium-prometheus"],
]) {
  kubectl(["-n", ns, "rollout", "status", "deployment/" + name, "--timeout=360s"],
    { timeout: 390_000 });
}
kubectl(["-n", "praetorium-system", "wait", "--for=condition=Ready",
  "certificate/praetorium-instance-origin", "--timeout=600s"], { timeout: 630_000 });
if (notificationEndpoints) {
  kubectl(["-n", "praetorium-build", "wait", "--for=condition=Ready",
    "certificate/praetorium-build-worker-notification-origin", "--timeout=600s"],
  { timeout: 630_000 });
}
console.log("K3s static application resources, controllers, certificate and four Deployments are ready.");
console.log("This does not certify Hosted GitHub access, Scriptorium or external routing.");
