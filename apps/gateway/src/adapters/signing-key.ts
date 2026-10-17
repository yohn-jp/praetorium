import { importPrivateKeyJwk, type KeyRecord, type SigningKey } from "@praetorium/auth";

interface StoredSigningKeyMaterial {
  readonly kid: string;
  readonly privateKeyJwk: JsonWebKey;
}

interface CachedSigningKey {
  readonly rawSecretValue: string;
  readonly promise: Promise<SigningKey>;
}

let cachedSigningKey: CachedSigningKey | undefined;

/**
 * The active private key lives only in a Wrangler secret (`GATEWAY_SIGNING_KEY`,
 * JSON-encoded `{kid, privateKeyJwk}`) — never in D1, KV, or a log (ADR
 * 0007). Rotation replaces this secret's value via `wrangler secret put`;
 * it is not mutable from within the Worker, since Workers cannot write their
 * own secret bindings at runtime. Cache only the imported CryptoKey for the
 * exact secret value; registry authorization is checked separately for each
 * request that issues or verifies a signed credential.
 */
export function resolveActiveSigningKey(rawSecretValue: string): Promise<SigningKey> {
  if (cachedSigningKey?.rawSecretValue === rawSecretValue) return cachedSigningKey.promise;

  const pending = (async (): Promise<SigningKey> => {
    const parsed: unknown = JSON.parse(rawSecretValue);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new TypeError("Gateway signing key JSON is invalid");
    }
    const material = parsed as Partial<StoredSigningKeyMaterial>;
    if (typeof material.kid !== "string" || typeof material.privateKeyJwk !== "object" ||
      material.privateKeyJwk === null || Array.isArray(material.privateKeyJwk)) {
      throw new TypeError("Gateway signing key JSON is invalid");
    }
    const privateKeyJwk = material.privateKeyJwk as JsonWebKey;
    if (privateKeyJwk.kty !== "EC" || privateKeyJwk.crv !== "P-256" ||
      typeof privateKeyJwk.x !== "string" || typeof privateKeyJwk.y !== "string" ||
      typeof privateKeyJwk.d !== "string") {
      throw new TypeError("Gateway signing key must be a private P-256 key");
    }
    return {
      kid: material.kid,
      privateKey: await importPrivateKeyJwk(privateKeyJwk),
    };
  })();
  const promise = pending.catch((error: unknown) => {
    if (cachedSigningKey?.promise === promise) cachedSigningKey = undefined;
    throw error;
  });
  cachedSigningKey = { rawSecretValue, promise };
  return promise;
}

export function assertActiveSigningKeyRegistered(
  signingKey: SigningKey,
  publicKeyJwk: JsonWebKey,
  keyRegistry: readonly KeyRecord[],
): void {
  if (!keyRegistry.some((record) => record.kid === signingKey.kid && record.status === "active" &&
    record.publicKeyJwk.x === publicKeyJwk.x && record.publicKeyJwk.y === publicKeyJwk.y)) {
    throw new TypeError("the active Gateway signing key must match its public key registry record");
  }
}
