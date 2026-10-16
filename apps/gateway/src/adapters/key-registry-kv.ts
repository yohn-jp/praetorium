import type { KeyRecord } from "@praetorium/auth";

const KEY_REGISTRY_KV_KEY = "gateway-signing-key-registry";

/**
 * The key registry holds only public JWK material and status metadata
 * (never a private key — see ADR 0007), so KV is an appropriate store for
 * it despite being eventually consistent: a rotation propagating a few
 * seconds late across edge locations only means some requests briefly see
 * the previous registry state, not a security regression.
 */
export async function loadKeyRegistry(kv: KVNamespace): Promise<readonly KeyRecord[]> {
  const raw = await kv.get(KEY_REGISTRY_KV_KEY);
  return raw ? (JSON.parse(raw) as readonly KeyRecord[]) : [];
}

export async function saveKeyRegistry(kv: KVNamespace, keys: readonly KeyRecord[]): Promise<void> {
  await kv.put(KEY_REGISTRY_KV_KEY, JSON.stringify(keys));
}
