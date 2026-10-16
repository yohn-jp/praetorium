#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  accessSync,
  cpSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readInventory } from "../infrastructure/scripts/inventory.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultInventory = path.join(repoRoot, "infrastructure/test/disposable-inventory.json");

function usage() {
  process.stderr.write(`Usage:
  node scripts/deploy-infrastructure.mjs plan --inventory <file>
  node scripts/deploy-infrastructure.mjs preflight --inventory <file>
  node scripts/deploy-infrastructure.mjs create --inventory <file> --confirm <cluster-name>
  node scripts/deploy-infrastructure.mjs apply --inventory <file> --confirm <cluster-name>
`);
}

function parseArgs(argv) {
  const [action, ...rest] = argv;
  if (!["plan", "preflight", "create", "apply"].includes(action)) {
    throw new Error("action must be plan, preflight, create, or apply");
  }
  const args = { action, inventoryPath: null, confirmation: null };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--inventory" && rest[index + 1]) args.inventoryPath = rest[++index];
    else if (arg === "--confirm" && rest[index + 1]) args.confirmation = rest[++index];
    else throw new Error(`unknown or incomplete argument: ${arg}`);
  }
  if (!args.inventoryPath) throw new Error("--inventory must name the owned inventory explicitly");
  if (["create", "apply"].includes(action) && !args.confirmation) {
    throw new Error(`${action} requires --confirm with the exact disposable cluster name`);
  }
  return args;
}

