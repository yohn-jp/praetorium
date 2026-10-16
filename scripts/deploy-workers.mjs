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
    .replaceAll("@@PLATFORM_DATABASE_ID@@", inventory.cloudflare.platformDatabaseId)
    .replaceAll("@@GATEWAY_AUTH_DATABASE_ID@@", inventory.cloudflare.gatewayAuthDatabaseId);
}

function checkPaths() {
  const paths = [
    "apps/control-plane/src/worker.ts",
    "apps/gateway/src/worker.ts",
    "packages/persistence/migrations",
    "apps/gateway/migrations",
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
      databaseBindings: ["PLATFORM_DB", "GATEWAY_AUTH_DB"],
      serviceBinding: "GATEWAY.CONTROL_PLANE -> praetorium-control-plane",
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
      for (const [templateName, configName] of [
        ["control-plane.template.json", "control-plane.json"],
        ["gateway.template.json", "gateway.json"],
      ]) {
        const template = readFileSync(path.join(templatesDir, templateName), "utf8");
        const configPath = path.join(templatesDir, `.runtime-${process.pid}-${randomUUID()}-${configName}`);
        writeFileSync(configPath, render(template, inventory), { mode: 0o600 });
        configs.push(configPath);
      }
      for (const [database, config] of [
        ["praetorium-platform", configs[0]],
        ["praetorium-gateway-auth", configs[1]],
      ]) {
        command(["exec", "wrangler", "d1", "migrations", "apply", database, "--local", "--persist-to", inventoryState, "--config", config]);
      }
      process.stdout.write(`${JSON.stringify({
        action: "apply-local",
        inventory: inventoryResult.absolutePath,
        owner: inventory.ownership.clusterName,
        databases: ["praetorium-platform", "praetorium-gateway-auth"],
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
