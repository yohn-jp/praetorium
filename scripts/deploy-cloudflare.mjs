#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readInventory } from "../infrastructure/scripts/inventory.mjs";
import { renderWorkerTemplate } from "../infrastructure/scripts/worker-config.mjs";
import {
  validateWorkNotificationTokens,
  workNotificationsEnabled,
} from "../infrastructure/scripts/work-notifications.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
let inventoryPath;
let secretFilesPath;
let mode = "--check";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--inventory" && args[i + 1]) inventoryPath = args[++i];
  else if (args[i] === "--secret-files" && args[i + 1]) secretFilesPath = args[++i];
  else if (["--check", "--apply"].includes(args[i])) mode = args[i];
  else throw new Error("Usage: node scripts/deploy-cloudflare.mjs --inventory <private-inventory.json> [--check|--apply]");
}
if (!inventoryPath || !secretFilesPath) throw new Error("--inventory and --secret-files are required");
const input = readInventory(inventoryPath);
if (input.errors.length || input.blockers.length) {
  throw new Error("incomplete deployment inventory: " + [...input.errors, ...input.blockers].join("; "));
}
const inventory = input.inventory;
if (!path.isAbsolute(secretFilesPath)) throw new Error("--secret-files must be an absolute path");
const secretMeta = lstatSync(secretFilesPath);
if (!secretMeta.isFile() || secretMeta.isSymbolicLink() ||
    (process.platform !== "win32" && (secretMeta.mode & 0o077) !== 0)) {
  throw new Error("--secret-files must be a private regular file");
}
const privateManifest = JSON.parse(readFileSync(secretFilesPath, "utf8"));
if (privateManifest.apiVersion !== "praetorium.io/secret-files/v1" || !privateManifest.values) {
  throw new Error("private secret-files manifest has invalid schema");
}
function privateBytes(role) {
  const filename = privateManifest.values[role];
  if (typeof filename !== "string" || !path.isAbsolute(filename)) throw new Error(role + " requires an absolute file");
  const meta = lstatSync(filename);
  if (!meta.isFile() || meta.isSymbolicLink() ||
      (process.platform !== "win32" && (meta.mode & 0o077) !== 0)) {
    throw new Error(role + " must use a private regular file");
  }
  const bytes = readFileSync(filename);
  if (!bytes.length) throw new Error(role + " secret is empty");
  return bytes;
}
const notificationsEnabled = workNotificationsEnabled(inventory);
const notificationTokenBytes = notificationsEnabled
  ? {
      provisioner: privateBytes("provisionerWorkNotificationToken"),
      build: privateBytes("buildWorkerWorkNotificationToken"),
    }
  : null;
