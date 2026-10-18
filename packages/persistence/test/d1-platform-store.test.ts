import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  InstanceService,
  RepositoryRegistryService,
} from "../../application/src/instances/index.js";
import {
  OperationFenceConflict,
  OperationService,
} from "../../application/src/operations/index.js";
import {
  RepositoryNotFound,
  RepositoryStateConflict,
} from "../../application/src/instances/types.js";
import { D1PlatformStore } from "../src/d1/platform-store.js";
import type { D1Database, D1PreparedStatement, D1Result } from "../src/d1/types.js";

const schemaUrl = new URL("../../../docs/migration/tasks/T03-schema.sql", import.meta.url);
const liveDatabases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of liveDatabases.splice(0)) database.close();
});

describe("D1PlatformStore with SQLite transactions", () => {
  it("atomically resolves concurrent first access to one repository instance", async () => {
    const { database, registry, instances } = createPlatform();
    const [first, second] = await Promise.all([
      registry.resolveOrCreate(registryInput("instance-a", "request-a")),
      registry.resolveOrCreate(registryInput("instance-b", "request-b")),
    ]);

    expect(first.binding.repositoryId).toBe(71);
    expect(second.binding.instanceId).toBe(first.binding.instanceId);
    expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
    expect(database.prepare("SELECT count(*) AS n FROM logical_instances").get()).toMatchObject({
      n: 1,
    });
    expect(database.prepare("SELECT count(*) AS n FROM repository_bindings").get()).toMatchObject({
      n: 1,
    });
    expect(
      database
        .prepare(
          "SELECT count(*) AS n FROM audit_events WHERE action = 'repository.binding.created'",
        )
        .get(),
    ).toMatchObject({ n: 1 });

    const suspendInput = {
      repositoryId: 71,
      expectedBindingEpoch: 1,
      eventId: "delivery-removal-1",
      eventKind: "installation_repository.removed",
      reason: "installation removed repository access",
      requestId: "webhook-request-1",
      now: 20,
    } as const;
    const suspended = await registry.suspendBinding(suspendInput);
    expect(suspended).toMatchObject({ bindingEpoch: 2, suspended: true });
    await expect(registry.suspendBinding(suspendInput)).rejects.toBeInstanceOf(RepositoryNotFound);
    expect(database.prepare("SELECT count(*) AS n FROM repository_events").get()).toMatchObject({
      n: 1,
    });
    expect(
      database
        .prepare(
          "SELECT count(*) AS n FROM audit_events WHERE action = 'repository.binding.suspended'",
        )
        .get(),
    ).toMatchObject({ n: 1 });
    const revalidated = await registry.revalidateBinding({
      repositoryId: 71,
      expectedBindingEpoch: 2,
      installationId: 82,
      owner: "praetorium-new-owner",
      name: "renamed-repo",
      authorizationRevision: 4,
      actorId: "operator-1",
      requestId: "revalidate-1",
      now: 30,
    });
    expect(revalidated).toMatchObject({
      installationId: 82,
      owner: "praetorium-new-owner",
      name: "renamed-repo",
      bindingEpoch: 3,
      suspended: false,
    });
    await expect(
      instances.requestDesiredState({
        repositoryId: 71,
        bindingEpoch: 1,
        authorizationRevision: 3,
        desiredState: "running",
        actorId: "user-1",
        idempotencyKey: "stale-start",
        requestId: "stale-request",
        now: 31,
      }),
    ).rejects.toBeInstanceOf(RepositoryStateConflict);
  });

  it("does not claim a start until an admitted deployment and verified build exist", async () => {
    const { database, registry, instances, operations } = createPlatform();
    const resolved = await registry.resolveOrCreate(registryInput("instance-a", "request-a"));
    const snapshot = { binding: resolved.binding, instance: resolved.instance };
    const start = {
      repositoryId: 71,
      bindingEpoch: snapshot.binding.bindingEpoch,
      authorizationRevision: snapshot.binding.authorizationRevision,
      desiredState: "running",
      actorId: "user-1",
      idempotencyKey: "start-1",
      requestId: "request-a",
      now: 100,
    } as const;
    const [requested, replayed] = await Promise.all([
      instances.requestDesiredState(start),
      instances.requestDesiredState(start),
    ]);

    expect(requested.operation?.phase).toBe("waiting-for-artifact");
    expect(replayed.operation?.id).toBe(requested.operation?.id);
    expect(
      database
        .prepare("SELECT count(*) AS n FROM operations WHERE idempotency_key = 'start-1'")
        .get(),
    ).toMatchObject({ n: 1 });
    await expect(
      operations.claimNext({ workerId: "provisioner-1", clusterId: "cluster-a", now: 101 }),
    ).resolves.toBeNull();
  });

  it("rejects forceNewRuntime for an empty stopped instance", async () => {
    const { database, registry, instances } = createPlatform();
    const resolved = await registry.resolveOrCreate(registryInput("instance-a", "request-a"));

    await expect(
      instances.requestDesiredState({
        repositoryId: 71,
        bindingEpoch: resolved.binding.bindingEpoch,
        authorizationRevision: resolved.binding.authorizationRevision,
        desiredState: "stopped",
        forceNewRuntime: true,
        actorId: "user-1",
        idempotencyKey: "invalid-stop-redeploy",
        requestId: "invalid-stop-redeploy-request",
        now: 100,
      }),
    ).rejects.toThrow("forceNewRuntime is only valid for a running desired state");
    expect(database.prepare("SELECT count(*) AS n FROM operations").get()).toMatchObject({
      n: 0,
    });
    expect(await instances.getByRepositoryId(71)).toMatchObject({
      instance: { desiredState: "stopped", generation: 0, runtimeEpoch: 0 },
    });
  });

  it("rejects forceNewRuntime for an already stopped instance without changing its epoch", async () => {
    const { database, registry, instances } = createPlatform();
    const resolved = await registry.resolveOrCreate(registryInput("instance-a", "request-a"));
    database
      .prepare(
        `UPDATE logical_instances SET generation = 3, runtime_epoch = 2,
         observed_generation = 3, observed_runtime_epoch = 2, observed_sequence = 1,
         observed_state = 'stopped' WHERE instance_id = ?`,
      )
      .run(resolved.binding.instanceId);

    await expect(
      instances.requestDesiredState({
        repositoryId: 71,
        bindingEpoch: resolved.binding.bindingEpoch,
        authorizationRevision: resolved.binding.authorizationRevision,
        desiredState: "stopped",
        forceNewRuntime: true,
        actorId: "user-1",
        idempotencyKey: "invalid-stop-redeploy",
        requestId: "invalid-stop-redeploy-request",
        now: 100,
      }),
    ).rejects.toThrow("forceNewRuntime is only valid for a running desired state");
    expect(database.prepare("SELECT count(*) AS n FROM operations").get()).toMatchObject({
      n: 0,
    });
    expect(await instances.getByRepositoryId(71)).toMatchObject({
      instance: { desiredState: "stopped", generation: 3, runtimeEpoch: 2 },
    });
  });

  it("records pre-retirement progress and blocking without overwriting the old runtime observation", async () => {
    const { database, registry, instances, operations } = createPlatform();
    const resolved = await registry.resolveOrCreate(registryInput("instance-a", "request-a"));
    seedDeployment(database, resolved.binding.instanceId);
    seedCurrentReadyRuntime(database, resolved.binding.instanceId);
    const requested = await instances.requestDesiredState({
      repositoryId: 71,
      bindingEpoch: resolved.binding.bindingEpoch,
      authorizationRevision: resolved.binding.authorizationRevision,
      desiredState: "running",
      forceNewRuntime: true,
      actorId: "user-1",
      idempotencyKey: "redeploy-1",
      requestId: "redeploy-request",
      now: 100,
    });
    expect(requested.operation).toMatchObject({ kind: "redeploy", generation: 2, runtimeEpoch: 2 });
    const claim = await operations.claimNext({
      workerId: "provisioner-1",
      clusterId: "cluster-a",
      now: 101,
    });
    if (!claim) throw new Error("expected admitted redeploy claim");
    const lease = {
      operationId: claim.operation.id,
      workerId: claim.operation.workerId!,
      leaseToken: claim.operation.leaseToken!,
      leaseEpoch: claim.operation.leaseEpoch,
    } as const;

    await operations.report({
      ...lease,
      sequence: 1,
      now: 102,
      observation: null,
    });
    expect(await instances.getByInstanceId(resolved.binding.instanceId)).toMatchObject({
      instance: {
        generation: 2,
        runtimeEpoch: 2,
        observedGeneration: 1,
        observedRuntimeEpoch: 1,
        observedSequence: 7,
        observedState: "ready",
        observedRevisionId: "revision-1",
        currentArtifactDigest: `sha256:${"a".repeat(64)}`,
      },
    });

    await operations.report({
      ...lease,
      sequence: 2,
      now: 103,
      terminal: "blocked",
      observation: null,
    });
    expect(await operations.getById(claim.operation.id)).toMatchObject({
      status: "blocked",
      phase: "blocked",
    });
    expect(await instances.getByInstanceId(resolved.binding.instanceId)).toMatchObject({
      instance: {
        generation: 2,
        runtimeEpoch: 2,
        observedGeneration: 1,
        observedRuntimeEpoch: 1,
        observedSequence: 7,
        observedState: "ready",
        observedRevisionId: "revision-1",
        currentArtifactDigest: `sha256:${"a".repeat(64)}`,
      },
    });
  });

  it("keeps report audit IDs unique when an expired operation lease restarts its sequence", async () => {
    const { database, registry, instances, operations } = createPlatform();
    const resolved = await registry.resolveOrCreate(registryInput("instance-a", "request-a"));
    seedDeployment(database, resolved.binding.instanceId);
    await instances.requestDesiredState({
      repositoryId: 71,
      bindingEpoch: resolved.binding.bindingEpoch,
      authorizationRevision: resolved.binding.authorizationRevision,
      desiredState: "running",
      actorId: "user-1",
      idempotencyKey: "start-1",
      requestId: "request-a",
      now: 100,
    });

    const firstClaim = await operations.claimNext({
      workerId: "provisioner-1",
      clusterId: "cluster-a",
      now: 101,
    });
    if (!firstClaim) throw new Error("expected admitted start claim");
    const firstLease = {
      operationId: firstClaim.operation.id,
      workerId: firstClaim.operation.workerId!,
      leaseToken: firstClaim.operation.leaseToken!,
      leaseEpoch: firstClaim.operation.leaseEpoch,
    } as const;
    expect(firstLease.leaseEpoch).toBe(1);

    await operations.report({ ...firstLease, sequence: 1, now: 102, observation: null });

    const secondClaim = await operations.claimNext({
      workerId: "provisioner-1",
      clusterId: "cluster-a",
      now: firstClaim.operation.leaseExpiresAt!,
    });
    if (!secondClaim) throw new Error("expected expired operation lease to be reclaimed");
    const secondLease = {
      operationId: secondClaim.operation.id,
      workerId: secondClaim.operation.workerId!,
      leaseToken: secondClaim.operation.leaseToken!,
      leaseEpoch: secondClaim.operation.leaseEpoch,
    } as const;
    expect(secondLease.leaseEpoch).toBe(2);
    const reclaimedAt = firstClaim.operation.leaseExpiresAt! + 1;

    await expect(
      operations.report({ ...firstLease, sequence: 2, now: reclaimedAt, observation: null }),
    ).rejects.toBeInstanceOf(OperationFenceConflict);
    await operations.report({
      ...secondLease,
      sequence: 1,
      now: reclaimedAt,
      observation: null,
    });

    const rows = database
      .prepare(
        `SELECT event_id, occurred_at FROM audit_events
         WHERE operation_id = ? AND action = 'operation.reported' ORDER BY occurred_at`,
      )
      .all(firstClaim.operation.id) as { event_id: string; occurred_at: number }[];
    expect(rows).toEqual([
      {
        event_id: `operation.report:${firstClaim.operation.id}:1:1`,
        occurred_at: 102,
      },
      {
        event_id: `operation.report:${firstClaim.operation.id}:2:1`,
        occurred_at: reclaimedAt,
      },
    ]);
  });

  it("fenced-blocks a claim when runtime context cannot be resolved without changing the old observation", async () => {
    const { database, registry, instances, operations } = createPlatform();
    const resolved = await registry.resolveOrCreate(registryInput("instance-a", "request-a"));
    seedDeployment(database, resolved.binding.instanceId);
    seedCurrentReadyRuntime(database, resolved.binding.instanceId);
    const requested = await instances.requestDesiredState({
      repositoryId: 71,
      bindingEpoch: resolved.binding.bindingEpoch,
      authorizationRevision: resolved.binding.authorizationRevision,
      desiredState: "running",
      forceNewRuntime: true,
      actorId: "user-1",
      idempotencyKey: "redeploy-1",
      requestId: "redeploy-request",
      now: 100,
    });
    if (!requested.operation) throw new Error("expected redeploy operation");
    const claim = await operations.claimNext({
      workerId: "provisioner-1",
      clusterId: "cluster-a",
      now: 101,
    });
    if (!claim) throw new Error("expected admitted redeploy claim");
    const lease = {
      operationId: claim.operation.id,
      workerId: claim.operation.workerId!,
      leaseToken: claim.operation.leaseToken!,
      leaseEpoch: claim.operation.leaseEpoch,
    } as const;

    const blocked = await operations.blockClaim({
      ...lease,
      code: "RUNTIME_CONTEXT_INVALID",
      message: "The admitted runtime context could not be resolved.",
      now: 102,
    });
    expect(blocked).toMatchObject({
      status: "blocked",
      phase: "blocked",
      leaseToken: null,
      leaseExpiresAt: null,
      result: {
        code: "RUNTIME_CONTEXT_INVALID",
        message: "The admitted runtime context could not be resolved.",
      },
    });
    expect(await instances.getByInstanceId(resolved.binding.instanceId)).toMatchObject({
      instance: {
        generation: 2,
        runtimeEpoch: 2,
        observedGeneration: 1,
        observedRuntimeEpoch: 1,
        observedSequence: 7,
        observedState: "ready",
        observedRevisionId: "revision-1",
      },
    });
    expect(
      database
        .prepare("SELECT count(*) AS n FROM audit_events WHERE action = 'operation.claim.blocked'")
        .get(),
    ).toMatchObject({ n: 1 });
    await expect(
      operations.report({
        ...lease,
        sequence: 1,
        now: 103,
        terminal: "blocked",
        observation: null,
      }),
    ).rejects.toBeInstanceOf(OperationFenceConflict);
  });

  it("requires a fresh capacity epoch and rolls back mismatched reservation attachment", async () => {
    const { database, registry, instances, operations, store } = createPlatform({
      maxCapacitySnapshotAgeMs: 5,
    });
    const resolved = await registry.resolveOrCreate(registryInput("instance-a", "request-a"));
    const snapshot = { binding: resolved.binding, instance: resolved.instance };
    seedDeployment(database, snapshot.binding.instanceId);
    const desired = await instances.requestDesiredState({
      repositoryId: 71,
      bindingEpoch: snapshot.binding.bindingEpoch,
      authorizationRevision: snapshot.binding.authorizationRevision,
      desiredState: "running",
      actorId: "user-1",
      idempotencyKey: "start-1",
      requestId: "request-a",
      now: 100,
    });
    expect(desired.operation).not.toBeNull();
    const claimed = await operations.claimNext({
      workerId: "provisioner-1",
      clusterId: "cluster-a",
      now: 101,
    });
    expect(claimed?.deploymentRevision?.artifact?.signature).toEqual({
      keyId: "test-key",
      signature: "test-signature",
    });
    if (!claimed) throw new Error("expected admitted operation claim");

    const capacity = capacitySnapshot();
    const incompleteEpoch = await operations.recordCapacitySnapshot({
      clusterId: "cluster-a",
      observedAt: 1_000,
      complete: false,
      capacity,
      representedReservationIds: [],
    });
    expect(incompleteEpoch).toBe(1);
    expect(
      await operations.reserveRuntime({
        operationId: claimed.operation.id,
        workerId: claimed.operation.workerId!,
        leaseToken: claimed.operation.leaseToken!,
        leaseEpoch: claimed.operation.leaseEpoch,
        expectedRuntimeEpoch: claimed.operation.runtimeEpoch,
        expectedCapacityEpoch: incompleteEpoch,
        clusterId: "cluster-a",
        resources: resources(),
        reservationId: "target-reservation",
        now: 1_000,
      }),
    ).toBeNull();

    const capacityEpoch = await operations.recordCapacitySnapshot({
      clusterId: "cluster-a",
      observedAt: 1_001,
      complete: true,
      capacity,
      representedReservationIds: [],
    });
    expect(capacityEpoch).toBe(2);
    database
      .prepare(
        `INSERT INTO runtime_reservations (
         reservation_id, instance_id, repository_id, runtime_epoch, generation, cluster_id, status,
         capacity_snapshot_epoch, cpu_milli, memory_mib, ephemeral_storage_mib, created_at, updated_at
       ) VALUES ('wrong-reservation', ?, 71, 1, 1, 'cluster-a', 'reserved', 2, 1, 1, 1, 1_001, 1_001)`,
      )
      .run(snapshot.binding.instanceId);

    const reservationInput = {
      operationId: claimed.operation.id,
      workerId: claimed.operation.workerId!,
      leaseToken: claimed.operation.leaseToken!,
      leaseEpoch: claimed.operation.leaseEpoch,
      expectedRuntimeEpoch: claimed.operation.runtimeEpoch,
      expectedCapacityEpoch: capacityEpoch!,
      clusterId: "cluster-a",
      resources: resources(),
      reservationId: "target-reservation",
      now: 1_001,
    } as const;
    expect(await operations.reserveRuntime(reservationInput)).toBeNull();
    expect(
      database
        .prepare("SELECT reservation_id FROM operations WHERE operation_id = ?")
        .get(claimed.operation.id),
    ).toMatchObject({ reservation_id: null });
    expect(
      database
        .prepare("SELECT count(*) AS n FROM runtime_reservations WHERE instance_id = ?")
        .get(snapshot.binding.instanceId),
    ).toMatchObject({ n: 1 });
    expect(await operations.reserveRuntime({ ...reservationInput, now: 1_007 })).toBeNull();

    const freshCapacityEpoch = await operations.recordCapacitySnapshot({
      clusterId: "cluster-a",
      observedAt: 1_008,
      complete: true,
      capacity,
      representedReservationIds: [],
    });
    expect(freshCapacityEpoch).toBe(3);

    database
      .prepare("DELETE FROM runtime_reservations WHERE reservation_id = 'wrong-reservation'")
      .run();
    const reservation = await operations.reserveRuntime({
      ...reservationInput,
      expectedCapacityEpoch: freshCapacityEpoch!,
      now: 1_008,
    });
    expect(reservation).toMatchObject({
      reservationId: "target-reservation",
      status: "reserved",
      capacitySnapshotEpoch: 3,
      resources: resources(),
    });
    expect((await store.getByRepositoryId(71))?.instance.reservationId).toBe("target-reservation");
    expect(await operations.currentReservations("cluster-a")).toMatchObject({
      capacityEpoch: 3,
      observedAt: 1_008,
      complete: true,
      reservations: [{ reservationId: "target-reservation", status: "reserved", repositoryId: 71 }],
    });
  });

  it("rolls back a stale observation report and accepts an idempotent current report", async () => {
    const { database, registry, instances, operations } = createPlatform();
    const resolved = await registry.resolveOrCreate(registryInput("instance-a", "request-a"));
    const snapshot = { binding: resolved.binding, instance: resolved.instance };
    seedDeployment(database, snapshot.binding.instanceId);
    await instances.requestDesiredState({
      repositoryId: 71,
      bindingEpoch: snapshot.binding.bindingEpoch,
      authorizationRevision: snapshot.binding.authorizationRevision,
      desiredState: "running",
      actorId: "user-1",
      idempotencyKey: "start-1",
      requestId: "request-a",
      now: 100,
    });
    const claimed = await operations.claimNext({
      workerId: "provisioner-1",
      clusterId: "cluster-a",
      now: 101,
    });
    if (!claimed) throw new Error("expected admitted operation claim");
    const lease = {
      operationId: claimed.operation.id,
      workerId: claimed.operation.workerId!,
      leaseToken: claimed.operation.leaseToken!,
      leaseEpoch: claimed.operation.leaseEpoch,
    } as const;
    database
      .prepare(
        `UPDATE logical_instances SET observed_generation = 1, observed_runtime_epoch = 1,
       observed_sequence = 5, observed_state = 'ready' WHERE instance_id = ?`,
      )
      .run(snapshot.binding.instanceId);

    await expect(
      operations.report({
        ...lease,
        sequence: 1,
        now: 200,
        terminal: "succeeded",
        observation: observation(snapshot.binding.instanceId, 71, 4),
      }),
    ).rejects.toBeInstanceOf(OperationFenceConflict);
    expect(await operations.getById(claimed.operation.id)).toMatchObject({
      status: "claimed",
      reportSequence: 0,
    });

    await operations.checkpoint({
      ...lease,
      expectedCheckpointSequence: 0,
      phase: "route-activated",
      checkpoint: {},
      now: 200,
    });
    await operations.checkpoint({
      ...lease,
      expectedCheckpointSequence: 1,
      phase: "complete",
      checkpoint: {},
      now: 200,
    });

    const accepted = await operations.report({
      ...lease,
      sequence: 1,
      now: 201,
      terminal: "succeeded",
      observation: observation(snapshot.binding.instanceId, 71, 6),
    });
    expect(accepted.operation.status).toBe("succeeded");
    expect(accepted.applied).toBe(true);
    await expect(
      operations.report({
        ...lease,
        sequence: 1,
        now: 100_000,
        terminal: "succeeded",
        observation: observation(snapshot.binding.instanceId, 71, 6),
      }),
    ).resolves.toMatchObject({ duplicate: true, applied: false });
  });

  it("releases a runtime reservation only with the current lease and exact writer-absence proof", async () => {
    const { database, registry, instances, operations } = createPlatform();
    const resolved = await registry.resolveOrCreate(registryInput("instance-a", "request-a"));
    const { binding, instance } = resolved;
    seedDeployment(database, binding.instanceId);
    await instances.requestDesiredState({
      repositoryId: 71,
      bindingEpoch: binding.bindingEpoch,
      authorizationRevision: binding.authorizationRevision,
      desiredState: "running",
      actorId: "user-1",
      idempotencyKey: "start-1",
      requestId: "request-a",
      now: 100,
    });
    const start = await operations.claimNext({
      workerId: "provisioner-1",
      clusterId: "cluster-a",
      now: 101,
    });
    if (!start) throw new Error("expected admitted start claim");
    const capacityEpoch = await operations.recordCapacitySnapshot({
      clusterId: "cluster-a",
      observedAt: 102,
      complete: true,
      capacity: capacitySnapshot(),
      representedReservationIds: [],
    });
    const reservation = await operations.reserveRuntime({
      operationId: start.operation.id,
      workerId: start.operation.workerId!,
      leaseToken: start.operation.leaseToken!,
      leaseEpoch: start.operation.leaseEpoch,
      expectedRuntimeEpoch: start.operation.runtimeEpoch,
      expectedCapacityEpoch: capacityEpoch!,
      clusterId: "cluster-a",
      resources: resources(),
      reservationId: "current-reservation",
      now: 102,
    });
    expect(reservation?.status).toBe("reserved");
    await operations.checkpoint({
      operationId: start.operation.id,
      workerId: start.operation.workerId!,
      leaseToken: start.operation.leaseToken!,
      leaseEpoch: start.operation.leaseEpoch,
      expectedCheckpointSequence: 0,
      phase: "route-activated",
      checkpoint: {},
      now: 103,
    });
    await operations.checkpoint({
      operationId: start.operation.id,
      workerId: start.operation.workerId!,
      leaseToken: start.operation.leaseToken!,
      leaseEpoch: start.operation.leaseEpoch,
      expectedCheckpointSequence: 1,
      phase: "complete",
      checkpoint: {},
      now: 103,
    });
    await operations.report({
      operationId: start.operation.id,
      workerId: start.operation.workerId!,
      leaseToken: start.operation.leaseToken!,
      leaseEpoch: start.operation.leaseEpoch,
      sequence: 1,
      now: 103,
      terminal: "succeeded",
      observation: observation(binding.instanceId, 71, 1),
    });

    const stopped = await instances.requestDesiredState({
      repositoryId: 71,
      bindingEpoch: binding.bindingEpoch,
      authorizationRevision: binding.authorizationRevision,
      desiredState: "stopped",
      actorId: "user-1",
      idempotencyKey: "stop-1",
      requestId: "stop-request",
      now: 104,
    });
    expect(stopped.operation?.kind).toBe("stop");
    const stop = await operations.claimNext({
      workerId: "provisioner-1",
      clusterId: "cluster-a",
      now: 105,
    });
    if (!stop) throw new Error("expected stop claim");
    const lease = {
      operationId: stop.operation.id,
      workerId: stop.operation.workerId!,
      leaseToken: stop.operation.leaseToken!,
      leaseEpoch: stop.operation.leaseEpoch,
    } as const;
    const release = {
      ...lease,
      reservationId: reservation!.reservationId,
      expectedReservationRuntimeEpoch: reservation!.runtimeEpoch,
      now: 106,
    } as const;
    await operations.checkpoint({
      ...lease,
      expectedCheckpointSequence: 0,
      phase: "old-writer-absent",
      checkpoint: {
        writerAbsenceProof: {
          instanceId: binding.instanceId,
          repositoryId: 71,
          retiredRuntimeEpoch: reservation!.runtimeEpoch - 1,
        },
      },
      now: 106,
    });
    await expect(operations.releaseRuntime(release)).rejects.toBeInstanceOf(OperationFenceConflict);
    expect(
      database
        .prepare("SELECT status FROM runtime_reservations WHERE reservation_id = ?")
        .get(reservation!.reservationId),
    ).toMatchObject({ status: "reserved" });
    await expect(
      operations.report({
        ...lease,
        sequence: 1,
        now: 106,
        terminal: "succeeded",
        observation: stoppedObservation(
          binding.instanceId,
          71,
          stop.operation.generation,
          stop.operation.runtimeEpoch,
          2,
        ),
      }),
    ).rejects.toBeInstanceOf(OperationFenceConflict);
    expect(await operations.getById(stop.operation.id)).toMatchObject({ reportSequence: 0 });

    await operations.checkpoint({
      ...lease,
      expectedCheckpointSequence: 1,
      phase: "old-writer-absent",
      checkpoint: {
        writerAbsenceProof: {
          instanceId: binding.instanceId,
          repositoryId: 71,
          retiredRuntimeEpoch: reservation!.runtimeEpoch,
        },
      },
      now: 107,
    });
    await operations.releaseRuntime({ ...release, now: 107 });
    expect(
      database
        .prepare("SELECT status FROM runtime_reservations WHERE reservation_id = ?")
        .get(reservation!.reservationId),
    ).toMatchObject({ status: "released" });
    expect(await instances.getByInstanceId(instance.instanceId)).toMatchObject({
      instance: { reservationId: null, reservationState: "released" },
    });
    await operations.checkpoint({
      ...lease,
      expectedCheckpointSequence: 2,
      phase: "complete",
      checkpoint: {
        writerAbsenceProof: {
          instanceId: binding.instanceId,
          repositoryId: 71,
          retiredRuntimeEpoch: reservation!.runtimeEpoch,
        },
      },
      now: 108,
    });
    await operations.report({
      ...lease,
      sequence: 1,
      now: 108,
      terminal: "succeeded",
      observation: stoppedObservation(
        binding.instanceId,
        71,
        stop.operation.generation,
        stop.operation.runtimeEpoch,
        2,
      ),
    });
    expect(await operations.getById(stop.operation.id)).toMatchObject({ status: "succeeded" });
    expect(await instances.getByInstanceId(instance.instanceId)).toMatchObject({
      instance: {
        generation: stop.operation.generation,
        runtimeEpoch: stop.operation.runtimeEpoch,
        observedGeneration: stop.operation.generation,
        observedRuntimeEpoch: stop.operation.runtimeEpoch,
        observedState: "stopped",
        observedRevisionId: null,
        currentArtifactDigest: null,
      },
    });
  });
});

