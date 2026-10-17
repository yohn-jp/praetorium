import type {
  LifecyclePhase,
  LifecycleReadinessEvidence,
} from "@praetorium/application/lifecycle";

export type ProvisionerOperationKind = "start" | "stop" | "redeploy" | "update";
export type ProvisionerOperationStatus =
  | "pending"
  | "claimed"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked";
export type ProvisionerObservedState =
  | "absent"
  | "starting"
  | "ready"
  | "stopping"
  | "stopped"
  | "failed"
  | "unknown";
export type ProvisionerTerminal = "succeeded" | "failed" | "blocked";

export interface ProvisionerOperationRecord {
  readonly id: string;
  readonly instanceId: string;
  readonly repositoryId: number;
  readonly generation: number;
  readonly runtimeEpoch: number;
  readonly kind: ProvisionerOperationKind;
  readonly status: ProvisionerOperationStatus;
  readonly attempt: number;
  readonly leaseEpoch: number;
  readonly leaseToken: string;
  readonly leaseExpiresAt: number;
  readonly reportSequence: number;
  readonly phase: LifecyclePhase;
  readonly checkpointSequence: number;
  readonly checkpoint: Readonly<Record<string, unknown>> | null;
  readonly clusterId: string | null;
  readonly reservationId: string | null;
  readonly deploymentRevisionId: string | null;
  readonly buildId: string | null;
  readonly prerequisiteBuildId: string | null;
}

export interface ProvisionerInstanceSnapshot {
  readonly instanceId: string;
  readonly repositoryId: number;
  readonly generation: number;
  readonly runtimeEpoch: number;
  readonly observedGeneration: number | null;
  readonly desiredState: "running" | "stopped";
  readonly observedState: ProvisionerObservedState;
  readonly observedRuntimeEpoch: number | null;
  readonly observedRevisionId: string | null;
  readonly desiredRevisionId: string | null;
  readonly currentArtifactDigest: string | null;
  readonly desiredArtifactDigest: string | null;
  readonly reservationState: "none" | "pending" | "reserved" | "allocated" | "blocked" | "released";
  readonly reservationId: string | null;
  readonly clusterId: string | null;
}

export interface ProvisionerBindingSnapshot {
  readonly repositoryId: number;
  readonly instanceId: string;
  readonly installationId: number;
  readonly owner: string;
  readonly name: string;
  readonly authorizationRevision: number;
  readonly bindingEpoch: number;
  readonly suspended: boolean;
}

