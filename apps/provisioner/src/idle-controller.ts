import { WorkAvailability } from "@praetorium/application";
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  IdleLifecycle,
  type IdleObservation,
  type RuntimeAssignment,
  type LifecycleReadinessEvidence,
  type ProducerStatus,
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
import { IdleDeadlineJournal, type IdleDeadlineRecord } from "./idle-deadline-journal.js";

const CONTROL_PAGE_SIZE = 25;
const MAX_CONTROL_PAGES_PER_CYCLE = 4_096;
const MAX_RUNTIME_PAGES_PER_CANDIDATE_PAGE = 4_096;
const MAX_PRODUCER_STATUS_AGE_MS = 30_000;
const IDLE_RECHECK_INTERVAL_MS = 300_000;
const MAX_AVAILABILITY_WAIT_MS = 3_600_000;
const INITIAL_RETRY_INTERVAL_MS = 5_000;
const MAX_RETRY_INTERVAL_MS = 300_000;
const IDENTITY_REFRESH_MARGIN_MS = 90_000;
const MAX_RECORDED_HEALTH_TRIGGERS = 10_000;

export interface IdleRuntimeInspector {
  listManagedInstances(
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<RuntimePage<ManagedRuntimeSummary>>;
  inspect(assignment: RuntimeAssignment, signal?: AbortSignal): Promise<RuntimeObservation>;
  controlEndpoint(assignment: RuntimeAssignment, signal?: AbortSignal): Promise<string>;
  refreshRuntimeIdentity?(assignment: RuntimeAssignment, signal?: AbortSignal): Promise<boolean>;
  runtimeIdentityExpiresAt?(assignment: RuntimeAssignment, signal?: AbortSignal): Promise<number>;
}

export interface ProvisionerIdleControllerOptions {
  readonly operations: ProvisionerOperationService;
  readonly workerId: string;
  readonly clusterId: string;
  readonly runtime: LifecycleProvisionerExecutorOptions["runtime"];
  readonly idleTimeoutMs?: number;
  readonly statusMaxAgeMs?: number;
  readonly idleJournalPath?: string;
  readonly idleJournal?: IdleDeadlineJournal;
  readonly now?: () => number;
  readonly logger?: ProvisionerLogger;
  readonly metrics?: ProvisionerMetrics;
  readonly fetch?: typeof fetch;
  readonly identityTransport?: RuntimeIdentityAssignmentTransport;
  readonly authProbe?: RuntimeAuthAcceptanceProbe;
  /** Narrow seam for deterministic unit tests; production uses the T07 adapter. */
  readonly createInspector?: (candidate: ProvisionerIdleCandidate) => IdleRuntimeInspector;
}

interface TrackedRuntime {
  readonly candidate: ProvisionerIdleCandidate;
  readonly assignment: RuntimeAssignment;
  readonly inspector: IdleRuntimeInspector;
  identityRefreshAt: number | undefined;
  idleCheckAt: number | undefined;
  retryAt: number | undefined;
  retryMs: number;
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

function sameIdleBinding(left: RuntimeAssignment, right: RuntimeAssignment): boolean {
  return (
    left.instanceId === right.instanceId &&
    left.repositoryId === right.repositoryId &&
    left.generation === right.generation &&
    left.runtimeEpoch === right.runtimeEpoch &&
    left.clusterId === right.clusterId
  );
}

function validActivityCounts(activity: ProducerStatus["activity"]): boolean {
  return [
    activity.activeApiRequests,
    activity.activeMcpRequests,
    activity.activeMutations,
    activity.activeJobs,
    activity.restartableJobs,
    activity.pendingCheckpoints,
  ].every((value) => Number.isSafeInteger(value) && value >= 0);
}

export class ProvisionerIdleController {
  private readonly now: () => number;
  private readonly statusMaxAgeMs: number;
  private readonly idleTimeoutMs: number;
  private readonly availability = new WorkAvailability();
  private readonly journal: IdleDeadlineJournal;
  private readonly recordedHealthTriggers = new Set<string>();
  private journalLoadAttempted = false;
  private journalReady = false;
  private discoveryPending = true;
  private discoveryRetryAt: number | undefined;
  private discoveryRetryMs = INITIAL_RETRY_INTERVAL_MS;
  private readonly tracked = new Map<string, TrackedRuntime>();
  private readonly logger: ProvisionerLogger | undefined;
  private readonly metrics: ProvisionerMetrics | undefined;
  private readonly createInspector: (candidate: ProvisionerIdleCandidate) => IdleRuntimeInspector;
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
    this.statusMaxAgeMs = options.statusMaxAgeMs ?? MAX_PRODUCER_STATUS_AGE_MS;
    this.logger = options.logger;
    this.metrics = options.metrics;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.journal = options.idleJournal ?? new IdleDeadlineJournal(options.idleJournalPath);
    if (!Number.isSafeInteger(this.idleTimeoutMs) || this.idleTimeoutMs < 1)
      throw new RangeError("idle timeout must be a positive integer");
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
          runtimeIdentityExpiresAt: (assignment, signal) =>
            adapter.runtimeIdentityExpiresAt(assignment, signal),
        };
      });
  }

  notifyWorkAvailable(): void {
    this.discoveryPending = true;
    this.availability.notify();
  }

  async processDueOnce(signal?: AbortSignal): Promise<void> {
    await this.ensureJournalLoaded();
    await this.processDue(signal ?? new AbortController().signal);
  }

  async run(signal: AbortSignal): Promise<void> {
    await this.ensureJournalLoaded();
    while (!signal.aborted) {
      if (this.discoveryPending) {
        this.discoveryPending = false;
        this.discoveryRetryAt = undefined;
        try {
          await this.scanFullInventory(signal);
          this.discoveryRetryMs = INITIAL_RETRY_INTERVAL_MS;
        } catch (error) {
          if (signal.aborted) break;
          this.discoveryRetryAt = this.now() + this.discoveryRetryMs;
          this.discoveryRetryMs = Math.min(
            MAX_RETRY_INTERVAL_MS,
            Math.ceil(this.discoveryRetryMs * 1.8),
          );
          this.metrics?.increment("idle_scan_retry");
          this.logger?.warn("idle_scan_retry", { code: errorCode(error) });
        }
      }
      if (signal.aborted) break;
      try {
        await this.processDue(signal);
      } catch (error) {
        if (signal.aborted) break;
        this.metrics?.increment("idle_timer_retry");
        this.logger?.warn("idle_timer_retry", { code: errorCode(error) });
      }
      if (signal.aborted) break;
      const nextWakeAt = this.nextWakeAt();
      const waitMs =
        nextWakeAt === undefined
          ? MAX_AVAILABILITY_WAIT_MS
          : Math.max(1, Math.min(MAX_AVAILABILITY_WAIT_MS, nextWakeAt - this.now()));
      await this.availability.wait(signal, waitMs);
      if (this.discoveryRetryAt !== undefined && this.discoveryRetryAt <= this.now()) {
        this.discoveryPending = true;
      }
    }
  }

  private async ensureJournalLoaded(): Promise<void> {
    if (this.journalLoadAttempted) return;
    this.journalLoadAttempted = true;
    try {
      await this.journal.load();
      this.journalReady = this.journal.persistent;
      if (!this.journalReady) this.metrics?.increment("idle_journal_unconfigured");
    } catch (error) {
      this.journalReady = false;
      this.metrics?.increment("idle_journal_unavailable");
      this.logger?.warn("idle_journal_unavailable", { code: errorCode(error) });
    }
  }

  private async scanFullInventory(signal?: AbortSignal): Promise<void> {
    let pages = 0;
    do {
      if (signal?.aborted) return;
      await this.scanOnce(signal);
      pages += 1;
      if (pages > MAX_CONTROL_PAGES_PER_CYCLE * MAX_RUNTIME_PAGES_PER_CANDIDATE_PAGE) {
        throw new Error("idle_inventory_page_limit");
      }
    } while (this.candidatePage !== null || this.controlCursor !== null);
  }

  private nextWakeAt(): number | undefined {
    const values: number[] = [];
    if (this.discoveryRetryAt !== undefined) values.push(this.discoveryRetryAt);
    for (const runtime of this.tracked.values()) {
      if (runtime.identityRefreshAt !== undefined) values.push(runtime.identityRefreshAt);
      if (runtime.idleCheckAt !== undefined) values.push(runtime.idleCheckAt);
      if (runtime.retryAt !== undefined) values.push(runtime.retryAt);
    }
    return values.length === 0 ? undefined : Math.min(...values);
  }

  private async processDue(signal: AbortSignal): Promise<void> {
    const now = this.now();
    if (this.discoveryRetryAt !== undefined && this.discoveryRetryAt <= now) {
      this.discoveryPending = true;
      this.discoveryRetryAt = undefined;
    }
    for (const tracked of [...this.tracked.values()]) {
      if (signal.aborted) return;
      if (tracked.identityRefreshAt !== undefined && tracked.identityRefreshAt <= this.now()) {
        if (!(await this.refreshIdentity(tracked, signal))) {
          if (tracked.idleCheckAt !== undefined && tracked.idleCheckAt <= this.now())
            tracked.idleCheckAt = tracked.identityRefreshAt;
          continue;
        }
      }
      if (signal.aborted) return;
      const dueAt = tracked.retryAt ?? tracked.idleCheckAt;
      if (dueAt !== undefined && dueAt <= this.now()) {
        tracked.retryAt = undefined;
        tracked.idleCheckAt = undefined;
        if (tracked.candidate.hasActiveOperation) continue;
        await this.evaluateCandidate(
          tracked.candidate,
          tracked.assignment,
          tracked.inspector,
          signal,
          false,
        );
      }
    }
  }

  private async refreshIdentity(tracked: TrackedRuntime, signal: AbortSignal): Promise<boolean> {
    const inspector = tracked.inspector;
    if (
      inspector.refreshRuntimeIdentity === undefined ||
      inspector.runtimeIdentityExpiresAt === undefined
    ) {
      tracked.identityRefreshAt = undefined;
      return true;
    }
    try {
      if (await inspector.refreshRuntimeIdentity(tracked.assignment, signal))
        this.metrics?.increment("runtime_identity_refreshed");
      const expiresAt = await inspector.runtimeIdentityExpiresAt(tracked.assignment, signal);
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.now())
        throw new Error("runtime_identity_expiry_invalid");
      tracked.identityRefreshAt = expiresAt - IDENTITY_REFRESH_MARGIN_MS;
      if (tracked.identityRefreshAt <= this.now())
        tracked.identityRefreshAt = this.now() + INITIAL_RETRY_INTERVAL_MS;
      tracked.retryMs = INITIAL_RETRY_INTERVAL_MS;
      return true;
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      this.metrics?.increment("runtime_identity_refresh_failed");
      this.logger?.warn("runtime_identity_refresh_failed", { code: errorCode(error) });
      tracked.identityRefreshAt = this.now() + tracked.retryMs;
      tracked.retryMs = Math.min(MAX_RETRY_INTERVAL_MS, Math.ceil(tracked.retryMs * 1.8));
      return false;
    }
  }

  /** Processes at most one bounded Control Plane page and one Kubernetes page. */
  async scanOnce(signal?: AbortSignal): Promise<void> {
    await this.ensureJournalLoaded();
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
      await this.evaluateCandidate(candidate, assignment, this.inspector, signal, true);
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
    inspector: IdleRuntimeInspector | undefined,
    signal?: AbortSignal,
    allowHealthProbe = false,
  ): Promise<void> {
    if (inspector === undefined) return;
    let tracked = this.tracked.get(candidate.instanceId);
    if (tracked === undefined || !sameIdleBinding(tracked.assignment, assignment)) {
      tracked = {
        candidate,
        assignment,
        inspector,
        identityRefreshAt: undefined,
        idleCheckAt: undefined,
        retryAt: undefined,
        retryMs: INITIAL_RETRY_INTERVAL_MS,
      };
    } else {
      tracked = { ...tracked, candidate, assignment, inspector };
    }
    this.tracked.set(candidate.instanceId, tracked);
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
        this.scheduleRetry(tracked);
        return;
      }

      if (
        tracked.identityRefreshAt === undefined &&
        inspector.runtimeIdentityExpiresAt !== undefined &&
        inspector.refreshRuntimeIdentity !== undefined
      ) {
        const expiresAt = await inspector.runtimeIdentityExpiresAt(assignment, signal);
        if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.now())
          throw new Error("runtime_identity_expiry_invalid");
        tracked.identityRefreshAt = Math.max(
          this.now() + 1_000,
          expiresAt - IDENTITY_REFRESH_MARGIN_MS,
        );
        if (expiresAt - this.now() <= IDENTITY_REFRESH_MARGIN_MS) {
          if (!(await this.refreshIdentity(tracked, signal ?? new AbortController().signal))) {
            tracked.idleCheckAt = tracked.identityRefreshAt;
            return;
          }
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
        this.scheduleRetry(tracked);
        return;
      }

      if (
        allowHealthProbe &&
        !candidate.hasActiveOperation &&
        candidate.healthOperationId !== null &&
        this.options.authProbe !== undefined &&
        this.options.operations.recordRuntimeHealth !== undefined
      ) {
        const trigger = JSON.stringify([
          candidate.instanceId,
          candidate.runtimeEpoch,
          candidate.healthOperationId,
        ]);
        if (!this.recordedHealthTriggers.has(trigger)) {
          this.recordedHealthTriggers.add(trigger);
          if (this.recordedHealthTriggers.size > MAX_RECORDED_HEALTH_TRIGGERS) {
            const oldest = this.recordedHealthTriggers.values().next().value;
            if (oldest !== undefined) this.recordedHealthTriggers.delete(oldest);
          }
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
      }

      if (candidate.hasActiveOperation) {
        tracked.retryAt = undefined;
        return;
      }

      const activity = status.activity;
      if (!validActivityCounts(activity)) {
        this.metrics?.increment("idle_activity_counts_invalid");
        tracked.idleCheckAt = this.now() + IDLE_RECHECK_INTERVAL_MS;
        return;
      }
      const activityAt =
        activity.lastMeaningfulActivityAt === null
          ? Number.NaN
          : Date.parse(activity.lastMeaningfulActivityAt);
      if (!Number.isSafeInteger(activityAt) || activityAt < 0 || activityAt > this.now()) {
        this.metrics?.increment("idle_activity_time_unknown");
        tracked.idleCheckAt = this.now() + IDLE_RECHECK_INTERVAL_MS;
        return;
      }
      if (
        activity.activeApiRequests > 0 ||
        activity.activeMcpRequests > 0 ||
        activity.activeJobs > 0 ||
        activity.activeMutations > 0 ||
        activity.pendingCheckpoints > 0 ||
        activity.uncertainPublication
      ) {
        tracked.idleCheckAt = this.now() + IDLE_RECHECK_INTERVAL_MS;
        return;
      }
      if (!this.journalReady) {
        this.metrics?.increment("idle_journal_unavailable");
        tracked.idleCheckAt = undefined;
        return;
      }
      let deadline: IdleDeadlineRecord | undefined = this.journal.get(assignment);
      if (deadline === undefined || deadline.lastMeaningfulActivityAt !== activityAt) {
        deadline = {
          instanceId: candidate.instanceId,
          repositoryId: candidate.repositoryId,
          generation: candidate.generation,
          runtimeEpoch: candidate.runtimeEpoch,
          clusterId: candidate.clusterId,
          lastMeaningfulActivityAt: activityAt,
          deadlineAt: activityAt + this.idleTimeoutMs,
          updatedAt: this.now(),
        };
        if (!(await this.journal.put(deadline))) {
          this.metrics?.increment("idle_journal_unavailable");
          tracked.idleCheckAt = undefined;
          return;
        }
      }
      if (deadline.deadlineAt > this.now()) {
        tracked.idleCheckAt = deadline.deadlineAt;
        tracked.retryAt = undefined;
        tracked.retryMs = INITIAL_RETRY_INTERVAL_MS;
        return;
      }

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
        idleTimeoutMs: this.idleTimeoutMs,
        now: this.now,
      });
      const decision = await lifecycle.evaluate(candidate.instanceId, signal);
      if (decision.status === "scheduled") {
        tracked.idleCheckAt = undefined;
        tracked.retryAt = undefined;
        this.metrics?.increment("idle_stop_requested");
        this.logger?.info("idle_stop_requested", { code: "producer_activity_timeout" });
      } else {
        this.metrics?.increment("idle_runtime_retained");
        tracked.idleCheckAt = this.now() + IDLE_RECHECK_INTERVAL_MS;
      }
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      this.metrics?.increment("idle_observation_unavailable");
      this.logger?.warn("idle_observation_unavailable", { code: errorCode(error) });
      this.scheduleRetry(tracked);
    }
  }

  private scheduleRetry(tracked: TrackedRuntime): void {
    tracked.retryAt = this.now() + tracked.retryMs;
    tracked.retryMs = Math.min(MAX_RETRY_INTERVAL_MS, Math.ceil(tracked.retryMs * 1.8));
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
