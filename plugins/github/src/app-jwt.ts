import { base64UrlEncode } from "@praetorium/auth";

function decodeBase64(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function encodeLength(length: number): Uint8Array {
  if (length < 128) return Uint8Array.of(length);
  const bytes: number[] = [];
  for (let value = length; value > 0; value >>>= 8) bytes.unshift(value & 0xff);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function der(tag: number, content: Uint8Array): Uint8Array {
  return Uint8Array.of(tag, ...encodeLength(content.length), ...content);
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = der(0x02, Uint8Array.of(0));
  const algorithm = der(
    0x30,
    Uint8Array.of(0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00),
  );
  const privateKey = der(0x04, pkcs1);
  return der(0x30, concat(version, algorithm, privateKey));
}

function privateKeyDer(pem: string): Uint8Array {
  const match = /^-----BEGIN (PRIVATE KEY|RSA PRIVATE KEY)-----([\s\S]+?)-----END \1-----$/.exec(
    pem.trim(),
  );
  if (!match) throw new TypeError("GitHub App private key PEM is malformed");
  const decoded = decodeBase64(match[2]!.replace(/\s/g, ""));
  return match[1] === "RSA PRIVATE KEY" ? pkcs1ToPkcs8(decoded) : decoded;
}

const encoder = new TextEncoder();

function bufferSource(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/** Creates the short-lived RS256 App JWT used only to mint installation tokens. */
export async function createGitHubAppJwt(
  appId: number,
  privateKeyPem: string,
  now = new Date(),
): Promise<string> {
  if (!Number.isSafeInteger(appId) || appId < 1)
    throw new TypeError("GitHub App ID must be a positive integer");
  const pkcs8 = privateKeyDer(privateKeyPem);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    bufferSource(pkcs8),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const header = base64UrlEncode(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = base64UrlEncode(
    encoder.encode(
      JSON.stringify({ iss: String(appId), iat: nowSeconds - 60, exp: nowSeconds + 540 }),
    ),
  );
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    encoder.encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}
