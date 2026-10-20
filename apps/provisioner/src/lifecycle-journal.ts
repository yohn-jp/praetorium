import type {
  LifecycleJournal,
  LifecycleOperation,
  LifecyclePhase,
  RuntimeAssignment,
  RuntimeDeployment,
} from "@praetorium/application/lifecycle";
import type {
  ClaimedProvisionerOperation,
  ProvisionerOperationRecord,
  ProvisionerOperationService,
  ProvisionerResolvedRuntime,
} from "./operation-client.js";

const CHECKPOINT_SCHEMA_VERSION = 1;
const MAX_CHECKPOINT_BYTES = 32 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new TypeError(`lifecycle checkpoint ${field} is invalid`);
  }
  return value;
}

function requiredInteger(value: unknown, field: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`lifecycle checkpoint ${field} is invalid`);
  }
  return value;
}

function phase(value: unknown): LifecyclePhase {
  const phases: readonly LifecyclePhase[] = [
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
  ];
  if (typeof value !== "string" || !phases.includes(value as LifecyclePhase)) {
    throw new TypeError("lifecycle checkpoint phase is invalid");
  }
  return value as LifecyclePhase;
}

function reason(
  kind: ClaimedProvisionerOperation["operation"]["kind"],
): LifecycleOperation["reason"] {
  if (kind === "update") return "update";
  if (kind === "redeploy") return "redeploy";
  // The persisted operation contract has no idle reason field yet. A stop is
  // therefore treated as user initiated until a typed idle operation reason is
  // part of the shared contract.
  return "user";
}

function deploymentOf(runtime: ProvisionerResolvedRuntime): RuntimeDeployment {
  return {
    revisionId: runtime.revisionId,
    ...(runtime.legacyRuntimeEpoch === undefined
      ? {}
      : { legacyRuntimeEpoch: runtime.legacyRuntimeEpoch }),
    repositoryId: runtime.assignment.repositoryId,
    repositoryLocator: runtime.assignment.repositoryLocator,
    defaultBranchPolicy: runtime.assignment.defaultBranchPolicy,
    imageDigest: runtime.assignment.imageDigest,
    artifactRef: runtime.artifactRef,
    platformManifestDigest: runtime.platformManifestDigest,
    compositionManifestDigest: runtime.assignment.compositionManifestDigest,
    enabledModuleIds: runtime.assignment.enabledModuleIds,
    ...(runtime.assignment.persistence === undefined
      ? {}
      : { persistence: runtime.assignment.persistence }),
    credentialBrokerLocator: runtime.assignment.credentialBrokerLocator,
    grantPolicy: runtime.assignment.grantPolicy,
    controlServicePolicy: runtime.assignment.controlServicePolicy,
    runtimeMetadata: {
      producerRevision: runtime.metadata.producerRevision,
      listenerPort: runtime.metadata.listener.port,
      livenessPath: runtime.metadata.paths.liveness,
      readinessPath: runtime.metadata.paths.readiness,
      metadataPath: runtime.metadata.paths.metadata,
      shutdownPath: runtime.metadata.paths.shutdown,
      statusPath: runtime.metadata.paths.status,
      quiescePath: runtime.metadata.paths.quiesce,
      resumePath: runtime.metadata.paths.resume,
      shutdownTimeoutSeconds: runtime.metadata.shutdownTimeoutSeconds,
    },
    hostname: runtime.hostname,
    resourceProfileId: runtime.resourceProfileId,
    resources: runtime.resources,
  };
}

export function assignmentOf(
  claim: ClaimedProvisionerOperation,
  runtime: ProvisionerResolvedRuntime,
  current: boolean,
): RuntimeAssignment {
  const operation = claim.operation;
  const instance = claim.snapshot.instance;
  const generation = current ? instance.observedGeneration : operation.generation;
  const clusterId = current ? instance.clusterId : operation.clusterId;
  if (generation === null || clusterId === null) {
    throw new TypeError("resolved runtime context has no generation or cluster binding");
  }
  const reservationId = current
    ? (claim.currentReservation?.reservationId ?? instance.reservationId)
    : (claim.reservation?.reservationId ?? operation.reservationId);
  return {
    instanceId: operation.instanceId,
    repositoryId: operation.repositoryId,
    runtimeEpoch: runtime.assignment.runtimeEpoch,
    generation,
    clusterId,
    reservationId,
    deployment: deploymentOf(runtime),
  };
}

