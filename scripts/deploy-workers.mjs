#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readInventory } from "../infrastructure/scripts/inventory.mjs";
import { buildPolicy, releasePolicy, renderWorkerTemplate } from "../infrastructure/scripts/worker-config.mjs";
import { workNotificationEndpoints, workNotificationsEnabled } from "../infrastructure/scripts/work-notifications.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templatesDir = path.join(repoRoot, "infrastructure/workers");
const requiredMigrations = [
  "0001_repository_platform.sql",
  "0002_stable_release_rollouts.sql",
  "0003_staged_configurations.sql",
  "0004_runtime_git_credentials.sql",
  "0005_runtime_health_observations.sql",
];

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
  if (!result.inventoryPath)
    throw new Error("--inventory must name the owned inventory explicitly");
  if (action === "apply-local" && !result.confirmation)
    throw new Error("apply-local requires the exact disposable cluster name with --confirm");
  return result;
}

function validate(file) {
  const result = readInventory(file);
  if (result.errors.length > 0)
    throw new Error(`inventory is invalid:\n- ${result.errors.join("\n- ")}`);
  const { inventory } = result;
  if (inventory.environment !== "disposable-test" || inventory.cloudflare.mode !== "local") {
    throw new Error(
      "Worker migration application is restricted to disposable-test with Cloudflare local mode",
    );
  }
  if (
    !inventory.ownership.disposable ||
    inventory.ownership.context !== `kind-${inventory.ownership.clusterName}`
  ) {
    throw new Error("inventory does not declare an explicit disposable Kind owner");
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,51}[a-z0-9])?$/.test(inventory.ownership.clusterName)) {
    throw new Error("ownership.clusterName must be DNS-safe");
  }
  return result;
}

function checkPaths() {
  const paths = [
    "apps/control-plane/src/worker.ts",
    "apps/gateway/src/worker.ts",
    "apps/control-plane/migrations",
    ...requiredMigrations.map((file) => `apps/control-plane/migrations/${file}`),
    "infrastructure/workers/control-plane.template.json",
    "infrastructure/workers/gateway.template.json",
  ];
  const directory = path.join(repoRoot, "apps/control-plane/migrations");
  const migrationFiles = existsSync(directory)
    ? readdirSync(directory)
        .filter((entry) => entry.endsWith(".sql"))
        .sort()
    : [];
  return {
    files: Object.fromEntries(
      paths.map((entry) => [entry, existsSync(path.join(repoRoot, entry))]),
    ),
    migrationFiles,
  };
}

