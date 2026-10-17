import type { RuntimeAssignment } from "@praetorium/contracts";
export type RuntimeNeutralState =
  | "absent"
  | "provisioning"
  | "running"
  | "stopped"
  | "deleting"
  | "failed"
  | "unknown";

export type RuntimeConditionStatus = "true" | "false" | "unknown";

export interface RuntimeCondition {
  readonly type: string;
  readonly status: RuntimeConditionStatus;
  readonly reason?: string;
  readonly message?: string;
}

export interface RuntimeHealthEvidence {
  readonly ready: boolean;
  readonly checkedAt: string;
}

/** Resolved by the statically selected application adapter, never raw API input. */
export interface RuntimeApplicationRequirements {
  readonly httpPort: number;
  readonly livenessPath: string;
  readonly readinessPath: string;
  readonly metadataPath: string;
  readonly shutdownPath: string;
  readonly shutdownTimeoutSeconds: number;
  readonly platformControlPaths: {
    readonly status: string;
    readonly quiesce: string;
    readonly resume: string;
  };
}

export interface RuntimeApplicationEvidence {
  readonly ready: boolean;
  readonly observedAt: string;
}

export type RuntimeMetadata = Readonly<Record<string, string>>;

/** Opaque, validated identifiers used in tenant resource names and labels. */
export type RuntimeInstanceId = string & { readonly __runtimeInstanceId: unique symbol };
export type RuntimeReleaseId = string & { readonly __runtimeReleaseId: unique symbol };
export type RuntimeRepositoryId = number & { readonly __runtimeRepositoryId: unique symbol };

export function parseRuntimeInstanceId(value: string): RuntimeInstanceId {
  if (!/^ins_[0-9A-HJKMNP-TV-Z]{26}$/.test(value)) {
    throw new TypeError("runtime instance id is invalid");
  }
  return value as RuntimeInstanceId;
}

export function parseRuntimeReleaseId(value: string): RuntimeReleaseId {
  // Deployment revision IDs are durable producer-independent identities. Keep
  // them opaque while enforcing Kubernetes label-value bounds before rendering.
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$/.test(value)) {
    throw new TypeError("runtime deployment revision id is invalid");
  }
  return value as RuntimeReleaseId;
}

export function parseRuntimeRepositoryId(value: number): RuntimeRepositoryId {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("runtime repository id is invalid");
  }
  return value as RuntimeRepositoryId;
}

export interface RuntimeRelease {
  readonly releaseId: RuntimeReleaseId;
  readonly artifactRef: string;
  /** Digest of the admitted OCI index or single-platform manifest. */
  readonly imageDigest: string;
  /** Exact child manifest selected for this cluster's platform. */
  readonly platformManifestDigest: string;
}

export interface RuntimeResourceQuantities {
  readonly cpuMilli: number;
  readonly memoryMiB: number;
  readonly ephemeralStorageMiB: number;
}

export interface RuntimeResourceProfile {
  readonly id: string;
  /** Producer-declared request floor, already validated against operator policy. */
  readonly request: RuntimeResourceQuantities;
}

export type RuntimeResourceProfileId = string;

/** Repo and epoch identity are required at every provider boundary. */
export interface InstanceIdentity {
  readonly instanceId: RuntimeInstanceId;
  readonly repositoryId: RuntimeRepositoryId;
  readonly runtimeEpoch: number;
  readonly generation: number;
  readonly clusterId: string;
}

export interface RuntimeInstanceSpec extends InstanceIdentity {
  readonly release: RuntimeRelease | null;
  readonly resourceProfile: RuntimeResourceProfile;
  readonly hostname: string | null;
  /** Already-resolved, bounded settings. Raw control-plane payloads do not enter this port. */
  readonly runtimeConfig: RuntimeMetadata;
  /** Canonical Scriptorium assignment projected into a read-only runtime Secret. */
  readonly scriptoriumAssignment?: RuntimeAssignment;
  /** Short-lived Control Plane proof; Provisioner refreshes the projected Secret before expiry. */
  readonly runtimeIdentityProof?: string;
  readonly application?: RuntimeApplicationRequirements;
}

export interface RuntimeIdentityProjection {
  readonly identity: InstanceIdentity;
  readonly assignment: RuntimeAssignment;
  readonly runtimeIdentityProof: string;
  /** Parsed from the mounted proof for refresh scheduling only; the broker verifies its signature. */
  readonly expiresAt: string;
}

export interface RunningInstanceSpec extends RuntimeInstanceSpec {
  readonly release: RuntimeRelease;
}

export type StoppedInstanceSpec = RuntimeInstanceSpec;
export interface ReleaseSpec extends RuntimeInstanceSpec {
  readonly release: RuntimeRelease;
}
export type RuntimeDeletionSpec = InstanceIdentity;

