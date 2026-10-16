import { describe, expect, it } from "vitest";
import type { ReleaseCandidate } from "../releases/model.js";
import type {
  ClusterRolloutLease,
  CompositionResult,
  StableFollower,
  StableRollout,
  StableRolloutDeps,
  StableRolloutRepository,
} from "./model.js";
import { runStableRolloutBatch } from "./service.js";

const TIME = "2026-01-01T00:00:00.000Z";
const RELEASE_DIGEST = `sha256:${"a".repeat(64)}`;

function release(): ReleaseCandidate {
  const revision = "a".repeat(40);
  return {
    schemaVersion: 1,
    id: "release-current",
    version: "2.0.0",
    imageRepository: "ghcr.io/example/runtime",
    imageDigest: RELEASE_DIGEST,
    catalog: {
      contractVersion: "scriptorium-build/v1",
      producerRevision: revision,
      runtimeBaseDigest: RELEASE_DIGEST,
      buildKitDigest: RELEASE_DIGEST,
      recipeDigest: RELEASE_DIGEST,
      lockDigest: RELEASE_DIGEST,
      sourceDigest: RELEASE_DIGEST,
      supportedPlatforms: ["linux/amd64"],
      modules: [],
      baseResources: { cpuMilli: 0, memoryMiB: 0, ephemeralStorageMiB: 0 },
      sharedResourceGroups: [],
      resourceProfiles: [],
    },
    runtimeMetadata: {
      contractVersion: "scriptorium-platform/v1",
      producerRevision: revision,
      listener: { port: 3000 },
      paths: {
        liveness: "/health/live",
        readiness: "/health/ready",
        metadata: "/api/platform/v1/metadata",
        shutdown: "/api/platform/v1/shutdown",
        status: "/api/platform/v1/status",
        quiesce: "/api/platform/v1/quiesce",
        resume: "/api/platform/v1/resume",
      },
      shutdownTimeoutSeconds: 30,
    },
    signatureRef: "https://evidence.example/signature",
    provenanceRef: "https://evidence.example/provenance",
    admission: {
      registryConfirmed: true,
      provenanceVerified: true,
      runtimeMetadataVerified: true,
      evidence: ["fixture"],
      verifiedAt: TIME,
    },
    status: "available",
    createdAt: TIME,
  };
}

function follower(overrides: Partial<StableFollower> = {}): StableFollower {
  return {
    instanceId: "instance-1",
    repositoryId: 101,
    bindingEpoch: 1,
    authorizationRevision: 1,
    clusterId: "cluster-a",
    generation: 4,
    runtimeEpoch: 2,
    desiredState: "running",
    policy: "stable",
    desiredReleaseId: null,
    desiredArtifactDigest: RELEASE_DIGEST,
    currentArtifactDigest: RELEASE_DIGEST,
    configurationRevision: "config-1",
    selectedModuleIds: ["spellcheck", "diagram"],
    resourceProfileId: "standard",
    platform: "linux/amd64",
    ...overrides,
  };
}

function rollout(snapshot = follower()): StableRollout {
  return {
    id: "rollout-1",
    releaseId: "release-current",
    instanceId: snapshot.instanceId,
    clusterId: snapshot.clusterId,
    snapshot,
    state: "pending",
    revision: 0,
    buildKey: null,
    buildId: null,
    artifactDigest: null,
    deploymentRevisionId: null,
    operationId: null,
    failureCode: null,
    nextAttemptAt: null,
    updatedAt: TIME,
  };
}

class FakeRollouts implements StableRolloutRepository {
  readonly rows = new Map<string, StableRollout>();
  dispatches = 0;
  compositions = 0;

  constructor(initial: StableRollout) {
    this.rows.set(initial.id, initial);
  }

  async recordFollowerPage(): Promise<"recorded"> {
    return "recorded";
  }

  async listDueRollouts(): Promise<readonly StableRollout[]> {
    return [...this.rows.values()].filter(
      (row) => row.state !== "complete" && row.state !== "blocked",
    );
  }

  async findRollout(id: string): Promise<StableRollout | null> {
    return this.rows.get(id) ?? null;
  }

  async saveRollout(input: {
    rollout: StableRollout;
    expectedRevision: number;
  }): Promise<"saved" | "stale"> {
    const current = this.rows.get(input.rollout.id);
    if (!current || current.revision !== input.expectedRevision) return "stale";
    this.rows.set(input.rollout.id, { ...input.rollout, revision: current.revision + 1 });
    return "saved";
  }

  async claimClusterLease(input: {
    clusterId: string;
    rolloutId: string;
    owner: string;
    now: number;
    leaseMs: number;
  }): Promise<ClusterRolloutLease> {
    return {
      clusterId: input.clusterId,
      rolloutId: input.rolloutId,
      owner: input.owner,
      epoch: 1,
      expiresAt: input.now + input.leaseMs,
      activeOperationId: null,
    };
  }

  async findClusterLease(): Promise<ClusterRolloutLease | null> {
    return null;
  }

  async renewClusterLease(): Promise<ClusterRolloutLease | null> {
    return null;
  }

  async releaseClusterLease(): Promise<boolean> {
    return true;
  }

  async dispatchUnderClusterLease(): Promise<{
    readonly kind: "dispatched";
    readonly operationId: string;
    readonly generation: number;
  }> {
    this.dispatches += 1;
    return { kind: "dispatched", operationId: `operation-${this.dispatches}`, generation: 5 };
  }

