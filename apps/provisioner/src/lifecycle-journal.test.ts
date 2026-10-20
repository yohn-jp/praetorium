import { describe, expect, it, vi } from "vitest";
import type { ClaimedProvisionerOperation, ProvisionerOperationService } from "./operation-client.js";
import { OperationBackedLifecycleJournal } from "./lifecycle-journal.js";

describe("OperationBackedLifecycleJournal", () => {
  it("keeps a durable accepted resume checkpoint when LifecycleService loads again", async () => {
    const persistedCheckpoint = {
      schemaVersion: 1,
      lifecycle: {
        id: "op-stop-recovery",
        version: 4,
        instanceId: "ins_stop_recovery",
        repositoryId: 1423923158,
        clusterId: "cluster-runtime",
        generation: 5,
        kind: "stop",
        reason: "user",
        phase: "quiescing-old",
        runtimeEpoch: 3,
        current: null,
        target: null,
        targetEpoch: null,
        targetReservationId: null,
        rollbackEpoch: null,
        quiesceRequest: {
          contractVersion: "scriptorium-platform/v1",
          operationId: "op-stop-recovery",
          instanceId: "ins_stop_recovery",
          runtimeEpoch: 3,
          reason: "stop",
          deadline: "2026-10-21T00:00:00.000Z",
        },
        quiesceReceipt: null,
        writerAbsenceProof: null,
        readinessEvidence: null,
        rollbackCompatibilityEvidence: null,
        rollbackCompatible: null,
        buildId: null,
        failureCode: null,
        failureReason: null,
        lastAuthenticatedActivityAt: null,
      },
    };
    const claim = {
      operation: {
        id: "op-stop-recovery",
        instanceId: "ins_stop_recovery",
        repositoryId: 1423923158,
        generation: 5,
        runtimeEpoch: 3,
        kind: "stop",
        status: "claimed",
        attempt: 2,
        leaseEpoch: 7,
        leaseToken: "lease-token",
        leaseExpiresAt: 1_900_000_000_000,
        reportSequence: 0,
        phase: "quiescing-old",
        checkpointSequence: 12,
        checkpoint: persistedCheckpoint,
        clusterId: "cluster-runtime",
        reservationId: null,
        deploymentRevisionId: null,
        buildId: null,
        prerequisiteBuildId: null,
      },
      snapshot: {
        binding: { suspended: false },
        instance: { observedGeneration: 5, clusterId: "cluster-runtime", reservationId: null },
      },
      reservation: null,
      currentReservation: null,
      deploymentRevision: null,
      currentDeploymentRevision: null,
      runtimeContext: { current: null, target: null },
    } as unknown as ClaimedProvisionerOperation;
    const checkpoint = vi.fn(async (input) => ({
      operation: {
        ...claim.operation,
        phase: input.phase,
        checkpointSequence: input.expectedCheckpointSequence + 1,
        checkpoint: input.checkpoint,
      },
    }));
    const journal = new OperationBackedLifecycleJournal({
      claim,
      operations: { checkpoint } as unknown as ProvisionerOperationService,
      workerId: "worker-runtime",
    });

    const recovered = journal.currentOperation;
    expect(recovered).toMatchObject({ phase: "quiescing-old", quiesceRequest: { operationId: "op-stop-recovery" } });
    await journal.advance(recovered.id, recovered.version, {
      phase: "accepted",
      quiesceRequest: null,
      quiesceReceipt: null,
    });

    await expect(journal.load("op-stop-recovery")).resolves.toMatchObject({
      phase: "accepted",
      quiesceRequest: null,
      quiesceReceipt: null,
      version: 5,
    });
    expect(checkpoint).toHaveBeenCalledOnce();
  });
});
