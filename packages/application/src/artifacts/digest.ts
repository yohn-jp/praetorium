export type Sha256Digest = `sha256:${string}`;

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

export function isSha256Digest(value: unknown): value is Sha256Digest {
  return typeof value === "string" && DIGEST_RE.test(value);
}

export async function sha256Digest(bytes: Uint8Array | ArrayBuffer): Promise<Sha256Digest> {
  let owned: ArrayBuffer;
  if (bytes instanceof ArrayBuffer) {
    owned = bytes.slice(0);
  } else {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    owned = copy.buffer;
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", owned);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