function checkpointEnvelope(operation: LifecycleOperation): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    lifecycle: operation,
  };
  if (operation.writerAbsenceProof !== null)
    result.writerAbsenceProof = operation.writerAbsenceProof;
  const byteLength = new TextEncoder().encode(JSON.stringify(result)).byteLength;
  if (byteLength > MAX_CHECKPOINT_BYTES)
    throw new RangeError("lifecycle checkpoint exceeds the Control Plane bound");
  return result;
}

function persistedOperation(
  value: unknown,
  claim: ClaimedProvisionerOperation,
): LifecycleOperation | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    value.schemaVersion !== CHECKPOINT_SCHEMA_VERSION ||
    !isRecord(value.lifecycle)
  ) {
    throw new TypeError("persisted lifecycle checkpoint is malformed");
  }
  const raw = value.lifecycle;
  if (
    raw.id !== claim.operation.id ||
    raw.instanceId !== claim.operation.instanceId ||
    raw.repositoryId !== claim.operation.repositoryId ||
    raw.generation !== claim.operation.generation ||
    raw.clusterId !== claim.operation.clusterId
  )
    throw new TypeError("persisted lifecycle checkpoint is bound to another operation");
  const result = raw as unknown as LifecycleOperation;
  requiredInteger(result.version, "version");
  requiredText(result.id, "operation ID");
  requiredText(result.instanceId, "instance ID");
  requiredInteger(result.repositoryId, "repository ID", 1);
  requiredInteger(result.generation, "generation", 1);
  requiredInteger(result.runtimeEpoch, "runtime epoch", 1);
  phase(result.phase);
  if (result.kind !== claim.operation.kind)
    throw new TypeError("persisted lifecycle operation kind changed");
  if (
    result.current !== null &&
    (result.current.instanceId !== result.instanceId ||
      result.current.repositoryId !== result.repositoryId)
  )
    throw new TypeError("persisted current assignment identity changed");
  if (result.target !== null && result.target.repositoryId !== result.repositoryId) {
    throw new TypeError("persisted target deployment identity changed");
  }
  if (result.targetEpoch !== null) requiredInteger(result.targetEpoch, "target epoch", 1);
  if (result.rollbackEpoch !== null) requiredInteger(result.rollbackEpoch, "rollback epoch", 1);
  if (result.writerAbsenceProof !== null) {
    if (
      result.writerAbsenceProof.instanceId !== result.instanceId ||
      result.writerAbsenceProof.repositoryId !== result.repositoryId ||
      result.writerAbsenceProof.remainingWriters !== 0
    )
      throw new TypeError("persisted writer absence proof identity changed");
  }
  return {
    ...result,
    readinessEvidence: result.readinessEvidence ?? null,
    rollbackCompatibilityEvidence: result.rollbackCompatibilityEvidence ?? null,
    rollbackCompatible: result.rollbackCompatible ?? null,
  };
}

function initialOperation(claim: ClaimedProvisionerOperation): LifecycleOperation {
  const operation = claim.operation;
  const current =
    claim.runtimeContext.current === null
      ? null
      : assignmentOf(claim, claim.runtimeContext.current, true);
  const target =
    claim.runtimeContext.target === null ? null : deploymentOf(claim.runtimeContext.target);
  const state = persistedOperation(operation.checkpoint, claim);
  if (state !== null) return state;
  if (operation.kind === "stop" && target !== null)
    throw new TypeError("stop operation cannot carry a target runtime");
  if (operation.kind !== "stop" && target === null) {
    // A missing target is not upgraded to a guessed image or producer ABI.
    // The build provider may report waiting, but no runtime side effect occurs.
  }
  return {
    id: operation.id,
    version: 0,
    instanceId: operation.instanceId,
    repositoryId: operation.repositoryId,
    clusterId: operation.clusterId ?? "",
    generation: operation.generation,
    kind: operation.kind,
    reason: reason(operation.kind),
    phase: phase(operation.phase),
    runtimeEpoch: operation.runtimeEpoch,
    targetRevisionId: claim.runtimeContext.target?.revisionId ?? operation.deploymentRevisionId,
    current,
    target,
    targetEpoch: operation.kind === "stop" ? null : operation.runtimeEpoch,
    targetReservationId: claim.reservation?.reservationId ?? operation.reservationId,
    rollbackEpoch: null,
    quiesceRequest: null,
    quiesceReceipt: null,
    writerAbsenceProof: null,
    readinessEvidence: null,
    rollbackCompatibilityEvidence: null,
    rollbackCompatible: null,
    buildId: operation.buildId,
    failureCode: null,
    failureReason: null,
    lastAuthenticatedActivityAt: null,
  };
}

