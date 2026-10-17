#!/usr/bin/env node

import { mkdtemp, open, readFile, realpath, rm } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_INVENTORY_BYTES = 64 * 1024;
const REQUIRED_CATEGORIES = Object.freeze([
  "workers-d1-do",
  "github-access",
  "buildkit-registry",
  "kubernetes-isolation",
  "browser-entry",
  "producer-recovery",
  "stable-rollout",
]);

const CATEGORY_PLANS = Object.freeze({
  "workers-d1-do":
    "Run the production Worker bundle against owned local D1 and Durable Object bindings; exercise migrations, repository binding and coordination.",
  "github-access":
    "Use the owned test GitHub App, authorized test users and test repository to verify access decisions, scoped credential renewal and Git operations.",
  "buildkit-registry":
    "Build approved producer compositions in isolated BuildKit and round-trip immutable artifacts through the owned disposable registry.",
  "kubernetes-isolation":
    "Deploy into the owned disposable Kubernetes namespace and verify workload isolation, capacity, ingress and cleanup.",
  "browser-entry":
    "Use a real browser against the owned stable origin to verify direct entry, wake, handoff, cookies and retry behavior.",
  "producer-recovery":
    "Run the real producer image and exercise quiesce, recovery, re-clone and browser-journal reconciliation using producer evidence.",
  "stable-rollout":
    "Exercise stable and pinned rollout, canary failure, stale worker reports and preservation of the serving instance.",
});

const RUNNER_PATHS = Object.freeze({
  "workers-d1-do": "tests/integration/workers-d1-do.test.mjs",
  "github-access": "tests/integration/github-access.test.mjs",
  "buildkit-registry": "tests/integration/buildkit-registry.test.mjs",
  "kubernetes-isolation": "tests/integration/kubernetes-isolation.test.mjs",
  "browser-entry": "tests/e2e/browser-entry.test.mjs",
  "producer-recovery": "tests/integration/producer-recovery.test.mjs",
  "stable-rollout": "tests/integration/stable-rollout.test.mjs",
});

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value, keys) {
  return isRecord(value) && Object.keys(value).every((key) => keys.includes(key));
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isUnassigned(value) {
  return (
    !nonEmptyString(value) ||
    /^(?:unassigned|unknown|todo|fixture|example|not[- ]configured|operator-supplied before provisioning)$/i.test(
      value.trim(),
    )
  );
}

function parseCli(argv) {
  let planOnly = false;
  let inventoryPath;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--plan") {
      planOnly = true;
      continue;
    }
    if (argument === "--environment") {
      if (inventoryPath !== undefined || !argv[index + 1] || argv[index + 1].startsWith("--")) {
        throw new Error("--environment requires exactly one inventory path");
      }
      inventoryPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      return { help: true };
    }
    throw new Error(`unsupported argument: ${argument}`);
  }
  if (inventoryPath === undefined) {
    throw new Error("--environment <explicit-owned-test-inventory.json> is required");
  }
  return { planOnly, inventoryPath };
}

