#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readInventory } from "../infrastructure/scripts/inventory.mjs";
import { renderWorkerTemplate } from "../infrastructure/scripts/worker-config.mjs";
import {
  assertRemoteDisposableSecretMaterials,
  remoteDisposableSecretRoles,
  writeRemoteDisposableWorkerDeploymentSecrets,
  writeWorkerDeploymentSecrets,
} from "./worker-deployment-secrets.mjs";
import {
  applyMigrationsWithPreflight,
  assertCompatibleMigrationHistory,
  assertMigrationReadback,
  parseD1TableReadback,
  orderedMigrationFiles,
  parseAppliedMigrationReadback,
} from "./deployment-migrations.mjs";
import {
  validateWorkNotificationTokens,
  workNotificationsEnabled,
} from "../infrastructure/scripts/work-notifications.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
let inventoryPath;
let secretFilesPath;
let mode = "--check";
let modeSelected = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--inventory" && args[i + 1]) inventoryPath = args[++i];
  else if (args[i] === "--secret-files" && args[i + 1]) secretFilesPath = args[++i];
  else if (["--check", "--preflight", "--migrate", "--workers", "--apply"].includes(args[i])) {
    if (modeSelected) throw new Error("choose one Cloudflare deployment mode");
    mode = args[i];
    modeSelected = true;
  } else throw new Error("Usage: node scripts/deploy-cloudflare.mjs --inventory <private-inventory.json> --secret-files <private-manifest.json> [--check|--preflight|--migrate|--workers|--apply]");
}
if (!inventoryPath || !secretFilesPath) throw new Error("--inventory and --secret-files are required");
const input = readInventory(inventoryPath);
if (input.errors.length || input.blockers.length) {
  throw new Error("incomplete deployment inventory: " + [...input.errors, ...input.blockers].join("; "));
}
const inventory = input.inventory;
const remoteDisposable = inventory.environment === "disposable-test" &&
  inventory.cloudflare.mode === "remote-disposable";
