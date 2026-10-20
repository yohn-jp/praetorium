import { WorkAvailability } from "@praetorium/application";
import { physicalInstanceId } from "@praetorium/contracts";
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

const INSTANCE_ID = "ins_01M56ESTANTNHV8BA5J1PCNNQJ";
const PHYSICAL_INSTANCE_ID = physicalInstanceId(INSTANCE_ID, 5, null);

function claimed(): ClaimedProvisionerOperation {
  const now = Date.now();
  return {
    operation: {
      id: "op_01",
      instanceId: INSTANCE_ID,
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
      instance: {
        generation: 2,
        observedState: "ready",
      } as ClaimedProvisionerOperation["snapshot"]["instance"],
    },
    reservation: null,
    currentReservation: null,
    deploymentRevision: null,
    currentDeploymentRevision: null,
    runtimeContext: {
      current: null,
      target: {
        revisionId: "rev-target",
        artifactRef: `registry.example/scriptorium@sha256:${"b".repeat(64)}`,
        legacyRuntimeEpoch: null,
        assignment: {
          instanceId: PHYSICAL_INSTANCE_ID,
          repositoryId: 123456,
          runtimeEpoch: 5,
          imageDigest: `sha256:${"b".repeat(64)}`,
        },
      } as ClaimedProvisionerOperation["runtimeContext"]["target"],
    },
  } as ClaimedProvisionerOperation;
}

function actualAssignment(generation = 2, runtimeEpoch = 5): RuntimeAssignment {
  return {
    instanceId: INSTANCE_ID,
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
  it("reports target readiness at route activation before releasing the old reservation", async () => {
    const controller = new AbortController();
    const reports: Array<Record<string, unknown>> = [];
    const onOperationSettled = vi.fn();
    let firstClaim = true;
    const claim = claimed();
    const readyObservation = {
      instanceId: INSTANCE_ID,
      repositoryId: 123456,
      generation: 2,
      runtimeEpoch: 5,
      observedState: "ready",
      observedArtifactDigest: `sha256:${"b".repeat(64)}`,
      observedRevisionId: "rev-target",
    };
    const releaseRuntime = vi.fn(async () => {
      expect(reports.at(-1)?.observation).toMatchObject(readyObservation);
    });
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
      releaseRuntime,
    } as unknown as ProvisionerOperationService;
    const executor = {
      async execute(_claim: ClaimedProvisionerOperation, context: LifecycleExecutionContext) {
        await context.report?.("starting-target");
        await context.report?.("target-ready", {
          instanceId: INSTANCE_ID,
          repositoryId: "123456",
          generation: "2",
          clusterId: "cluster-a",
          runtimeEpoch: "5",
          revisionId: "rev-target",
          imageDigest: `sha256:${"b".repeat(64)}`,
        });
        await context.report?.("route-activated", {
          instanceId: INSTANCE_ID,
          repositoryId: "123456",
          generation: "2",
          clusterId: "cluster-a",
          runtimeEpoch: "5",
          revisionId: "rev-target",
          imageDigest: `sha256:${"b".repeat(64)}`,
        });
        await releaseRuntime();
        return { status: "complete", observed: actualAssignment() } as LifecycleResult;
      },
    };
    const worker = new ProvisionerWorker({
      operations,
      executor,
      workerId: "worker-a",
      clusterId: "cluster-a",
      onOperationSettled,
      recoveryIntervalMs: 100,
      retryIntervalMs: 100,
    });

    await worker.run(controller.signal);

    expect(reports).toHaveLength(4);
    expect(reports[0]).toMatchObject({ observation: null });
    expect(reports[0]).not.toHaveProperty("terminal");
    expect(reports[1]).toMatchObject({ observation: null });
    expect(reports[2]).toMatchObject({ observation: readyObservation });
    expect(reports[2]).not.toHaveProperty("terminal");
    expect(reports[3]).toMatchObject({
      terminal: "succeeded",
      observation: {
        ...readyObservation,
      },
    });
    expect(reports[3]?.observation).not.toHaveProperty("operationId");
    expect(releaseRuntime).toHaveBeenCalledOnce();
    expect(onOperationSettled).toHaveBeenCalledOnce();
    expect(onOperationSettled).toHaveBeenCalledWith(claim.operation.instanceId);
  });

  it("does not report rollback route readiness as the admitted target", async () => {
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
    const worker = new ProvisionerWorker({
      operations,
      executor: {
        async execute(_claim: ClaimedProvisionerOperation, context: LifecycleExecutionContext) {
          await context.report?.("route-activated", {
            instanceId: INSTANCE_ID,
            repositoryId: "123456",
            generation: "2",
            clusterId: "cluster-a",
            runtimeEpoch: "6",
            revisionId: "rev-previous",
            imageDigest: `sha256:${"c".repeat(64)}`,
          });
          return { status: "failed", code: "rollback_complete", reason: "test" } as LifecycleResult;
        },
      },
      workerId: "worker-a",
      clusterId: "cluster-a",
      recoveryIntervalMs: 100,
      retryIntervalMs: 100,
    });

    await worker.run(controller.signal);

    expect(reports).toHaveLength(2);
    expect(reports[0]).toMatchObject({ observation: null });
    expect(reports[1]).toMatchObject({ terminal: "failed", observation: null });
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
        executor: {
          async execute() {
            return { status: "blocked", code: "test", reason: "test" };
          },
        },
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

  it("backs claim failures off to the bounded recovery interval", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      let calls = 0;
      const operations = {
        async claimNext() {
          calls += 1;
          throw new Error("control_plane_unavailable");
        },
      } as unknown as ProvisionerOperationService;
      const worker = new ProvisionerWorker({
        operations,
        executor: {
          async execute() {
            return { status: "blocked", code: "test", reason: "test" };
          },
        },
        workerId: "worker-a",
        clusterId: "cluster-a",
        retryIntervalMs: 5_000,
        recoveryIntervalMs: 300_000,
      });

      const running = worker.run(controller.signal);
      await vi.waitFor(() => expect(calls).toBe(1));
      await vi.advanceTimersByTimeAsync(300_000);
      controller.abort();
      await running;

      expect(calls).toBe(7);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers a missed work notification through the bounded claim and refreshes its instance", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      let claim!: ClaimedProvisionerOperation;
      const onOperationSettled = vi.fn();
      let calls = 0;
      let firstClaim!: () => void;
      const firstClaimed = new Promise<void>((resolve) => {
        firstClaim = resolve;
      });
      const operations = {
        async claimNext(input: { readonly signal: AbortSignal }) {
          calls += 1;
          if (calls === 1) {
            firstClaim();
            return null;
          }
          if (calls === 2) {
            claim = claimed();
            return claim;
          }
          return new Promise<null>((resolve) => {
            input.signal.addEventListener("abort", () => resolve(null), { once: true });
          });
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
          if (input.terminal !== undefined) controller.abort();
          return { operation: claim.operation, applied: true, duplicate: false };
        },
      } as unknown as ProvisionerOperationService;
      const worker = new ProvisionerWorker({
        operations,
        executor: {
          async execute() {
            return { status: "complete", observed: actualAssignment() } as LifecycleResult;
          },
        },
        workerId: "worker-a",
        clusterId: "cluster-a",
        onOperationSettled,
        recoveryIntervalMs: 300_000,
      });

      const running = worker.run(controller.signal);
      await firstClaimed;
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(300_000);
      await running;

      expect(calls).toBe(3);
      expect(onOperationSettled).toHaveBeenCalledWith(claim.operation.instanceId);
    } finally {
      vi.useRealTimers();
    }
  });
});
