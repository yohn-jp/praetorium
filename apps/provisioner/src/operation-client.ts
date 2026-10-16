import type { LifecyclePhase } from "@praetorium/application/lifecycle";

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
  readonly deploymentRevision: ProvisionerDeploymentRevision | null;
}

export interface ProvisionerObservation {
  readonly operationId: string;
  readonly instanceId: string;
  readonly repositoryId: number;
  readonly generation: number;
  readonly runtimeEpoch: number;
  readonly sequence: number;
  readonly observedState: ProvisionerObservedState;
  readonly observedArtifactDigest: string | null;
  readonly observedRevisionId: string | null;
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

export interface HttpOperationServiceOptions {
  readonly baseUrl: string;
  readonly credential: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface ProvisionerOperationService {
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
  recordCapacitySnapshot(input: CapacitySnapshotInput & { readonly signal?: AbortSignal }): Promise<number | null>;
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
    readonly observation: ProvisionerObservation;
    readonly terminal?: ProvisionerTerminal | null;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly operation: ProvisionerOperationRecord; readonly applied: boolean; readonly duplicate: boolean }>;
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
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TypeError(message);
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
  "accepted", "waiting-for-artifact", "waiting-for-capacity", "capacity-reserved",
  "quiescing-old", "old-quiesced", "stopping-old", "old-writer-absent",
  "starting-target", "target-ready", "route-activated", "complete", "blocked", "failed", "unknown",
];
const operationKinds: readonly ProvisionerOperationKind[] = ["start", "stop", "redeploy", "update"];
const operationStatuses: readonly ProvisionerOperationStatus[] = ["pending", "claimed", "running", "succeeded", "failed", "blocked"];
const observedStates: readonly ProvisionerObservedState[] = ["absent", "starting", "ready", "stopping", "stopped", "failed", "unknown"];
const reservationStatuses: readonly ProvisionerReservation["status"][] = ["pending", "reserved", "allocated", "released", "blocked"];

function parseResources(input: unknown, message: string): RuntimeResources {
  const value = object(input, message);
  return {
    cpuMilli: safeInteger(value.cpuMilli, message),
    memoryMiB: safeInteger(value.memoryMiB, message),
    ephemeralStorageMiB: safeInteger(value.ephemeralStorageMiB, message),
  };
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
    checkpoint: operation.checkpoint === null ? null : object(operation.checkpoint, "invalid operation checkpoint"),
    clusterId: nullableString(operation.clusterId, "operation cluster ID invalid"),
    reservationId: nullableString(operation.reservationId, "operation reservation ID invalid"),
    deploymentRevisionId: nullableString(operation.deploymentRevisionId, "operation deployment revision ID invalid"),
    buildId: nullableString(operation.buildId, "operation build ID invalid"),
    prerequisiteBuildId: nullableString(operation.prerequisiteBuildId, "operation prerequisite build ID invalid"),
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
    capacitySnapshotEpoch: safeInteger(value.capacitySnapshotEpoch, "reservation capacity epoch missing"),
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
    nodeResourceVersion: nonEmptyString(value.nodeResourceVersion, "capacity node resource version missing"),
    podResourceVersion: nonEmptyString(value.podResourceVersion, "capacity Pod resource version missing"),
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
    representedReservationIds: value.representedReservationIds.map((item) => nonEmptyString(item, "invalid represented reservation ID")),
    reservations: value.reservations.map(parseReservation),
  };
}

function parseOperationEnvelope(input: unknown): { readonly operation: ProvisionerOperationRecord } {
  const value = object(input, "invalid operation response");
  return { operation: parseOperation(value.operation) };
}

function assertOperationResponse(
  operation: ProvisionerOperationRecord,
  expected: { readonly operationId: string; readonly leaseEpoch: number; readonly leaseToken: string },
): void {
  if (
    operation.id !== expected.operationId ||
    operation.leaseEpoch !== expected.leaseEpoch ||
    operation.leaseToken !== expected.leaseToken
  ) throw new TypeError("Operation Service returned a mismatched lease response");
}

function parseReservationOrNull(input: unknown): ProvisionerReservation | null {
  if (input === null) return null;
  const envelope = object(input, "invalid reservation response");
  return parseReservation("reservation" in envelope ? envelope.reservation : envelope);
}