function run(command, args, options = {}) {
  const executable = resolveExecutable(command);
  if (!executable) throw new Error(`${command} is unavailable; set PRAETORIUM_${command.toUpperCase().replaceAll("-", "_")}_BIN or add it to PATH`);
  const result = spawnSync(executable, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    input: options.input,
    stdio: options.input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
    timeout: options.timeout ?? 120_000,
  });
  if (result.error) throw new Error(`${command} is unavailable: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${command} ${args[0] ?? ""} failed (${result.status}): ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

function kubeconfigPath(inventory, { createDirectory = false } = {}) {
  const uid = typeof process.getuid === "function" ? process.getuid() : "unknown";
  const directory = path.join(os.tmpdir(), `praetorium-t12-${uid}`);
  if (createDirectory) mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (existsSync(directory)) {
    const stats = lstatSync(directory);
    if (!stats.isDirectory() || stats.isSymbolicLink() || (typeof process.getuid === "function" && stats.uid !== uid)) {
      throw new Error(`refusing an unsafe explicit kubeconfig directory: ${directory}`);
    }
    chmodSync(directory, 0o700);
  }
  return path.join(directory, `${inventory.ownership.clusterName}.yaml`);
}

function pathEntryExists(file) {
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function requireOwnedKubeconfig(inventory) {
  const file = kubeconfigPath(inventory);
  if (!pathEntryExists(file)) throw new Error(`explicit disposable kubeconfig is missing: ${file}`);
  const stats = lstatSync(file);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!stats.isFile() || stats.isSymbolicLink() || (uid !== null && stats.uid !== uid) || (stats.mode & 0o077) !== 0) {
    throw new Error(`explicit disposable kubeconfig must be an owner-only regular file: ${file}`);
  }
  return file;
}

function checkInventory(inventoryPath, { requireReady = false } = {}) {
  const result = readInventory(inventoryPath);
  if (result.errors.length > 0) throw new Error(`inventory is invalid:\n- ${result.errors.join("\n- ")}`);
  if (result.inventory.environment !== "disposable-test" || result.inventory.cloudflare.mode !== "local") {
    throw new Error("local cluster actions require environment=disposable-test and cloudflare.mode=local");
  }
  if (result.inventory.ownership.disposable !== true) throw new Error("inventory does not own a disposable cluster");
  const name = result.inventory.ownership.clusterName;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,51}[a-z0-9])?$/.test(name)) {
    throw new Error("ownership.clusterName must be a DNS-safe Kind cluster name");
  }
  if (requireReady && result.blockers.length > 0) {
    throw new Error(`inventory is not ready:\n- ${result.blockers.join("\n- ")}`);
  }
  return result;
}

function available(command) {
  const executable = resolveExecutable(command);
  if (!executable) return false;
  const args = command === "kubectl" ? ["version", "--client"] : ["--version"];
  const result = spawnSync(executable, args, { encoding: "utf8", stdio: "ignore", timeout: 5_000 });
  return !result.error && result.status === 0;
}

function resolveExecutable(command) {
  const variable = `PRAETORIUM_${command.toUpperCase().replaceAll("-", "_")}_BIN`;
  const configured = process.env[variable];
  if (configured) {
    const candidate = path.resolve(configured);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      return null;
    }
  }
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep checking PATH entries.
    }
  }
  return null;
}

function kustomizeAvailable() {
  if (available("kustomize")) return true;
  if (!available("kubectl")) return false;
  try {
    for (const overlay of ["controllers", "overlays/deployment", "overlays/disposable"]) {
      run("kubectl", ["kustomize", path.join(repoRoot, "infrastructure/kubernetes", overlay)], { timeout: 15_000 });
    }
    return true;
  } catch {
    return false;
  }
}

function buildKustomize(directory) {
  return available("kustomize")
    ? run("kustomize", ["build", directory])
    : run("kubectl", ["kustomize", directory]);
}

function renderValues(inventory) {
  const secret = inventory.secretRefs;
  return {
    "@@CLUSTER_ID@@": inventory.clusterId,
    "@@PROVISIONER_WORKER_ID@@": `${inventory.clusterId}-provisioner`,
    "@@ENVIRONMENT@@": inventory.environment,
    "@@INSTANCE_HOSTNAME_SUFFIX@@": inventory.domains.instanceHostnameSuffix,
    "@@TLS_SECRET_NAME@@": inventory.domains.tlsSecretName,
    "@@GATEWAY_ORIGIN@@": inventory.domains.gatewayOrigin,
    "@@GATEWAY_SERVICE_URL@@": inventory.domains.gatewayServiceUrl,
    "@@NODE_ENV@@": inventory.environment === "disposable-test" ? "test" : "production",
    "@@CONTROL_PLANE_URL@@": inventory.domains.controlPlaneUrl,
    "@@BUILDKIT_ENDPOINT@@": inventory.buildkit.endpoint,
    "@@BUILDKIT_SERVER_NAME@@": inventory.buildkit.endpoint ? new URL(inventory.buildkit.endpoint).hostname : null,
    "@@BUILDKIT_FRONTEND_REPOSITORY@@": inventory.buildkit.frontendRepository,
    "@@BUILDKIT_OUTPUT_REPOSITORY@@": inventory.buildkit.outputRepository,
    "@@BUILD_WORKER_ID@@": `${inventory.clusterId}-build-worker`,
    "@@BUILD_WORKER_CONTROL_PLANE_URL@@": inventory.domains.controlPlaneUrl,
    "@@BUILD_WORKER_SIGNING_KEY_ID@@": inventory.buildWorker.signingKeyId,
    "@@BUILD_WORKER_COMPOSITION_REPOSITORY@@": inventory.buildWorker.compositionRepository,
    "@@BUILD_WORKER_BUILDKIT_PATH@@": inventory.buildWorker.buildctlPath,
    "@@IMAGE_PROVISIONER@@": inventory.images.provisioner,
    "@@IMAGE_INSTANCE_ACCESS@@": inventory.images.instanceAccess,
    "@@IMAGE_BUILD_WORKER@@": inventory.images.buildWorker,
    "@@IMAGE_PROMETHEUS@@": inventory.images.prometheus,
    "@@SECRET_PROVISIONER_CREDENTIAL@@": secret.controlPlaneCredential.name,
    "@@SECRET_PROVISIONER_CREDENTIAL_KEY@@": secret.controlPlaneCredential.key,
    "@@SECRET_INSTANCE_ACCESS_AUTH@@": secret.instanceAccessServiceAuth.name,
    "@@SECRET_INSTANCE_ACCESS_AUTH_KEY@@": secret.instanceAccessServiceAuth.key,
    "@@SECRET_BUILD_WORKER_AUTH@@": secret.buildWorkerControlPlaneAuth.name,
    "@@SECRET_BUILD_WORKER_AUTH_KEY@@": secret.buildWorkerControlPlaneAuth.key,
    "@@SECRET_BUILD_WORKER_SIGNING_KEY@@": secret.buildWorkerSigningKey.name,
    "@@SECRET_BUILD_WORKER_SIGNING_KEY_KEY@@": secret.buildWorkerSigningKey.key,
    "@@SECRET_REGISTRY_PUSH@@": secret.buildWorkerRegistryPush.name,
    "@@SECRET_REGISTRY_PUSH_KEY@@": secret.buildWorkerRegistryPush.key,
    "@@SECRET_APPLICATION_IMAGE_PULL@@": secret.applicationImagePull.name,
    "@@SECRET_BUILDKIT_CLIENT@@": secret.buildkitClient.name,
    "@@SECRET_BUILDKIT_CA_KEY@@": secret.buildkitClient.caKey,
    "@@SECRET_BUILDKIT_CERT_KEY@@": secret.buildkitClient.certKey,
    "@@SECRET_BUILDKIT_PRIVATE_KEY@@": secret.buildkitClient.privateKey,
    "@@SECRET_CLOUDFLARE_DNS_TOKEN@@": secret.cloudflareDnsApiToken.name,
    "@@SECRET_CLOUDFLARE_DNS_TOKEN_KEY@@": secret.cloudflareDnsApiToken.key,
    "@@ACME_CONTACT_EMAIL@@": inventory.acmeContactEmail,
  };
}

function renderTree(source, destination, values) {
  cpSync(source, destination, { recursive: true, errorOnExist: true });
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile()) files.push(fullPath);
    }
  };
  visit(destination);
  for (const file of files) {
    const original = readFileSync(file, "utf8");
    let rendered = original;
    for (const [token, value] of Object.entries(values)) {
      if (value !== null && value !== undefined) rendered = rendered.replaceAll(token, String(value));
    }
    writeFileSync(file, rendered, { mode: 0o600 });
  }
  const unresolved = files.filter((file) => /@@[A-Z0-9_]+@@/.test(readFileSync(file, "utf8")));
  if (unresolved.length > 0) {
    throw new Error(`rendered infrastructure contains unresolved placeholders: ${unresolved.map((file) => path.relative(destination, file)).join(", ")}`);
  }
}

function requireClusterOwnership(inventory, kubeconfig) {
  const name = inventory.ownership.clusterName;
  const context = inventory.ownership.context;
  const clusters = run("kind", ["get", "clusters", "--kubeconfig", kubeconfig]).trim().split(/\s+/).filter(Boolean);
  if (!clusters.includes(name)) throw new Error(`owned Kind cluster ${name} does not exist`);
  const nodes = JSON.parse(run("kubectl", ["--kubeconfig", kubeconfig, "--context", context, "get", "nodes", "-o", "json"]));
  if (!Array.isArray(nodes.items) || nodes.items.length === 0) throw new Error("explicit Kind context has no nodes");
  for (const node of nodes.items) {
    const labels = node.metadata?.labels ?? {};
    if (labels["praetorium.io/cluster-id"] !== inventory.clusterId || labels["praetorium.io/disposable"] !== "true") {
      throw new Error(`node ${node.metadata?.name ?? "(unnamed)"} does not carry this inventory's ownership labels`);
    }
  }
  return { name, context };
}