function createPlatform(options: { readonly maxCapacitySnapshotAgeMs?: number } = {}) {
  const database = new DatabaseSync(":memory:");
  liveDatabases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(readFileSync(fileURLToPath(schemaUrl), "utf8"));
  database.exec(
    readFileSync(
      fileURLToPath(
        new URL("../../../apps/control-plane/migrations/0004_runtime_git_credentials.sql", import.meta.url),
      ),
      "utf8",
    ),
  );
  const store = new D1PlatformStore(new SqliteD1Database(database), options);
  let instanceCounter = 0;
  const registry = new RepositoryRegistryService(
    store,
    () => `instance-generated-${++instanceCounter}`,
  );
  let operationCounter = 0;
  const instances = new InstanceService(store, () => `operation-generated-${++operationCounter}`);
  let leaseCounter = 0;
  const operations = new OperationService(
    store,
    () => `provisioner-lease-token-${++leaseCounter}-with-sufficient-length`,
  );
  return { database, store, registry, instances, operations };
}

function registryInput(instanceId: string, requestId: string) {
  return {
    repository: {
      repositoryId: 71,
      installationId: 81,
      owner: "praetorium",
      name: "test-repo",
      authorizationRevision: 3,
    },
    actor: { id: "user-1", kind: "user" as const },
    requestId,
    idempotencyKey: `resolve-${requestId}`,
    now: 10,
    instanceId,
  };
}

