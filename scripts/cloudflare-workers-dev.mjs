import { lstatSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function secureProfileToken(filename, expectedUid = process.getuid?.()) {
  const metadata = lstatSync(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink() ||
      (expectedUid !== undefined && metadata.uid !== expectedUid) ||
      (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
    throw new Error("Wrangler OAuth profile must be an owner-private regular file");
  }
  const contents = readFileSync(filename, "utf8");
  const token = contents.match(/^\s*oauth_token\s*=\s*"([^"\r\n]+)"\s*$/mu)?.[1];
  if (!token) throw new Error("Wrangler OAuth profile has no supported access token");
  return token;
}

export function readCloudflareApiToken({ env = process.env, home = os.homedir(), uid = process.getuid?.() } = {}) {
  const environmentToken = env.CLOUDFLARE_API_TOKEN;
  if (typeof environmentToken === "string" && environmentToken.trim()) return environmentToken.trim();

  const xdgConfig = env.XDG_CONFIG_HOME || path.join(home, ".config");
  const legacyConfig = path.join(home, ".wrangler");
  const configRoot = existsSync(legacyConfig) ? legacyConfig : path.join(xdgConfig, ".wrangler");
  const profile = path.join(configRoot, "config", "default.toml");
  return secureProfileToken(profile, uid);
}

export function assertWorkersDevOriginForAccount(rawOrigin, workerName, accountSubdomain) {
  if (typeof accountSubdomain !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(accountSubdomain)) {
    throw new Error("Cloudflare account has no valid workers.dev subdomain");
  }
  let url;
  try {
    url = new URL(rawOrigin);
  } catch {
    throw new Error("remote-disposable origin is not a valid URL");
  }
  const expectedHostname = `${workerName}.${accountSubdomain}.workers.dev`;
  if (url.protocol !== "https:" || url.hostname !== expectedHostname || url.origin !== rawOrigin ||
      url.pathname !== "/" || url.username || url.password || url.search || url.hash) {
    throw new Error(`remote-disposable origin must match the selected Cloudflare account workers.dev subdomain: ${workerName}`);
  }
  return true;
}

export async function readWorkersDevSubdomain({ accountId, token, fetchImpl = fetch, timeoutMs = 10_000 }) {
  if (typeof accountId !== "string" || !/^[a-f0-9]{32}$/u.test(accountId) ||
      typeof token !== "string" || token.length === 0) {
    throw new Error("Cloudflare account subdomain readback requires a valid account and auth token");
  }
  let response;
  try {
    response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error("could not read the selected Cloudflare account workers.dev subdomain");
  }
  if (!response.ok) throw new Error(`Cloudflare account subdomain readback failed (HTTP ${response.status})`);
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error("Cloudflare account subdomain readback returned invalid JSON");
  }
  const subdomain = body?.result?.subdomain;
  if (body?.success !== true || typeof subdomain !== "string" ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(subdomain)) {
    throw new Error("Cloudflare account subdomain readback was incomplete");
  }
  return subdomain;
}
