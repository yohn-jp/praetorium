#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readInventory } from "../infrastructure/scripts/inventory.mjs";
import { renderPlatformBundle } from "../infrastructure/scripts/render-platform.mjs";
import {
  assertKindRuntimeVersion,
  KIND_RUNTIME_VERSION,
  NODE_IMAGE,
} from "../infrastructure/scripts/kind-runtime.mjs";
import { applyGuardedBundle } from "../infrastructure/scripts/guarded-apply.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  process.stderr.write(`Usage:
  node scripts/deploy-infrastructure.mjs plan --inventory <file>
  node scripts/deploy-infrastructure.mjs preflight --inventory <file>
  node scripts/deploy-infrastructure.mjs render --inventory <file>
  node scripts/deploy-infrastructure.mjs create --inventory <file> --confirm <cluster-name>
  node scripts/deploy-infrastructure.mjs apply --inventory <file> --confirm <cluster-name>
`);
}

function parseArgs(argv) {
  const [action, ...rest] = argv;
  if (!["plan", "preflight", "render", "create", "apply"].includes(action)) {
    throw new Error("action must be plan, preflight, render, create, or apply");
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
  if (!executable)
    throw new Error(
      `${command} is unavailable; set PRAETORIUM_${command.toUpperCase().replaceAll("-", "_")}_BIN or add it to PATH`,
    );
  const result = spawnSync(executable, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    input: options.input,
    stdio: options.input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
    timeout: options.timeout ?? 120_000,
  });
  if (result.error) throw new Error(`${command} is unavailable: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args[0] ?? ""} failed (${result.status}): ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result.stdout;
}

function kubeconfigPath(inventory, { createDirectory = false } = {}) {
  const uid = typeof process.getuid === "function" ? process.getuid() : "unknown";
  const directory = path.join(os.tmpdir(), `praetorium-t12-${uid}`);
  if (createDirectory) mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (existsSync(directory)) {
    const stats = lstatSync(directory);
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      (typeof process.getuid === "function" && stats.uid !== uid)
    ) {
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
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    (uid !== null && stats.uid !== uid) ||
    (stats.mode & 0o077) !== 0
  ) {
    throw new Error(`explicit disposable kubeconfig must be an owner-only regular file: ${file}`);
  }
  return file;
}

function checkInventory(inventoryPath, { requireReady = false } = {}) {
  const result = readInventory(inventoryPath);
  if (result.errors.length > 0)
    throw new Error(`inventory is invalid:\n- ${result.errors.join("\n- ")}`);
  if (
    result.inventory.environment !== "disposable-test" ||
    result.inventory.cloudflare.mode !== "local"
  ) {
    throw new Error(
      "local cluster actions require environment=disposable-test and cloudflare.mode=local",
    );
  }
  if (result.inventory.ownership.disposable !== true)
    throw new Error("inventory does not own a disposable cluster");
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
  const args =
    command === "kubectl"
      ? ["version", "--client"]
      : command === "kustomize"
        ? ["version"]
        : ["--version"];
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

function kindRuntime() {
  try {
    const version = assertKindRuntimeVersion(run("kind", ["version"], { timeout: 5_000 }));
    return { valid: true, version, requiredVersion: KIND_RUNTIME_VERSION, nodeImage: NODE_IMAGE };
  } catch (error) {
    return {
      valid: false,
      requiredVersion: KIND_RUNTIME_VERSION,
      nodeImage: NODE_IMAGE,
      error: error.message,
    };
  }
}

function requireKindRuntime() {
  const runtime = kindRuntime();
  if (!runtime.valid) throw new Error(runtime.error);
  return runtime;
}

function preflightKustomize() {
  const tool = available("kustomize") ? "kustomize" : available("kubectl") ? "kubectl" : null;
  if (!tool)
    return {
      valid: false,
      executable: null,
      targets: [],
      error: "Kustomize and kubectl are unavailable",
    };
  try {
    const targets = ["base", "controllers", "overlays/deployment", "overlays/disposable"];
    for (const target of targets) {
      const directory = path.join(repoRoot, "infrastructure/kubernetes", target);
      run(tool, tool === "kustomize" ? ["build", directory] : ["kustomize", directory], {
        timeout: 15_000,
      });
    }
    return { valid: true, executable: tool, targets, error: null };
  } catch (error) {
    return { valid: false, executable: tool, targets: [], error: error.message };
  }
}

function buildKustomize(directory) {
  return available("kustomize")
    ? run("kustomize", ["build", directory])
    : run("kubectl", ["kustomize", directory]);
}

function renderStaticBundle(inventory) {
  return renderPlatformBundle(inventory, { overlay: "disposable", buildKustomize });
}

function requireClusterOwnership(inventory, kubeconfig) {
  const name = inventory.ownership.clusterName;
  const context = inventory.ownership.context;
  // Kind lists container-backed cluster names; kubeconfig belongs to kubectl.
  const clusters = run("kind", ["get", "clusters"])
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!clusters.includes(name)) throw new Error(`owned Kind cluster ${name} does not exist`);
  const nodes = JSON.parse(
    run("kubectl", [
      "--kubeconfig",
      kubeconfig,
      "--context",
      context,
      "get",
      "nodes",
      "-o",
      "json",
    ]),
  );
  if (!Array.isArray(nodes.items) || nodes.items.length === 0)
    throw new Error("explicit Kind context has no nodes");
  for (const node of nodes.items) {
    const labels = node.metadata?.labels ?? {};
    if (
      labels["praetorium.io/cluster-id"] !== inventory.clusterId ||
      labels["praetorium.io/disposable"] !== "true"
    ) {
      throw new Error(
        `node ${node.metadata?.name ?? "(unnamed)"} does not carry this inventory's ownership labels`,
      );
    }
  }
  return { name, context };
}

