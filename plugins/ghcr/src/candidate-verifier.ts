import {
  buildKey,
  BuilderArtifactStatementSchema,
  canonicalBuildInput,
  CompositionManifestSchema,
  validateCompositionBindings,
  type BuildInput,
  type BuilderArtifactStatement,
  type CompositionManifest,
} from "@praetorium/contracts";
import { parseBuilderArtifactStatement } from "./builder-signature.js";
import { isSha256Digest, sha256Digest, type Sha256Digest } from "./digest.js";
import type { GhcrRegistryClient } from "./oci-registry-client.js";
import type { OciPlatform, VerifiedOciImage } from "./oci-types.js";

export interface CompositionArtifactInspection {
  readonly imageDigest: Sha256Digest;
  readonly compositionManifestDigest: Sha256Digest;
  readonly serverEntry: string | null;
  readonly browserEntry: string | null;
  readonly serverModuleIds: readonly string[];
  readonly browserModuleIds: readonly string[];
  readonly nativeDependencies: CompositionManifest["nativeDependencies"];
  readonly smoke: {
    readonly id: string;
    readonly healthPath: string;
    readonly passed: boolean;
  };
}

/**
 * Injected by the isolated build worker. It must inspect files/dependencies
 * from the immutable image digest and execute the producer-declared smoke;
 * the registry package intentionally does not ship a container runtime.
 */
export interface CompositionArtifactInspector {
  inspectAndSmoke(
    input: {
      readonly imageReference: string;
      readonly image: VerifiedOciImage;
      readonly compositionManifest: CompositionManifest;
    },
    signal: AbortSignal,
  ): Promise<CompositionArtifactInspection>;
}

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
  constructor(readonly reason: "invalid_candidate" | "registry" | "composition" | "closure" | "smoke" | "canceled", message: string) {
    super(message);
    this.name = "CandidateVerificationError";
  }
}

/** Verifies untrusted build output before it can be operator-signed. */
export class GhcrCandidateVerifier {
  constructor(
    private readonly registry: GhcrRegistryClient,
    private readonly inspector: CompositionArtifactInspector,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async verifyUnsignedCandidate(
    candidate: UnsignedBuildCandidate,
    approvedOutput: ApprovedCandidateOutput,
    signal: AbortSignal,
  ): Promise<BuilderArtifactStatement> {
    if (signal.aborted) throw new CandidateVerificationError("canceled", "candidate verification was canceled");
    const repository = parseCandidateReference(candidate.candidateRef, candidate.manifestDigest, approvedOutput);
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
        this.registry.readBlob(candidate.compositionManifest.repository, candidate.compositionManifest.digest, undefined, signal),
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

    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abortFromCaller, { once: true });
    if (signal.aborted) controller.abort(signal.reason);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new CandidateVerificationError("smoke", "declared composition smoke timed out"));
      }, compositionManifest.smoke.timeoutSeconds * 1000);
    });
    try {
      const inspection = await Promise.race([
        this.inspector.inspectAndSmoke({
          imageReference: `${approvedOutput.registryHost}/${repository}@${candidate.manifestDigest}`,
          image,
          compositionManifest,
        }, controller.signal),
        timeoutPromise,
      ]);
      if (!inspectionMatches(inspection, image, candidate.manifestDigest, candidate.compositionManifest.digest, compositionManifest)) {
        throw new CandidateVerificationError("closure", "inspected image closure or native dependencies do not match the composition");
      }
      if (
        inspection.smoke.id !== compositionManifest.smoke.id ||
        inspection.smoke.healthPath !== compositionManifest.smoke.healthPath ||
        inspection.smoke.passed !== true
      ) {
        throw new CandidateVerificationError("smoke", "declared composition health smoke did not pass");
      }
    } catch (error) {
      if (error instanceof CandidateVerificationError) throw error;
      if (signal.aborted) throw new CandidateVerificationError("canceled", "candidate inspection was canceled");
      if (controller.signal.aborted) throw new CandidateVerificationError("smoke", "declared composition smoke timed out");
      throw new CandidateVerificationError("closure", "image closure inspection or smoke failed");
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      signal.removeEventListener("abort", abortFromCaller);
    }

    return statement;
  }
}

function parseCandidateReference(reference: string, digest: string, approvedOutput: ApprovedCandidateOutput): string | null {
  if (!isSha256Digest(digest) || typeof reference !== "string") return null;
  if (approvedOutput.registryHost !== "ghcr.io" || typeof approvedOutput.repository !== "string") return null;
  const repository = approvedOutput.repository;
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/u.test(repository)) return null;
  return reference === `${approvedOutput.registryHost}/${repository}@${digest}` ? repository : null;
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

function inspectionMatches(
  inspection: CompositionArtifactInspection,
  image: VerifiedOciImage,
  imageDigest: Sha256Digest,
  compositionManifestDigest: Sha256Digest,
  manifest: CompositionManifest,
): boolean {
  return (
    inspection.imageDigest === imageDigest &&
    inspection.compositionManifestDigest === compositionManifestDigest &&
    inspection.serverEntry === manifest.server.entry &&
    inspection.browserEntry === manifest.browser.entry &&
    sameStrings(inspection.serverModuleIds, manifest.server.moduleIds) &&
    sameStrings(inspection.browserModuleIds, manifest.browser.moduleIds) &&
    JSON.stringify(inspection.nativeDependencies) === JSON.stringify(manifest.nativeDependencies) &&
    image.manifestDigest === imageDigest
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
