import {
  RuntimeIdentityCredentialSchema,
  type RuntimeIdentityCredential,
} from "@praetorium/contracts";
import { err, ok, type Result } from "./domain.js";
import { base64UrlDecode, base64UrlEncode, generateToken } from "./random.js";

export const RUNTIME_IDENTITY_AUDIENCE = "praetorium-git-broker" as const;

export type RuntimeIdentityVerificationErrorCode =
  | "MALFORMED"
  | "UNKNOWN_KEY"
  | "KEY_SOURCE_UNAVAILABLE"
  | "BAD_SIGNATURE"
  | "INVALID_BINDING";

export interface RuntimeIdentityVerificationError {
  readonly code: RuntimeIdentityVerificationErrorCode;
  readonly message: string;
}

export interface RuntimeIdentityExpectedBinding {
  readonly runtimeId: string;
  readonly instanceId: string;
  readonly repositoryId: number;
  readonly installationId: number;
  readonly runtimeEpoch: number;
  readonly leaseId: string;
  readonly now: string;
}

export interface RuntimeIdentityCredentialVerifier {
  verify(
    compactJws: string,
    expected: RuntimeIdentityExpectedBinding,
  ): Promise<Result<RuntimeIdentityCredential, RuntimeIdentityVerificationError>>;
}

export interface RuntimeIdentityCredentialVerifierConfig {
  readonly issuer: string;
  /** Must resolve only currently authorized Control Plane service-identity keys. */
  readonly resolveKey: (kid: string) => Promise<CryptoKey | null>;
}

export interface RuntimeIdentitySigningKey {
  readonly kid: string;
  readonly privateKey: CryptoKey;
}

export interface IssueRuntimeIdentityCredentialInput {
  readonly issuer: string;
  readonly runtimeId: string;
  readonly instanceId: string;
  readonly repositoryId: number;
  readonly installationId: number;
  readonly runtimeEpoch: number;
  readonly leaseId: string;
  readonly now: string;
  readonly ttlSeconds: number;
  readonly tokenId?: string;
}

export interface IssuedRuntimeIdentityCredential {
  readonly token: string;
  readonly descriptor: RuntimeIdentityCredential;
}

/** Issues a runtime service identity. Its audience and subject binding are fixed here. */
export async function issueRuntimeIdentityCredential(
  signingKey: RuntimeIdentitySigningKey,
  input: IssueRuntimeIdentityCredentialInput,
): Promise<IssuedRuntimeIdentityCredential> {
  const nowMs = Date.parse(input.now);
  if (!Number.isFinite(nowMs) || nowMs < 0)
    throw new TypeError("runtime identity issuance time must be valid");
  if (!signingKey.kid || signingKey.kid.length > 128)
    throw new TypeError("runtime identity signing kid is invalid");
  if (!Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds < 1 || input.ttlSeconds > 300)
    throw new TypeError("runtime identity lifetime must be between 1 and 300 seconds");

  const issuedAt = Math.floor(nowMs / 1000);
  const descriptor = RuntimeIdentityCredentialSchema.parse({
    contractVersion: "praetorium-runtime-identity/v1",
    iss: input.issuer,
    aud: RUNTIME_IDENTITY_AUDIENCE,
    sub: input.runtimeId,
    runtimeId: input.runtimeId,
    instanceId: input.instanceId,
    repositoryId: input.repositoryId,
    installationId: input.installationId,
    runtimeEpoch: input.runtimeEpoch,
    leaseId: input.leaseId,
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeJson(value: string): unknown {
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(base64UrlDecode(value)),
  ) as unknown;
}

function isBase64Url(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/u.test(value);
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
  if (parts.length !== 3 || parts.some((part) => !isBase64Url(part))) return null;
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
  try {
    const header = decodeJson(encodedHeader);
    if (!validHeader(header)) return null;
    const signature = base64UrlDecode(encodedSignature);
    if (signature.byteLength !== 64 || base64UrlEncode(signature) !== encodedSignature) return null;
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

/** Verifies ES256, the fixed audience, exact claims, and unskewed expiry before returning claims. */
export function createRuntimeIdentityCredentialVerifier(
  config: RuntimeIdentityCredentialVerifierConfig,
): RuntimeIdentityCredentialVerifier {
  if (!config.issuer) throw new TypeError("runtime identity issuer is required");

  return {
    async verify(compactJws, expected) {
      const decoded = decodeJws(compactJws);
      if (!decoded)
        return err({ code: "MALFORMED", message: "runtime identity credential is malformed" });

      let key: CryptoKey | null;
      try {
        key = await config.resolveKey(decoded.header.kid);
      } catch {
        return err({
          code: "KEY_SOURCE_UNAVAILABLE",
          message: "runtime identity verification keys are unavailable",
        });
      }
      if (!key)
        return err({ code: "UNKNOWN_KEY", message: "runtime identity signing key is unknown" });
      if (
        key.algorithm.name !== "ECDSA" ||
        (key.algorithm as EcKeyAlgorithm).namedCurve !== "P-256"
      )
        return err({ code: "BAD_SIGNATURE", message: "runtime identity signing key is invalid" });

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
        return err({ code: "BAD_SIGNATURE", message: "runtime identity signature is invalid" });

      const nowMs = Date.parse(expected.now);
      if (!Number.isFinite(nowMs) || nowMs < 0)
        return err({ code: "INVALID_BINDING", message: "runtime identity binding is invalid" });
      const nowSeconds = nowMs / 1000;
      try {
        const credential = RuntimeIdentityCredentialSchema.parse(decoded.payload);
        if (
          credential.iss !== config.issuer ||
          credential.aud !== RUNTIME_IDENTITY_AUDIENCE ||
          credential.iat > nowSeconds ||
          credential.nbf > nowSeconds ||
          credential.exp <= nowSeconds ||
          credential.runtimeId !== expected.runtimeId ||
          credential.sub !== expected.runtimeId ||
          credential.instanceId !== expected.instanceId ||
          credential.repositoryId !== expected.repositoryId ||
          credential.installationId !== expected.installationId ||
          credential.runtimeEpoch !== expected.runtimeEpoch ||
          credential.leaseId !== expected.leaseId
        )
          return err({
            code: "INVALID_BINDING",
            message: "runtime identity credential is not valid for this binding",
          });
        return ok(credential);
      } catch {
        return err({
          code: "INVALID_BINDING",
          message: "runtime identity credential claims are invalid",
        });
      }
    },
  };
}
