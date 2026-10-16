import { RuntimeProviderError } from "../errors.js";
import {
  CLUSTER_LABEL_KEY,
  GENERATION_LABEL_KEY,
  INSTANCE_LABEL_KEY,
  OWNERSHIP_LABEL_KEY,
  PLATFORM_LABEL_KEY,
  REPOSITORY_LABEL_KEY,
  RUNTIME_EPOCH_LABEL_KEY,
} from "../labels.js";
import { parseRuntimeInstanceId, parseRuntimeRepositoryId } from "../types.js";
import type { RuntimeCapacity, RuntimeNodeCapacity, RuntimeResourceQuantities } from "../types.js";
import type { KubernetesApi } from "./client.js";
import type { KubernetesListResult } from "./types.js";

export interface KubernetesCapacityReservation {
  readonly reservationId: string;
  readonly clusterId: string | null;
  readonly instanceId: string;
  readonly repositoryId: number;
  readonly runtimeEpoch: number;
  readonly generation: number;
  readonly resources: RuntimeResourceQuantities;
  readonly status: "pending" | "reserved" | "allocated" | "released" | "blocked";
}

export interface KubernetesCapacityReservationSnapshot {
  readonly clusterId: string;
  readonly capacityEpoch: number;
  readonly observedAt: number;
  readonly complete: boolean;
  readonly capacity: {
    readonly allocatable: RuntimeResourceQuantities;
    readonly requested: RuntimeResourceQuantities;
    readonly nodeResourceVersion: string;
    readonly podResourceVersion: string;
  } | null;
  readonly representedReservationIds: readonly string[];
  readonly reservations: readonly KubernetesCapacityReservation[];
}

/** Structural adapter for OperationService; the plugin never stores leases. */
export interface KubernetesCapacityReservationSource {
  currentReservations(clusterId: string): Promise<KubernetesCapacityReservationSnapshot>;
  recordCapacitySnapshot(input: {
    readonly clusterId: string;
    readonly observedAt: number;
    readonly complete: boolean;
    readonly capacity: {
      readonly allocatable: RuntimeResourceQuantities;
      readonly requested: RuntimeResourceQuantities;
      readonly nodeResourceVersion: string;
      readonly podResourceVersion: string;
    };
    readonly representedReservationIds: readonly string[];
  }): Promise<number | null>;
}

export interface KubernetesCapacityOptions {
  readonly clusterId: string;
  readonly api: KubernetesApi;
  readonly reservations: KubernetesCapacityReservationSource;
  readonly now: () => number;
  readonly maxAgeMs: number;
}

interface IdentityKey {
  readonly clusterId: string;
  readonly instanceId: string;
  readonly repositoryId: number;
  readonly runtimeEpoch: number;
  readonly generation: number;
}

interface NodeSnapshot {
  readonly nodeName: string;
  readonly allocatable: RuntimeResourceQuantities;
  readonly schedulable: boolean;
}

interface KubernetesListSnapshot {
  readonly items: readonly unknown[];
  readonly resourceVersion: string;
}

const ZERO: RuntimeResourceQuantities = {
  cpuMilli: 0,
  memoryMiB: 0,
  ephemeralStorageMiB: 0,
};

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function capacityError(message: string): RuntimeProviderError {
  return new RuntimeProviderError("capacity", message, "retryable");
}

function invalidSnapshot(message: string): RuntimeProviderError {
  return new RuntimeProviderError("invalid_response", message, "retryable");
}

function requiredString(value: unknown, description: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw invalidSnapshot(`${description} is missing`);
  return value;
}

function parseCpuMilli(value: unknown, roundUp: boolean): number {
  if (typeof value !== "string") throw invalidSnapshot("Kubernetes CPU quantity is missing");
  const match = /^(\d+(?:\.\d+)?)(n|u|m)?$/.exec(value);
  if (match === null) throw invalidSnapshot("Kubernetes CPU quantity is invalid");
  const amount = Number(match[1]);
  const multiplier =
    match[2] === "n" ? 1e-6 : match[2] === "u" ? 1e-3 : match[2] === "m" ? 1 : 1000;
  const exactMilli = amount * multiplier;
  const milli = roundUp ? Math.ceil(exactMilli) : Math.floor(exactMilli);
  if (!Number.isSafeInteger(milli) || milli < 0)
    throw invalidSnapshot("Kubernetes CPU quantity is out of range");
  return milli;
}