export interface RuntimeObservation {
  readonly identity: InstanceIdentity;
  readonly observationId: string;
  readonly observedAt: number;
  readonly namespaceExists: boolean;
  readonly managedGeneration?: number;
  readonly state: RuntimeNeutralState;
  readonly repositoryId?: RuntimeRepositoryId;
  readonly runtimeEpoch?: number;
  readonly releaseId?: RuntimeReleaseId;
  readonly releaseDigest?: string;
  readonly endpoint?: string;
  readonly health?: RuntimeHealthEvidence;
  readonly application?: RuntimeApplicationEvidence;
  /** Determined from a fresh Pod list covering every epoch of this instance. */
  readonly writerState?: "absent" | "running" | "terminating" | "unknown";
  /** Complete Pod-list evidence scoped to this instance namespace, without an epoch selector. */
  readonly writerCensus: RuntimeWriterCensus;
  readonly observedImageDigest?: string;
  readonly metadata?: RuntimeMetadata;
  readonly conditions: readonly RuntimeCondition[];
}

export interface RuntimeWriterPodIdentity {
  readonly namespace: string;
  readonly name: string;
  readonly uid: string;
  readonly runtimeEpoch: number | null;
  readonly generation: number | null;
  readonly phase: string | null;
  readonly deleting: boolean;
  readonly ready: boolean;
  readonly imageIds: readonly string[];
}

export interface RuntimeWriterCensus {
  readonly scope: "instance-repository-all-epochs";
  readonly complete: true;
  readonly queriedNamespace: string;
  readonly namespaceUid: string | null;
  readonly namespaceResourceVersion: string | null;
  /** Null only when Kubernetes confirmed that the entire namespace is absent. */
  readonly listResourceVersion: string | null;
  readonly queriedPodCount: number;
  readonly pods: readonly RuntimeWriterPodIdentity[];
}

/** Proof supplied by the lifecycle/auth adapters before an app route can be created. */
export interface RuntimeEndpointActivationEvidence {
  readonly identity: InstanceIdentity;
  readonly actualImageDigest: string;
  readonly applicationProbe: {
    readonly id: string;
    readonly observedAt: number;
    readonly ready: true;
  };
  readonly authProbe: { readonly id: string; readonly observedAt: number; readonly ready: true };
}

export interface RuntimeProgress {
  readonly phase: string;
  readonly state: RuntimeNeutralState;
  readonly percent?: number;
  readonly conditions?: readonly RuntimeCondition[];
}

export type RuntimeApplyStatus = "applied" | "unchanged" | "pending";
/** Called immediately before each new external side effect. */
export type RuntimeEffectGuard = () => void | Promise<void>;

export interface ApplyResult {
  readonly status: RuntimeApplyStatus;
  readonly observation: RuntimeObservation;
  readonly progress: readonly RuntimeProgress[];
}

export interface ManagedRuntimeSummary extends InstanceIdentity {
  readonly managedGeneration: number;
  readonly state: RuntimeNeutralState;
  readonly releaseId?: RuntimeReleaseId;
  readonly releaseDigest?: string;
  readonly endpoint?: string;
}

export interface RuntimePage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface RuntimeNodeCapacity {
  readonly nodeName: string;
  readonly allocatable: RuntimeResourceQuantities;
  readonly requested: RuntimeResourceQuantities;
  readonly available: RuntimeResourceQuantities;
}

/** Capacity is a fresh view of this cluster, never a configured zero/infinity fallback. */
export interface RuntimeCapacity {
  readonly observedAt: number;
  readonly authoritative: true;
  readonly capacityEpoch: number;
  readonly nodeResourceVersion: string;
  readonly podResourceVersion: string;
  readonly reservationObservedAt: number;
  /** Remaining allocatable cluster resources after live workload requests and leases. */
  readonly cpuMilli: number;
  readonly memoryMiB: number;
  readonly ephemeralStorageMiB: number;
  readonly allocatable: RuntimeResourceQuantities;
  readonly requested: RuntimeResourceQuantities;
  readonly reserved: RuntimeResourceQuantities;
  readonly activeInstances: number;
  readonly nodes: readonly RuntimeNodeCapacity[];
}

export interface RuntimeProvider {
  inspect(spec: InstanceIdentity, signal?: AbortSignal): Promise<RuntimeObservation>;
  ensureRunning(
    spec: RunningInstanceSpec,
    signal: AbortSignal,
    beforeEffect: RuntimeEffectGuard,
  ): Promise<ApplyResult>;
  ensureStopped(
    spec: StoppedInstanceSpec,
    signal: AbortSignal,
    beforeEffect: RuntimeEffectGuard,
  ): Promise<ApplyResult>;
  ensureRelease(
    spec: ReleaseSpec,
    signal: AbortSignal,
    beforeEffect: RuntimeEffectGuard,
  ): Promise<ApplyResult>;
  ensureRuntimeDeleted(
    spec: RuntimeDeletionSpec,
    signal: AbortSignal,
    beforeEffect: RuntimeEffectGuard,
  ): Promise<ApplyResult>;
  listManagedInstances(
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<RuntimePage<ManagedRuntimeSummary>>;
  getCapacitySnapshot(
    signal?: AbortSignal,
    resourceProfileId?: RuntimeResourceProfileId,
  ): Promise<RuntimeCapacity>;
}
