import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { ZodError } from "zod";
import { InstanceService, RepositoryRegistryService } from "@praetorium/application/instances";
import { OperationService } from "@praetorium/application/operations";
import { D1PlatformStore } from "@praetorium/persistence/d1";
import type { D1Database, D1PreparedStatement, D1Result } from "@praetorium/persistence/d1";
import {
  createControlCredentialIssuer,
  type ControlCredentialIssuer,
} from "./control-credentials.js";
import {
  createProvisionerIdleRoutes,
  type ProvisionerIdleRoutesDependencies,
} from "./idle-routes.js";
import { createRuntimeHealthRoutes } from "./runtime-health-routes.js";

const schemaUrl = new URL("../../../docs/migration/tasks/T03-schema.sql", import.meta.url);
const activeDatabases: DatabaseSync[] = [];
const NOW = Date.parse("2026-10-17T00:00:10.000Z");
const WORKER_ID = "worker-a";
const CLUSTER_ID = "cluster-a";

afterEach(() => {
  for (const database of activeDatabases.splice(0)) database.close();
});

describe("Control Plane provisioner idle routes", () => {
  it("records fresh current-writer health and rejects replay, stale epoch and changed image", async () => {
    const h = createHarness();
    await h.addReadyInstance("ins_health", 701);
    h.database.exec(
      readFileSync(
        new URL("../migrations/0005_runtime_health_observations.sql", import.meta.url),
        "utf8",
      ),
    );
    h.database
      .prepare(
        `INSERT INTO operations (
      operation_id,instance_id,repository_id,generation,runtime_epoch,kind,status,phase,
      deployment_revision_id,idempotency_scope,idempotency_key,request_hash,actor_id,authorization_revision,created_at,updated_at
    ) VALUES ('op-health','ins_health',701,1,1,'start','succeeded','complete',
      'revision-ins_health','health','health','health','user-1',3,?,?)`,
      )
      .run(NOW, NOW);
    const route = createRuntimeHealthRoutes({
      db: new SqliteD1Database(h.database),
      workerId: WORKER_ID,
      clusterId: CLUSTER_ID,
      now: () => NOW,
    });
    const body = {
      workerId: WORKER_ID,
      clusterId: CLUSTER_ID,
      operationId: "op-health",
      readinessEvidence: {
        assignment: {
          instanceId: "ins_health",
          repositoryId: 701,
          runtimeEpoch: 1,
          generation: 1,
          clusterId: CLUSTER_ID,
          deployment: {
            revisionId: "revision-ins_health",
            imageDigest: `sha256:${(701).toString(16).padStart(64, "0")}`,
            platformManifestDigest: `sha256:${"c".repeat(64)}`,
            compositionManifestDigest: `sha256:${"d".repeat(64)}`,
          },
        },
        providerObservationId: "provider-observation-1",
        actualImageDigest: `sha256:${"c".repeat(64)}`,
        producerObservedAt: new Date(NOW - 1).toISOString(),
        compositionManifestDigest: `sha256:${"d".repeat(64)}`,
        enabledModuleIds: [],
        applicationProbeId: "application-1",
        validGrantProbeId: "valid-1",
        wrongRepositoryProbeId: "wrong-repo-1",
        wrongEpochProbeId: "wrong-epoch-1",
        invalidServiceCredentialProbeId: "invalid-1",
        uiApiMcpProbeId: "ui-1",
        persistenceProbeId: "persistence-1",
        persistence: { state: "verified", observedRemoteCommit: "f".repeat(40), formats: [] },
        verifiedAt: new Date(NOW).toISOString(),
      },
    };
    const request = (input: unknown) =>
      route.request("/internal/provisioner/runtime-health", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
    expect((await request(body)).status).toBe(200);
    expect((await request(body)).status).toBe(409);
    body.readinessEvidence.providerObservationId = "provider-observation-2";
    body.readinessEvidence.assignment.runtimeEpoch = 2;
    expect((await request(body)).status).toBe(409);
    body.readinessEvidence.assignment.runtimeEpoch = 1;
    body.readinessEvidence.assignment.deployment.imageDigest = `sha256:${"b".repeat(64)}`;
    expect((await request(body)).status).toBe(409);
    expect(
      h.database.prepare("SELECT COUNT(*) AS count FROM runtime_health_observations").get(),
    ).toMatchObject({ count: 1 });
  });
  it("lists only current ready runtimes in the worker cluster with bounded keyset pagination", async () => {
    const h = createHarness();
    await h.addReadyInstance("ins_a", 71);
    await h.addReadyInstance("ins_b", 72);
    await h.addReadyInstance("ins_c", 73, { suspended: true });
    await h.addReadyInstance("ins_elsewhere", 74, { clusterId: "cluster-b" });
    await h.addReadyInstance("ins_stale", 75, { staleObservation: true });
    h.database
      .prepare(
        `INSERT INTO operations (
           operation_id, instance_id, repository_id, generation, runtime_epoch, kind, status, phase,
           idempotency_scope, idempotency_key, request_hash, actor_id, authorization_revision,
           created_at, updated_at
         ) VALUES ('op_active_b', 'ins_b', 72, 1, 1, 'stop', 'pending', 'accepted',
                   'repository:72', 'active-b', 'hash', 'worker-a', 3, ?, ?)`,
      )
      .run(NOW, NOW);

    const first = await h.request("/internal/provisioner/idle-candidates", {
      workerId: WORKER_ID,
      clusterId: CLUSTER_ID,
      limit: 2,
      cursor: null,
    });
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      items: [
        {
          instanceId: "ins_a",
          repositoryId: 71,
          generation: 1,
          runtimeEpoch: 1,
          clusterId: CLUSTER_ID,
          desiredState: "running",
          bindingSuspended: false,
          hasActiveOperation: false,
          currentRuntime: {
            revisionId: "revision-ins_a",
            instanceId: "ins_a",
            repositoryId: 71,
            runtimeEpoch: 1,
          },
        },
        {
          instanceId: "ins_b",
          bindingSuspended: false,
          hasActiveOperation: true,
        },
      ],
      nextCursor: "ins_b",
    });

    const second = await h.request("/internal/provisioner/idle-candidates", {
      workerId: WORKER_ID,
      clusterId: CLUSTER_ID,
      limit: 2,
      cursor: "ins_b",
    });
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({
      items: [
        {
          instanceId: "ins_c",
          bindingSuspended: true,
          hasActiveOperation: false,
        },
      ],
      nextCursor: null,
    });
    expect(h.resolveCurrentRuntime).toHaveBeenCalledTimes(3);
  });

  it("looks up one current idle candidate by instance without scanning the inventory", async () => {
    const h = createHarness();
    await h.addReadyInstance("ins_point", 77);
    await h.addReadyInstance("ins_other_point", 78);

    const found = await h.request("/internal/provisioner/idle-candidate", {
      workerId: WORKER_ID,
      clusterId: CLUSTER_ID,
      instanceId: "ins_point",
    });
    expect(found.status).toBe(200);
    await expect(found.json()).resolves.toMatchObject({
      instanceId: "ins_point",
      repositoryId: 77,
      generation: 1,
      runtimeEpoch: 1,
      clusterId: CLUSTER_ID,
      desiredState: "running",
      bindingSuspended: false,
      hasActiveOperation: false,
      currentRuntime: { instanceId: "ins_point", repositoryId: 77 },
    });
    expect(h.resolveCurrentRuntime).toHaveBeenCalledTimes(1);

    const missing = await h.request("/internal/provisioner/idle-candidate", {
      workerId: WORKER_ID,
      clusterId: CLUSTER_ID,
      instanceId: "ins_missing",
    });
    expect(missing.status).toBe(200);
    await expect(missing.json()).resolves.toBeNull();
    expect(h.resolveCurrentRuntime).toHaveBeenCalledTimes(1);

    const wrongCluster = await h.request("/internal/provisioner/idle-candidate", {
      workerId: WORKER_ID,
      clusterId: "cluster-b",
      instanceId: "ins_point",
    });
    expect(wrongCluster.status).toBe(403);
  });

  it("advertises and revalidates a persisted canary health deadline by exact assignment", async () => {
    const h = createHarness();
    await h.addReadyInstance("ins_canary", 76);
    const schedule = vi.fn(async () => ({
      healthOperationId: "op-canary-health",
      nextCheckAt: NOW + 5 * 60_000,
      sampleDueAt: NOW - 1,
    }));
    const inventory = await h.request(
      "/internal/provisioner/idle-candidates",
      { workerId: WORKER_ID, clusterId: CLUSTER_ID, limit: 25, cursor: null },
      schedule,
    );
    expect(inventory.status).toBe(200);
    await expect(inventory.json()).resolves.toMatchObject({
      items: [
        {
          instanceId: "ins_canary",
          healthOperationId: "op-canary-health",
          activeCanaryHealth: true,
          healthNextCheckAt: NOW - 1,
        },
      ],
    });

    const due = await h.request(
      "/internal/provisioner/runtime-health-due",
      {
        workerId: WORKER_ID,
        clusterId: CLUSTER_ID,
        instanceId: "ins_canary",
        repositoryId: 76,
        expectedGeneration: 1,
        expectedRuntimeEpoch: 1,
      },
      schedule,
    );
    expect(due.status).toBe(200);
    await expect(due.json()).resolves.toEqual({
      active: true,
      nextCheckAt: NOW + 5 * 60_000,
      sampleDueAt: NOW - 1,
      healthOperationId: "op-canary-health",
    });

    const stale = await h.request(
      "/internal/provisioner/runtime-health-due",
      {
        workerId: WORKER_ID,
        clusterId: CLUSTER_ID,
        instanceId: "ins_canary",
        repositoryId: 76,
        expectedGeneration: 1,
        expectedRuntimeEpoch: 2,
      },
      schedule,
    );
    await expect(stale.json()).resolves.toEqual({
      active: false,
      nextCheckAt: null,
      sampleDueAt: null,
      healthOperationId: null,
    });
    expect(schedule).toHaveBeenCalledTimes(2);
  });

  it("requests an ordinary provisioner stop with atomic current-state and no-active-operation fences", async () => {
    const h = createHarness();
    await h.addReadyInstance("ins_stop", 81);

    const response = await h.request("/internal/provisioner/idle-stop", {
      workerId: WORKER_ID,
      clusterId: CLUSTER_ID,
      instanceId: "ins_stop",
      repositoryId: 81,
      expectedGeneration: 1,
      expectedRuntimeEpoch: 1,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ operationId: "op_idle_001" });
    expect(
      h.database
        .prepare(
          "SELECT desired_state, generation, runtime_epoch FROM logical_instances WHERE instance_id = ?",
        )
        .get("ins_stop"),
    ).toEqual({ desired_state: "stopped", generation: 2, runtime_epoch: 1 });
    expect(
      h.database
        .prepare(
          "SELECT kind, status, cluster_id, generation FROM operations WHERE operation_id = ?",
        )
        .get("op_idle_001"),
    ).toEqual({ kind: "stop", status: "pending", cluster_id: CLUSTER_ID, generation: 2 });
    expect(
      h.database
        .prepare("SELECT actor_kind, actor_id, action FROM audit_events WHERE operation_id = ?")
        .get("op_idle_001"),
    ).toEqual({ actor_kind: "provisioner", actor_id: WORKER_ID, action: "instance.stop" });
  });

  it("keeps the exact active release canary out of idle-stop while allowing ordinary and cleanup stops", async () => {
    const finalHealthSampleAt = NOW + 15 * 60_000;
    const h = createHarness(finalHealthSampleAt);
    await h.addReadyInstance("ins_canary_guard", 82);
    await h.addReadyInstance("ins_impostor_guard", 84);
    await h.addReadyInstance("ins_normal_guard", 83);
    h.database
      .prepare(
        `INSERT INTO release_candidates (
           release_id, image_digest, version, image_repository, status, candidate_json, created_at
         ) VALUES ('rel_canary_guard', ?, '1.0.0', 'ghcr.io/praetorium/test', 'candidate', '{}', ?)`,
      )
      .run(`sha256:${"e".repeat(64)}`, new Date(NOW).toISOString());
    h.database
      .prepare(
        `INSERT INTO idempotency_records (
           scope, idempotency_key, request_hash, response_kind, response_id, created_at
         ) VALUES ('repository:82', 'stable-canary-plan:rel_canary_guard', 'plan-hash',
                   'configuration-plan', 'revision-ins_canary_guard', ?)`,
      )
      .run(NOW);
    h.database
      .prepare(
        `INSERT INTO idempotency_records (
           scope, idempotency_key, request_hash, response_kind, response_id, created_at
         ) VALUES ('repository:84', 'stable-canary-plan:rel_canary_guard', 'user-plan-hash',
                   'configuration-plan', 'revision-ins_impostor_guard', ?)`,
      )
      .run(NOW);
    const canarySelection = JSON.stringify({
      releaseId: "rel_canary_guard",
      requestedModules: [],
      resourceProfileId: "small",
      policy: "pinned",
    });
    h.database
      .prepare(
        "UPDATE deployment_revisions SET selection_json = ?, actor_id = ? WHERE revision_id = ?",
      )
      .run(canarySelection, "system:stable-release-canary", "revision-ins_canary_guard");
    h.database
      .prepare(
        "UPDATE deployment_revisions SET selection_json = ?, actor_id = ? WHERE revision_id = ?",
      )
      .run(canarySelection, "user-84", "revision-ins_impostor_guard");
    h.database
      .prepare(
        `INSERT INTO release_candidate_workflows (
           release_id, state, revision, attempts, next_attempt_at, lease_owner, lease_epoch,
           lease_expires_at, canary_artifact_digest, canary_build_key, canary_runtime_id,
           canary_operation_id, healthy_since, last_healthy_at, last_health_evidence_json,
           cleanup_evidence_json, follower_cursor, follower_planning_complete,
           canary_cleanup_complete, cleanup_disposition, failure_code, updated_at
         ) VALUES ('rel_canary_guard', 'canary_starting', 0, 0, NULL, NULL, 0, NULL,
                   NULL, 'build-key-ins_canary_guard', NULL, NULL, NULL, NULL, NULL, NULL,
                   NULL, 0, 0, NULL, NULL, ?)`,
      )
      .run(NOW);

    const idleStop = (instanceId: string, repositoryId: number) =>
      h.request("/internal/provisioner/idle-stop", {
        workerId: WORKER_ID,
        clusterId: CLUSTER_ID,
        instanceId,
        repositoryId,
        expectedGeneration: 1,
        expectedRuntimeEpoch: 1,
      });

    const starting = await idleStop("ins_canary_guard", 82);
    expect(starting.status).toBe(409);
    expect(
      h.database
        .prepare("SELECT desired_state, generation FROM logical_instances WHERE instance_id = ?")
        .get("ins_canary_guard"),
    ).toEqual({ desired_state: "running", generation: 1 });

    const unrelatedSameKey = await idleStop("ins_impostor_guard", 84);
    expect(unrelatedSameKey.status).toBe(200);

    h.database
      .prepare(
        `UPDATE release_candidate_workflows
            SET state = 'canary_observing', canary_runtime_id = 'ins_canary_guard',
                healthy_since = ?, last_healthy_at = ?, next_attempt_at = ?,
                last_health_evidence_json = '{}'
          WHERE release_id = 'rel_canary_guard'`,
      )
      .run(NOW + 5 * 60_000, NOW + 10 * 60_000, finalHealthSampleAt);
    // The final canary sample is due now; its asynchronous promotion callback has not yet changed D1.
    const observing = await idleStop("ins_canary_guard", 82);
    expect(observing.status).toBe(409);

    h.database
      .prepare(
        "UPDATE release_candidate_workflows SET state = 'canary_cleanup' WHERE release_id = ?",
      )
      .run("rel_canary_guard");
    const cleanup = await idleStop("ins_canary_guard", 82);
    expect(cleanup.status).toBe(409);

    const ordinary = await idleStop("ins_normal_guard", 83);
    expect(ordinary.status).toBe(200);

    const canarySnapshot = await h.store.getByRepositoryId(82);
    expect(canarySnapshot).not.toBeNull();
    const cleanupStop = await new InstanceService(
      h.store,
      () => "op_release_canary_cleanup",
    ).requestDesiredState({
      repositoryId: 82,
      bindingEpoch: canarySnapshot!.binding.bindingEpoch,
      authorizationRevision: canarySnapshot!.binding.authorizationRevision,
      desiredState: "stopped",
      actorId: "system:stable-release-canary",
      idempotencyKey: "stable-canary-stop:rel_canary_guard",
      requestId: "t11-canary-stop:op-canary-start",
      now: finalHealthSampleAt,
    });
    expect(cleanupStop.operation).toMatchObject({
      id: "op_release_canary_cleanup",
      kind: "stop",
      status: "pending",
    });
  });

  it("rejects stale, suspended, cross-cluster, or active-operation stop requests without mutation", async () => {
    const cases = [
      {
        instanceId: "ins_stale_stop",
        repositoryId: 91,
        expectedGeneration: 1,
        expectedRuntimeEpoch: 1,
      },
      {
        instanceId: "ins_suspended_stop",
        repositoryId: 92,
        expectedGeneration: 1,
        expectedRuntimeEpoch: 1,
      },
      {
        instanceId: "ins_other_cluster_stop",
        repositoryId: 93,
        expectedGeneration: 1,
        expectedRuntimeEpoch: 1,
      },
      {
        instanceId: "ins_active_stop",
        repositoryId: 94,
        expectedGeneration: 1,
        expectedRuntimeEpoch: 1,
      },
      {
        instanceId: "ins_valid_stop",
        repositoryId: 95,
        expectedGeneration: 0,
        expectedRuntimeEpoch: 1,
      },
    ] as const;
    const h = createHarness();
    await h.addReadyInstance("ins_stale_stop", 91, { staleObservation: true });
    await h.addReadyInstance("ins_suspended_stop", 92, { suspended: true });
    await h.addReadyInstance("ins_other_cluster_stop", 93, { clusterId: "cluster-b" });
    await h.addReadyInstance("ins_active_stop", 94);
    await h.addReadyInstance("ins_valid_stop", 95);
    h.database
      .prepare(
        `INSERT INTO operations (
           operation_id, instance_id, repository_id, generation, runtime_epoch, kind, status, phase,
           idempotency_scope, idempotency_key, request_hash, actor_id, authorization_revision,
           created_at, updated_at
         ) VALUES ('op_active_stop', 'ins_active_stop', 94, 1, 1, 'start', 'running', 'accepted',
                   'repository:94', 'active-stop', 'hash', 'worker-a', 3, ?, ?)`,
      )
      .run(NOW, NOW);

    for (const item of cases) {
      const response = await h.request("/internal/provisioner/idle-stop", {
        workerId: WORKER_ID,
        clusterId: CLUSTER_ID,
        ...item,
      });
      expect(response.status).toBe(409);
    }
    expect(
      h.database
        .prepare("SELECT COUNT(*) AS count FROM operations WHERE operation_id LIKE 'op_idle_%'")
        .get(),
    ).toEqual({ count: 0 });
    expect(
      h.database
        .prepare(
          "SELECT desired_state, generation FROM logical_instances WHERE instance_id = 'ins_valid_stop'",
        )
        .get(),
    ).toEqual({ desired_state: "running", generation: 1 });
  });

  it("generates the observation operation ID on the server and never accepts caller action fields", async () => {
    const h = createHarness();
    await h.addReadyInstance("ins_observe", 101);
    const signing = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const operations = new OperationService(h.store, () => "lease-token-aaaaaaaaaaaaaaaaaaaaaaaa");
    const issuer = createControlCredentialIssuer({
      operations,
      instances: { getByInstanceId: (id) => h.store.getByInstanceId(id) },
      hasActiveOperation: async (instanceId) => h.hasActiveOperation(instanceId),
      issuerOrigin: "https://control.example.test",
      signingKey: {
        kid: "operator-test",
        privateKeyJwk: await crypto.subtle.exportKey("jwk", signing.privateKey),
      },
      now: () => NOW,
    });
    const route = h.makeRoutes(issuer);
    const response = await route.request("/internal/provisioner/observation-credential", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workerId: WORKER_ID,
        clusterId: CLUSTER_ID,
        instanceId: "ins_observe",
        repositoryId: 101,
        expectedGeneration: 1,
        runtimeEpoch: 1,
      }),
    });

    expect(response.status).toBe(200);
    const issued = (await response.json()) as {
      token: string;
      expiresAt: string;
      operationId: string;
    };
    expect(issued.operationId).toBe("op_idle_001");
    const payload = issued.token.split(".")[1]!;
    const claims = JSON.parse(new TextDecoder().decode(decodeBase64Url(payload))) as Record<
      string,
      unknown
    >;
    expect(claims).toMatchObject({ operationId: "op_idle_001", action: "status", runtimeEpoch: 1 });
    expect(issued.expiresAt).toBe(new Date((Math.floor(NOW / 1000) + 30) * 1000).toISOString());
    expect(
      await h.request("/internal/provisioner/observation-credential", {
        workerId: WORKER_ID,
        clusterId: CLUSTER_ID,
        instanceId: "ins_observe",
        repositoryId: 101,
        expectedGeneration: 1,
        runtimeEpoch: 1,
        action: "resume",
      }),
    ).toHaveProperty("status", 400);
  });

  it("rejects a worker or cluster identity mismatch", async () => {
    const h = createHarness();
    const response = await h.request("/internal/provisioner/idle-candidates", {
      workerId: "worker-other",
      clusterId: CLUSTER_ID,
      limit: 25,
      cursor: null,
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "WORKER_SCOPE_MISMATCH" },
    });
  });
});

