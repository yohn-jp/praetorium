import { CanaryCleanupEvidenceSchema, CanaryHealthEvidenceSchema } from "./model.js";
import type {
  CandidateWorkLease,
  CandidateWorkflow,
  ReleaseCandidate,
  ReleasePromotionRepository,
  ReleaseAdmissionProvider,
  ReleaseClock,
} from "./model.js";
import { compareReleaseVersions } from "./semver.js";
import type { CompositionResult, StableRolloutPlanner } from "../rollouts/model.js";

export const STABLE_CANARY_HEALTH_WINDOW_MS = 10 * 60 * 1_000;
const DEFAULT_RETRY_MS = 5 * 60 * 1_000;
const CANDIDATE_LEASE_MS = 60 * 1_000;
const FOLLOWER_PAGE_SIZE = 50;

export interface CanaryCompositionProvider {
  /** Uses the configured disposable canary selection and the normal build cache. */
  compose(input: {
    readonly release: ReleaseCandidate;
    readonly idempotencyKey: string;
  }): Promise<CompositionResult>;
}

export interface CanaryRuntimeProvider {
  /** Idempotent by idempotencyKey; starts only the explicitly disposable canary. */
  ensureRunning(input: {
    readonly release: ReleaseCandidate;
    readonly artifactDigest: string;
    readonly idempotencyKey: string;
  }): Promise<{ readonly runtimeId: string; readonly operationId: string }>;
  observe(input: {
    readonly runtimeId: string;
    readonly operationId: string;
  }): Promise<
    | { readonly kind: "healthy"; readonly evidence: unknown }
    | { readonly kind: "unhealthy"; readonly code: string }
    | { readonly kind: "unknown" }
  >;
  /** Idempotent stop request, including a retry after worker restart. */
  stop(input: {
    readonly runtimeId: string;
    readonly startedOperationId: string;
    readonly idempotencyKey: string;
  }): Promise<
    { readonly kind: "pending" | "blocked" } | { readonly kind: "stopped"; readonly evidence: unknown }
  >;
}

export interface ReleasePromotionDeps {
  readonly releases: ReleasePromotionRepository;
  readonly admission: ReleaseAdmissionProvider;
  readonly canaryComposition: CanaryCompositionProvider;
  readonly canaryRuntime: CanaryRuntimeProvider;
  readonly rolloutPlanner: StableRolloutPlanner;
  readonly clock: ReleaseClock;
  readonly workerId: string;
  readonly healthWindowMs?: number;
  readonly maxHealthGapMs?: number;
  readonly retryMs?: number;
  /** Best-effort hint after the durable canary-observing checkpoint commits. */
  readonly notifyCanaryHealthScheduleAvailable?: (instanceId: string) => Promise<void>;
}

export type PromotionBatchResult = {
  readonly claimed: number;
  readonly advanced: number;
  readonly retried: number;
  readonly terminal: number;
};

type WorkflowNext = Omit<
  CandidateWorkflow,
  "revision" | "leaseOwner" | "leaseEpoch" | "leaseExpiresAt"
>;

function nextWorkflow(
  workflow: CandidateWorkflow,
  patch: Partial<WorkflowNext>,
  now: string,
): WorkflowNext {
  const {
    revision: _revision,
    leaseOwner: _owner,
    leaseEpoch: _epoch,
    leaseExpiresAt: _expiresAt,
    ...base
  } = workflow;
  void _revision;
  void _owner;
  void _epoch;
  void _expiresAt;
  return { ...base, ...patch, updatedAt: now };
}

async function save(
  deps: ReleasePromotionDeps,
  lease: CandidateWorkLease,
  patch: Partial<WorkflowNext>,
  releaseLease = true,
): Promise<boolean> {
  return (
    (await deps.releases.saveCandidateWorkflow({
      lease,
      next: nextWorkflow(lease.workflow, patch, deps.clock.now()),
      releaseLease,
    })) === "saved"
  );
}

function isTerminal(state: CandidateWorkflow["state"]): boolean {
  return (
    state === "complete" || state === "blocked" || state === "rejected" || state === "superseded"
  );
}