export interface OperationBackedLifecycleJournalOptions {
  readonly claim: ClaimedProvisionerOperation;
  readonly operations: ProvisionerOperationService;
  readonly workerId: string;
  readonly assertLease?: () => Promise<void>;
}

/** Persists the state machine's complete recovery point in T03's fenced journal. */
export class OperationBackedLifecycleJournal implements LifecycleJournal {
  private current: LifecycleOperation;
  private remoteCheckpointSequence: number;

  constructor(private readonly options: OperationBackedLifecycleJournalOptions) {
    this.current = initialOperation(options.claim);
    this.remoteCheckpointSequence = options.claim.operation.checkpointSequence;
  }

  get currentOperation(): LifecycleOperation {
    return this.current;
  }

  async load(operationId: string, signal?: AbortSignal): Promise<LifecycleOperation | null> {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    if (operationId !== this.options.claim.operation.id) return null;
    // The constructor already validated the claimed checkpoint. Re-reading the
    // immutable claim here would roll back checkpoints accepted earlier in this
    // lease (notably resume/clear recovery before identity renewal).
    return this.current;
  }

  async advance(
    operationId: string,
    expectedVersion: number,
    patch: Partial<Omit<LifecycleOperation, "id" | "version">>,
    signal?: AbortSignal,
  ): Promise<LifecycleOperation | null> {
    if (operationId !== this.current.id || expectedVersion !== this.current.version) return null;
    const next: LifecycleOperation = {
      ...this.current,
      ...patch,
      version: this.current.version + 1,
    };
    const response = await this.options.operations.checkpoint({
      operationId,
      workerId: this.options.workerId,
      leaseToken: this.options.claim.operation.leaseToken,
      leaseEpoch: this.options.claim.operation.leaseEpoch,
      expectedCheckpointSequence: this.remoteCheckpointSequence,
      phase: next.phase,
      checkpoint: checkpointEnvelope(next),
      ...(this.options.assertLease === undefined
        ? {}
        : { beforeRetry: this.options.assertLease }),
      ...(signal === undefined ? {} : { signal }),
    });
    this.assertReturnedCheckpoint(response.operation, next);
    this.remoteCheckpointSequence = response.operation.checkpointSequence;
    this.current = next;
    return this.current;
  }

  async allocateRollbackEpoch(
    operationId: string,
    failedEpoch: number,
    signal?: AbortSignal,
  ): Promise<number> {
    if (operationId !== this.current.id || this.current.rollbackEpoch !== null) {
      throw new TypeError(
        "rollback epoch allocation does not match the current lifecycle operation",
      );
    }
    if (this.current.targetEpoch !== failedEpoch || this.current.runtimeEpoch !== failedEpoch) {
      throw new TypeError("rollback epoch allocation is not bound to the failed runtime epoch");
    }
    const rollbackEpoch = failedEpoch + 1;
    const next: LifecycleOperation = {
      ...this.current,
      runtimeEpoch: rollbackEpoch,
      rollbackEpoch,
      phase: "unknown",
    };
    const response = await this.options.operations.advanceRuntimeEpochForRecovery({
      operationId,
      workerId: this.options.workerId,
      leaseToken: this.options.claim.operation.leaseToken,
      leaseEpoch: this.options.claim.operation.leaseEpoch,
      expectedRuntimeEpoch: failedEpoch,
      checkpoint: checkpointEnvelope(next),
      ...(signal === undefined ? {} : { signal }),
    });
    if (response.operation.runtimeEpoch !== rollbackEpoch) {
      throw new TypeError("Control Plane allocated an unexpected rollback runtime epoch");
    }
    this.remoteCheckpointSequence = response.operation.checkpointSequence;
    // The lifecycle service's in-memory CAS version advances on its subsequent
    // checkpoint. Retain it here while the Control Plane epoch fence moves.
    this.current = next;
    return rollbackEpoch;
  }

  private assertReturnedCheckpoint(
    returned: ProvisionerOperationRecord,
    expected: LifecycleOperation,
  ): void {
    if (
      returned.id !== expected.id ||
      returned.runtimeEpoch !== expected.runtimeEpoch ||
      returned.phase !== expected.phase ||
      returned.checkpointSequence !== this.remoteCheckpointSequence + 1
    )
      throw new TypeError("Control Plane returned a mismatched lifecycle checkpoint");
  }
}
