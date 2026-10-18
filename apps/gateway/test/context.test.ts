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

  it("requires all declared runtime bindings before reading configuration", async () => {
    await expect(createGatewayContext({} as GatewayEnv, "request-1", "2026-10-17T03:00:00.000Z"))
      .rejects.toThrow("Gateway Durable Object, KV, Control Plane and Rate Limiting bindings are required");
  });
});