export interface ProvisionerReservation {
  readonly reservationId: string;
  readonly instanceId: string;
  readonly repositoryId: number;
  readonly runtimeEpoch: number;
  readonly generation: number;
  readonly clusterId: string | null;
  readonly status: "pending" | "reserved" | "allocated" | "released" | "blocked";
  readonly resources: {
    readonly cpuMilli: number;
    readonly memoryMiB: number;
    readonly ephemeralStorageMiB: number;
  };
  readonly capacitySnapshotEpoch: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ProvisionerDeploymentRevision {
  readonly revisionId: string;
  readonly instanceId: string;
  readonly repositoryId: number;
  readonly generation: number;
  readonly buildKey: string;
  readonly buildId: string;
  readonly selection: Readonly<Record<string, unknown>>;
  readonly resources: ProvisionerReservation["resources"];
  readonly artifactDigest: string | null;
  readonly status: "building" | "admitted" | "failed" | "superseded";
}

export interface ClaimedProvisionerOperation {
  readonly operation: ProvisionerOperationRecord;
  readonly snapshot: {
    readonly binding: ProvisionerBindingSnapshot;
    readonly instance: ProvisionerInstanceSnapshot;
  };
  readonly reservation: ProvisionerReservation | null;
  readonly currentReservation: ProvisionerReservation | null;
  readonly deploymentRevision: ProvisionerDeploymentRevision | null;
  readonly currentDeploymentRevision: ProvisionerDeploymentRevision | null;
  readonly runtimeContext: {
    readonly current: ProvisionerResolvedRuntime | null;
    readonly target: ProvisionerResolvedRuntime | null;
  };
}

export interface ProvisionerResolvedRuntime {
  readonly revisionId: string;
  readonly artifactRef: string;
  readonly platformManifestDigest: string;
  readonly resourceProfileId: string;
  readonly hostname: string;
  readonly resources: RuntimeResources;
  readonly assignment: {
    readonly contractVersion: "scriptorium-platform/v1";
    readonly instanceId: string;
    readonly repositoryId: number;
    readonly repositoryLocator: string;
    readonly defaultBranchPolicy: string;
    readonly runtimeEpoch: number;
    readonly imageDigest: string;
    readonly compositionManifestDigest: string;
    readonly enabledModuleIds: readonly string[];
    readonly persistence?: {
      readonly contractVersion: "scriptorium-persistence/v1";
      readonly readable: readonly {
        readonly formatId: string;
        readonly versions: readonly number[];
      }[];
      readonly writable: readonly {
        readonly formatId: string;
        readonly version: number;
      }[];
    };
    readonly credentialBrokerLocator: string;
    readonly grantPolicy: ProvisionerAuthenticationPolicy;
    readonly controlServicePolicy: ProvisionerAuthenticationPolicy;
  };
  readonly metadata: {
    readonly contractVersion: "scriptorium-platform/v1";
    readonly producerRevision: string;
    readonly listener: { readonly port: number };
    readonly paths: {
      readonly liveness: string;
      readonly readiness: string;
      readonly metadata: string;
      readonly shutdown: string;
      readonly status: "/api/platform/v1/status";
      readonly quiesce: "/api/platform/v1/quiesce";
      readonly resume: "/api/platform/v1/resume";
    };
    readonly shutdownTimeoutSeconds: number;
  };
}

export interface ProvisionerIdleCandidate {
  readonly instanceId: string;
  readonly repositoryId: number;
  readonly generation: number;
  readonly runtimeEpoch: number;
  readonly clusterId: string;
  readonly desiredState: "running" | "stopped";
  readonly bindingSuspended: boolean;
  readonly hasActiveOperation: boolean;
  readonly healthOperationId: string | null;
  readonly currentRuntime: ProvisionerResolvedRuntime;
}

export interface ProvisionerIdleCandidatePage {
  readonly items: readonly ProvisionerIdleCandidate[];
  readonly nextCursor: string | null;
}

export interface ProvisionerAuthenticationPolicy {
  readonly issuer: string;
  readonly jwksUrl: string;
  readonly audience: string;
}

export interface ProvisionerObservation {
  readonly instanceId: string;
  readonly repositoryId: number;
  readonly generation: number;
  readonly runtimeEpoch: number;
  readonly sequence: number;
  readonly observedState: ProvisionerObservedState;
  readonly observedArtifactDigest: string | null;
  readonly observedRevisionId: string | null;
  readonly reportedAt: string;
}

export interface RuntimeResources {
  readonly cpuMilli: number;
  readonly memoryMiB: number;
  readonly ephemeralStorageMiB: number;
}

export interface ReservationSnapshot {
  readonly clusterId: string;
  readonly capacityEpoch: number;
  readonly observedAt: number;
  readonly complete: boolean;
  readonly capacity: {
    readonly allocatable: RuntimeResources;
    readonly requested: RuntimeResources;
    readonly nodeResourceVersion: string;
    readonly podResourceVersion: string;
  } | null;
  readonly representedReservationIds: readonly string[];
  readonly reservations: readonly ProvisionerReservation[];
}

export interface CapacitySnapshotInput {
  readonly clusterId: string;
  readonly observedAt: number;
  readonly complete: boolean;
  readonly capacity: {
    readonly allocatable: RuntimeResources;
    readonly requested: RuntimeResources;
    readonly nodeResourceVersion: string;
    readonly podResourceVersion: string;
  };
  readonly representedReservationIds: readonly string[];
}

export interface ControlCredentialRequest {
  readonly operationId: string;
  readonly workerId: string;
  readonly leaseToken: string;
  readonly leaseEpoch: number;
  readonly instanceId: string;
  readonly repositoryId: number;
  readonly runtimeEpoch: number;
  readonly action: "status" | "quiesce" | "resume";
  readonly payloadDigest: string;
  readonly signal?: AbortSignal;
}

export interface ControlCredentialResponse {
  readonly token: string;
  readonly expiresAt: string;
}

export interface RuntimeBindingMetadata {
  readonly repositoryId: number;
  readonly installationId: number;
  readonly instanceId: string;
  readonly runtimeId: string;
  readonly runtimeEpoch: number;
  readonly leaseId: string;
  readonly clusterId: string;
  readonly active: true;
  readonly authority: "observed-writer" | "post-absence-target";
}

export interface RuntimeIdentityRequest {
  readonly runtimeId: string;
  readonly instanceId: string;
  readonly repositoryId: number;
  readonly installationId: number;
  readonly runtimeEpoch: number;
  readonly leaseId: string;
  readonly workerId: string;
  readonly clusterId: string;
  readonly operationId?: string;
  readonly leaseToken?: string;
  readonly leaseEpoch?: number;
  readonly signal?: AbortSignal;
}

export interface RuntimeIdentityResponse {
  readonly token: string;
  readonly expiresAt: string;
}

export interface RuntimeHealthObservationInput {
  readonly workerId: string;
  readonly clusterId: string;
  readonly operationId: string;
  readonly readinessEvidence: LifecycleReadinessEvidence;
  readonly signal?: AbortSignal;
}

export interface RuntimeIdentityProvisionerService {
  readRuntimeBinding(input: {
    readonly repositoryId: number;
    readonly signal?: AbortSignal;
  }): Promise<RuntimeBindingMetadata | null>;
  issueRuntimeIdentity(input: RuntimeIdentityRequest): Promise<RuntimeIdentityResponse>;
}

export interface HttpOperationServiceOptions {
  readonly baseUrl: string;
  readonly credential: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface ProvisionerOperationService {
  listIdleCandidates(input: {
    readonly workerId: string;
    readonly clusterId: string;
    readonly limit: number;
    readonly cursor: string | null;
    readonly signal?: AbortSignal;
  }): Promise<ProvisionerIdleCandidatePage>;
  createIdleStop(input: {
    readonly workerId: string;
    readonly clusterId: string;
    readonly instanceId: string;
    readonly repositoryId: number;
    readonly expectedGeneration: number;
    readonly expectedRuntimeEpoch: number;
    readonly signal?: AbortSignal;
  }): Promise<string>;
  issueObservationCredential(input: {
    readonly workerId: string;
    readonly clusterId: string;
    readonly instanceId: string;
    readonly repositoryId: number;
    readonly expectedGeneration: number;
    readonly runtimeEpoch: number;
    readonly signal?: AbortSignal;
  }): Promise<ControlCredentialResponse & { readonly operationId: string }>;
  claimNext(input: {
    readonly workerId: string;
    readonly clusterId: string;
    readonly leaseSeconds: number;
    readonly signal?: AbortSignal;
  }): Promise<ClaimedProvisionerOperation | null>;
  heartbeat(input: {
    readonly operationId: string;
    readonly workerId: string;
    readonly leaseToken: string;
    readonly leaseEpoch: number;
    readonly sequence: number;
    readonly leaseSeconds: number;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly leaseExpiresAt: number; readonly operation: ProvisionerOperationRecord }>;
  checkpoint(input: {
    readonly operationId: string;
    readonly workerId: string;
    readonly leaseToken: string;
    readonly leaseEpoch: number;
    readonly expectedCheckpointSequence: number;
    readonly phase: LifecyclePhase;
    readonly checkpoint: Readonly<Record<string, unknown>>;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly operation: ProvisionerOperationRecord }>;
  advanceRuntimeEpochForRecovery(input: {
    readonly operationId: string;
    readonly workerId: string;
    readonly leaseToken: string;
    readonly leaseEpoch: number;
    readonly expectedRuntimeEpoch: number;
    readonly checkpoint: Readonly<Record<string, unknown>>;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly operation: ProvisionerOperationRecord }>;
  reserveRuntime(input: {
    readonly operationId: string;
    readonly workerId: string;
    readonly leaseToken: string;
    readonly leaseEpoch: number;
    readonly expectedRuntimeEpoch: number;
    readonly clusterId: string;
    readonly expectedCapacityEpoch: number;
    readonly resources: RuntimeResources;
    readonly reservationId: string;
    readonly signal?: AbortSignal;
  }): Promise<ProvisionerReservation | null>;
  currentReservations(input: {
    readonly clusterId: string;
    readonly signal?: AbortSignal;
  }): Promise<ReservationSnapshot>;
  recordCapacitySnapshot(
    input: CapacitySnapshotInput & { readonly signal?: AbortSignal },
  ): Promise<number | null>;
  issueControlCredential(input: ControlCredentialRequest): Promise<ControlCredentialResponse>;
  recordRuntimeHealth?(input: RuntimeHealthObservationInput): Promise<{ readonly recorded: true }>;
  releaseRuntime(input: {
    readonly reservationId: string;
    readonly operationId: string;
    readonly workerId: string;
    readonly leaseToken: string;
    readonly leaseEpoch: number;
    readonly expectedReservationRuntimeEpoch: number;
    readonly signal?: AbortSignal;
  }): Promise<void>;
  report(input: {
    readonly operationId: string;
    readonly workerId: string;
    readonly leaseToken: string;
    readonly leaseEpoch: number;
    readonly sequence: number;
    readonly observation: ProvisionerObservation | null;
    readonly terminal?: ProvisionerTerminal | null;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly operation: ProvisionerOperationRecord;
    readonly applied: boolean;
    readonly duplicate: boolean;
  }>;
}

export class OperationServiceHttpError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(`Operation Service request failed (${code})`);
    this.name = "OperationServiceHttpError";
  }
}

const SERVICE_PATH = "/internal/provisioner";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function object(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(message);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(message);
  return value;
}

function safeInteger(value: unknown, message: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new TypeError(message);
  return value;
}

function positiveInteger(value: unknown, message: string): number {
  const result = safeInteger(value, message);
  if (result < 1) throw new TypeError(message);
  return result;
}

function nullableString(value: unknown, message: string): string | null {
  if (value === null) return null;
  return nonEmptyString(value, message);
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], message: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new TypeError(message);
  return value as T;
}

const lifecyclePhases: readonly LifecyclePhase[] = [
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
const operationKinds: readonly ProvisionerOperationKind[] = ["start", "stop", "redeploy", "update"];
const operationStatuses: readonly ProvisionerOperationStatus[] = [
  "pending",
  "claimed",
  "running",
  "succeeded",
  "failed",
  "blocked",
];
const observedStates: readonly ProvisionerObservedState[] = [
  "absent",
  "starting",
  "ready",
  "stopping",
  "stopped",
  "failed",
  "unknown",
];
const reservationStatuses: readonly ProvisionerReservation["status"][] = [
  "pending",
  "reserved",
  "allocated",
  "released",
  "blocked",
];
const reservationStates: readonly ProvisionerInstanceSnapshot["reservationState"][] = [
  "none",
  "pending",
  "reserved",
  "allocated",
  "blocked",
  "released",
];
const sha256 = /^sha256:[0-9a-f]{64}$/u;
const moduleId = /^[a-z][a-z0-9-]{0,63}$/u;

function parseResources(input: unknown, message: string): RuntimeResources {
  const value = object(input, message);
  return {
    cpuMilli: safeInteger(value.cpuMilli, message),
    memoryMiB: safeInteger(value.memoryMiB, message),
    ephemeralStorageMiB: safeInteger(value.ephemeralStorageMiB, message),
  };
}

function parsePersistenceDeclaration(input: unknown): NonNullable<
  ProvisionerResolvedRuntime["assignment"]["persistence"]
> {
  const value = object(input, "runtime persistence declaration invalid");
  if (value.contractVersion !== "scriptorium-persistence/v1")
    throw new TypeError("runtime persistence declaration version invalid");
  if (!Array.isArray(value.readable) || value.readable.length > 128)
    throw new TypeError("runtime readable persistence formats invalid");
  if (!Array.isArray(value.writable) || value.writable.length > 128)
    throw new TypeError("runtime writable persistence formats invalid");
  const readableIds = new Set<string>();
  const readable = value.readable.map((entry) => {
    const item = object(entry, "runtime readable persistence format invalid");
    const formatId = nonEmptyString(item.formatId, "runtime persistence format ID invalid");
    if (!/^[a-z][a-z0-9.-]{0,127}$/u.test(formatId) || readableIds.has(formatId))
      throw new TypeError("runtime readable persistence format ID invalid");
    readableIds.add(formatId);
    if (
      !Array.isArray(item.versions) ||
      item.versions.length < 1 ||
      item.versions.length > 64 ||
      item.versions.some((version) => !Number.isSafeInteger(version) || (version as number) < 1) ||
      new Set(item.versions).size !== item.versions.length
    )
      throw new TypeError("runtime readable persistence versions invalid");
    return { formatId, versions: [...item.versions] as number[] };
  });
  const writablePairs = new Set<string>();
  const writable = value.writable.map((entry) => {
    const item = object(entry, "runtime writable persistence format invalid");
    const formatId = nonEmptyString(item.formatId, "runtime persistence format ID invalid");
    const version = positiveInteger(item.version, "runtime persistence version invalid");
    if (!/^[a-z][a-z0-9.-]{0,127}$/u.test(formatId))
      throw new TypeError("runtime writable persistence format ID invalid");
    const pair = `${formatId}\u0000${version}`;
    if (writablePairs.has(pair)) throw new TypeError("duplicate runtime writable persistence format");
    writablePairs.add(pair);
    return { formatId, version };
  });
  return { contractVersion: "scriptorium-persistence/v1", readable, writable };
}

function parsePolicy(input: unknown, message: string): ProvisionerAuthenticationPolicy {
  const value = object(input, message);
  const issuer = nonEmptyString(value.issuer, message);
  const jwksUrl = nonEmptyString(value.jwksUrl, message);
  const audience = nonEmptyString(value.audience, message);
  for (const candidate of [issuer, jwksUrl]) {
    const url = new URL(candidate);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new TypeError(message);
    }
  }
  return { issuer, jwksUrl, audience };
}

function parseRuntimeBinding(input: unknown): RuntimeBindingMetadata {
  const value = object(input, "runtime binding metadata invalid");
  const expected = [
    "active",
    "authority",
    "clusterId",
    "installationId",
    "instanceId",
    "leaseId",
    "repositoryId",
    "runtimeEpoch",
    "runtimeId",
  ];
  if (Object.keys(value).sort().join(",") !== expected.sort().join(","))
    throw new TypeError("runtime binding metadata has an unsupported shape");
  if (value.active !== true) throw new TypeError("runtime binding is not active");
  return {
    repositoryId: positiveInteger(value.repositoryId, "runtime binding repository invalid"),
    installationId: positiveInteger(value.installationId, "runtime binding installation invalid"),
    instanceId: nonEmptyString(value.instanceId, "runtime binding instance invalid"),
    runtimeId: nonEmptyString(value.runtimeId, "runtime binding ID invalid"),
    runtimeEpoch: positiveInteger(value.runtimeEpoch, "runtime binding epoch invalid"),
    leaseId: nonEmptyString(value.leaseId, "runtime binding lease invalid"),
    clusterId: nonEmptyString(value.clusterId, "runtime binding cluster invalid"),
    active: true,
    authority: enumValue(
      value.authority,
      ["observed-writer", "post-absence-target"],
      "runtime binding authority invalid",
    ),
  };
}

function parseRuntimeMetadata(input: unknown): ProvisionerResolvedRuntime["metadata"] {
  const metadata = object(input, "runtime metadata invalid");
  const listener = object(metadata.listener, "runtime listener invalid");
  const paths = object(metadata.paths, "runtime paths invalid");
  const producerRevision = nonEmptyString(metadata.producerRevision, "producer revision missing");
  if (!/^[a-f0-9]{40}$/u.test(producerRevision)) throw new TypeError("producer revision invalid");
  const port = positiveInteger(listener.port, "runtime port invalid");
  if (port > 65_535) throw new TypeError("runtime port invalid");
  const path = (key: string) => {
    const value = nonEmptyString(paths[key], "runtime path missing");
    if (!/^\/(?!\/)[^\r\n?#]{1,256}$/u.test(value)) throw new TypeError("runtime path invalid");
    return value;
  };
  if (
    metadata.contractVersion !== "scriptorium-platform/v1" ||
    paths.status !== "/api/platform/v1/status" ||
    paths.quiesce !== "/api/platform/v1/quiesce" ||
    paths.resume !== "/api/platform/v1/resume"
  )
    throw new TypeError("runtime metadata contract version or control paths invalid");
  return {
    contractVersion: "scriptorium-platform/v1",
    producerRevision,
    listener: { port },
    paths: {
      liveness: path("liveness"),
      readiness: path("readiness"),
      metadata: path("metadata"),
      shutdown: path("shutdown"),
      status: "/api/platform/v1/status",
      quiesce: "/api/platform/v1/quiesce",
      resume: "/api/platform/v1/resume",
    },
    shutdownTimeoutSeconds: positiveInteger(
      metadata.shutdownTimeoutSeconds,
      "runtime shutdown timeout invalid",
    ),
  };
}

function parseResolvedRuntime(input: unknown): ProvisionerResolvedRuntime {
  const value = object(input, "resolved runtime context invalid");
  const assignment = object(value.assignment, "runtime assignment invalid");
  if (assignment.contractVersion !== "scriptorium-platform/v1")
    throw new TypeError("runtime assignment contract version invalid");
  const enabledModuleIds = assignment.enabledModuleIds;
  if (
    !Array.isArray(enabledModuleIds) ||
    enabledModuleIds.length > 256 ||
    enabledModuleIds.some((item) => typeof item !== "string" || !moduleId.test(item)) ||
    new Set(enabledModuleIds).size !== enabledModuleIds.length
  ) {
    throw new TypeError("runtime assignment module set invalid");
  }
  const imageDigest = nonEmptyString(assignment.imageDigest, "runtime image digest missing");
  const compositionManifestDigest = nonEmptyString(
    assignment.compositionManifestDigest,
    "runtime composition digest missing",
  );
  const platformManifestDigest = nonEmptyString(
    value.platformManifestDigest,
    "runtime platform manifest digest missing",
  );
  if (
    !sha256.test(imageDigest) ||
    !sha256.test(compositionManifestDigest) ||
    !sha256.test(platformManifestDigest)
  ) {
    throw new TypeError("runtime artifact digest invalid");
  }
  const artifactRef = nonEmptyString(value.artifactRef, "runtime artifact reference missing");
  if (
    !/^[a-z0-9][a-z0-9./:_-]{0,254}@sha256:[0-9a-f]{64}$/u.test(artifactRef) ||
    !artifactRef.endsWith(`@${imageDigest}`)
  ) {
    throw new TypeError("runtime artifact reference is not bound to its admitted digest");
  }
  const repositoryLocator = nonEmptyString(
    assignment.repositoryLocator,
    "runtime repository locator missing",
  );
  const repositoryUrl = new URL(repositoryLocator);
  if (
    repositoryUrl.protocol !== "https:" ||
    repositoryUrl.hostname !== "github.com" ||
    repositoryUrl.port !== "" ||
    repositoryUrl.username !== "" ||
    repositoryUrl.password !== "" ||
    !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repositoryUrl.pathname) ||
    repositoryUrl.search !== "" ||
    repositoryUrl.hash !== ""
  )
    throw new TypeError("runtime repository locator invalid");
  const hostname = nonEmptyString(value.hostname, "runtime hostname missing");
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u.test(hostname) || hostname.includes("..")) {
    throw new TypeError("runtime hostname invalid");
  }
  const resourceProfileId = nonEmptyString(
    value.resourceProfileId,
    "runtime resource profile missing",
  );
  if (!moduleId.test(resourceProfileId)) throw new TypeError("runtime resource profile invalid");
  const persistence =
    assignment.persistence === undefined
      ? undefined
      : parsePersistenceDeclaration(assignment.persistence);
  return {
    revisionId: nonEmptyString(value.revisionId, "runtime revision ID missing"),
    artifactRef,
    platformManifestDigest,
    resourceProfileId,
    hostname,
    resources: parseResources(value.resources, "runtime resource profile invalid"),
    assignment: {
      contractVersion: "scriptorium-platform/v1",
      instanceId: nonEmptyString(assignment.instanceId, "runtime instance ID missing"),
      repositoryId: positiveInteger(assignment.repositoryId, "runtime repository ID missing"),
      repositoryLocator,
      defaultBranchPolicy: nonEmptyString(
        assignment.defaultBranchPolicy,
        "runtime branch policy missing",
      ),
      runtimeEpoch: positiveInteger(assignment.runtimeEpoch, "runtime epoch missing"),
      imageDigest,
      compositionManifestDigest,
      enabledModuleIds: [...enabledModuleIds] as string[],
      ...(persistence === undefined ? {} : { persistence }),
      credentialBrokerLocator: nonEmptyString(
        assignment.credentialBrokerLocator,
        "credential broker locator missing",
      ),
      grantPolicy: parsePolicy(assignment.grantPolicy, "runtime grant policy invalid"),
      controlServicePolicy: parsePolicy(
        assignment.controlServicePolicy,
        "runtime control policy invalid",
      ),
    },
    metadata: parseRuntimeMetadata(value.metadata),
  };
}

function parseIdleCandidate(input: unknown): ProvisionerIdleCandidate {
  const value = object(input, "invalid idle candidate");
  const instanceId = nonEmptyString(value.instanceId, "idle candidate instance ID missing");
  const repositoryId = positiveInteger(value.repositoryId, "idle candidate repository ID missing");
  const generation = positiveInteger(value.generation, "idle candidate generation missing");
  const runtimeEpoch = positiveInteger(value.runtimeEpoch, "idle candidate runtime epoch missing");
  const clusterId = nonEmptyString(value.clusterId, "idle candidate cluster ID missing");
  const desiredState = enumValue(
    value.desiredState,
    ["running", "stopped"],
    "idle candidate desired state invalid",
  );
  if (
    typeof value.bindingSuspended !== "boolean" ||
    typeof value.hasActiveOperation !== "boolean"
  ) {
    throw new TypeError("idle candidate eligibility flags invalid");
  }
  const currentRuntime = parseResolvedRuntime(value.currentRuntime);
  const healthOperationId =
    value.healthOperationId === undefined || value.healthOperationId === null
      ? null
      : nonEmptyString(value.healthOperationId, "idle candidate health operation ID invalid");
  if (
    currentRuntime.assignment.instanceId !== instanceId ||
    currentRuntime.assignment.repositoryId !== repositoryId ||
    currentRuntime.assignment.runtimeEpoch !== runtimeEpoch
  ) {
    throw new TypeError("idle candidate current runtime identity mismatch");
  }
  return {
    instanceId,
    repositoryId,
    generation,
    runtimeEpoch,
    clusterId,
    desiredState,
    bindingSuspended: value.bindingSuspended,
    hasActiveOperation: value.hasActiveOperation,
    healthOperationId,
    currentRuntime,
  };
}

function parseIdleCandidatePage(
  input: unknown,
  requestedLimit: number,
): ProvisionerIdleCandidatePage {
  const value = object(input, "invalid idle candidate page");
  if (!Array.isArray(value.items) || value.items.length > requestedLimit) {
    throw new TypeError("idle candidate page exceeds the requested bound");
  }
  const items = value.items.map(parseIdleCandidate);
  if (new Set(items.map((item) => item.instanceId)).size !== items.length) {
    throw new TypeError("idle candidate page contains duplicate instances");
  }
  let nextCursor: string | null;
  if (value.nextCursor === null) nextCursor = null;
  else {
    nextCursor = nonEmptyString(value.nextCursor, "idle candidate cursor invalid");
    if (nextCursor.length > 2_048 || /[\r\n]/u.test(nextCursor)) {
      throw new TypeError("idle candidate cursor exceeds its bound");
    }
  }
  return { items, nextCursor };
}

function parseOperation(input: unknown): ProvisionerOperationRecord {
  const operation = object(input, "invalid operation record");
  return {
    id: nonEmptyString(operation.id, "operation ID missing"),
    instanceId: nonEmptyString(operation.instanceId, "operation instance missing"),
    repositoryId: positiveInteger(operation.repositoryId, "operation repository missing"),
    generation: positiveInteger(operation.generation, "operation generation missing"),
    runtimeEpoch: positiveInteger(operation.runtimeEpoch, "operation epoch missing"),
    kind: enumValue(operation.kind, operationKinds, "operation kind invalid"),
    status: enumValue(operation.status, operationStatuses, "operation status invalid"),
    attempt: safeInteger(operation.attempt, "operation attempt missing"),
    leaseEpoch: positiveInteger(operation.leaseEpoch, "lease epoch missing"),
    leaseToken: nonEmptyString(operation.leaseToken, "lease token missing"),
    leaseExpiresAt: positiveInteger(operation.leaseExpiresAt, "lease expiry missing"),
    reportSequence: safeInteger(operation.reportSequence, "report sequence missing"),
    phase: enumValue(operation.phase, lifecyclePhases, "operation phase invalid"),
    checkpointSequence: safeInteger(operation.checkpointSequence, "checkpoint sequence missing"),
    checkpoint:
      operation.checkpoint === null
        ? null
        : object(operation.checkpoint, "invalid operation checkpoint"),
    clusterId: nullableString(operation.clusterId, "operation cluster ID invalid"),
    reservationId: nullableString(operation.reservationId, "operation reservation ID invalid"),
    deploymentRevisionId: nullableString(
      operation.deploymentRevisionId,
      "operation deployment revision ID invalid",
    ),
    buildId: nullableString(operation.buildId, "operation build ID invalid"),
    prerequisiteBuildId: nullableString(
      operation.prerequisiteBuildId,
      "operation prerequisite build ID invalid",
    ),
  };
}

function parseReservation(input: unknown): ProvisionerReservation {
  const value = object(input, "invalid runtime reservation");
  const clusterId = nullableString(value.clusterId, "reservation cluster ID invalid");
  const reservation: ProvisionerReservation = {
    reservationId: nonEmptyString(value.reservationId, "reservation ID missing"),
    instanceId: nonEmptyString(value.instanceId, "reservation instance missing"),
    repositoryId: positiveInteger(value.repositoryId, "reservation repository missing"),
    runtimeEpoch: positiveInteger(value.runtimeEpoch, "reservation epoch missing"),
    generation: positiveInteger(value.generation, "reservation generation missing"),
    clusterId,
    status: enumValue(value.status, reservationStatuses, "reservation status invalid"),
    resources: parseResources(value.resources, "reservation resources invalid"),
    capacitySnapshotEpoch: safeInteger(
      value.capacitySnapshotEpoch,
      "reservation capacity epoch missing",
    ),
    createdAt: safeInteger(value.createdAt, "reservation created time missing"),
    updatedAt: safeInteger(value.updatedAt, "reservation updated time missing"),
  };
  return reservation;
}

function parseCapacity(input: unknown): ReservationSnapshot["capacity"] {
  if (input === null) return null;
  const value = object(input, "invalid persisted capacity snapshot");
  return {
    allocatable: parseResources(value.allocatable, "capacity allocatable resources invalid"),
    requested: parseResources(value.requested, "capacity requested resources invalid"),
    nodeResourceVersion: nonEmptyString(
      value.nodeResourceVersion,
      "capacity node resource version missing",
    ),
    podResourceVersion: nonEmptyString(
      value.podResourceVersion,
      "capacity Pod resource version missing",
    ),
  };
}

function parseReservationSnapshot(input: unknown): ReservationSnapshot {
  const value = object(input, "invalid reservation snapshot");
  if (!Array.isArray(value.representedReservationIds) || !Array.isArray(value.reservations)) {
    throw new TypeError("invalid reservation snapshot collections");
  }
  return {
    clusterId: nonEmptyString(value.clusterId, "reservation snapshot cluster missing"),
    capacityEpoch: safeInteger(value.capacityEpoch, "capacity epoch missing"),
    observedAt: safeInteger(value.observedAt, "capacity observation time missing"),
    complete: value.complete === true,
    capacity: parseCapacity(value.capacity),
    representedReservationIds: value.representedReservationIds.map((item) =>
      nonEmptyString(item, "invalid represented reservation ID"),
    ),
    reservations: value.reservations.map(parseReservation),
  };
}

function parseOperationEnvelope(input: unknown): {
  readonly operation: ProvisionerOperationRecord;
} {
  const value = object(input, "invalid operation response");
  return { operation: parseOperation(value.operation) };
}

function assertOperationResponse(
  operation: ProvisionerOperationRecord,
  expected: {
    readonly operationId: string;
    readonly leaseEpoch: number;
    readonly leaseToken: string;
  },
): void {
  if (
    operation.id !== expected.operationId ||
    operation.leaseEpoch !== expected.leaseEpoch ||
    operation.leaseToken !== expected.leaseToken
  )
    throw new TypeError("Operation Service returned a mismatched lease response");
}

function parseReservationOrNull(input: unknown): ProvisionerReservation | null {
  if (input === null) return null;
  const envelope = object(input, "invalid reservation response");
  return parseReservation("reservation" in envelope ? envelope.reservation : envelope);
}

function parseClaim(input: unknown): ClaimedProvisionerOperation | null {
  if (input === null) return null;
  const response = object(input, "invalid claim response");
  if (response.operation === null) return null;
  const operation = object(response.operation, "invalid claimed operation");
  const snapshot = object(response.snapshot, "invalid claimed snapshot");
  const binding = object(snapshot.binding, "invalid repository binding");
  const instance = object(snapshot.instance, "invalid instance snapshot");
  const reservation =
    response.reservation === null
      ? null
      : object(response.reservation, "invalid runtime reservation");
  const currentReservation =
    response.currentReservation === null
      ? null
      : object(response.currentReservation, "invalid current runtime reservation");
  const deploymentRevision =
    response.deploymentRevision === null
      ? null
      : object(response.deploymentRevision, "invalid deployment revision");
  const currentDeploymentRevision =
    response.currentDeploymentRevision === null
      ? null
      : object(response.currentDeploymentRevision, "invalid current deployment revision");
  const runtimeContext = object(response.runtimeContext, "resolved runtime context missing");
  const currentRuntime =
    runtimeContext.current === null ? null : parseResolvedRuntime(runtimeContext.current);
  const targetRuntime =
    runtimeContext.target === null ? null : parseResolvedRuntime(runtimeContext.target);

  const parsedOperation = parseOperation(operation);
  const parsedBinding: ProvisionerBindingSnapshot = {
    repositoryId: positiveInteger(binding.repositoryId, "binding repository missing"),
    instanceId: nonEmptyString(binding.instanceId, "binding instance missing"),
    installationId: positiveInteger(binding.installationId, "binding installation missing"),
    owner: nonEmptyString(binding.owner, "binding owner missing"),
    name: nonEmptyString(binding.name, "binding name missing"),
    authorizationRevision: safeInteger(
      binding.authorizationRevision,
      "binding authorization missing",
    ),
    bindingEpoch: positiveInteger(binding.bindingEpoch, "binding epoch missing"),
    suspended: binding.suspended === true,
  };
  const parsedInstance: ProvisionerInstanceSnapshot = {
    instanceId: nonEmptyString(instance.instanceId, "instance ID missing"),
    repositoryId: positiveInteger(instance.repositoryId, "instance repository missing"),
    generation: positiveInteger(instance.generation, "instance generation missing"),
    runtimeEpoch: positiveInteger(instance.runtimeEpoch, "instance epoch missing"),
    observedGeneration:
      instance.observedGeneration === null
        ? null
        : safeInteger(instance.observedGeneration, "observed generation invalid"),
    desiredState: enumValue(
      instance.desiredState,
      ["running", "stopped"],
      "instance desired state invalid",
    ),
    observedState: enumValue(
      instance.observedState,
      observedStates,
      "instance observed state invalid",
    ),
    observedRuntimeEpoch:
      instance.observedRuntimeEpoch === null
        ? null
        : safeInteger(instance.observedRuntimeEpoch, "observed runtime epoch invalid"),
    observedRevisionId:
      instance.observedRevisionId === null
        ? null
        : nonEmptyString(instance.observedRevisionId, "observed revision ID invalid"),
    desiredRevisionId:
      instance.desiredRevisionId === null
        ? null
        : nonEmptyString(instance.desiredRevisionId, "desired revision ID invalid"),
    currentArtifactDigest:
      instance.currentArtifactDigest === null
        ? null
        : nonEmptyString(instance.currentArtifactDigest, "current artifact digest invalid"),
    desiredArtifactDigest:
      instance.desiredArtifactDigest === null
        ? null
        : nonEmptyString(instance.desiredArtifactDigest, "desired artifact digest invalid"),
    reservationState: enumValue(
      instance.reservationState,
      reservationStates,
      "instance reservation state invalid",
    ),
    reservationId: nullableString(instance.reservationId, "instance reservation ID invalid"),
    clusterId: nullableString(instance.clusterId, "instance cluster ID invalid"),
  };
  if (
    parsedOperation.status !== "claimed" ||
    parsedOperation.clusterId === null ||
    parsedOperation.id.length === 0 ||
    parsedBinding.suspended ||
    parsedOperation.instanceId !== parsedBinding.instanceId ||
    parsedOperation.instanceId !== parsedInstance.instanceId ||
    parsedOperation.repositoryId !== parsedBinding.repositoryId ||
    parsedOperation.repositoryId !== parsedInstance.repositoryId ||
    parsedOperation.generation !== parsedInstance.generation ||
    parsedOperation.runtimeEpoch !== parsedInstance.runtimeEpoch
  )
    throw new TypeError("claimed operation identity is inconsistent");

  for (const resolved of [currentRuntime, targetRuntime]) {
    if (
      resolved !== null &&
      (resolved.assignment.instanceId !== parsedOperation.instanceId ||
        resolved.assignment.repositoryId !== parsedOperation.repositoryId)
    )
      throw new TypeError("resolved runtime belongs to another repository instance");
  }
  if (
    currentRuntime !== null &&
    (parsedInstance.observedRuntimeEpoch !== currentRuntime.assignment.runtimeEpoch ||
      parsedInstance.observedGeneration === null ||
      parsedInstance.observedRevisionId !== currentRuntime.revisionId ||
      parsedInstance.currentArtifactDigest !== currentRuntime.assignment.imageDigest ||
      parsedInstance.clusterId !== parsedOperation.clusterId)
  )
    throw new TypeError("resolved current runtime differs from the observed instance state");
  if (currentRuntime === null && parsedInstance.observedState === "ready") {
    throw new TypeError("ready instance is missing its resolved current runtime");
  }
  if (parsedOperation.kind === "stop") {
    if (targetRuntime !== null)
      throw new TypeError("stop operation unexpectedly carries a target runtime");
  } else if (
    targetRuntime === null ||
    targetRuntime.assignment.runtimeEpoch !== parsedOperation.runtimeEpoch ||
    parsedOperation.deploymentRevisionId !== targetRuntime.revisionId ||
    (deploymentRevision !== null &&
      (deploymentRevision.revisionId !== targetRuntime.revisionId ||
        deploymentRevision.status !== "admitted" ||
        deploymentRevision.artifactDigest !== targetRuntime.assignment.imageDigest))
  )
    throw new TypeError("target runtime is not bound to the admitted deployment revision");

  return {
    operation: parsedOperation,
    snapshot: {
      binding: parsedBinding,
      instance: parsedInstance,
    },
    reservation: reservation === null ? null : parseReservation(reservation),
    currentReservation: currentReservation === null ? null : parseReservation(currentReservation),
    deploymentRevision:
      deploymentRevision === null
        ? null
        : {
            revisionId: nonEmptyString(
              deploymentRevision.revisionId,
              "deployment revision ID missing",
            ),
            instanceId: nonEmptyString(
              deploymentRevision.instanceId,
              "deployment revision instance missing",
            ),
            repositoryId: positiveInteger(
              deploymentRevision.repositoryId,
              "deployment revision repository missing",
            ),
            generation: positiveInteger(
              deploymentRevision.generation,
              "deployment revision generation missing",
            ),
            buildKey: nonEmptyString(
              deploymentRevision.buildKey,
              "deployment revision build key missing",
            ),
            buildId: nonEmptyString(
              deploymentRevision.buildId,
              "deployment revision build ID missing",
            ),
            selection: object(
              deploymentRevision.selection,
              "deployment revision selection invalid",
            ),
            resources: parseResources(
              deploymentRevision.resources,
              "deployment revision resources invalid",
            ),
            artifactDigest:
              deploymentRevision.artifactDigest === null
                ? null
                : nonEmptyString(
                    deploymentRevision.artifactDigest,
                    "deployment revision artifact digest invalid",
                  ),
            status: enumValue(
              deploymentRevision.status,
              ["building", "admitted", "failed", "superseded"],
              "deployment revision status invalid",
            ),
          },
    currentDeploymentRevision:
      currentDeploymentRevision === null
        ? null
        : {
            revisionId: nonEmptyString(
              currentDeploymentRevision.revisionId,
              "current deployment revision ID missing",
            ),
            instanceId: nonEmptyString(
              currentDeploymentRevision.instanceId,
              "current deployment revision instance missing",
            ),
            repositoryId: positiveInteger(
              currentDeploymentRevision.repositoryId,
              "current deployment revision repository missing",
            ),
            generation: positiveInteger(
              currentDeploymentRevision.generation,
              "current deployment revision generation missing",
            ),
            buildKey: nonEmptyString(
              currentDeploymentRevision.buildKey,
              "current deployment revision build key missing",
            ),
            buildId: nonEmptyString(
              currentDeploymentRevision.buildId,
              "current deployment revision build ID missing",
            ),
            selection: object(
              currentDeploymentRevision.selection,
              "current deployment revision selection invalid",
            ),
            resources: parseResources(
              currentDeploymentRevision.resources,
              "current deployment revision resources invalid",
            ),
            artifactDigest:
              currentDeploymentRevision.artifactDigest === null
                ? null
                : nonEmptyString(
                    currentDeploymentRevision.artifactDigest,
                    "current deployment revision artifact digest invalid",
                  ),
            status: enumValue(
              currentDeploymentRevision.status,
              ["building", "admitted", "failed", "superseded"],
              "current deployment revision status invalid",
            ),
          },
    runtimeContext: { current: currentRuntime, target: targetRuntime },
  };
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname))
  ) {
    throw new TypeError("Control Plane URL must use HTTPS outside localhost");
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new TypeError("Control Plane URL cannot contain credentials, query, or fragment");
  }
  return value.replace(/\/+$/u, "");
}