function createHarness(routeNow = NOW) {
  const database = new DatabaseSync(":memory:");
  activeDatabases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(readFileSync(fileURLToPath(schemaUrl), "utf8"));
  database.exec(
    readFileSync(
      new URL("../migrations/0002_stable_release_rollouts.sql", import.meta.url),
      "utf8",
    ),
  );
  const db = new SqliteD1Database(database);
  const store = new D1PlatformStore(db);
  let nextInstanceId = "unused-instance";
  const registry = new RepositoryRegistryService(store, () => nextInstanceId);
  let operationNumber = 0;
  const resolveCurrentRuntime = vi.fn(async (snapshot, revision) => ({
    revisionId: revision.revisionId,
    instanceId: snapshot.instance.instanceId,
    repositoryId: snapshot.binding.repositoryId,
    runtimeEpoch: snapshot.instance.observedRuntimeEpoch,
  }));

  const makeRoutes = (
    credentialIssuer: Pick<ControlCredentialIssuer, "issueObservation"> = {
      async issueObservation() {
        return { token: "unused", expiresAt: new Date(NOW + 30_000).toISOString() };
      },
    },
    canaryHealthSchedule?: ProvisionerIdleRoutesDependencies["canaryHealthSchedule"],
  ) => {
    const idle = createProvisionerIdleRoutes({
      db,
      store,
      credentialIssuer,
      workerId: WORKER_ID,
      clusterId: CLUSTER_ID,
      now: () => routeNow,
      newOperationId: () => `op_idle_${String(++operationNumber).padStart(3, "0")}`,
      ...(canaryHealthSchedule ? { canaryHealthSchedule } : {}),
      resolveCurrentRuntime,
    });
    const app = new Hono();
    app.route("/internal/provisioner", idle);
    app.onError((error, c) => {
      if (error instanceof ZodError || error instanceof SyntaxError || error instanceof TypeError)
        return c.json({ error: { code: "INVALID_REQUEST" } }, 400);
      return c.json({ error: { code: "UPSTREAM_UNAVAILABLE" } }, 503);
    });
    return app;
  };

  return {
    database,
    store,
    resolveCurrentRuntime,
    makeRoutes,
    async request(
      path: string,
      body: unknown,
      canaryHealthSchedule?: ProvisionerIdleRoutesDependencies["canaryHealthSchedule"],
    ) {
      const app = makeRoutes(undefined, canaryHealthSchedule);
      return app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    },
    async addReadyInstance(
      instanceId: string,
      repositoryId: number,
      options: {
        readonly clusterId?: string;
        readonly suspended?: boolean;
        readonly staleObservation?: boolean;
      } = {},
    ) {
      nextInstanceId = instanceId;
      const resolved = await registry.resolveOrCreate({
        repository: {
          repositoryId,
          installationId: 900 + repositoryId,
          owner: "praetorium",
          name: `repo-${repositoryId}`,
          authorizationRevision: 3,
        },
        actor: { id: "user-1", kind: "user" },
        requestId: `request-${repositoryId}`,
        idempotencyKey: `resolve-${repositoryId}`,
        now: NOW,
      });
      const artifactDigest = seedDeployment(database, instanceId, repositoryId);
      const observedGeneration = options.staleObservation ? 0 : 1;
      const currentCluster = options.clusterId ?? CLUSTER_ID;
      database
        .prepare(
          `UPDATE logical_instances
           SET generation = 1, runtime_epoch = 1, desired_state = 'running',
               observed_generation = ?, observed_runtime_epoch = 1, observed_sequence = 1,
               observed_state = 'ready', observed_revision_id = ?, desired_revision_id = ?,
               desired_artifact_digest = ?, current_artifact_digest = ?,
               reservation_state = 'allocated', reservation_id = ?
           WHERE instance_id = ?`,
        )
        .run(
          observedGeneration,
          `revision-${instanceId}`,
          `revision-${instanceId}`,
          artifactDigest,
          artifactDigest,
          `reservation-${instanceId}`,
          instanceId,
        );
      database
        .prepare(
          `INSERT INTO runtime_reservations (
             reservation_id, instance_id, repository_id, runtime_epoch, generation, cluster_id,
             status, capacity_snapshot_epoch, cpu_milli, memory_mib, ephemeral_storage_mib,
             created_at, updated_at
           ) VALUES (?, ?, ?, 1, 1, ?, 'allocated', 1, 400, 256, 128, ?, ?)`,
        )
        .run(`reservation-${instanceId}`, instanceId, repositoryId, currentCluster, NOW, NOW);
      if (options.suspended) {
        const binding = await store.suspendBinding({
          repositoryId,
          expectedBindingEpoch: resolved.binding.bindingEpoch,
          eventId: `suspend-${repositoryId}`,
          eventKind: "test.suspend",
          reason: "test suspension",
          requestId: null,
          now: NOW,
        });
        expect(binding?.suspended).toBe(true);
      }
    },
    async hasActiveOperation(instanceId: string) {
      const row = database
        .prepare(
          "SELECT 1 AS active FROM operations WHERE instance_id = ? AND status IN ('pending', 'claimed', 'running') LIMIT 1",
        )
        .get(instanceId) as { active?: number } | undefined;
      return row?.active === 1;
    },
  };
}

