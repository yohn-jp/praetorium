import type { ReleaseCandidate } from "../releases/model.js";
import type {
  StableFollower,
  StableRollout,
  StableRolloutDeps,
  StableRolloutPlanner,
} from "./model.js";

const DEFAULT_ROLLOUT_LEASE_MS = 2 * 60 * 1_000;
const DEFAULT_RETRY_MS = 5 * 60 * 1_000;

type RolloutPatch = Partial<Omit<StableRollout, "id" | "revision" | "updatedAt">>;

async function saveRollout(
  deps: StableRolloutDeps,
  rollout: StableRollout,
  patch: RolloutPatch,
): Promise<boolean> {
  return (
    (await deps.rollouts.saveRollout({
      rollout: { ...rollout, ...patch, updatedAt: deps.clock.now() },
      expectedRevision: rollout.revision,
      at: deps.clock.now(),
    })) === "saved"
  );
}

function hasChangedSincePlan(current: StableFollower, planned: StableFollower): boolean {
  return (
    current.repositoryId !== planned.repositoryId ||
    current.bindingEpoch !== planned.bindingEpoch ||
    current.authorizationRevision !== planned.authorizationRevision ||
    current.clusterId !== planned.clusterId ||
    current.generation !== planned.generation ||
    current.runtimeEpoch !== planned.runtimeEpoch ||
    current.configurationRevision !== planned.configurationRevision ||
    current.policy !== planned.policy ||
    current.desiredState !== planned.desiredState ||
    current.desiredReleaseId !== planned.desiredReleaseId ||
    current.desiredArtifactDigest !== planned.desiredArtifactDigest ||
    current.currentArtifactDigest !== planned.currentArtifactDigest ||
    current.selectedModuleIds.join("\u0000") !== planned.selectedModuleIds.join("\u0000") ||
    current.resourceProfileId !== planned.resourceProfileId ||
    current.platform !== planned.platform
  );
}

function clearBuild(rollout: StableRollout): RolloutPatch {
  return {
    snapshot: rollout.snapshot,
    state: "pending",
    buildKey: null,
    buildId: null,
    artifactDigest: null,
    deploymentRevisionId: null,
    operationId: null,
    failureCode: null,
    nextAttemptAt: null,
  };
}

export function createStableRolloutPlanner(deps: StableRolloutDeps): StableRolloutPlanner {
  return {
    async planNextPage(input) {
      const page = await deps.followers.listInstances(input.cursor, input.limit);
      const eligible = page.items.filter((follower) => follower.policy === "stable");
      const result = await deps.rollouts.recordFollowerPage({
        releaseId: input.release.id,
        expectedCursor: input.cursor,
        page: { items: eligible, nextCursor: page.nextCursor },
        at: input.at,
      });
      if (result === "stale") {
        return { kind: "stale", nextCursor: input.cursor };
      }
      return {
        kind: "planned",
        nextCursor: page.nextCursor,
        complete: page.nextCursor === null,
        planned: eligible.length,
      };
    },
    hasUnsettledRollouts(releaseId) {
      return deps.rollouts.hasUnsettledRollouts(releaseId);
    },
  };
}

async function settleActiveOperation(
  deps: StableRolloutDeps,
  rollout: StableRollout,
): Promise<"settled" | "waiting" | "stale"> {
  if (!rollout.operationId) {
    await saveRollout(deps, rollout, { state: "blocked", failureCode: "operation_id_missing" });
    return "settled";
  }
  const lease = await deps.rollouts.findClusterLease(rollout.clusterId);
  if (!lease || lease.rolloutId !== rollout.id || lease.activeOperationId !== rollout.operationId) {
    // A missing fence is not proof that its runtime effect stopped. Keep the
    // plan blocked for inspection rather than creating a replacement writer.
    await saveRollout(deps, rollout, { state: "blocked", failureCode: "cluster_fence_missing" });
    return "settled";
  }
  const operation = await deps.operations.observe(rollout.operationId);
  if (operation.operationId !== rollout.operationId) {
    await deps.rollouts.renewClusterLease({
      lease,
      now: deps.clock.nowMs(),
      leaseMs: DEFAULT_ROLLOUT_LEASE_MS,
    });
    return "waiting";
  }
  if (
    operation.status === "pending" ||
    operation.status === "claimed" ||
    operation.status === "running"
  ) {
    await deps.rollouts.renewClusterLease({
      lease,
      now: deps.clock.nowMs(),
      leaseMs: DEFAULT_ROLLOUT_LEASE_MS,
    });
    return "waiting";
  }
  if (operation.status === "unknown" || operation.status === "missing") {
    await deps.rollouts.renewClusterLease({
      lease,
      now: deps.clock.nowMs(),
      leaseMs: DEFAULT_ROLLOUT_LEASE_MS,
    });
    return "waiting";
  }
  const result = await deps.rollouts.setOperationResult({
    rolloutId: rollout.id,
    expectedRevision: rollout.revision,
    operation,
    at: deps.clock.now(),
  });
  return result === "saved" ? "settled" : "stale";
}