function requireNamespaceSecrets(inventory, kubeconfig, context) {
  const secret = inventory.secretRefs;
  const required = [
    [
      "praetorium-system",
      secret.controlPlaneCredential,
      "Opaque",
      [secret.controlPlaneCredential.key],
    ],
    [
      "praetorium-system",
      secret.instanceAccessServiceAuth,
      "Opaque",
      [secret.instanceAccessServiceAuth.key],
    ],
    [
      "praetorium-system",
      secret.applicationImagePull,
      "kubernetes.io/dockerconfigjson",
      [".dockerconfigjson"],
    ],
    [
      "praetorium-build",
      secret.buildWorkerControlPlaneAuth,
      "Opaque",
      [secret.buildWorkerControlPlaneAuth.key],
    ],
    [
      "praetorium-build",
      secret.buildWorkerSigningKey,
      "Opaque",
      [secret.buildWorkerSigningKey.key],
    ],
    [
      "praetorium-build",
      secret.buildWorkerRegistryPush,
      "Opaque",
      [secret.buildWorkerRegistryPush.key],
    ],
    [
      "praetorium-build",
      secret.buildWorkerRegistryPull,
      "Opaque",
      [secret.buildWorkerRegistryPull.key],
    ],
    [
      "praetorium-build",
      secret.buildkitClient,
      "kubernetes.io/tls",
      [
        secret.buildkitClient.caKey,
        secret.buildkitClient.certKey,
        secret.buildkitClient.privateKey,
      ],
    ],
    [
      "praetorium-build",
      secret.applicationImagePull,
      "kubernetes.io/dockerconfigjson",
      [".dockerconfigjson"],
    ],
    [
      "praetorium-observability",
      secret.applicationImagePull,
      "kubernetes.io/dockerconfigjson",
      [".dockerconfigjson"],
    ],
  ];
  const missing = [];
  const invalid = [];
  const metadataTemplate =
    '{{.type}}{{"\\n"}}{{range $key, $value := .data}}{{$key}}{{"\\n"}}{{end}}';
  for (const [namespace, reference, expectedType, expectedKeys] of required) {
    try {
      const result = run("kubectl", [
        "--kubeconfig",
        kubeconfig,
        "--context",
        context,
        "-n",
        namespace,
        "get",
        "secret",
        reference.name,
        "-o",
        "go-template",
        "--template",
        metadataTemplate,
      ])
        .trim()
        .split("\n");
      const type = result.shift();
      const actualKeys = new Set(result.filter(Boolean));
      const absent = expectedKeys.filter((key) => !actualKeys.has(key));
      if (type !== expectedType || absent.length > 0) {
        invalid.push(
          `${namespace}/${reference.name} (expected type ${expectedType} and keys ${expectedKeys.join(", ")}${absent.length > 0 ? `; missing ${absent.join(", ")}` : ""})`,
        );
      }
    } catch {
      missing.push(`${namespace}/${reference.name}`);
    }
  }
  if (missing.length > 0) {
    throw new Error(`operator-managed secrets must exist before apply: ${missing.join(", ")}`);
  }
  if (invalid.length > 0)
    throw new Error(`operator-managed secrets have the wrong type or keys: ${invalid.join(", ")}`);
}