function validateInventory(inventory) {
  const errors = [];
  if (
    !hasOnlyKeys(inventory, ["schemaVersion", "inventoryId", "owner", "environment", "resources"])
  ) {
    return { errors: ["inventory must be an object with only the supported top-level fields"] };
  }
  if (inventory.schemaVersion !== 1) errors.push("schemaVersion must equal 1");
  if (!nonEmptyString(inventory.inventoryId)) errors.push("inventoryId must be a non-empty string");

  const owner = inventory.owner;
  if (!hasOnlyKeys(owner, ["name", "identity"])) {
    errors.push("owner must contain only name and identity");
  } else {
    if (isUnassigned(owner.name)) errors.push("owner.name must identify the environment owner");
    if (isUnassigned(owner.identity))
      errors.push("owner.identity must identify the environment owner");
  }

  const environment = inventory.environment;
  if (
    !hasOnlyKeys(environment, [
      "name",
      "purpose",
      "disposable",
      "production",
      "expiresAt",
      "cleanupProcedure",
    ])
  ) {
    errors.push(
      "environment must contain only the supported identity, ownership, lifetime and cleanup fields",
    );
  } else {
    if (isUnassigned(environment.name))
      errors.push("environment.name must identify the test environment");
    if (environment.purpose !== "t14-disposable-test")
      errors.push("environment.purpose must equal t14-disposable-test");
    if (environment.disposable !== true) errors.push("environment.disposable must be true");
    if (environment.production !== false)
      errors.push("environment.production must be explicitly false");
    if (!nonEmptyString(environment.cleanupProcedure))
      errors.push("environment.cleanupProcedure is required");
    const hasTimeZoneDateTime =
      typeof environment.expiresAt === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
        environment.expiresAt,
      );
    const expiry = hasTimeZoneDateTime ? Date.parse(environment.expiresAt) : NaN;
    if (!Number.isFinite(expiry) || expiry <= Date.now())
      errors.push("environment.expiresAt must be a future date-time with an explicit zone");
  }

  if (!hasOnlyKeys(inventory.resources, REQUIRED_CATEGORIES)) {
    errors.push("resources contains an unsupported category or is not an object");
  }
  if (isRecord(inventory.resources)) {
    for (const id of REQUIRED_CATEGORIES) {
      if (!Object.hasOwn(inventory.resources, id)) errors.push(`resources.${id} is required`);
    }
  }

  const categories = REQUIRED_CATEGORIES.map((id) => {
    const resource = isRecord(inventory.resources) ? inventory.resources[id] : undefined;
    if (resource === undefined) {
      return {
        id,
        status: "BLOCKED",
        proofStatus: "NOT_CHECKED",
        reason: "required resource category is missing",
      };
    }
    if (!isRecord(resource) || !["available", "missing"].includes(resource.state)) {
      errors.push(`${id} must have state available or missing`);
      return {
        id,
        status: "BLOCKED",
        proofStatus: "NOT_CHECKED",
        reason: "resource declaration is invalid",
      };
    }
    if (resource.state === "missing") {
      if (!hasOnlyKeys(resource, ["state", "owner", "disposable", "production", "reference"])) {
        errors.push(
          `${id} contains unsupported fields; inventories cannot supply commands or executables`,
        );
      }
      if (!isRecord(owner) || resource.owner !== owner.identity)
        errors.push(`${id}.owner must match owner.identity`);
      if (resource.disposable !== true) errors.push(`${id}.disposable must be true`);
      if (resource.production !== false) errors.push(`${id}.production must be explicitly false`);
      if (resource.reference !== null)
        errors.push(`${id}.reference must be null while the resource is missing`);
      return {
        id,
        status: "BLOCKED",
        proofStatus: "NOT_CHECKED",
        reason: "resource is declared missing",
      };
    }
    if (!hasOnlyKeys(resource, ["state", "owner", "disposable", "production", "reference"])) {
      errors.push(
        `${id} contains unsupported fields; inventories cannot supply commands or executables`,
      );
    }
    if (!isRecord(owner) || resource.owner !== owner.identity)
      errors.push(`${id}.owner must match owner.identity`);
    if (resource.disposable !== true) errors.push(`${id}.disposable must be true`);
    if (resource.production !== false) errors.push(`${id}.production must be explicitly false`);
    if (!nonEmptyString(resource.reference))
      errors.push(`${id}.reference must identify the owned resource`);
    return {
      id,
      status: "NOT_CHECKED",
      proofStatus: "NOT_CHECKED",
      reason: "inventory is an ownership declaration, not runtime evidence",
    };
  });

  if (errors.length > 0) {
    return {
      errors: [...new Set(errors)],
      categories: categories.map((category) =>
        category.status === "BLOCKED"
          ? category
          : {
              ...category,
              status: "BLOCKED",
              proofStatus: "NOT_CHECKED",
              reason: "inventory validation failed",
            },
      ),
    };
  }
  return { errors, categories };
}