  async setOperationResult(): Promise<"saved"> {
    return "saved";
  }

  async hasUnsettledRollouts(): Promise<boolean> {
    return false;
  }
}

function deps(input: {
  readonly current?: StableFollower;
  readonly rollouts: FakeRollouts;
  readonly composition?: CompositionResult;
  readonly findCurrent?: () => StableFollower | null;
  readonly stableReleaseId?: string | null;
}): StableRolloutDeps {
  const current = input.current ?? follower();
  return {
    releases: {
      findById: async () => release(),
      getStableChannel: async () => ({
        currentReleaseId: input.stableReleaseId ?? "release-current",
      }),
    },
    followers: {
      listInstances: async () => ({ items: [], nextCursor: null }),
      findCurrent: async () => (input.findCurrent ? input.findCurrent() : current),
    },
    rollouts: input.rollouts,
    composition: {
      compose: async () => {
        input.rollouts.compositions += 1;
        if (input.composition) return input.composition;
        return {
          kind: "ready",
          buildKey: `build-${current.configurationRevision}`,
          buildId: "build-1",
          artifactDigest: `sha256:${"b".repeat(64)}`,
          deploymentRevisionId: `revision-${current.configurationRevision}`,
        };
      },
    },
    operations: { observe: async (operationId) => ({ operationId, status: "missing" }) },
    clock: { nowMs: () => Date.parse(TIME), now: () => TIME },
    workerId: "rollout-worker",
  };
}

describe("stable rollout service", () => {
  it("preserves pinned and stopped followers without composing or dispatching", async () => {
    for (const [state, expected] of [
      [follower({ policy: "pinned" }), "skipped_pinned"],
      [follower({ desiredState: "stopped" }), "deferred_stopped"],
    ] as const) {
      const rows = new FakeRollouts(rollout(state));
      await runStableRolloutBatch(deps({ current: state, rollouts: rows }));
      expect(rows.rows.get("rollout-1")?.state).toBe(expected);
      expect(rows.compositions).toBe(0);
      expect(rows.dispatches).toBe(0);
    }
  });

  it("blocks an incompatible add-on composition without changing desired/current artifact", async () => {
    const initial = follower();
    const rows = new FakeRollouts(rollout(initial));
    const result = await runStableRolloutBatch(
      deps({
        current: initial,
        rollouts: rows,
        composition: { kind: "failed", code: "selected_module_missing", retryable: false },
      }),
    );
    expect(result.settled).toBe(1);
    expect(rows.rows.get("rollout-1")?.state).toBe("blocked");
    expect(rows.rows.get("rollout-1")?.failureCode).toBe("selected_module_missing");
    expect(initial.desiredArtifactDigest).toBe(RELEASE_DIGEST);
    expect(initial.currentArtifactDigest).toBe(RELEASE_DIGEST);
    expect(rows.dispatches).toBe(0);
  });

  it("throws away an old build when newer desired configuration arrives before dispatch", async () => {
    const before = follower();
    const after = follower({
      generation: before.generation + 1,
      configurationRevision: "config-2",
      selectedModuleIds: ["spellcheck", "calendar"],
    });
    const rows = new FakeRollouts(rollout(before));
    let current = before;
    const dependencies = deps({ rollouts: rows, findCurrent: () => current });

    await runStableRolloutBatch(dependencies);
    expect(rows.rows.get("rollout-1")?.state).toBe("dispatch_pending");
    current = after;
    await runStableRolloutBatch(dependencies);

    const refreshed = rows.rows.get("rollout-1")!;
    expect(refreshed.state).toBe("pending");
    expect(refreshed.snapshot.configurationRevision).toBe("config-2");
    expect(refreshed.snapshot.selectedModuleIds).toEqual(["spellcheck", "calendar"]);
    expect(refreshed.buildKey).toBeNull();
    expect(refreshed.artifactDigest).toBeNull();
    expect(rows.dispatches).toBe(0);
  });

  it("refreshes a composed target when the resource profile changes", async () => {
    const before = follower();
    const after = follower({
      generation: before.generation + 1,
      configurationRevision: "config-2",
      resourceProfileId: "large",
    });
    const rows = new FakeRollouts(rollout(before));
    let current = before;
    const dependencies = deps({ rollouts: rows, findCurrent: () => current });

    await runStableRolloutBatch(dependencies);
    expect(rows.rows.get("rollout-1")?.state).toBe("dispatch_pending");
    current = after;
    await runStableRolloutBatch(dependencies);

    const refreshed = rows.rows.get("rollout-1")!;
    expect(refreshed.state).toBe("pending");
    expect(refreshed.snapshot.resourceProfileId).toBe("large");
    expect(refreshed.buildKey).toBeNull();
    expect(rows.dispatches).toBe(0);
  });

  it("does not dispatch an older candidate after stable advances", async () => {
    const initial = follower();
    const rows = new FakeRollouts(rollout(initial));
    await runStableRolloutBatch(
      deps({ current: initial, rollouts: rows, stableReleaseId: "release-newer" }),
    );
    expect(rows.rows.get("rollout-1")?.state).toBe("superseded");
    expect(rows.compositions).toBe(0);
    expect(rows.dispatches).toBe(0);
  });
});
