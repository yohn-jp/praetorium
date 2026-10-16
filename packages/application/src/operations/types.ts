import type { ResourceRequirements, RuntimeMetadata } from "@praetorium/contracts";
import type { InstanceSnapshot, OperationRecord, RepositorySnapshot } from "../instances/types.js";

export const OPERATION_PHASES = [
  "accepted",
  "waiting-for-artifact",
  "waiting-for-capacity",
  "capacity-reserved",
  "quiescing-old",
  "old-quiesced",
  "stopping-old",
  "old-writer-absent",
  "starting-target",
  "target-ready",
  "route-activated",
  "complete",
  "blocked",
  "failed",
  "unknown",
] as const;

export type OperationPhase = (typeof OPERATION_PHASES)[number];

export type CapacityResourceSnapshot = {
  readonly allocatable: ResourceRequirements;
  readonly requested: ResourceRequirements;
  readonly nodeResourceVersion: string;
  readonly podResourceVersion: string;
};

export type CapacitySnapshotInput = {
  readonly clusterId: string;
  readonly observedAt: number;
  readonly complete: boolean;
  readonly capacity: CapacityResourceSnapshot;
  /** Reservation IDs whose exact workloads are represented by this Pod census. */
  readonly representedReservationIds: readonly string[];
};

export type RuntimeReservation = {
  readonly reservationId: string;
  readonly instanceId: string;
  readonly repositoryId: number;
  readonly runtimeEpoch: number;
  readonly generation: number;
  readonly clusterId: string | null;
  readonly status: "pending" | "reserved" | "allocated" | "released" | "blocked";
  readonly capacitySnapshotEpoch: number;
  readonly resources: ResourceRequirements;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type ClaimedOperation = {
  readonly operation: OperationRecord;
  readonly snapshot: RepositorySnapshot;
  /** Stops and cleanup may be claimed without a capacity reservation. */
  readonly reservation: RuntimeReservation | null;
  readonly deploymentRevision: DeploymentRevisionSummary | null;
  readonly currentReservation: RuntimeReservation | null;
  readonly currentDeploymentRevision: DeploymentRevisionSummary | null;
};

export type DeploymentRevisionSummary = {
  readonly revisionId: string;
  readonly instanceId: string;
  readonly repositoryId: number;
  readonly generation: number;
  readonly buildKey: string;
  readonly buildId: string;
  readonly selection: Readonly<Record<string, unknown>>;
  readonly resources: ResourceRequirements;
  readonly runtimeMetadata: RuntimeMetadata;
  readonly artifactDigest: string | null;
  readonly status: "building" | "admitted" | "failed" | "superseded";
  readonly artifact: VerifiedArtifactSummary | null;
};

/** Verifier output stored with an admitted OCI digest. */
export type VerifiedArtifactSummary = {
  readonly artifactDigest: string;
  readonly manifestDigest: string;
  readonly platformManifestDigest: string;
  readonly compositionManifestDigest: string;
  readonly producerRevision: string;
  readonly requestedModules: readonly string[];
  readonly resolvedModules: readonly Readonly<Record<string, unknown>>[];
  readonly contractVersions: Readonly<Record<string, unknown>>;
  readonly sbomRef: string | null;
  readonly provenanceRef: string | null;
  readonly verification: Readonly<Record<string, unknown>>;
  readonly statement: Readonly<Record<string, unknown>>;
  readonly signature: Readonly<Record<string, unknown>>;
  readonly verifierId: string;
  readonly admittedAt: number | null;
};

export type OperationCheckpointInput = {
  readonly operationId: string;
  readonly workerId: string;
  readonly leaseToken: string;
  readonly leaseEpoch: number;
  readonly expectedCheckpointSequence: number;
  readonly phase: OperationPhase;
  readonly checkpoint: Readonly<Record<string, unknown>>;
  readonly now: number;
};

export type OperationObservation = {
  readonly operationId: string;
  readonly instanceId: string;
  readonly repositoryId: number;
  readonly generation: number;
  readonly runtimeEpoch: number;
  readonly sequence: number;
  readonly observedState: InstanceSnapshot["observedState"];
  readonly observedArtifactDigest: string | null;
  readonly observedRevisionId: string | null;
  readonly reportedAt: number;
};

export type OperationTerminal = "succeeded" | "failed" | "blocked";

export type ReserveRuntimeInput = {
  readonly operationId: string;
  readonly workerId: string;
  readonly leaseToken: string;
  readonly leaseEpoch: number;
  readonly expectedRuntimeEpoch: number;
  readonly expectedCapacityEpoch: number;
  readonly clusterId: string;
  readonly resources: ResourceRequirements;
  readonly reservationId: string;
  readonly now: number;
};

export type ReservationSnapshot = {
  readonly clusterId: string;
  readonly capacityEpoch: number;
  readonly observedAt: number;
  readonly complete: boolean;
  readonly capacity: CapacityResourceSnapshot | null;
  readonly representedReservationIds: readonly string[];
  readonly reservations: readonly RuntimeReservation[];
};

export type OperationStore = {
  getOperationById(operationId: string): Promise<OperationRecord | null>;
  recordCapacitySnapshot(input: {
    readonly clusterId: string;
    readonly observedAt: number;
    readonly complete: boolean;
    readonly capacity: CapacityResourceSnapshot;
    readonly representedReservationIds: readonly string[];
  }): Promise<number | null>;
  reserveRuntime(input: ReserveRuntimeInput): Promise<RuntimeReservation | null>;
  releaseRuntimeReservation(input: {
    readonly reservationId: string;
    readonly operationId: string;
    readonly workerId: string;
    readonly leaseToken: string;
    readonly leaseEpoch: number;
    readonly expectedReservationRuntimeEpoch: number;
    readonly now: number;
  }): Promise<boolean>;
  currentReservations(clusterId: string): Promise<ReservationSnapshot>;
  claimNextOperation(input: {
    readonly workerId: string;
    readonly clusterId: string;
    readonly leaseToken: string;
    readonly now: number;
    readonly leaseSeconds: number;
  }): Promise<ClaimedOperation | null>;
  heartbeatOperation(input: {
    readonly operationId: string;
    readonly workerId: string;
    readonly leaseToken: string;
    readonly leaseEpoch: number;
    readonly sequence: number;
    readonly now: number;
    readonly leaseSeconds: number;
  }): Promise<{ readonly operation: OperationRecord; readonly leaseExpiresAt: number } | null>;
  appendOperationCheckpoint(input: OperationCheckpointInput): Promise<OperationRecord | null>;
  advanceRuntimeEpochForRecovery(input: {
    readonly operationId: string;
    readonly workerId: string;
    readonly leaseToken: string;
    readonly leaseEpoch: number;
    readonly expectedRuntimeEpoch: number;
    readonly checkpoint: Readonly<Record<string, unknown>>;
    readonly now: number;
  }): Promise<OperationRecord | null>;
  reportOperation(input: {
    readonly operationId: string;
    readonly workerId: string;
    readonly leaseToken: string;
    readonly leaseEpoch: number;
    readonly sequence: number;
    readonly observation: OperationObservation;
    readonly terminal: OperationTerminal | null;
    readonly now: number;
  }): Promise<{
    readonly operation: OperationRecord;
    readonly applied: boolean;
    readonly duplicate: boolean;
  } | null>;
};

export class OperationFenceConflict extends Error {
  readonly code = "OPERATION_FENCE_CONFLICT";
  constructor(message = "operation lease or sequence is no longer current") {
    super(message);
    this.name = "OperationFenceConflict";
  }
}
