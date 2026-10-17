#!/usr/bin/env node
/**
 * One-command Cloudflare deployment for the existing Praetorium Workers.
 * Does not provision Proxmox, Kubernetes, or missing GitHub App credentials.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gateway = "apps/gateway/wrangler.toml";
const control = "apps/control-plane/wrangler.toml";
const apply = process.argv.slice(2).includes("--apply");
if (process.argv.slice(2).some((arg) => arg !== "--apply" && arg !== "--check")) {
  throw new Error("Usage: node scripts/deploy-cloudflare.mjs [--check | --apply]");
}
function run(command, args, { capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    shell: process.platform === "win32",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
    timeout: 15 * 60_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args[0]} failed (exit ${result.status ?? "unknown"}): ${result.error?.message ?? (capture ? result.stderr?.slice(0, 600) : "")}`);
  }
  return result.stdout ?? "";
}
function readConfig(name) {
  const text = readFileSync(path.join(root, name), "utf8");
  if (/00000000-0000-0000-0000-000000000000|00000000000000000000000000000000|@@[A-Z_]+@@/.test(text)) {
    throw new Error(`${name} still contains a placeholder resource binding`);
  }
  return text;
}
const gatewayConfig = readConfig(gateway);
const controlConfig = readConfig(control);
if (!gatewayConfig.includes('pattern = "praetorium.yohn.jp"')) {
  throw new Error("Gateway custom domain is missing from Wrangler config");
}
if (!controlConfig.includes('database_id = "08f29fef-eb9e-4541-82fb-777fa2f4aab0"')) {
  throw new Error("Control Plane D1 binding does not match the approved database");
}
if (!gatewayConfig.includes('id = "770c4ac60df74b019409c1203f35687d"')) {
  throw new Error("Gateway KV binding does not match the approved namespace");
}
const required = {
  [gateway]: [
    "GITHUB_APP_PRIVATE_KEY", "GITHUB_OAUTH_CLIENT_SECRET", "GATEWAY_GITHUB_WEBHOOK_SECRET",
    "GATEWAY_SIGNING_KEY", "CONTROL_PLANE_GATEWAY_AUTH",
    "RUNTIME_CREDENTIAL_RETIREMENT_AUTH", "INSTANCE_ACCESS_SERVICE_AUTH_TOKEN",
    "GATEWAY_SESSION_DIGEST_PEPPER", "GATEWAY_CREDENTIAL_DIGEST_PEPPER",
    "GATEWAY_HANDOFF_DIGEST_PEPPER", "GATEWAY_TOKEN_ENCRYPTION_KEY",
  ],
  [control]: [
    "CONTROL_PLANE_GATEWAY_AUTH", "RUNTIME_CREDENTIAL_RETIREMENT_AUTH",
    "RUNTIME_CONTROL_SIGNING_KEY", "RUNTIME_IDENTITY_SIGNING_KEY",
  ],
};
for (const [config, names] of Object.entries(required)) {
  const output = run("npx", ["--yes", "wrangler@4.151.1", "secret", "list", "--config", config], { capture: true });
  const available = new Set(JSON.parse(output).map((entry) => entry.name));
  const missing = names.filter((name) => !available.has(name));
  if (missing.length) throw new Error(`${config} missing Worker Secrets: ${missing.join(", ")}`);
}
const registry = run("npx", ["--yes", "wrangler@4.151.1", "kv", "key", "get", "gateway-signing-key-registry", "--namespace-id", "770c4ac60df74b019409c1203f35687d", "--remote"], { capture: true });
const active = JSON.parse(registry).filter((entry) => entry.status === "active");
if (active.length !== 1 || active[0].publicKeyJwk?.kty !== "EC" || active[0].publicKeyJwk?.crv !== "P-256") {
  throw new Error("Gateway signing key registry has no unique active P-256 public key");
}
for (const key of ["GATEWAY_ORIGIN", "CONTROL_PLANE_ORIGIN", "GITHUB_APP_ID", "GITHUB_OAUTH_CLIENT_ID"]) {
  if (!new RegExp(`^\\s*${key}\\s*=\\s*"[^"]+"\\s*$`, "m").test(gatewayConfig)) {
    throw new Error(`Gateway Wrangler configuration is missing ${key}`);
  }
}
console.log("Cloudflare resource IDs, secret names, public registry and Gateway vars: present.");
console.log("Secret values and private/public signing-key match cannot be verified via Cloudflare API.");
if (!apply) {
  console.log("Preflight only. Use --apply to build, migrate D1, deploy both Workers and probe endpoints.");
  process.exit(0);
}
if (!existsSync(path.join(root, "node_modules"))) {
  run("corepack", ["pnpm@11.18.0", "install", "--frozen-lockfile"]);
}
run("corepack", ["pnpm@11.18.0", "build"]);
run("npx", ["--yes", "wrangler@4.151.1", "d1", "migrations", "apply", "praetorium-platform", "--remote", "--config", control]);
run("npx", ["--yes", "wrangler@4.151.1", "deploy", "--config", control]);
run("npx", ["--yes", "wrangler@4.151.1", "deploy", "--config", gateway]);
console.log("Cloudflare Workers deployed. Checking declared HTTPS endpoints.");
for (const url of ["https://praetorium.yohn.jp/healthz", "https://praetorium.yohn.jp/.well-known/jwks.json"]) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Deployed endpoint failed: ${url} HTTP ${response.status}`);
  if (url.endsWith("jwks.json")) {
    const jwks = await response.json();
    if (!Array.isArray(jwks.keys) || !jwks.keys.some((key) => key.kid === active[0].kid)) {
      throw new Error("Deployed Gateway JWKS does not contain the configured active key");
    }
  }
  console.log(`OK ${url}`);
}
console.log("Cloudflare deployment and Gateway HTTPS probes passed. Kubernetes/Scriptorium acceptance is separate.");
