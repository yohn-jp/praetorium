import { describe, expect, it, vi } from "vitest";
import { createGatewayContext, type GatewayEnv } from "../src/context.js";

async function signingMaterial() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const privateKeyJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicKeyJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  if (!publicKeyJwk.x || !publicKeyJwk.y) throw new Error("generated signing key is missing public coordinates");
  return {
    secret: JSON.stringify({ kid: "gateway-key", privateKeyJwk }),
    registry: [{
      kid: "gateway-key",
      status: "active",
      publicKeyJwk: { kty: "EC", crv: "P-256", x: publicKeyJwk.x, y: publicKeyJwk.y },
      createdAt: "2026-10-18T00:00:00.000Z",
      retiredAt: null,
    }],
  };
}

function encodedEncryptionKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

describe("Gateway signing authority initialization", () => {
  it("loads the registry only on demand and fails closed when the active key is revoked", async () => {
    const material = await signingMaterial();
    let registryValue = JSON.stringify(material.registry);
    const get = vi.fn(async () => registryValue);
    const env = {
      USER_AUTH_STATE: {} as DurableObjectNamespace,
      EPHEMERAL_CODES: {} as DurableObjectNamespace,
      GATEWAY_KV: { get } as unknown as KVNamespace,
      LOGIN_RATE_LIMIT: { limit: async () => ({ success: true }) } as RateLimit,
      MCP_SOURCE_RATE_LIMIT: { limit: async () => ({ success: true }) } as RateLimit,
      MCP_CREDENTIAL_RATE_LIMIT: { limit: async () => ({ success: true }) } as RateLimit,
      RUNTIME_GIT_RATE_LIMIT: { limit: async () => ({ success: true }) } as RateLimit,
      WAKE_RATE_LIMIT: { limit: async () => ({ success: true }) } as RateLimit,
      MUTATION_RECEIPT_RATE_LIMIT: { limit: async () => ({ success: true }) } as RateLimit,
      CONTROL_PLANE: { fetch: vi.fn(async () => new Response()) } as unknown as Fetcher,
      GATEWAY_ORIGIN: "https://gateway.test",
      GATEWAY_SESSION_TTL_SECONDS: "3600",
      GATEWAY_HANDOFF_TTL_SECONDS: "60",
      GATEWAY_ACCESS_GRANT_TTL_SECONDS: "300",
      GATEWAY_INSTANCE_HOSTNAME_SUFFIX: "instances.test",
      GATEWAY_ALLOWED_REPOSITORY_OWNER: "yohn-jp",
      GITHUB_APP_ID: "5355765",
      GITHUB_OAUTH_CLIENT_ID: "gateway-test-client",
      GITHUB_OAUTH_CLIENT_SECRET: "gateway-test-oauth-secret-0123456789",
      GATEWAY_SESSION_DIGEST_PEPPER: "gateway-test-session-pepper-0123456789",
      GATEWAY_CREDENTIAL_DIGEST_PEPPER: "gateway-test-credential-pepper-0123456789",
      GATEWAY_HANDOFF_DIGEST_PEPPER: "gateway-test-handoff-pepper-0123456789",
      GATEWAY_TOKEN_ENCRYPTION_KEY: encodedEncryptionKey(),
      GATEWAY_TOKEN_ENCRYPTION_KEY_ID: "test-encryption-key",
      GATEWAY_SIGNING_KEY: material.secret,
      CONTROL_PLANE_GATEWAY_AUTH: "gateway-test-control-plane-secret-0123456789",
      INSTANCE_ACCESS_SERVICE_AUTH_TOKEN: "gateway-test-instance-access-secret-0123456789",
    } satisfies GatewayEnv;

    const context = await createGatewayContext(env, "gateway-context-test", "2026-10-18T00:00:00.000Z");
    expect(get).not.toHaveBeenCalled();

    await expect(context.getSigningKey()).resolves.toMatchObject({ kid: "gateway-key" });
    expect(get).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledWith("gateway-signing-key-registry", { cacheTtl: 30 });

    registryValue = JSON.stringify(material.registry.map((record) => ({ ...record, status: "compromised" })));
    const nextRequest = await createGatewayContext(env, "gateway-context-test-2", "2026-10-18T00:00:01.000Z");
    await expect(nextRequest.getSigningKey()).rejects.toThrow(
      "the active Gateway signing key must match its public key registry record",
    );
    expect(get).toHaveBeenCalledTimes(2);
  });
});
