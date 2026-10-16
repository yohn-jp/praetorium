import type {
  BuilderArtifactStatement,
  BuilderSignature,
  BuildClaim as ContractBuildClaim,
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

/** Canonical claim returned by the Control Plane contract, including the fence. */
export type BuildClaim = ContractBuildClaim;

export type BuildQueueProgress = BuildProgress;

export type BuildQueueHeartbeatInput = {
  buildId: string;
  attemptId: string;
  workerId: string;
  leaseToken: string;
  leaseEpoch: number;
  sequence: number;
  now: number;
  progress?: BuildQueueProgress;
  leaseSeconds?: number;
};

export type BuildQueueHeartbeatResult = {
  accepted: boolean;
  cancelRequested: boolean;
  leaseExpiresAt: number | null;
};

export type BuildQueueReportInput = {
  buildId: string;
  buildKey: string;
  attemptId: string;
  workerId: string;
  leaseToken: string;
  leaseEpoch: number;
  sequence: number;
  now: number;
  result: BuildReportResult;
};

export type BuildQueueReportResult = { accepted: boolean; duplicate: boolean };

/**
 * Application port implemented by the Control Plane adapter. The lease token
 * is an attempt-scoped fence and must never be sent to BuildKit or a recipe.
 */
export interface BuildQueuePort {
  claimNext(input: {
    workerId: string;
    now: number;
    leaseSeconds: number;
  }): Promise<BuildClaim | null>;
  heartbeat(input: BuildQueueHeartbeatInput): Promise<BuildQueueHeartbeatResult>;
  report(input: BuildQueueReportInput): Promise<BuildQueueReportResult>;
}
