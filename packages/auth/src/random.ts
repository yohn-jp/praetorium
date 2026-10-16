/** Cryptographically secure random bytes via WebCrypto (Workers and Node both provide it globally). */
export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/**
 * Generates a URL-safe random token carrying at least `bits` of entropy.
 * The encoded length is rounded up to a whole byte, so the actual entropy
 * is always `>= bits`, never truncated below it.
 */
export function generateToken(bits: number): string {
  const byteLength = Math.ceil(bits / 8);
  return base64UrlEncode(randomBytes(byteLength));
}