if (notificationTokenBytes) {
  validateWorkNotificationTokens({
    ...notificationTokenBytes,
    provisionerClaim: privateBytes("controlPlaneCredential"),
    buildClaim: privateBytes("buildWorkerControlPlaneAuth"),
  });
}
if (inventory.environment !== "deployment" || inventory.cloudflare.mode !== "remote") {
  throw new Error("remote Cloudflare deployment requires deployment/remote inventory");
}
function run(command, params, { input: stdin, capture = true, timeout = 15 * 60_000, allowFailure = false } = {}) {
  const result = spawnSync(command, params, {
    cwd: root, encoding: "utf8", input: stdin,
    stdio: ["pipe", "pipe", "pipe"], timeout, maxBuffer: 16 * 1024 * 1024,
    shell: process.platform === "win32",
  });
  if (result.error || (result.status !== 0 && !allowFailure)) {
    // No sensitive command stdout or stderr is emitted: some Wrangler calls read secrets from stdin.
    throw new Error(command + " " + params[0] + " failed (" + (result.error?.code ?? result.status) + ")");
  }
  if (!capture && result.stdout) process.stdout.write(result.stdout);
  return result.stdout ?? "";
}
function wrangler(params, opts) {
  return run("corepack", ["pnpm@11.18.0", "exec", "wrangler", ...params], opts);
}
const generated = mkdtempSync(path.join(root, "infrastructure/workers/.praetorium-wrangler-"));
const conf = {
  gateway: path.join(generated, "gateway.json"),
  control: path.join(generated, "control-plane.json"),
};
try {
  const workerTemplates = [
    ["control", "control-plane.template.json", inventory.domains.controlPlaneUrl],
    ["gateway", "gateway.template.json", inventory.domains.gatewayOrigin],
  ];
  for (const [key, name, origin] of workerTemplates) {
    const original = readFileSync(path.join(root, "infrastructure/workers", name), "utf8");
    const config = JSON.parse(renderWorkerTemplate(original, inventory, key === "control" ? "control-plane" : "gateway"));
    config.account_id = inventory.cloudflare.accountId;
    config.routes = [{ pattern: new URL(origin).hostname, custom_domain: true }];
    // Generated configs live in a private subdirectory; make source and migration paths relative to it.
    config.main = path.relative(generated, path.join(root, "apps", key === "control" ? "control-plane" : "gateway", "src/worker.ts")).replaceAll(path.sep, "/");
    for (const database of config.d1_databases ?? []) {
      if (database.binding === "CONTROL_PLANE_DB") {
        database.migrations_dir = path.relative(generated, path.join(root, "apps/control-plane/migrations")).replaceAll(path.sep, "/");
      }
    }
    writeFileSync(conf[key], JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  }
  const required = {
    [conf.gateway]: [
      "GITHUB_APP_PRIVATE_KEY", "GITHUB_OAUTH_CLIENT_SECRET", "GATEWAY_GITHUB_WEBHOOK_SECRET",
      "GATEWAY_SIGNING_KEY", "CONTROL_PLANE_GATEWAY_AUTH", "RUNTIME_CREDENTIAL_RETIREMENT_AUTH",
      "INSTANCE_ACCESS_SERVICE_AUTH_TOKEN", "GATEWAY_SESSION_DIGEST_PEPPER",
      "GATEWAY_CREDENTIAL_DIGEST_PEPPER", "GATEWAY_HANDOFF_DIGEST_PEPPER",
      "GATEWAY_TOKEN_ENCRYPTION_KEY",
    ],
    [conf.control]: [
      "CONTROL_PLANE_GATEWAY_AUTH", "RUNTIME_CREDENTIAL_RETIREMENT_AUTH",
      "RUNTIME_CONTROL_SIGNING_KEY", "RUNTIME_IDENTITY_SIGNING_KEY",
    ],
  };
  for (const [config, names] of Object.entries(required)) {
    const existing = new Set(JSON.parse(wrangler(["secret", "list", "--config", config])).map((s) => s.name));
    const missing = names.filter((name) => !existing.has(name));
    if (missing.length) throw new Error("missing Worker Secrets for " + path.basename(config) + ": " + missing.join(", "));
  }
  const kvOutput = wrangler(["kv", "key", "get", "gateway-signing-key-registry", "--remote",
    "--namespace-id", inventory.cloudflare.gatewayKvNamespaceId]);
  const records = JSON.parse(kvOutput);
  if (!Array.isArray(records) || records.filter((row) =>
    row.status === "active" && row.publicKeyJwk?.kty === "EC" && row.publicKeyJwk?.crv === "P-256").length !== 1) {
    throw new Error("Gateway public key registry must contain one active P-256 key");
  }
  console.log("Cloudflare resources, Worker Secrets and active public key registry: present.");
  if (notificationsEnabled) {
    console.log("Work notification token files are privately referenced and validated locally; remote notification Worker Secrets are not checked until deployment. DNS, Runtime ingress, and certificate readiness are not verified here.");
  }
  if (mode === "--check") {
    console.log("No Cloudflare resource mutated.");
    process.exit(0);
  }
  run("corepack", ["pnpm@11.18.0", "install", "--frozen-lockfile"], { capture: false });
  run("corepack", ["pnpm@11.18.0", "build"], { capture: false });
  // Publish the same operator-supplied runtime tokens to the respective Worker
  // that K3s reads from its namespace Secret; never ask for a second token.
  for (const [worker, key, role] of [
    [conf.gateway, "INSTANCE_ACCESS_SERVICE_AUTH_TOKEN", "instanceAccessServiceAuth"],
    [conf.control, "PROVISIONER_AUTH_TOKEN", "controlPlaneCredential"],
    [conf.control, "BUILD_WORKER_AUTH_TOKEN", "buildWorkerControlPlaneAuth"],
    [conf.control, "REGISTRY_PULL_CREDENTIAL", "buildWorkerRegistryPull"],
  ]) {
    wrangler(["secret", "put", key, "--config", worker], { input: privateBytes(role), capture: true });
  }
  if (notificationTokenBytes) {
    for (const [key, role] of [
      ["PROVISIONER_WORK_NOTIFICATION_TOKEN", "provisioner"],
      ["BUILD_WORK_NOTIFICATION_TOKEN", "build"],
    ]) {
      wrangler(["secret", "put", key, "--config", conf.control], {
        input: notificationTokenBytes[role],
        capture: true,
      });
    }
  }
  if (privateManifest.values.releaseOperatorToken) {
    wrangler(["secret", "put", "RELEASE_OPERATOR_TOKEN", "--config", conf.control],
      { input: privateBytes("releaseOperatorToken"), capture: true });
  }
  wrangler(["d1", "migrations", "apply", "praetorium-platform", "--remote",
    "--config", conf.control], { capture: false });
  wrangler(["deploy", "--config", conf.control], { capture: false });
  wrangler(["deploy", "--config", conf.gateway], { capture: false });
  for (const [origin, endpoint] of [
    [inventory.domains.controlPlaneUrl, "/healthz"],
    [inventory.domains.gatewayOrigin, "/healthz"],
    [inventory.domains.gatewayOrigin, "/.well-known/jwks.json"],
  ]) {
    const response = await fetch(origin + endpoint, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error("Cloudflare HTTPS probe failed: " + origin + endpoint +
      " HTTP " + response.status);
    if (endpoint.endsWith("jwks.json")) {
      const actual = await response.json();
      const active = records.find((row) => row.status === "active");
      if (!actual.keys?.some((key) => key.kid === active.kid &&
          key.x === active.publicKeyJwk.x && key.y === active.publicKeyJwk.y)) {
        throw new Error("deployed Gateway JWKS differs from approved public key registry");
      }
    }
    console.log("Verified " + origin + endpoint);
  }
  console.log("Cloudflare Worker deployment verified (K3s and hosted end-to-end checks separate).");
} finally {
  rmSync(generated, { recursive: true, force: true });
}
