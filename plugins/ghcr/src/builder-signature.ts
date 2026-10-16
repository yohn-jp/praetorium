import {
  BuilderArtifactStatementSchema,
  BuilderSignatureSchema,
  type BuilderArtifactStatement,
  type BuilderSignature,
} from "@praetorium/contracts";
import { canonicalJson, decodeBase64, toArrayBuffer, type JsonValue } from "./digest.js";

export type { BuilderArtifactStatement, BuilderSignature } from "@praetorium/contracts";

export interface OperatorSigningKey {
  /** Operator-controlled identifier for a pinned public key; it is not a CI identity. */
  readonly keyId: string;
  readonly publicKeyBase64: string;
  readonly revoked?: boolean;
  readonly validFrom?: string;
  readonly validUntil?: string;
}

export interface BuilderSignatureVerification {
  readonly verified: boolean;
  readonly keyId?: string;
  readonly reason?: string;
}

export interface BuilderSignatureVerifier {
  verify(statement: BuilderArtifactStatement, signature: BuilderSignature): Promise<BuilderSignatureVerification>;
}

/**
 * Runtime validation uses the repository-wide producer contract. The module
 * list also has a canonical order so signatures remain stable across producers.
 */
export function parseBuilderArtifactStatement(value: unknown): BuilderArtifactStatement | null {
  const parsed = BuilderArtifactStatementSchema.safeParse(value);
  if (!parsed.success) return null;
  const seen = new Set<string>();
  for (let index = 0; index < parsed.data.resolvedModules.length; index += 1) {
    const id = parsed.data.resolvedModules[index]!.id;
    if (seen.has(id) || (index > 0 && parsed.data.resolvedModules[index - 1]!.id >= id)) return null;
    seen.add(id);
  }
  return parsed.data;
}

export function parseBuilderSignature(value: unknown): BuilderSignature | null {
  const parsed = BuilderSignatureSchema.safeParse(value);
  if (!parsed.success) return null;
  try {
    if (decodeBase64(parsed.data.signature).byteLength !== 64) return null;
  } catch {
    return null;
  }
  return parsed.data;
}

/** Verifies derived artifacts only against operator-pinned Ed25519 keys. */
export class OperatorBuilderSignatureVerifier implements BuilderSignatureVerifier {
  private readonly keys: ReadonlyMap<string, OperatorSigningKey>;

  constructor(
    keys: readonly OperatorSigningKey[],
    private readonly clock: () => number = Date.now,
    private readonly maxFutureSkewMs = 5 * 60_000,
  ) {
    const byId = new Map<string, OperatorSigningKey>();
    for (const key of keys) {
      if (
        typeof key.keyId !== "string" || key.keyId.length < 1 || key.keyId.length > 128 ||
        byId.has(key.keyId) || !isValidWindow(key.validFrom) || !isValidWindow(key.validUntil)
      ) {
        throw new TypeError("operator signer keys must have unique ids and valid time windows");
      }
      byId.set(key.keyId, key);
    }
    this.keys = byId;
  }

  async verify(
    statementInput: BuilderArtifactStatement,
    signatureInput: BuilderSignature,
  ): Promise<BuilderSignatureVerification> {
    const statement = parseBuilderArtifactStatement(statementInput);
    const signature = parseBuilderSignature(signatureInput);
    if (statement === null || signature === null) {
      return { verified: false, reason: "attestation or signature shape is invalid" };
    }
    const key = this.keys.get(signature.keyId);
    if (!key || key.revoked === true) return { verified: false, reason: "operator signing key is not trusted" };

    const signedAt = Date.parse(statement.issuedAt);
    const now = this.clock();
    if (!Number.isFinite(now) || signedAt > now + this.maxFutureSkewMs) {
      return { verified: false, reason: "attestation timestamp is in the future" };
    }
    if (key.validFrom !== undefined && signedAt < Date.parse(key.validFrom)) {
      return { verified: false, reason: "operator signing key was not valid at attestation time" };
    }
    if (key.validUntil !== undefined && signedAt > Date.parse(key.validUntil)) {
      return { verified: false, reason: "operator signing key was no longer valid at attestation time" };
    }

    let publicKeyBytes: Uint8Array;
    let signatureBytes: Uint8Array;
    try {
      publicKeyBytes = decodeBase64(key.publicKeyBase64);
      signatureBytes = decodeBase64(signature.signature);
    } catch {
      return { verified: false, reason: "operator signing key material is malformed" };
    }
    if (publicKeyBytes.byteLength !== 32 || signatureBytes.byteLength !== 64) {
      return { verified: false, reason: "operator signing key material has an invalid size" };
    }

    try {
      const publicKey = await globalThis.crypto.subtle.importKey(
        "raw",
        toArrayBuffer(publicKeyBytes),
        { name: "Ed25519" } as AlgorithmIdentifier,
        false,
        ["verify"],
      );
      const message = new TextEncoder().encode(canonicalJson(statement as unknown as JsonValue));
      const verified = await globalThis.crypto.subtle.verify(
        { name: "Ed25519" } as AlgorithmIdentifier,
        publicKey,
        toArrayBuffer(signatureBytes),
        toArrayBuffer(message),
      );
      return verified
        ? { verified: true, keyId: key.keyId }
        : { verified: false, reason: "operator signature does not cover this artifact statement" };
    } catch {
      return { verified: false, reason: "Ed25519 verification failed" };
    }
  }
}

export function builderStatementBytes(statement: BuilderArtifactStatement): Uint8Array {
  const parsed = parseBuilderArtifactStatement(statement);
  if (parsed === null) throw new TypeError("builder artifact statement is invalid");
  return new TextEncoder().encode(canonicalJson(parsed as unknown as JsonValue));
}

function isValidWindow(value: string | undefined): boolean {
  return value === undefined || (typeof value === "string" && Number.isFinite(Date.parse(value)));
}
