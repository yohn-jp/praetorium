import { generateToken } from "../random.js";

/** The one supported signing algorithm and curve; deliberately not configurable per token. */
const KEY_ALGORITHM: EcKeyGenParams = { name: "ECDSA", namedCurve: "P-256" };

export interface SigningKeyPair {
  readonly privateKey: CryptoKey;
  readonly publicKey: CryptoKey;
}

/** Extractable so the private key can be exported for storage in the Cloudflare secret store (never in D1/KV/logs). */
export async function generateSigningKeyPair(): Promise<SigningKeyPair> {
  const keyPair = await crypto.subtle.generateKey(KEY_ALGORITHM, true, ["sign", "verify"]);
  return { privateKey: keyPair.privateKey, publicKey: keyPair.publicKey };
}

/** A stable, random `kid` — never derived from key material or a sequence number. */
export function generateKid(): string {
  return generateToken(128);
}

export async function exportPublicKeyJwk(publicKey: CryptoKey): Promise<JsonWebKey> {
  return crypto.subtle.exportKey("jwk", publicKey);
}

export async function exportPrivateKeyJwk(privateKey: CryptoKey): Promise<JsonWebKey> {
  return crypto.subtle.exportKey("jwk", privateKey);
}

export async function importPublicKeyJwk(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, KEY_ALGORITHM, true, ["verify"]);
}

export async function importPrivateKeyJwk(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, KEY_ALGORITHM, true, ["sign"]);
}