function seedDeployment(database: DatabaseSync, instanceId: string): void {
  const artifactDigest = `sha256:${"a".repeat(64)}`;
  const manifestDigest = `sha256:${"b".repeat(64)}`;
  const platformDigest = `sha256:${"c".repeat(64)}`;
  const compositionDigest = `sha256:${"d".repeat(64)}`;
  const producerRevision = "a".repeat(40);
  const buildId = "build-1";
  const buildKey = "build-key-1";
  const attemptId = "build-attempt-1";
  database
    .prepare(
      `INSERT INTO builds (build_id, build_key, build_input_json, status, artifact_digest, created_at, updated_at)
     VALUES (?, ?, '{"input":1}', 'succeeded', ?, 10, 10)`,
    )
    .run(buildId, buildKey, artifactDigest);
  database
    .prepare(
      `INSERT INTO build_attempts (attempt_id, build_id, lease_epoch, worker_id, status, lease_token, lease_expires_at,
       report_sequence, started_at, updated_at, finished_at)
     VALUES (?, ?, 1, 'build-worker', 'succeeded', 'build-lease-token', 1_000, 2, 10, 10, 10)`,
    )
    .run(attemptId, buildId);
  database
    .prepare(
      `INSERT INTO artifacts (
       artifact_digest, build_key, build_id, attempt_id, manifest_digest, platform_manifest_digest,
       composition_manifest_digest, producer_revision, requested_modules_json, resolved_modules_json,
       contract_versions_json, sbom_ref, provenance_ref, verification_json, statement_json, signature_json,
       verifier_id, status, created_at, admitted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', '{"build":"scriptorium-build/v1","platform":"scriptorium-platform/v1"}',
       NULL, NULL, '{"checks":{"closure":true}}', '{"subject":"test"}', '{"keyId":"test-key","signature":"test-signature"}',
       'test-verifier', 'admitted', 10, 10)`,
    )
    .run(
      artifactDigest,
      buildKey,
      buildId,
      attemptId,
      manifestDigest,
      platformDigest,
      compositionDigest,
      producerRevision,
    );
  database
    .prepare(
      `INSERT INTO deployment_revisions (
       revision_id, instance_id, repository_id, generation, build_key, build_id, selection_json,
       resource_requirements_json, runtime_metadata_json, artifact_digest, status, actor_id, created_at
     ) VALUES ('revision-1', ?, 71, 1, ?, ?, '{}', ?, ?, ?, 'admitted', 'user-1', 10)`,
    )
    .run(
      instanceId,
      buildKey,
      buildId,
      JSON.stringify(resources()),
      JSON.stringify(runtimeMetadata(producerRevision)),
      artifactDigest,
    );
  database
    .prepare(
      `UPDATE logical_instances SET desired_revision_id = 'revision-1', desired_artifact_digest = ? WHERE instance_id = ?`,
    )
    .run(artifactDigest, instanceId);
}

