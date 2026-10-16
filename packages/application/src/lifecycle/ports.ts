/** Neutral lifecycle vocabulary. Provider packages implement these ports; this
 * package never imports Kubernetes, a producer SDK, D1, or HTTP framework code.
 */

export type LifecycleOperationKind = "start" | "redeploy" | "update" | "stop";

export type LifecyclePhase =
  | "accepted"
  | "waiting-for-artifact"
  | "waiting-for-capacity"
  | "capacity-reserved"
  | "quiescing-old"
  | "old-quiesced"
  | "stopping-old"
  | "old-writer-absent"
  | "starting-target"
  | "target-ready"
  | "route-activated"
  | "complete"
  | "blocked"
  | "failed"
  | "unknown";

export type RuntimeEpoch = number;
export type BeforeLifecycleEffect = () => Promise<void>;

export const SCRIPTORIUM_PLATFORM_CONTRACT_VERSION = "scriptorium-platform/v1" as const;
export type ScriptoriumRuntimePolicy = {
  readonly issuer: string;
  readonly jwksUrl: string;
  readonly audience: string;
};

export interface RuntimeDeployment {
  readonly revisionId: string;
  readonly repositoryId: number;
  readonly repositoryLocator: string;
  readonly defaultBranchPolicy: string;
  readonly imageDigest: string;
  readonly artifactRef: string;
  readonly platformManifestDigest: string;
  readonly compositionManifestDigest: string;
  readonly enabledModuleIds: readonly string[];
  readonly credentialBrokerLocator: string;
  readonly grantPolicy: ScriptoriumRuntimePolicy;
  readonly controlServicePolicy: ScriptoriumRuntimePolicy;
  readonly runtimeMetadata: {
    readonly producerRevision: string;
    readonly listenerPort: number;
    readonly livenessPath: string;
    readonly readinessPath: string;
    readonly metadataPath: string;
    readonly shutdownPath: string;
    readonly statusPath: string;
    readonly quiescePath: string;
    readonly resumePath: string;
    readonly shutdownTimeoutSeconds: number;
  };
  readonly hostname: string;
  readonly resourceProfileId: string;
  readonly resources: {
    readonly cpuMilli: number;
    readonly memoryMiB: number;
    readonly ephemeralStorageMiB: number;
  };
}

export interface RuntimeAssignment {
  readonly instanceId: string;
  readonly repositoryId: number;
  readonly runtimeEpoch: RuntimeEpoch;
  readonly generation: number;
  readonly clusterId: string;
  readonly reservationId: string | null;
  readonly deployment: RuntimeDeployment;
}

export interface QuiesceRequest {
  readonly contractVersion: typeof SCRIPTORIUM_PLATFORM_CONTRACT_VERSION;
  readonly operationId: string;
  readonly instanceId: string;
  readonly runtimeEpoch: RuntimeEpoch;
  readonly reason: "idle" | "redeploy" | "update" | "stop" | "rollback";
  readonly deadline: string;
}

export interface QuiesceReceipt {
  readonly contractVersion: typeof SCRIPTORIUM_PLATFORM_CONTRACT_VERSION;
  readonly operationId: string;
  readonly instanceId: string;
  readonly runtimeEpoch: RuntimeEpoch;
  readonly quiesceRevision: string;
  readonly disposition: "safe" | "blocked" | "unknown";
  readonly activeMutations: number;
  readonly activeJobs: number;
  readonly restartableJobs: number;
  readonly pendingCheckpoints: number;
  readonly uncertainPublication: boolean;
  readonly lastConfirmedRemoteRevision: string | null;
  readonly reasonCodes: readonly string[];
  readonly observedAt: string;
}

export interface ProducerStatus {
  readonly contractVersion: typeof SCRIPTORIUM_PLATFORM_CONTRACT_VERSION;
  readonly instanceId: string;
  readonly repositoryId: number;
  readonly runtimeEpoch: RuntimeEpoch;
  readonly imageDigest: string;
  readonly compositionManifestDigest: string;
  readonly enabledModuleIds: readonly string[];
  readonly ready: boolean;
  readonly activity: {
    readonly lastMeaningfulActivityAt: string | null;
    readonly activeApiRequests: number;
    readonly activeMcpRequests: number;
    readonly activeMutations: number;
    readonly activeJobs: number;
    readonly restartableJobs: number;
    readonly pendingCheckpoints: number;
    readonly uncertainPublication: boolean;
  };
  readonly lastConfirmedRemoteRevision: string | null;
  readonly observedAt: string;
}

export interface RuntimeWriter {
  /** Null is an unlabelled/unbound Pod; it still counts as a possible writer. */
  readonly runtimeEpoch: RuntimeEpoch | null;
  readonly phase: "running" | "terminating";
  /** Provider-observed workload identities, such as Kubernetes pod UIDs. */
  readonly identities: readonly string[];
}

