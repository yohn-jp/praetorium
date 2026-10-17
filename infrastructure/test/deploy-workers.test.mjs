import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateInventory } from "../scripts/inventory.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const inventoryPath = path.join(repoRoot, "infrastructure/test/disposable-inventory.json");
const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));

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
  assert.deepEqual(plan.migrations, [
    "0001_repository_platform.sql",
    "0002_stable_release_rollouts.sql",
    "0003_staged_configurations.sql",
    "0004_runtime_git_credentials.sql",
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
  assert.ok(
    preflight.blocked.length > 0,
    "canonical disposable infrastructure inputs stay blocked",
  );
});
