import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { ReleaseCandidateSchema, type ReleaseCandidate } from "@praetorium/application/releases";
import type { StableFollower } from "@praetorium/application/rollouts";
import {
  D1T11ReleaseRolloutStore,
  type D1BindValue,
  type D1PreparedStatement,
  type D1Result,
  type FencedDesiredUpdateWriter,
  type T11D1Database,
} from "./t11-release-rollouts.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
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
      if (ArrayBuffer.isView(value) && !(value instanceof Uint8Array)) {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      }
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

  async run(): Promise<D1Result<never>> {
    const result = this.statement.run(...this.sqlValues());
    return { meta: { changes: Number(result.changes) } };
  }

  async executeBatch(): Promise<D1Result<unknown>> {
    if (/^\s*SELECT\b/iu.test(this.sql)) {
      return {
        results: this.statement.all(...this.sqlValues()) as unknown[],
        meta: { changes: 0 },
      };
    }
    const result = this.statement.run(...this.sqlValues());
    return { meta: { changes: Number(result.changes) } };
  }
}

class SQLiteD1 implements T11D1Database {
  readonly database = new DatabaseSync(":memory:");

  prepare(sql: string): SQLiteD1Statement {
    return new SQLiteD1Statement(sql, this.database.prepare(sql));
  }

  async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
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

const updateWriter: FencedDesiredUpdateWriter = {
  async enqueueDesiredUpdateWithFence() {
    return { kind: "stale" };
  },
};

function store(db: SQLiteD1) {
  return new D1T11ReleaseRolloutStore(db, updateWriter, () => "op-test");
}

function installSchema(db: SQLiteD1) {
  db.database.exec(`
    CREATE TABLE logical_instances(instance_id TEXT PRIMARY KEY);
    CREATE TABLE deployment_revisions(revision_id TEXT PRIMARY KEY);
    CREATE TABLE operations(operation_id TEXT PRIMARY KEY);
    CREATE TABLE audit_events(
      event_id TEXT PRIMARY KEY, repository_id INTEGER, instance_id TEXT, operation_id TEXT,
      actor_id TEXT, actor_kind TEXT, action TEXT, outcome TEXT, request_id TEXT,
      metadata_json TEXT, occurred_at INTEGER
    );
  `);
  const doc = readFileSync("docs/migration/tasks/T11.md", "utf8");
  const schema = doc.match(/```sql\n([\s\S]*?)\n```/u)?.[1];
  if (!schema) throw new Error("T11 D1 schema proposal is missing its SQL block");
  db.database.exec(schema);
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
    db.database.prepare("INSERT INTO logical_instances(instance_id) VALUES (?)").run("instance-1");
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
});