export class OperationServiceHttpClient
  implements ProvisionerOperationService, RuntimeIdentityProvisionerService
{
  private readonly baseUrl: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: HttpOperationServiceOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (options.credential.length === 0 || options.credential.length > 4096) {
      throw new TypeError("Operation Service credential is invalid");
    }
    if (/[\r\n]/u.test(options.credential))
      throw new TypeError("Operation Service credential is invalid");
  }

  async listIdleCandidates(input: {
    readonly workerId: string;
    readonly clusterId: string;
    readonly limit: number;
    readonly cursor: string | null;
    readonly signal?: AbortSignal;
  }): Promise<ProvisionerIdleCandidatePage> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 25) {
      throw new RangeError("idle candidate page limit must be between 1 and 25");
    }
    return this.post("/idle-candidates", withoutSignal(input), input.signal).then((result) =>
      parseIdleCandidatePage(result, input.limit),
    );
  }

  async createIdleStop(input: {
    readonly workerId: string;
    readonly clusterId: string;
    readonly instanceId: string;
    readonly repositoryId: number;
    readonly expectedGeneration: number;
    readonly expectedRuntimeEpoch: number;
    readonly signal?: AbortSignal;
  }): Promise<string> {
    const value = object(
      await this.post("/idle-stop", withoutSignal(input), input.signal),
      "invalid idle stop response",
    );
    return nonEmptyString(value.operationId, "idle stop operation ID missing");
  }

  async issueObservationCredential(input: {
    readonly workerId: string;
    readonly clusterId: string;
    readonly instanceId: string;
    readonly repositoryId: number;
    readonly expectedGeneration: number;
    readonly runtimeEpoch: number;
    readonly signal?: AbortSignal;
  }): Promise<ControlCredentialResponse & { readonly operationId: string }> {
    const value = object(
      await this.post("/observation-credential", withoutSignal(input), input.signal),
      "invalid idle observation credential response",
    );
    const token = nonEmptyString(value.token, "idle observation credential token missing");
    const expiresAt = nonEmptyString(value.expiresAt, "idle observation credential expiry missing");
    const operationId = nonEmptyString(
      value.operationId,
      "idle observation credential operation ID missing",
    );
    const expiry = Date.parse(expiresAt);
    const now = Date.now();
    if (
      token.length > 8192 ||
      /[\r\n]/u.test(token) ||
      !Number.isFinite(expiry) ||
      expiry <= now ||
      expiry > now + 31_000
    ) {
      throw new TypeError("idle observation credential response is invalid or expired");
    }
    return { token, expiresAt, operationId };
  }

  async claimNext(input: {
    readonly workerId: string;
    readonly clusterId: string;
    readonly leaseSeconds: number;
    readonly signal?: AbortSignal;
  }): Promise<ClaimedProvisionerOperation | null> {
    const result = await this.post(
      "/claim",
      {
        workerId: input.workerId,
        clusterId: input.clusterId,
        leaseSeconds: input.leaseSeconds,
      },
      input.signal,
    );
    const claim = parseClaim(result);
    if (claim !== null && claim.operation.clusterId !== input.clusterId) {
      throw new TypeError("claimed operation belongs to a different runtime cluster");
    }
    return claim;
  }

  heartbeat(input: {
    readonly operationId: string;
    readonly workerId: string;
    readonly leaseToken: string;
    readonly leaseEpoch: number;
    readonly sequence: number;
    readonly leaseSeconds: number;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly leaseExpiresAt: number; readonly operation: ProvisionerOperationRecord }> {
    return this.post("/heartbeat", withoutSignal(input), input.signal).then((result) => {
      const value = object(result, "invalid heartbeat response");
      const operation = parseOperation(value.operation);
      assertOperationResponse(operation, input);
      return {
        leaseExpiresAt: positiveInteger(value.leaseExpiresAt, "lease expiry response invalid"),
        operation,
      };
    });
  }

  checkpoint(input: {
    readonly operationId: string;
    readonly workerId: string;
    readonly leaseToken: string;
    readonly leaseEpoch: number;
    readonly expectedCheckpointSequence: number;
    readonly phase: LifecyclePhase;
    readonly checkpoint: Readonly<Record<string, unknown>>;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly operation: ProvisionerOperationRecord }> {
    return this.post("/checkpoint", withoutSignal(input), input.signal).then((result) => {
      const parsed = parseOperationEnvelope(result);
      assertOperationResponse(parsed.operation, input);
      return parsed;
    });
  }

  advanceRuntimeEpochForRecovery(input: {
    readonly operationId: string;
    readonly workerId: string;
    readonly leaseToken: string;
    readonly leaseEpoch: number;
    readonly expectedRuntimeEpoch: number;
    readonly checkpoint: Readonly<Record<string, unknown>>;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly operation: ProvisionerOperationRecord }> {
    return this.post("/advance-epoch", withoutSignal(input), input.signal).then((result) => {
      const parsed = parseOperationEnvelope(result);
      assertOperationResponse(parsed.operation, input);
      return parsed;
    });
  }

  reserveRuntime(input: {
    readonly operationId: string;
    readonly workerId: string;
    readonly leaseToken: string;
    readonly leaseEpoch: number;
    readonly expectedRuntimeEpoch: number;
    readonly clusterId: string;
    readonly expectedCapacityEpoch: number;
    readonly resources: RuntimeResources;
    readonly reservationId: string;
    readonly signal?: AbortSignal;
  }): Promise<ProvisionerReservation | null> {
    return this.post("/reserve", withoutSignal(input), input.signal).then(parseReservationOrNull);
  }

  currentReservations(input: {
    readonly clusterId: string;
    readonly signal?: AbortSignal;
  }): Promise<ReservationSnapshot> {
    return this.post("/reservations/current", withoutSignal(input), input.signal).then(
      parseReservationSnapshot,
    );
  }

  async recordCapacitySnapshot(
    input: CapacitySnapshotInput & { readonly signal?: AbortSignal },
  ): Promise<number | null> {
    const response = object(
      await this.post("/capacity/record", withoutSignal(input), input.signal),
      "invalid capacity record response",
    );
    if (response.capacityEpoch === null) return null;
    return positiveInteger(response.capacityEpoch, "capacity epoch response invalid");
  }

  async issueControlCredential(
    input: ControlCredentialRequest,
  ): Promise<ControlCredentialResponse> {
    if (!/^sha256:[a-f0-9]{64}$/u.test(input.payloadDigest)) {
      throw new TypeError("runtime control payload digest is invalid");
    }
    const value = object(
      await this.post("/control-credential", withoutSignal(input), input.signal),
      "invalid runtime control credential response",
    );
    const token = nonEmptyString(value.token, "runtime control credential token missing");
    if (token.length > 8192 || /[\r\n]/u.test(token))
      throw new TypeError("runtime control credential token is invalid");
    const expiresAt = nonEmptyString(value.expiresAt, "runtime control credential expiry missing");
    const expiryMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiryMs) || expiryMs <= Date.now() || expiryMs > Date.now() + 61_000) {
      throw new TypeError("runtime control credential expiry is outside its short lifetime");
    }
    return { token, expiresAt };
  }

  async readRuntimeBinding(input: {
    readonly repositoryId: number;
    readonly signal?: AbortSignal;
  }): Promise<RuntimeBindingMetadata | null> {
    try {
      return parseRuntimeBinding(
        await this.get(
          `/runtime-bindings/${encodeURIComponent(String(input.repositoryId))}`,
          input.signal,
        ),
      );
    } catch (error) {
      if (error instanceof OperationServiceHttpError && error.status === 404) return null;
      throw error;
    }
  }

  async issueRuntimeIdentity(input: RuntimeIdentityRequest): Promise<RuntimeIdentityResponse> {
    const value = object(
      await this.post("/runtime-identity", withoutSignal(input), input.signal),
      "invalid runtime identity response",
    );
    if (Object.keys(value).sort().join(",") !== "expiresAt,token")
      throw new TypeError("runtime identity response has an unsupported shape");
    const token = nonEmptyString(value.token, "runtime identity token missing");
    const expiresAt = nonEmptyString(value.expiresAt, "runtime identity expiry missing");
    const expiryMs = Date.parse(expiresAt);
    const now = Date.now();
    if (
      token.length > 8192 ||
      /[\r\n]/u.test(token) ||
      !Number.isFinite(expiryMs) ||
      expiryMs <= now ||
      expiryMs > now + 300_000
    )
      throw new TypeError("runtime identity response is invalid or outside its lifetime");
    return { token, expiresAt };
  }

  async recordRuntimeHealth(
    input: RuntimeHealthObservationInput,
  ): Promise<{ readonly recorded: true }> {
    const value = object(
      await this.post("/runtime-health", withoutSignal(input), input.signal),
      "invalid runtime health response",
    );
    if (Object.keys(value).length !== 1 || value.recorded !== true)
      throw new TypeError("runtime health observation was not recorded");
    return { recorded: true };
  }

  async releaseRuntime(input: {
    readonly reservationId: string;
    readonly operationId: string;
    readonly workerId: string;
    readonly leaseToken: string;
    readonly leaseEpoch: number;
    readonly expectedReservationRuntimeEpoch: number;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    await this.post("/reservations/release", withoutSignal(input), input.signal);
  }

  report(input: {
    readonly operationId: string;
    readonly workerId: string;
    readonly leaseToken: string;
    readonly leaseEpoch: number;
    readonly sequence: number;
    readonly observation: ProvisionerObservation | null;
    readonly terminal?: ProvisionerTerminal | null;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly operation: ProvisionerOperationRecord;
    readonly applied: boolean;
    readonly duplicate: boolean;
  }> {
    return this.post("/report", withoutSignal(input), input.signal).then((result) => {
      const value = object(result, "invalid report response");
      const operation = parseOperation(value.operation);
      assertOperationResponse(operation, input);
      if (typeof value.applied !== "boolean" || typeof value.duplicate !== "boolean") {
        throw new TypeError("invalid report result flags");
      }
      return { operation, applied: value.applied, duplicate: value.duplicate };
    });
  }

  private post(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.request("POST", path, body, signal);
  }

  private get(path: string, signal?: AbortSignal): Promise<unknown> {
    return this.request("GET", path, undefined, signal);
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const requestSignal =
      signal === undefined
        ? AbortSignal.timeout(this.timeoutMs)
        : AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]);
    let response: Response;
    try {
      response = await this.fetchImplementation(`${this.baseUrl}${SERVICE_PATH}${path}`, {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.options.credential}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        cache: "no-store",
        signal: requestSignal,
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      throw new OperationServiceHttpError("operation_service_unavailable", 0, true);
    }
    const text = await readBounded(response, MAX_RESPONSE_BYTES);
    let payload: unknown;
    try {
      payload = text.length === 0 ? null : (JSON.parse(text) as unknown);
    } catch {
      throw new OperationServiceHttpError(
        "operation_service_invalid_response",
        response.status,
        response.status >= 500,
      );
    }
    if (!response.ok) {
      const envelope =
        typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
      const error =
        typeof envelope.error === "object" &&
        envelope.error !== null &&
        !Array.isArray(envelope.error)
          ? (envelope.error as Record<string, unknown>)
          : envelope;
      const code =
        typeof error.code === "string" && /^[A-Z0-9_]{1,64}$/u.test(error.code)
          ? error.code.toLowerCase()
          : `http_${response.status}`;
      throw new OperationServiceHttpError(
        code,
        response.status,
        response.status === 408 ||
          response.status === 425 ||
          response.status === 429 ||
          response.status >= 500,
      );
    }
    return payload;
  }
}

function withoutSignal<T extends { readonly signal?: AbortSignal }>(input: T): Omit<T, "signal"> {
  return Object.fromEntries(Object.entries(input).filter(([key]) => key !== "signal")) as Omit<
    T,
    "signal"
  >;
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new OperationServiceHttpError(
        "operation_service_response_too_large",
        response.status,
        false,
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
