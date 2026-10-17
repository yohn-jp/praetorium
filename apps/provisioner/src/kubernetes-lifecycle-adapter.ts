import { createHash } from "node:crypto";
import {
  createInClusterKubernetesRuntimeProvider,
  parseRuntimeInstanceId,
  parseRuntimeReleaseId,
  parseRuntimeRepositoryId,
  type InstanceIdentity,
  type KubernetesRuntimeProvider,
  type RuntimeApplicationRequirements,
  type RuntimeEndpointActivationEvidence,
  type RuntimeInstanceSpec,
  type RuntimeObservation,
  type RuntimeResourceProfile,
  type RuntimeWriterPodIdentity,
} from "@praetorium/kubernetes";
import type { RuntimeAssignment as ScriptoriumRuntimeAssignment } from "@praetorium/contracts";
import type {
  BeforeLifecycleEffect,
  LifecycleReadinessEvidence,
  LifecycleRouteProvider,
  LifecycleRuntimeProvider,
  RuntimeAssignment,
  RuntimeReadiness,
  WriterCensus,
} from "@praetorium/application/lifecycle";
import type { ProvisionerOperationService, RuntimeResources } from "./operation-client.js";
import type { RuntimeIdentityAssignmentTransport } from "./runtime-identity.js";

const DEFAULT_CONVERGENCE_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface InClusterRuntimeOptions {
  readonly namespacePrefix: string;
  readonly clusterId: string;
  readonly ingressNamespace: string;
  readonly instanceAccessNamespace: string;
  readonly instanceAccessService: string;
  readonly controlNamespace: "praetorium-system";
  readonly controlService: "provisioner";
  readonly maximumResources: {
    readonly cpuMilli: number;
    readonly memoryMiB: number;
    readonly ephemeralStorageMiB: number;
  };
  readonly maxCapacityAgeMs: number;
  readonly convergenceTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
}

export interface RuntimeContextFence {
  readonly clusterId: string;
  readonly repositoryId: number;
  readonly generation: number;
  readonly runtimeEpoch: number;
}

function parseIdentity(assignment: RuntimeAssignment): InstanceIdentity {
  return {
    instanceId: parseRuntimeInstanceId(assignment.instanceId),
    repositoryId: parseRuntimeRepositoryId(assignment.repositoryId),
    runtimeEpoch: assignment.runtimeEpoch,
    generation: assignment.generation,
    clusterId: assignment.clusterId,
  };
}

function applicationRequirements(assignment: RuntimeAssignment): RuntimeApplicationRequirements {
  const metadata = assignment.deployment.runtimeMetadata;
  return {
    httpPort: metadata.listenerPort,
    livenessPath: metadata.livenessPath,
    readinessPath: metadata.readinessPath,
    metadataPath: metadata.metadataPath,
    shutdownPath: metadata.shutdownPath,
    shutdownTimeoutSeconds: metadata.shutdownTimeoutSeconds,
    platformControlPaths: {
      status: metadata.statusPath,
      quiesce: metadata.quiescePath,
      resume: metadata.resumePath,
    },
  };
}

function resourceProfile(assignment: RuntimeAssignment): RuntimeResourceProfile {
  return {
    id: assignment.deployment.resourceProfileId,
    request: assignment.deployment.resources,
  };
}

function runtimeSpec(
  assignment: RuntimeAssignment,
  hosted?: { readonly assignment: ScriptoriumRuntimeAssignment; readonly proof: string },
): RuntimeInstanceSpec {
  if (assignment.clusterId.length === 0 || assignment.deployment.hostname.length === 0) {
    throw new TypeError("runtime assignment lacks an admitted cluster or hostname");
  }
  const identity = parseIdentity(assignment);
  return {
    ...identity,
    release: {
      releaseId: parseRuntimeReleaseId(assignment.deployment.revisionId),
      artifactRef: assignment.deployment.artifactRef,
      imageDigest: assignment.deployment.imageDigest,
      platformManifestDigest: assignment.deployment.platformManifestDigest,
    },
    resourceProfile: resourceProfile(assignment),
    hostname: assignment.deployment.hostname,
    runtimeConfig: {},
    ...(hosted === undefined
      ? {}
      : {
          scriptoriumAssignment: hosted.assignment,
          runtimeIdentityProof: hosted.proof,
        }),
    application: applicationRequirements(assignment),
  };
}

