import type { CursorPage, ReleaseCandidate } from "../releases/model.js";

export type StableFollower = {
  readonly instanceId: string;
  readonly repositoryId: number;
  readonly bindingEpoch: number;
  readonly authorizationRevision: number;
  readonly clusterId: string;
  readonly generation: number;
  readonly runtimeEpoch: number;
  readonly desiredState: "running" | "stopped";
  readonly policy: "stable" | "pinned";
  readonly desiredReleaseId: string | null;
  readonly desiredArtifactDigest: string | null;
  readonly currentArtifactDigest: string | null;
  readonly configurationRevision: string;
  readonly selectedModuleIds: readonly string[];
  readonly resourceProfileId: string;
  readonly platform: "linux/amd64" | "linux/arm64";
};

export type StableRolloutState =
  | "pending"
  | "building"
  | "waiting_build"
  | "dispatch_pending"
  | "operation_pending"
  | "complete"
  | "deferred_stopped"
  | "skipped_pinned"
  | "blocked"
  | "superseded";

export type StableRollout = {
  readonly id: string;
  readonly releaseId: string;
  readonly instanceId: string;
  readonly clusterId: string;
  readonly snapshot: StableFollower;
  readonly state: StableRolloutState;
  readonly revision: number;
  readonly buildKey: string | null;
  readonly buildId: string | null;
  readonly artifactDigest: string | null;
  readonly deploymentRevisionId: string | null;
  readonly operationId: string | null;
  readonly failureCode: string | null;
  readonly nextAttemptAt: number | null;
  readonly updatedAt: string;
};

export type ClusterRolloutLease = {
  readonly clusterId: string;
  readonly rolloutId: string;
  readonly owner: string;
  readonly epoch: number;
  readonly expiresAt: number;
  readonly activeOperationId: string | null;
};

export type CompositionResult =
  | {
      readonly kind: "ready";
      readonly buildKey: string;
      readonly buildId: string;
      readonly artifactDigest: string;
      readonly deploymentRevisionId: string;
    }
  | {
      readonly kind: "pending";
      readonly buildKey: string;
      readonly buildId: string;
      readonly retryAt: number;
    }
  | { readonly kind: "failed"; readonly code: string; readonly retryable: boolean };

export type OperationObservation =
  | { readonly operationId: string; readonly status: "pending" | "claimed" | "running" }
  | { readonly operationId: string; readonly status: "succeeded" }
  | { readonly operationId: string; readonly status: "failed" | "blocked"; readonly code: string }
  | { readonly operationId: string; readonly status: "missing" | "unknown" };

export interface StableFollowerRepository {
  listInstances(cursor: string | null, limit: number): Promise<CursorPage<StableFollower>>;
  findCurrent(instanceId: string): Promise<StableFollower | null>;
}

export interface StableRolloutRepository {
  /** Persist page plans and its cursor as one idempotent operation. */
  recordFollowerPage(input: {
    readonly releaseId: string;
    readonly expectedCursor: string | null;
    readonly page: CursorPage<StableFollower>;
    readonly at: string;
  }): Promise<"recorded" | "stale">;
  listDueRollouts(now: number, limit: number): Promise<readonly StableRollout[]>;
  findRollout(id: string): Promise<StableRollout | null>;
  saveRollout(input: {
    readonly rollout: StableRollout;
    readonly expectedRevision: number;
    readonly at: string;
  }): Promise<"saved" | "stale">;
  claimClusterLease(input: {
    readonly clusterId: string;
    readonly rolloutId: string;
    readonly owner: string;
    readonly now: number;
    readonly leaseMs: number;
  }): Promise<ClusterRolloutLease | null>;
  findClusterLease(clusterId: string): Promise<ClusterRolloutLease | null>;
  renewClusterLease(input: {
    readonly lease: ClusterRolloutLease;
    readonly now: number;
    readonly leaseMs: number;
  }): Promise<ClusterRolloutLease | null>;
  releaseClusterLease(lease: ClusterRolloutLease): Promise<boolean>;
  /**
   * Atomically validates the current lease, instance snapshot and policy,
   * then creates a normal `update` operation and records the operation ID.
   */
  dispatchUnderClusterLease(input: {
    readonly lease: ClusterRolloutLease;
    readonly rollout: StableRollout;
    readonly current: StableFollower;
    readonly actorId: string;
    readonly idempotencyKey: string;
    readonly at: string;
  }): Promise<
    | { readonly kind: "dispatched"; readonly operationId: string; readonly generation: number }
    | { readonly kind: "stale" }
    | { readonly kind: "pinned" }
    | { readonly kind: "stopped" }
    | { readonly kind: "lease_lost" }
  >;
  setOperationResult(input: {
    readonly rolloutId: string;
    readonly expectedRevision: number;
    readonly operation: OperationObservation;
    readonly at: string;
  }): Promise<"saved" | "stale">;
  hasUnsettledRollouts(releaseId: string): Promise<boolean>;
}

export interface CompositionProvider {
  compose(input: {
    readonly release: ReleaseCandidate;
    readonly follower: StableFollower;
    readonly idempotencyKey: string;
  }): Promise<CompositionResult>;
}

export interface RuntimeOperationProvider {
  observe(operationId: string): Promise<OperationObservation>;
}

export type FollowerPlanningResult = {
  readonly kind: "planned";
  readonly nextCursor: string | null;
  readonly complete: boolean;
  readonly planned: number;
};

export interface StableRolloutPlanner {
  planNextPage(input: {
    readonly release: ReleaseCandidate;
    readonly cursor: string | null;
    readonly limit: number;
    readonly at: string;
  }): Promise<
    FollowerPlanningResult | { readonly kind: "stale"; readonly nextCursor: string | null }
  >;
  hasUnsettledRollouts(releaseId: string): Promise<boolean>;
}

export interface StableRolloutDeps {
  readonly releases: {
    findById(id: string): Promise<ReleaseCandidate | null>;
    getStableChannel(): Promise<{ readonly currentReleaseId: string | null }>;
  };
  readonly followers: StableFollowerRepository;
  readonly rollouts: StableRolloutRepository;
  readonly composition: CompositionProvider;
  readonly operations: RuntimeOperationProvider;
  readonly clock: { nowMs(): number; now(): string };
  readonly workerId: string;
}
