import { WorkAvailability } from "@praetorium/application";
import { describe, expect, it, vi } from "vitest";
import type {
  LifecycleExecutionContext,
  LifecycleResult,
  RuntimeAssignment,
} from "@praetorium/application/lifecycle";
import type {
  ClaimedProvisionerOperation,
  ProvisionerOperationService,
} from "./operation-client.js";
import { ProvisionerWorker } from "./worker.js";

function claimed(): ClaimedProvisionerOperation {
  const now = Date.now();
  return {
    operation: {
      id: "op_01",
      instanceId: "ins_01",
      repositoryId: 123456,
      generation: 2,
      runtimeEpoch: 5,
      kind: "redeploy",
      status: "claimed",
      attempt: 1,
      leaseEpoch: 7,
      leaseToken: "lease-token",
      leaseExpiresAt: now + 60_000,
      reportSequence: 0,
      phase: "accepted",
      checkpointSequence: 0,
      checkpoint: null,
      clusterId: "cluster-a",
      reservationId: null,
      deploymentRevisionId: "rev-target",
      buildId: "build-target",
      prerequisiteBuildId: null,
    },
    snapshot: {
      binding: {} as ClaimedProvisionerOperation["snapshot"]["binding"],
      instance: { observedState: "ready" } as ClaimedProvisionerOperation["snapshot"]["instance"],
    },
    reservation: null,
    currentReservation: null,
    deploymentRevision: null,
    currentDeploymentRevision: null,
    runtimeContext: {
      current: null,
      target: {
        revisionId: "rev-target",
        assignment: { imageDigest: `sha256:${"b".repeat(64)}` },
      } as ClaimedProvisionerOperation["runtimeContext"]["target"],
    },
  } as ClaimedProvisionerOperation;
}

function actualAssignment(generation = 2, runtimeEpoch = 5): RuntimeAssignment {
  return {
    instanceId: "ins_01",
    repositoryId: 123456,
    generation,
    runtimeEpoch,
    deployment: {
      revisionId: "rev-target",
      imageDigest: `sha256:${"b".repeat(64)}`,
    },
  } as RuntimeAssignment;
}

describe("ProvisionerWorker observation reporting", () => {
  it("sends null for progress and only reports a successful exact target observation", async () => {
    const controller = new AbortController();
    const reports: Array<Record<string, unknown>> = [];
    let firstClaim = true;
    const claim = claimed();
    const operations = {
      async claimNext() {
        if (firstClaim) {
          firstClaim = false;
          return claim;
        }
        return null;
      },
      async heartbeat(input: {
        readonly operationId: string;
        readonly leaseEpoch: number;
        readonly leaseToken: string;
      }) {
        return {
          leaseExpiresAt: Date.now() + 60_000,
          operation: {
            ...claim.operation,
            id: input.operationId,
            leaseEpoch: input.leaseEpoch,
            leaseToken: input.leaseToken,
            leaseExpiresAt: Date.now() + 60_000,
          },
        };
      },
      async report(input: Record<string, unknown>) {
        reports.push(input);
        if (input.terminal !== undefined) controller.abort();
        return { operation: claim.operation, applied: true, duplicate: false };
      },
    } as unknown as ProvisionerOperationService;
    const executor = {
      async execute(_claim: ClaimedProvisionerOperation, context: LifecycleExecutionContext) {
        await context.report?.("starting-target");
        return { status: "complete", observed: actualAssignment() } as LifecycleResult;
      },
    };
    const worker = new ProvisionerWorker({
      operations,
      executor,
      workerId: "worker-a",
      clusterId: "cluster-a",
      recoveryIntervalMs: 100,
      retryIntervalMs: 100,
    });

    await worker.run(controller.signal);

    expect(reports).toHaveLength(2);
    expect(reports[0]).toMatchObject({ observation: null });
    expect(reports[0]).not.toHaveProperty("terminal");
    expect(reports[1]).toMatchObject({
      terminal: "succeeded",
      observation: {
        instanceId: "ins_01",
        repositoryId: 123456,
        generation: 2,
        runtimeEpoch: 5,
        observedState: "ready",
        observedArtifactDigest: `sha256:${"b".repeat(64)}`,
        observedRevisionId: "rev-target",
      },
    });
    expect(reports[1]?.observation).not.toHaveProperty("operationId");
  });

  it("blocks terminal success when the completed assignment differs from the operation target", async () => {
    const controller = new AbortController();
    const reports: Array<Record<string, unknown>> = [];
    let firstClaim = true;
    const claim = claimed();
    const operations = {
      async claimNext() {
        if (firstClaim) {
          firstClaim = false;
          return claim;
        }
        return null;
      },
      async heartbeat(input: {
        readonly operationId: string;
        readonly leaseEpoch: number;
        readonly leaseToken: string;
      }) {
        return {
          leaseExpiresAt: Date.now() + 60_000,
          operation: { ...claim.operation, ...input, leaseExpiresAt: Date.now() + 60_000 },
        };
      },
      async report(input: Record<string, unknown>) {
        reports.push(input);
        if (input.terminal !== undefined) controller.abort();
        return { operation: claim.operation, applied: true, duplicate: false };
      },
    } as unknown as ProvisionerOperationService;
    const executor = {
      async execute() {
        return { status: "complete", observed: actualAssignment(1, 4) } as LifecycleResult;
      },
    };
    const worker = new ProvisionerWorker({
      operations,
      executor,
      workerId: "worker-a",
      clusterId: "cluster-a",
      recoveryIntervalMs: 100,
      retryIntervalMs: 100,
    });

    await worker.run(controller.signal);

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ terminal: "blocked", observation: null });
  });

  it("claims immediately, then uses notifications and a bounded recovery claim", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const workAvailability = new WorkAvailability();
      let calls = 0;
      let resolveFirst!: () => void;
      let resolveSecond!: () => void;
      const firstClaim = new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
      const secondClaim = new Promise<void>((resolve) => {
        resolveSecond = resolve;
      });
      const operations = {
        async claimNext() {
          calls += 1;
          if (calls === 1) resolveFirst();
          if (calls === 2) resolveSecond();
          if (calls === 3) controller.abort();
          return null;
        },
      } as unknown as ProvisionerOperationService;
      const worker = new ProvisionerWorker({
        operations,
        executor: { async execute() { return { status: "blocked", code: "test", reason: "test" }; } },
        workerId: "worker-a",
        clusterId: "cluster-a",
        workAvailability,
        recoveryIntervalMs: 300_000,
      });

      const running = worker.run(controller.signal);
      await firstClaim;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(calls).toBe(1);

      workAvailability.notify();
      await secondClaim;
      expect(calls).toBe(2);

      await vi.advanceTimersByTimeAsync(300_000);
      await running;
      expect(calls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
