import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateInventory } from "../scripts/inventory.mjs";
import { buildPolicy } from "../scripts/worker-config.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const inventoryPath = path.join(repoRoot, "infrastructure/test/disposable-inventory.json");
const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));

function planForInventory(value) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "praetorium-worker-plan-"));
  const file = path.join(directory, "inventory.json");
  try {
    writeFileSync(file, JSON.stringify(value));
    return spawnSync(
      process.execPath,
      ["scripts/deploy-workers.mjs", "plan", "--inventory", file],
      { cwd: repoRoot, encoding: "utf8" },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const cacheRetentionFields = ["maxBytes", "maxEntries", "minAgeMs", "maxEvictions"];

test("checked-in disposable inventory leaves T11 canary policy disabled without fake evidence", () => {
  const result = validateInventory(inventory);
  assert.deepEqual(result.errors, []);
  assert.equal(inventory.releasePolicy.workerId, null);
  assert.deepEqual(inventory.releasePolicy.signerIdentityAllowlist, []);
  assert.equal(inventory.releasePolicy.canary.owner, null);
  assert.equal(inventory.releasePolicy.canary.disposable, true);
  assert.equal(inventory.releasePolicy.canary.production, false);
  assert.equal(inventory.releasePolicy.canary.requestedModules, null);
});

test("cache retention requires four bounded operator inputs without guessed values", () => {
  const result = validateInventory(inventory);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(inventory.buildPolicy.cacheRetention, {
    maxBytes: null,
    maxEntries: null,
    minAgeMs: null,
    maxEvictions: null,
  });
  for (const field of cacheRetentionFields) {
    assert.ok(
      result.blockers.includes(`buildPolicy.cacheRetention.${field} has not been supplied`),
    );
  }

  const validBoundaries = structuredClone(inventory);
  validBoundaries.buildPolicy.cacheRetention = {
    maxBytes: 0,
    maxEntries: 1,
    minAgeMs: 0,
    maxEvictions: 1,
  };
  assert.deepEqual(validateInventory(validBoundaries).errors, []);
  const maximums = structuredClone(inventory);
  maximums.buildPolicy.cacheRetention = {
    maxBytes: Number.MAX_SAFE_INTEGER,
    maxEntries: Number.MAX_SAFE_INTEGER,
    minAgeMs: Number.MAX_SAFE_INTEGER,
    maxEvictions: 32,
  };
  assert.deepEqual(validateInventory(maximums).errors, []);

  const bounds = {
    maxBytes: [0, Number.MAX_SAFE_INTEGER],
    maxEntries: [1, Number.MAX_SAFE_INTEGER],
    minAgeMs: [0, Number.MAX_SAFE_INTEGER],
    maxEvictions: [1, 32],
  };
  for (const [field, invalidValue] of [
    ["maxBytes", -1],
    ["maxEntries", 0],
    ["minAgeMs", -1],
    ["minAgeMs", 1.5],
    ["maxEvictions", 0],
    ["maxEvictions", 33],
    ["maxBytes", Number.MAX_SAFE_INTEGER + 1],
  ]) {
    const invalid = structuredClone(validBoundaries);
    invalid.buildPolicy.cacheRetention[field] = invalidValue;
    const [minimum, maximum] = bounds[field];
    assert.ok(
      validateInventory(invalid).errors.includes(
        `buildPolicy.cacheRetention.${field} must be a safe integer between ${minimum} and ${maximum}`,
      ),
      `${field}=${invalidValue} must be rejected`,
    );
  }
});

test("release policy rejects unsafe canary scope and reports partial operator configuration", () => {
  const productionCanary = structuredClone(inventory);
  productionCanary.releasePolicy.canary.production = true;
  assert.match(
    validateInventory(productionCanary).errors.join("\n"),
    /releasePolicy\.canary\.production must be false/u,
  );

  const partialPolicy = structuredClone(inventory);
  partialPolicy.releasePolicy.workerId = "release-worker";
  const result = validateInventory(partialPolicy);
  assert.deepEqual(result.errors, []);
  assert.ok(result.blockers.includes("T11 release operator actor ID has not been supplied"));
  assert.ok(result.blockers.includes("T11 disposable canary owner has not been supplied"));
  assert.ok(
    result.blockers.includes(
      "T11 trusted Sigstore signer identity allowlist has not been supplied",
    ),
  );
});

test("Worker plan reports exact secret surfaces and producer-blocked release gates without remote effects", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/deploy-workers.mjs", "plan", "--inventory", inventoryPath],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(result.status, 2, result.stderr);
  const plan = JSON.parse(result.stdout);

  assert.equal(plan.remoteCalls, false);
  assert.equal(plan.secretValuesInspected, false);
  assert.deepEqual(plan.sideEffects, []);
  assert.equal(plan.controlPlaneBuildPolicy.configured, false);
  assert.equal(plan.controlPlaneBuildPolicy.cacheRetention, null);
  for (const field of cacheRetentionFields) {
    assert.ok(
      plan.inventoryBlockers.includes(`buildPolicy.cacheRetention.${field} has not been supplied`),
    );
  }
  assert.deepEqual(plan.migrations, [
    "0001_repository_platform.sql",
    "0002_stable_release_rollouts.sql",
    "0003_staged_configurations.sql",
    "0004_runtime_git_credentials.sql",
    "0005_runtime_health_observations.sql",
    "0006_application_origins.sql",
  ]);
  assert.ok(plan.discoveredMigrations.includes("0004_runtime_git_credentials.sql"));
  assert.deepEqual(plan.serviceBindings, [
    "Control Plane GATEWAY_SERVICE -> praetorium-gateway",
    "Gateway CONTROL_PLANE -> praetorium-control-plane",
  ]);
  assert.ok(plan.requiredWorkerSecrets.controlPlane.includes("RUNTIME_CREDENTIAL_RETIREMENT_AUTH"));
  assert.ok(plan.requiredWorkerSecrets.gateway.includes("RUNTIME_CREDENTIAL_RETIREMENT_AUTH"));
  assert.deepEqual(plan.runtimeCredentialRetirement, {
    secret: "RUNTIME_CREDENTIAL_RETIREMENT_AUTH",
    requiredBy: ["controlPlane", "gateway"],
    valueSharedBetweenWorkers: true,
    format: "32-4096 non-space printable ASCII characters",
    distinctFrom: [
      "CONTROL_PLANE_GATEWAY_AUTH",
      "PROVISIONER_AUTH_TOKEN",
      "BUILD_WORKER_AUTH_TOKEN",
      "RELEASE_OPERATOR_TOKEN",
    ],
    nodeProvisionerSecretRequired: false,
    secretValuesInspected: false,
  });
  assert.ok(!plan.optionalProvisionerRoute.secrets.includes("RUNTIME_CREDENTIAL_RETIREMENT_AUTH"));
  assert.equal(plan.releasePolicy.configured, false);
  assert.equal(plan.releaseGates.scheduledCron, "*/5 * * * *");
  assert.match(plan.releaseGates.admission, /S01/u);
  assert.match(plan.releaseGates.canaryEvidence, /S02\/S05/u);
  assert.match(plan.releaseGates.promotion, /BLOCKED/u);
  assert.ok(plan.requiredWorkerSecrets.gateway.includes("GATEWAY_GITHUB_WEBHOOK_SECRET"));
  assert.ok(plan.requiredWorkerSecrets.gateway.includes("GITHUB_APP_PRIVATE_KEY"));
  assert.ok(plan.requiredWorkerSecrets.controlPlane.includes("RUNTIME_IDENTITY_SIGNING_KEY"));
  assert.ok(
    plan.optionalControlPlaneSecrets.some((secret) => secret.startsWith("RELEASE_OPERATOR_TOKEN")),
  );
  assert.ok(plan.workerVariables.controlPlane.includes("CONTROL_PLANE_ORIGIN"));
  assert.ok(plan.workerVariables.controlPlane.includes("RELEASE_POLICY_JSON"));
  assert.ok(plan.workerVariables.gateway.includes("CONTROL_PLANE_ORIGIN"));
  assert.deepEqual(plan.templateProblems, []);
});

test("enabled work notifications add the derived endpoints and dedicated Worker secret bindings", () => {
  const enabled = structuredClone(inventory);
  enabled.workNotifications = { enabled: true };
  enabled.secretRefs.provisionerWorkNotificationToken = {
    name: "praetorium-provisioner-work-notification-token",
    key: "token",
  };
  enabled.secretRefs.buildWorkerWorkNotificationToken = {
    name: "praetorium-build-worker-work-notification-token",
    key: "token",
  };
  const result = planForInventory(enabled);
  assert.equal(result.status, 2);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.remoteCalls, false);
  assert.deepEqual(plan.workNotifications, {
    enabled: true,
    endpoints: {
      provisioner: "https://notify-provisioner.instances.praetorium.localhost/internal/work-available",
      build: "https://notify-build.instances.praetorium.localhost/internal/work-available",
    },
    requiredSecrets: ["PROVISIONER_WORK_NOTIFICATION_TOKEN", "BUILD_WORK_NOTIFICATION_TOKEN"],
    tokenValuesInspected: false,
    delivery: "best-effort HTTPS POST; worker polling fallback remains bounded",
  });
  assert.ok(plan.workerVariables.controlPlane.includes("PROVISIONER_WORK_NOTIFICATION_URL"));
  assert.ok(plan.workerVariables.controlPlane.includes("BUILD_WORK_NOTIFICATION_URL"));
  assert.ok(plan.requiredWorkerSecrets.controlPlane.includes("PROVISIONER_WORK_NOTIFICATION_TOKEN"));
  assert.ok(plan.requiredWorkerSecrets.controlPlane.includes("BUILD_WORK_NOTIFICATION_TOKEN"));
});

