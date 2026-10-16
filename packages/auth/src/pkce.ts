import { base64UrlEncode, generateToken } from "./random.js";

/** OAuth `state` parameter: random, single-use, bound to the initiating browser. */
export function generateState(): string {
  return generateToken(160);
}

/** RFC 7636 PKCE code verifier, well above the 43-character minimum. */
export function generateCodeVerifier(): string {
  return generateToken(256);
}

/** RFC 7636 `S256` code challenge derived from a verifier. */
export async function deriveCodeChallengeS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}