function seedCurrentReadyRuntime(database: DatabaseSync, instanceId: string): void {
  database
    .prepare(
      `UPDATE logical_instances
       SET generation = 1, runtime_epoch = 1, desired_state = 'running',
           observed_generation = 1, observed_runtime_epoch = 1, observed_sequence = 7,
           observed_state = 'ready', observed_revision_id = 'revision-1',
           desired_revision_id = 'revision-1',
           desired_artifact_digest = ?, current_artifact_digest = ?
       WHERE instance_id = ?`,
    )
    .run(`sha256:${"a".repeat(64)}`, `sha256:${"a".repeat(64)}`, instanceId);
}

function resources() {
  return { cpuMilli: 400, memoryMiB: 256, ephemeralStorageMiB: 128 } as const;
}

function capacitySnapshot() {
  return {
    allocatable: { cpuMilli: 1_000, memoryMiB: 1_024, ephemeralStorageMiB: 1_024 },
    requested: { cpuMilli: 100, memoryMiB: 100, ephemeralStorageMiB: 100 },
    nodeResourceVersion: "node-rv-1",
    podResourceVersion: "pod-rv-1",
  } as const;
}

function runtimeMetadata(producerRevision: string) {
  return {
    contractVersion: "scriptorium-platform/v1",
    producerRevision,
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
  } as const;
}