function createReport({ inventoryId = null, mode, validation, runnerResults = null }) {
  const categories =
    validation.categories ??
    REQUIRED_CATEGORIES.map((id) => ({
      id,
      status: "NOT_CHECKED",
      proofStatus: "NOT_CHECKED",
      reason: "no valid environment inventory was loaded",
    }));
  const blocked =
    categories.some((category) => category.status === "BLOCKED") || validation.errors.length > 0;
  const runnerBlocked = runnerResults?.some((result) => result.status === "BLOCKED") ?? false;
  const failed = runnerResults?.some((result) => result.status === "FAILED") ?? false;
  const fullyVerified =
    runnerResults !== null &&
    runnerResults.length === REQUIRED_CATEGORIES.length &&
    runnerResults.every((result) => result.status === "VERIFIED");
  const status =
    blocked || runnerBlocked
      ? "BLOCKED"
      : failed
        ? "FAILED"
        : fullyVerified
          ? "VERIFIED"
          : "NOT_CHECKED";
  return {
    reportVersion: 1,
    task: "T14",
    status,
    mode,
    inventoryId,
    generatedAt: new Date().toISOString(),
    effectsExecuted:
      mode === "plan" ? false : (runnerResults?.some((result) => result.executed) ?? false),
    errors: validation.errors,
    categories: categories.map((category) => {
      const runner = runnerResults?.find((result) => result.id === category.id);
      return {
        ...category,
        ...(runner
          ? {
              status: runner.status,
              proofStatus: runner.status === "VERIFIED" ? "VERIFIED" : "NOT_CHECKED",
              runnerStatus: runner.status,
              runnerPath: RUNNER_PATHS[runner.id],
              runnerReason: runner.reason,
            }
          : {}),
      };
    }),
    intendedEffects: REQUIRED_CATEGORIES.map((id) => ({
      category: id,
      description: CATEGORY_PLANS[id],
    })),
  };
}

function createRunnerEnvironment(inventoryPath, category, isolatedHome, source = process.env) {
  return {
    PATH: source.PATH ?? "",
    ...(source.SystemRoot ? { SystemRoot: source.SystemRoot } : {}),
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    XDG_CONFIG_HOME: path.join(isolatedHome, ".config"),
    PRAETORIUM_T14_INVENTORY_PATH: inventoryPath,
    PRAETORIUM_T14_CATEGORY: category,
    PRAETORIUM_T14_RESULT_PATH: path.join(isolatedHome, "runner-result.json"),
  };
}

// A blocked prerequisite is distinct from a failed assertion. Only the fixed
// repository runner can write this per-process, owner-only result location.
// A sidecar can never promote a nonzero process to VERIFIED.
async function readRunnerResult(resultPath) {
  let handle;
  try {
    handle = await open(
      resultPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.size > 4096 ||
      (info.mode & 0o022) !== 0 ||
      (process.getuid && info.uid !== process.getuid())
    )
      return {};
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 4096) return {};
    return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
  } catch (error) {
    return error.code === "ENOENT" ? null : {};
  } finally {
    await handle?.close();
  }
}

function classifyRunnerResult(category, result, report = null) {
  if (result.error || result.signal || !Number.isInteger(result.status)) {
    return { status: "FAILED", reason: "fixed runner did not complete normally" };
  }
  if (report !== null) {
    const valid =
      hasOnlyKeys(report, ["reportVersion", "category", "status", "reason"]) &&
      report.reportVersion === 1 &&
      report.category === category &&
      ["BLOCKED", "FAILED"].includes(report.status) &&
      typeof report.reason === "string" &&
      report.reason.length > 0 &&
      report.reason.length <= 512 &&
      [...report.reason].every(
        (character) => character.codePointAt(0) >= 32 && character.codePointAt(0) !== 127,
      );
    if (!valid || result.status === 0) {
      return {
        status: "FAILED",
        reason: "fixed runner outcome report is invalid or contradicts its exit",
      };
    }
    return { status: report.status, reason: report.reason };
  }
  return result.status === 0
    ? { status: "VERIFIED", reason: "fixed acceptance runner passed" }
    : { status: "FAILED", reason: `fixed runner exited with status ${result.status}` };
}

async function readInventory(inventoryPath) {
  const resolvedPath = path.resolve(process.cwd(), inventoryPath);
  const actualPath = await realpath(resolvedPath);
  const contents = await readFile(actualPath);
  if (contents.byteLength > MAX_INVENTORY_BYTES) throw new Error("inventory exceeds 64 KiB");
  let parsed;
  try {
    parsed = JSON.parse(contents.toString("utf8"));
  } catch {
    throw new Error("inventory is not valid JSON");
  }
  return parsed;
}

