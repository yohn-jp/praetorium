import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { ReleaseCandidateSchema, type ReleaseCandidate } from "@praetorium/application/releases";
import type { StableFollower } from "@praetorium/application/rollouts";
import {
  stableRolloutOperationIdempotencyKey,
  stableRolloutStageIdempotencyKey,
} from "@praetorium/application/rollouts";
import { D1StableFollowerRepository } from "./stable-followers.js";
import {
  D1T11ReleaseRolloutStore,
  type D1BindValue,
  type D1PreparedStatement,
  type D1Result,
  type StagedRolloutActivator,
  type T11D1Database,
} from "./t11-release-rollouts.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const BUILD_KEY = `sha256:${"b".repeat(64)}`;
const PRODUCER = "a".repeat(40);
const TIME = "2026-01-01T00:00:00.000Z";
const NOW = Date.parse(TIME);

class SQLiteD1Statement implements D1PreparedStatement {
  private values: readonly D1BindValue[] = [];

  constructor(
    private readonly sql: string,
    private readonly statement: StatementSync,
  ) {}

  private sqlValues() {
    return this.values.map((value): SQLInputValue => {
      if (typeof value === "boolean") return Number(value);
      if (value instanceof ArrayBuffer) return new Uint8Array(value);
      return value;
    });
  }

  bind(...values: D1BindValue[]): D1PreparedStatement {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.sqlValues()) as T | undefined) ?? null;
  }

  async all<T>(): Promise<D1Result<T>> {
    return {
      results: this.statement.all(...this.sqlValues()) as T[],
      meta: { changes: 0 },
    };
  }

  async run<T>(): Promise<D1Result<T>> {
    const result = this.statement.run(...this.sqlValues());
    return { results: [], meta: { changes: Number(result.changes) } };
  }

  async executeBatch(): Promise<D1Result<unknown>> {
    if (/^\s*SELECT\b/iu.test(this.sql)) {
      return {
        results: this.statement.all(...this.sqlValues()) as unknown[],
        meta: { changes: 0 },
      };
    }
    const result = this.statement.run(...this.sqlValues());
    return { results: [], meta: { changes: Number(result.changes) } };
  }
}

class SQLiteD1 implements T11D1Database {
  readonly database = new DatabaseSync(":memory:");

  prepare(sql: string): SQLiteD1Statement {
    return new SQLiteD1Statement(sql, this.database.prepare(sql));
  }