async function advanceRollout(
  deps: StableRolloutDeps,
  rollout: StableRollout,
): Promise<"advanced" | "waiting" | "settled" | "stale"> {
  if (rollout.state === "operation_pending") {
    return settleActiveOperation(deps, rollout);
  }
  if (
    rollout.state === "complete" ||
    rollout.state === "deferred_stopped" ||
    rollout.state === "skipped_pinned" ||
    rollout.state === "blocked" ||
    rollout.state === "superseded"
  ) {
    return "settled";
  }

  const release = await deps.releases.findById(rollout.releaseId);
  if (!release || release.status !== "available") {
    await saveRollout(deps, rollout, {
      state: "blocked",
      failureCode: "target_release_not_promoted",
    });
    return "settled";
  }
  const stableChannel = await deps.releases.getStableChannel();
  if (stableChannel.currentReleaseId !== release.id) {
    await saveRollout(deps, rollout, {
      state: "superseded",
      failureCode: "newer_release_is_stable",
    });
    return "settled";
  }
  const current = await deps.followers.findCurrent(rollout.instanceId);
  if (!current) {
    await saveRollout(deps, rollout, { state: "superseded", failureCode: "instance_missing" });
    return "settled";
  }
  if (current.policy === "pinned") {
    await saveRollout(deps, rollout, { state: "skipped_pinned", failureCode: null });
    return "settled";
  }
  if (current.desiredState === "stopped") {
    await saveRollout(deps, rollout, { state: "deferred_stopped", failureCode: null });
    return "settled";
  }

  if (hasChangedSincePlan(current, rollout.snapshot)) {
    const refreshed = await saveRollout(deps, rollout, {
      ...clearBuild(rollout),
      snapshot: current,
      clusterId: current.clusterId,
    });
    return refreshed ? "advanced" : "stale";
  }

  if (
    rollout.state === "pending" ||
    rollout.state === "building" ||
    rollout.state === "waiting_build"
  ) {
    const composition = await deps.composition.compose({
      release,
      follower: current,
      idempotencyKey: `stable-rollout-build:${release.id}:${current.instanceId}:${current.configurationRevision}`,
    });
    if (composition.kind === "pending") {
      await saveRollout(deps, rollout, {
        state: "waiting_build",
        buildKey: composition.buildKey,
        buildId: composition.buildId,
        nextAttemptAt: composition.retryAt,
        failureCode: null,
      });
      return "waiting";
    }
    if (composition.kind === "failed") {
      await saveRollout(deps, rollout, {
        state: composition.retryable ? "waiting_build" : "blocked",
        failureCode: composition.code,
        nextAttemptAt: composition.retryable ? deps.clock.nowMs() + DEFAULT_RETRY_MS : null,
      });
      return composition.retryable ? "waiting" : "settled";
    }
    const saved = await saveRollout(deps, rollout, {
      state: "dispatch_pending",
      buildKey: composition.buildKey,
      buildId: composition.buildId,
      artifactDigest: composition.artifactDigest,
      deploymentRevisionId: composition.deploymentRevisionId,
      failureCode: null,
      nextAttemptAt: null,
    });
    return saved ? "advanced" : "stale";
  }

  // The compose result is persisted before this point. Re-fetch the instance
  // immediately before dispatch so a stop/pin/configuration change can fence
  // an old stable update.
  const latest = await deps.followers.findCurrent(current.instanceId);
  if (!latest) {
    await saveRollout(deps, rollout, { state: "superseded", failureCode: "instance_missing" });
    return "settled";
  }
  if (latest.policy === "pinned") {
    await saveRollout(deps, rollout, { state: "skipped_pinned", failureCode: null });
    return "settled";
  }
  if (hasChangedSincePlan(latest, current)) {
    await saveRollout(deps, rollout, {
      ...clearBuild(rollout),
      snapshot: latest,
      clusterId: latest.clusterId,
    });
    return "advanced";
  }
  if (latest.desiredState === "stopped") {
    await saveRollout(deps, rollout, { state: "deferred_stopped", failureCode: null });
    return "settled";
  }
  if (
    !rollout.deploymentRevisionId ||
    !rollout.artifactDigest ||
    !rollout.buildKey ||
    !rollout.buildId
  ) {
    await saveRollout(deps, rollout, {
      state: "blocked",
      failureCode: "composed_artifact_missing",
    });
    return "settled";
  }
  if (
    latest.desiredArtifactDigest === rollout.artifactDigest &&
    latest.currentArtifactDigest === rollout.artifactDigest
  ) {
    await saveRollout(deps, rollout, { state: "complete", failureCode: null });
    return "settled";
  }

  const lease = await deps.rollouts.claimClusterLease({
    clusterId: rollout.clusterId,
    rolloutId: rollout.id,
    owner: deps.workerId,
    now: deps.clock.nowMs(),
    leaseMs: DEFAULT_ROLLOUT_LEASE_MS,
  });
  if (!lease) return "waiting";
  const dispatch = await deps.rollouts.dispatchUnderClusterLease({
    lease,
    rollout,
    current: latest,
    actorId: "system:stable-release",
    idempotencyKey: `stable-rollout:${rollout.releaseId}:${rollout.instanceId}:${latest.generation}:${rollout.buildKey}`,
    at: deps.clock.now(),
  });
  if (dispatch.kind === "dispatched") return "advanced";
  if (dispatch.kind === "lease_lost") return "stale";
  await deps.rollouts.releaseClusterLease(lease);
  if (dispatch.kind === "pinned") {
    await saveRollout(deps, rollout, { state: "skipped_pinned", failureCode: null });
    return "settled";
  }
  if (dispatch.kind === "stopped") {
    await saveRollout(deps, rollout, { state: "deferred_stopped", failureCode: null });
    return "settled";
  }
  await saveRollout(deps, rollout, {
    ...clearBuild(rollout),
    snapshot: latest,
  });
  return "advanced";
}

