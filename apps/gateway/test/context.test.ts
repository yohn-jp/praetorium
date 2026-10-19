import { describe, expect, it } from "vitest";
import { createGatewayContext, type GatewayEnv } from "../src/context.js";

describe("production Gateway composition", () => {
  it("fails closed when deployment values and auth providers are not configured", async () => {
    const env = {
      USER_AUTH_STATE: {} as DurableObjectNamespace,
      EPHEMERAL_CODES: {} as DurableObjectNamespace,
      GATEWAY_KV: {} as KVNamespace,
      LOGIN_RATE_LIMIT: { limit: async () => ({ success: true }) } as RateLimit,
      MCP_SOURCE_RATE_LIMIT: { limit: async () => ({ success: true }) } as RateLimit,
      MCP_CREDENTIAL_RATE_LIMIT: { limit: async () => ({ success: true }) } as RateLimit,
      RUNTIME_GIT_RATE_LIMIT: { limit: async () => ({ success: true }) } as RateLimit,
      WAKE_RATE_LIMIT: { limit: async () => ({ success: true }) } as RateLimit,
      MUTATION_RECEIPT_RATE_LIMIT: { limit: async () => ({ success: true }) } as RateLimit,
      CONTROL_PLANE: { fetch: async () => new Response() } as Fetcher,
    } satisfies GatewayEnv;

    await expect(createGatewayContext(env, "request-1", "2026-10-17T03:00:00.000Z"))
      .rejects.toThrow("GATEWAY_ORIGIN must be an exact HTTPS origin");
  });

  it("rejects an omitted environment before issuing limiter keys", async () => {
    const original = {
      USER_AUTH_STATE: {} as DurableObjectNamespace,
      EPHEMERAL_CODES: {} as DurableObjectNamespace,
      GATEWAY_KV: {} as KVNamespace,
      CONTROL_PLANE: {} as Fetcher,
      LOGIN_RATE_LIMIT: {} as RateLimit,
      MCP_SOURCE_RATE_LIMIT: {} as RateLimit,
      MCP_CREDENTIAL_RATE_LIMIT: {} as RateLimit,
      RUNTIME_GIT_RATE_LIMIT: {} as RateLimit,
      WAKE_RATE_LIMIT: {} as RateLimit,
      MUTATION_RECEIPT_RATE_LIMIT: {} as RateLimit,
      GATEWAY_ORIGIN: "https://gateway.test",
      GATEWAY_ALLOWED_REPOSITORY_OWNER: "yohn-jp",
      GITHUB_APP_ID: "1234",
      GITHUB_OAUTH_CLIENT_ID: "client-id",
      GITHUB_OAUTH_CLIENT_SECRET: "valid-test-secret-value",
      CONTROL_PLANE_GATEWAY_AUTH: "valid-control-plane-secret",
      INSTANCE_ACCESS_SERVICE_AUTH_TOKEN: "valid-instance-access-secret",
      GATEWAY_TOKEN_ENCRYPTION_KEY_ID: "initial",
      GATEWAY_TOKEN_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      GATEWAY_SESSION_TTL_SECONDS: "3600",
      GATEWAY_HANDOFF_TTL_SECONDS: "60",
      GATEWAY_ACCESS_GRANT_TTL_SECONDS: "300",
      GATEWAY_INSTANCE_HOSTNAME_SUFFIX: "instances.test",
      GATEWAY_SESSION_DIGEST_PEPPER: "test-session-pepper",
      GATEWAY_CREDENTIAL_DIGEST_PEPPER: "test-credential-pepper",
      GATEWAY_HANDOFF_DIGEST_PEPPER: "test-handoff-pepper",
    } satisfies GatewayEnv;
    await expect(createGatewayContext(original, "req", "2026-10-19T00:00:00Z"))
      .rejects.toThrow("GATEWAY_ENVIRONMENT must explicitly identify");
  });

  it("requires all declared runtime bindings before reading configuration", async () => {
    await expect(createGatewayContext({} as GatewayEnv, "request-1", "2026-10-17T03:00:00.000Z"))
      .rejects.toThrow("Gateway Durable Object, KV, Control Plane and Rate Limiting bindings are required");
  });
});
