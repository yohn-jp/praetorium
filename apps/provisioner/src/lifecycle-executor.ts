import {
  LifecycleService,
  type BuildResolution,
  type LifecycleBuildProvider,
  type LifecycleOperation,
  type LifecycleResult,
  type QuiesceRequest,
  type RuntimeAssignment,
  type RollbackCompatibilityEvidence,
  type RuntimeDeployment,
  isPersistenceRollbackCompatible,
} from "@praetorium/application/lifecycle";
import { QuiesceRequestSchema, QuiesceResultSchema } from "@praetorium/contracts";
import type {
  ClaimedProvisionerOperation,
  ProvisionerOperationService,
} from "./operation-client.js";
import type { ProvisionerOperationExecutor } from "./worker.js";
import {
  KubernetesLifecycleRuntimeAdapter,
  LifecycleReservationAdapter,
  type InClusterRuntimeOptions,
} from "./kubernetes-lifecycle-adapter.js";
import { assignmentOf, OperationBackedLifecycleJournal } from "./lifecycle-journal.js";
import {
  OperationBackedRuntimeControlCredentialProvider,
  ScriptoriumControlHttpClient,
  ScriptoriumControlHttpError,
  type RuntimeAuthAcceptanceProbe,
} from "./scriptorium-control-client.js";
import type { RuntimeIdentityAssignmentTransport } from "./runtime-identity.js";

/** T03 already claims only an admitted immutable revision. This adapter binds
 * that resolution to the application state machine and never starts a build or
 * invents a target artifact. */
class ClaimedArtifactBuildProvider implements LifecycleBuildProvider {
  constructor(private readonly claim: ClaimedProvisionerOperation) {}

  async resolveOrBuild(
    operation: LifecycleOperation,
    beforeEffect: () => Promise<void>,
    signal?: AbortSignal,
  ): Promise<BuildResolution> {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    await beforeEffect();
    const target = this.claim.runtimeContext.target;
    if (target === null) return { status: "pending" as const };
    if (operation.targetRevisionId !== null && operation.targetRevisionId !== target.revisionId) {
      return { status: "rejected" as const, reasonCode: "target_revision_mismatch" };
    }
    const buildId = this.claim.operation.buildId ?? this.claim.deploymentRevision?.buildId;
    return {
      status: "admitted" as const,
      ...(buildId === undefined ? {} : { buildId }),
      deployment: operation.target ?? deploymentFromResolvedRuntime(target),
    };
  }

  async isRollbackCompatible(
    previous: RuntimeDeployment,
    target: RuntimeDeployment,
    evidence: RollbackCompatibilityEvidence,
  ): Promise<boolean> {
    return isPersistenceRollbackCompatible(previous, target, evidence);
  }
}