function parseMiB(value: unknown, kind: "memory" | "ephemeral storage", roundUp: boolean): number {
  if (typeof value !== "string") throw invalidSnapshot(`Kubernetes ${kind} quantity is missing`);
  const match = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|Pi|Ei|K|M|G|T|P|E|m)?$/.exec(value);
  if (match === null) throw invalidSnapshot(`Kubernetes ${kind} quantity is invalid`);
  const amount = Number(match[1]);
  const unit = match[2] ?? "";
  const bytes =
    unit === "Ki"
      ? amount * 1024
      : unit === "Mi"
        ? amount * 1024 ** 2
        : unit === "Gi"
          ? amount * 1024 ** 3
          : unit === "Ti"
            ? amount * 1024 ** 4
            : unit === "Pi"
              ? amount * 1024 ** 5
              : unit === "Ei"
                ? amount * 1024 ** 6
                : unit === "K"
                  ? amount * 1_000
                  : unit === "M"
                    ? amount * 1_000 ** 2
                    : unit === "G"
                      ? amount * 1_000 ** 3
                      : unit === "T"
                        ? amount * 1_000 ** 4
                        : unit === "P"
                          ? amount * 1_000 ** 5
                          : unit === "E"
                            ? amount * 1_000 ** 6
                            : unit === "m"
                              ? amount / 1_000
                              : amount;
  const exactMiB = bytes / 1024 ** 2;
  const mib = roundUp ? Math.ceil(exactMiB) : Math.floor(exactMiB);
  if (!Number.isSafeInteger(mib) || mib < 0)
    throw invalidSnapshot(`Kubernetes ${kind} quantity is out of range`);
  return mib;
}

function parseResourceQuantities(
  value: unknown,
  required: boolean,
  roundRequestsUp = false,
): RuntimeResourceQuantities {
  const resources = record(value);
  if (resources === undefined) {
    if (!required) return ZERO;
    throw invalidSnapshot("Kubernetes resource quantities are missing");
  }
  const cpu = resources.cpu;
  const memory = resources.memory;
  const ephemeralStorage = resources["ephemeral-storage"];
  if (required && (cpu === undefined || memory === undefined || ephemeralStorage === undefined)) {
    throw invalidSnapshot("Kubernetes CPU, memory, and ephemeral-storage quantities are required");
  }
  if (!required && cpu === undefined && memory === undefined && ephemeralStorage === undefined) {
    return ZERO;
  }
  return {
    cpuMilli: cpu === undefined ? 0 : parseCpuMilli(cpu, roundRequestsUp),
    memoryMiB: memory === undefined ? 0 : parseMiB(memory, "memory", roundRequestsUp),
    ephemeralStorageMiB:
      ephemeralStorage === undefined
        ? 0
        : parseMiB(ephemeralStorage, "ephemeral storage", roundRequestsUp),
  };
}

function plus(
  left: RuntimeResourceQuantities,
  right: RuntimeResourceQuantities,
): RuntimeResourceQuantities {
  const result = {
    cpuMilli: left.cpuMilli + right.cpuMilli,
    memoryMiB: left.memoryMiB + right.memoryMiB,
    ephemeralStorageMiB: left.ephemeralStorageMiB + right.ephemeralStorageMiB,
  };
  if (Object.values(result).some((quantity) => !Number.isSafeInteger(quantity))) {
    throw invalidSnapshot("Kubernetes aggregate resource quantity overflowed");
  }
  return result;
}

function maxResources(
  left: RuntimeResourceQuantities,
  right: RuntimeResourceQuantities,
): RuntimeResourceQuantities {
  return {
    cpuMilli: Math.max(left.cpuMilli, right.cpuMilli),
    memoryMiB: Math.max(left.memoryMiB, right.memoryMiB),
    ephemeralStorageMiB: Math.max(left.ephemeralStorageMiB, right.ephemeralStorageMiB),
  };
}