test("Worker preflight recognizes credential retirement wiring without inspecting secret values", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/deploy-workers.mjs", "preflight", "--inventory", inventoryPath],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(result.status, 2, result.stderr);
  const preflight = JSON.parse(result.stdout);

  assert.deepEqual(preflight.expectedMigrations, [
    "0001_repository_platform.sql",
    "0002_stable_release_rollouts.sql",
    "0003_staged_configurations.sql",
    "0004_runtime_git_credentials.sql",
    "0005_runtime_health_observations.sql",
    "0006_application_origins.sql",
  ]);
  assert.ok(preflight.discoveredMigrations.includes("0004_runtime_git_credentials.sql"));
  assert.deepEqual(preflight.serviceBindings, [
    "Control Plane GATEWAY_SERVICE -> praetorium-gateway",
    "Gateway CONTROL_PLANE -> praetorium-control-plane",
  ]);
  assert.deepEqual(preflight.templateProblems, []);
  assert.ok(
    preflight.requiredWorkerSecrets.controlPlane.includes("RUNTIME_CREDENTIAL_RETIREMENT_AUTH"),
  );
  assert.ok(preflight.requiredWorkerSecrets.gateway.includes("RUNTIME_CREDENTIAL_RETIREMENT_AUTH"));
  assert.equal(preflight.runtimeCredentialRetirement.secretValuesInspected, false);
  assert.equal(preflight.secretValuesInspected, false);
  assert.equal(preflight.remoteCalls, false);
  assert.equal(preflight.controlPlaneBuildPolicy.configured, false);
  assert.equal(preflight.controlPlaneBuildPolicy.cacheRetention, null);
  for (const field of cacheRetentionFields) {
    assert.ok(
      preflight.blocked.includes(`buildPolicy.cacheRetention.${field} has not been supplied`),
    );
  }
  assert.ok(
    preflight.blocked.length > 0,
    "canonical disposable infrastructure inputs stay blocked",
  );
});

