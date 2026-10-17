import { setTimeout as delay } from "node:timers/promises";
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  IdleLifecycle,
  type IdleObservation,
  type RuntimeAssignment,
  type LifecycleReadinessEvidence,
  type RuntimePersistenceObservation,
} from "@praetorium/application/lifecycle";
import {
  parseRuntimeInstanceId,
  parseRuntimeRepositoryId,
  type ManagedRuntimeSummary,
  type RuntimeObservation,
  type RuntimePage,
} from "@praetorium/kubernetes";
import type { ProvisionerLogger } from "./worker.js";
import {
  deploymentFromResolvedRuntime,
  type LifecycleProvisionerExecutorOptions,
} from "./lifecycle-executor.js";
import type { ProvisionerIdleCandidate, ProvisionerOperationService } from "./operation-client.js";
import type { ProvisionerMetrics } from "./metrics.js";
import { KubernetesLifecycleRuntimeAdapter } from "./kubernetes-lifecycle-adapter.js";
import {
  IdleObservationRuntimeControlCredentialProvider,
  ScriptoriumControlHttpClient,
  type RuntimeAuthAcceptanceProbe,
} from "./scriptorium-control-client.js";
import type { RuntimeIdentityAssignmentTransport } from "./runtime-identity.js";

const CONTROL_PAGE_SIZE = 25;
const DEFAULT_SCAN_INTERVAL_MS = 60_000;
const MAX_CONTROL_PAGES_PER_CYCLE = 4_096;
const MAX_RUNTIME_PAGES_PER_CANDIDATE_PAGE = 4_096;
const MAX_PRODUCER_STATUS_AGE_MS = 30_000;

