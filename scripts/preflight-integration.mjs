#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const categories = [
  "workers-d1-do",
  "github-access",
  "buildkit-registry",
  "kubernetes-isolation",
  "browser-entry",
  "producer-recovery",
  "stable-rollout",
];

function usage() {
  process.stderr.write(
    "Usage: node scripts/preflight-integration.mjs --environment <owned-inventory.json> [--plan]\n",
  );
}

function parseArgs(argv) {
  const result = { environment: null, plan: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--plan") result.plan = true;
    else if (arg === "--environment" && argv[index + 1]) result.environment = argv[++index];
    else throw new Error(`unknown or incomplete argument: ${arg}`);
  }
  if (!result.environment) throw new Error("--environment must name an explicit owned inventory");
  return result;
}

function exactKeys(object, expected, name, errors) {
  if (!object || typeof object !== "object" || Array.isArray(object)) {
    errors.push(`${name} must be an object`);
    return;
  }
  const actual = Object.keys(object).sort();
  const wanted = [...expected].sort();
  if (actual.join("\0") !== wanted.join("\0")) {
    errors.push(`${name} must contain exactly: ${wanted.join(", ")}`);
  }
}

function nonEmpty(value, field, errors) {
  if (typeof value !== "string" || value.trim() === "") errors.push(`${field} must be a non-empty string`);
}

function validateInventory(value) {
  const errors = [];
  const blocked = [];
  exactKeys(value, ["schemaVersion", "inventoryId", "owner", "environment", "resources"], "inventory", errors);
  if (value.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  nonEmpty(value.inventoryId, "inventoryId", errors);

  exactKeys(value.owner, ["name", "identity"], "owner", errors);
  nonEmpty(value.owner?.name, "owner.name", errors);
  nonEmpty(value.owner?.identity, "owner.identity", errors);
  const ownerIdentity = value.owner?.identity;
  if (/operator-supplied|to be recorded|placeholder|replace/i.test(ownerIdentity ?? "")) {
    blocked.push("inventory owner identity has not been recorded");
  }

  exactKeys(
    value.environment,
    ["name", "purpose", "disposable", "production", "expiresAt", "cleanupProcedure"],
    "environment",
    errors,
  );
  nonEmpty(value.environment?.name, "environment.name", errors);
  if (value.environment?.purpose !== "t14-disposable-test") errors.push("environment.purpose must be t14-disposable-test");
  if (value.environment?.disposable !== true) errors.push("environment.disposable must be true");
  if (value.environment?.production !== false) errors.push("environment.production must be false");
  const expiresAt = value.environment?.expiresAt ?? "";
  const expiry = Date.parse(expiresAt);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(expiresAt) || !Number.isFinite(expiry)) {
    errors.push("environment.expiresAt must be a date-time with an explicit timezone");
  }
  else if (expiry <= Date.now()) blocked.push("owned test inventory has expired");
  nonEmpty(value.environment?.cleanupProcedure, "environment.cleanupProcedure", errors);

  exactKeys(value.resources, categories, "resources", errors);
  for (const category of categories) {
    const resource = value.resources?.[category];
    exactKeys(resource, ["state", "owner", "disposable", "production", "reference"], `resources.${category}`, errors);
    if (resource?.state !== "available" && resource?.state !== "missing") {
      errors.push(`resources.${category}.state must be available or missing`);
    }
    if (resource?.owner !== ownerIdentity) errors.push(`resources.${category}.owner must match owner.identity`);
    if (resource?.disposable !== true) errors.push(`resources.${category}.disposable must be true`);
    if (resource?.production !== false) errors.push(`resources.${category}.production must be false`);
    if (resource?.state === "missing") {
      if (resource.reference !== null) errors.push(`resources.${category}.reference must be null while missing`);
      blocked.push(`owned resource ${category} is missing`);
    }
    if (resource?.state === "available") {
      nonEmpty(resource.reference, `resources.${category}.reference`, errors);
    }
  }
  return { errors, blocked };
}

function loadInventory(file) {
  const absolute = path.resolve(file);
  const inventory = JSON.parse(readFileSync(absolute, "utf8"));
  return { absolute, inventory, ...validateInventory(inventory) };
}

function report(inventory, errors, blocked, plan) {
  const categoriesReport = Object.fromEntries(
    categories.map((category) => [
      category,
      {
        status: inventory.resources?.[category]?.state === "available" ? "NOT_CHECKED" : "BLOCKED",
        resource: inventory.resources?.[category]?.reference ?? null,
      },
    ]),
  );
  const result = {
    inventoryId: inventory.inventoryId,
    ownerIdentity: inventory.owner?.identity ?? null,
    environment: inventory.environment?.name ?? null,
    planOnly: plan,
    sideEffects: [],
    categories: categoriesReport,
    errors,
    blocked,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

try {
  const args = parseArgs(process.argv.slice(2));
  const { inventory, errors: readErrors, blocked: readBlocked } = loadInventory(args.environment);
  const blocked = [...readBlocked];
  if (!args.plan) {
    // This preflight deliberately does not inspect the caller's current Kubernetes context.
    // The T14 runner performs exact explicit-context ownership checks before it executes a category.
    for (const category of categories) {
      if (inventory.resources?.[category]?.state === "available") {
        blocked.push(`${category} is declared available but has no verified execution evidence`);
      }
    }
  }
  report(inventory, readErrors, blocked, args.plan);
  if (readErrors.length > 0 || blocked.length > 0) process.exitCode = 2;
} catch (error) {
  usage();
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
}
