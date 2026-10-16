#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readInventory } from "../infrastructure/scripts/inventory.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templatesDir = path.join(repoRoot, "infrastructure/workers");

function usage() {
  process.stderr.write(`Usage:
  node scripts/deploy-workers.mjs plan --inventory <file>
  node scripts/deploy-workers.mjs preflight --inventory <file>
  node scripts/deploy-workers.mjs apply-local --inventory <file> --confirm <cluster-name>
`);
}

function parseArgs(argv) {
  const [action, ...rest] = argv;
  if (!["plan", "preflight", "apply-local"].includes(action)) {
    throw new Error("action must be plan, preflight, or apply-local");
  }
  const result = { action, inventoryPath: null, confirmation: null };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--inventory" && rest[index + 1]) result.inventoryPath = rest[++index];
    else if (argument === "--confirm" && rest[index + 1]) result.confirmation = rest[++index];
    else throw new Error(`unknown or incomplete argument: ${argument}`);
  }
  if (!result.inventoryPath) throw new Error("--inventory must name the owned inventory explicitly");
  if (action === "apply-local" && !result.confirmation) throw new Error("apply-local requires the exact disposable cluster name with --confirm");
  return result;
}

function validate(file) {
  const result = readInventory(file);
  if (result.errors.length > 0) throw new Error(`inventory is invalid:\n- ${result.errors.join("\n- ")}`);
  const { inventory } = result;
  if (inventory.environment !== "disposable-test" || inventory.cloudflare.mode !== "local") {
    throw new Error("Worker migration application is restricted to disposable-test with Cloudflare local mode");
  }
  if (!inventory.ownership.disposable || inventory.ownership.context !== `kind-${inventory.ownership.clusterName}`) {
    throw new Error("inventory does not declare an explicit disposable Kind owner");
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,51}[a-z0-9])?$/.test(inventory.ownership.clusterName)) {
    throw new Error("ownership.clusterName must be DNS-safe");
  }
  return result;
}

function render(template, inventory) {
  return template
    .replaceAll("@@CONTROL_PLANE_DATABASE_ID@@", inventory.cloudflare.controlPlaneDatabaseId)
    .replaceAll("@@GATEWAY_KV_NAMESPACE_ID@@", inventory.cloudflare.gatewayKvNamespaceId);
}

function checkPaths() {
  const paths = [
    "apps/control-plane/src/worker.ts",
    "apps/gateway/src/worker.ts",
    "apps/control-plane/migrations",
  ];
  return Object.fromEntries(paths.map((entry) => [entry, existsSync(path.join(repoRoot, entry))]));
}