async function retry(
  deps: ReleasePromotionDeps,
  lease: CandidateWorkLease,
  reason: string,
  nowMs: number,
): Promise<boolean> {
  const delay = deps.retryMs ?? DEFAULT_RETRY_MS;
  return save(deps, lease, {
    attempts: lease.workflow.attempts + 1,
    nextAttemptAt: nowMs + delay,
    failureCode: reason,
  });
}

async function reject(
  deps: ReleasePromotionDeps,
  lease: CandidateWorkLease,
  state: "blocked" | "rejected" | "superseded",
  reason: string,
): Promise<boolean> {
  return save(deps, lease, {
    state,
    nextAttemptAt: null,
    failureCode: reason,
  });
}

async function ensureCandidateIsAdmitted(
  deps: ReleasePromotionDeps,
  lease: CandidateWorkLease,
): Promise<"verified" | "retry" | "rejected"> {
  if (
    !lease.candidate.admission.registryConfirmed ||
    !lease.candidate.admission.provenanceVerified
  ) {
    return "rejected";
  }
  const result = await deps.admission.verify(lease.candidate);
  return result.kind === "verified" ? "verified" : result.kind;
}

async function stableVersion(
  deps: ReleasePromotionDeps,
): Promise<{ readonly channelRevision: number; readonly current: ReleaseCandidate | null }> {
  const channel = await deps.releases.getStableChannel();
  const current = channel.currentReleaseId
    ? await deps.releases.findById(channel.currentReleaseId)
    : null;
  return { channelRevision: channel.revision, current };
}

