import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertWorkersDevOriginForAccount,
  readCloudflareApiToken,
  readWorkersDevSubdomain,
} from "../../scripts/cloudflare-workers-dev.mjs";

const accountId = "a".repeat(32);
const secret = "fixture-private-access-token-that-is-not-logged";

function profileFixture() {
  const home = mkdtempSync(path.join(os.tmpdir(), "praetorium-wrangler-auth-"));
  const config = path.join(home, "xdg", ".wrangler", "config");
  mkdirSync(config, { recursive: true, mode: 0o700 });
  const profile = path.join(config, "default.toml");
  writeFileSync(profile, `oauth_token = "${secret}"\n`, { mode: 0o600 });
  return { home, profile, env: { XDG_CONFIG_HOME: path.join(home, "xdg") } };
}

test("account subdomain readback binds the expected worker.dev hosts to the selected account", async () => {
  let request;
  const subdomain = await readWorkersDevSubdomain({
    accountId,
    token: secret,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, json: async () => ({ success: true, result: { subdomain: "praetorium-test" } }) };
    },
  });
  assert.equal(subdomain, "praetorium-test");
  assert.equal(request.url, `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`);
  assert.equal(request.options.method, "GET");
  assert.equal(request.options.headers.authorization, `Bearer ${secret}`);
  assert.equal(assertWorkersDevOriginForAccount(
    "https://praetorium-t14-canary-gateway.praetorium-test.workers.dev",
    "praetorium-t14-canary-gateway",
    subdomain,
  ), true);
  assert.throws(() => assertWorkersDevOriginForAccount(
    "https://praetorium-t14-canary-gateway.foreign-account.workers.dev",
    "praetorium-t14-canary-gateway",
    subdomain,
  ), /selected Cloudflare account/u);
  assert.throws(() => assertWorkersDevOriginForAccount(
    "https://praetorium-t14-canary-gateway.praetorium-test.workers.dev.evil.example",
    "praetorium-t14-canary-gateway",
    subdomain,
  ), /selected Cloudflare account/u);
});

test("account subdomain readback fails closed on bad API status, shape, or account input", async () => {
  await assert.rejects(readWorkersDevSubdomain({ accountId, token: secret, fetchImpl: async () => ({
    ok: false, status: 403,
  }) }), /HTTP 403/u);
  await assert.rejects(readWorkersDevSubdomain({ accountId, token: secret, fetchImpl: async () => ({
    ok: true, status: 200, json: async () => ({ success: true, result: {} }),
  }) }), /incomplete/u);
  await assert.rejects(readWorkersDevSubdomain({ accountId: "production", token: secret }), /valid account/u);
});

test("Wrangler account token is read privately from env or the owner profile and never printed", () => {
  const fixture = profileFixture();
  try {
    assert.equal(readCloudflareApiToken({ env: fixture.env, home: fixture.home, uid: process.getuid() }), secret);
    assert.equal(readCloudflareApiToken({ env: { CLOUDFLARE_API_TOKEN: secret }, home: fixture.home }), secret);
    chmodSync(fixture.profile, 0o644);
    assert.throws(() => readCloudflareApiToken({ env: fixture.env, home: fixture.home, uid: process.getuid() }), /owner-private/u);
    rmSync(fixture.profile);
    symlinkSync(path.join(fixture.home, "missing"), fixture.profile);
    assert.throws(() => readCloudflareApiToken({ env: fixture.env, home: fixture.home, uid: process.getuid() }));
  } finally {
    rmSync(fixture.home, { recursive: true, force: true });
  }
});