export function deploymentFromResolvedRuntime(
  runtime: NonNullable<ClaimedProvisionerOperation["runtimeContext"]["target"]>,
): RuntimeDeployment {
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

const observedIdentityRefreshBarrierPhases = new Set([
  "quiescing-old",
  "old-quiesced",
  "stopping-old",
  "old-writer-absent",
  "starting-target",
  "target-ready",
  "route-activated",
  "complete",
]);

const recoverablePreflightFailures = new Set([
  "producer_remote_preflight_unavailable",
  "producer_remote_preflight_unverified",
]);
const MIN_RECOVERY_QUIESCE_REMAINING_MS = 10_000;

function checkpointRequestMatchesOperation(
  claim: ClaimedProvisionerOperation,
  request: QuiesceRequest,
): boolean {
  return request.operationId === claim.operation.id && request.reason !== "rollback";
}

function sameCheckpointCurrentAssignment(
  checkpointCurrent: RuntimeAssignment | null,
  claimedCurrent: RuntimeAssignment,
): boolean {
  return (
    checkpointCurrent !== null &&
    checkpointCurrent.instanceId === claimedCurrent.instanceId &&
    checkpointCurrent.repositoryId === claimedCurrent.repositoryId &&
    checkpointCurrent.runtimeEpoch === claimedCurrent.runtimeEpoch &&
    checkpointCurrent.generation === claimedCurrent.generation &&
    checkpointCurrent.clusterId === claimedCurrent.clusterId &&
    checkpointCurrent.reservationId === claimedCurrent.reservationId &&
    checkpointCurrent.deployment.revisionId === claimedCurrent.deployment.revisionId &&
    checkpointCurrent.deployment.imageDigest === claimedCurrent.deployment.imageDigest &&
    checkpointCurrent.deployment.compositionManifestDigest ===
      claimedCurrent.deployment.compositionManifestDigest &&
    checkpointCurrent.deployment.artifactRef === claimedCurrent.deployment.artifactRef &&
    checkpointCurrent.deployment.platformManifestDigest ===
      claimedCurrent.deployment.platformManifestDigest &&
    JSON.stringify(checkpointCurrent.deployment.enabledModuleIds) ===
      JSON.stringify(claimedCurrent.deployment.enabledModuleIds)
  );
}

function persistedQuiesceRequest(value: unknown): QuiesceRequest {
  const request = QuiesceRequestSchema.parse(value);
  if (
    request.reason !== "stop" &&
    request.reason !== "redeploy" &&
    request.reason !== "update" &&
    request.reason !== "idle" &&
    request.reason !== "rollback"
  )
    throw new TypeError("persisted quiesce reason is unsupported");
  return { ...request, reason: request.reason };
}

function operationQuiesceReason(claim: ClaimedProvisionerOperation): QuiesceRequest["reason"] {
  const state = claim.operation.checkpoint;
  const lifecycle = state !== null && isRecord(state.lifecycle) ? state.lifecycle : null;
  if (lifecycle?.reason === "idle") return "idle";
  if (claim.operation.kind === "stop") return "stop";
  if (claim.operation.kind === "update" || lifecycle?.reason === "update") return "update";
  return "redeploy";
}

/** Reopens only a persisted quiesce handshake; it never stops a writer or
 * treats its receipt as evidence that retirement is safe. */
async function recoverPersistedQuiesce(input: {
  readonly claim: ClaimedProvisionerOperation;
  readonly currentAssignment: RuntimeAssignment | null;
  readonly runtime: KubernetesLifecycleRuntimeAdapter;
  readonly producer: ScriptoriumControlHttpClient;
  readonly journal: OperationBackedLifecycleJournal;
  readonly now: () => number;
  readonly context: Parameters<ProvisionerOperationExecutor["execute"]>[1];
}): Promise<boolean> {
  const { claim, currentAssignment, runtime, producer, journal, context } = input;
  let state = journal.currentOperation;
  const failedPreflight = recoverablePreflightFailures.has(state.failureCode ?? "");
  if (
    state.quiesceRequest === null ||
    !(
      state.phase === "quiescing-old" ||
      state.phase === "old-quiesced" ||
      (failedPreflight && (state.phase === "unknown" || state.phase === "blocked"))
    )
  )
    return false;

  const request = persistedQuiesceRequest(state.quiesceRequest);
  if (
    request.instanceId !== claim.operation.instanceId ||
    state.rollbackEpoch !== null ||
    state.writerAbsenceProof !== null ||
    state.readinessEvidence !== null ||
    !checkpointRequestMatchesOperation(claim, request)
  )
    throw new TypeError("persisted quiesce request is not bound to the claimed operation");

  const assignment = currentAssignment;
  if (
    assignment === null ||
    assignment.instanceId !== request.instanceId ||
    assignment.repositoryId !== claim.operation.repositoryId ||
    assignment.runtimeEpoch !== request.runtimeEpoch ||
    assignment.clusterId !== claim.operation.clusterId ||
    !sameCheckpointCurrentAssignment(state.current, assignment)
  )
    throw new TypeError("persisted quiesce request does not match the admitted runtime assignment");
  if (request.reason !== "rollback" && request.reason !== operationQuiesceReason(claim))
    throw new TypeError("persisted quiesce reason is not bound to the claimed operation");

  const receipt =
    state.quiesceReceipt === null ? null : QuiesceResultSchema.parse(state.quiesceReceipt);
  if (
    (state.phase === "old-quiesced" && receipt === null) ||
    (state.phase === "quiescing-old" && receipt !== null) ||
    (receipt !== null &&
      (receipt.operationId !== request.operationId ||
        receipt.instanceId !== request.instanceId ||
        receipt.runtimeEpoch !== request.runtimeEpoch ||
        receipt.contractVersion !== request.contractVersion))
  )
    throw new TypeError("persisted quiesce receipt does not match its request");

  const resume = async (value: typeof request) => {
    await producer.resume(value, context.assertLease, context.signal);
  };
  await context.assertLease();
  const census = await runtime.censusWriters(
    claim.operation.instanceId,
    claim.operation.repositoryId,
    context.signal,
  );
  if (
    !census.complete ||
    census.providerObservationId.length === 0 ||
    !Number.isFinite(Date.parse(census.observedAt)) ||
    Date.parse(census.observedAt) > input.now() ||
    census.matchedWriterCount !== census.writers.length ||
    census.writers.length !== 1 ||
    census.writers[0]?.runtimeEpoch !== request.runtimeEpoch ||
    census.writers[0]?.phase !== "running" ||
    census.writers[0]?.identities.length !== 1 ||
    census.writers[0]?.identities[0]?.length === 0
  )
    throw new Error("persisted quiesce recovery requires the exact sole running writer");

  try {
    await resume(request);
  } catch (error) {
    if (
      !(error instanceof ScriptoriumControlHttpError) ||
      error.status !== 409 ||
      error.code !== "RESUME_BINDING_MISMATCH"
    )
      throw error;

    let recoveryRequest = persistedQuiesceRequest({
      ...request,
      deadline: new Date(input.now() + 30_000).toISOString(),
    });
    await context.assertLease();
    state = journal.currentOperation;
    const requested = await journal.advance(
      state.id,
      state.version,
      { phase: "quiescing-old", quiesceRequest: recoveryRequest, quiesceReceipt: null },
      context.signal,
    );
    if (requested === null) throw new Error("quiesce recovery checkpoint is stale");
    await context.report?.("quiescing-old");

    // Credential-retirement batching can consume the original quiesce window.
    // Renew the same request before sending it if the window is nearly spent.
    if (Date.parse(recoveryRequest.deadline) - input.now() < MIN_RECOVERY_QUIESCE_REMAINING_MS) {
      recoveryRequest = persistedQuiesceRequest({
        ...recoveryRequest,
        deadline: new Date(input.now() + 30_000).toISOString(),
      });
      await context.assertLease();
      state = journal.currentOperation;
      const refreshedRequest = await journal.advance(
        state.id,
        state.version,
        { phase: "quiescing-old", quiesceRequest: recoveryRequest, quiesceReceipt: null },
        context.signal,
      );
      if (refreshedRequest === null) throw new Error("fresh quiesce deadline checkpoint is stale");
      await context.report?.("quiescing-old");
    }

    // This response reopens the exact producer's matching resume path. Its
    // disposition is deliberately not treated as retirement evidence.
    const recoveredReceipt = await producer.quiesce(
      recoveryRequest,
      context.assertLease,
      context.signal,
    );
    const parsedReceipt = QuiesceResultSchema.parse(recoveredReceipt);
    if (
      parsedReceipt.operationId !== recoveryRequest.operationId ||
      parsedReceipt.instanceId !== recoveryRequest.instanceId ||
      parsedReceipt.runtimeEpoch !== recoveryRequest.runtimeEpoch ||
      parsedReceipt.contractVersion !== recoveryRequest.contractVersion
    )
      throw new TypeError("recovery quiesce receipt does not match the persisted request");

    await context.assertLease();
    state = journal.currentOperation;
    const quiesced = await journal.advance(
      state.id,
      state.version,
      { phase: "old-quiesced", quiesceRequest: recoveryRequest, quiesceReceipt: parsedReceipt },
      context.signal,
    );
    if (quiesced === null) throw new Error("quiesce receipt checkpoint is stale");
    await context.report?.("old-quiesced");
    await resume(recoveryRequest);
  }

  await context.assertLease();
  state = journal.currentOperation;
  const accepted = await journal.advance(
    state.id,
    state.version,
    { phase: "accepted", quiesceRequest: null, quiesceReceipt: null },
    context.signal,
  );
  if (accepted === null) throw new Error("accepted resume checkpoint is stale");
  await context.report?.("accepted");
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mayRefreshObservedIdentityBeforeRetirement(claim: ClaimedProvisionerOperation): boolean {
  if (claim.runtimeContext.current === null) return false;
  const checkpoint = claim.operation.checkpoint;
  const lifecycle =
    checkpoint !== null && isRecord(checkpoint.lifecycle) ? checkpoint.lifecycle : null;
  const phase = typeof lifecycle?.phase === "string" ? lifecycle.phase : claim.operation.phase;
  return (
    !observedIdentityRefreshBarrierPhases.has(phase) &&
    (lifecycle === null ||
      lifecycle.quiesceRequest === null ||
      lifecycle.quiesceRequest === undefined)
  );
}

export interface LifecycleProvisionerExecutorOptions {
  readonly operations: ProvisionerOperationService;
  readonly workerId: string;
  readonly runtime: InClusterRuntimeOptions;
  readonly authProbe: RuntimeAuthAcceptanceProbe;
  readonly assignmentTransport: RuntimeIdentityAssignmentTransport;
  readonly now?: () => number;
  readonly idleTimeoutMs?: number;
}

/** Production executor that binds the durable T03 lease/checkpoint to the
 * lifecycle state machine and live T07 provider for each claimed operation. */
export class LifecycleProvisionerExecutor implements ProvisionerOperationExecutor {
  private readonly now: () => number;

  constructor(private readonly options: LifecycleProvisionerExecutorOptions) {
    this.now = options.now ?? Date.now;
  }

  get canExecute(): boolean {
    return this.options.authProbe.available && this.options.assignmentTransport.available;
  }

  async execute(
    claim: ClaimedProvisionerOperation,
    context: Parameters<ProvisionerOperationExecutor["execute"]>[1],
  ): Promise<LifecycleResult> {
    const operation = claim.operation;
    if (operation.clusterId === null)
      return blocked("operation_cluster_missing", "claimed operation has no cluster binding");
    const fence = {
      clusterId: operation.clusterId,
      repositoryId: operation.repositoryId,
      generation: operation.generation,
      runtimeEpoch: operation.runtimeEpoch,
    };
    const runtime = new KubernetesLifecycleRuntimeAdapter(
      this.options.runtime,
      fence,
      {
        currentReservations: (clusterId) =>
          this.options.operations.currentReservations({ clusterId, signal: context.signal }),
        recordCapacitySnapshot: (input) =>
          this.options.operations.recordCapacitySnapshot({ ...input, signal: context.signal }),
      },
      this.options.assignmentTransport.forClaim(claim),
    );
    const currentAssignment =
      claim.runtimeContext.current === null
        ? null
        : assignmentOf(claim, claim.runtimeContext.current, true);
    const targetAssignment =
      claim.runtimeContext.target === null
        ? null
        : assignmentOf(claim, claim.runtimeContext.target, false);
    const producer = new ScriptoriumControlHttpClient(
      {
        namespacePrefix: this.options.runtime.namespacePrefix,
        resolveEndpoint: (assignment, signal) => runtime.controlEndpoint(assignment, signal),
        now: this.now,
        // A status request can time out while the producer's shared remote
        // census is still running. Immediate retries can join that census;
        // lifecycle recovery also waits briefly for a newly renewed GitHub
        // credential to project into the producer's mounted Secret. The lease
        // is checked between delayed reads; idle observation stays one-shot.
        unknownPersistenceRetries: 2,
        unknownPersistenceDelayedRetries: 15,
        unknownPersistenceRetryDelayMs: 5_000,
        beforeStatusRetry: context.assertLease,
      },
      new OperationBackedRuntimeControlCredentialProvider(
        this.options.operations,
        claim,
        this.options.workerId,
        this.now,
      ),
    );
    producer.bindCurrent(currentAssignment);
    producer.bindTarget(targetAssignment);

    // Required auth-probe transports must be present before the lifecycle can
    // quiesce, stop, start, or activate a route. A missing S02 proof is a hard
    // capability gate, not positive evidence supplied by this worker.
    if (!producer.available)
      return blocked(
        "control_credential_unavailable",
        "runtime control credentials are unavailable",
      );
    if (!this.options.authProbe.available) {
      return blocked(
        "runtime_auth_probe_unavailable",
        "positive and negative runtime grant probes are not configured",
      );
    }
    if (!this.options.assignmentTransport.available) {
      return blocked(
        "runtime_assignment_transport_unavailable",
        "producer assignment transport is not published",
      );
    }

    const journal = new OperationBackedLifecycleJournal({
      claim,
      operations: this.options.operations,
      workerId: this.options.workerId,
      assertLease: context.assertLease,
    });
    const checkpointedCurrent = journal.currentOperation.current;
    const retirementReservation =
      operation.checkpoint === null &&
      (checkpointedCurrent === null || checkpointedCurrent.reservationId === null)
        ? claim.currentReservation
        : checkpointedCurrent;
    const capacity = new LifecycleReservationAdapter({
      runtime,
      operations: this.options.operations,
      now: this.now,
      maxCapacityAgeMs: this.options.runtime.maxCapacityAgeMs,
      claim: {
        operationId: operation.id,
        workerId: this.options.workerId,
        leaseToken: operation.leaseToken,
        leaseEpoch: operation.leaseEpoch,
        runtimeEpoch: operation.runtimeEpoch,
        clusterId: operation.clusterId,
        generation: operation.generation,
        instanceId: operation.instanceId,
        repositoryId: operation.repositoryId,
        reservationId: claim.reservation?.reservationId ?? null,
        currentReservationId: retirementReservation?.reservationId ?? null,
        currentReservationEpoch: retirementReservation?.runtimeEpoch ?? null,
      },
    });
    const service = new LifecycleService({
      journal,
      builds: new ClaimedArtifactBuildProvider(claim),
      capacity,
      producer,
      authProbe: this.options.authProbe
        .withEndpointResolver(async (assignment, signal) => {
          // A recovered completion checkpoint skips start(), including its
          // identity renewal loop. Remote snapshot reads still need a current
          // repository proof; renew through the existing fenced provider.
          await runtime.refreshRuntimeIdentity(assignment, context.assertLease, signal);
          return runtime.controlEndpoint(assignment, signal);
        })
        .forLease(claim, this.options.workerId),
      runtime,
      routes: runtime,
      now: this.now,
    });
    try {
      const recoveredQuiesce = await recoverPersistedQuiesce({
        claim,
        currentAssignment,
        runtime,
        producer,
        journal,
        now: this.now,
        context,
      });
      if (recoveredQuiesce && currentAssignment !== null) {
        try {
          // The durable accepted checkpoint reopens the normal retained
          // observed-identity issuer. Subsequent fresh status still decides
          // whether retirement may proceed.
          await runtime.refreshRuntimeIdentity(
            currentAssignment,
            context.assertLease,
            context.signal,
          );
        } catch {
          // LifecycleService's fresh remote preflight remains authoritative.
        }
      }
      // The old writer can need a fresh GitHub read proof before status and
      // quiesce can obtain their remote persistence observation. Renew only
      // from the exact claimed current assignment, and before the durable
      // quiesce checkpoint closes observed-writer identity authority.
      if (
        !recoveredQuiesce &&
        currentAssignment !== null &&
        mayRefreshObservedIdentityBeforeRetirement(claim)
      ) {
        try {
          await runtime.refreshRuntimeIdentity(
            currentAssignment,
            context.assertLease,
            context.signal,
          );
        } catch {
          // Renewal is best-effort here. The lifecycle's fresh producer status
          // check remains the safety gate and will block retirement if remote
          // confirmation is still unavailable.
        }
      }
      return await service.execute(operation.id, context);
    } finally {
      await runtime.close();
    }
  }
}

function blocked(code: string, reason: string): LifecycleResult {
  return { status: "blocked", code, reason };
}