test("Worker plan includes cache retention only when all four controls are complete", () => {
  const complete = structuredClone(inventory);
  complete.buildkit.outputRepository = "ghcr.io/operator-owned/cache-retention-fixture";
  complete.buildkit.frontendRepository = "ghcr.io/operator-owned/producer-inputs";
  complete.buildWorker.compositionRepository = "operator-owned/compositions";
  complete.buildPolicy.targetPlatform = "linux/amd64";
  complete.buildPolicy.builderKeys = [
    {
      keyId: "retention-fixture-key",
      publicKeyBase64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      revoked: false,
      validFrom: null,
      validUntil: null,
    },
  ];
  complete.buildWorker.signingKeyId = "retention-fixture-key";
  complete.buildPolicy.cacheRetention = {
    maxBytes: 0,
    maxEntries: 1,
    minAgeMs: 0,
    maxEvictions: 32,
  };
  assert.deepEqual(validateInventory(complete).errors, []);
  assert.deepEqual(buildPolicy(complete).allowedRepositories, [
    "operator-owned/cache-retention-fixture",
    "operator-owned/producer-inputs",
    "operator-owned/compositions",
  ]);
  const completeResult = planForInventory(complete);
  assert.equal(completeResult.status, 2, completeResult.stderr);
  const completePlan = JSON.parse(completeResult.stdout);
  assert.equal(completePlan.controlPlaneBuildPolicy.configured, true);
  assert.deepEqual(
    completePlan.controlPlaneBuildPolicy.cacheRetention,
    complete.buildPolicy.cacheRetention,
  );

  const partial = structuredClone(complete);
  partial.buildPolicy.cacheRetention.maxEvictions = null;
  const partialResult = planForInventory(partial);
  assert.equal(partialResult.status, 2, partialResult.stderr);
  const partialPlan = JSON.parse(partialResult.stdout);
  assert.equal(partialPlan.controlPlaneBuildPolicy.configured, false);
  assert.equal(partialPlan.controlPlaneBuildPolicy.cacheRetention, null);
  assert.ok(
    partialPlan.inventoryBlockers.includes(
      "buildPolicy.cacheRetention.maxEvictions has not been supplied",
    ),
  );
});
