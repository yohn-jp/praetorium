import { base64UrlEncode } from "./random.js";

async function importHmacKey(secretKey: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    secretKey as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/**
 * Keyed digest (HMAC-SHA-256) of a secret value under a server-held pepper
 * key. Used so a disclosed database row (the digest) can never be replayed
 * as the credential itself: reproducing it requires the pepper, which never
 * leaves the Worker secret store.
 */
export async function keyedDigest(secretKey: Uint8Array, value: string): Promise<string> {
  const key = await importHmacKey(secretKey);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return base64UrlEncode(new Uint8Array(signature));
}

/**
 * Constant-time string comparison. Digests compared here are always
 * fixed-length encoder output, so comparing lengths first leaks nothing
 * beyond what the wire format already reveals.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}
