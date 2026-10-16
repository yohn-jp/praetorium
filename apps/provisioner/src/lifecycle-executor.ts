import {
  LifecycleService,
  type LifecycleAuthProbeProvider,
  type BuildResolution,
  type LifecycleBuildProvider,
  type LifecycleOperation,
  type LifecycleResult,
  type RuntimeDeployment,
} from "@praetorium/application/lifecycle";
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
  type RuntimeAuthAcceptanceProbe,
} from "./scriptorium-control-client.js";

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

  /** The admitted revision projection currently carries no schema/data rollback
   * compatibility proof, so automatic rollback remains disabled. */
  async isRollbackCompatible(): Promise<boolean> {
    return false;
  }
}

export function deploymentFromResolvedRuntime(
  runtime: NonNullable<ClaimedProvisionerOperation["runtimeContext"]["target"]>,
): RuntimeDeployment {
  return {
    revisionId: runtime.revisionId,
    repositoryId: runtime.assignment.repositoryId,
    repositoryLocator: runtime.assignment.repositoryLocator,
    defaultBranchPolicy: runtime.assignment.defaultBranchPolicy,
    imageDigest: runtime.assignment.imageDigest,
    artifactRef: runtime.artifactRef,
    platformManifestDigest: runtime.platformManifestDigest,
    compositionManifestDigest: runtime.assignment.compositionManifestDigest,
    enabledModuleIds: runtime.assignment.enabledModuleIds,
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

export interface LifecycleProvisionerExecutorOptions {
  readonly operations: ProvisionerOperationService;
  readonly workerId: string;
  readonly runtime: InClusterRuntimeOptions;
  readonly authProbe: LifecycleAuthProbeProvider & Pick<RuntimeAuthAcceptanceProbe, "available">;
  readonly assignmentTransport: { readonly available: boolean };
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
    const runtime = new KubernetesLifecycleRuntimeAdapter(this.options.runtime, fence, {
      currentReservations: (clusterId) =>
        this.options.operations.currentReservations({ clusterId, signal: context.signal }),
      recordCapacitySnapshot: (input) =>
        this.options.operations.recordCapacitySnapshot({ ...input, signal: context.signal }),
    });
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
    });
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
        currentReservationId: claim.currentReservation?.reservationId ?? null,
        currentReservationEpoch: claim.currentReservation?.runtimeEpoch ?? null,
      },
    });
    const service = new LifecycleService({
      journal,
      builds: new ClaimedArtifactBuildProvider(claim),
      capacity,
      producer,
      authProbe: this.options.authProbe,
      runtime,
      routes: runtime,
      now: this.now,
    });
    return service.execute(operation.id, context);
  }
}

function blocked(code: string, reason: string): LifecycleResult {
  return { status: "blocked", code, reason };
}