function censusOf(observation: RuntimeObservation): WriterCensus {
  const census = observation.writerCensus;
  if (
    census.scope !== "instance-repository-all-epochs" ||
    census.complete !== true ||
    census.queriedPodCount !== census.pods.length ||
    observation.observationId.length === 0 ||
    !Number.isSafeInteger(observation.observedAt) ||
    observation.observedAt < 1
  ) {
    return {
      complete: false,
      providerObservationId: observation.observationId,
      observedAt: new Date(observation.observedAt).toISOString(),
      matchedWriterCount: census.pods.length,
      writers: [],
    };
  }
  return {
    complete: true,
    providerObservationId: observation.observationId,
    observedAt: new Date(observation.observedAt).toISOString(),
    matchedWriterCount: census.queriedPodCount,
    writers: census.pods.map((pod: RuntimeWriterPodIdentity) => ({
      runtimeEpoch: pod.runtimeEpoch,
      phase: pod.deleting ? "terminating" : "running",
      identities: [pod.uid],
    })),
  };
}

function sameIdentity(observed: RuntimeObservation, assignment: RuntimeAssignment): boolean {
  return (
    observed.identity.instanceId === assignment.instanceId &&
    observed.identity.repositoryId === assignment.repositoryId &&
    observed.identity.runtimeEpoch === assignment.runtimeEpoch &&
    observed.identity.generation === assignment.generation &&
    observed.identity.clusterId === assignment.clusterId
  );
}

function writerCensusIdentity(
  instanceId: string,
  repositoryId: number,
  fence: RuntimeContextFence,
): InstanceIdentity {
  return {
    instanceId: parseRuntimeInstanceId(instanceId),
    repositoryId: parseRuntimeRepositoryId(repositoryId),
    runtimeEpoch: fence.runtimeEpoch,
    generation: fence.generation,
    clusterId: fence.clusterId,
  };
}

function subtractFloor(left: RuntimeResources, right: RuntimeResources): RuntimeResources {
  return {
    cpuMilli: Math.max(0, left.cpuMilli - right.cpuMilli),
    memoryMiB: Math.max(0, left.memoryMiB - right.memoryMiB),
    ephemeralStorageMiB: Math.max(0, left.ephemeralStorageMiB - right.ephemeralStorageMiB),
  };
}

function fits(request: RuntimeResources, available: RuntimeResources): boolean {
  return (
    request.cpuMilli <= available.cpuMilli &&
    request.memoryMiB <= available.memoryMiB &&
    request.ephemeralStorageMiB <= available.ephemeralStorageMiB
  );
}

function sameResources(left: RuntimeResources, right: RuntimeResources): boolean {
  return (
    left.cpuMilli === right.cpuMilli &&
    left.memoryMiB === right.memoryMiB &&
    left.ephemeralStorageMiB === right.ephemeralStorageMiB
  );
}

