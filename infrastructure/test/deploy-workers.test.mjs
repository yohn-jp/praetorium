import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateInventory } from "../scripts/inventory.mjs";
import {
  buildPolicy,
  remoteDisposableRateLimitNamespaces,
  remoteDisposableWorkerNames,
  renderWorkerTemplate,
} from "../scripts/worker-config.mjs";
import { orderedMigrationFiles } from "../../scripts/deployment-migrations.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const inventoryPath = path.join(repoRoot, "infrastructure/test/disposable-inventory.json");
const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
const expectedMigrations = orderedMigrationFiles(path.join(repoRoot, "apps/control-plane/migrations"));

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

function remoteDisposableInventory() {
  const value = structuredClone(inventory);
  value.ownership.clusterName = "praetorium-t14-canary";
  value.ownership.context = "kind-praetorium-t14-canary";
  value.ownership.confirmation = value.ownership.clusterName;
  value.cloudflare = {
    mode: "remote-disposable",
    accountId: "a".repeat(32),
    controlPlaneDatabaseId: "11111111-1111-4111-8111-111111111111",
    gatewayKvNamespaceId: "b".repeat(32),
  };
  value.domains.controlPlaneUrl =
    "https://praetorium-t14-canary-control-plane.testaccount.workers.dev";
  value.domains.gatewayOrigin =
    "https://praetorium-t14-canary-gateway.testaccount.workers.dev";
  value.domains.gatewayServiceUrl = value.domains.gatewayOrigin;
  return value;
}

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

test("remote-disposable mode accepts only isolated T14 Worker, D1, KV, and workers.dev targets", () => {
  const isolated = remoteDisposableInventory();
  assert.deepEqual(validateInventory(isolated).errors, []);
  assert.deepEqual(remoteDisposableWorkerNames(isolated), {
    controlPlane: "praetorium-t14-canary-control-plane",
    gateway: "praetorium-t14-canary-gateway",
    database: "praetorium-t14-canary-control-plane",
    kvNamespace: "praetorium-t14-canary-gateway",
  });
  const rateLimitNamespaces = Object.values(remoteDisposableRateLimitNamespaces(isolated));
  assert.equal(new Set(rateLimitNamespaces).size, 6);
  assert.ok(rateLimitNamespaces.every((id) => ![761101, 761102, 761103, 761104, 761105, 761106].includes(id)));

  const productionD1 = structuredClone(isolated);
  productionD1.cloudflare.controlPlaneDatabaseId = "08f29fef-eb9e-4541-82fb-777fa2f4aab0";
  assert.match(validateInventory(productionD1).errors.join("\n"), /must not reference production D1 or KV/u);

  const productionKv = structuredClone(isolated);
  productionKv.cloudflare.gatewayKvNamespaceId = "770c4ac60df74b019409c1203f35687d";
  assert.match(validateInventory(productionKv).errors.join("\n"), /must not reference production D1 or KV/u);

  const wrongOrigin = structuredClone(isolated);
  wrongOrigin.domains.gatewayOrigin = "https://praetorium.yohn.jp";
  wrongOrigin.domains.gatewayServiceUrl = wrongOrigin.domains.gatewayOrigin;
  assert.match(validateInventory(wrongOrigin).errors.join("\n"), /matching workers.dev origin/u);

  const wrongPrefix = structuredClone(isolated);
  wrongPrefix.ownership.clusterName = "shared-control-plane";
  assert.match(validateInventory(wrongPrefix).errors.join("\n"), /bounded praetorium-t14- prefix/u);

  const sharedCoordination = structuredClone(isolated);
  sharedCoordination.workNotifications = {
    enabled: true,
    coordinationVpcServiceId: "01a158fc-ef0d-7d11-8976-af6247908574",
  };
  assert.match(validateInventory(sharedCoordination).errors.join("\n"), /bounded polling/u);
});

test("remote-disposable projection uses only prefixed workers.dev Workers and their isolated bindings", () => {
  const isolated = remoteDisposableInventory();
  const controlTemplate = readFileSync(
    path.join(repoRoot, "infrastructure/workers/control-plane.template.json"),
    "utf8",
  );
  const gatewayTemplate = readFileSync(
    path.join(repoRoot, "infrastructure/workers/gateway.template.json"),
    "utf8",
  );
  const control = JSON.parse(renderWorkerTemplate(controlTemplate, isolated, "control-plane"));
  const gateway = JSON.parse(renderWorkerTemplate(gatewayTemplate, isolated, "gateway"));

  assert.equal(control.name, "praetorium-t14-canary-control-plane");
  assert.equal(gateway.name, "praetorium-t14-canary-gateway");
  assert.equal(control.workers_dev, true);
  assert.equal(gateway.workers_dev, true);
  assert.equal(control.routes, undefined);
  assert.equal(gateway.routes, undefined);
  assert.equal(control.vpc_services, undefined);
  assert.equal(gateway.vpc_services, undefined);
  assert.deepEqual(control.services, [{ binding: "GATEWAY_SERVICE", service: gateway.name }]);
  assert.deepEqual(gateway.services, [{ binding: "CONTROL_PLANE", service: control.name }]);
  assert.equal(control.d1_databases[0].database_name, "praetorium-t14-canary-control-plane");
  assert.equal(control.d1_databases[0].database_id, isolated.cloudflare.controlPlaneDatabaseId);
  assert.equal(gateway.kv_namespaces[0].id, isolated.cloudflare.gatewayKvNamespaceId);
  assert.deepEqual(
    gateway.ratelimits.map(({ name, namespace_id }) => [name, namespace_id]),
    Object.entries(remoteDisposableRateLimitNamespaces(isolated)),
  );
  assert.ok(gateway.ratelimits.every((limit) => ![761101, 761102, 761103, 761104, 761105, 761106].includes(limit.namespace_id)));
  assert.equal(gateway.vars.GATEWAY_ENVIRONMENT, "test");
  // Durable Object namespaces are scoped to the Worker script name. Preserve the
  // class/migration contract while giving the test Worker its own namespace.
  assert.deepEqual(control.durable_objects, JSON.parse(controlTemplate).durable_objects);
  assert.deepEqual(control.migrations, JSON.parse(controlTemplate).migrations);
  assert.deepEqual(gateway.durable_objects, JSON.parse(gatewayTemplate).durable_objects);
  assert.deepEqual(gateway.migrations, JSON.parse(gatewayTemplate).migrations);
  assert.throws(() => renderWorkerTemplate(gatewayTemplate, isolated, "admin"), /only the isolated/u);

  const productionMode = structuredClone(isolated);
  productionMode.environment = "deployment";
  assert.match(validateInventory(productionMode).errors.join("\n"), /requires a real remote Cloudflare account/u);
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
  assert.deepEqual(plan.migrations, expectedMigrations);
  assert.ok(plan.discoveredMigrations.includes("0004_runtime_git_credentials.sql"));
  assert.ok(plan.discoveredMigrations.includes("0004_source_release_builds.sql"));
  assert.ok(plan.discoveredMigrations.includes("0007_source_release_recovery.sql"));
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

  assert.deepEqual(preflight.expectedMigrations, expectedMigrations);
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
