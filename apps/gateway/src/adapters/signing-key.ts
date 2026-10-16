import { importPrivateKeyJwk, type SigningKey } from "@praetorium/auth";

interface StoredSigningKeyMaterial {
  readonly kid: string;
  readonly privateKeyJwk: JsonWebKey;
}

/**
 * The active private key lives only in a Wrangler secret (`SIGNING_KEY`,
 * JSON-encoded `{kid, privateKeyJwk}`) — never in D1, KV, or a log (ADR
 * 0007). Rotation replaces this secret's value via `wrangler secret put`;
 * it is not mutable from within the Worker, since Workers cannot write
 * their own secret bindings at runtime.
 */
export async function resolveActiveSigningKey(rawSecretValue: string): Promise<SigningKey> {
  const parsed = JSON.parse(rawSecretValue) as StoredSigningKeyMaterial;
  const privateKey = await importPrivateKeyJwk(parsed.privateKeyJwk);
  return { kid: parsed.kid, privateKey };
}