function requireNamespaceSecrets(inventory, kubeconfig, context) {
  const secret = inventory.secretRefs;
  const required = [
    ["praetorium-system", secret.controlPlaneCredential, "Opaque", [secret.controlPlaneCredential.key]],
    ["praetorium-system", secret.instanceAccessServiceAuth, "Opaque", [secret.instanceAccessServiceAuth.key]],
    ["praetorium-system", secret.applicationImagePull, "kubernetes.io/dockerconfigjson", [".dockerconfigjson"]],
    ["praetorium-build", secret.buildWorkerControlPlaneAuth, "Opaque", [secret.buildWorkerControlPlaneAuth.key]],
    ["praetorium-build", secret.buildWorkerSigningKey, "Opaque", [secret.buildWorkerSigningKey.key]],
    ["praetorium-build", secret.buildWorkerRegistryPush, "Opaque", [secret.buildWorkerRegistryPush.key]],
    ["praetorium-build", secret.buildkitClient, "kubernetes.io/tls", [secret.buildkitClient.caKey, secret.buildkitClient.certKey, secret.buildkitClient.privateKey]],
    ["praetorium-build", secret.applicationImagePull, "kubernetes.io/dockerconfigjson", [".dockerconfigjson"]],
    ["praetorium-observability", secret.applicationImagePull, "kubernetes.io/dockerconfigjson", [".dockerconfigjson"]],
  ];
  const missing = [];
  const invalid = [];
  const metadataTemplate = '{{.type}}{{"\\n"}}{{range $key, $value := .data}}{{$key}}{{"\\n"}}{{end}}';
  for (const [namespace, reference, expectedType, expectedKeys] of required) {
    try {
      const result = run("kubectl", [
        "--kubeconfig", kubeconfig, "--context", context, "-n", namespace, "get", "secret", reference.name,
        "-o", "go-template", "--template", metadataTemplate,
      ]).trim().split("\n");
      const type = result.shift();
      const actualKeys = new Set(result.filter(Boolean));
      const absent = expectedKeys.filter((key) => !actualKeys.has(key));
      if (type !== expectedType || absent.length > 0) {
        invalid.push(`${namespace}/${reference.name} (expected type ${expectedType} and keys ${expectedKeys.join(", ")}${absent.length > 0 ? `; missing ${absent.join(", ")}` : ""})`);
      }
    } catch {
      missing.push(`${namespace}/${reference.name}`);
    }
  }
  if (missing.length > 0) {
    throw new Error(`operator-managed secrets must exist before apply: ${missing.join(", ")}`);
  }
  if (invalid.length > 0) throw new Error(`operator-managed secrets have the wrong type or keys: ${invalid.join(", ")}`);
}

