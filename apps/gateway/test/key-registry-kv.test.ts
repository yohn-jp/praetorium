import { describe, expect, it, vi } from "vitest";
import { loadKeyRegistry } from "../src/adapters/key-registry-kv.js";

const publicJwk = { kty: "EC", crv: "P-256", x: "A".repeat(43), y: "B".repeat(43) };
const activeKey = {
  kid: "key-one",
  status: "active",
  publicKeyJwk: publicJwk,
  createdAt: "2026-10-18T00:00:00.000Z",
  retiredAt: null,
};

describe("Gateway KV signing-key registry", () => {
  it("uses the shortest supported KV cache TTL and observes revocation after that location cache expires", async () => {
    let value = JSON.stringify([activeKey]);
    let cachedValue: string | undefined;
    let cacheExpiresAt = 0;
    let now = 0;
    const get = vi.fn(async (_key: string, options?: { readonly cacheTtl?: number }) => {
      if (cachedValue !== undefined && now < cacheExpiresAt) return cachedValue;
      cachedValue = value;
      cacheExpiresAt = now + (options?.cacheTtl ?? 60) * 1_000;
      return cachedValue;
    });
    const kv = { get } as unknown as KVNamespace;

    expect((await loadKeyRegistry(kv))[0]?.status).toBe("active");
    expect(get).toHaveBeenLastCalledWith("gateway-signing-key-registry", { cacheTtl: 30 });

    value = JSON.stringify([{ ...activeKey, status: "compromised" }]);
    now = 29_999;
    expect((await loadKeyRegistry(kv))[0]?.status).toBe("active");
    now = 30_000;
    expect((await loadKeyRegistry(kv))[0]?.status).toBe("compromised");
    expect(get).toHaveBeenCalledTimes(3);
  });

  it("fails closed if KV cannot refresh the registry after the configured cache window", async () => {
    let now = 0;
    let unavailable = false;
    let cachedValue: string | undefined;
    let cacheExpiresAt = 0;
    const get = vi.fn(async (_key: string, options?: { readonly cacheTtl?: number }) => {
      if (cachedValue !== undefined && now < cacheExpiresAt) return cachedValue;
      if (unavailable) throw new Error("KV unavailable");
      cachedValue = JSON.stringify([activeKey]);
      cacheExpiresAt = now + (options?.cacheTtl ?? 60) * 1_000;
      return cachedValue;
    });
    const kv = { get } as unknown as KVNamespace;

    await expect(loadKeyRegistry(kv)).resolves.toHaveLength(1);
    now = 30_000;
    unavailable = true;
    await expect(loadKeyRegistry(kv)).rejects.toThrow("KV unavailable");
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed registry data and propagates KV read failures", async () => {
    const malformed = { get: vi.fn(async () => JSON.stringify([{ ...activeKey, publicKeyJwk: { ...publicJwk, d: "private" } }])) };
    await expect(loadKeyRegistry(malformed as unknown as KVNamespace)).rejects.toThrow(
      "Gateway public key registry contains invalid or private key material",
    );

    const unavailable = { get: vi.fn(async () => { throw new Error("KV unavailable"); }) };
    await expect(loadKeyRegistry(unavailable as unknown as KVNamespace)).rejects.toThrow("KV unavailable");
  });
});