  async batch<T>(statements: readonly D1PreparedStatement[]): Promise<readonly D1Result<T>[]> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results: D1Result<unknown>[] = [];
      for (const statement of statements) {
        results.push(await (statement as SQLiteD1Statement).executeBatch());
      }
      this.database.exec("COMMIT");
      return results as D1Result<T>[];
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function candidate(id = "release-1", version = "1.0.0", digest = DIGEST): ReleaseCandidate {
  return ReleaseCandidateSchema.parse({
    schemaVersion: 1,
    id,
    version,
    imageRepository: "example/runtime",
    imageDigest: digest,
    catalog: {
      contractVersion: "scriptorium-build/v1",
      producerRevision: PRODUCER,
      runtimeBaseDigest: digest,
      buildKitDigest: DIGEST,
      recipeDigest: DIGEST,
      lockDigest: DIGEST,
      sourceDigest: DIGEST,
      supportedPlatforms: ["linux/amd64"],
      modules: [],
      baseResources: { cpuMilli: 0, memoryMiB: 0, ephemeralStorageMiB: 0 },
      sharedResourceGroups: [],
      resourceProfiles: [],
    },
    runtimeMetadata: {
      contractVersion: "scriptorium-platform/v1",
      producerRevision: PRODUCER,
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
    },
    signatureRef: "https://evidence.example/signature",
    provenanceRef: "https://evidence.example/provenance",
    admission: {
      registryConfirmed: true,
      provenanceVerified: true,
      runtimeMetadataVerified: true,
      evidence: ["verified test evidence"],
      verifiedAt: TIME,
    },
    status: "candidate",
    createdAt: TIME,
  });
}

const stagedActivator: StagedRolloutActivator = {
  async findStageByIdempotency() {
    return null;
  },
  async activateStageUnderClusterFence() {
    return null;
  },
};

function store(db: SQLiteD1, activator = stagedActivator) {
  return new D1T11ReleaseRolloutStore(db, activator, () => "op-test");
}

function installSchema(db: SQLiteD1) {
  db.database.exec("PRAGMA foreign_keys = ON");
  for (const migration of [
    "../../../migrations/0001_repository_platform.sql",
    "../../../migrations/0002_stable_release_rollouts.sql",
  ]) {
    db.database.exec(readFileSync(new URL(migration, import.meta.url), "utf8"));
  }
}

function follower(instanceId: string, clusterId = "cluster-1"): StableFollower {
  return {
    instanceId,
    repositoryId: 101,
    bindingEpoch: 1,
    authorizationRevision: 1,
    clusterId,
    generation: 2,
    runtimeEpoch: 1,
    desiredState: "running",
    policy: "stable",
    desiredReleaseId: null,
    desiredArtifactDigest: null,
    currentArtifactDigest: null,
    configurationRevision: "revision-1",
    selectedModuleIds: ["forms"],
    resourceProfileId: "standard",
    platform: "linux/amd64",
  };
}

describe("D1T11ReleaseRolloutStore against SQLite execution", () => {
  it("persists admitted candidates, audit, cursor, workflow leases and channel CAS across store reconstruction", async () => {
    const db = new SQLiteD1();
    installSchema(db);
    const release = candidate();
    const first = store(db);
    expect(
      await first.createCandidateWithAudit({
        candidate: release,
        audit: {
          actorId: "operator-1",
          requestId: "request-1",
          action: "release.candidate.admit",
          targetId: release.id,
          outcome: "accepted",
          metadata: { digest: release.imageDigest },
          occurredAt: TIME,
        },
      }),
    ).toBe("created");
    expect(await first.createCandidate(release)).toBe("duplicate");
    expect(db.database.prepare("SELECT count(*) AS count FROM audit_events").get()).toMatchObject({
      count: 1,
    });
    expect(
      await first.commitDiscoveryPage({
        expectedRevision: 0,
        expectedCursor: null,
        page: { items: [release], nextCursor: null },
        at: TIME,
      }),
    ).toBe("advanced");

    const afterRestart = store(db);
    const lease = (
      await afterRestart.claimCandidateWork({
        owner: "worker-a",
        now: NOW,
        leaseMs: 60_000,
        limit: 1,
      })
    )[0];
    expect(lease?.workflow.state).toBe("queued");
    expect(
      await afterRestart.saveCandidateWorkflow({
        lease: lease!,
        next: { ...lease!.workflow, state: "canary_building", attempts: 1, updatedAt: TIME },
        releaseLease: true,
      }),
    ).toBe("saved");
    const reclaimed = (
      await store(db).claimCandidateWork({
        owner: "worker-b",
        now: NOW + 1,
        leaseMs: 60_000,
        limit: 1,
      })
    )[0];
    expect(reclaimed?.workflow.state).toBe("canary_building");
    expect(reclaimed?.workflow.revision).toBe(1);
    expect(
      await afterRestart.promoteStable({
        releaseId: release.id,
        expectedRevision: 0,
        promotedAt: TIME,
      }),
    ).toBe("promoted");
    expect(db.database.prepare("SELECT count(*) AS count FROM audit_events").get()).toMatchObject({
      count: 2,
    });
    expect(
      db.database
        .prepare(
          "SELECT actor_kind, action, outcome FROM audit_events WHERE action = 'release.stable.promoted'",
        )
        .get(),
    ).toMatchObject({
      actor_kind: "system",
      action: "release.stable.promoted",
      outcome: "accepted",
    });
    expect(
      await store(db).promoteStable({
        releaseId: release.id,
        expectedRevision: 0,
        promotedAt: TIME,
      }),
    ).toBe("ineligible");
    const next = candidate("release-2", "2.0.0", `sha256:${"b".repeat(64)}`);
    await store(db).createCandidate(next);
    expect(
      await store(db).promoteStable({
        releaseId: next.id,
        expectedRevision: 0,
        promotedAt: TIME,
      }),
    ).toBe("conflict");
    expect((await store(db).getStableChannel()).currentReleaseId).toBe(release.id);
    expect((await store(db).findById(release.id))?.status).toBe("available");
  });

  it("bounds workflow claims and recovers a lease after a worker crash", async () => {
    const db = new SQLiteD1();
    installSchema(db);
    const releases = [
      candidate("release-a"),
      candidate("release-b", "2.0.0", `sha256:${"b".repeat(64)}`),
    ];
    const first = store(db);
    for (const release of releases) await first.createCandidate(release);
    await first.commitDiscoveryPage({
      expectedRevision: 0,
      expectedCursor: null,
      page: { items: releases, nextCursor: null },
      at: TIME,
    });

    const originalLease = await first.claimCandidateWork({
      owner: "worker-before-crash",
      now: NOW,
      leaseMs: 60_000,
      limit: 1,
    });
    expect(originalLease).toHaveLength(1);
    expect(originalLease[0]?.candidate.id).toBe("release-a");

    const recoveredLease = await store(db).claimCandidateWork({
      owner: "worker-after-crash",
      now: NOW + 60_000,
      leaseMs: 60_000,
      limit: 1,
    });
    expect(recoveredLease).toHaveLength(1);
    expect(recoveredLease[0]?.candidate.id).toBe("release-a");
    expect(recoveredLease[0]?.epoch).toBe(originalLease[0]!.epoch + 1);
  });

  it("creates durable rollout fanout and permits only one unexpired cluster writer", async () => {
    const db = new SQLiteD1();
    installSchema(db);
    const release = candidate();
    const first = store(db);
    await first.createCandidate(release);
    await first.promoteStable({ releaseId: release.id, expectedRevision: 0, promotedAt: TIME });
    db.database
      .prepare(
        "INSERT INTO logical_instances(instance_id, repository_id, desired_state, created_at, updated_at) VALUES (?, ?, 'running', ?, ?)",
      )
      .run("instance-1", 101, NOW, NOW);
    expect(
      await first.recordFollowerPage({
        releaseId: release.id,
        expectedCursor: null,
        page: { items: [follower("instance-1")], nextCursor: null },
        at: TIME,
      }),
    ).toBe("recorded");
    const afterRestart = store(db);
    const due = await afterRestart.listDueRollouts(NOW, 10);
    expect(due).toHaveLength(1);
    expect(due[0]?.snapshot.instanceId).toBe("instance-1");

    const lease = await afterRestart.claimClusterLease({
      clusterId: "cluster-1",
      rolloutId: due[0]!.id,
      owner: "rollout-worker-a",
      now: NOW,
      leaseMs: 60_000,
    });
    expect(lease).not.toBeNull();
    const concurrent = await store(db).claimClusterLease({
      clusterId: "cluster-1",
      rolloutId: due[0]!.id,
      owner: "rollout-worker-b",
      now: NOW + 1,
      leaseMs: 60_000,
    });
    expect(concurrent).toBeNull();
    expect(await afterRestart.findClusterLease("cluster-1")).toMatchObject({
      owner: "rollout-worker-a",
      activeOperationId: null,
    });
  });

  it("activates the persisted build stage through the current cluster lease", async () => {
    const db = new SQLiteD1();
    installSchema(db);
    const release = candidate();
    const activationCalls: unknown[] = [];
    const activator: StagedRolloutActivator = {
      async findStageByIdempotency(repositoryId, idempotencyKey) {
        expect(repositoryId).toBe(101);
        expect(idempotencyKey).toBe(
          await stableRolloutStageIdempotencyKey("release-1", "instance-1", "revision-1"),
        );
        return {
          stageId: "stage-1",
          buildKey: BUILD_KEY,
          buildId: "build-1",
          artifactDigest: DIGEST,
          status: "staged",
        };
      },
      async activateStageUnderClusterFence(input) {
        activationCalls.push(input);
        return { operationId: "op-activated", generation: 8 };
      },
    };
    const rollouts = store(db, activator);
    await rollouts.createCandidate(release);
    await rollouts.promoteStable({ releaseId: release.id, expectedRevision: 0, promotedAt: TIME });
    db.database
      .prepare(
        "INSERT INTO logical_instances(instance_id, repository_id, desired_state, created_at, updated_at) VALUES (?, ?, 'running', ?, ?)",
      )
      .run("instance-1", 101, NOW, NOW);
    await rollouts.recordFollowerPage({
      releaseId: release.id,
      expectedCursor: null,
      page: { items: [follower("instance-1")], nextCursor: null },
      at: TIME,
    });
    const [initial] = await rollouts.listDueRollouts(NOW, 1);
    expect(initial).toBeDefined();
    await rollouts.saveRollout({
      rollout: {
        ...initial!,
        state: "dispatch_pending",
        buildKey: BUILD_KEY,
        buildId: "build-1",
        artifactDigest: DIGEST,
        updatedAt: TIME,
      },
      expectedRevision: initial!.revision,
      at: TIME,
    });
    const rollout = (await rollouts.findRollout(initial!.id))!;
    const lease = await rollouts.claimClusterLease({
      clusterId: rollout.clusterId,
      rolloutId: rollout.id,
      owner: "rollout-worker",
      now: NOW,
      leaseMs: 60_000,
    });
    expect(lease).not.toBeNull();

    await expect(
      rollouts.dispatchUnderClusterLease({
        lease: lease!,
        rollout,
        current: follower("instance-1"),
        actorId: "system:stable-release",
        idempotencyKey: await stableRolloutOperationIdempotencyKey(
          "release-1",
          "instance-1",
          2,
          BUILD_KEY,
        ),
        at: TIME,
      }),
    ).resolves.toEqual({ kind: "dispatched", operationId: "op-activated", generation: 8 });
    expect(activationCalls).toEqual([
      {
        stageId: "stage-1",
        clusterId: "cluster-1",
        rolloutId: rollout.id,
        releaseId: release.id,
        owner: "rollout-worker",
        leaseEpoch: lease!.epoch,
        expectedRolloutRevision: rollout.revision,
        expectedBuildKey: BUILD_KEY,
        expectedBuildId: "build-1",
        expectedArtifactDigest: DIGEST,
        actorId: "system:stable-release",
        actorKind: "system",
        requestId: await stableRolloutStageIdempotencyKey("release-1", "instance-1", "revision-1"),
        operationId: "op-test",
        operationIdempotencyKey: await stableRolloutOperationIdempotencyKey(
          "release-1",
          "instance-1",
          2,
          BUILD_KEY,
        ),
        now: NOW,
      },
    ]);
  });

  it("reads the current stable configuration and assigned cluster from actual D1 rows", async () => {
    const db = new SQLiteD1();
    installSchema(db);
    const selected = {
      releaseId: "release-old",
      requestedModules: ["forms"],
      resourceProfileId: "balanced",
      policy: "stable",
    };
    const buildInput = {
      contractVersion: "scriptorium-build/v1",
      producerRevision: PRODUCER,
      runtimeBaseDigest: DIGEST,
      buildKitDigest: DIGEST,
      recipeDigest: DIGEST,
      sourceDigest: DIGEST,
      lockDigest: DIGEST,
      requestedModules: ["forms"],
      resolvedModules: [{ id: "forms", version: "1.0.0", artifactDigest: DIGEST }],
      platform: "linux/amd64",
      options: {},
    };
    db.database.exec(`
      INSERT INTO logical_instances (
        instance_id, repository_id, desired_state, policy, generation, runtime_epoch,
        desired_revision_id, desired_artifact_digest, current_artifact_digest,
        reservation_state, reservation_id, created_at, updated_at
      ) VALUES ('instance-1', 101, 'running', 'stable', 7, 4,
        'revision-7', '${DIGEST}', '${DIGEST}', 'allocated', 'reservation-4', ${NOW}, ${NOW});
      INSERT INTO repository_bindings (
        repository_id, instance_id, installation_id, owner, name,
        authorization_revision, binding_epoch, suspended, created_at, updated_at
      ) VALUES (101, 'instance-1', 201, 'owner', 'repo', 3, 2, 0, ${NOW}, ${NOW});
      INSERT INTO builds (build_id, build_key, build_input_json, status, created_at, updated_at)
      VALUES ('build-7', 'key-7', '${JSON.stringify(buildInput)}', 'succeeded', ${NOW}, ${NOW});
      INSERT INTO deployment_revisions (
        revision_id, instance_id, repository_id, generation, build_key, build_id,
        selection_json, resource_requirements_json, runtime_metadata_json,
        artifact_digest, status, actor_id, created_at
      ) VALUES ('revision-7', 'instance-1', 101, 7, 'key-7', 'build-7',
        '${JSON.stringify(selected)}', '{"cpuMilli":100,"memoryMiB":128,"ephemeralStorageMiB":256}',
        '{"contractVersion":"scriptorium-platform/v1","producerRevision":"${PRODUCER}","listener":{"port":3000},"paths":{"liveness":"/health/live","readiness":"/health/ready","metadata":"/api/platform/v1/metadata","shutdown":"/api/platform/v1/shutdown","status":"/api/platform/v1/status","quiesce":"/api/platform/v1/quiesce","resume":"/api/platform/v1/resume"},"shutdownTimeoutSeconds":30}',
        NULL, 'admitted', 'actor', ${NOW});
      INSERT INTO runtime_reservations (
        reservation_id, instance_id, repository_id, runtime_epoch, generation,
        cluster_id, status, capacity_snapshot_epoch, cpu_milli, memory_mib,
        ephemeral_storage_mib, created_at, updated_at
      ) VALUES ('reservation-4', 'instance-1', 101, 4, 7, 'cluster-actual',
        'allocated', 1, 100, 128, 256, ${NOW}, ${NOW});
    `);

    const followers = new D1StableFollowerRepository(db, "cluster-default");
    const page = await followers.listInstances(null, 1);
    expect(page).toMatchObject({
      nextCursor: null,
      items: [
        {
          instanceId: "instance-1",
          repositoryId: 101,
          bindingEpoch: 2,
          authorizationRevision: 3,
          clusterId: "cluster-actual",
          generation: 7,
          runtimeEpoch: 4,
          desiredState: "running",
          policy: "stable",
          desiredReleaseId: "release-old",
          configurationRevision: "revision-7",
          selectedModuleIds: ["forms"],
          resourceProfileId: "balanced",
          platform: "linux/amd64",
        },
      ],
    });
    expect(await followers.findCurrent("instance-1")).toEqual(page.items[0]);
  });
});