function report({ action, inventoryResult, dependencies, clusterVerified = false, sideEffects = [] }) {
  const { inventory, blockers } = inventoryResult;
  const output = {
    action,
    inventory: inventoryResult.absolutePath,
    environment: inventory.environment,
    clusterName: inventory.ownership.clusterName,
    context: inventory.ownership.context,
    kubeconfig: kubeconfigPath(inventory),
    clusterVerified,
    dependencies,
    blockers,
    sideEffects,
  };
  if (action === "plan") {
    output.fixedActions = [
      "create only the explicitly named Kind cluster with inventory ownership labels",
      "preflight only its derived kind-<cluster-name> context and inventory labels",
      "render and apply only static shared-platform Kustomize resources",
      "never reconcile per-instance namespaces or workloads from Flux",
    ];
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

try {
  const args = parseArgs(process.argv.slice(2));
  const inventoryResult = checkInventory(args.inventoryPath, { requireReady: args.action === "apply" });
  const { inventory } = inventoryResult;

  if (["create", "apply"].includes(args.action) && args.confirmation !== inventory.ownership.clusterName) {
    throw new Error(`--confirm must exactly equal ${inventory.ownership.clusterName}`);
  }

  if (args.action === "plan") {
    report({ action: args.action, inventoryResult, dependencies: {}, clusterVerified: false });
    if (inventoryResult.blockers.length > 0) process.exitCode = 2;
  } else if (args.action === "preflight") {
    const dependencies = {
      kind: available("kind"),
      kubectl: available("kubectl"),
      kustomize: kustomizeAvailable(),
    };
    const missing = Object.entries(dependencies).filter(([, present]) => !present).map(([name]) => name);
    report({ action: args.action, inventoryResult, dependencies, clusterVerified: false });
    if (missing.length > 0 || inventoryResult.blockers.length > 0) {
      process.stderr.write(`BLOCKED: ${[...missing.map((name) => `missing ${name}`), ...inventoryResult.blockers].join("; ")}\n`);
      process.exitCode = 2;
    }
  } else if (args.action === "create") {
    if (!available("kind") || !available("kubectl")) throw new Error("create requires installed kind and kubectl");
    const kubeconfig = kubeconfigPath(inventory, { createDirectory: true });
    if (pathEntryExists(kubeconfig)) throw new Error(`refusing to overwrite an existing disposable kubeconfig: ${kubeconfig}`);
    const temporary = mkdtempSync(path.join(os.tmpdir(), "praetorium-t12-kind-"));
    try {
      const config = path.join(temporary, "kind.yaml");
      const template = readFileSync(path.join(repoRoot, "infrastructure/kind/disposable-config.yaml"), "utf8");
      writeFileSync(config, template.replaceAll("@@CLUSTER_ID@@", inventory.clusterId), { mode: 0o600 });
      run("kind", ["create", "cluster", "--name", inventory.ownership.clusterName, "--config", config, "--kubeconfig", kubeconfig, "--wait", "120s"]);
      chmodSync(kubeconfig, 0o600);
      requireClusterOwnership(inventory, requireOwnedKubeconfig(inventory));
      report({
        action: args.action,
        inventoryResult,
        dependencies: { kind: true, kubectl: true },
        clusterVerified: true,
        sideEffects: [`created disposable Kind cluster ${inventory.ownership.clusterName}`],
      });
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  } else {
    for (const command of ["kind", "kubectl"]) {
      if (!available(command)) throw new Error(`apply requires installed ${command}`);
    }
    if (!kustomizeAvailable()) throw new Error("apply requires Kustomize or kubectl's kustomize subcommand");
    const kubeconfig = requireOwnedKubeconfig(inventory);
    const { context } = requireClusterOwnership(inventory, kubeconfig);
    requireNamespaceSecrets(inventory, kubeconfig, context);
    run("kubectl", ["--kubeconfig", kubeconfig, "--context", context, "get", "--raw", "/apis/cert-manager.io/v1"]);
    run("kubectl", ["--kubeconfig", kubeconfig, "--context", context, "get", "--raw", "/apis/traefik.io/v1alpha1"]);
    const temporary = mkdtempSync(path.join(os.tmpdir(), "praetorium-t12-kustomize-"));
    try {
      const rendered = path.join(temporary, "kubernetes");
      renderTree(path.join(repoRoot, "infrastructure/kubernetes"), rendered, renderValues(inventory));
      const bundle = buildKustomize(path.join(rendered, "overlays/disposable"));
      if (/@@[A-Z0-9_]+@@/.test(bundle) || /namespace:\s*praetorium-instances(?:\s|$)/m.test(bundle)) {
        throw new Error("static Kustomize bundle contains placeholders or dynamic instance namespaces");
      }
      run("kubectl", ["--kubeconfig", kubeconfig, "--context", context, "apply", "-f", "-"], { input: bundle });
      for (const [namespace, name] of [
        ["praetorium-system", "praetorium-instance-access"],
        ["praetorium-system", "praetorium-provisioner"],
        ["praetorium-build", "praetorium-build-worker"],
        ["praetorium-observability", "praetorium-prometheus"],
      ]) {
        run("kubectl", ["--kubeconfig", kubeconfig, "--context", context, "-n", namespace, "rollout", "status", `deployment/${name}`, "--timeout=180s"]);
      }
      report({
        action: args.action,
        inventoryResult,
        dependencies: { kind: true, kubectl: true, kustomize: true },
        clusterVerified: true,
        sideEffects: [`applied static shared resources to ${context}`],
      });
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
} catch (error) {
  usage();
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
}
