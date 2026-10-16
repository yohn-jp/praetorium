import { ArtifactAdmissionError, ArtifactAdmissionService } from "../artifacts/admission.js";
import type { BuildInput } from "@praetorium/contracts";
import { isSha256Digest, type Sha256Digest } from "../artifacts/digest.js";
import type { VerifiedArtifact } from "../artifacts/types.js";
import type {
  AdmittedBuildArtifactRecord,
  BuildArtifactCacheRecord,
  BuildArtifactCacheStore,
  BuildCacheLookup,
} from "./types.js";

export class BuildCacheConflictError extends Error {
  constructor(
    readonly buildKey: Sha256Digest,
    readonly record: Extract<BuildArtifactCacheRecord, { state: "conflict" }>,
  ) {
    super(`verified build outputs conflict for ${buildKey}`);
    this.name = "BuildCacheConflictError";
  }
}

function outputIdentity(artifact: VerifiedArtifact): string {
  return JSON.stringify({
    buildKey: artifact.buildKey,
    image: [
      artifact.image.repository,
      artifact.image.digest,
      artifact.image.platformManifestDigest,
      artifact.image.platform,
    ],
    buildInput: artifact.buildInput,
    compositionManifest: [artifact.compositionManifest.repository, artifact.compositionManifest.digest],
    producerRevision: artifact.producerRevision,
    resolvedModules: artifact.resolvedModules.map(({ id, version, artifactDigest }) => [id, version, artifactDigest]),
    contractVersion: artifact.contractVersion,
  });
}

function admissionIdentity(artifact: VerifiedArtifact): string {
  return `${artifact.signerKeyId}\u0000${artifact.signature.signature}\u0000${artifact.issuedAt}`;
}

function appendUnique(
  artifacts: readonly VerifiedArtifact[],
  candidate: VerifiedArtifact,
  identity: (artifact: VerifiedArtifact) => string,
): readonly VerifiedArtifact[] {
  const key = identity(candidate);
  return artifacts.some((artifact) => identity(artifact) === key) ? artifacts : [...artifacts, candidate];
}

/** Pure monotonic transition used by the transactional cache repository. */
export function recordVerifiedArtifactTransition(
  existing: BuildArtifactCacheRecord | null,
  candidate: VerifiedArtifact,
  at: string,
): BuildArtifactCacheRecord {
  if (!isSha256Digest(candidate.buildKey) || !Number.isFinite(Date.parse(at))) {
    throw new TypeError("verified artifact cache record has an invalid key or timestamp");
  }
  if (existing !== null && existing.buildKey !== candidate.buildKey) {
    throw new TypeError("artifact cache transition key does not match the existing record");
  }
  if (existing === null) {
    return {
      state: "admitted",
      buildKey: candidate.buildKey,
      artifact: candidate,
      attestations: [candidate],
      admittedAt: at,
      lastHitAt: null,
    };
  }
  if (existing.state === "conflict") {
    return {
      ...existing,
      artifacts: appendUnique(existing.artifacts, candidate, outputIdentity),
    };
  }
  if (outputIdentity(existing.artifact) !== outputIdentity(candidate)) {
    const artifacts = appendUnique(
      appendUnique(existing.attestations, candidate, outputIdentity),
      existing.artifact,
      outputIdentity,
    );
    return { state: "conflict", buildKey: candidate.buildKey, artifacts, conflictAt: at };
  }
  return {
    ...existing,
    attestations: appendUnique(existing.attestations, candidate, admissionIdentity),
  };
}

/** Canonical artifact admission and verified shared cache lookup. */
export class BuildArtifactCache {
  constructor(
    private readonly admission: ArtifactAdmissionService,
    private readonly store: BuildArtifactCacheStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async admit(candidate: unknown, expectedInput: BuildInput): Promise<VerifiedArtifact> {
    const artifact = await this.admission.verifyCandidate(candidate, expectedInput);
    const record = await this.store.recordVerifiedArtifact(artifact);
    if (record.state === "conflict") throw new BuildCacheConflictError(artifact.buildKey, record);
    if (record.buildKey !== artifact.buildKey) {
      throw new Error("artifact cache store returned a record for a different build key");
    }
    return artifact;
  }

  async lookup(buildKeyInput: string): Promise<BuildCacheLookup> {
    if (!isSha256Digest(buildKeyInput)) throw new TypeError("build key must be an immutable sha256 digest");
    const buildKey = buildKeyInput;
    const record = await this.store.findByBuildKey(buildKey);
    if (!record) return { hit: false, reason: "not_found" };
    if (record.state === "conflict") return { hit: false, reason: "conflicted" };
    if (record.buildKey !== buildKey || record.artifact.buildKey !== buildKey || record.attestations.length === 0) {
      return { hit: false, reason: "admission_policy_failed" };
    }

    let sawReachabilityFailure = false;
    for (const attestation of record.attestations) {
      try {
        const verified = await this.admission.revalidate(attestation);
        await this.store.recordCacheHit(buildKey, this.clock().toISOString());
        return { hit: true, artifact: verified };
      } catch (error) {
        if (error instanceof ArtifactAdmissionError && error.code === "registry_unavailable") {
          sawReachabilityFailure = true;
        } else if (error instanceof ArtifactAdmissionError && error.code === "registry_mismatch") {
          sawReachabilityFailure = true;
        }
      }
    }
    return {
      hit: false,
      reason: sawReachabilityFailure ? "artifact_unreachable" : "admission_policy_failed",
    };
  }
}

export function isAdmittedRecord(record: BuildArtifactCacheRecord): record is AdmittedBuildArtifactRecord {
  return record.state === "admitted";
}