function observation(instanceId: string, repositoryId: number, sequence: number) {
  return {
    instanceId,
    repositoryId,
    generation: 1,
    runtimeEpoch: 1,
    sequence,
    observedState: "ready" as const,
    observedArtifactDigest: `sha256:${"a".repeat(64)}`,
    observedRevisionId: "revision-1",
    reportedAt: 200,
  };
}

function stoppedObservation(
  instanceId: string,
  repositoryId: number,
  generation: number,
  runtimeEpoch: number,
  sequence: number,
) {
  return {
    instanceId,
    repositoryId,
    generation,
    runtimeEpoch,
    sequence,
    observedState: "stopped" as const,
    observedArtifactDigest: null,
    observedRevisionId: null,
    reportedAt: 200,
  };
}

class SqliteD1Database implements D1Database {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly database: DatabaseSync) {}

  prepare(query: string): D1PreparedStatement {
    return new SqliteD1Statement(this.database, query, []);
  }

  async batch<T = unknown>(
    statements: readonly D1PreparedStatement[],
  ): Promise<readonly D1Result<T>[]> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      this.database.exec("BEGIN IMMEDIATE");
      const results: D1Result<T>[] = [];
      for (const statement of statements) results.push(await statement.run<T>());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    } finally {
      release();
    }
  }
}

class SqliteD1Statement implements D1PreparedStatement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly query: string,
    private readonly values: readonly SQLInputValue[],
  ) {}

  bind(
    ...values: readonly (string | number | null | ArrayBuffer | Uint8Array)[]
  ): D1PreparedStatement {
    return new SqliteD1Statement(this.database, this.query, values.map(sqlInput));
  }

  async first<T = unknown>(): Promise<T | null> {
    const row = this.database.prepare(this.query).get(...this.values);
    return (row as T | undefined) ?? null;
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    const rows = this.database.prepare(this.query).all(...this.values) as T[];
    return { results: rows, success: true, meta: { changes: 0 } };
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    const statement = this.database.prepare(this.query);
    if (/\bRETURNING\b/iu.test(this.query)) {
      const rows = statement.all(...this.values) as T[];
      return { results: rows, success: true, meta: { changes: rows.length } };
    }
    const result = statement.run(...this.values);
    return { results: [], success: true, meta: { changes: Number(result.changes) } };
  }
}

function sqlInput(value: string | number | null | ArrayBuffer | Uint8Array): SQLInputValue {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return value;
}
