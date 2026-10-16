import { bundleFromJSON, type Bundle } from "@sigstore/bundle";
import { TrustedRoot } from "@sigstore/protobuf-specs";
import { toSignedEntity, toTrustMaterial, Verifier, type VerificationPolicy } from "@sigstore/verify";
import trustedRootJson from "./assets/trusted-root.json" with { type: "json" };

export interface ProvenanceVerificationInput {
  readonly imageDigest: string;
  readonly signatureRef: string | null;
  readonly provenanceRef: string | null;
}

export interface ProvenanceVerificationResult {
  readonly verified: boolean;
  readonly signerIdentity?: string;
  readonly evidence: readonly string[];
}

export interface SignerIdentityAllowlistEntry {
  readonly subjectAlternativeName: string;
  readonly issuer?: string;
}

export interface SigstoreProvenanceVerifierOptions {
  /** Explicit producer identities. An empty list rejects every bundle. */
  readonly signerIdentityAllowlist: readonly SignerIdentityAllowlistEntry[];
  readonly fetch?: typeof fetch;
  readonly verifier?: Verifier;
  readonly maxBundleBytes?: number;
}

interface InTotoStatement {
  readonly subject?: readonly { readonly digest?: { readonly sha256?: string } }[];
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const headerLength = response.headers.get("content-length");
  if (headerLength !== null && /^\d+$/.test(headerLength) && Number(headerLength) > maxBytes) {
    throw new RangeError("provenance bundle exceeds the configured size limit");
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (!Number.isSafeInteger(size) || size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new RangeError("provenance bundle exceeds the configured size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function decodeStatement(bundle: Bundle): InTotoStatement | null {
  if (bundle.content.$case !== "dsseEnvelope") return null;
  try {
    const statement: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bundle.content.dsseEnvelope.payload));
    if (typeof statement !== "object" || statement === null || Array.isArray(statement)) return null;
    return statement as InTotoStatement;
  } catch {
    return null;
  }
}

function policyFor(entry: SignerIdentityAllowlistEntry): VerificationPolicy {
  return {
    subjectAlternativeName: entry.subjectAlternativeName,
    ...(entry.issuer === undefined ? {} : { extensions: { issuer: entry.issuer } }),
  };
}

/**
 * Verifies source-release Sigstore bundles with the same trust-root and
 * in-toto subject binding as Arcadia's current GHCR ingestion path. Identity
 * allowlisting is mandatory; derived build artifacts use the separate
 * operator-key verifier instead.
 */
export class SigstoreProvenanceVerifier {
  private readonly verifier: Verifier;
  private readonly fetchImplementation: typeof fetch;
  private readonly maxBundleBytes: number;

  constructor(private readonly options: SigstoreProvenanceVerifierOptions) {
    this.verifier = options.verifier ?? new Verifier(toTrustMaterial(TrustedRoot.fromJSON(trustedRootJson)));
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.maxBundleBytes = options.maxBundleBytes ?? 2 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxBundleBytes) || this.maxBundleBytes < 1) {
      throw new TypeError("maxBundleBytes must be a positive safe integer");
    }
  }

  async verify(input: ProvenanceVerificationInput): Promise<ProvenanceVerificationResult> {
    const bundleRef = input.signatureRef ?? input.provenanceRef;
    if (bundleRef === null) return { verified: false, evidence: ["no provenance bundle was supplied"] };
    if (!/^sha256:[0-9a-f]{64}$/.test(input.imageDigest)) {
      return { verified: false, evidence: ["artifact identity is not an immutable sha256 digest"] };
    }
    if (this.options.signerIdentityAllowlist.length === 0) {
      return { verified: false, evidence: ["no producer signer identities are configured"] };
    }

    let bundleUrl: URL;
    try {
      bundleUrl = new URL(bundleRef);
    } catch {
      return { verified: false, evidence: ["provenance reference is not a valid URL"] };
    }
    if (bundleUrl.protocol !== "https:" || bundleUrl.username || bundleUrl.password) {
      return { verified: false, evidence: ["provenance reference must be an HTTPS URL without embedded credentials"] };
    }

    let response: Response;
    try {
      response = await this.fetchImplementation(bundleUrl, { redirect: "error" });
    } catch {
      return { verified: false, evidence: ["fetching the provenance bundle failed"] };
    }
    if (!response.ok) {
      return { verified: false, evidence: [`provenance bundle request returned ${response.status}`] };
    }
    let bundleJson: unknown;
    try {
      const bytes = await readBoundedBody(response, this.maxBundleBytes);
      if (bytes.byteLength === 0 || bytes.byteLength > this.maxBundleBytes) {
        return { verified: false, evidence: ["provenance bundle has an invalid size"] };
      }
      bundleJson = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch (error) {
      if (error instanceof RangeError) {
        return { verified: false, evidence: ["provenance bundle exceeds the configured size limit"] };
      }
      return { verified: false, evidence: ["provenance bundle is not valid JSON"] };
    }

    let bundle: Bundle;
    try {
      bundle = bundleFromJSON(bundleJson);
    } catch {
      return { verified: false, evidence: ["provenance bundle has an invalid Sigstore format"] };
    }
    const statement = decodeStatement(bundle);
    const expectedDigest = input.imageDigest.slice("sha256:".length);
    if (!statement?.subject?.some((subject) => subject.digest?.sha256 === expectedDigest)) {
      return { verified: false, evidence: ["provenance subject does not cover the requested artifact digest"] };
    }

    let lastError: unknown;
    for (const identity of this.options.signerIdentityAllowlist) {
      if (!identity.subjectAlternativeName) continue;
      try {
        const signer = this.verifier.verify(toSignedEntity(bundle), policyFor(identity));
        return {
          verified: true,
          signerIdentity: signer.identity?.subjectAlternativeName,
          evidence: [
            "DSSE signature, certificate chain and transparency evidence verified against the Sigstore trust root",
            "provenance subject digest matches the immutable artifact digest",
            "producer signer matches the configured identity allowlist",
          ],
        };
      } catch (error) {
        lastError = error;
      }
    }
    return {
      verified: false,
      evidence: [lastError === undefined ? "no valid signer identity is configured" : "signature or producer identity verification failed"],
    };
  }
}