function inspectTemplates() {
  const problems = [];
  let controlPlane;
  let gateway;
  try {
    controlPlane = JSON.parse(
      readFileSync(path.join(templatesDir, "control-plane.template.json"), "utf8"),
    );
    gateway = JSON.parse(readFileSync(path.join(templatesDir, "gateway.template.json"), "utf8"));
  } catch (error) {
    return [`Worker configuration template is invalid JSON: ${error.message}`];
  }
  if (
    controlPlane.compatibility_date !== "2026-07-30" ||
    gateway.compatibility_date !== "2026-07-30"
  ) {
    problems.push("Worker templates must use the pinned 2026-07-30 compatibility date");
  }
  if (
    controlPlane.triggers?.crons?.length !== 1 ||
    controlPlane.triggers.crons[0] !== "*/5 * * * *"
  ) {
    problems.push("Control Plane template must run the T11 scheduled handler every five minutes");
  }
  if (
    controlPlane.d1_databases?.length !== 1 ||
    controlPlane.d1_databases[0]?.binding !== "CONTROL_PLANE_DB" ||
    controlPlane.d1_databases[0]?.database_name !== "praetorium-platform" ||
    controlPlane.d1_databases[0]?.migrations_dir !== "../../apps/control-plane/migrations"
  ) {
    problems.push(
      "Control Plane template must bind the canonical platform D1 and migration directory",
    );
  }
  if (
    controlPlane.durable_objects?.bindings?.length !== 1 ||
    controlPlane.durable_objects.bindings[0]?.name !== "REPOSITORY_COORDINATOR" ||
    controlPlane.durable_objects.bindings[0]?.class_name !== "RepositoryCoordinator"
  ) {
    problems.push("Control Plane template must bind RepositoryCoordinator");
  }
  if (
    controlPlane.migrations?.length !== 1 ||
    controlPlane.migrations[0]?.tag !== "v1" ||
    !controlPlane.migrations[0]?.new_sqlite_classes?.includes("RepositoryCoordinator")
  ) {
    problems.push(
      "Control Plane template must register its RepositoryCoordinator Durable Object migration",
    );
  }
  if (
    controlPlane.services?.length !== 1 ||
    controlPlane.services[0]?.binding !== "GATEWAY_SERVICE" ||
    controlPlane.services[0]?.service !== "praetorium-gateway"
  ) {
    problems.push("Control Plane template must bind the Gateway retirement service");
  }
  const expectedControlVariables = [
    "BUILD_POLICY_JSON",
    "BUILD_WORKER_ID",
    "CONTROL_PLANE_ORIGIN",
    "GATEWAY_ORIGIN",
    "INSTANCE_HOST_SUFFIX",
    "PROVISIONER_WORK_NOTIFICATION_URL",
    "BUILD_WORK_NOTIFICATION_URL",
    "RELEASE_POLICY_JSON",
    "RUNTIME_REGISTRY_HOST",
    "GIT_CREDENTIAL_BROKER_LOCATOR",
  ].sort();
  if (
    Object.keys(controlPlane.vars ?? {})
      .sort()
      .join("\0") !== expectedControlVariables.join("\0")
  ) {
    problems.push(
      "Control Plane template must declare the current build and runtime policy variables",
    );
  }
  if (gateway.d1_databases !== undefined)
    problems.push("Gateway template must not bind a D1 database");
  const gatewayObjects = new Map(
    (gateway.durable_objects?.bindings ?? []).map((binding) => [binding.name, binding.class_name]),
  );
  if (
    gatewayObjects.size !== 2 ||
    gatewayObjects.get("USER_AUTH_STATE") !== "UserAuthStateDurableObject" ||
    gatewayObjects.get("EPHEMERAL_CODES") !== "EphemeralCodeDurableObject"
  ) {
    problems.push("Gateway template must bind its two durable authentication authorities");
  }
  if (
    gateway.migrations?.length !== 1 ||
    gateway.migrations[0]?.tag !== "v1" ||
    !gateway.migrations[0]?.new_sqlite_classes?.includes("UserAuthStateDurableObject") ||
    !gateway.migrations[0]?.new_sqlite_classes?.includes("EphemeralCodeDurableObject")
  ) {
    problems.push("Gateway template must register both Durable Object migrations");
  }
  const expectedGatewayVariables = [
    "GATEWAY_ORIGIN",
    "CONTROL_PLANE_ORIGIN",
    "GATEWAY_SESSION_TTL_SECONDS",
    "GATEWAY_HANDOFF_TTL_SECONDS",
    "GATEWAY_ACCESS_GRANT_TTL_SECONDS",
    "GATEWAY_INSTANCE_HOSTNAME_SUFFIX",
    "GATEWAY_ALLOWED_REPOSITORY_OWNER",
    "GITHUB_APP_ID",
    "GITHUB_OAUTH_CLIENT_ID",
    "GATEWAY_TOKEN_ENCRYPTION_KEY_ID",
  ].sort();
  if (
    Object.keys(gateway.vars ?? {})
      .sort()
      .join("\0") !== expectedGatewayVariables.join("\0")
  ) {
    problems.push("Gateway template must declare the current required runtime variables");
  }
  if (gateway.kv_namespaces?.length !== 1 || gateway.kv_namespaces[0]?.binding !== "GATEWAY_KV") {
    problems.push("Gateway template must bind GATEWAY_KV");
  }
  if (
    gateway.services?.length !== 1 ||
    gateway.services[0]?.binding !== "CONTROL_PLANE" ||
    gateway.services[0]?.service !== "praetorium-control-plane"
  ) {
    problems.push("Gateway template must bind the Control Plane service");
  }
  return problems;
}

function command(args, options = {}) {
  const result = spawnSync("corepack", ["pnpm@11.18.0", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, CI: "true" },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeout ?? 120_000,
  });
  if (result.error)
    throw new Error(`Corepack pnpm@11.18.0 is unavailable: ${result.error.message}`);
  if (result.status !== 0)
    throw new Error(
      `corepack pnpm@11.18.0 ${args.join(" ")} failed (${result.status}): ${(result.stderr || result.stdout).trim()}`,
    );
  return result.stdout;
}