function subtract(
  left: RuntimeResourceQuantities,
  right: RuntimeResourceQuantities,
): RuntimeResourceQuantities {
  return {
    cpuMilli: Math.max(0, left.cpuMilli - right.cpuMilli),
    memoryMiB: Math.max(0, left.memoryMiB - right.memoryMiB),
    ephemeralStorageMiB: Math.max(0, left.ephemeralStorageMiB - right.ephemeralStorageMiB),
  };
}

function nodeSnapshot(value: unknown): NodeSnapshot {
  const metadata = record(record(value)?.metadata);
  const spec = record(record(value)?.spec);
  const status = record(record(value)?.status);
  const nodeName = requiredString(metadata?.name, "Kubernetes node name");
  const allocatable = parseResourceQuantities(status?.allocatable, true);
  const conditions = Array.isArray(status?.conditions) ? status.conditions : [];
  const ready = conditions.some((item) => {
    const condition = record(item);
    return condition?.type === "Ready" && condition.status === "True";
  });
  const taints = Array.isArray(spec?.taints) ? spec.taints : [];
  const unschedulable = spec?.unschedulable === true;
  const blockedByTaint = taints.some((item) => {
    const taint = record(item);
    return taint?.effect === "NoSchedule" || taint?.effect === "NoExecute";
  });
  return { nodeName, allocatable, schedulable: ready && !unschedulable && !blockedByTaint };
}

function podRequest(value: unknown): RuntimeResourceQuantities {
  const pod = record(value);
  const spec = record(pod?.spec);
  if (spec === undefined || !Array.isArray(spec.containers) || spec.containers.length === 0) {
    throw invalidSnapshot("Kubernetes Pod container requests are missing");
  }
  let regular = ZERO;
  for (const item of spec.containers) {
    const container = record(item);
    if (container === undefined) throw invalidSnapshot("Kubernetes Pod container is invalid");
    regular = plus(
      regular,
      parseResourceQuantities(record(container.resources)?.requests, false, true),
    );
  }
  let initMaximum = ZERO;
  const initContainers = Array.isArray(spec.initContainers) ? spec.initContainers : [];
  for (const item of initContainers) {
    const container = record(item);
    if (container === undefined) throw invalidSnapshot("Kubernetes init container is invalid");
    if (container.restartPolicy === "Always") {
      throw capacityError("restartable init containers are not supported in capacity accounting");
    }
    initMaximum = maxResources(
      initMaximum,
      parseResourceQuantities(record(container.resources)?.requests, false, true),
    );
  }
  let requests = maxResources(regular, initMaximum);
  const overhead = spec.overhead;
  if (overhead !== undefined)
    requests = plus(requests, parseResourceQuantities(overhead, false, true));
  return requests;
}

function activePod(value: unknown): boolean {
  const pod = record(value);
  const metadata = record(pod?.metadata);
  const phase = record(pod?.status)?.phase;
  if (typeof metadata?.deletionTimestamp === "string") return true;
  return phase !== "Succeeded" && phase !== "Failed";
}

function identityKey(identity: IdentityKey): string {
  return [
    identity.clusterId,
    identity.repositoryId,
    identity.instanceId,
    identity.runtimeEpoch,
    identity.generation,
  ].join(":");
}

function podIdentity(value: unknown, clusterId: string): IdentityKey | undefined {
  const labels = record(record(value)?.metadata)?.labels;
  const managed = record(labels);
  if (managed?.[PLATFORM_LABEL_KEY] !== "arcadia-platform" || managed[OWNERSHIP_LABEL_KEY] !== "v1")
    return undefined;
  try {
    const instanceId = parseRuntimeInstanceId(
      requiredString(managed[INSTANCE_LABEL_KEY], "runtime Pod instance label"),
    );
    const repositoryText = requiredString(
      managed[REPOSITORY_LABEL_KEY],
      "runtime Pod repository label",
    );
    const repositoryId = parseRuntimeRepositoryId(Number(repositoryText));
    const runtimeEpochText = requiredString(
      managed[RUNTIME_EPOCH_LABEL_KEY],
      "runtime Pod epoch label",
    );
    const generationText = requiredString(
      managed[GENERATION_LABEL_KEY],
      "runtime Pod generation label",
    );
    const runtimeEpoch = Number(runtimeEpochText);
    const generation = Number(generationText);
    if (
      managed[CLUSTER_LABEL_KEY] !== clusterId ||
      String(repositoryId) !== repositoryText ||
      !/^[1-9]\d*$/.test(runtimeEpochText) ||
      !/^[1-9]\d*$/.test(generationText) ||
      !Number.isSafeInteger(runtimeEpoch) ||
      runtimeEpoch < 1 ||
      !Number.isSafeInteger(generation) ||
      generation < 1
    )
      throw invalidSnapshot("managed Pod runtime identity is invalid");
    return { clusterId, instanceId, repositoryId, runtimeEpoch, generation };
  } catch (error) {
    if (error instanceof RuntimeProviderError) throw error;
    throw invalidSnapshot("managed Pod runtime identity is invalid");
  }
}