function seedDeployment(database: DatabaseSync, instanceId: string, repositoryId: number): string {
  const artifactDigest = `sha256:${repositoryId.toString(16).padStart(64, "0")}`;
  const manifestDigest = `sha256:${"b".repeat(64)}`;
  const platformDigest = `sha256:${"c".repeat(64)}`;
  const compositionDigest = `sha256:${"d".repeat(64)}`;
  const producerRevision = "a".repeat(40);
  const buildId = `build-${instanceId}`;
  const buildKey = `build-key-${instanceId}`;
  const attemptId = `build-attempt-${instanceId}`;
  database
    .prepare(
      `INSERT INTO builds (build_id, build_key, build_input_json, status, artifact_digest, created_at, updated_at)
       VALUES (?, ?, '{"input":1}', 'succeeded', ?, ?, ?)`,
    )
    .run(buildId, buildKey, artifactDigest, NOW, NOW);
  database
    .prepare(
      `INSERT INTO build_attempts (
         attempt_id, build_id, lease_epoch, worker_id, status, lease_token, lease_expires_at,
         report_sequence, started_at, updated_at, finished_at
       ) VALUES (?, ?, 1, 'build-worker', 'succeeded', 'build-lease-token', ?, 2, ?, ?, ?)`,
    )
    .run(attemptId, buildId, NOW + 60_000, NOW, NOW, NOW);
  database
    .prepare(
      `INSERT INTO artifacts (
         artifact_digest, build_key, build_id, attempt_id, manifest_digest, platform_manifest_digest,
         composition_manifest_digest, producer_revision, requested_modules_json, resolved_modules_json,
         contract_versions_json, sbom_ref, provenance_ref, verification_json, statement_json,
         signature_json, verifier_id, status, created_at, admitted_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', '{"build":"scriptorium-build/v1","platform":"scriptorium-platform/v1"}',
         NULL, NULL, '{"checks":{"closure":true}}', '{"subject":"test"}',
         '{"keyId":"test-key","signature":"test-signature"}', 'test-verifier', 'admitted', ?, ?)`,
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
      NOW,
      NOW,
    );
  database
    .prepare(
      `INSERT INTO deployment_revisions (
         revision_id, instance_id, repository_id, generation, build_key, build_id, selection_json,
         resource_requirements_json, runtime_metadata_json, artifact_digest, status, actor_id, created_at
       ) VALUES (?, ?, ?, 1, ?, ?, '{"resourceProfileId":"small"}',
         '{"cpuMilli":400,"memoryMiB":256,"ephemeralStorageMiB":128}', ?, ?, 'admitted', 'user-1', ?)`,
    )
    .run(
      `revision-${instanceId}`,
      instanceId,
      repositoryId,
      buildKey,
      buildId,
      JSON.stringify({
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
      }),
      artifactDigest,
      NOW,
    );
  database
    .prepare(
      "UPDATE logical_instances SET desired_revision_id = ?, desired_artifact_digest = ? WHERE instance_id = ?",
    )
    .run(`revision-${instanceId}`, artifactDigest, instanceId);
  return artifactDigest;
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

class SqliteD1Database implements D1Database {
  private pending = Promise.resolve();

  constructor(private readonly database: DatabaseSync) {}

  prepare(query: string): D1PreparedStatement {
    return new SqliteD1Statement(this.database, query, []);
  }

  async batch<T = unknown>(
    statements: readonly D1PreparedStatement[],
  ): Promise<readonly D1Result<T>[]> {
    const previous = this.pending;
    let release!: () => void;
    this.pending = new Promise<void>((resolve) => {
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