export class KubernetesLifecycleRuntimeAdapter
  implements LifecycleRuntimeProvider, LifecycleRouteProvider
{
  readonly provider: KubernetesRuntimeProvider;
  private readonly now: () => number;
  private readonly convergenceTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private identityRenewalController: AbortController | undefined;
  private identityRenewalTask: Promise<void> | undefined;

  constructor(
    options: InClusterRuntimeOptions,
    private readonly fence: RuntimeContextFence,
    capacityReservations: {
      readonly currentReservations: (
        clusterId: string,
      ) => ReturnType<ProvisionerOperationService["currentReservations"]>;
      readonly recordCapacitySnapshot: (
        input: Parameters<ProvisionerOperationService["recordCapacitySnapshot"]>[0],
      ) => ReturnType<ProvisionerOperationService["recordCapacitySnapshot"]>;
    },
    private readonly identityTransport?: RuntimeIdentityAssignmentTransport,
  ) {
    this.now = options.now ?? Date.now;
    this.convergenceTimeoutMs = options.convergenceTimeoutMs ?? DEFAULT_CONVERGENCE_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.provider = createInClusterKubernetesRuntimeProvider({
      namespacePrefix: options.namespacePrefix,
      clusterId: options.clusterId,
      maxCapacityAgeMs: options.maxCapacityAgeMs,
      now: this.now,
      rendererOptions: {
        ingressNamespace: options.ingressNamespace,
        instanceAccessNamespace: options.instanceAccessNamespace,
        instanceAccessService: options.instanceAccessService,
        controlNamespace: options.controlNamespace,
        controlService: options.controlService,
        maximumResources: options.maximumResources,
      },
      reservations: {
        currentReservations: (clusterId) => capacityReservations.currentReservations(clusterId),
        recordCapacitySnapshot: (input) => capacityReservations.recordCapacitySnapshot(input),
      },
    });
  }

  async censusWriters(
    instanceId: string,
    repositoryId: number,
    signal?: AbortSignal,
  ): Promise<WriterCensus> {
    const identity = writerCensusIdentity(instanceId, repositoryId, this.fence);
    const observation = await this.provider.inspect(identity, signal);
    return censusOf(observation);
  }

  async stop(
    assignment: RuntimeAssignment,
    _operationId: string,
    beforeEffect: () => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    const spec = runtimeSpec(assignment);
    const deadline = this.now() + this.convergenceTimeoutMs;
    do {
      await beforeEffect();
      const result = await this.provider.ensureStopped(
        spec,
        signal ?? new AbortController().signal,
        beforeEffect,
      );
      if (result.status === "applied" || result.status === "unchanged") return;
      await pause(this.pollIntervalMs, signal);
    } while (this.now() < deadline);
    throw new Error("runtime_stop_convergence_timeout");
  }

  async start(
    assignment: RuntimeAssignment,
    _operationId: string,
    beforeEffect: () => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = this.now() + this.convergenceTimeoutMs;
    do {
      await beforeEffect();
      const spec = await this.projectedRuntimeSpec(assignment, signal);
      if (spec.release === null)
        throw new TypeError("runtime start requires an admitted immutable artifact");
      const runningSpec = { ...spec, release: spec.release };
      const result = await this.provider.ensureRunning(
        runningSpec,
        signal ?? new AbortController().signal,
        beforeEffect,
      );
      if (result.status === "applied" || result.status === "unchanged") {
        this.startIdentityRenewal(assignment, beforeEffect, signal);
        return;
      }
      await pause(this.pollIntervalMs, signal);
    } while (this.now() < deadline);
    throw new Error("runtime_start_convergence_timeout");
  }

  async readiness(assignment: RuntimeAssignment, signal?: AbortSignal): Promise<RuntimeReadiness> {
    const observation = await this.provider.inspect(parseIdentity(assignment), signal);
    const census = censusOf(observation);
    const imageIdentityVerified =
      observation.observedImageDigest === assignment.deployment.platformManifestDigest;
    const ready =
      sameIdentity(observation, assignment) &&
      census.complete &&
      observation.writerState === "running" &&
      observation.writerCensus.queriedPodCount === 1 &&
      observation.application?.ready === true &&
      imageIdentityVerified;
    return {
      status: ready ? "ready" : observation.writerState === "unknown" ? "unknown" : "not-ready",
      assignment,
      providerObservationId: observation.observationId,
      actualImageDigest: observation.observedImageDigest ?? null,
      imageIdentityVerified,
      producer: null,
      ...(ready
        ? {}
        : {
            reasonCode: imageIdentityVerified
              ? "runtime_not_ready"
              : "actual_image_digest_mismatch",
          }),
    };
  }

  /** Resolve only the provider-verified owned Service address. The Kubernetes
   * adapter rechecks the ready Pod, actual image, Service selector and port. */
  async controlEndpoint(assignment: RuntimeAssignment, signal?: AbortSignal): Promise<string> {
    const spec = runtimeSpec(assignment);
    if (spec.release === null || spec.application === undefined) {
      throw new TypeError("runtime control endpoint requires an admitted application runtime");
    }
    const runningSpec = { ...spec, release: spec.release };
    try {
      return await this.provider.getControlEndpoint(runningSpec, signal);
    } catch {
      // Producer control calls are the only consumers of this endpoint. After
      // a readiness failure, status/quiesce/resume may use the separate
      // provider-owned Service while retaining the exact live writer/image
      // census and assignment-scoped control credential.
      return this.provider.getRecoveryControlEndpoint(runningSpec, signal);
    }
  }

  async refreshRuntimeIdentity(
    assignment: RuntimeAssignment,
    beforeEffect: BeforeLifecycleEffect,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (this.identityTransport === undefined) return false;
    const identity = parseIdentity(assignment);
    const existing = await this.provider.readRuntimeIdentityProjection(identity, signal);
    if (existing === null) throw new Error("hosted_runtime_identity_projection_missing");
    const expectedAssignment = this.identityTransport.canonicalAssignment(assignment);
    if (JSON.stringify(existing.assignment) !== JSON.stringify(expectedAssignment)) {
      throw new Error("hosted_runtime_identity_assignment_mismatch");
    }
    const expiresAt = Date.parse(existing.expiresAt);
    if (!Number.isFinite(expiresAt))
      throw new Error("hosted_runtime_identity_proof_expiry_invalid");
    if (expiresAt - this.now() > 90_000) return false;

    this.identityTransport.invalidate(assignment);
    const material = await this.identityTransport.project(assignment, signal);
    const spec = runtimeSpec(assignment, material);
    if (spec.release === null)
      throw new TypeError("runtime identity refresh requires a running artifact");
    await this.provider.refreshRuntimeIdentity(
      { ...spec, release: spec.release },
      material.proof,
      signal ?? new AbortController().signal,
      beforeEffect,
    );
    return true;
  }

  private async projectedRuntimeSpec(
    assignment: RuntimeAssignment,
    signal?: AbortSignal,
  ): Promise<RuntimeInstanceSpec> {
    if (this.identityTransport === undefined) return runtimeSpec(assignment);
    const material = await this.identityTransport.project(assignment, signal);
    return runtimeSpec(assignment, material);
  }

  async close(): Promise<void> {
    this.identityRenewalController?.abort();
    await this.identityRenewalTask?.catch(() => undefined);
    this.identityRenewalController = undefined;
    this.identityRenewalTask = undefined;
  }

  private startIdentityRenewal(
    assignment: RuntimeAssignment,
    beforeEffect: BeforeLifecycleEffect,
    operationSignal?: AbortSignal,
  ): void {
    if (this.identityTransport === undefined || this.identityRenewalTask !== undefined) return;
    const controller = new AbortController();
    this.identityRenewalController = controller;
    const signal =
      operationSignal === undefined
        ? controller.signal
        : AbortSignal.any([controller.signal, operationSignal]);
    this.identityRenewalTask = (async () => {
      while (!signal.aborted) {
        await pause(30_000, signal).catch(() => undefined);
        if (signal.aborted) return;
        try {
          await this.refreshRuntimeIdentity(assignment, beforeEffect, signal);
        } catch {
          if (signal.aborted) return;
          await pause(5_000, signal).catch(() => undefined);
        }
      }
    })();
  }

  async activate(
    assignment: RuntimeAssignment,
    evidence: LifecycleReadinessEvidence,
    beforeEffect: () => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    const spec = runtimeSpec(assignment);
    if (spec.release === null)
      throw new TypeError("endpoint activation requires an admitted runtime artifact");
    const identity = parseIdentity(assignment);
    const activation: RuntimeEndpointActivationEvidence = {
      identity,
      actualImageDigest: evidence.actualImageDigest,
      applicationProbe: {
        id: evidence.applicationProbeId,
        observedAt: Date.parse(evidence.verifiedAt),
        ready: true,
      },
      authProbe: {
        id: evidence.validGrantProbeId,
        observedAt: Date.parse(evidence.verifiedAt),
        ready: true,
      },
    };
    await beforeEffect();
    const runningSpec = { ...spec, release: spec.release };
    await this.provider.activateEndpoint(
      runningSpec,
      activation,
      signal ?? new AbortController().signal,
      beforeEffect,
    );
  }

  async deactivate(
    instanceId: string,
    beforeEffect: () => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    await beforeEffect();
    await this.provider.deactivateEndpoint(
      writerCensusIdentity(instanceId, this.fenceRepositoryId, this.fence),
      signal ?? new AbortController().signal,
      beforeEffect,
    );
  }

  private get fenceRepositoryId(): number {
    return this.fence.repositoryId;
  }
}

