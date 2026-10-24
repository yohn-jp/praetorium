import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderWorkerTemplate } from "../../infrastructure/scripts/worker-config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function parseScalar(raw) {
  if (raw.startsWith('"')) return JSON.parse(raw);
  if (raw.startsWith("'")) return raw.slice(1, -1);
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/u.test(raw)) return Number(raw);
  throw new Error("unsupported TOML scalar in projection fixture");
}

function parseGatewayProjection(toml) {
  const vars = {};
  const routes = [];
  let section = "";
  let route;
  for (const rawLine of toml.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line === "[vars]") {
      section = "vars";
      route = undefined;
    } else if (line === "[[routes]]") {
      section = "routes";
      route = {};
      routes.push(route);
    } else if (line.startsWith("[")) {
      section = "";
      route = undefined;
    } else if (section === "vars" || section === "routes") {
      const match = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/u.exec(line);
      if (!match) continue;
      const value = parseScalar(match[2]);
      if (section === "vars") vars[match[1]] = value;
      else route[match[1]] = value;
    }
  }
  return { vars, routes };
}

test("inventory Gateway projection matches direct Wrangler Admin and Source settings", () => {
  const direct = parseGatewayProjection(
    readFileSync(path.join(root, "apps/gateway/wrangler.toml"), "utf8"),
  );
  const inventory = JSON.parse(
    readFileSync(path.join(root, "infrastructure/test/disposable-inventory.json"), "utf8"),
  );
  inventory.environment = "deployment";
  inventory.domains.gatewayOrigin = direct.vars.GATEWAY_ORIGIN;
  inventory.domains.controlPlaneUrl = direct.vars.CONTROL_PLANE_ORIGIN;
  inventory.domains.instanceHostnameSuffix = direct.vars.GATEWAY_INSTANCE_HOSTNAME_SUFFIX;
  inventory.gateway = {
    ...inventory.gateway,
    allowedRepositoryOwner: direct.vars.GATEWAY_ALLOWED_REPOSITORY_OWNER,
    githubAppId: Number(direct.vars.GITHUB_APP_ID),
    githubOauthClientId: direct.vars.GITHUB_OAUTH_CLIENT_ID,
    tokenEncryptionKeyId: direct.vars.GATEWAY_TOKEN_ENCRYPTION_KEY_ID,
    adminOrigin: direct.vars.PRAETORIUM_ADMIN_ORIGIN,
    adminGithubUserIds: direct.vars.PRAETORIUM_ADMIN_GITHUB_USER_IDS.split(",").map(Number),
    releaseSources: JSON.parse(direct.vars.PRAETORIUM_RELEASE_SOURCES_JSON),
  };

  const template = readFileSync(
    path.join(root, "infrastructure/workers/gateway.template.json"),
    "utf8",
  );
  const generated = JSON.parse(renderWorkerTemplate(template, inventory, "gateway"));
  assert.deepEqual(generated.vars, direct.vars);
  assert.deepEqual(generated.routes, direct.routes);
  assert.equal(generated.vars.GATEWAY_SESSION_TTL_SECONDS, "28800");
  assert.equal(generated.vars.PRAETORIUM_ADMIN_ORIGIN, inventory.gateway.adminOrigin);
  assert.deepEqual(
    JSON.parse(generated.vars.PRAETORIUM_RELEASE_SOURCES_JSON),
    inventory.gateway.releaseSources,
  );
});

