import { describe, expect, it } from "vitest";
import type { OperationRecord } from "@praetorium/application/instances";
import type { D1Database } from "@praetorium/persistence/d1";
import { createProvisionerRoutes } from "./provisioner-routes.js";
import type { OperationService } from "@praetorium/application/operations";
import { createCredentialRetirementBarrier } from "./credential-retirement.js";

const operation = {
  id: "op-retire",
  instanceId: "ins-retire",
  repositoryId: 17,
  kind: "stop",
  phase: "quiescing-old",
  checkpoint: {
    lifecycle: {
      quiesceRequest: {
        contractVersion: "scriptorium-platform/v1",
        operationId: "op-retire",
        instanceId: "ins-retire",
        runtimeEpoch: 4,
        reason: "stop",
        deadline: "2026-10-17T01:00:00.000Z",
      },
    },
  },
} as unknown as OperationRecord;
function database(read: () => { remaining: number } | null): D1Database {
  return {
    prepare: () => ({ bind: () => ({ first: async () => read() }) }),
  } as unknown as D1Database;
}

describe("known credential retirement barrier", () => {
  it("does not trust a Gateway success while authoritative pending records remain", async () => {
    let remaining = 1;
    const barrier = createCredentialRetirementBarrier({
      db: database(() => ({ remaining })),
      serviceSecret: "s".repeat(32),
      gateway: {
        async fetch(request) {
          expect(request.redirect).toBe("manual");
          expect(request.headers.get("Authorization")).toBe(`Bearer ${"s".repeat(32)}`);
          expect(await request.json()).toEqual({ repositoryId: 17, runtimeEpoch: 4 });
          return Response.json({ complete: true });
        },
      },
    });
    await expect(barrier(operation)).resolves.toBe(false);
    remaining = 0;
    await expect(barrier(operation)).resolves.toBe(true);
  });
  it("does not follow redirects from the private retirement callback", async () => {
    const barrier = createCredentialRetirementBarrier({
      db: database(() => ({ remaining: 1 })),
      serviceSecret: "s".repeat(32),
      gateway: {
        async fetch(request) {
          expect(request.redirect).toBe("manual");
          return new Response(null, {
            status: 302,
            headers: { Location: "https://untrusted.test/" },
          });
        },
      },
    });
    await expect(barrier(operation)).rejects.toThrow("service unavailable");
  });
  it("requires the retirement service for unexpired known credentials", async () => {
    const barrier = createCredentialRetirementBarrier({ db: database(() => ({ remaining: 1 })) });
    await expect(barrier(operation)).rejects.toThrow("service unavailable");
  });
  it("fails closed on unknown ledger state rather than treating it as an empty list", async () => {
    const barrier = createCredentialRetirementBarrier({ db: database(() => null) });
    await expect(barrier(operation)).rejects.toThrow("state unavailable");
  });
  it("rechecks D1 after the trusted revoker returns", async () => {
    let remaining = 1;
    const barrier = createCredentialRetirementBarrier({
      db: database(() => ({ remaining })),
      serviceSecret: "s".repeat(32),
      gateway: {
        async fetch() {
          remaining = 0;
          return Response.json({ complete: true });
        },
      },
    });
    await expect(barrier(operation)).resolves.toBe(true);
  });
  it("holds an already-absent old writer's credentials until durable revocation", async () => {
    let remaining = 1;
    const absent = {
      ...operation,
      phase: "old-writer-absent",
      checkpoint: {
        writerAbsenceProof: {
          instanceId: operation.instanceId,
          repositoryId: operation.repositoryId,
          retiredRuntimeEpoch: 4,
          remainingWriters: 0,
          source: "runtime-provider-census",
        },
      },
    } as unknown as OperationRecord;
    const barrier = createCredentialRetirementBarrier({
      db: database(() => ({ remaining })),
      serviceSecret: "s".repeat(32),
      gateway: {
        async fetch(request) {
          expect(await request.json()).toEqual({ repositoryId: 17, runtimeEpoch: 4 });
          return Response.json({ complete: true });
        },
      },
    });
    await expect(barrier(absent)).resolves.toBe(false);
    remaining = 0;
    await expect(barrier(absent)).resolves.toBe(true);
  });
  it("does not retire credentials for a null retired epoch", async () => {
    const barrier = createCredentialRetirementBarrier({
      db: database(() => {
        throw new Error("unexpected credential lookup");
      }),
    });
    await expect(
      barrier({
        ...operation,
        phase: "old-writer-absent",
        checkpoint: {
          writerAbsenceProof: {
            instanceId: operation.instanceId,
            repositoryId: operation.repositoryId,
            retiredRuntimeEpoch: null,
            remainingWriters: 0,
            source: "runtime-provider-census",
          },
        },
      } as unknown as OperationRecord),
    ).resolves.toBe(true);
  });
  it("the provisioner checkpoint route does not acknowledge absent-writer retirement before its barrier", async () => {
    const workerId = "worker-test";
    const leaseToken = "l".repeat(32);
    const input = {
      operationId: operation.id,
      workerId,
      leaseToken,
      leaseEpoch: 1,
      expectedCheckpointSequence: 0,
      phase: "old-writer-absent" as const,
      checkpoint: { writerAbsenceProof: { remainingWriters: 0 } },
    };
    let persisted: OperationRecord | null = null;
    let checkpointCalls = 0;
    let barrierCalls = 0;
    const app = createProvisionerRoutes({
      operations: {
        async getById() {
          return persisted;
        },
        async checkpoint() {
          checkpointCalls += 1;
          persisted = {
            ...operation,
            status: "running",
            workerId,
            leaseToken,
            leaseEpoch: 1,
            leaseExpiresAt: 10_000,
            checkpointSequence: 1,
            phase: input.phase,
            checkpoint: input.checkpoint,
          } as unknown as OperationRecord;
          return persisted;
        },
      } as unknown as OperationService,
      workerId: "worker-test",
      clusterId: "cluster-test",
      now: () => 100,
      resolveRuntimeContext: async () => ({}),
      retireCredentials: async (saved) => {
        expect(persisted).not.toBeNull();
        expect(saved).toBe(persisted);
        barrierCalls += 1;
        return barrierCalls > 2;
      },
    });
    const request = (overrides: Partial<typeof input> = {}) =>
      app.request("/checkpoint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, ...overrides }),
      });
    const pending = await request();
    expect(pending.status).toBe(202);
    expect(await pending.json()).toMatchObject({
      operation: { checkpointSequence: 1, phase: "old-writer-absent" },
      credentialRetirementPending: true,
    });
    const stillPending = await request();
    expect(stillPending.status).toBe(202);
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ operation: persisted });
    expect(checkpointCalls).toBe(1);
    expect(barrierCalls).toBe(3);
    const changedPayload = await request({
      checkpoint: { unsafe: true } as unknown as typeof input.checkpoint,
    });
    expect(changedPayload.status).toBe(200);
    expect(checkpointCalls).toBe(2);
  });

  it("returns the recovered operation in the provisioner client's operation envelope", async () => {
    const recovered = { ...operation, runtimeEpoch: 5 } as OperationRecord;
    const app = createProvisionerRoutes({
      operations: {
        async advanceRuntimeEpochForRecovery() {
          return recovered;
        },
      } as unknown as OperationService,
      workerId: "worker-test",
      clusterId: "cluster-test",
      now: () => 1,
      resolveRuntimeContext: async () => ({}),
    });
    const response = await app.request("/advance-epoch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operationId: operation.id,
        workerId: "worker-test",
        leaseToken: "l".repeat(32),
        leaseEpoch: 1,
        expectedRuntimeEpoch: 4,
        checkpoint: {},
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ operation: recovered });
  });
});