export interface LifecycleReservationAdapterOptions {
  readonly runtime: KubernetesLifecycleRuntimeAdapter;
  readonly operations: ProvisionerOperationService;
  readonly now?: () => number;
  readonly maxCapacityAgeMs: number;
  readonly claim: {
    readonly operationId: string;
    readonly workerId: string;
    readonly leaseToken: string;
    readonly leaseEpoch: number;
    readonly runtimeEpoch: number;
    readonly clusterId: string;
    readonly generation: number;
    readonly instanceId: string;
    readonly repositoryId: number;
    readonly reservationId: string | null;
    readonly currentReservationId: string | null;
    readonly currentReservationEpoch: number | null;
  };
}

export class LifecycleReservationAdapter {
  constructor(private readonly options: LifecycleReservationAdapterOptions) {}

  async reserve(
    operationId: string,
    instanceId: string,
    deployment: RuntimeAssignment["deployment"],
    beforeEffect: () => Promise<void>,
    signal?: AbortSignal,
  ): Promise<{ readonly status: "reserved" | "pending"; readonly reservationId?: string }> {
    const { claim, operations } = this.options;
    if (operationId !== claim.operationId || instanceId !== claim.instanceId) {
      throw new TypeError("runtime reservation request differs from the claimed operation");
    }
    if (claim.reservationId !== null)
      return { status: "reserved", reservationId: claim.reservationId };
    await beforeEffect();
    let capacity;
    try {
      capacity = await this.provider.getCapacitySnapshot(signal);
    } catch (error) {
      if (isRetryableCapacity(error)) return { status: "pending" };
      throw error;
    }
    if (
      capacity.authoritative !== true ||
      capacity.capacityEpoch < 1 ||
      capacity.observedAt > (this.options.now ?? Date.now)() ||
      (this.options.now ?? Date.now)() - capacity.observedAt > this.options.maxCapacityAgeMs ||
      capacity.cpuMilli < deployment.resources.cpuMilli ||
      capacity.memoryMiB < deployment.resources.memoryMiB ||
      capacity.ephemeralStorageMiB < deployment.resources.ephemeralStorageMiB
    )
      return { status: "pending" };
    const reservationSnapshot = await operations.currentReservations({
      clusterId: claim.clusterId,
      ...(signal === undefined ? {} : { signal }),
    });
    if (
      reservationSnapshot.clusterId !== claim.clusterId ||
      reservationSnapshot.complete !== true ||
      reservationSnapshot.capacity === null ||
      reservationSnapshot.capacityEpoch !== capacity.capacityEpoch ||
      reservationSnapshot.observedAt !== capacity.reservationObservedAt ||
      reservationSnapshot.capacity.nodeResourceVersion !== capacity.nodeResourceVersion ||
      reservationSnapshot.capacity.podResourceVersion !== capacity.podResourceVersion
    )
      return { status: "pending" };
    if (
      reservationSnapshot.reservations.some(
        (reservation) =>
          reservation.status === "allocated" &&
          !reservationSnapshot.representedReservationIds.includes(reservation.reservationId),
      )
    )
      return { status: "pending" };
    const reserved = reservationSnapshot.reservations
      .filter((reservation) => reservation.status === "reserved")
      .reduce<RuntimeResources>(
        (total, reservation) => ({
          cpuMilli: total.cpuMilli + reservation.resources.cpuMilli,
          memoryMiB: total.memoryMiB + reservation.resources.memoryMiB,
          ephemeralStorageMiB:
            total.ephemeralStorageMiB + reservation.resources.ephemeralStorageMiB,
        }),
        { cpuMilli: 0, memoryMiB: 0, ephemeralStorageMiB: 0 },
      );
    if (
      Object.values(reserved).some((quantity) => !Number.isSafeInteger(quantity)) ||
      !sameResources(reserved, capacity.reserved)
    )
      return { status: "pending" };
    if (
      !capacity.nodes.some((node) =>
        fits(deployment.resources, subtractFloor(node.available, reserved)),
      )
    ) {
      return { status: "pending" };
    }
    await beforeEffect();
    const reservationId = claim.reservationId ?? `res_${stableId(operationId, claim.runtimeEpoch)}`;
    const reservation = await operations.reserveRuntime({
      operationId,
      workerId: claim.workerId,
      leaseToken: claim.leaseToken,
      leaseEpoch: claim.leaseEpoch,
      expectedRuntimeEpoch: claim.runtimeEpoch,
      clusterId: claim.clusterId,
      expectedCapacityEpoch: capacity.capacityEpoch,
      resources: deployment.resources,
      reservationId,
      ...(signal === undefined ? {} : { signal }),
    });
    if (reservation === null) return { status: "pending" };
    if (
      reservation.reservationId !== reservationId ||
      reservation.instanceId !== claim.instanceId ||
      reservation.repositoryId !== claim.repositoryId ||
      reservation.runtimeEpoch !== claim.runtimeEpoch ||
      reservation.generation !== claim.generation ||
      reservation.clusterId !== claim.clusterId ||
      reservation.status !== "reserved" ||
      reservation.resources.cpuMilli !== deployment.resources.cpuMilli ||
      reservation.resources.memoryMiB !== deployment.resources.memoryMiB ||
      reservation.resources.ephemeralStorageMiB !== deployment.resources.ephemeralStorageMiB
    )
      throw new TypeError("Control Plane returned a mismatched runtime reservation");
    return { status: "reserved", reservationId };
  }

