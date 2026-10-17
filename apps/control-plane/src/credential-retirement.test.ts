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
    await expect(barrier(operation)).rejects.toThrow("remain pending");
    remaining = 0;
    await expect(barrier(operation)).resolves.toBeUndefined();
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
    await expect(barrier(operation)).rejects.toThrow("remain pending");
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
    await expect(barrier(operation)).resolves.toBeUndefined();
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
    await expect(barrier(absent)).rejects.toThrow("remain pending");
    remaining = 0;
    await expect(barrier(absent)).resolves.toBeUndefined();
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
    ).resolves.toBeUndefined();
  });
  it("the provisioner checkpoint route does not acknowledge absent-writer retirement before its barrier", async () => {
    const absent = { ...operation, phase: "old-writer-absent" } as OperationRecord;
    let persisted = false;
    let pending = true;
    const app = createProvisionerRoutes({
      operations: {
        async checkpoint() {
          persisted = true;
          return absent;
        },
      } as unknown as OperationService,
      workerId: "worker-test",
      clusterId: "cluster-test",
      now: () => 1,
      resolveRuntimeContext: async () => ({}),
      retireCredentials: async (saved) => {
        expect(persisted).toBe(true);
        expect(saved).toBe(absent);
        if (pending) throw new Error("pending retirement");
      },
    });
    app.onError(() => Response.json({ error: "retirement unavailable" }, { status: 503 }));
    const request = () =>
      app.request("/checkpoint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operationId: operation.id,
          workerId: "worker-test",
          leaseToken: "l".repeat(32),
          leaseEpoch: 1,
          expectedCheckpointSequence: 0,
          phase: "old-writer-absent",
          checkpoint: {},
        }),
      });
    expect((await request()).status).toBe(503);
    pending = false;
    expect((await request()).status).toBe(200);
  });
});