async function executeFixedRunners(categories, inventoryPath) {
  const results = [];
  for (const category of categories) {
    if (category.status === "BLOCKED") {
      results.push({
        id: category.id,
        status: "BLOCKED",
        executed: false,
        reason: category.reason,
      });
      continue;
    }
    const declaredRunnerPath = path.resolve(REPOSITORY_ROOT, RUNNER_PATHS[category.id]);
    if (!declaredRunnerPath.startsWith(`${REPOSITORY_ROOT}${path.sep}`)) {
      results.push({
        id: category.id,
        status: "BLOCKED",
        executed: false,
        reason: "runner path escaped the repository",
      });
      continue;
    }
    let runnerPath;
    try {
      runnerPath = await realpath(declaredRunnerPath);
    } catch {
      results.push({
        id: category.id,
        status: "BLOCKED",
        executed: false,
        reason: "fixed acceptance runner is not present at this HEAD",
      });
      continue;
    }
    if (!runnerPath.startsWith(`${REPOSITORY_ROOT}${path.sep}`)) {
      results.push({
        id: category.id,
        status: "BLOCKED",
        executed: false,
        reason: "fixed acceptance runner resolves outside the repository",
      });
      continue;
    }
    const isolatedHome = await mkdtemp(path.join(os.tmpdir(), "praetorium-t14-home-"));
    let result;
    let outcome;
    try {
      result = spawnSync(process.execPath, ["--test", runnerPath], {
        cwd: REPOSITORY_ROOT,
        env: createRunnerEnvironment(inventoryPath, category.id, isolatedHome),
        encoding: "utf8",
        stdio: "ignore",
        shell: false,
      });
      outcome = classifyRunnerResult(
        category.id,
        result,
        await readRunnerResult(path.join(isolatedHome, "runner-result.json")),
      );
    } finally {
      await rm(isolatedHome, { recursive: true, force: true });
    }
    if (result.error) {
      results.push({
        id: category.id,
        status: "FAILED",
        executed: false,
        reason: "fixed runner could not start",
      });
    } else {
      results.push({
        id: category.id,
        executed: true,
        ...outcome,
      });
    }
  }
  return results;
}

async function main(argv = process.argv.slice(2)) {
  let cli;
  try {
    cli = parseCli(argv);
  } catch (error) {
    const validation = { errors: [error.message] };
    const report = createReport({ mode: "preflight", validation });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 2;
  }
  if (cli.help) {
    process.stdout.write(
      "Usage: node scripts/verify-integration.mjs --environment <explicit-owned-test-inventory.json> [--plan]\n",
    );
    return 0;
  }

  let inventory;
  try {
    inventory = await readInventory(cli.inventoryPath);
  } catch (error) {
    const validation = { errors: [`cannot load environment inventory: ${error.message}`] };
    const report = createReport({ mode: cli.planOnly ? "plan" : "run", validation });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 2;
  }

  const validation = validateInventory(inventory);
  const inventoryPath = await realpath(path.resolve(process.cwd(), cli.inventoryPath));
  const runnerResults =
    !cli.planOnly && validation.errors.length === 0
      ? await executeFixedRunners(validation.categories, inventoryPath)
      : null;
  const report = createReport({
    inventoryId: nonEmptyString(inventory?.inventoryId) ? inventory.inventoryId : null,
    mode: cli.planOnly ? "plan" : "run",
    validation,
    runnerResults,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  if (
    validation.errors.length > 0 ||
    validation.categories.some((category) => category.status === "BLOCKED")
  )
    return 2;
  if (cli.planOnly) return 0;
  if (runnerResults?.some((result) => result.status === "BLOCKED" || result.status === "FAILED"))
    return 2;
  return runnerResults?.every((result) => result.status === "VERIFIED") ? 0 : 3;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 2;
    });
}

export {
  CATEGORY_PLANS,
  REQUIRED_CATEGORIES,
  createReport,
  createRunnerEnvironment,
  classifyRunnerResult,
  parseCli,
  validateInventory,
};