test("inventory Control Plane projection keeps the direct Source Producer trust policy", () => {
  const directText = readFileSync(path.join(root, "apps/control-plane/wrangler.toml"), "utf8");
  const directVars = parseGatewayProjection(directText);
  const directPolicy = JSON.parse(directVars.vars.BUILD_POLICY_JSON);
  const inventory = JSON.parse(
    readFileSync(path.join(root, "infrastructure/test/disposable-inventory.json"), "utf8"),
  );
  inventory.environment = "deployment";
  inventory.clusterId = directVars.vars.PROVISIONER_CLUSTER_ID;
  inventory.domains.gatewayOrigin = directVars.vars.GATEWAY_ORIGIN;
  inventory.domains.controlPlaneUrl = directVars.vars.CONTROL_PLANE_ORIGIN;
  inventory.domains.instanceHostnameSuffix = directVars.vars.INSTANCE_HOST_SUFFIX;
  inventory.buildkit.frontendRepository = directPolicy.sourceProducerRepository;
  inventory.buildkit.outputRepository = `ghcr.io/${directPolicy.outputRepository}`;
  inventory.buildWorker.compositionRepository = directPolicy.allowedRepositories.find(
    (repository) =>
      repository !== directPolicy.outputRepository &&
      repository !== directPolicy.sourceProducerRepository.slice("ghcr.io/".length),
  );
  inventory.buildPolicy = {
    ...inventory.buildPolicy,
    registryUrl: directPolicy.registryUrl,
    maxImageLayerBytes: directPolicy.maxImageLayerBytes,
    maxImageVerificationMs: directPolicy.maxImageVerificationMs,
    maxRegistryRequestMs: directPolicy.maxRegistryRequestMs,
    runtimeResourceLimits: directPolicy.runtimeResourceLimits,
    cacheRetention: directPolicy.cacheRetention,
    targetPlatform: directPolicy.targetPlatform,
    builderKeys: directPolicy.builderKeys,
  };

  const template = readFileSync(
    path.join(root, "infrastructure/workers/control-plane.template.json"),
    "utf8",
  );
  const generated = JSON.parse(renderWorkerTemplate(template, inventory, "control-plane"));
  assert.deepEqual(JSON.parse(generated.vars.BUILD_POLICY_JSON), directPolicy);
  assert.equal(
    JSON.parse(generated.vars.BUILD_POLICY_JSON).sourceProducerRepository,
    "ghcr.io/yohn-jp/praetorium/scriptorium-producer",
  );
  assert.deepEqual(generated.routes, directVars.routes);
});

test("Admin Worker alone owns operator domain and retains private Gateway broker binding", () => {
  const inventory = JSON.parse(readFileSync(
    path.join(root, "infrastructure/test/disposable-inventory.json"), "utf8",
  ));
  inventory.gateway.adminOrigin = "https://admin.praetorium.test";
  inventory.domains.gatewayOrigin = "https://praetorium.test";
  const adminTemplate = readFileSync(
    path.join(root, "infrastructure/workers/admin.template.json"), "utf8",
  );
  const gatewayTemplate = readFileSync(
    path.join(root, "infrastructure/workers/gateway.template.json"), "utf8",
  );
  const admin = JSON.parse(renderWorkerTemplate(adminTemplate, inventory, "admin"));
  const gateway = JSON.parse(renderWorkerTemplate(gatewayTemplate, inventory, "gateway"));
  assert.deepEqual(admin.routes, [{pattern: "admin.praetorium.test", custom_domain: true}]);
  assert.deepEqual(gateway.routes, [{pattern: "praetorium.test", custom_domain: true}]);
  assert.equal(admin.vars.ADMIN_ORIGIN, inventory.gateway.adminOrigin);
  assert.equal(admin.vars.GATEWAY_ORIGIN, inventory.domains.gatewayOrigin);
  assert.ok(admin.services.some(item =>
    item.service === "praetorium-gateway" && item.binding === "ADMIN_IDENTITY" &&
    item.entrypoint === "AdminIdentityBroker"));
  assert.ok(admin.services.some(item =>
    item.service === "praetorium-control-plane" && item.binding === "CONTROL_PLANE"));
  assert.ok(!JSON.stringify(admin).includes("GATEWAY_SESSION_DIGEST_PEPPER"));
  assert.throws(() => renderWorkerTemplate(adminTemplate, {...inventory,
    gateway: {...inventory.gateway, adminOrigin: null}}, "admin"), /Admin origin/u);
});

test("Admin observer private VPC binding is projected only from explicit inventory", () => {
  const input = JSON.parse(readFileSync(
    path.join(root, "infrastructure/test/disposable-inventory.json"), "utf8",
  ));
  input.gateway.adminOrigin = "https://admin.praetorium.test";
  input.gateway.adminObserverVpcServiceId = "01a158fc-ef0d-7d11-8976-af6247908575";
  const template = readFileSync(
    path.join(root, "infrastructure/workers/admin.template.json"), "utf8",
  );
  const result = JSON.parse(renderWorkerTemplate(template, input, "admin"));
  assert.deepEqual(result.vpc_services, [{
    binding:"INFRASTRUCTURE",
    service_id:input.gateway.adminObserverVpcServiceId,
  }]);
  assert.equal(result.services.length, 2);
  delete input.gateway.adminObserverVpcServiceId;
  assert.equal(JSON.parse(renderWorkerTemplate(template, input, "admin")).vpc_services, undefined);
});