/** A complete provider census of actual writers. Leases and desired state are
 * deliberately not part of this proof. `complete: false` must block retirement.
 */
export interface WriterCensus {
  readonly complete: boolean;
  /** Kubernetes list/resourceVersion or equivalent provider-owned evidence ID. */
  readonly providerObservationId: string;
  readonly observedAt: string;
  readonly matchedWriterCount: number;
  readonly writers: readonly RuntimeWriter[];
}

export interface WriterAbsenceProof {
  readonly instanceId: string;
  readonly repositoryId: number;
  readonly retiredRuntimeEpoch: RuntimeEpoch | null;
  readonly providerObservationId: string;
  readonly censusObservedAt: string;
  readonly remainingWriters: 0;
  readonly evidenceIdentities: readonly string[];
  readonly source: "runtime-provider-census";
}

export interface RuntimeReadiness {
  readonly status: "ready" | "not-ready" | "unknown";
  readonly assignment: RuntimeAssignment;
  readonly providerObservationId: string;
  /** Digest read from the actual running container image, not an env value. */
  readonly actualImageDigest: string | null;
  readonly imageIdentityVerified: boolean;
  readonly producer: ProducerStatus | null;
  readonly reasonCode?: string;
}

export interface BuildResolution {
  readonly status: "pending" | "admitted" | "rejected";
  readonly buildId?: string;
  readonly deployment?: RuntimeDeployment;
  readonly reasonCode?: string;
  readonly rollbackCompatible?: boolean;
}

export interface LifecycleOperation {
  readonly id: string;
  readonly version: number;
  readonly instanceId: string;
  readonly repositoryId: number;
  readonly clusterId: string;
  readonly generation: number;
  readonly kind: LifecycleOperationKind;
  readonly reason: "user" | "idle" | "update" | "redeploy";
  readonly phase: LifecyclePhase;
  /** Epoch reserved atomically with this operation by the Control Plane. */
  readonly runtimeEpoch: RuntimeEpoch;
  readonly targetRevisionId: string | null;
  readonly current: RuntimeAssignment | null;
  readonly target: RuntimeDeployment | null;
  readonly targetEpoch: RuntimeEpoch | null;
  readonly targetReservationId: string | null;
  readonly rollbackEpoch: RuntimeEpoch | null;
  readonly quiesceRequest: QuiesceRequest | null;
  readonly quiesceReceipt: QuiesceReceipt | null;
  readonly writerAbsenceProof: WriterAbsenceProof | null;
  readonly buildId: string | null;
  readonly failureCode: string | null;
  readonly failureReason: string | null;
  readonly lastAuthenticatedActivityAt: string | null;
}

export interface LifecycleJournal {
  load(operationId: string, signal?: AbortSignal): Promise<LifecycleOperation | null>;
  /** Compare-and-set every durable transition before its next external side effect. */
  advance(
    operationId: string,
    expectedVersion: number,
    patch: Partial<Omit<LifecycleOperation, "id" | "version">>,
    signal?: AbortSignal,
  ): Promise<LifecycleOperation | null>;
  /** Reserve and persist a fresh epoch before a compatible rollback starts. */
  allocateRollbackEpoch(
    operationId: string,
    failedEpoch: RuntimeEpoch,
    signal?: AbortSignal,
  ): Promise<RuntimeEpoch>;
}

export interface LifecycleBuildProvider {
  resolveOrBuild(
    operation: LifecycleOperation,
    beforeEffect: BeforeLifecycleEffect,
    signal?: AbortSignal,
  ): Promise<BuildResolution>;
  isRollbackCompatible(previous: RuntimeDeployment, target: RuntimeDeployment): Promise<boolean>;
}