function command(args, options = {}) {
  const result = spawnSync("pnpm", args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, CI: "true" },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeout ?? 120_000,
  });
  if (result.error) throw new Error(`pnpm is unavailable: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`pnpm ${args.join(" ")} failed (${result.status}): ${(result.stderr || result.stdout).trim()}`);
  return result.stdout;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const inventoryResult = validate(args.inventoryPath);
  const { inventory } = inventoryResult;
  const paths = checkPaths();
  const missing = Object.entries(paths).filter(([, present]) => !present).map(([entry]) => entry);

  if (args.action === "plan") {
    process.stdout.write(`${JSON.stringify({
      action: "plan",
      inventory: inventoryResult.absolutePath,
      environment: inventory.environment,
      databaseBindings: ["CONTROL_PLANE_DB"],
      gatewayKvBinding: "GATEWAY_KV",
      durableObjectBindings: ["REPOSITORY_COORDINATOR", "USER_AUTH_STATE", "EPHEMERAL_CODES"],
      serviceBinding: "GATEWAY.CONTROL_PLANE -> praetorium-control-plane",
      requiredGatewayVariables: [
        "GATEWAY_ORIGIN",
        "GATEWAY_INSTANCE_HOSTNAME_SUFFIX",
        "GATEWAY_ALLOWED_REPOSITORY_OWNER",
        "GITHUB_APP_ID",
        "GITHUB_OAUTH_CLIENT_ID",
      ],
      requiredWorkerSecrets: {
        controlPlane: ["CONTROL_PLANE_GATEWAY_AUTH"],
        gateway: [
          "GITHUB_OAUTH_CLIENT_SECRET",
          "CONTROL_PLANE_GATEWAY_AUTH",
          "INSTANCE_ACCESS_SERVICE_AUTH_TOKEN",
          "GATEWAY_SESSION_DIGEST_PEPPER",
          "GATEWAY_CREDENTIAL_DIGEST_PEPPER",
          "GATEWAY_HANDOFF_DIGEST_PEPPER",
          "GATEWAY_TOKEN_ENCRYPTION_KEY",
          "GATEWAY_SIGNING_KEY",
        ],
      },
      optionalProvisionerRoute: {
        secret: "PROVISIONER_AUTH_TOKEN",
        variables: [
          "PROVISIONER_WORKER_ID",
          "PROVISIONER_CLUSTER_ID",
          "GATEWAY_ORIGIN",
          "CONTROL_PLANE_ORIGIN",
          "INSTANCE_HOST_SUFFIX",
          "RUNTIME_REGISTRY_HOST",
          "GIT_CREDENTIAL_BROKER_LOCATOR",
        ],
      },
      actions: ["apply only local D1 migrations", "keep all local D1 state under the disposable inventory directory"],
      remoteCalls: false,
      missingProjectInputs: missing,
      sideEffects: [],
    }, null, 2)}\n`);
    if (missing.length > 0) process.exitCode = 2;
  } else if (args.action === "preflight") {
    const pnpm = spawnSync("pnpm", ["exec", "wrangler", "--version"], { cwd: repoRoot, encoding: "utf8", stdio: "ignore", timeout: 10_000 });
    const blocked = [...missing];
    if (pnpm.error || pnpm.status !== 0) blocked.push("workspace Wrangler executable is unavailable");
    process.stdout.write(`${JSON.stringify({
      action: "preflight",
      inventory: inventoryResult.absolutePath,
      cloudflareMode: inventory.cloudflare.mode,
      files: paths,
      wranglerAvailable: !pnpm.error && pnpm.status === 0,
      blocked,
      remoteCalls: false,
    }, null, 2)}\n`);
    if (blocked.length > 0) process.exitCode = 2;
  } else {
    if (args.confirmation !== inventory.ownership.clusterName) throw new Error(`--confirm must exactly equal ${inventory.ownership.clusterName}`);
    if (missing.length > 0) throw new Error(`local Worker inputs are missing:\n- ${missing.join("\n- ")}`);
    const pnpm = spawnSync("pnpm", ["exec", "wrangler", "--version"], { cwd: repoRoot, encoding: "utf8", stdio: "ignore", timeout: 10_000 });
    if (pnpm.error || pnpm.status !== 0) throw new Error("apply-local requires the workspace Wrangler executable");

    const inventoryState = path.join(os.tmpdir(), "praetorium-t12-workers", inventory.ownership.clusterName);
    const configs = [];
    try {
      const template = readFileSync(path.join(templatesDir, "control-plane.template.json"), "utf8");
      const configPath = path.join(templatesDir, `.runtime-${process.pid}-${randomUUID()}-control-plane.json`);
      writeFileSync(configPath, render(template, inventory), { mode: 0o600 });
      configs.push(configPath);
      command(["exec", "wrangler", "d1", "migrations", "apply", "praetorium-platform", "--local", "--persist-to", inventoryState, "--config", configPath]);
      process.stdout.write(`${JSON.stringify({
        action: "apply-local",
        inventory: inventoryResult.absolutePath,
        owner: inventory.ownership.clusterName,
        databases: ["praetorium-platform"],
        gatewayKv: "local Worker binding; no D1 migration",
        persistenceDirectory: inventoryState,
        remoteCalls: false,
        sideEffects: ["local D1 migration state was created or updated"],
      }, null, 2)}\n`);
    } finally {
      for (const config of configs) rmSync(config, { force: true });
    }
  }
} catch (error) {
  usage();
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
}
