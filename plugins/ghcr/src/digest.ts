export type Sha256Digest = `sha256:${string}`;

const SHA256_RE = /^sha256:[0-9a-f]{64}$/;

export function isSha256Digest(value: unknown): value is Sha256Digest {
  return typeof value === "string" && SHA256_RE.test(value);
}

export function requireSha256Digest(value: unknown, label = "digest"): Sha256Digest {
  if (!isSha256Digest(value)) {
    throw new TypeError(`${label} must be a lowercase sha256 OCI digest`);
  }
  return value;
}

export async function sha256Digest(bytes: Uint8Array | ArrayBuffer): Promise<Sha256Digest> {
  let owned: ArrayBuffer;
  if (bytes instanceof ArrayBuffer) {
    owned = bytes.slice(0);
  } else {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    owned = copy.buffer;
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", owned);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodeBase64(value: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new TypeError("value is not valid base64");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** Stable JSON encoding used as the exact signed message for builder attestations. */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("signed JSON numbers must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}
