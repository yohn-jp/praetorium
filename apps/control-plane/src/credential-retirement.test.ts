import { describe, expect, it } from "vitest";
import type { OperationRecord } from "@praetorium/application/instances";
import type { D1Database } from "@praetorium/persistence/d1";
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
});
