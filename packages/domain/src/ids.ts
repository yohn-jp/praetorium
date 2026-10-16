import { z } from "zod";

const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Encodes a ULID-shaped opaque id body: a 48-bit millisecond timestamp
 * (10 base32 chars) followed by 80 bits of caller-supplied randomness (16
 * base32 chars). Pure given its inputs — callers own sourcing the clock
 * and randomness, keeping this package free of I/O.
 */
function encodeUlidBody(timestampMs: number, randomBytes: Uint8Array): string {
  if (!Number.isInteger(timestampMs) || timestampMs < 0 || timestampMs > 281_474_976_710_655) {
    throw new RangeError("timestampMs must fit in an unsigned 48-bit millisecond timestamp");
  }
  if (randomBytes.length !== 10) {
    throw new RangeError("randomBytes must be exactly 10 bytes (80 bits) long");
  }

  let time = timestampMs;
  let timePart = "";
  for (let index = 0; index < 10; index += 1) {
    const remainder = time % 32;
    timePart = CROCKFORD_ALPHABET[remainder] + timePart;
    time = (time - remainder) / 32;
  }

  let buffer = 0;
  let bitsInBuffer = 0;
  let randomPart = "";
  for (const byte of randomBytes) {
    buffer = (buffer << 8) | byte;
    bitsInBuffer += 8;
    while (bitsInBuffer >= 5) {
      bitsInBuffer -= 5;
      randomPart += CROCKFORD_ALPHABET[(buffer >>> bitsInBuffer) & 0x1f];
    }
  }
  if (bitsInBuffer > 0) {
    randomPart += CROCKFORD_ALPHABET[(buffer << (5 - bitsInBuffer)) & 0x1f];
  }

  return timePart + randomPart;
}

/**
 * Opaque IDs use a `<prefix>_<26-char Crockford base32>` shape so no
 * GitHub login, hostname, Kubernetes name, or database row ID can leak
 * through a public identifier.
 */
function opaqueId<Brand extends string>(prefix: string) {
  const pattern = new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`);
  const schema = z
    .string()
    .regex(pattern, `expected an opaque id of the form "${prefix}_<26 char ulid>"`)
    .brand<Brand>();

  function generate(timestampMs: number, randomBytes: Uint8Array): z.infer<typeof schema> {
    return schema.parse(`${prefix}_${encodeUlidBody(timestampMs, randomBytes)}`) as z.infer<
      typeof schema
    >;
  }

  return { schema, generate };
}

const userIdFactory = opaqueId<"UserId">("usr");
export const UserId = userIdFactory.schema;
export type UserId = z.infer<typeof UserId>;
export const newUserId = userIdFactory.generate;

const instanceIdFactory = opaqueId<"InstanceId">("ins");
export const InstanceId = instanceIdFactory.schema;
export type InstanceId = z.infer<typeof InstanceId>;
export const newInstanceId = instanceIdFactory.generate;

const releaseIdFactory = opaqueId<"ReleaseId">("rel");
export const ReleaseId = releaseIdFactory.schema;
export type ReleaseId = z.infer<typeof ReleaseId>;
export const newReleaseId = releaseIdFactory.generate;

const releaseChannelIdFactory = opaqueId<"ReleaseChannelId">("rch");
export const ReleaseChannelId = releaseChannelIdFactory.schema;
export type ReleaseChannelId = z.infer<typeof ReleaseChannelId>;
export const newReleaseChannelId = releaseChannelIdFactory.generate;

const runtimeClusterIdFactory = opaqueId<"RuntimeClusterId">("clu");
export const RuntimeClusterId = runtimeClusterIdFactory.schema;
export type RuntimeClusterId = z.infer<typeof RuntimeClusterId>;
export const newRuntimeClusterId = runtimeClusterIdFactory.generate;

const operationIdFactory = opaqueId<"OperationId">("op");
export const OperationId = operationIdFactory.schema;
export type OperationId = z.infer<typeof OperationId>;
export const newOperationId = operationIdFactory.generate;

const browserSessionIdFactory = opaqueId<"BrowserSessionId">("bse");
export const BrowserSessionId = browserSessionIdFactory.schema;
export type BrowserSessionId = z.infer<typeof BrowserSessionId>;
export const newBrowserSessionId = browserSessionIdFactory.generate;

const mcpCredentialIdFactory = opaqueId<"McpCredentialId">("mcp");
export const McpCredentialId = mcpCredentialIdFactory.schema;
export type McpCredentialId = z.infer<typeof McpCredentialId>;
export const newMcpCredentialId = mcpCredentialIdFactory.generate;

const accessGrantIdFactory = opaqueId<"AccessGrantId">("agr");
export const AccessGrantId = accessGrantIdFactory.schema;
export type AccessGrantId = z.infer<typeof AccessGrantId>;
export const newAccessGrantId = accessGrantIdFactory.generate;

const auditEventIdFactory = opaqueId<"AuditEventId">("aud");
export const AuditEventId = auditEventIdFactory.schema;
export type AuditEventId = z.infer<typeof AuditEventId>;
export const newAuditEventId = auditEventIdFactory.generate;

/**
 * Generates the 26-character Crockford base32 body every opaque id above
 * uses: a 48-bit millisecond timestamp (10 chars, time-sortable) followed
 * by 80 bits of randomness (16 chars). Callers append their own
 * `<prefix>_` and validate with the corresponding id schema.
 */
export function generateUlid(now: number = Date.now()): string {
  const randomBytes = new Uint8Array(10);
  crypto.getRandomValues(randomBytes);
  return encodeUlidBody(now, randomBytes);
}
