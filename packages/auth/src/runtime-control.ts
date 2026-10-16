import {
  assertRuntimeControlBinding,
  RuntimeControlCredentialSchema,
  type RuntimeControlCredential,
} from "@praetorium/contracts";
import { err, ok, type Result } from "./domain.js";
import { base64UrlDecode, base64UrlEncode, generateToken } from "./random.js";

export type RuntimeControlVerificationErrorCode =
  | "MALFORMED"
  | "UNKNOWN_KEY"
  | "KEY_SOURCE_UNAVAILABLE"
  | "BAD_SIGNATURE"
  | "INVALID_BINDING";

export interface RuntimeControlVerificationError {
  readonly code: RuntimeControlVerificationErrorCode;
  readonly message: string;
}

export interface RuntimeControlExpectedBinding {
  readonly instanceId: string;
  readonly repositoryId: number;
  readonly runtimeEpoch: number;
  readonly operationId: string;
  readonly action: RuntimeControlCredential["action"];
  readonly payloadDigest: string;
  readonly now: string;
}

export interface RuntimeControlCredentialVerifier {
  verify(
    compactJws: string,
    expected: RuntimeControlExpectedBinding,
  ): Promise<Result<RuntimeControlCredential, RuntimeControlVerificationError>>;
}

export interface RuntimeControlCredentialVerifierConfig {
  readonly issuer: string;
  readonly audience: string;
  /** Must resolve only currently authorized Control Plane verification keys. */
  readonly resolveKey: (kid: string) => Promise<CryptoKey | null>;
}

export interface RuntimeControlSigningKey {
  readonly kid: string;
  readonly privateKey: CryptoKey;
}

export interface IssueRuntimeControlCredentialInput {
  readonly issuer: string;
  readonly audience: string;
  readonly subject: string;
  readonly instanceId: string;
  readonly repositoryId: number;
  readonly runtimeEpoch: number;
  readonly operationId: string;
  readonly action: RuntimeControlCredential["action"];
  readonly payloadDigest: string;
  readonly now: string;
  readonly ttlSeconds: number;
  readonly tokenId?: string;
}

export interface IssuedRuntimeControlCredential {
  readonly token: string;
  readonly descriptor: RuntimeControlCredential;
}

/** Issues a short-lived ES256 credential bound to one runtime-control operation. */
export async function issueRuntimeControlCredential(
  signingKey: RuntimeControlSigningKey,
  input: IssueRuntimeControlCredentialInput,
): Promise<IssuedRuntimeControlCredential> {
  const nowMs = new Date(input.now).getTime();
  if (!Number.isFinite(nowMs)) throw new TypeError("runtime control issuance time must be valid");
  if (!signingKey.kid || signingKey.kid.length > 128)
    throw new TypeError("runtime control signing kid is invalid");
  if (!Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds < 1 || input.ttlSeconds > 60) {
    throw new TypeError("runtime control credential lifetime must be between 1 and 60 seconds");
  }

  const issuedAt = Math.floor(nowMs / 1000);
  const descriptor = RuntimeControlCredentialSchema.parse({
    contractVersion: "praetorium-runtime-control/v1",
    iss: input.issuer,
    sub: input.subject,
    aud: input.audience,
    instanceId: input.instanceId,
    repositoryId: input.repositoryId,
    runtimeEpoch: input.runtimeEpoch,
    operationId: input.operationId,
    action: input.action,
    payloadDigest: input.payloadDigest,
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
  readonly alg: "ES256";
  readonly kid: string;
  readonly typ: "JWT";
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

/** Verifies ES256 before applying the strict operation and runtime binding. */
export function createRuntimeControlCredentialVerifier(
  config: RuntimeControlCredentialVerifierConfig,
): RuntimeControlCredentialVerifier {
  if (!config.issuer || !config.audience)
    throw new TypeError("runtime control issuer and audience are required");

  return {
    async verify(compactJws, expected) {
      const decoded = decodeJws(compactJws);
      if (!decoded)
        return err({ code: "MALFORMED", message: "runtime control credential is malformed" });

      let key: CryptoKey | null;
      try {
        key = await config.resolveKey(decoded.header.kid);
      } catch {
        return err({
          code: "KEY_SOURCE_UNAVAILABLE",
          message: "runtime control verification keys are unavailable",
        });
      }
      if (!key)
        return err({ code: "UNKNOWN_KEY", message: "runtime control signing key is unknown" });
      if (
        key.algorithm.name !== "ECDSA" ||
        (key.algorithm as EcKeyAlgorithm).namedCurve !== "P-256"
      ) {
        return err({ code: "BAD_SIGNATURE", message: "runtime control signing key is invalid" });
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
        return err({ code: "BAD_SIGNATURE", message: "runtime control signature is invalid" });

      const nowMs = new Date(expected.now).getTime();
      if (!Number.isFinite(nowMs))
        return err({ code: "INVALID_BINDING", message: "runtime control binding is invalid" });
      try {
        const credential = assertRuntimeControlBinding(decoded.payload, {
          issuer: config.issuer,
          audience: config.audience,
          instanceId: expected.instanceId,
          repositoryId: expected.repositoryId,
          runtimeEpoch: expected.runtimeEpoch,
          operationId: expected.operationId,
          action: expected.action,
          payloadDigest: expected.payloadDigest,
          now: Math.floor(nowMs / 1000),
        });
        return ok(credential);
      } catch {
        return err({
          code: "INVALID_BINDING",
          message: "runtime control credential is not valid for this operation",
        });
      }
    },
  };
}
