import type {
  BuildClaim as ContractBuildClaim,
  BuildHeartbeatRequest,
  BuildInput,
  BuildReportRequest,
  BuilderArtifactStatement,
  BuilderSignature,
} from "@praetorium/contracts";
import type { VerifiedArtifact } from "../artifacts/types.js";

/** Bounded worker-local progress; raw BuildKit vertices and logs stay private. */
export type BuildQueueProgress = {
  readonly stage: "preparing" | "building" | "publishing";
  readonly percent: number | null;
};

/** Canonical claim returned by the Control Plane, including its attempt fence. */
export type BuildClaim = ContractBuildClaim;

export type BuildQueueHeartbeatInput = BuildHeartbeatRequest & {
  /** Worker-local value. Control Plane adapters must replace it with server time. */
  readonly now: number;
};

export type BuildQueueHeartbeatResult = {
  readonly accepted: boolean;
  readonly cancelRequested: boolean;
  readonly leaseExpiresAt: number | null;
};

export type BuildQueueReportInput = BuildReportRequest & {
  /** Worker-local value. Control Plane adapters must replace it with server time. */
  readonly now: number;
};

export type BuildQueueReportResult = { readonly accepted: boolean; readonly duplicate: boolean };

/** Application port used by the build worker; HTTP adapters validate wire schemas first. */
export interface BuildQueuePort {
  claimNext(input: {
    readonly workerId: string;
    readonly now: number;
    readonly leaseSeconds: number;
  }): Promise<BuildClaim | null>;
  heartbeat(input: BuildQueueHeartbeatInput): Promise<BuildQueueHeartbeatResult>;
  report(input: BuildQueueReportInput): Promise<BuildQueueReportResult>;
}

export type BuildReportFence = {
  readonly buildId: string;
  readonly attemptId: string;
  readonly workerId: string;
  readonly leaseToken: string;
  readonly leaseEpoch: number;
};

export type BuildReportContext = {
  readonly buildKey: string;
  readonly input: BuildInput;
  readonly reportSequence: number;
  readonly lastReportDigest: string | null;
  readonly leaseExpiresAt: number;
};

export type BuildArtifactAdmission = {
  verifyCandidate(
    candidate: {
      readonly statement: BuilderArtifactStatement;
      readonly signature: BuilderSignature;
    },
    expectedInput: BuildInput,
  ): Promise<VerifiedArtifact>;
};

export type BuildAdmissionFailure = {
  readonly code: string;
  readonly retryable: boolean;
};

/** Narrow durable port. Implementations fence every write by the current attempt. */
export interface BuildQueueStore {
  claimNext(input: {
    readonly workerId: string;
    readonly attemptId: string;
    readonly leaseToken: string;
    readonly now: number;
    readonly leaseSeconds: number;
  }): Promise<BuildClaim | null>;
  heartbeat(
    input: BuildQueueHeartbeatInput & { readonly serverNow: number },
  ): Promise<BuildQueueHeartbeatResult>;
  getReportContext(input: BuildReportFence): Promise<BuildReportContext | null>;
  recordReport(input: {
    readonly request: BuildReportRequest;
    readonly serverNow: number;
    readonly reportDigest: string;
    readonly artifact: VerifiedArtifact | null;
    readonly admissionFailure?: BuildAdmissionFailure;
  }): Promise<BuildQueueReportResult>;
}