function parseClaim(input: unknown): ClaimedProvisionerOperation | null {
  const response = object(input, "invalid claim response");
  if (response.operation === null) return null;
  const operation = object(response.operation, "invalid claimed operation");
  const snapshot = object(response.snapshot, "invalid claimed snapshot");
  const binding = object(snapshot.binding, "invalid repository binding");
  const instance = object(snapshot.instance, "invalid instance snapshot");
  const reservation = response.reservation === null
    ? null
    : object(response.reservation, "invalid runtime reservation");
  const deploymentRevision = response.deploymentRevision === null
    ? null
    : object(response.deploymentRevision, "invalid deployment revision");

  const parsedOperation = parseOperation(operation);
  const parsedBinding: ProvisionerBindingSnapshot = {
    repositoryId: positiveInteger(binding.repositoryId, "binding repository missing"),
    instanceId: nonEmptyString(binding.instanceId, "binding instance missing"),
    installationId: positiveInteger(binding.installationId, "binding installation missing"),
    owner: nonEmptyString(binding.owner, "binding owner missing"),
    name: nonEmptyString(binding.name, "binding name missing"),
    authorizationRevision: safeInteger(binding.authorizationRevision, "binding authorization missing"),
    bindingEpoch: positiveInteger(binding.bindingEpoch, "binding epoch missing"),
    suspended: binding.suspended === true,
  };
  const parsedInstance: ProvisionerInstanceSnapshot = {
    instanceId: nonEmptyString(instance.instanceId, "instance ID missing"),
    repositoryId: positiveInteger(instance.repositoryId, "instance repository missing"),
    generation: positiveInteger(instance.generation, "instance generation missing"),
    runtimeEpoch: positiveInteger(instance.runtimeEpoch, "instance epoch missing"),
    observedGeneration: instance.observedGeneration === null ? null : safeInteger(instance.observedGeneration, "observed generation invalid"),
    desiredState: enumValue(instance.desiredState, ["running", "stopped"], "instance desired state invalid"),
    observedState: enumValue(instance.observedState, observedStates, "instance observed state invalid"),
    observedRuntimeEpoch: instance.observedRuntimeEpoch === null ? null : safeInteger(instance.observedRuntimeEpoch, "observed runtime epoch invalid"),
    observedRevisionId: instance.observedRevisionId === null ? null : nonEmptyString(instance.observedRevisionId, "observed revision ID invalid"),
    desiredRevisionId: instance.desiredRevisionId === null ? null : nonEmptyString(instance.desiredRevisionId, "desired revision ID invalid"),
    currentArtifactDigest: instance.currentArtifactDigest === null ? null : nonEmptyString(instance.currentArtifactDigest, "current artifact digest invalid"),
    desiredArtifactDigest: instance.desiredArtifactDigest === null ? null : nonEmptyString(instance.desiredArtifactDigest, "desired artifact digest invalid"),
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
  ) throw new TypeError("claimed operation identity is inconsistent");

  return {
    operation: parsedOperation,
    snapshot: {
      binding: parsedBinding,
      instance: parsedInstance,
    },
    reservation: reservation === null ? null : parseReservation(reservation),
    deploymentRevision: deploymentRevision === null ? null : {
      revisionId: nonEmptyString(deploymentRevision.revisionId, "deployment revision ID missing"),
      instanceId: nonEmptyString(deploymentRevision.instanceId, "deployment revision instance missing"),
      repositoryId: positiveInteger(deploymentRevision.repositoryId, "deployment revision repository missing"),
      generation: positiveInteger(deploymentRevision.generation, "deployment revision generation missing"),
      buildKey: nonEmptyString(deploymentRevision.buildKey, "deployment revision build key missing"),
      buildId: nonEmptyString(deploymentRevision.buildId, "deployment revision build ID missing"),
      selection: object(deploymentRevision.selection, "deployment revision selection invalid"),
      resources: parseResources(deploymentRevision.resources, "deployment revision resources invalid"),
      artifactDigest: deploymentRevision.artifactDigest === null ? null : nonEmptyString(deploymentRevision.artifactDigest, "deployment revision artifact digest invalid"),
      status: enumValue(deploymentRevision.status, ["building", "admitted", "failed", "superseded"], "deployment revision status invalid"),
    },
  };
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname))) {
    throw new TypeError("Control Plane URL must use HTTPS outside localhost");
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new TypeError("Control Plane URL cannot contain credentials, query, or fragment");
  }
  return value.replace(/\/+$/u, "");
}

export class OperationServiceHttpClient implements ProvisionerOperationService {
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
    if (/[\r\n]/u.test(options.credential)) throw new TypeError("Operation Service credential is invalid");
  }

  async claimNext(input: {
    readonly workerId: string;
    readonly clusterId: string;
    readonly leaseSeconds: number;
    readonly signal?: AbortSignal;
  }): Promise<ClaimedProvisionerOperation | null> {
    const result = await this.post("/claim", {
      workerId: input.workerId,
      clusterId: input.clusterId,
      leaseSeconds: input.leaseSeconds,
    }, input.signal);
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
      return { leaseExpiresAt: positiveInteger(value.leaseExpiresAt, "lease expiry response invalid"), operation };
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
    return this.post("/reservations/current", withoutSignal(input), input.signal).then(parseReservationSnapshot);
  }

  async recordCapacitySnapshot(input: CapacitySnapshotInput & { readonly signal?: AbortSignal }): Promise<number | null> {
    const response = object(await this.post("/capacity/record", withoutSignal(input), input.signal), "invalid capacity record response");
    if (response.capacityEpoch === null) return null;
    return positiveInteger(response.capacityEpoch, "capacity epoch response invalid");
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
    readonly observation: ProvisionerObservation;
    readonly terminal?: ProvisionerTerminal | null;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly operation: ProvisionerOperationRecord; readonly applied: boolean; readonly duplicate: boolean }> {
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

  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const requestSignal = signal === undefined
      ? AbortSignal.timeout(this.timeoutMs)
      : AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]);
    let response: Response;
    try {
      response = await this.fetchImplementation(`${this.baseUrl}${SERVICE_PATH}${path}`, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.options.credential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
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
      payload = text.length === 0 ? null : JSON.parse(text) as unknown;
    } catch {
      throw new OperationServiceHttpError("operation_service_invalid_response", response.status, response.status >= 500);
    }
    if (!response.ok) {
      const envelope = typeof payload === "object" && payload !== null
        ? payload as Record<string, unknown>
        : {};
      const error = typeof envelope.error === "object" && envelope.error !== null && !Array.isArray(envelope.error)
        ? envelope.error as Record<string, unknown>
        : envelope;
      const code = typeof error.code === "string" && /^[A-Z0-9_]{1,64}$/u.test(error.code)
        ? error.code.toLowerCase()
        : `http_${response.status}`;
      throw new OperationServiceHttpError(code, response.status, response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500);
    }
    return payload;
  }
}

function withoutSignal<T extends { readonly signal?: AbortSignal }>(input: T): Omit<T, "signal"> {
  return Object.fromEntries(Object.entries(input).filter(([key]) => key !== "signal")) as Omit<T, "signal">;
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
      throw new OperationServiceHttpError("operation_service_response_too_large", response.status, false);
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
