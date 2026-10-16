import {
  assertMutationReceiptBinding,
  MutationAuthorizationReceiptSchema,
  type MutationAuthorizationReceipt,
} from "@praetorium/contracts";
import type { UserId } from "./domain.js";
import { err, ok, type Result } from "./domain.js";
import { base64UrlDecode, base64UrlEncode, generateToken } from "./random.js";

export type MutationReceiptVerificationErrorCode =
  | "MALFORMED"
  | "UNKNOWN_KEY"
  | "KEY_SOURCE_UNAVAILABLE"
  | "BAD_SIGNATURE"
  | "INVALID_BINDING";

export interface MutationReceiptVerificationError {
  readonly code: MutationReceiptVerificationErrorCode;
  readonly message: string;
}

export interface MutationReceiptExpectedBinding {
  readonly repositoryId: number;
  readonly instanceId: string;
  readonly runtimeEpoch: number;
  readonly operationId: string;
  readonly payloadDigest: string;
  readonly now: string;
}

export interface MutationAuthorizationReceiptVerifier {
  verify(
    compactJws: string,
    expected: MutationReceiptExpectedBinding,
  ): Promise<Result<MutationAuthorizationReceipt, MutationReceiptVerificationError>>;
}

export interface MutationAuthorizationReceiptVerifierConfig {
  readonly issuer: string;
  readonly audience: string;
  /** Must resolve only the currently authorized Gateway verification key set. */
  readonly resolveKey: (kid: string) => Promise<CryptoKey | null>;
}

export interface MutationReceiptSigningKey {
  readonly kid: string;
  readonly privateKey: CryptoKey;
}

export interface IssueMutationAuthorizationReceiptInput {
  readonly issuer: string;
  readonly audience: string;
  readonly subjectUserId: UserId | string;
  readonly repositoryId: number;
  readonly instanceId: string;
  readonly runtimeEpoch: number;
  readonly operationId: string;
  readonly payloadDigest: string;
  readonly authorizationRevision: number;
  readonly sessionRevision: number;
  readonly now: string;
  readonly ttlSeconds: number;
  readonly tokenId?: string;
}

export interface IssuedMutationAuthorizationReceipt {
  readonly token: string;
  readonly descriptor: MutationAuthorizationReceipt;
}

/** Issues an exact repository/runtime/operation/payload-bound Gateway ES256 receipt. */
export async function issueMutationAuthorizationReceipt(
  signingKey: MutationReceiptSigningKey,
  input: IssueMutationAuthorizationReceiptInput,
): Promise<IssuedMutationAuthorizationReceipt> {
  const nowMs = new Date(input.now).getTime();
  if (!Number.isFinite(nowMs)) throw new TypeError("mutation receipt issuance time must be valid");
  if (!signingKey.kid || signingKey.kid.length > 128)
    throw new TypeError("mutation receipt signing kid is invalid");
  if (!Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds < 1 || input.ttlSeconds > 60) {
    throw new TypeError("mutation authorization receipt lifetime must be between 1 and 60 seconds");
  }
  const issuedAt = Math.floor(nowMs / 1000);
  const descriptor = MutationAuthorizationReceiptSchema.parse({
    contractVersion: "praetorium-mutation/v1",
    iss: input.issuer,
    sub: input.subjectUserId,
    aud: input.audience,
    repositoryId: input.repositoryId,
    instanceId: input.instanceId,
    runtimeEpoch: input.runtimeEpoch,
    operationId: input.operationId,
    payloadDigest: input.payloadDigest,
    action: "publish",
    authorizationRevision: input.authorizationRevision,
    sessionRevision: input.sessionRevision,
    iat: issuedAt,
    nbf: issuedAt,
    exp: issuedAt + input.ttlSeconds,
    jti: input.tokenId ?? generateToken(128),
  });
  const header = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify({ alg: "ES256", kid: signingKey.kid, typ: "JWT" })),
  );
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(descriptor)));
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    signingKey.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return {
    token: `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`,
    descriptor,
  };
}

interface JwsHeader {
  readonly alg: unknown;
  readonly kid: unknown;
  readonly typ: unknown;
}

function decodeJson(value: string): unknown {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(value))) as unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validHeader(value: unknown): value is JwsHeader {
  if (!isPlainObject(value)) return false;
  return (
    Object.keys(value).sort().join(",") === "alg,kid,typ" &&
    value.alg === "ES256" &&
    typeof value.kid === "string" &&
    value.kid.length > 0 &&
    value.kid.length <= 128 &&
    value.typ === "JWT"
  );
}

function decodeJws(compactJws: string): {
  readonly header: JwsHeader;
  readonly payload: unknown;
  readonly signingInput: string;
  readonly signature: Uint8Array;
} | null {
  if (compactJws.length > 16_384) return null;
  const parts = compactJws.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) return null;
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
  try {
    const header = decodeJson(encodedHeader);
    if (!validHeader(header)) return null;
    const signature = base64UrlDecode(encodedSignature);
    if (signature.byteLength !== 64) return null;
    return {
      header,
      payload: decodeJson(encodedPayload),
      signingInput: `${encodedHeader}.${encodedPayload}`,
      signature,
    };
  } catch {
    return null;
  }
}

function bufferSource(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/** Cryptographically verifies the fixed ES256 JWT before applying the strict receipt binding. */
export function createMutationAuthorizationReceiptVerifier(
  config: MutationAuthorizationReceiptVerifierConfig,
): MutationAuthorizationReceiptVerifier {
  if (!config.issuer || !config.audience)
    throw new TypeError("mutation receipt issuer and audience are required");

  return {
    async verify(compactJws, expected) {
      const decoded = decodeJws(compactJws);
      if (!decoded) return err({ code: "MALFORMED", message: "mutation receipt is malformed" });

      let key: CryptoKey | null;
      try {
        key = await config.resolveKey(decoded.header.kid as string);
      } catch {
        return err({
          code: "KEY_SOURCE_UNAVAILABLE",
          message: "mutation receipt verification keys are unavailable",
        });
      }
      if (!key)
        return err({ code: "UNKNOWN_KEY", message: "mutation receipt signing key is unknown" });
      if (
        key.algorithm.name !== "ECDSA" ||
        (key.algorithm as EcKeyAlgorithm).namedCurve !== "P-256"
      ) {
        return err({ code: "BAD_SIGNATURE", message: "mutation receipt signing key is invalid" });
      }

      let validSignature: boolean;
      try {
        validSignature = await crypto.subtle.verify(
          { name: "ECDSA", hash: "SHA-256" },
          key,
          bufferSource(decoded.signature),
          new TextEncoder().encode(decoded.signingInput),
        );
      } catch {
        validSignature = false;
      }
      if (!validSignature)
        return err({ code: "BAD_SIGNATURE", message: "mutation receipt signature is invalid" });

      const nowMs = new Date(expected.now).getTime();
      if (!Number.isFinite(nowMs))
        return err({ code: "INVALID_BINDING", message: "mutation receipt binding is invalid" });
      try {
        const receipt = assertMutationReceiptBinding(decoded.payload, {
          issuer: config.issuer,
          audience: config.audience,
          repositoryId: expected.repositoryId,
          instanceId: expected.instanceId,
          runtimeEpoch: expected.runtimeEpoch,
          operationId: expected.operationId,
          payloadDigest: expected.payloadDigest,
          now: Math.floor(nowMs / 1000),
        });
        return ok(receipt);
      } catch {
        return err({
          code: "INVALID_BINDING",
          message: "mutation receipt is not valid for this operation",
        });
      }
    },
  };
}