/** Plans all stable followers and advances a bounded set of cluster rollouts. */
export async function runStableRolloutBatch(
  deps: StableRolloutDeps,
  input: { readonly limit?: number } = {},
): Promise<{
  readonly considered: number;
  readonly advanced: number;
  readonly waiting: number;
  readonly settled: number;
}> {
  const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 25)));
  const rollouts = await deps.rollouts.listDueRollouts(deps.clock.nowMs(), limit);
  const result = { considered: rollouts.length, advanced: 0, waiting: 0, settled: 0 };
  for (const rollout of rollouts) {
    try {
      const outcome = await advanceRollout(deps, rollout);
      if (outcome === "advanced") result.advanced += 1;
      else if (outcome === "waiting") result.waiting += 1;
      else if (outcome === "settled") result.settled += 1;
    } catch {
      const current = await deps.rollouts.findRollout(rollout.id);
      if (
        current &&
        current.revision === rollout.revision &&
        current.state !== "operation_pending"
      ) {
        await saveRollout(deps, current, {
          state: "waiting_build",
          failureCode: "rollout_step_failed",
          nextAttemptAt: deps.clock.nowMs() + DEFAULT_RETRY_MS,
        });
      }
      result.waiting += 1;
    }
  }
  return result;
}

export type StableRolloutReleaseInput = {
  readonly release: ReleaseCandidate;
  readonly cursor: string | null;
  readonly limit: number;
};