export interface LifecycleCapacityProvider {
  reserve(
    operationId: string,
    instanceId: string,
    deployment: RuntimeDeployment,
    beforeEffect: BeforeLifecycleEffect,
    signal?: AbortSignal,
  ): Promise<{ readonly status: "reserved" | "pending"; readonly reservationId?: string }>;
  release(
    reservationId: string,
    operationId: string,
    beforeEffect: BeforeLifecycleEffect,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface LifecycleProducerProvider {
  status(assignment: RuntimeAssignment, signal?: AbortSignal): Promise<ProducerStatus>;
  quiesce(
    request: QuiesceRequest,
    beforeEffect: BeforeLifecycleEffect,
    signal?: AbortSignal,
  ): Promise<QuiesceReceipt>;
  resume(
    request: QuiesceRequest,
    beforeEffect: BeforeLifecycleEffect,
    signal?: AbortSignal,
  ): Promise<void>;
}

/** Evidence must come from real calls against the new runtime auth path. */
export interface LifecycleAuthProbeProvider {
  verify(
    assignment: RuntimeAssignment,
    signal?: AbortSignal,
  ): Promise<{
    readonly applicationProbeId: string;
    readonly grantPolicyMatched: boolean;
    readonly controlServicePolicyMatched: boolean;
    readonly validGrantAccepted: boolean;
    readonly wrongRepositoryGrantRejected: boolean;
    readonly wrongEpochGrantRejected: boolean;
    readonly invalidServiceCredentialRejected: boolean;
    readonly validGrantProbeId: string;
    readonly wrongRepositoryProbeId: string;
    readonly wrongEpochProbeId: string;
    readonly invalidServiceCredentialProbeId: string;
    readonly observedAt: string;
  }>;
}

export interface LifecycleReadinessEvidence {
  readonly assignment: RuntimeAssignment;
  readonly providerObservationId: string;
  readonly actualImageDigest: string;
  readonly producerObservedAt: string;
  readonly compositionManifestDigest: string;
  readonly enabledModuleIds: readonly string[];
  readonly applicationProbeId: string;
  readonly validGrantProbeId: string;
  readonly wrongRepositoryProbeId: string;
  readonly wrongEpochProbeId: string;
  readonly invalidServiceCredentialProbeId: string;
  readonly verifiedAt: string;
}

export interface LifecycleRuntimeProvider {
  /** Must inspect live provider resources across all epochs for this instance. */
  censusWriters(
    instanceId: string,
    repositoryId: number,
    signal?: AbortSignal,
  ): Promise<WriterCensus>;
  stop(
    assignment: RuntimeAssignment,
    operationId: string,
    beforeEffect: BeforeLifecycleEffect,
    signal?: AbortSignal,
  ): Promise<void>;
  start(
    assignment: RuntimeAssignment,
    operationId: string,
    beforeEffect: BeforeLifecycleEffect,
    signal?: AbortSignal,
  ): Promise<void>;
  readiness(assignment: RuntimeAssignment, signal?: AbortSignal): Promise<RuntimeReadiness>;
}

export interface LifecycleRouteProvider {
  activate(
    assignment: RuntimeAssignment,
    evidence: LifecycleReadinessEvidence,
    beforeEffect: BeforeLifecycleEffect,
    signal?: AbortSignal,
  ): Promise<void>;
  deactivate(
    instanceId: string,
    beforeEffect: BeforeLifecycleEffect,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface LifecycleDependencies {
  readonly journal: LifecycleJournal;
  readonly builds: LifecycleBuildProvider;
  readonly capacity: LifecycleCapacityProvider;
  readonly producer: LifecycleProducerProvider;
  readonly authProbe: LifecycleAuthProbeProvider;
  readonly runtime: LifecycleRuntimeProvider;
  readonly routes: LifecycleRouteProvider;
  readonly now?: () => number;
  readonly quiesceTimeoutMs?: number;
  readonly readinessTimeoutMs?: number;
  /** Maximum age for producer status and auth probe evidence before route activation. */
  readonly readinessEvidenceMaxAgeMs?: number;
  readonly pollIntervalMs?: number;
}

export interface LifecycleExecutionContext {
  readonly signal: AbortSignal;
  readonly assertLease: () => Promise<void>;
  readonly report?: (
    phase: LifecyclePhase,
    details?: Readonly<Record<string, string>>,
  ) => Promise<void>;
}

export type LifecycleResult =
  | { readonly status: "complete"; readonly observed: RuntimeAssignment | null }
  | { readonly status: "waiting"; readonly phase: LifecyclePhase; readonly reason: string }
  | { readonly status: "blocked"; readonly code: string; readonly reason: string }
  | {
      readonly status: "failed";
      readonly code: string;
      readonly reason: string;
      readonly observed?: RuntimeAssignment;
    }
  | { readonly status: "unknown"; readonly code: string; readonly reason: string };

export interface IdleObservation {
  readonly instanceId: string;
  readonly repositoryId: number;
  /** Adapter maps the producer's meaningful-activity clock; probes are excluded. */
  readonly lastMeaningfulActivityAt: string | null;
  readonly activeRequests: number;
  readonly activeJobs: number;
  readonly activeMutation: boolean;
  readonly intendedStopped: boolean;
  readonly runtimeState: "running" | "stopped" | "unknown";
  readonly current: RuntimeAssignment | null;
}

export interface IdleObservationProvider {
  observe(instanceId: string, signal?: AbortSignal): Promise<IdleObservation>;
}

export interface IdleOperationFactory {
  createIdleStop(observation: IdleObservation): Promise<string>;
}
