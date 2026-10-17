import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker.js";
import type { GatewayEnv } from "../src/env.js";

const publicJwk = { kty: "EC", crv: "P-256", x: "A".repeat(43), y: "B".repeat(43) };
const activeKey = {
  kid: "active-key",
  status: "active",
  publicKeyJwk: publicJwk,
  createdAt: "2026-10-18T00:00:00.000Z",
  retiredAt: null,
};

afterEach(() => vi.restoreAllMocks());

describe("Gateway Worker static routes", () => {
  it("serves liveness with no auth, Control Plane, or KV bindings", async () => {
    const response = await worker.fetch(
      new Request("https://gateway.example/healthz", { headers: { "X-Request-Id": "health-check" } }),
      {} as GatewayEnv,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Request-Id")).toBe("health-check");
    expect(response.headers.get("Strict-Transport-Security")).toContain("max-age=63072000");
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("serves JWKS from the current public registry without initializing Gateway secrets or DOs", async () => {
    const kv = {
      get: vi.fn(async () => JSON.stringify([
        activeKey,
        { ...activeKey, kid: "retired-key", status: "retired" },
        { ...activeKey, kid: "compromised-key", status: "compromised" },
      ])),
    } as unknown as KVNamespace;

    const response = await worker.fetch(
      new Request("https://gateway.example/.well-known/jwks.json"),
      { GATEWAY_KV: kv } as GatewayEnv,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=30, must-revalidate");
    expect(kv.get).toHaveBeenCalledWith("gateway-signing-key-registry", { cacheTtl: 30 });
    const body = await response.json() as { keys: { kid: string }[] };
    expect(body.keys.map(({ kid }) => kid)).toEqual(["active-key", "retired-key"]);
  });

  it("keeps liveness independent of registry outages and fails JWKS closed", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const kv = { get: vi.fn(async () => { throw new Error("KV unavailable"); }) } as unknown as KVNamespace;
    const env = { GATEWAY_KV: kv } as GatewayEnv;

    const live = await worker.fetch(new Request("https://gateway.example/healthz"), env);
    const jwks = await worker.fetch(new Request("https://gateway.example/.well-known/jwks.json"), env);

    expect(live.status).toBe(200);
    expect(jwks.status).toBe(500);
    expect(kv.get).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledOnce();
  });

  it("keeps readiness dependent on configured Gateway authorities", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await worker.fetch(new Request("https://gateway.example/readyz"), {} as GatewayEnv);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "INTERNAL" } });
  });
});
