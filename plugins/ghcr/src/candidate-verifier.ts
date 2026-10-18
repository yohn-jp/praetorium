import {
  buildKey,
  BuilderArtifactStatementSchema,
  canonicalBuildInput,
  CompositionManifestSchema,
  validateCompositionBindings,
  type BuildInput,
  type BuilderArtifactStatement,
} from "@praetorium/contracts";
import { parseBuilderArtifactStatement } from "./builder-signature.js";
import { isSha256Digest, sha256Digest, type Sha256Digest } from "./digest.js";
import type { GhcrRegistryClient } from "./oci-registry-client.js";
import type { OciPlatform, VerifiedOciImage } from "./oci-types.js";

const MAX_COMPOSITION_MANIFEST_BYTES = 4 * 1024 * 1024;

export interface UnsignedBuildCandidate {
  readonly expectedInput: BuildInput;
  readonly expectedBuildKey: Sha256Digest;
  readonly candidateRef: string;
  readonly manifestDigest: Sha256Digest;
  readonly compositionManifest: {
    readonly repository: string;
    readonly digest: Sha256Digest;
  };
}

export interface ApprovedCandidateOutput {
  /** Canonical origin recorded by the Control Plane; transport overrides never change it. */
  readonly registryHost: string;
  /** Trusted derived-output repository from the persisted build request. */
  readonly repository: string;
}

export class CandidateVerificationError extends Error {
  constructor(readonly reason: "invalid_candidate" | "registry" | "composition" | "canceled", message: string) {
    super(message);
    this.name = "CandidateVerificationError";
  }
}

/** Binds trusted builder output to the immutable request and registry identity before signing. */
export class GhcrCandidateVerifier {
  constructor(
    private readonly registry: GhcrRegistryClient,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async verifyUnsignedCandidate(
    candidate: UnsignedBuildCandidate,
    approvedOutput: ApprovedCandidateOutput,
    signal: AbortSignal,
  ): Promise<BuilderArtifactStatement> {
    if (signal.aborted) throw new CandidateVerificationError("canceled", "candidate verification was canceled");
    const registryHost = this.registry.registryHost;
    const repository = parseCandidateReference(candidate.candidateRef, candidate.manifestDigest, approvedOutput, registryHost);
    if (!repository || !isSha256Digest(candidate.expectedBuildKey) || !isSha256Digest(candidate.compositionManifest.digest)) {
      throw new CandidateVerificationError("invalid_candidate", "candidate reference or digest is invalid");
    }
    let expectedKey: string;
    try {
      expectedKey = await buildKey(candidate.expectedInput);
    } catch {
      throw new CandidateVerificationError("invalid_candidate", "persisted build input is invalid");
    }
    if (expectedKey !== candidate.expectedBuildKey) {
      throw new CandidateVerificationError("invalid_candidate", "persisted build key does not match its canonical input");
    }

    const platform = toOciPlatform(candidate.expectedInput.platform);
    let image: VerifiedOciImage;
    let compositionBlob;
    try {
      [image, compositionBlob] = await Promise.all([
        this.registry.verifyImage(repository, candidate.manifestDigest, platform, signal),
        this.registry.readBlob(candidate.compositionManifest.repository, candidate.compositionManifest.digest, MAX_COMPOSITION_MANIFEST_BYTES, signal),
      ]);
    } catch {
      if (signal.aborted) throw new CandidateVerificationError("canceled", "candidate registry verification was canceled");
      throw new CandidateVerificationError("registry", "registry could not verify the candidate and composition bytes");
    }
    if (
      image.repository !== repository ||
      image.manifestDigest !== candidate.manifestDigest ||
      `${image.platform.os}/${image.platform.architecture}` !== candidate.expectedInput.platform
    ) {
      throw new CandidateVerificationError("registry", "candidate digest or selected platform does not match persisted input");
    }
    if (
      compositionBlob.digest !== candidate.compositionManifest.digest ||
      await sha256Digest(compositionBlob.bytes) !== candidate.compositionManifest.digest
    ) {
      throw new CandidateVerificationError("composition", "composition manifest content does not match its digest");
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(compositionBlob.bytes));
    } catch {
      throw new CandidateVerificationError("composition", "composition manifest is not valid UTF-8 JSON");
    }
    const compositionParse = CompositionManifestSchema.safeParse(decoded);
    if (!compositionParse.success) {
      throw new CandidateVerificationError("composition", "composition manifest does not match the producer contract");
    }
    const compositionManifest = compositionParse.data;
    try {
      const expectedCanonicalInput = canonicalBuildInput(candidate.expectedInput);
      const manifestCanonicalInput = canonicalBuildInput(compositionManifest.buildInput);
      const canonicalInput = JSON.parse(expectedCanonicalInput) as BuildInput;
      const normalizedManifest = { ...compositionManifest, buildInput: canonicalInput };
      if (
        manifestCanonicalInput !== expectedCanonicalInput ||
        compositionManifest.buildKey !== expectedKey ||
        !(await validateCompositionBindings(normalizedManifest))
      ) {
        throw new Error("composition binding mismatch");
      }
    } catch {
      throw new CandidateVerificationError("composition", "composition manifest is not bound to the persisted build input");
    }

    const statement: BuilderArtifactStatement = {
      schemaVersion: "praetorium.build-artifact/v1",
      buildKey: candidate.expectedBuildKey,
      artifact: {
        repository,
        digest: candidate.manifestDigest,
        platformManifestDigest: image.platformManifestDigest,
        platform: compositionManifest.platform,
      },
      compositionManifest: candidate.compositionManifest,
      producerRevision: candidate.expectedInput.producerRevision,
      resolvedModules: compositionManifest.resolvedModules,
      contractVersion: "scriptorium-build/v1",
      issuedAt: validNow(this.clock),
    };
    if (!BuilderArtifactStatementSchema.safeParse(statement).success || parseBuilderArtifactStatement(statement) === null) {
      throw new CandidateVerificationError("composition", "verified composition cannot form a canonical artifact statement");
    }

    return statement;
  }
}

function parseCandidateReference(
  reference: string,
  digest: string,
  approvedOutput: ApprovedCandidateOutput,
  registryHost: string,
): string | null {
  if (!isSha256Digest(digest) || typeof reference !== "string") return null;
  if (
    typeof approvedOutput.registryHost !== "string" ||
    approvedOutput.registryHost !== registryHost ||
    typeof approvedOutput.repository !== "string"
  ) return null;
  const repository = approvedOutput.repository;
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/u.test(repository)) return null;
  return reference === `${registryHost}/${repository}@${digest}` ? repository : null;
}

function toOciPlatform(platform: BuildInput["platform"]): OciPlatform {
  const [os, architecture] = platform.split("/");
  return { os: os!, architecture: architecture! };
}

function validNow(clock: () => Date): string {
  const now = clock();
  if (!Number.isFinite(now.getTime())) throw new TypeError("candidate verifier clock returned an invalid time");
  return now.toISOString();
}