function wranglerAvailable() {
  const executable = path.join(
    repoRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "wrangler.cmd" : "wrangler",
  );
  if (!existsSync(executable)) return false;
  const result = spawnSync(executable, ["--version"], {
    encoding: "utf8",
    stdio: "ignore",
    timeout: 30_000,
  });
  return !result.error && result.status === 0;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const inventoryResult = validate(args.inventoryPath);
  const { inventory } = inventoryResult;
  const paths = checkPaths();
  const missing = [
    ...Object.entries(paths.files)
      .filter(([, present]) => !present)
      .map(([entry]) => entry),
    ...requiredMigrations
      .filter((file) => !paths.migrationFiles.includes(file))
      .map((file) => `apps/control-plane/migrations/${file}`),
  ];
  const templateProblems = inspectTemplates();
  const generatedBuildPolicy = buildPolicy(inventory);
  const notificationsEnabled = workNotificationsEnabled(inventory);
  const notificationEndpoints = workNotificationEndpoints(inventory);
  const workerVariables = {
    gateway: [
      "GATEWAY_ORIGIN",
      "CONTROL_PLANE_ORIGIN",
      "GATEWAY_SESSION_TTL_SECONDS",
      "GATEWAY_HANDOFF_TTL_SECONDS",
      "GATEWAY_ACCESS_GRANT_TTL_SECONDS",
      "GATEWAY_INSTANCE_HOSTNAME_SUFFIX",
      "GATEWAY_ALLOWED_REPOSITORY_OWNER",
      "GITHUB_APP_ID",
      "GITHUB_OAUTH_CLIENT_ID",
      "GATEWAY_TOKEN_ENCRYPTION_KEY_ID",
    ],
    controlPlane: [
      "BUILD_POLICY_JSON",
      "BUILD_WORKER_ID",
      "CONTROL_PLANE_ORIGIN",
      "GATEWAY_ORIGIN",
      "INSTANCE_HOST_SUFFIX",
      "RELEASE_POLICY_JSON",
      "RUNTIME_REGISTRY_HOST",
      "GIT_CREDENTIAL_BROKER_LOCATOR",
      ...(notificationsEnabled
        ? ["PROVISIONER_WORK_NOTIFICATION_URL", "BUILD_WORK_NOTIFICATION_URL"]
        : []),
    ],
  };
  const workerSecrets = {
    controlPlane: [
      "CONTROL_PLANE_GATEWAY_AUTH",
      "RUNTIME_CREDENTIAL_RETIREMENT_AUTH",
      "RUNTIME_IDENTITY_SIGNING_KEY",
      ...(notificationsEnabled
        ? ["PROVISIONER_WORK_NOTIFICATION_TOKEN", "BUILD_WORK_NOTIFICATION_TOKEN"]
        : []),
    ],
    gateway: [
      "GITHUB_OAUTH_CLIENT_SECRET",
      "GATEWAY_GITHUB_WEBHOOK_SECRET",
      "GITHUB_APP_PRIVATE_KEY",
      "CONTROL_PLANE_GATEWAY_AUTH",
      "RUNTIME_CREDENTIAL_RETIREMENT_AUTH",
      "INSTANCE_ACCESS_SERVICE_AUTH_TOKEN",
      "GATEWAY_SESSION_DIGEST_PEPPER",
      "GATEWAY_CREDENTIAL_DIGEST_PEPPER",
      "GATEWAY_HANDOFF_DIGEST_PEPPER",
      "GATEWAY_TOKEN_ENCRYPTION_KEY",
      "GATEWAY_SIGNING_KEY",
    ],
  };
  const runtimeCredentialRetirement = {
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
  };
  const serviceBindings = [
    "Control Plane GATEWAY_SERVICE -> praetorium-gateway",
    "Gateway CONTROL_PLANE -> praetorium-control-plane",
  ];
  const workerBlockers = [...inventoryResult.blockers, ...templateProblems];

  if (args.action === "plan") {
    process.stdout.write(
      `${JSON.stringify(
        {
          action: "plan",
          inventory: inventoryResult.absolutePath,
          environment: inventory.environment,
          databaseBindings: ["CONTROL_PLANE_DB"],
          gatewayKvBinding: "GATEWAY_KV",
          durableObjectBindings: ["REPOSITORY_COORDINATOR", "USER_AUTH_STATE", "EPHEMERAL_CODES"],
          serviceBindings,
          workerVariables,
          requiredWorkerSecrets: workerSecrets,
          workNotifications: {
            enabled: notificationsEnabled,
            endpoints: notificationEndpoints,
            requiredSecrets: notificationsEnabled
              ? ["PROVISIONER_WORK_NOTIFICATION_TOKEN", "BUILD_WORK_NOTIFICATION_TOKEN"]
              : [],
            tokenValuesInspected: false,
            delivery: notificationsEnabled
              ? "best-effort HTTPS POST; worker polling fallback remains bounded"
              : "disabled by inventory; existing bounded polling fallback remains active",
          },
          runtimeCredentialRetirement,
          optionalControlPlaneSecrets: [
            "REGISTRY_PULL_CREDENTIAL (separate JSON username/password credential for Control Plane OCI reads)",
            "BUILD_WORKER_AUTH_TOKEN (enables build routes only with BUILD_POLICY_JSON; same token as the Build Worker mounted file)",
            "RUNTIME_CONTROL_SIGNING_KEY (private P-256 JWK for runtime-control credentials)",
            "RELEASE_OPERATOR_TOKEN (separate 32-4096 non-space printable ASCII operator token; distinct from CONTROL_PLANE_GATEWAY_AUTH, BUILD_WORKER_AUTH_TOKEN, and PROVISIONER_AUTH_TOKEN)",
            "PROVISIONER_AUTH_TOKEN (enables Control Plane operation routes only after the real producer transports are ready)",
          ],
          optionalControlPlaneVariables: [
            "BUILD_POLICY_JSON (generated only when the complete build policy is supplied)",
            "RELEASE_POLICY_JSON (generated only when the complete operator-selected disposable canary policy is supplied)",
            ...(notificationsEnabled
              ? ["PROVISIONER_WORK_NOTIFICATION_URL and BUILD_WORK_NOTIFICATION_URL (derived from the configured instance hostname suffix)"]
              : []),
          ],
          controlPlaneBuildPolicy: {
            configured: generatedBuildPolicy !== null,
            sourceVariable: "BUILD_POLICY_JSON",
            fields: [
              "registryUrl",
              "allowedRepositories",
              "outputRepository",
              "maxImageLayerBytes",
              "maxImageVerificationMs",
              "maxRegistryRequestMs",
              "targetPlatform",
              "builderKeys",
              "runtimeResourceLimits",
              "cacheRetention",
            ],
            cacheRetention: generatedBuildPolicy?.cacheRetention ?? null,
            registryUrl: inventory.buildPolicy.registryUrl,
            outputRepository: inventory.buildkit.outputRepository,
            targetPlatform: inventory.buildPolicy.targetPlatform,
            builderKeyIds: inventory.buildPolicy.builderKeys.map((key) => key.keyId),
            runtimeResourceLimits: inventory.buildPolicy.runtimeResourceLimits,
          },
          optionalProvisionerRoute: {
            secrets: ["PROVISIONER_AUTH_TOKEN", "RUNTIME_CONTROL_SIGNING_KEY"],
            variables: [
              "PROVISIONER_WORKER_ID",
              "PROVISIONER_CLUSTER_ID",
              "GATEWAY_ORIGIN",
              "CONTROL_PLANE_ORIGIN",
              "INSTANCE_HOST_SUFFIX",
              "RUNTIME_REGISTRY_HOST",
              "GIT_CREDENTIAL_BROKER_LOCATOR",
            ],
            readiness:
              "disabled: producer S03 runtime assignment ABI and S02 grant-probe transport are unavailable; Provisioner /readyz remains 503 and it claims no operations",
          },
          releasePolicy: {
            configured: releasePolicy(inventory) !== null,
            source:
              "public values from inventory.releasePolicy and inventory.clusterId; no secret values",
          },
          releaseGates: {
            scheduledCron: "*/5 * * * *",
            admission: "BLOCKED: S01 immutable producer metadata attestation ABI is unavailable",
            canaryEvidence:
              "BLOCKED: authenticated S02/S05 UI, API, MCP, and persistence conformance observations are unavailable",
            promotion:
              "BLOCKED: release admission and promotion require S01 metadata plus S02/S05 canary evidence",
          },
          migrationDirectory: "apps/control-plane/migrations",
          migrations: requiredMigrations,
          discoveredMigrations: paths.migrationFiles,
          actions: [
            "apply only the four Control Plane local D1 migrations",
            "keep all local D1 state under the disposable inventory directory",
          ],
          remoteCalls: false,
          missingProjectInputs: missing,
          inventoryBlockers: inventoryResult.blockers,
          templateProblems,
          blockers: [...workerBlockers, ...missing],
          secretValuesInspected: false,
          sideEffects: [],
        },
        null,
        2,
      )}\n`,
    );
    if (missing.length > 0 || workerBlockers.length > 0) process.exitCode = 2;
  } else if (args.action === "preflight") {
    const wrangler = wranglerAvailable();
    const blocked = [...new Set([...missing, ...workerBlockers])];
    if (!wrangler) blocked.push("workspace Wrangler executable is unavailable");
    process.stdout.write(
      `${JSON.stringify(
        {
          action: "preflight",
          inventory: inventoryResult.absolutePath,
          cloudflareMode: inventory.cloudflare.mode,
          files: paths.files,
          discoveredMigrations: paths.migrationFiles,
          templateProblems,
          expectedMigrations: requiredMigrations,
          serviceBindings,
          workerVariables,
          requiredWorkerSecrets: workerSecrets,
          workNotifications: {
            enabled: notificationsEnabled,
            endpoints: notificationEndpoints,
            requiredSecrets: notificationsEnabled
              ? ["PROVISIONER_WORK_NOTIFICATION_TOKEN", "BUILD_WORK_NOTIFICATION_TOKEN"]
              : [],
            tokenValuesInspected: false,
            delivery: notificationsEnabled
              ? "best-effort HTTPS POST; worker polling fallback remains bounded"
              : "disabled by inventory; existing bounded polling fallback remains active",
          },
          runtimeCredentialRetirement,
          optionalControlPlaneSecrets: [
            "REGISTRY_PULL_CREDENTIAL",
            "BUILD_WORKER_AUTH_TOKEN",
            "RUNTIME_CONTROL_SIGNING_KEY",
            "RELEASE_OPERATOR_TOKEN",
            "PROVISIONER_AUTH_TOKEN",
          ],
          optionalControlPlaneVariables: ["BUILD_POLICY_JSON", "RELEASE_POLICY_JSON"],
          controlPlaneBuildPolicy: {
            configured: generatedBuildPolicy !== null,
            cacheRetention: generatedBuildPolicy?.cacheRetention ?? null,
          },
          releasePolicyConfigured: releasePolicy(inventory) !== null,
          releaseGates: {
            scheduledCron: "*/5 * * * *",
            admission: "BLOCKED: S01 immutable producer metadata attestation ABI is unavailable",
            canaryEvidence:
              "BLOCKED: authenticated S02/S05 UI, API, MCP, and persistence conformance observations are unavailable",
            promotion:
              "BLOCKED: release admission and promotion require S01 metadata plus S02/S05 canary evidence",
          },
          wranglerAvailable: wrangler,
          secretValuesInspected: false,
          blocked,
          remoteCalls: false,
        },
        null,
        2,
      )}\n`,
    );
    if (blocked.length > 0) process.exitCode = 2;
  } else {
    if (args.confirmation !== inventory.ownership.clusterName)
      throw new Error(`--confirm must exactly equal ${inventory.ownership.clusterName}`);
    if (missing.length > 0)
      throw new Error(`local Worker inputs are missing:\n- ${missing.join("\n- ")}`);
    if (templateProblems.length > 0)
      throw new Error(`Worker templates are invalid:\n- ${templateProblems.join("\n- ")}`);
    if (!wranglerAvailable())
      throw new Error("apply-local requires the workspace Wrangler executable");

    const inventoryState = path.join(
      os.tmpdir(),
      "praetorium-t12-workers",
      inventory.ownership.clusterName,
    );
    const configs = [];
    try {
      const template = readFileSync(path.join(templatesDir, "control-plane.template.json"), "utf8");
      const configPath = path.join(
        templatesDir,
        `.runtime-${process.pid}-${randomUUID()}-control-plane.json`,
      );
      writeFileSync(configPath, renderWorkerTemplate(template, inventory, "control-plane"), { mode: 0o600 });
      configs.push(configPath);
      command([
        "exec",
        "wrangler",
        "d1",
        "migrations",
        "apply",
        "praetorium-platform",
        "--local",
        "--persist-to",
        inventoryState,
        "--config",
        configPath,
      ]);
      process.stdout.write(
        `${JSON.stringify(
          {
            action: "apply-local",
            inventory: inventoryResult.absolutePath,
            owner: inventory.ownership.clusterName,
            databases: ["praetorium-platform"],
            migrations: requiredMigrations,
            gatewayKv: "local Worker binding; no D1 migration",
            persistenceDirectory: inventoryState,
            remoteCalls: false,
            sideEffects: ["local D1 migration state was created or updated"],
          },
          null,
          2,
        )}\n`,
      );
    } finally {
      for (const config of configs) rmSync(config, { force: true });
    }
  }
} catch (error) {
  usage();
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
}