async function advanceCandidate(
  deps: ReleasePromotionDeps,
  lease: CandidateWorkLease,
): Promise<"advanced" | "retried" | "terminal" | "stale"> {
  const { workflow, candidate } = lease;
  const nowMs = deps.clock.nowMs();
  const retryMs = deps.retryMs ?? DEFAULT_RETRY_MS;

  if (isTerminal(workflow.state)) return "terminal";

  if (workflow.state === "queued") {
    const result = await ensureCandidateIsAdmitted(deps, lease);
    if (result === "retry") {
      return (await retry(deps, lease, "release_evidence_unavailable", nowMs))
        ? "retried"
        : "stale";
    }
    if (result === "rejected") {
      return (await reject(deps, lease, "rejected", "release_evidence_rejected"))
        ? "terminal"
        : "stale";
    }
    const { current } = await stableVersion(deps);
    if (current && compareReleaseVersions(candidate.version, current.version) <= 0) {
      return (await reject(deps, lease, "superseded", "not_newer_than_stable"))
        ? "terminal"
        : "stale";
    }
    return (await save(deps, lease, {
      state: "canary_building",
      attempts: workflow.attempts + 1,
      nextAttemptAt: null,
      failureCode: null,
    }))
      ? "advanced"
      : "stale";
  }

  if (workflow.state === "canary_building") {
    const built = await deps.canaryComposition.compose({
      release: candidate,
      idempotencyKey: `stable-canary-build:${candidate.id}`,
    });
    if (built.kind === "pending") {
      return (await save(deps, lease, {
        canaryBuildKey: built.buildKey,
        nextAttemptAt: Math.max(nowMs + 1_000, built.retryAt),
      }))
        ? "retried"
        : "stale";
    }
    if (built.kind === "failed") {
      if (built.retryable) {
        return (await retry(deps, lease, built.code, nowMs)) ? "retried" : "stale";
      }
      return (await reject(deps, lease, "blocked", built.code)) ? "terminal" : "stale";
    }
    return (await save(deps, lease, {
      state: "canary_starting",
      canaryBuildKey: built.buildKey,
      canaryArtifactDigest: built.artifactDigest,
      nextAttemptAt: null,
      failureCode: null,
    }))
      ? "advanced"
      : "stale";
  }

  if (workflow.state === "canary_starting") {
    if (!workflow.canaryArtifactDigest) {
      return (await reject(deps, lease, "blocked", "canary_artifact_missing"))
        ? "terminal"
        : "stale";
    }
    const canary = await deps.canaryRuntime.ensureRunning({
      release: candidate,
      artifactDigest: workflow.canaryArtifactDigest,
      idempotencyKey: `stable-canary-runtime:${candidate.id}`,
    });
    const saved = await save(deps, lease, {
      state: "canary_observing",
      canaryRuntimeId: canary.runtimeId,
      canaryOperationId: canary.operationId,
      healthySince: null,
      lastHealthyAt: null,
      lastHealthEvidence: null,
      nextAttemptAt: nowMs + Math.min(retryMs, 5 * 60 * 1_000),
      failureCode: null,
    });
    if (!saved) return "stale";
    try {
      await deps.notifyCanaryHealthScheduleAvailable?.(canary.runtimeId);
    } catch {
      // The workflow checkpoint is durable; the hint is best-effort.
    }
    return "advanced";
  }

  if (workflow.state === "canary_observing") {
    if (!workflow.canaryRuntimeId) {
      return (await reject(deps, lease, "blocked", "canary_runtime_missing"))
        ? "terminal"
        : "stale";
    }
    if (!workflow.canaryOperationId) {
      return (await reject(deps, lease, "blocked", "canary_operation_missing"))
        ? "terminal"
        : "stale";
    }
    const health = await deps.canaryRuntime.observe({
      runtimeId: workflow.canaryRuntimeId,
      operationId: workflow.canaryOperationId,
    });
    if (health.kind === "unhealthy") {
      return (await save(deps, lease, {
        state: "canary_cleanup",
        failureCode: health.code || "canary_unhealthy",
        cleanupDisposition: "reject",
        nextAttemptAt: null,
      }))
        ? "advanced"
        : "stale";
    }
    if (health.kind === "unknown") {
      // Missing observations must not leave the workflow immediately claimable.
      return (await save(deps, lease, { nextAttemptAt: nowMs + Math.min(retryMs, 5 * 60 * 1_000) })) ? "retried" : "stale";
    }

    const maxGap = deps.maxHealthGapMs ?? 2 * 5 * 60 * 1_000;
    const parsedEvidence = CanaryHealthEvidenceSchema.safeParse(health.evidence);
    if (
      !parsedEvidence.success ||
      parsedEvidence.data.artifactDigest !== workflow.canaryArtifactDigest ||
      parsedEvidence.data.runtimeId !== workflow.canaryRuntimeId ||
      parsedEvidence.data.operationId !== workflow.canaryOperationId ||
      workflow.lastHealthEvidence?.providerObservationId ===
        parsedEvidence.data.providerObservationId ||
      parsedEvidence.data.observedAt > nowMs ||
      nowMs - parsedEvidence.data.observedAt > maxGap ||
      (workflow.lastHealthyAt !== null && parsedEvidence.data.observedAt <= workflow.lastHealthyAt)
    ) {
      // Invalid/duplicate evidence waits for another bounded observation window.
      return (await save(deps, lease, { nextAttemptAt: nowMs + Math.min(retryMs, 5 * 60 * 1_000) })) ? "retried" : "stale";
    }
    const healthySince =
      workflow.healthySince === null ||
      workflow.lastHealthyAt === null ||
      workflow.lastHealthEvidence?.runtimeEpoch !== parsedEvidence.data.runtimeEpoch ||
      parsedEvidence.data.observedAt - workflow.lastHealthyAt > maxGap
        ? parsedEvidence.data.observedAt
        : workflow.healthySince;
    const healthyWindow = deps.healthWindowMs ?? STABLE_CANARY_HEALTH_WINDOW_MS;
    if (parsedEvidence.data.observedAt - healthySince < healthyWindow) {
      return (await save(deps, lease, {
        healthySince,
        lastHealthyAt: parsedEvidence.data.observedAt,
        lastHealthEvidence: parsedEvidence.data,
        nextAttemptAt: Math.min(healthySince + healthyWindow, nowMs + 5 * 60 * 1_000),
      }))
        ? "retried"
        : "stale";
    }
    return (await save(deps, lease, {
      state: "canary_cleanup",
      healthySince,
      lastHealthyAt: parsedEvidence.data.observedAt,
      lastHealthEvidence: parsedEvidence.data,
      cleanupDisposition: "promote",
      nextAttemptAt: null,
    }))
      ? "advanced"
      : "stale";
  }

  if (workflow.state === "canary_cleanup") {
    if (!workflow.canaryRuntimeId || !workflow.cleanupDisposition) {
      return (await reject(deps, lease, "blocked", "canary_cleanup_state_invalid"))
        ? "terminal"
        : "stale";
    }
    if (!workflow.canaryOperationId) {
      return (await reject(deps, lease, "blocked", "canary_operation_missing"))
        ? "terminal"
        : "stale";
    }
    const stopped = await deps.canaryRuntime.stop({
      runtimeId: workflow.canaryRuntimeId,
      startedOperationId: workflow.canaryOperationId,
      idempotencyKey: `stable-canary-stop:${candidate.id}`,
    });
    if (stopped.kind === "blocked") {
      return (await save(deps, lease, {
        nextAttemptAt: nowMs + Math.min(retryMs, 5 * 60 * 1_000),
        failureCode: "canary_stop_blocked",
      })) ? "retried" : "stale";
    }
    if (stopped.kind === "pending") {
      return (await save(deps, lease, { nextAttemptAt: nowMs + Math.min(retryMs, 5 * 60 * 1_000) }))
        ? "retried"
        : "stale";
    }
    const parsedCleanup = CanaryCleanupEvidenceSchema.safeParse(stopped.evidence);
    const maxCleanupEvidenceAge = deps.maxHealthGapMs ?? 2 * 5 * 60 * 1_000;
    if (
      !parsedCleanup.success ||
      parsedCleanup.data.operationId.length === 0 ||
      parsedCleanup.data.startedOperationId !== workflow.canaryOperationId ||
      parsedCleanup.data.writerAbsence.instanceId !== workflow.canaryRuntimeId ||
      parsedCleanup.data.observedAt > nowMs ||
      nowMs - parsedCleanup.data.observedAt > maxCleanupEvidenceAge ||
      parsedCleanup.data.writerAbsence.censusObservedAt > parsedCleanup.data.observedAt ||
      (workflow.lastHealthEvidence !== null &&
        parsedCleanup.data.writerAbsence.retiredEpoch !==
          workflow.lastHealthEvidence.runtimeEpoch) ||
      nowMs - parsedCleanup.data.writerAbsence.censusObservedAt > maxCleanupEvidenceAge
    ) {
      return (await save(deps, lease, { nextAttemptAt: nowMs + Math.min(retryMs, 5 * 60 * 1_000) }))
        ? "retried"
        : "stale";
    }
    if (workflow.cleanupDisposition === "reject") {
      return (await save(deps, lease, {
        state: "rejected",
        canaryCleanupComplete: true,
        cleanupEvidence: parsedCleanup.data,
        nextAttemptAt: null,
      }))
        ? "terminal"
        : "stale";
    }
    return (await save(deps, lease, {
      state: "promoting",
      canaryCleanupComplete: true,
      cleanupEvidence: parsedCleanup.data,
      nextAttemptAt: null,
      failureCode: null,
    }))
      ? "advanced"
      : "stale";
  }

  if (workflow.state === "promoting") {
    const admission = await ensureCandidateIsAdmitted(deps, lease);
    if (admission === "retry") {
      return (await retry(deps, lease, "release_evidence_unavailable_before_promotion", nowMs))
        ? "retried"
        : "stale";
    }
    if (admission === "rejected") {
      return (await reject(deps, lease, "rejected", "release_evidence_rejected_before_promotion"))
        ? "terminal"
        : "stale";
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { channelRevision, current } = await stableVersion(deps);
      if (current?.id === candidate.id) {
        return (await save(deps, lease, {
          state: "promoted",
          nextAttemptAt: null,
          failureCode: null,
        }))
          ? "advanced"
          : "stale";
      }
      if (current && compareReleaseVersions(candidate.version, current.version) <= 0) {
        return (await reject(deps, lease, "superseded", "newer_release_already_stable"))
          ? "terminal"
          : "stale";
      }
      const result = await deps.releases.promoteStable({
        releaseId: candidate.id,
        expectedRevision: channelRevision,
        promotedAt: deps.clock.now(),
      });
      if (result === "promoted") {
        return (await save(deps, lease, {
          state: "promoted",
          nextAttemptAt: null,
          failureCode: null,
        }))
          ? "advanced"
          : "stale";
      }
      if (result === "ineligible") {
        return (await reject(deps, lease, "rejected", "candidate_is_not_admitted"))
          ? "terminal"
          : "stale";
      }
    }
    return (await retry(deps, lease, "stable_channel_cas_conflict", nowMs)) ? "retried" : "stale";
  }

  if (workflow.state === "promoted" || workflow.state === "rolling_out") {
    const stableChannel = await deps.releases.getStableChannel();
    if (stableChannel.currentReleaseId !== candidate.id) {
      return (await reject(deps, lease, "superseded", "newer_release_is_stable"))
        ? "terminal"
        : "stale";
    }
  }

  if (workflow.state === "promoted") {
    return (await save(deps, lease, {
      state: "rolling_out",
      followerCursor: null,
      followerPlanningComplete: false,
      nextAttemptAt: null,
    }))
      ? "advanced"
      : "stale";
  }

  if (workflow.state === "rolling_out") {
    if (!workflow.followerPlanningComplete) {
      const planned = await deps.rolloutPlanner.planNextPage({
        release: candidate,
        cursor: workflow.followerCursor,
        limit: FOLLOWER_PAGE_SIZE,
        at: deps.clock.now(),
      });
      if (planned.kind === "stale") {
        return (await retry(deps, lease, "rollout_fanout_cursor_conflict", nowMs))
          ? "retried"
          : "stale";
      }
      const complete = planned.complete;
      return (await save(deps, lease, {
        followerCursor: planned.nextCursor,
        followerPlanningComplete: complete,
        nextAttemptAt: null,
      }))
        ? "advanced"
        : "stale";
    }
    if (await deps.rolloutPlanner.hasUnsettledRollouts(candidate.id)) {
      return (await save(deps, lease, { nextAttemptAt: nowMs + retryMs })) ? "retried" : "stale";
    }
    return (await save(deps, lease, { state: "complete", nextAttemptAt: null }))
      ? "terminal"
      : "stale";
  }

  return (await reject(deps, lease, "blocked", "unknown_candidate_workflow_state"))
    ? "terminal"
    : "stale";
}

