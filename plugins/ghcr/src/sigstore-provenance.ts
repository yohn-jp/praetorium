import { bundleFromJSON, type Bundle } from "@sigstore/bundle";
import { TrustedRoot } from "@sigstore/protobuf-specs";
import { toSignedEntity, toTrustMaterial, Verifier, type VerificationPolicy } from "@sigstore/verify";
import trustedRootJson from "./assets/trusted-root.json" with { type: "json" };

const MAX_TIMER_MS = 2_147_483_647;

export interface ProvenanceVerificationInput {
  readonly imageDigest: string;
  readonly signatureRef: string | null;
  readonly provenanceRef: string | null;
}

export interface ProvenanceVerificationResult {
  readonly verified: boolean;
  readonly signerIdentity?: string;
  readonly evidence: readonly string[];
  readonly attestation?: {
    readonly bundleRef: string;
    readonly predicateType: string;
    readonly subjects: readonly { readonly name: string; readonly sha256: string }[];
  };
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
  /** Bound for provenance response headers and body. */
  readonly maxRequestMs?: number;
}

interface InTotoStatement {
  readonly _type?: string;
  readonly predicateType?: string;
  readonly subject?: readonly {
    readonly name?: string;
    readonly digest?: { readonly sha256?: string };
  }[];
}

const SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1";
const IN_TOTO_STATEMENT_V1 = "https://in-toto.io/Statement/v1";
const MAX_ATTESTED_SUBJECTS = 256;

async function readBoundedBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  const headerLength = response.headers.get("content-length");
  if (headerLength !== null && /^\d+$/.test(headerLength) && Number(headerLength) > maxBytes) {
    void response.body?.cancel().catch(() => undefined);
    throw new RangeError("provenance bundle exceeds the configured size limit");
  }
  if (signal.aborted) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("provenance request was canceled");
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let rejectAborted: ((error: Error) => void) | undefined;
  const aborted = new Promise<never>((_, reject) => { rejectAborted = reject; });
  void aborted.catch(() => undefined);
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
    rejectAborted?.(new Error("provenance body read aborted"));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    while (true) {
      const read = reader.read();
      const { done, value } = await Promise.race([read, aborted]);
      if (done) break;
      size += value.byteLength;
      if (!Number.isSafeInteger(size) || size > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new RangeError("provenance bundle exceeds the configured size limit");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (signal.aborted) throw new Error("provenance request was canceled");
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
    try { reader.releaseLock(); } catch { /* an aborted stream can still have a pending read */ }
  }
  if (signal.aborted) throw new Error("provenance request was canceled");
  if (headerLength !== null && /^\d+$/.test(headerLength) && Number(headerLength) !== size) {
    throw new Error("provenance bundle content length does not match its header");
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
  private readonly maxRequestMs: number;

  constructor(private readonly options: SigstoreProvenanceVerifierOptions) {
    this.verifier = options.verifier ?? new Verifier(toTrustMaterial(TrustedRoot.fromJSON(trustedRootJson)));
    this.fetchImplementation = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.maxBundleBytes = options.maxBundleBytes ?? 2 * 1024 * 1024;
    this.maxRequestMs = options.maxRequestMs ?? 15_000;
    if (!Number.isSafeInteger(this.maxBundleBytes) || this.maxBundleBytes < 1) {
      throw new TypeError("maxBundleBytes must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.maxRequestMs) || this.maxRequestMs < 1 || this.maxRequestMs > MAX_TIMER_MS) {
      throw new TypeError("maxRequestMs must be a positive timer duration");
    }
  }

  async verify(input: ProvenanceVerificationInput, signal?: AbortSignal): Promise<ProvenanceVerificationResult> {
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

    const controller = new AbortController();
    let timedOut = false;
    let rejectAborted: ((error: Error) => void) | undefined;
    const aborted = new Promise<never>((_, reject) => { rejectAborted = reject; });
    void aborted.catch(() => undefined);
    const onAbort = () => rejectAborted?.(new Error("provenance fetch aborted"));
    const onCallerAbort = () => controller.abort(signal?.reason);
    controller.signal.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) controller.abort(signal.reason);
    else signal?.addEventListener("abort", onCallerAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("provenance request timed out"));
    }, this.maxRequestMs);

    let response: Response;
    try {
      if (controller.signal.aborted) throw new Error("provenance request was canceled");
      response = await Promise.race([
        this.fetchImplementation(bundleUrl, {
          redirect: "manual", headers: { "accept-encoding": "identity" }, signal: controller.signal,
        }),
        aborted,
      ]);
    } catch {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
      signal?.removeEventListener("abort", onCallerAbort);
      return {
        verified: false,
        evidence: [timedOut ? "provenance request exceeded its configured time limit" : "fetching the provenance bundle failed"],
      };
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
      signal?.removeEventListener("abort", onCallerAbort);
      return { verified: false, evidence: [`provenance bundle request returned ${response.status}`] };
    }
    let bundleJson: unknown;
    try {
      const bytes = await readBoundedBody(response, this.maxBundleBytes, controller.signal);
      if (bytes.byteLength === 0 || bytes.byteLength > this.maxBundleBytes) {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", onAbort);
        signal?.removeEventListener("abort", onCallerAbort);
        return { verified: false, evidence: ["provenance bundle has an invalid size"] };
      }
      bundleJson = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch (error) {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
      signal?.removeEventListener("abort", onCallerAbort);
      if (timedOut) return { verified: false, evidence: ["provenance request exceeded its configured time limit"] };
      if (signal?.aborted) return { verified: false, evidence: ["provenance request was canceled"] };
      if (error instanceof RangeError) {
        return { verified: false, evidence: ["provenance bundle exceeds the configured size limit"] };
      }
      return { verified: false, evidence: ["provenance bundle is not valid JSON"] };
    }
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", onAbort);
    signal?.removeEventListener("abort", onCallerAbort);

    let bundle: Bundle;
    try {
      bundle = bundleFromJSON(bundleJson);
    } catch {
      return { verified: false, evidence: ["provenance bundle has an invalid Sigstore format"] };
    }
    const statement = decodeStatement(bundle);
    const subjects = parseSubjects(statement?.subject);
    if (
      statement?._type !== IN_TOTO_STATEMENT_V1 ||
      statement.predicateType !== SLSA_PROVENANCE_V1 ||
      subjects === null
    ) {
      return { verified: false, evidence: ["provenance statement has an invalid SLSA predicate or subject list"] };
    }
    const expectedDigest = input.imageDigest.slice("sha256:".length);
    if (!subjects.some((subject) => subject.sha256 === expectedDigest)) {
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
          attestation: {
            bundleRef,
            predicateType: statement.predicateType,
            subjects,
          },
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

function parseSubjects(
  input: InTotoStatement["subject"],
): readonly { readonly name: string; readonly sha256: string }[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_ATTESTED_SUBJECTS) {
    return null;
  }
  const subjects: { name: string; sha256: string }[] = [];
  for (const candidate of input) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      typeof candidate.name !== "string" ||
      candidate.name.length === 0 ||
      candidate.name.length > 512 ||
      typeof candidate.digest !== "object" ||
      candidate.digest === null ||
      Array.isArray(candidate.digest)
    ) {
      return null;
    }
    const sha256 = candidate.digest.sha256;
    if (sha256 === undefined) continue;
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(sha256)) return null;
    subjects.push({ name: candidate.name, sha256 });
  }
  return subjects;
}
