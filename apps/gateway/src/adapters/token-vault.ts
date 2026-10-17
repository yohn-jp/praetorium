import { createTokenVault, importTokenEncryptionKey, type TokenVault } from "@praetorium/auth";

interface CachedTokenVault {
  readonly keyId: string;
  readonly rawSecretValue: string;
  readonly promise: Promise<TokenVault>;
}

let cachedTokenVault: CachedTokenVault | undefined;

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError("token encryption key must be base64url");
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/**
 * Reuse only the imported AES key for the exact secret and key ID. Workers
 * cannot mutate secret bindings, and a changed secret or ID replaces the
 * isolate cache so token-key rotation takes effect on the next request.
 */
export function resolveTokenVault(keyId: string, rawSecretValue: string): Promise<TokenVault> {
  if (cachedTokenVault?.keyId === keyId && cachedTokenVault.rawSecretValue === rawSecretValue) {
    return cachedTokenVault.promise;
  }

  const rawKey = decodeBase64Url(rawSecretValue);
  if (rawKey.byteLength !== 32) throw new TypeError("GATEWAY_TOKEN_ENCRYPTION_KEY must decode to 32 bytes");
  const pending = importTokenEncryptionKey(rawKey)
    .then((key) => createTokenVault([{ id: keyId, key }], keyId));
  const promise = pending.catch((error: unknown) => {
    if (cachedTokenVault?.promise === promise) cachedTokenVault = undefined;
    throw error;
  });
  cachedTokenVault = { keyId, rawSecretValue, promise };
  return promise;
}
