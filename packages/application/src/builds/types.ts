import type {
  BuilderArtifactStatement,
  BuilderSignature,
  BuildReportRequest,
} from "@praetorium/contracts";
import type { BuildInput } from "@praetorium/contracts";

/** Bounded worker-local status. Raw BuildKit vertex names and logs are never exposed. */
export type BuildProgress = {
  stage: "preparing" | "building" | "publishing";
  percent: number | null;
};

export type BuildCandidate = {
  candidateRef: string;
  manifestDigest: string;
  /** Producer receipt, verified against registry bytes before it is signed. */
  compositionManifest: BuilderArtifactStatement["compositionManifest"];
};

export type SignedBuildCandidate = BuildCandidate & {
  statement: BuilderArtifactStatement;
  signature: BuilderSignature;
};

export type BuildFailure = Extract<BuildReportRequest["result"], { kind: "failed" | "canceled" }>;
export type BuildReportResult = BuildReportRequest["result"];

export type BuildExecutionRequest = {
  buildId: string;
  buildKey: string;
  attemptId: string;
  attempt: number;
  leaseEpoch: number;
  input: BuildInput;
  /** Worker-local callback. It is not part of BuildInput or the canonical build key. */
  onProgress?: (progress: BuildProgress) => void;
};

export interface BuildProvider {
  execute(
    request: BuildExecutionRequest,
    signal: AbortSignal,
    beforeEffect: () => Promise<void>,
  ): Promise<BuildCandidate>;
}

/** T05 implementation reads/verifies OCI bytes, composition closure and smoke evidence. */
export interface BuildCandidateVerifier {
  verify(input: {
    buildKey: string;
    expected: BuildInput;
    candidate: BuildCandidate;
    signal: AbortSignal;
  }): Promise<BuilderArtifactStatement>;
}

/** A builder identity adapter signs only a statement returned by the verifier. */
export interface BuilderSigner {
  sign(statement: BuilderArtifactStatement): Promise<BuilderSignature>;
}

export interface BuildAttestor {
  attest(input: {
    buildKey: string;
    expected: BuildInput;
    candidate: BuildCandidate;
    signal: AbortSignal;
    beforeEffect: () => Promise<void>;
  }): Promise<SignedBuildCandidate>;
}