async function collectAll(
  api: KubernetesApi,
  kind: "Node" | "Pod",
  signal?: AbortSignal,
): Promise<KubernetesListSnapshot> {
  const items: unknown[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let resourceVersion: string | null = null;
  for (let pageCount = 0; pageCount < 1_000; pageCount += 1) {
    let page: KubernetesListResult;
    try {
      page = await api.list(kind, "", "", cursor, signal);
    } catch {
      throw capacityError(`authoritative Kubernetes ${kind} observation is unavailable`);
    }
    if (
      page.resourceVersion === null ||
      (resourceVersion !== null && page.resourceVersion !== resourceVersion)
    ) {
      throw capacityError(`Kubernetes ${kind} pages are not a complete consistent snapshot`);
    }
    resourceVersion = page.resourceVersion;
    items.push(...page.items);
    if (items.length > 100_000)
      throw capacityError(`Kubernetes ${kind} observation exceeds its bound`);
    const next = page.nextCursor;
    if (next === null) return { items, resourceVersion };
    if (seenCursors.has(next)) throw capacityError(`Kubernetes ${kind} pagination did not advance`);
    seenCursors.add(next);
    cursor = next;
  }
  throw capacityError(`Kubernetes ${kind} observation exceeded its page bound`);
}

function validateReservationSnapshot(
  snapshot: KubernetesCapacityReservationSnapshot,
  clusterId: string,
): void {
  if (
    snapshot.clusterId !== clusterId ||
    !Number.isSafeInteger(snapshot.observedAt) ||
    !Number.isSafeInteger(snapshot.capacityEpoch) ||
    snapshot.capacityEpoch < 0 ||
    !Array.isArray(snapshot.representedReservationIds) ||
    !Array.isArray(snapshot.reservations)
  ) {
    throw capacityError("reservation snapshot is not authoritative for this cluster");
  }
  if (snapshot.capacity !== null) {
    const capacity = record(snapshot.capacity);
    const allocatable = record(capacity?.allocatable);
    const requested = record(capacity?.requested);
    if (
      allocatable === undefined ||
      requested === undefined ||
      typeof capacity?.nodeResourceVersion !== "string" ||
      capacity.nodeResourceVersion.length === 0 ||
      typeof capacity?.podResourceVersion !== "string" ||
      capacity.podResourceVersion.length === 0
    ) {
      throw invalidSnapshot("persisted capacity resource detail is invalid");
    }
    for (const quantity of [...Object.values(allocatable), ...Object.values(requested)]) {
      if (typeof quantity !== "number" || !Number.isSafeInteger(quantity) || quantity < 0) {
        throw invalidSnapshot("persisted capacity resource detail is invalid");
      }
    }
  }
  for (const reservation of snapshot.reservations) {
    if (
      reservation.status === "released" ||
      reservation.status === "blocked" ||
      reservation.status === "pending"
    )
      continue;
    if (reservation.status !== "reserved" && reservation.status !== "allocated") {
      throw invalidSnapshot("capacity reservation state is invalid");
    }
    if (
      reservation.reservationId.length === 0 ||
      reservation.clusterId !== clusterId ||
      !Number.isSafeInteger(reservation.repositoryId) ||
      reservation.repositoryId < 1 ||
      !Number.isSafeInteger(reservation.runtimeEpoch) ||
      reservation.runtimeEpoch < 1 ||
      !Number.isSafeInteger(reservation.generation) ||
      reservation.generation < 1 ||
      !Number.isSafeInteger(reservation.resources.cpuMilli) ||
      reservation.resources.cpuMilli < 1 ||
      !Number.isSafeInteger(reservation.resources.memoryMiB) ||
      reservation.resources.memoryMiB < 1 ||
      !Number.isSafeInteger(reservation.resources.ephemeralStorageMiB) ||
      reservation.resources.ephemeralStorageMiB < 1
    )
      throw invalidSnapshot("capacity reservation identity or size is invalid");
    try {
      parseRuntimeInstanceId(reservation.instanceId);
    } catch {
      throw invalidSnapshot("capacity reservation instance id is invalid");
    }
  }
}

export async function readKubernetesCapacity(
  options: KubernetesCapacityOptions,
  signal?: AbortSignal,
): Promise<RuntimeCapacity> {
  const startedAt = options.now();
  const [nodeList, podList, reservationSnapshot] = await Promise.all([
    collectAll(options.api, "Node", signal),
    collectAll(options.api, "Pod", signal),
    options.reservations.currentReservations(options.clusterId).catch(() => {
      throw capacityError("authoritative resource reservations are unavailable");
    }),
  ]);
  const observedAt = options.now();
  if (observedAt < startedAt || observedAt - startedAt > options.maxAgeMs) {
    throw capacityError("Kubernetes capacity observation is stale");
  }
  validateReservationSnapshot(reservationSnapshot, options.clusterId);

  const nodes = nodeList.items.map(nodeSnapshot);
  if (nodes.length === 0)
    throw capacityError("Kubernetes cluster has no node capacity observations");
  if (new Set(nodes.map((node) => node.nodeName)).size !== nodes.length) {
    throw invalidSnapshot("Kubernetes node observation contains duplicate nodes");
  }
  const schedulable = nodes.filter((node) => node.schedulable);
  const allocatable = schedulable.reduce((sum, node) => plus(sum, node.allocatable), ZERO);
  const schedulableByName = new Map(schedulable.map((node) => [node.nodeName, node]));
  const requestedByNode = new Map<string, RuntimeResourceQuantities>();
  const activeReservations = reservationSnapshot.reservations.filter(
    (reservation) => reservation.status === "reserved" || reservation.status === "allocated",
  );
  const reservationsByIdentity = new Map<string, KubernetesCapacityReservation>();
  for (const reservation of activeReservations) {
    const key = identityKey({
      clusterId: options.clusterId,
      repositoryId: reservation.repositoryId,
      instanceId: reservation.instanceId,
      runtimeEpoch: reservation.runtimeEpoch,
      generation: reservation.generation,
    });
    if (reservationsByIdentity.has(key)) {
      throw capacityError("multiple active capacity reservations share one runtime identity");
    }
    reservationsByIdentity.set(key, reservation);
  }
  const matchedReservationIds = new Set<string>();
  const matchedPodIdentities = new Set<string>();
  const activeInstances = new Set<string>();
  for (const pod of podList.items) {
    if (!activePod(pod)) continue;
    const spec = record(record(pod)?.spec);
    const nodeName = typeof spec?.nodeName === "string" ? spec.nodeName : "";
    if (nodeName.length === 0) {
      throw capacityError("an active unscheduled Pod makes capacity unknown");
    }
    const identity = podIdentity(pod, options.clusterId);
    if (identity !== undefined) {
      const key = identityKey(identity);
      if (matchedPodIdentities.has(key)) {
        throw capacityError("multiple active writer Pods share one runtime identity");
      }
      matchedPodIdentities.add(key);
      const reservation = reservationsByIdentity.get(key);
      if (reservation !== undefined) {
        const request = podRequest(pod);
        if (
          request.cpuMilli !== reservation.resources.cpuMilli ||
          request.memoryMiB !== reservation.resources.memoryMiB ||
          request.ephemeralStorageMiB !== reservation.resources.ephemeralStorageMiB
        ) {
          throw capacityError("runtime Pod requests do not match its capacity reservation");
        }
        matchedReservationIds.add(reservation.reservationId);
      }
      activeInstances.add(
        [identity.clusterId, identity.repositoryId, identity.instanceId].join(":"),
      );
    }
    if (!schedulableByName.has(nodeName)) continue;
    const requests = podRequest(pod);
    requestedByNode.set(nodeName, plus(requestedByNode.get(nodeName) ?? ZERO, requests));
  }
  const requested = [...requestedByNode.values()].reduce((sum, item) => plus(sum, item), ZERO);

  const recordedEpoch = await options.reservations
    .recordCapacitySnapshot({
      clusterId: options.clusterId,
      observedAt,
      complete: true,
      capacity: {
        allocatable,
        requested,
        nodeResourceVersion: nodeList.resourceVersion,
        podResourceVersion: podList.resourceVersion,
      },
      representedReservationIds: [...matchedReservationIds].sort(),
    })
    .catch(() => {
      throw capacityError("authoritative capacity snapshot could not be recorded");
    });
  if (recordedEpoch === null || !Number.isSafeInteger(recordedEpoch) || recordedEpoch < 1) {
    throw capacityError("authoritative capacity snapshot was not committed");
  }
  const committedSnapshot = await options.reservations
    .currentReservations(options.clusterId)
    .catch(() => {
      throw capacityError("committed capacity snapshot could not be read");
    });
  const committedReadAt = options.now();
  validateReservationSnapshot(committedSnapshot, options.clusterId);
  if (
    committedReadAt < committedSnapshot.observedAt ||
    committedReadAt - committedSnapshot.observedAt > options.maxAgeMs ||
    committedSnapshot.capacityEpoch !== recordedEpoch ||
    committedSnapshot.observedAt !== observedAt ||
    committedSnapshot.complete !== true ||
    committedSnapshot.capacity === null ||
    committedSnapshot.capacity.nodeResourceVersion !== nodeList.resourceVersion ||
    committedSnapshot.capacity.podResourceVersion !== podList.resourceVersion ||
    committedSnapshot.representedReservationIds.length !== matchedReservationIds.size ||
    committedSnapshot.representedReservationIds.some((id) => !matchedReservationIds.has(id))
  ) {
    throw capacityError("persisted capacity snapshot does not match the complete live observation");
  }

  let reserved = ZERO;
  for (const reservation of committedSnapshot.reservations) {
    if (reservation.status !== "reserved" && reservation.status !== "allocated") continue;
    activeInstances.add(
      [options.clusterId, reservation.repositoryId, reservation.instanceId].join(":"),
    );
    if (reservation.status === "reserved") {
      reserved = plus(reserved, {
        cpuMilli: reservation.resources.cpuMilli,
        memoryMiB: reservation.resources.memoryMiB,
        ephemeralStorageMiB: reservation.resources.ephemeralStorageMiB,
      });
    }
  }

  const storedAllocatable = committedSnapshot.capacity.allocatable;
  const storedRequested = committedSnapshot.capacity.requested;
  if (
    storedAllocatable.cpuMilli !== allocatable.cpuMilli ||
    storedAllocatable.memoryMiB !== allocatable.memoryMiB ||
    storedAllocatable.ephemeralStorageMiB !== allocatable.ephemeralStorageMiB ||
    storedRequested.cpuMilli !== requested.cpuMilli ||
    storedRequested.memoryMiB !== requested.memoryMiB ||
    storedRequested.ephemeralStorageMiB !== requested.ephemeralStorageMiB
  ) {
    throw capacityError(
      "persisted capacity epoch no longer matches the live Kubernetes resource observation",
    );
  }

  const used = plus(requested, reserved);
  const free = subtract(allocatable, used);
  const nodeCapacity: RuntimeNodeCapacity[] = schedulable.map((node) => {
    const nodeRequested = requestedByNode.get(node.nodeName) ?? ZERO;
    return {
      nodeName: node.nodeName,
      allocatable: node.allocatable,
      requested: nodeRequested,
      available: subtract(node.allocatable, nodeRequested),
    };
  });
  return {
    observedAt,
    authoritative: true,
    capacityEpoch: committedSnapshot.capacityEpoch,
    nodeResourceVersion: nodeList.resourceVersion,
    podResourceVersion: podList.resourceVersion,
    reservationObservedAt: committedSnapshot.observedAt,
    cpuMilli: free.cpuMilli,
    memoryMiB: free.memoryMiB,
    ephemeralStorageMiB: free.ephemeralStorageMiB,
    allocatable,
    requested,
    reserved,
    activeInstances: activeInstances.size,
    nodes: nodeCapacity,
  };
}
