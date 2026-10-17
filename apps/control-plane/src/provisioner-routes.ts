import { Hono } from "hono";
import { z } from "zod";
import { ResourceRequirementsSchema } from "@praetorium/contracts";
import type { OperationService, ClaimedOperation } from "@praetorium/application/operations";
import { boundedJson } from "./app.js";
import { IssueControlCredentialInputSchema } from "./control-credentials.js";
const Id = z.string().min(1).max(128),
  Counter = z.number().int().nonnegative(),
  Time = z.number().int().nonnegative();
const Fence = {
  operationId: Id,
  workerId: Id,
  leaseToken: z.string().min(32).max(256),
  leaseEpoch: Counter,
};
const Lease = z.number().int().min(5).max(300);
const Phase = z.enum([
  "accepted",
  "waiting-for-artifact",
  "waiting-for-capacity",
  "capacity-reserved",
  "quiescing-old",
  "old-quiesced",
  "stopping-old",
  "old-writer-absent",
  "starting-target",
  "target-ready",
  "route-activated",
  "complete",
  "blocked",
  "failed",
  "unknown",
]);
const Checkpoint = z.record(z.string(), z.unknown());
const Claim = z.strictObject({
  workerId: Id,
  clusterId: Id,
  leaseSeconds: Lease,
});
const Heartbeat = z.strictObject({
  ...Fence,
  sequence: Counter,
  leaseSeconds: Lease,
});
const Reserve = z.strictObject({
  ...Fence,
  expectedRuntimeEpoch: Counter,
  clusterId: Id,
  expectedCapacityEpoch: Counter,
  resources: ResourceRequirementsSchema,
  reservationId: Id,
});
const SaveCheckpoint = z.strictObject({
  ...Fence,
  expectedCheckpointSequence: Counter,
  phase: Phase,
  checkpoint: Checkpoint,
});
const Advance = z.strictObject({
  ...Fence,
  expectedRuntimeEpoch: Counter,
  checkpoint: Checkpoint,
});
const Report = z.strictObject({
  ...Fence,
  sequence: Counter,
  observation: z
    .strictObject({
      instanceId: Id,
      repositoryId: z.number().int().positive(),
      generation: Counter,
      runtimeEpoch: Counter,
      sequence: Counter,
      observedState: z.enum([
        "absent",
        "starting",
        "ready",
        "stopping",
        "stopped",
        "failed",
        "unknown",
      ]),
      observedArtifactDigest: z.string().nullable(),
      observedRevisionId: Id.nullable(),
    })
    .nullable(),
  terminal: z.enum(["succeeded", "failed", "blocked"]).optional(),
});
const Capacity = z.strictObject({
  clusterId: Id,
  observedAt: Time,
  complete: z.boolean(),
  capacity: z.strictObject({
    allocatable: ResourceRequirementsSchema,
    requested: ResourceRequirementsSchema,
    nodeResourceVersion: z.string().min(1).max(255),
    podResourceVersion: z.string().min(1).max(255),
  }),
  representedReservationIds: z.array(Id).max(4096),
});
export interface ProvisionerRoutesDependencies {
  operations: OperationService;
  workerId: string;
  clusterId: string;
  now: () => number;
  prepareClaim?: () => Promise<void> | void;
  retireCredentials?: (
    operation: Awaited<ReturnType<OperationService["checkpoint"]>>,
  ) => Promise<void>;
  issueControlCredential?: (input: unknown) => Promise<unknown>;
  resolveRuntimeContext: (claim: ClaimedOperation) => Promise<unknown>;
}
export function createProvisionerRoutes(deps: ProvisionerRoutesDependencies) {
  const app = new Hono();
  const scoped = (value: { workerId?: string; clusterId?: string }) => {
    if (
      (value.workerId !== undefined && value.workerId !== deps.workerId) ||
      (value.clusterId !== undefined && value.clusterId !== deps.clusterId)
    )
      throw new TypeError("Worker identity scope mismatch");
  };
  app.post("/claim", async (c) => {
    const input = Claim.parse(await boundedJson(c.req.raw));
    scoped(input);
    await deps.prepareClaim?.();
    const claim = await deps.operations.claimNext({
      ...input,
      now: deps.now(),
    });
    if (!claim) return c.json(null);
    try {
      return c.json({ ...claim, runtimeContext: await deps.resolveRuntimeContext(claim) });
    } catch {
      await deps.operations.blockClaim({
        operationId: claim.operation.id,
        workerId: input.workerId,
        leaseToken: claim.operation.leaseToken ?? "",
        leaseEpoch: claim.operation.leaseEpoch,
        code: "RUNTIME_CONTEXT_UNAVAILABLE",
        message: "The admitted runtime context could not be verified",
        now: deps.now(),
      });
      return c.json({ error: { code: "RUNTIME_CONTEXT_UNAVAILABLE" } }, 409);
    }
  });
  app.post("/control-credential", async (c) => {
    if (!deps.issueControlCredential)
      return c.json({ error: { code: "CONTROL_CREDENTIAL_UNAVAILABLE" } }, 503);
    const input = IssueControlCredentialInputSchema.parse(await boundedJson(c.req.raw));
    scoped(input);
    return c.json(await deps.issueControlCredential(input));
  });
  app.post("/heartbeat", async (c) => {
    const input = Heartbeat.parse(await boundedJson(c.req.raw));
    scoped(input);
    return c.json(await deps.operations.heartbeat({ ...input, now: deps.now() }));
  });
  app.post("/reserve", async (c) => {
    const input = Reserve.parse(await boundedJson(c.req.raw));
    scoped(input);
    return c.json(await deps.operations.reserveRuntime({ ...input, now: deps.now() }));
  });
  app.post("/release", async (c) => {
    const input = z
      .strictObject({
        ...Fence,
        reservationId: Id,
        expectedReservationRuntimeEpoch: Counter,
      })
      .parse(await boundedJson(c.req.raw));
    scoped(input);
    await deps.operations.releaseRuntime({ ...input, now: deps.now() });
    return c.json({ released: true });
  });
  app.post("/checkpoint", async (c) => {
    const input = SaveCheckpoint.parse(await boundedJson(c.req.raw));
    scoped(input);
    const operation = await deps.operations.checkpoint({ ...input, now: deps.now() });
    if (input.phase === "quiescing-old") {
      if (!deps.retireCredentials)
        return c.json({ error: { code: "CREDENTIAL_RETIREMENT_UNAVAILABLE" } }, 503);
      await deps.retireCredentials(operation);
    }
    return c.json(operation);
  });
  app.post("/advance-epoch", async (c) => {
    const input = Advance.parse(await boundedJson(c.req.raw));
    scoped(input);
    return c.json(
      await deps.operations.advanceRuntimeEpochForRecovery({
        ...input,
        now: deps.now(),
      }),
    );
  });
  app.post("/report", async (c) => {
    const input = Report.parse(await boundedJson(c.req.raw));
    scoped(input);
    return c.json(
      await deps.operations.report({
        ...input,
        terminal: input.terminal ?? null,
        observation: input.observation ? { ...input.observation, reportedAt: deps.now() } : null,
        now: deps.now(),
      }),
    );
  });
  app.post("/reservations/current", async (c) => {
    const input = z.strictObject({ clusterId: Id }).parse(await boundedJson(c.req.raw));
    scoped(input);
    return c.json(await deps.operations.currentReservations(input.clusterId));
  });
  app.post("/capacity/record", async (c) => {
    const input = Capacity.parse(await boundedJson(c.req.raw));
    scoped(input);
    const now = deps.now();
    if (input.observedAt > now || now - input.observedAt > 30000)
      return c.json({ error: { code: "CAPACITY_UNAVAILABLE" } }, 409);
    return c.json({
      capacityEpoch: await deps.operations.recordCapacitySnapshot(input),
    });
  });
  return app;
}