export interface IdleRuntimeInspector {
  listManagedInstances(
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<RuntimePage<ManagedRuntimeSummary>>;
  inspect(assignment: RuntimeAssignment, signal?: AbortSignal): Promise<RuntimeObservation>;
  controlEndpoint(assignment: RuntimeAssignment, signal?: AbortSignal): Promise<string>;
  refreshRuntimeIdentity?(
    assignment: RuntimeAssignment,
    signal?: AbortSignal,
  ): Promise<boolean>;
}

export interface ProvisionerIdleControllerOptions {
  readonly operations: ProvisionerOperationService;
  readonly workerId: string;
  readonly clusterId: string;
  readonly runtime: LifecycleProvisionerExecutorOptions["runtime"];
  readonly idleTimeoutMs?: number;
  readonly scanIntervalMs?: number;
  readonly statusMaxAgeMs?: number;
  readonly now?: () => number;
  readonly logger?: ProvisionerLogger;
  readonly metrics?: ProvisionerMetrics;
  readonly fetch?: typeof fetch;
  readonly identityTransport?: RuntimeIdentityAssignmentTransport;
  readonly authProbe?: RuntimeAuthAcceptanceProbe;
  /** Narrow seam for deterministic unit tests; production uses the T07 adapter. */
  readonly createInspector?: (candidate: ProvisionerIdleCandidate) => IdleRuntimeInspector;
}

function isCurrentRuntimeCandidate(
  candidate: ProvisionerIdleCandidate,
  clusterId: string,
): boolean {
  return (
    candidate.clusterId === clusterId &&
    candidate.desiredState === "running" &&
    !candidate.bindingSuspended &&
    candidate.currentRuntime.assignment.instanceId === candidate.instanceId &&
    candidate.currentRuntime.assignment.repositoryId === candidate.repositoryId &&
    candidate.currentRuntime.assignment.runtimeEpoch === candidate.runtimeEpoch
  );
}

function assignmentOf(candidate: ProvisionerIdleCandidate): RuntimeAssignment {
  const resolved = candidate.currentRuntime;
  return {
    instanceId: candidate.instanceId,
    repositoryId: candidate.repositoryId,
    generation: candidate.generation,
    runtimeEpoch: candidate.runtimeEpoch,
    clusterId: candidate.clusterId,
    // Idle observation does not reserve/release capacity. A requested stop is
    // created by the Control Plane and resolves its current reservation there.
    reservationId: null,
    deployment: deploymentFromResolvedRuntime(resolved),
  };
}

function matchesManagedRuntime(
  runtime: ManagedRuntimeSummary,
  candidate: ProvisionerIdleCandidate,
  assignment: RuntimeAssignment,
): boolean {
  return (
    runtime.instanceId === candidate.instanceId &&
    runtime.repositoryId === candidate.repositoryId &&
    runtime.runtimeEpoch === candidate.runtimeEpoch &&
    runtime.generation === candidate.generation &&
    runtime.clusterId === candidate.clusterId &&
    runtime.managedGeneration === candidate.generation &&
    runtime.state === "running" &&
    runtime.releaseId === assignment.deployment.revisionId &&
    runtime.releaseDigest === assignment.deployment.imageDigest
  );
}

function observationMatches(
  observation: RuntimeObservation,
  candidate: ProvisionerIdleCandidate,
  assignment: RuntimeAssignment,
  now: number,
  maxAgeMs: number,
): boolean {
  const census = observation.writerCensus;
  const writer = census.pods[0];
  const observedAt = observation.observedAt;
  const healthAt = Date.parse(observation.health?.checkedAt ?? "");
  const applicationAt = Date.parse(observation.application?.observedAt ?? "");
  return (
    observation.observationId.length > 0 &&
    Number.isSafeInteger(observedAt) &&
    observedAt > 0 &&
    observedAt <= now &&
    now - observedAt <= maxAgeMs &&
    observation.identity.instanceId === assignment.instanceId &&
    observation.identity.repositoryId === assignment.repositoryId &&
    observation.identity.generation === assignment.generation &&
    observation.identity.runtimeEpoch === assignment.runtimeEpoch &&
    observation.identity.clusterId === assignment.clusterId &&
    observation.managedGeneration === candidate.generation &&
    observation.state === "running" &&
    observation.writerState === "running" &&
    observation.namespaceExists &&
    census.scope === "instance-repository-all-epochs" &&
    census.complete === true &&
    census.queriedPodCount === 1 &&
    census.pods.length === 1 &&
    writer?.runtimeEpoch === candidate.runtimeEpoch &&
    writer.generation === candidate.generation &&
    writer.deleting === false &&
    writer.ready === true &&
    observation.application?.ready === true &&
    observation.health?.ready === true &&
    Number.isFinite(healthAt) &&
    healthAt <= now &&
    now - healthAt <= maxAgeMs &&
    Number.isFinite(applicationAt) &&
    applicationAt <= now &&
    now - applicationAt <= maxAgeMs &&
    observation.releaseId === assignment.deployment.revisionId &&
    observation.releaseDigest === assignment.deployment.imageDigest &&
    observation.observedImageDigest === assignment.deployment.platformManifestDigest
  );
}

function sameModuleSet(left: readonly string[], right: readonly string[]): boolean {
  const expected = new Set(right);
  return left.length === expected.size && left.every((moduleId) => expected.has(moduleId));
}

export class ProvisionerIdleController {
  private readonly now: () => number;
  private readonly scanIntervalMs: number;
  private readonly statusMaxAgeMs: number;
  private readonly logger: ProvisionerLogger | undefined;
  private readonly metrics: ProvisionerMetrics | undefined;
  private readonly createInspector: (candidate: ProvisionerIdleCandidate) => IdleRuntimeInspector;
  private readonly idleTimeoutMs: number | undefined;
  private controlCursor: string | null = null;
  private candidatePage: Awaited<
    ReturnType<ProvisionerOperationService["listIdleCandidates"]>
  > | null = null;
  private inspector: IdleRuntimeInspector | undefined;
  private runtimeCursor: string | undefined;
  private controlPagesInCycle = 0;
  private runtimePagesInCandidatePage = 0;
  private readonly evaluatedCandidates = new Set<string>();