if (!path.isAbsolute(secretFilesPath)) throw new Error("--secret-files must be an absolute path");
const secretMeta = lstatSync(secretFilesPath);
if (!secretMeta.isFile() || secretMeta.isSymbolicLink() ||
    (process.platform !== "win32" && (secretMeta.mode & 0o077) !== 0) ||
    (remoteDisposable && secretMeta.uid !== process.getuid())) {
  throw new Error("--secret-files must be a private regular file");
}
const privateManifest = JSON.parse(readFileSync(secretFilesPath, "utf8"));
if (privateManifest.apiVersion !== "praetorium.io/secret-files/v1" || !privateManifest.values) {
  throw new Error("private secret-files manifest has invalid schema");
}
if (remoteDisposable) {
  const manifestDirectory = lstatSync(path.dirname(secretFilesPath));
  if (
    !manifestDirectory.isDirectory() || manifestDirectory.isSymbolicLink() ||
    manifestDirectory.uid !== process.getuid() || (manifestDirectory.mode & 0o077) !== 0 ||
    !path.dirname(secretFilesPath).split(path.sep).includes(inventory.ownership.clusterName) ||
    privateManifest.environment !== "remote-disposable" ||
    privateManifest.clusterName !== inventory.ownership.clusterName ||
    Object.keys(privateManifest).sort().join("\0") !==
      ["apiVersion", "clusterName", "environment", "values"].sort().join("\0") ||
    Object.keys(privateManifest.values).sort().join("\0") !==
      [...remoteDisposableSecretRoles].sort().join("\0")
  ) {
    throw new Error("remote-disposable secret manifest must be exact and bound to the named T14 cluster");
  }
}
function privateBytes(role) {
  const filename = privateManifest.values[role];
  if (typeof filename !== "string" || !path.isAbsolute(filename)) throw new Error(role + " requires an absolute file");
  const meta = lstatSync(filename);
  if (!meta.isFile() || meta.isSymbolicLink() ||
      (process.platform !== "win32" && (meta.mode & 0o077) !== 0) ||
      (remoteDisposable && meta.uid !== process.getuid())) {
    throw new Error(role + " must use a private regular file");
  }
  if (remoteDisposable) {
    const directory = path.dirname(filename);
    const directoryMeta = lstatSync(directory);
    if (!directoryMeta.isDirectory() || directoryMeta.isSymbolicLink() ||
        directoryMeta.uid !== process.getuid() ||
        (directoryMeta.mode & 0o077) !== 0 ||
        !directory.split(path.sep).includes(inventory.ownership.clusterName)) {
      throw new Error(role + " must be below the owner-private T14 secret directory");
    }
  }
  const bytes = readFileSync(filename);
  if (!bytes.length) throw new Error(role + " secret is empty");
  return bytes;
}
if (remoteDisposable) {
  assertRemoteDisposableSecretMaterials(privateBytes);
  const appId = String(inventory.gateway.githubAppId ?? "");
  if (!appId || appId === "5355765" || inventory.gateway.githubOauthClientId === "Iv23liUxWil9dmhuYJuA") {
    throw new Error("remote-disposable Gateway must use its test-only GitHub App and OAuth application");
  }
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
    registryPull: privateBytes("buildWorkerRegistryPull"),
    registryPush: privateBytes("buildWorkerRegistryPush"),
    registryHost: new URL(inventory.buildPolicy.registryUrl).host,
  });
}
if (!remoteDisposable &&
    (inventory.environment !== "deployment" || inventory.cloudflare.mode !== "remote")) {
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
  admin: path.join(generated, "admin.json"),
};
try {
  const workerTemplates = remoteDisposable ? [
    ["control", "control-plane.template.json"],
    ["gateway", "gateway.template.json"],
  ] : [
    ["control", "control-plane.template.json"],
    ["gateway", "gateway.template.json"],
    ["admin", "admin.template.json"],
  ];
  for (const [key, name] of workerTemplates) {
    const original = readFileSync(path.join(root, "infrastructure/workers", name), "utf8");
    const config = JSON.parse(renderWorkerTemplate(original, inventory, key === "control" ? "control-plane" : key));
    config.account_id = inventory.cloudflare.accountId;
    // Generated configs live in a private subdirectory; make source and migration paths relative to it.
    config.main = path.relative(generated, path.join(root, "apps", key === "control" ? "control-plane" : key, "src/worker.ts")).replaceAll(path.sep, "/");
    for (const database of config.d1_databases ?? []) {
      if (database.binding === "CONTROL_PLANE_DB") {
        database.migrations_dir = path.relative(generated, path.join(root, "apps/control-plane/migrations")).replaceAll(path.sep, "/");
      }
    }
    writeFileSync(conf[key], JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  }
  if (!remoteDisposable && inventory.gateway.adminObserverVpcServiceId && !privateManifest.values.adminObserverToken)
    throw new Error("Admin observer VPC requires the independent adminObserverToken source");
  const required = remoteDisposable ? {
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
      "PROVISIONER_AUTH_TOKEN", "BUILD_WORKER_AUTH_TOKEN", "REGISTRY_PULL_CREDENTIAL",
      "RELEASE_OPERATOR_TOKEN",
    ],
  } : {
    [conf.gateway]: [
      "GITHUB_APP_PRIVATE_KEY", "GITHUB_OAUTH_CLIENT_SECRET", "GATEWAY_GITHUB_WEBHOOK_SECRET",
      "GATEWAY_SIGNING_KEY", "CONTROL_PLANE_GATEWAY_AUTH", "RUNTIME_CREDENTIAL_RETIREMENT_AUTH",
      "INSTANCE_ACCESS_SERVICE_AUTH_TOKEN", "GATEWAY_SESSION_DIGEST_PEPPER",
      "GATEWAY_CREDENTIAL_DIGEST_PEPPER", "GATEWAY_HANDOFF_DIGEST_PEPPER",
      "GATEWAY_TOKEN_ENCRYPTION_KEY",
    ],
    [conf.admin]: [
      "ADMIN_CONTROL_PLANE_AUTH",
      ...(inventory.gateway.adminObserverVpcServiceId ? ["ADMIN_OBSERVER_AUTH"] : []),
    ],
    [conf.control]: [
      "ADMIN_CONTROL_PLANE_AUTH", "CONTROL_PLANE_GATEWAY_AUTH", "RUNTIME_CREDENTIAL_RETIREMENT_AUTH",
      "RUNTIME_CONTROL_SIGNING_KEY", "RUNTIME_IDENTITY_SIGNING_KEY",
    ],
  };
  const checkRemoteSecrets = !(remoteDisposable && mode === "--apply");
  if (checkRemoteSecrets) {
    for (const [config, names] of Object.entries(required)) {
      const existing = new Set(JSON.parse(wrangler(["secret", "list", "--config", config])).map((s) => s.name));
      const missing = names.filter((name) => !existing.has(name));
      if (missing.length) throw new Error("missing Worker Secrets for " + path.basename(config) + ": " + missing.join(", "));
    }
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
  const migrationDirectory = path.join(root, "apps/control-plane/migrations");
  const expectedMigrations = orderedMigrationFiles(migrationDirectory);
  const controlPlaneDatabase = conf.control && JSON.parse(readFileSync(conf.control, "utf8"))
    .d1_databases?.find((binding) => binding.binding === "CONTROL_PLANE_DB")?.database_name;
  if (typeof controlPlaneDatabase !== "string" || !controlPlaneDatabase) {
    throw new Error("generated Control Plane config is missing its D1 database name");
  }
  const readAppliedMigrations = () => {
    if (remoteDisposable) {
      const schemaOutput = wrangler([
        "d1", "execute", controlPlaneDatabase, "--remote",
        "--command", "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        "--json", "--config", conf.control,
      ]);
      const tables = parseD1TableReadback(schemaOutput);
      if (!tables.includes("d1_migrations")) {
        if (tables.length !== 0) {
          throw new Error("remote-disposable D1 contains tables without migration history");
        }
        return [];
      }
    }
    const output = wrangler([
      "d1", "execute", controlPlaneDatabase, "--remote",
      "--command", "SELECT name FROM d1_migrations ORDER BY id",
      "--json", "--config", conf.control,
    ]);
    return parseAppliedMigrationReadback(output);
  };
  const migrationReadback = () => {
    const appliedMigrations = readAppliedMigrations();
    assertMigrationReadback(expectedMigrations, appliedMigrations);
    console.log("Remote D1 migration history matches this checkout: " + expectedMigrations.join(", "));
  };
  const compatibleMigrationPreflight = () => {
    const appliedMigrations = readAppliedMigrations();
    assertCompatibleMigrationHistory(expectedMigrations, appliedMigrations);
    console.log("Remote D1 migration history is a compatible subset of this checkout.");
  };
  const applyMigrations = () => {
    applyMigrationsWithPreflight(
      expectedMigrations,
      readAppliedMigrations,
      () => wrangler(["d1", "migrations", "apply", controlPlaneDatabase, "--remote",
        "--config", conf.control], { capture: false }),
    );
    console.log("Remote D1 migration history matches this checkout: " + expectedMigrations.join(", "));
  };
  if (mode === "--check") {
    migrationReadback();
    console.log("No Cloudflare resource mutated.");
  } else if (mode === "--preflight") {
    compatibleMigrationPreflight();
    console.log("Cloudflare resource/secret and D1 migration preflight passed; no resource changed.");
  } else {
    if (mode === "--workers") migrationReadback();
    run("corepack", ["pnpm@11.18.0", "install", "--frozen-lockfile"], { capture: false });
    if (mode === "--migrate" || mode === "--apply") applyMigrations();
    if (mode === "--migrate") {
      console.log("D1 migrations applied and read back; no Worker or Kubernetes workload was deployed.");
    } else {
      run("corepack", ["pnpm@11.18.0", "build"], { capture: false });
      // Deploy the approved code and existing token bytes together. Standalone secret
      // edits can activate code early or fail when an undeployed version exists.
      const secretFiles = remoteDisposable
        ? writeRemoteDisposableWorkerDeploymentSecrets({ directory: generated, privateBytes })
        : writeWorkerDeploymentSecrets({
            directory: generated, privateBytes, notificationsEnabled,
            hasReleaseOperatorToken: Boolean(privateManifest.values.releaseOperatorToken),
            hasAdminCredential: Boolean(privateManifest.values.adminControlPlaneAuth),
            hasObserverCredential: Boolean(privateManifest.values.adminObserverToken),
          });
      if (!remoteDisposable && !secretFiles.admin)
        throw new Error("Admin dedicated service credential is required");
      wrangler(["deploy", "--config", conf.control, "--secrets-file", secretFiles.control], { capture: false });
      wrangler(["deploy", "--config", conf.gateway, "--secrets-file", secretFiles.gateway], { capture: false });
      if (!remoteDisposable) {
        // The Admin custom domain has exactly one owner. Gateway must be updated
        // before Admin attaches it; no fallback through unauthenticated Gateway routes.
        wrangler(["deploy", "--config", conf.admin, "--secrets-file", secretFiles.admin], { capture: false });
      }
      const healthChecks = [
        [inventory.domains.controlPlaneUrl, "/healthz"],
        [inventory.domains.gatewayOrigin, "/healthz"],
        [inventory.domains.gatewayOrigin, "/auth/login"],
        [inventory.domains.gatewayOrigin, "/.well-known/jwks.json"],
        ...(!remoteDisposable ? [[inventory.gateway.adminOrigin, "/healthz"]] : []),
      ];
      for (const [origin, endpoint] of healthChecks) {
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
      console.log(remoteDisposable
        ? "Remote-disposable Control Plane and Gateway Workers verified (no production routes or bindings deployed)."
        : "Cloudflare Worker deployment verified (K3s and hosted end-to-end checks separate).");
    }
  }
} finally {
  rmSync(generated, { recursive: true, force: true });
}