function report({
  action,
  inventoryResult,
  dependencies,
  clusterVerified = false,
  kustomizeValidation,
  runtime,
  sideEffects = [],
}) {
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
    ...(runtime ? { kindRuntime: runtime } : {}),
    ...(kustomizeValidation ? { kustomizeValidation } : {}),
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
  const inventoryResult = checkInventory(args.inventoryPath, {
    requireReady: ["apply", "render"].includes(args.action),
  });
  const { inventory } = inventoryResult;

  if (
    ["create", "apply"].includes(args.action) &&
    args.confirmation !== inventory.ownership.clusterName
  ) {
    throw new Error(`--confirm must exactly equal ${inventory.ownership.clusterName}`);
  }

  if (args.action === "plan") {
    report({ action: args.action, inventoryResult, dependencies: {}, clusterVerified: false });
    if (inventoryResult.blockers.length > 0) process.exitCode = 2;
  } else if (args.action === "preflight") {
    const kustomize = preflightKustomize();
    const runtime = kindRuntime();
    const dependencies = {
      kind: runtime.valid,
      kubectl: available("kubectl"),
      kustomize: kustomize.valid,
    };
    const missing = Object.entries(dependencies)
      .filter(([, present]) => !present)
      .map(([name]) => name);
    report({
      action: args.action,
      inventoryResult,
      dependencies,
      clusterVerified: false,
      kustomizeValidation: kustomize,
      runtime,
    });
    if (missing.length > 0 || inventoryResult.blockers.length > 0) {
      process.stderr.write(
        `BLOCKED: ${[...missing.map((name) => `missing ${name}`), ...inventoryResult.blockers].join("; ")}\n`,
      );
      process.exitCode = 2;
    }
    if (!kustomize.valid) {
      process.stderr.write(`BLOCKED: local Kustomize render failed: ${kustomize.error}\n`);
      process.exitCode = 2;
    }
  } else if (args.action === "render") {
    if (!available("kustomize") && !available("kubectl"))
      throw new Error("render requires Kustomize or kubectl kustomize");
    process.stdout.write(renderStaticBundle(inventory));
  } else if (args.action === "create") {
    if (!available("kind") || !available("kubectl"))
      throw new Error("create requires installed kind and kubectl");
    const runtime = requireKindRuntime();
    const kubeconfig = kubeconfigPath(inventory, { createDirectory: true });
    if (pathEntryExists(kubeconfig))
      throw new Error(`refusing to overwrite an existing disposable kubeconfig: ${kubeconfig}`);
    const temporary = mkdtempSync(path.join(os.tmpdir(), "praetorium-t12-kind-"));
    try {
      const config = path.join(temporary, "kind.yaml");
      const template = readFileSync(
        path.join(repoRoot, "infrastructure/kind/disposable-config.yaml"),
        "utf8",
      );
      writeFileSync(config, template.replaceAll("@@CLUSTER_ID@@", inventory.clusterId), {
        mode: 0o600,
      });
      run("kind", [
        "create",
        "cluster",
        "--name",
        inventory.ownership.clusterName,
        "--config",
        config,
        "--kubeconfig",
        kubeconfig,
        "--wait",
        "120s",
      ]);
      chmodSync(kubeconfig, 0o600);
      requireClusterOwnership(inventory, requireOwnedKubeconfig(inventory));
      report({
        action: args.action,
        inventoryResult,
        dependencies: { kind: true, kubectl: true },
        runtime,
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
    const runtime = requireKindRuntime();
    const kustomize = preflightKustomize();
    if (!kustomize.valid)
      throw new Error(
        `apply requires a successful four-target Kustomize render: ${kustomize.error}`,
      );
    const kubeconfig = requireOwnedKubeconfig(inventory);
    const { context } = requireClusterOwnership(inventory, kubeconfig);
    requireNamespaceSecrets(inventory, kubeconfig, context);
    run("kubectl", [
      "--kubeconfig",
      kubeconfig,
      "--context",
      context,
      "get",
      "--raw",
      "/apis/cert-manager.io/v1",
    ]);
    run("kubectl", [
      "--kubeconfig",
      kubeconfig,
      "--context",
      context,
      "get",
      "--raw",
      "/apis/traefik.io/v1alpha1",
    ]);
    const bundle = renderStaticBundle(inventory);
    const kubeArgs = ["--kubeconfig", kubeconfig, "--context", context];
    const readGuard = (resource, name) => {
      const output = run(
        "kubectl",
        [
          ...kubeArgs,
          "--request-timeout=5s",
          "get",
          resource,
          name,
          "--ignore-not-found",
          "-o",
          "json",
        ],
        { timeout: 7_000 },
      );
      return output.trim() === "" ? null : JSON.parse(output);
    };
    await applyGuardedBundle({
      bundle,
      discover: () =>
        JSON.parse(
          run(
            "kubectl",
            [
              ...kubeArgs,
              "--request-timeout=5s",
              "get",
              "--raw",
              "/apis/admissionregistration.k8s.io/v1",
            ],
            { timeout: 7_000 },
          ),
        ),
      serverDryRun: (input) =>
        run("kubectl", [...kubeArgs, "apply", "--dry-run=server", "--validate=strict", "-f", "-"], {
          input,
        }),
      apply: (input) => run("kubectl", [...kubeArgs, "apply", "-f", "-"], { input }),
      readPolicy: (name) =>
        readGuard("validatingadmissionpolicies.admissionregistration.k8s.io", name),
      readBinding: (name) =>
        readGuard("validatingadmissionpolicybindings.admissionregistration.k8s.io", name),
    });
    for (const [namespace, name] of [
      ["praetorium-system", "praetorium-instance-access"],
      ["praetorium-system", "praetorium-provisioner"],
      ["praetorium-build", "praetorium-build-worker"],
      ["praetorium-observability", "praetorium-prometheus"],
    ]) {
      run("kubectl", [
        "--kubeconfig",
        kubeconfig,
        "--context",
        context,
        "-n",
        namespace,
        "rollout",
        "status",
        `deployment/${name}`,
        "--timeout=180s",
      ]);
    }
    report({
      action: args.action,
      inventoryResult,
      dependencies: { kind: true, kubectl: true, kustomize: true },
      runtime,
      clusterVerified: true,
      sideEffects: [`applied static shared resources to ${context}`],
    });
  }
} catch (error) {
  usage();
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
}
