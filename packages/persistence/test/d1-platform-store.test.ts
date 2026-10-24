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

    seedAdmittedGrant(database, claimed.operation.id);
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

  it("persists route-activated target readiness before releasing the retired reservation", async () => {
    const fixture = await prepareTargetRedeploy();
    const { database, instances, operations, binding, operation, lease } = fixture;
    const targetObservation = readyTargetObservation(operation, binding.instanceId, 1);

    const progressed = await operations.report({
      ...lease,
      sequence: 1,
      now: 103,
      observation: targetObservation,
    });
    expect(progressed).toMatchObject({
      applied: true,
      operation: { status: "running", phase: "route-activated", reportSequence: 1 },
    });
    expect(await instances.getByInstanceId(binding.instanceId)).toMatchObject({
      instance: {
        generation: operation.generation,
        runtimeEpoch: operation.runtimeEpoch,
        observedGeneration: operation.generation,
        observedRuntimeEpoch: operation.runtimeEpoch,
        observedState: "ready",
        observedRevisionId: "revision-1",
        currentArtifactDigest: `sha256:${"a".repeat(64)}`,
      },
    });

    database
      .prepare("UPDATE operations SET lease_expires_at = 103 WHERE operation_id = ?")
      .run(operation.id);
    const reclaimedBeforeRelease = await operations.claimNext({
      workerId: "provisioner-recovery-1",
      clusterId: "cluster-a",
      now: 104,
    });
    if (!reclaimedBeforeRelease) throw new Error("expected route-activated operation reclaim");
    const recoveredLease = {
      operationId: reclaimedBeforeRelease.operation.id,
      workerId: reclaimedBeforeRelease.operation.workerId!,
      leaseToken: reclaimedBeforeRelease.operation.leaseToken!,
      leaseEpoch: reclaimedBeforeRelease.operation.leaseEpoch,
    } as const;

    await operations.releaseRuntime({
      ...recoveredLease,
      reservationId: "old-reservation",
      expectedReservationRuntimeEpoch: 1,
      now: 105,
    });
    expect(
      database
        .prepare("SELECT status FROM runtime_reservations WHERE reservation_id = 'old-reservation'")
        .get(),
    ).toMatchObject({ status: "released" });

    database
      .prepare("UPDATE operations SET lease_expires_at = 106 WHERE operation_id = ?")
      .run(operation.id);
    const reclaimedAfterRelease = await operations.claimNext({
      workerId: "provisioner-recovery-2",
      clusterId: "cluster-a",
      now: 107,
    });
    if (!reclaimedAfterRelease) throw new Error("expected post-release operation reclaim");
    const replayLease = {
      operationId: reclaimedAfterRelease.operation.id,
      workerId: reclaimedAfterRelease.operation.workerId!,
      leaseToken: reclaimedAfterRelease.operation.leaseToken!,
      leaseEpoch: reclaimedAfterRelease.operation.leaseEpoch,
    } as const;
    await operations.releaseRuntime({
      ...replayLease,
      reservationId: "old-reservation",
      expectedReservationRuntimeEpoch: 1,
      now: 108,
    });
    expect(
      database
        .prepare(
          "SELECT count(*) AS n FROM audit_events WHERE event_id = 'runtime.reservation.released:old-reservation:' || ?",
        )
        .get(operation.id),
    ).toMatchObject({ n: 1 });

    const complete = lifecycleCheckpoint(operation, { phase: "complete" });
    await operations.checkpoint({
      ...replayLease,
      expectedCheckpointSequence: 1,
      phase: "complete",
      checkpoint: complete,
      now: 109,
    });
    await expect(
      operations.report({
        ...replayLease,
        sequence: 1,
        now: 110,
        terminal: "succeeded",
        observation: null,
      }),
    ).rejects.toBeInstanceOf(OperationFenceConflict);
    await expect(
      operations.report({
        ...replayLease,
        sequence: 1,
        now: 110,
        terminal: "succeeded",
        observation: { ...targetObservation, sequence: 2 },
      }),
    ).resolves.toMatchObject({
      applied: true,
      operation: { status: "succeeded", phase: "complete", reportSequence: 1 },
    });
  });

  it("requires the matching release audit proof to replay a released reservation", async () => {
    const fixture = await prepareTargetRedeploy();
    const { database, operations, binding, operation, lease } = fixture;
    await operations.report({
      ...lease,
      sequence: 1,
      now: 103,
      observation: readyTargetObservation(operation, binding.instanceId, 1),
    });
    await operations.releaseRuntime({
      ...lease,
      reservationId: "old-reservation",
      expectedReservationRuntimeEpoch: 1,
      now: 104,
    });

    database
      .prepare(
        `UPDATE audit_events SET metadata_json = ?
         WHERE event_id = ?`,
      )
      .run(
        JSON.stringify({ reservationId: "old-reservation", retiredRuntimeEpoch: 99 }),
        `runtime.reservation.released:old-reservation:${operation.id}`,
      );
    database
      .prepare("UPDATE operations SET lease_expires_at = 105 WHERE operation_id = ?")
      .run(operation.id);
    const reclaimed = await operations.claimNext({
      workerId: "provisioner-recovery",
      clusterId: "cluster-a",
      now: 106,
    });
    if (!reclaimed) throw new Error("expected route-activated operation reclaim");

    await expect(
      operations.releaseRuntime({
        operationId: reclaimed.operation.id,
        workerId: reclaimed.operation.workerId!,
        leaseToken: reclaimed.operation.leaseToken!,
        leaseEpoch: reclaimed.operation.leaseEpoch,
        reservationId: "old-reservation",
        expectedReservationRuntimeEpoch: 1,
        now: 107,
      }),
    ).rejects.toBeInstanceOf(OperationFenceConflict);
  });

  it("releases the exact retained observed reservation for a newer-epoch stop operation", async () => {
    const fixture = await prepareRetainedStopReservationRelease();
    await checkpointRetainedStopAbsence(fixture, 7);

    await fixture.operations.releaseRuntime({
      ...fixture.lease,
      reservationId: fixture.reservationId,
      expectedReservationRuntimeEpoch: 7,
      now: 103,
    });
    expect(fixture.database.prepare(
      "SELECT status FROM runtime_reservations WHERE reservation_id = ?",
    ).get(fixture.reservationId)).toMatchObject({ status: "released" });
    expect(fixture.database.prepare(
      "SELECT reservation_id, reservation_state FROM logical_instances WHERE instance_id = ?",
    ).get(fixture.binding.instanceId)).toMatchObject({ reservation_id: null, reservation_state: "released" });
  });

  it("reports a retained-writer stop against the exact prior observed epoch, not the stop target epoch", async () => {
    const fixture = await prepareRetainedStopReservationRelease();
    const proof = {
      instanceId: fixture.binding.instanceId,
      repositoryId: fixture.binding.repositoryId,
      retiredRuntimeEpoch: 7,
      providerObservationId: "retained-writer-absence-observation",
      censusObservedAt: "2026-10-25T00:00:00.000Z",
      remainingWriters: 0,
      evidenceIdentities: ["retained-writer-pod-uid-17"],
      source: "runtime-provider-census",
    } as const;
    await checkpointRetainedStopAbsence(fixture, 7);
    await fixture.operations.releaseRuntime({
      ...fixture.lease,
      reservationId: fixture.reservationId,
      expectedReservationRuntimeEpoch: 7,
      now: 103,
    });
    await fixture.operations.checkpoint({
      ...fixture.lease,
      expectedCheckpointSequence: 1,
      phase: "complete",
      checkpoint: { writerAbsenceProof: proof },
      now: 104,
    });

    await fixture.operations.report({
      ...fixture.lease,
      sequence: 1,
      now: 105,
      terminal: "succeeded",
      observation: stoppedObservation(
        fixture.binding.instanceId,
        fixture.binding.repositoryId,
        20,
        9,
        8,
      ),
    });
    expect(await fixture.operations.getById(fixture.operation.id)).toMatchObject({
      status: "succeeded",
      runtimeEpoch: 9,
      checkpoint: { writerAbsenceProof: { retiredRuntimeEpoch: 7 } },
    });
    expect(await fixture.instances.getByInstanceId(fixture.binding.instanceId)).toMatchObject({
      instance: { generation: 20, runtimeEpoch: 9, observedGeneration: 20, observedRuntimeEpoch: 9, observedState: "stopped" },
    });
  });

  it("reports an epoch-zero stop with a null retired epoch only when the instance has no observed writer", async () => {
    const { database, registry, instances, operations } = createPlatform();
    const { binding } = await registry.resolveOrCreate(registryInput("instance-no-history", "request-no-history"));
    database.prepare("UPDATE logical_instances SET desired_state = 'running' WHERE instance_id = ?")
      .run(binding.instanceId);
    const requested = await instances.requestDesiredState({
      repositoryId: binding.repositoryId,
      bindingEpoch: binding.bindingEpoch,
      authorizationRevision: binding.authorizationRevision,
      desiredState: "stopped",
      expectedGeneration: 0,
      actorId: "user-1",
      idempotencyKey: "stop-no-history",
      requestId: "stop-no-history-request",
      now: 100,
    });
    expect(requested.operation).toMatchObject({ kind: "stop", generation: 1, runtimeEpoch: 0 });
    const claimed = await operations.claimNext({ workerId: "provisioner-no-history", clusterId: "cluster-a", now: 101 });
    if (!claimed) throw new Error("expected epoch-zero stop claim");
    const lease = {
      operationId: claimed.operation.id,
      workerId: claimed.operation.workerId!,
      leaseToken: claimed.operation.leaseToken!,
      leaseEpoch: claimed.operation.leaseEpoch,
    };
    const proof = {
      instanceId: binding.instanceId,
      repositoryId: binding.repositoryId,
      retiredRuntimeEpoch: null,
      providerObservationId: "complete-no-writer-census",
      censusObservedAt: new Date(102).toISOString(),
      remainingWriters: 0,
      evidenceIdentities: [],
      source: "runtime-provider-census",
    } as const;
    await operations.checkpoint({
      ...lease,
      expectedCheckpointSequence: 0,
      phase: "old-writer-absent",
      checkpoint: { writerAbsenceProof: proof },
      now: 102,
    });
    await operations.checkpoint({
      ...lease,
      expectedCheckpointSequence: 1,
      phase: "complete",
      checkpoint: { writerAbsenceProof: proof },
      now: 103,
    });
    await operations.report({
      ...lease,
      sequence: 1,
      now: 104,
      terminal: "succeeded",
      observation: stoppedObservation(binding.instanceId, binding.repositoryId, 1, 0, 1),
    });
    expect(await operations.getById(claimed.operation.id)).toMatchObject({
      status: "succeeded",
      runtimeEpoch: 0,
      checkpoint: { writerAbsenceProof: { retiredRuntimeEpoch: null, remainingWriters: 0 } },
    });
  });

  it.each([
    { cause: "wrong retired epoch", retiredEpoch: 8, override: {} },
    { cause: "missing retired epoch", retiredEpoch: null, override: {} },
    { cause: "invalid provider proof", retiredEpoch: 7, override: { source: "operator-assertion" } },
    { cause: "newer desired generation", retiredEpoch: 7, override: {}, generation: 21 },
    { cause: "expired worker lease", retiredEpoch: 7, override: {}, expireLease: true },
  ])("rejects a retained-writer stop report with $cause", async ({ cause: _cause, retiredEpoch, override, generation, expireLease }) => {
    const fixture = await prepareRetainedStopReservationRelease();
    await checkpointRetainedStopAbsence(fixture, retiredEpoch, override);
    const current = await fixture.operations.getById(fixture.operation.id);
    if (!current) throw new Error("expected stop operation");
    await fixture.operations.checkpoint({
      ...fixture.lease,
      expectedCheckpointSequence: 1,
      phase: "complete",
      checkpoint: current.checkpoint,
      now: 104,
    });
    fixture.database.prepare(
      "UPDATE runtime_reservations SET status = 'released' WHERE reservation_id = ?",
    ).run(fixture.reservationId);
    fixture.database.prepare(
      `UPDATE logical_instances SET reservation_id = NULL, reservation_state = 'released',
         runtime_authority_reservation_id = NULL, runtime_authority_operation_id = NULL,
         generation = COALESCE(?, generation) WHERE instance_id = ?`,
    ).run(generation ?? null, fixture.binding.instanceId);

    await expect(fixture.operations.report({
      ...fixture.lease,
      sequence: 1,
      now: expireLease ? fixture.leaseExpiresAt : 105,
      terminal: "succeeded",
      observation: stoppedObservation(
        fixture.binding.instanceId,
        fixture.binding.repositoryId,
        20,
        9,
        8,
      ),
    })).rejects.toBeInstanceOf(OperationFenceConflict);
    expect(await fixture.operations.getById(fixture.operation.id)).toMatchObject({
      status: "claimed",
      reportSequence: 0,
    });
  });

  it.each([
    { cause: "missing absence proof", mutate: async (f: Awaited<ReturnType<typeof prepareRetainedStopReservationRelease>>) => checkpointRetainedStopAbsence(f, null) },
    { cause: "wrong retired epoch", mutate: async (f: Awaited<ReturnType<typeof prepareRetainedStopReservationRelease>>) => checkpointRetainedStopAbsence(f, 6) },
    { cause: "wrong old reservation generation", mutate: async (f: Awaited<ReturnType<typeof prepareRetainedStopReservationRelease>>) => {
      await checkpointRetainedStopAbsence(f, 7);
      f.database.prepare("UPDATE runtime_reservations SET generation = 16 WHERE reservation_id = ?").run(f.reservationId);
    } },
    { cause: "newer desired generation", mutate: async (f: Awaited<ReturnType<typeof prepareRetainedStopReservationRelease>>) => {
      await checkpointRetainedStopAbsence(f, 7);
      f.database.prepare("UPDATE logical_instances SET generation = 21 WHERE instance_id = ?").run(f.binding.instanceId);
    } },
    { cause: "expired stop lease", mutate: async (f: Awaited<ReturnType<typeof prepareRetainedStopReservationRelease>>) => {
      await checkpointRetainedStopAbsence(f, 7);
    }, expireLease: true },
  ])("does not release a retained reservation with $cause", async ({ mutate, expireLease }) => {
    const fixture = await prepareRetainedStopReservationRelease();
    await mutate(fixture);
    await expect(fixture.operations.releaseRuntime({
      ...fixture.lease,
      reservationId: fixture.reservationId,
      expectedReservationRuntimeEpoch: 7,
      now: expireLease ? fixture.leaseExpiresAt : 103,
    })).rejects.toBeInstanceOf(OperationFenceConflict);
    expect(fixture.database.prepare(
      "SELECT status FROM runtime_reservations WHERE reservation_id = ?",
    ).get(fixture.reservationId)).toMatchObject({ status: "allocated" });
  });

  it("cannot create writer authority by reporting ready before credential retirement admission", async () => {
    const { database, operations, binding, operation, lease } = await prepareTargetRedeploy();
    database.prepare(`UPDATE logical_instances SET runtime_authority_reservation_id = NULL,
      runtime_authority_operation_id = NULL WHERE instance_id = ?`).run(binding.instanceId);
    await expect(operations.report({ ...lease, sequence: 1, now: 103,
      observation: readyTargetObservation(operation, binding.instanceId, 1),
    })).rejects.toBeInstanceOf(OperationFenceConflict);
    expect(await operations.getById(operation.id)).toMatchObject({ reportSequence: 0 });
    expect(database.prepare("SELECT runtime_authority_reservation_id FROM logical_instances WHERE instance_id = ?")
      .get(binding.instanceId)).toMatchObject({ runtime_authority_reservation_id: null });
  });

  it("accepts a stopped-to-running target with a fresh census and no retired epoch", async () => {
    const { database, registry, instances, operations } = createPlatform();
    const resolved = await registry.resolveOrCreate(registryInput("instance-a", "request-a"));
    const { binding } = resolved;
    seedDeployment(database, binding.instanceId);
    database
      .prepare(
        `UPDATE logical_instances SET generation = 1, runtime_epoch = 1, desired_state = 'stopped',
           observed_generation = 1, observed_runtime_epoch = 1, observed_sequence = 2,
           observed_state = 'stopped', observed_revision_id = NULL, current_artifact_digest = NULL,
           desired_revision_id = 'revision-1', reservation_state = 'released', reservation_id = NULL
         WHERE instance_id = ?`,
      )
      .run(binding.instanceId);
    const requested = await instances.requestDesiredState({
      repositoryId: 71,
      bindingEpoch: binding.bindingEpoch,
      authorizationRevision: binding.authorizationRevision,
      desiredState: "running",
      actorId: "user-1",
      idempotencyKey: "wake-1",
      requestId: "wake-request",
      now: 100,
    });
    if (!requested.operation) throw new Error("expected start operation");
    const claimed = await operations.claimNext({
      workerId: "provisioner-1",
      clusterId: "cluster-a",
      now: 101,
    });
    if (!claimed) throw new Error("expected admitted start claim");
    const operation = claimed.operation;
    const lease = {
      operationId: operation.id,
      workerId: operation.workerId!,
      leaseToken: operation.leaseToken!,
      leaseEpoch: operation.leaseEpoch,
    } as const;
    await operations.checkpoint({
      ...lease,
      expectedCheckpointSequence: 0,
      phase: "route-activated",
      checkpoint: lifecycleCheckpoint(operation, {
        phase: "route-activated",
        retiredRuntimeEpoch: null,
      }),
      now: 102,
    });

    seedAdmittedGrant(database, operation.id);
    await expect(
      operations.report({
        ...lease,
        sequence: 1,
        now: 103,
        observation: readyTargetObservation(operation, binding.instanceId, 1),
      }),
    ).resolves.toMatchObject({
      applied: true,
      operation: { status: "running", phase: "route-activated", reportSequence: 1 },
    });
  });

  it.each([
    ["before route activation", { checkpointPhase: "starting-target" as const }],
    ["when readiness is bound to another revision", { readinessRevisionId: "other-revision" }],
    [
      "when readiness is bound to another image",
      { readinessImageDigest: `sha256:${"e".repeat(64)}` },
    ],
    ["when readiness is bound to another generation", { readinessGeneration: 1 }],
    ["when the route is a rollback", { rollbackEpoch: 1 }],
    ["when an existing writer lacks its retirement proof", { includeWriterAbsenceProof: false }],
  ])("rejects nonterminal ready observations %s", async (_name, options) => {
    const fixture = await prepareTargetRedeploy(options);
    const { database, instances, operations, binding, operation, lease } = fixture;

    await expect(
      operations.report({
        ...lease,
        sequence: 1,
        now: 103,
        observation: readyTargetObservation(operation, binding.instanceId, 1),
      }),
    ).rejects.toBeInstanceOf(OperationFenceConflict);
    expect(await operations.getById(operation.id)).toMatchObject({ reportSequence: 0 });
    expect(await instances.getByInstanceId(binding.instanceId)).toMatchObject({
      instance: { observedGeneration: 1, observedRuntimeEpoch: 1, observedState: "ready" },
    });
    expect(
      database
        .prepare("SELECT status FROM runtime_reservations WHERE reservation_id = 'old-reservation'")
        .get(),
    ).toMatchObject({ status: "reserved" });
  });

  it("keeps non-ready and failed or blocked terminal reports observation-free", async () => {
    const nonReady = await prepareTargetRedeploy();
    await expect(
      nonReady.operations.report({
        ...nonReady.lease,
        sequence: 1,
        now: 103,
        observation: {
          ...readyTargetObservation(nonReady.operation, nonReady.binding.instanceId, 1),
          observedState: "starting",
        },
      }),
    ).rejects.toBeInstanceOf(OperationFenceConflict);

    const failed = await prepareTargetRedeploy();
    await expect(
      failed.operations.report({
        ...failed.lease,
        sequence: 1,
        now: 103,
        terminal: "failed",
        observation: readyTargetObservation(failed.operation, failed.binding.instanceId, 1),
      }),
    ).rejects.toBeInstanceOf(OperationFenceConflict);
    await expect(
      failed.operations.report({
        ...failed.lease,
        sequence: 1,
        now: 103,
        terminal: "failed",
        observation: null,
      }),
    ).resolves.toMatchObject({ operation: { status: "failed" } });

    const blocked = await prepareTargetRedeploy();
    await expect(
      blocked.operations.report({
        ...blocked.lease,
        sequence: 1,
        now: 103,
        terminal: "blocked",
        observation: readyTargetObservation(blocked.operation, blocked.binding.instanceId, 1),
      }),
    ).rejects.toBeInstanceOf(OperationFenceConflict);
    await expect(
      blocked.operations.report({
        ...blocked.lease,
        sequence: 1,
        now: 103,
        terminal: "blocked",
        observation: null,
      }),
    ).resolves.toMatchObject({ operation: { status: "blocked" } });
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
    seedAdmittedGrant(database, start.operation.id);
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
          providerObservationId: "complete-stop-census",
          censusObservedAt: "2026-10-25T00:00:00.000Z",
          remainingWriters: 0,
          evidenceIdentities: ["old-pod-uid"],
          source: "runtime-provider-census",
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
          providerObservationId: "complete-stop-census",
          censusObservedAt: "2026-10-25T00:00:00.000Z",
          remainingWriters: 0,
          evidenceIdentities: ["old-pod-uid"],
          source: "runtime-provider-census",
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
  database.exec(readFileSync(new URL("../../../apps/control-plane/migrations/0006_application_origins.sql", import.meta.url), "utf8"));
  database.exec(
    readFileSync(
      fileURLToPath(
        new URL(
          "../../../apps/control-plane/migrations/0004_runtime_git_credentials.sql",
          import.meta.url,
        ),
      ),
      "utf8",
    ),
  );
  database.exec(readFileSync(new URL("../../../apps/control-plane/migrations/0009_runtime_authority.sql", import.meta.url), "utf8"));
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

type TargetCheckpointOptions = {
  readonly checkpointPhase?: "starting-target" | "route-activated";
  readonly readinessRevisionId?: string;
  readonly readinessImageDigest?: string;
  readonly readinessGeneration?: number;
  readonly rollbackEpoch?: number;
  readonly includeWriterAbsenceProof?: boolean;
  readonly retiredRuntimeEpoch?: number | null;
};

async function prepareRetainedStopReservationRelease() {
  const platform = createPlatform();
  const { database, registry, instances, operations } = platform;
  const resolved = await registry.resolveOrCreate(registryInput("instance-retained-stop", "request-retained-stop"));
  const { binding } = resolved;
  seedDeployment(database, binding.instanceId);
  seedCurrentReadyRuntime(database, binding.instanceId);
  const reservationId = "retained-writer-epoch-7";
  database.prepare(`INSERT INTO runtime_reservations (
    reservation_id, instance_id, repository_id, runtime_epoch, generation, cluster_id, status,
    capacity_snapshot_epoch, cpu_milli, memory_mib, ephemeral_storage_mib, created_at, updated_at
  ) VALUES (?, ?, 71, 7, 17, 'cluster-a', 'allocated', 1, 400, 256, 128, 10, 10)`)
    .run(reservationId, binding.instanceId);
  database.prepare(`INSERT INTO operations (
    operation_id, instance_id, repository_id, generation, runtime_epoch, kind, status, phase,
    attempt, lease_epoch, report_sequence, checkpoint_sequence, cluster_id, reservation_id,
    deployment_revision_id, idempotency_scope, idempotency_key, request_hash, actor_id,
    authorization_revision, created_at, updated_at
  ) VALUES ('retained-writer-op', ?, 71, 17, 7, 'update', 'succeeded', 'complete',
    1, 1, 1, 0, 'cluster-a', ?, 'revision-1', 'repository:71', 'retained-writer',
    'retained-writer-hash', 'user-1', 3, 10, 10)`)
    .run(binding.instanceId, reservationId);
  database.prepare(`UPDATE logical_instances SET generation = 19, runtime_epoch = 9,
    desired_state = 'running', observed_generation = 17, observed_runtime_epoch = 7,
    observed_state = 'ready', observed_revision_id = 'revision-1',
    reservation_state = 'allocated', reservation_id = ?,
    runtime_authority_reservation_id = ?, runtime_authority_operation_id = 'retained-writer-op'
    WHERE instance_id = ?`)
    .run(reservationId, reservationId, binding.instanceId);

  const requested = await instances.requestDesiredState({
    repositoryId: binding.repositoryId,
    bindingEpoch: binding.bindingEpoch,
    authorizationRevision: binding.authorizationRevision,
    desiredState: "stopped",
    expectedGeneration: 19,
    actorId: "system:stable-release-canary",
    idempotencyKey: "stable-canary-stop:release-v038",
    requestId: "t11-canary-stop:operation-v038",
    now: 100,
  });
  if (!requested.operation) throw new Error("expected a retained-writer stop operation");
  expect(requested.operation).toMatchObject({ generation: 20, runtimeEpoch: 9, kind: "stop" });
  const claimed = await operations.claimNext({ workerId: "provisioner-stop", clusterId: "cluster-a", now: 101 });
  if (!claimed) throw new Error("expected retained-writer stop claim");
  return {
    ...platform,
    binding,
    reservationId,
    operation: claimed.operation,
    leaseExpiresAt: claimed.operation.leaseExpiresAt!,
    lease: {
      operationId: claimed.operation.id,
      workerId: claimed.operation.workerId!,
      leaseToken: claimed.operation.leaseToken!,
      leaseEpoch: claimed.operation.leaseEpoch,
    },
  };
}

async function checkpointRetainedStopAbsence(
  fixture: Awaited<ReturnType<typeof prepareRetainedStopReservationRelease>>,
  retiredEpoch: number | null,
  proofOverride: Readonly<Record<string, unknown>> = {},
) {
  await fixture.operations.checkpoint({
    ...fixture.lease,
    expectedCheckpointSequence: 0,
    phase: "old-writer-absent",
    checkpoint: retiredEpoch === null ? {} : {
      writerAbsenceProof: {
        instanceId: fixture.binding.instanceId,
        repositoryId: fixture.binding.repositoryId,
        retiredRuntimeEpoch: retiredEpoch,
        providerObservationId: "retained-writer-absence-observation",
        censusObservedAt: "2026-10-25T00:00:00.000Z",
        remainingWriters: 0,
        evidenceIdentities: ["retained-writer-pod-uid-17"],
        source: "runtime-provider-census",
        ...proofOverride,
      },
    },
    now: 102,
  });
}

async function prepareTargetRedeploy(options: TargetCheckpointOptions = {}) {
  const platform = createPlatform();
  const { database, registry, instances, operations } = platform;
  const resolved = await registry.resolveOrCreate(registryInput("instance-a", "request-a"));
  const { binding } = resolved;
  seedDeployment(database, binding.instanceId);
  seedCurrentReadyRuntime(database, binding.instanceId);
  database
    .prepare(
      `INSERT INTO runtime_reservations (
         reservation_id, instance_id, repository_id, runtime_epoch, generation, cluster_id, status,
         capacity_snapshot_epoch, cpu_milli, memory_mib, ephemeral_storage_mib, created_at, updated_at
       ) VALUES ('old-reservation', ?, 71, 1, 1, 'cluster-a', 'reserved', 1, 400, 256, 128, 10, 10)`,
    )
    .run(binding.instanceId);
  database
    .prepare(
      "UPDATE logical_instances SET reservation_id = 'old-reservation', reservation_state = 'reserved' WHERE instance_id = ?",
    )
    .run(binding.instanceId);

  await instances.requestDesiredState({
    repositoryId: 71,
    bindingEpoch: binding.bindingEpoch,
    authorizationRevision: binding.authorizationRevision,
    desiredState: "running",
    forceNewRuntime: true,
    actorId: "user-1",
    idempotencyKey: "redeploy-1",
    requestId: "redeploy-request",
    now: 100,
  });
  const claimed = await operations.claimNext({
    workerId: "provisioner-1",
    clusterId: "cluster-a",
    now: 101,
  });
  if (!claimed) throw new Error("expected admitted redeploy claim");
  const operation = claimed.operation;
  const lease = {
    operationId: operation.id,
    workerId: operation.workerId!,
    leaseToken: operation.leaseToken!,
    leaseEpoch: operation.leaseEpoch,
  } as const;
  const checkpointPhase = options.checkpointPhase ?? "route-activated";
  await operations.checkpoint({
    ...lease,
    expectedCheckpointSequence: 0,
    phase: checkpointPhase,
    checkpoint: lifecycleCheckpoint(operation, { ...options, phase: checkpointPhase }),
    now: 102,
  });
  seedAdmittedGrant(database, operation.id);
  return { ...platform, binding, operation, lease };
}

// These report-store fixtures begin after the separately tested retirement
// barrier has published the target grant. Reports may only promote that grant.
function seedAdmittedGrant(database: DatabaseSync, operationId: string): void {
  database.prepare(`INSERT INTO runtime_reservations (reservation_id, instance_id, repository_id,
    runtime_epoch, generation, cluster_id, status, capacity_snapshot_epoch, cpu_milli, memory_mib,
    ephemeral_storage_mib, created_at, updated_at)
    SELECT 'test-authority:' || operation_id, instance_id, repository_id, runtime_epoch, generation,
      cluster_id, 'reserved', 1, 1, 1, 1, 1, 1 FROM operations WHERE operation_id = ?
    ON CONFLICT(instance_id, runtime_epoch) DO UPDATE SET status = 'reserved'`).run(operationId);
  database.prepare(`UPDATE operations SET reservation_id = (
    SELECT reservation_id FROM runtime_reservations r WHERE r.instance_id = operations.instance_id
      AND r.runtime_epoch = operations.runtime_epoch) WHERE operation_id = ?`).run(operationId);
  database.prepare(`UPDATE logical_instances SET
    runtime_authority_reservation_id = (SELECT reservation_id FROM operations WHERE operation_id = ?),
    runtime_authority_operation_id = ?
    WHERE instance_id = (SELECT instance_id FROM operations WHERE operation_id = ?)`)
    .run(operationId, operationId, operationId);
}

function lifecycleCheckpoint(
  operation: {
    readonly id: string;
    readonly instanceId: string;
    readonly repositoryId: number;
    readonly generation: number;
    readonly runtimeEpoch: number;
  },
  options: TargetCheckpointOptions & {
    readonly phase?: "starting-target" | "route-activated" | "complete";
  } = {},
) {
  const imageDigest = `sha256:${"a".repeat(64)}`;
  const checkpoint: Record<string, unknown> = {
    schemaVersion: 1,
    lifecycle: {
      id: operation.id,
      instanceId: operation.instanceId,
      repositoryId: operation.repositoryId,
      clusterId: "cluster-a",
      generation: operation.generation,
      runtimeEpoch: operation.runtimeEpoch,
      phase: options.phase ?? "route-activated",
      targetEpoch: operation.runtimeEpoch,
      target: { revisionId: "revision-1", imageDigest },
      rollbackEpoch: options.rollbackEpoch ?? null,
      readinessEvidence: {
        assignment: {
          instanceId: operation.instanceId,
          repositoryId: operation.repositoryId,
          generation: options.readinessGeneration ?? operation.generation,
          clusterId: "cluster-a",
          runtimeEpoch: operation.runtimeEpoch,
          deployment: {
            revisionId: options.readinessRevisionId ?? "revision-1",
            imageDigest: options.readinessImageDigest ?? imageDigest,
          },
        },
      },
    },
  };
  if (options.includeWriterAbsenceProof !== false) {
    checkpoint.writerAbsenceProof = {
      instanceId: operation.instanceId,
      repositoryId: operation.repositoryId,
      retiredRuntimeEpoch:
        options.retiredRuntimeEpoch === undefined ? 1 : options.retiredRuntimeEpoch,
      providerObservationId: "runtime-list-resource-version-7",
      censusObservedAt: "2026-10-20T12:00:00.000Z",
      remainingWriters: 0,
      source: "runtime-provider-census",
    };
  }
  return checkpoint;
}

function readyTargetObservation(
  operation: {
    readonly generation: number;
    readonly runtimeEpoch: number;
  },
  instanceId: string,
  sequence: number,
) {
  return {
    instanceId,
    repositoryId: 71,
    generation: operation.generation,
    runtimeEpoch: operation.runtimeEpoch,
    sequence,
    observedState: "ready" as const,
    observedArtifactDigest: `sha256:${"a".repeat(64)}`,
    observedRevisionId: "revision-1",
    reportedAt: 103,
  };
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