  async release(
    reservationId: string,
    operationId: string,
    beforeEffect: () => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    const { claim, operations } = this.options;
    if (operationId !== claim.operationId)
      throw new TypeError("reservation release differs from the claimed operation");
    let expectedReservationRuntimeEpoch: number | null = null;
    if (reservationId === claim.currentReservationId)
      expectedReservationRuntimeEpoch = claim.currentReservationEpoch;
    else if (reservationId === claim.reservationId)
      expectedReservationRuntimeEpoch = claim.runtimeEpoch;
    if (expectedReservationRuntimeEpoch === null) {
      throw new TypeError("reservation release lacks a matching observed runtime epoch");
    }
    await beforeEffect();
    await operations.releaseRuntime({
      reservationId,
      operationId,
      workerId: claim.workerId,
      leaseToken: claim.leaseToken,
      leaseEpoch: claim.leaseEpoch,
      expectedReservationRuntimeEpoch,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  private get provider(): KubernetesRuntimeProvider {
    return this.options.runtime.provider;
  }
}

function stableId(operationId: string, runtimeEpoch: number): string {
  // A deterministic opaque reservation id makes a lost response retry
  // idempotent; it contains no repository data.
  return createHash("sha256").update(`${operationId}:${runtimeEpoch}`).digest("hex").slice(0, 32);
}

function isRetryableCapacity(error: unknown): boolean {
  if (!isRecord(error)) return false;
  return (
    error.code === "capacity" ||
    error.code === "unavailable" ||
    error.classification === "retryable"
  );
}

async function pause(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
