import { base64UrlDecode, base64UrlEncode, randomBytes } from "./random.js";

export interface TokenEncryptionKey {
  readonly id: string;
  readonly key: CryptoKey;
}

export interface EncryptedSecret {
  readonly version: 1;
  readonly keyId: string;
  readonly iv: string;
  readonly ciphertext: string;
}

export interface TokenVault {
  seal(plaintext: string, context: string): Promise<EncryptedSecret>;
  open(secret: EncryptedSecret, context: string): Promise<string>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bufferSource(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export async function importTokenEncryptionKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.byteLength !== 32) throw new TypeError("AES-256 token encryption keys must be 32 bytes");
  return crypto.subtle.importKey("raw", bufferSource(raw), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Encrypts user access and refresh tokens with authenticated, row-specific context. */
export function createTokenVault(
  keys: readonly TokenEncryptionKey[],
  currentKeyId: string,
): TokenVault {
  const byId = new Map(keys.map((key) => [key.id, key.key]));
  if (!currentKeyId || !byId.has(currentKeyId))
    throw new TypeError("current token encryption key is missing");

  return {
    async seal(plaintext, context) {
      const key = byId.get(currentKeyId);
      if (!key) throw new TypeError("current token encryption key is missing");
      const iv = randomBytes(12);
      const ciphertext = await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: bufferSource(iv),
          additionalData: bufferSource(
            encoder.encode(`praetorium-token:v1:${context}:${currentKeyId}`),
          ),
        },
        key,
        bufferSource(encoder.encode(plaintext)),
      );
      return {
        version: 1,
        keyId: currentKeyId,
        iv: base64UrlEncode(iv),
        ciphertext: base64UrlEncode(new Uint8Array(ciphertext)),
      };
    },

    async open(secret, context) {
      if (secret.version !== 1) throw new TypeError("unsupported encrypted secret version");
      const key = byId.get(secret.keyId);
      if (!key) throw new TypeError("encrypted secret key is unavailable");
      const plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: bufferSource(base64UrlDecode(secret.iv)),
          additionalData: bufferSource(
            encoder.encode(`praetorium-token:v1:${context}:${secret.keyId}`),
          ),
        },
        key,
        bufferSource(base64UrlDecode(secret.ciphertext)),
      );
      return decoder.decode(plaintext);
    },
  };
}