  constructor(private readonly options: ProvisionerIdleControllerOptions) {
    this.now = options.now ?? Date.now;
    this.scanIntervalMs = options.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
    this.statusMaxAgeMs = options.statusMaxAgeMs ?? MAX_PRODUCER_STATUS_AGE_MS;
    this.logger = options.logger;
    this.metrics = options.metrics;
    this.idleTimeoutMs = options.idleTimeoutMs;
    if (!Number.isSafeInteger(this.scanIntervalMs) || this.scanIntervalMs < 1) {
      throw new RangeError("idle scan interval must be a positive integer");
    }
    if (!Number.isSafeInteger(this.statusMaxAgeMs) || this.statusMaxAgeMs < 1) {
      throw new RangeError("idle producer status age must be a positive integer");
    }
    this.createInspector =
      options.createInspector ??
      ((candidate) => {
        const adapter = new KubernetesLifecycleRuntimeAdapter(
          options.runtime,
          {
            clusterId: candidate.clusterId,
            repositoryId: candidate.repositoryId,
            generation: candidate.generation,
            runtimeEpoch: candidate.runtimeEpoch,
          },
          {
            currentReservations: (clusterId) =>
              options.operations.currentReservations({ clusterId }),
            recordCapacitySnapshot: (input) => options.operations.recordCapacitySnapshot(input),
          },
          options.identityTransport,
        );
        return {
          listManagedInstances: (cursor, signal) =>
            adapter.provider.listManagedInstances(cursor, signal),
          inspect: (assignment, signal) =>
            adapter.provider.inspect(
              {
                instanceId: parseRuntimeInstanceId(assignment.instanceId),
                repositoryId: parseRuntimeRepositoryId(assignment.repositoryId),
                runtimeEpoch: assignment.runtimeEpoch,
                generation: assignment.generation,
                clusterId: assignment.clusterId,
              },
              signal,
            ),
          controlEndpoint: (assignment, signal) => adapter.controlEndpoint(assignment, signal),
          refreshRuntimeIdentity: (assignment, signal) =>
            adapter.refreshRuntimeIdentity(assignment, async () => undefined, signal),
        };
      });
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.scanOnce(signal);
      } catch (error) {
        if (signal.aborted) break;
        this.metrics?.increment("idle_scan_retry");
        this.logger?.warn("idle_scan_retry", { code: errorCode(error) });
      }
      if (signal.aborted) break;
      await delay(this.scanIntervalMs, undefined, { signal }).catch(() => undefined);
    }
  }

  /** Processes at most one bounded Control Plane page and one Kubernetes page. */
  async scanOnce(signal?: AbortSignal): Promise<void> {
    if (this.candidatePage === null) {
      this.candidatePage = await this.options.operations.listIdleCandidates({
        workerId: this.options.workerId,
        clusterId: this.options.clusterId,
        limit: CONTROL_PAGE_SIZE,
        cursor: this.controlCursor,
        ...(signal === undefined ? {} : { signal }),
      });
      this.controlPagesInCycle += 1;
      this.metrics?.increment("idle_candidate_page");
      if (this.controlPagesInCycle > MAX_CONTROL_PAGES_PER_CYCLE) {
        this.logger?.warn("idle_candidate_cursor_cycle_reset", { code: "cursor_page_limit" });
        this.controlCursor = null;
        this.controlPagesInCycle = 0;
        this.candidatePage = null;
        return;
      }
    }

    const candidates = this.candidatePage.items.filter((candidate) =>
      isCurrentRuntimeCandidate(candidate, this.options.clusterId),
    );
    if (candidates.length === 0) {
      this.finishCandidatePage();
      return;
    }

    this.inspector ??= this.createInspector(candidates[0]!);
    const page = await this.inspector.listManagedInstances(this.runtimeCursor, signal);
    this.runtimePagesInCandidatePage += 1;
    if (this.runtimePagesInCandidatePage > MAX_RUNTIME_PAGES_PER_CANDIDATE_PAGE) {
      this.logger?.warn("idle_runtime_cursor_cycle_reset", { code: "cursor_page_limit" });
      this.finishCandidatePage();
      return;
    }
    this.metrics?.increment("idle_runtime_page");

    for (const candidate of candidates) {
      const assignment = assignmentOf(candidate);
      if (!page.items.some((runtime) => matchesManagedRuntime(runtime, candidate, assignment))) {
        continue;
      }
      if (this.evaluatedCandidates.has(candidate.instanceId)) continue;
      this.evaluatedCandidates.add(candidate.instanceId);
      await this.evaluateCandidate(candidate, assignment, signal);
    }

    if (page.nextCursor === null) {
      this.finishCandidatePage();
    } else {
      if (page.nextCursor === this.runtimeCursor) {
        this.logger?.warn("idle_runtime_cursor_stalled", { code: "cursor_did_not_advance" });
        this.finishCandidatePage();
        return;
      }
      this.runtimeCursor = page.nextCursor;
    }
  }

  private async evaluateCandidate(
    candidate: ProvisionerIdleCandidate,
    assignment: RuntimeAssignment,
    signal?: AbortSignal,
  ): Promise<void> {
    const inspector = this.inspector;
    if (inspector === undefined) return;
    try {
      const runtimeObservation = await inspector.inspect(assignment, signal);
      const providerObservedAt = this.now();
      const providerReady = observationMatches(
        runtimeObservation,
        candidate,
        assignment,
        providerObservedAt,
        this.statusMaxAgeMs,
      );
      if (!providerReady) {
        this.metrics?.increment("idle_runtime_not_ready");
        return;
      }

      if (inspector.refreshRuntimeIdentity !== undefined) {
        try {
          if (await inspector.refreshRuntimeIdentity(assignment, signal))
            this.metrics?.increment("runtime_identity_refreshed");
        } catch (error) {
          if (signal?.aborted) throw signal.reason ?? error;
          this.metrics?.increment("runtime_identity_refresh_failed");
          this.logger?.warn("runtime_identity_refresh_failed", { code: errorCode(error) });
          return;
        }
      }

      const producer = new ScriptoriumControlHttpClient(
        {
          namespacePrefix: this.options.runtime.namespacePrefix,
          resolveEndpoint: (runtimeAssignment, endpointSignal) =>
            inspector.controlEndpoint(runtimeAssignment, endpointSignal),
          now: this.now,
          ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
        },
        new IdleObservationRuntimeControlCredentialProvider(
          this.options.operations,
          this.options.workerId,
          this.now,
        ),
      );
      const status = await producer.status(assignment, signal);
      const statusObservedAt = Date.parse(status.observedAt);
      const now = this.now();
      if (
        status.ready !== true ||
        status.imageDigest !== assignment.deployment.imageDigest ||
        status.compositionManifestDigest !== assignment.deployment.compositionManifestDigest ||
        !sameModuleSet(status.enabledModuleIds, assignment.deployment.enabledModuleIds) ||
        !Number.isFinite(statusObservedAt) ||
        statusObservedAt > now ||
        now - statusObservedAt > this.statusMaxAgeMs
      ) {
        this.metrics?.increment("idle_producer_status_stale_or_mismatched");
        return;
      }

      if (
        !candidate.hasActiveOperation &&
        candidate.healthOperationId !== null &&
        this.options.authProbe !== undefined &&
        this.options.operations.recordRuntimeHealth !== undefined
      ) {
        await this.recordHealthSample(
          candidate,
          assignment,
          runtimeObservation,
          status,
          this.options.authProbe.withEndpointResolver((runtimeAssignment, endpointSignal) =>
            inspector.controlEndpoint(runtimeAssignment, endpointSignal),
          ),
          signal,
        );
      }

      if (candidate.hasActiveOperation) return;

      const activity = status.activity;
      const observation: IdleObservation = {
        instanceId: candidate.instanceId,
        repositoryId: candidate.repositoryId,
        lastMeaningfulActivityAt: activity.lastMeaningfulActivityAt,
        activeRequests: activity.activeApiRequests + activity.activeMcpRequests,
        activeJobs: activity.activeJobs,
        activeMutation:
          activity.activeMutations > 0 ||
          activity.pendingCheckpoints > 0 ||
          activity.uncertainPublication,
        intendedStopped: candidate.desiredState === "stopped",
        runtimeState: "running",
        current: assignment,
      };
      const lifecycle = new IdleLifecycle({
        observations: {
          async observe() {
            return observation;
          },
        },
        operations: {
          createIdleStop: async (value) => {
            if (
              value.current?.instanceId !== candidate.instanceId ||
              value.current.repositoryId !== candidate.repositoryId ||
              value.current.generation !== candidate.generation ||
              value.current.runtimeEpoch !== candidate.runtimeEpoch ||
              value.current.clusterId !== candidate.clusterId
            ) {
              throw new TypeError("idle stop assignment fence changed during observation");
            }
            return this.options.operations.createIdleStop({
              workerId: this.options.workerId,
              clusterId: candidate.clusterId,
              instanceId: candidate.instanceId,
              repositoryId: candidate.repositoryId,
              expectedGeneration: candidate.generation,
              expectedRuntimeEpoch: candidate.runtimeEpoch,
              ...(signal === undefined ? {} : { signal }),
            });
          },
        },
        idleTimeoutMs: this.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
        now: this.now,
      });
      const decision = await lifecycle.evaluate(candidate.instanceId, signal);
      if (decision.status === "scheduled") {
        this.metrics?.increment("idle_stop_requested");
        this.logger?.info("idle_stop_requested", { code: "producer_activity_timeout" });
      } else {
        this.metrics?.increment("idle_runtime_retained");
      }
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      this.metrics?.increment("idle_observation_unavailable");
      this.logger?.warn("idle_observation_unavailable", { code: errorCode(error) });
    }
  }

  private async recordHealthSample(
    candidate: ProvisionerIdleCandidate,
    assignment: RuntimeAssignment,
    observation: RuntimeObservation,
    producer: Awaited<ReturnType<ScriptoriumControlHttpClient["status"]>>,
    authProbe: RuntimeAuthAcceptanceProbe,
    signal?: AbortSignal,
  ): Promise<void> {
    const recordHealth = this.options.operations.recordRuntimeHealth;
    const operationId = candidate.healthOperationId;
    const actualImageDigest = observation.observedImageDigest;
    if (
      authProbe === undefined ||
      recordHealth === undefined ||
      operationId === null ||
      actualImageDigest !== assignment.deployment.platformManifestDigest
    )
      return;
    const auth = await authProbe.verifyObserved(assignment, operationId, signal);
    const now = this.now();
    const verifiedAt = Date.parse(auth.observedAt);
    const producerAt = Date.parse(producer.observedAt);
    const evidenceIsFresh =
      Number.isFinite(verifiedAt) &&
      verifiedAt <= now &&
      now - verifiedAt <= this.statusMaxAgeMs &&
      Number.isFinite(producerAt) &&
      producerAt <= verifiedAt &&
      verifiedAt - producerAt <= this.statusMaxAgeMs;
    if (
      !evidenceIsFresh ||
      !auth.grantPolicyMatched ||
      !auth.controlServicePolicyMatched ||
      !auth.validGrantAccepted ||
      !auth.wrongRepositoryGrantRejected ||
      !auth.wrongEpochGrantRejected ||
      !auth.invalidServiceCredentialRejected ||
      !auth.applicationProbeId ||
      !auth.uiApiMcpProbeId ||
      !auth.persistenceProbeId ||
      !auth.validGrantProbeId ||
      !auth.wrongRepositoryProbeId ||
      !auth.wrongEpochProbeId ||
      !auth.invalidServiceCredentialProbeId
    ) {
      this.metrics?.increment("runtime_health_evidence_unverified");
      return;
    }
    const persistence: RuntimePersistenceObservation = producer.persistence ?? {
      state: "unknown",
      observedRemoteCommit: null,
      formats: [],
    };
    if (persistence.state !== "verified" || persistence.observedRemoteCommit === null) {
      this.metrics?.increment("runtime_health_persistence_unverified");
      return;
    }
    const readinessEvidence: LifecycleReadinessEvidence = {
      assignment,
      providerObservationId: observation.observationId,
      actualImageDigest,
      producerObservedAt: producer.observedAt,
      compositionManifestDigest: producer.compositionManifestDigest,
      enabledModuleIds: [...producer.enabledModuleIds].sort(),
      applicationProbeId: auth.applicationProbeId,
      uiApiMcpProbeId: auth.uiApiMcpProbeId,
      persistenceProbeId: auth.persistenceProbeId,
      validGrantProbeId: auth.validGrantProbeId,
      wrongRepositoryProbeId: auth.wrongRepositoryProbeId,
      wrongEpochProbeId: auth.wrongEpochProbeId,
      invalidServiceCredentialProbeId: auth.invalidServiceCredentialProbeId,
      persistence,
      verifiedAt: auth.observedAt,
    };
    const result = await recordHealth.call(this.options.operations, {
      workerId: this.options.workerId,
      clusterId: this.options.clusterId,
      operationId,
      readinessEvidence,
      ...(signal === undefined ? {} : { signal }),
    });
    if (result.recorded) this.metrics?.increment("runtime_health_sample_recorded");
  }

  private finishCandidatePage(): void {
    this.controlCursor = this.candidatePage?.nextCursor ?? null;
    if (this.controlCursor === null) this.controlPagesInCycle = 0;
    this.candidatePage = null;
    this.inspector = undefined;
    this.runtimeCursor = undefined;
    this.runtimePagesInCandidatePage = 0;
    this.evaluatedCandidates.clear();
  }
}

function errorCode(error: unknown): string {
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(error.message)) {
    return error.message;
  }
  return error instanceof Error ? error.name : "idle_scan_error";
}
