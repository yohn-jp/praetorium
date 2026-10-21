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
  const direct = parseGatewayProjection(readFileSync(path.join(root, "apps/gateway/wrangler.toml"), "utf8"));
  const inventory = JSON.parse(readFileSync(path.join(root, "infrastructure/test/disposable-inventory.json"), "utf8"));
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

  const template = readFileSync(path.join(root, "infrastructure/workers/gateway.template.json"), "utf8");
  const generated = JSON.parse(renderWorkerTemplate(template, inventory, "gateway"));
  assert.deepEqual(generated.vars, direct.vars);
  assert.deepEqual(generated.routes, direct.routes);
  assert.equal(generated.vars.GATEWAY_SESSION_TTL_SECONDS, "28800");
  assert.equal(generated.vars.PRAETORIUM_ADMIN_ORIGIN, inventory.gateway.adminOrigin);
  assert.deepEqual(JSON.parse(generated.vars.PRAETORIUM_RELEASE_SOURCES_JSON), inventory.gateway.releaseSources);
});