/** Advances a bounded number of durable promotion workflows. */
export async function advanceStablePromotions(
  deps: ReleasePromotionDeps,
  input: {
    readonly limit?: number;
    readonly leaseMs?: number;
    readonly releaseId?: string;
  } = {},
): Promise<PromotionBatchResult> {
  const limit = Math.max(1, Math.min(10, Math.trunc(input.limit ?? 2)));
  const leases = await deps.releases.claimCandidateWork({
    owner: deps.workerId,
    now: deps.clock.nowMs(),
    leaseMs: Math.max(10_000, Math.min(5 * 60 * 1_000, input.leaseMs ?? CANDIDATE_LEASE_MS)),
    limit,
    ...(input.releaseId === undefined ? {} : { releaseId: input.releaseId }),
  });
  const result = { claimed: leases.length, advanced: 0, retried: 0, terminal: 0 };
  for (const lease of leases) {
    try {
      const outcome = await advanceCandidate(deps, lease);
      if (outcome === "advanced") result.advanced += 1;
      else if (outcome === "retried") result.retried += 1;
      else if (outcome === "terminal") result.terminal += 1;
    } catch {
      await retry(deps, lease, "promotion_step_failed", deps.clock.nowMs());
      result.retried += 1;
    }
  }
  return result;
}
