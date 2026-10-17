import type { KeyRecord } from "@praetorium/auth";

const KEY_REGISTRY_KV_KEY = "gateway-signing-key-registry";
const KEY_REGISTRY_KV_CACHE_TTL_SECONDS = 30;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseKeyRegistry(raw: string | null): readonly KeyRecord[] {
  const value: unknown = raw === null ? [] : JSON.parse(raw);
  if (!Array.isArray(value) || value.length > 8) throw new TypeError("Gateway public key registry is invalid");
  const statuses = new Set(["active", "next", "retired", "compromised"]);
  return value.map((entry): KeyRecord => {
    if (!object(entry) || typeof entry["kid"] !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(entry["kid"]) ||
      typeof entry["status"] !== "string" || !statuses.has(entry["status"]) ||
      typeof entry["createdAt"] !== "string" ||
      !(entry["retiredAt"] === null || typeof entry["retiredAt"] === "string") ||
      !object(entry["publicKeyJwk"])) throw new TypeError("Gateway public key registry is invalid");
    const jwk = entry["publicKeyJwk"];
    if (Object.hasOwn(jwk, "d") || jwk["kty"] !== "EC" || jwk["crv"] !== "P-256" ||
      typeof jwk["x"] !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(jwk["x"]) ||
      typeof jwk["y"] !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(jwk["y"])) {
      throw new TypeError("Gateway public key registry contains invalid or private key material");
    }
    return {
      kid: entry["kid"],
      status: entry["status"] as KeyRecord["status"],
      publicKeyJwk: { kty: "EC", crv: "P-256", x: jwk["x"], y: jwk["y"] },
      createdAt: entry["createdAt"],
      retiredAt: entry["retiredAt"],
    };
  });
}

/**
 * The registry contains public JWKs only. Load it only on routes that issue or
 * verify signed credentials, or publish JWKS. Explicitly use KV's minimum
 * supported location-cache TTL. KV remains eventually consistent across
 * locations; there is intentionally no additional Worker-isolate cache.
 */
export async function loadKeyRegistry(kv: KVNamespace): Promise<readonly KeyRecord[]> {
  return parseKeyRegistry(await kv.get(KEY_REGISTRY_KV_KEY, {
    cacheTtl: KEY_REGISTRY_KV_CACHE_TTL_SECONDS,
  }));
}

export async function saveKeyRegistry(kv: KVNamespace, keys: readonly KeyRecord[]): Promise<void> {
  await kv.put(KEY_REGISTRY_KV_KEY, JSON.stringify(keys));
}
