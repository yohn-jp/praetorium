import type { Result as DomainResult } from "@praetorium/domain";
export { err, ok } from "@praetorium/domain";

/** Opaque identifiers stay provider-neutral at the auth package boundary. */
export type UserId = string & { readonly __brand: "UserId" };
export type ArcadiaInstanceId = string & { readonly __brand: "InstanceId" };
export type RuntimeClusterId = string & { readonly __brand: "RuntimeClusterId" };
export type McpCredentialId = string & { readonly __brand: "McpCredentialId" };
export type AccessGrantId = string & { readonly __brand: "AccessGrantId" };
export type Result<T, E = { readonly code: string; readonly message: string }> = DomainResult<T, E>;

const ACCESS_GRANT_ID_PATTERN = /^agr_[0-9A-HJKMNP-TV-Z]{26}$/;

export const AccessGrantId = {
  parse(value: string): AccessGrantId {
    if (!ACCESS_GRANT_ID_PATTERN.test(value)) throw new TypeError("invalid access grant id");
    return value as AccessGrantId;
  },
};

const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function generateUlid(now = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > 281_474_976_710_655) {
    throw new RangeError("timestamp must fit in 48 bits");
  }
  const random = crypto.getRandomValues(new Uint8Array(10));
  let time = now;
  let timePart = "";
  for (let index = 0; index < 10; index += 1) {
    const remainder = time % 32;
    timePart = CROCKFORD_ALPHABET[remainder] + timePart;
    time = (time - remainder) / 32;
  }
  let buffer = 0;
  let bits = 0;
  let randomPart = "";
  for (const byte of random) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      randomPart += CROCKFORD_ALPHABET[(buffer >>> bits) & 31];
    }
  }
  if (bits > 0) randomPart += CROCKFORD_ALPHABET[(buffer << (5 - bits)) & 31];
  return timePart + randomPart;
}
