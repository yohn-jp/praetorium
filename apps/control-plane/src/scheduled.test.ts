import { describe, expect, it } from "vitest";
import type { ReleasePromotionDeps } from "@praetorium/application/releases";
import type { StableRolloutDeps } from "@praetorium/application/rollouts";
import { createScheduledHandler } from "./scheduled.js";

const TIME = "2026-01-01T00:00:00.000Z";
const NOW = Date.parse(TIME);

function dependencies(owners: string[], pageLimits: number[]) {
  const releases = {
    async findById() {
      return null;
    },
    async findByDigest() {
      return null;
    },
    async listCandidates(_cursor: string | null, limit: number) {
      pageLimits.push(limit);
      return { items: [], nextCursor: null };
    },
    async createCandidate() {
      return "duplicate" as const;
    },
    async getStableChannel() {
      return { key: "stable" as const, currentReleaseId: null, revision: 0, updatedAt: TIME };
    },
    async promoteStable() {
      return "conflict" as const;
    },
    async getDiscoveryCheckpoint() {
      return { cursor: null, revision: 0 };
    },
    async commitDiscoveryPage() {
      return "advanced" as const;
    },
    async claimCandidateWork(input: { readonly owner: string }) {
      owners.push(input.owner);
      return [];
    },
    async saveCandidateWorkflow() {
      return "stale" as const;
    },
    async hasUnsettledRollouts() {
      return false;
    },
  };
  const clock = { nowMs: () => NOW, now: () => TIME };
  const promotions: ReleasePromotionDeps = {
    releases,
    admission: {
      async verify() {
        return { kind: "retry", reason: "unused" };
      },
    },
    canaryComposition: {
      async compose() {
        return { kind: "failed", code: "unused", retryable: false };
      },
    },
    canaryRuntime: {
      async ensureRunning() {
        return { runtimeId: "canary", operationId: "operation" };
      },
      async observe() {
        return { kind: "unknown" };
      },
      async stop() {
        return { kind: "pending" };
      },
    },
    rolloutPlanner: {
      async planNextPage() {
        return { kind: "planned", nextCursor: null, complete: true, planned: 0 };
      },
      async hasUnsettledRollouts() {
        return false;
      },
    },
    clock,
    workerId: "release-worker",
  };
  const rollouts: StableRolloutDeps = {
    releases: {
      async findById() {
        return null;
      },
      async getStableChannel() {
        return { currentReleaseId: null };
      },
    },
    followers: {
      async listInstances() {
        return { items: [], nextCursor: null };
      },
      async findCurrent() {
        return null;
      },
    },
    rollouts: {
      async recordFollowerPage() {
        return "recorded";
      },
      async listDueRollouts() {
        return [];
      },
      async findRollout() {
        return null;
      },
      async saveRollout() {
        return "stale";
      },
      async claimClusterLease() {
        return null;
      },
      async findClusterLease() {
        return null;
      },
      async renewClusterLease() {
        return null;
      },
      async releaseClusterLease() {
        return false;
      },
      async dispatchUnderClusterLease() {
        return { kind: "stale" };
      },
      async setOperationResult() {
        return "stale";
      },
      async hasUnsettledRollouts() {
        return false;
      },
    },
    composition: {
      async compose() {
        return { kind: "failed", code: "unused", retryable: false };
      },
    },
    operations: {
      async observe(operationId) {
        return { operationId, status: "missing" };
      },
    },
    clock,
    workerId: "rollout-worker",
  };
  return { promotions, rollouts };
}

describe("Control Plane scheduled T11 entry point", () => {
  it("returns cleanly when release scheduling is disabled", async () => {
    const contextPromises: Promise<unknown>[] = [];
    const handler = createScheduledHandler(() => null);
    const result = await handler(
      { cron: "*/5 * * * *", scheduledTime: NOW },
      {},
      { waitUntil: (promise) => contextPromises.push(promise) },
    );

    expect(result).toEqual({ releaseWork: "disabled" });
    expect(contextPromises).toHaveLength(1);
    await expect(contextPromises[0]).resolves.toEqual(result);
  });

  it("scans one bounded page, schedules its promise and uses a unique owner per invocation", async () => {
    const owners: string[] = [];
    const pageLimits: number[] = [];
    const deps = dependencies(owners, pageLimits);
    const handler = createScheduledHandler(() => deps);
    const contextPromises: Promise<unknown>[] = [];
    const context = {
      waitUntil(promise: Promise<unknown>) {
        contextPromises.push(promise);
      },
    };
    const controller = { cron: "*/5 * * * *", scheduledTime: NOW };

    const first = await handler(controller, {}, context);
    const second = await handler(controller, {}, context);

    expect(first.discovery).toEqual({ kind: "advanced", discovered: 0, nextCursor: null });
    expect(second.rollouts.considered).toBe(0);
    expect(pageLimits).toEqual([50, 50]);
    expect(owners).toHaveLength(2);
    expect(owners[0]).not.toBe(owners[1]);
    expect(contextPromises).toHaveLength(2);
    await expect(contextPromises[0]).resolves.toEqual(first);
    await expect(contextPromises[1]).resolves.toEqual(second);
  });
});
