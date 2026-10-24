import { OperationFenceConflict } from "@praetorium/application/operations";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  D1PlatformStore,
  type D1Database,
  type D1PreparedStatement,
  type D1Result,
} from "@praetorium/persistence/d1";
import { publishRuntimeAuthority } from "./runtime-authority-transition.js";
import { createRuntimeBindingMetadataReader } from "./runtime-binding.js";

const NOW = Date.parse("2026-10-17T00:00:10.000Z");
const liveDatabases: DatabaseSync[] = [];

class SQLiteD1 implements D1Database {
  readonly database = new DatabaseSync(":memory:");

  constructor() {
    liveDatabases.push(this.database);
  }

  prepare(query: string): D1PreparedStatement {
    return new SQLiteD1Statement(this.database, query, this.database.prepare(query));
  }

  async batch<T = unknown>(
    statements: readonly D1PreparedStatement[],
  ): Promise<readonly D1Result<T>[]> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results: D1Result<unknown>[] = [];
      for (const statement of statements)
        results.push(await (statement as SQLiteD1Statement).execute());
      this.database.exec("COMMIT");
      return results as D1Result<T>[];
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

class SQLiteD1Statement implements D1PreparedStatement {
  private values: readonly (string | number | null | ArrayBuffer | Uint8Array)[] = [];

  constructor(
    private readonly database: DatabaseSync,
    private readonly query: string,
    private readonly statement: StatementSync,
  ) {}

  bind(
    ...values: readonly (string | number | null | ArrayBuffer | Uint8Array)[]
  ): D1PreparedStatement {
    this.values = values;
    return this;
  }

  private sqlValues(): SQLInputValue[] {
    return this.values.map((value) => {
      if (value instanceof ArrayBuffer) return new Uint8Array(value);
      return value;
    });
  }

  async first<T = unknown>(): Promise<T | null> {
    return (this.statement.get(...this.sqlValues()) as T | undefined) ?? null;
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    return {
      results: this.statement.all(...this.sqlValues()) as T[],
      meta: { changes: 0 },
    };
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    const result = this.statement.run(...this.sqlValues());
    return { results: [], meta: { changes: Number(result.changes) } };
  }

  async execute(): Promise<D1Result> {
    if (/^\s*(SELECT|WITH)\b/iu.test(this.query)) {
      return { results: this.statement.all(...this.sqlValues()), meta: { changes: 0 } };
    }
    const result = this.statement.run(...this.sqlValues());
    return { results: [], meta: { changes: Number(result.changes) } };
  }
}

function installSchema(db: SQLiteD1): void {
  db.database.exec("PRAGMA foreign_keys = ON");
  for (const migration of [
    "../migrations/0001_repository_platform.sql",
    "../migrations/0002_stable_release_rollouts.sql",
    "../migrations/0003_staged_configurations.sql",
    "../migrations/0004_runtime_git_credentials.sql",
    "../migrations/0006_application_origins.sql",
    "../migrations/0009_runtime_authority.sql",
  ])
    db.database.exec(readFileSync(new URL(migration, import.meta.url), "utf8"));
}

async function publishAuthority(db: SQLiteD1, operationId: string): Promise<void> {
  const operation = await new D1PlatformStore(db).getOperationById(operationId);
  if (!operation) throw new TypeError(`missing operation fixture ${operationId}`);
  await publishRuntimeAuthority(db, operation, NOW);
}

function seedRuntimeGitCredential(
  db: SQLiteD1,
  options: {
    readonly status: "active" | "revocation_pending" | "revoked";
    readonly expiresAt?: number;
    readonly instanceId?: string;
    readonly runtimeEpoch?: number;
  },
): void {
  db.database
    .prepare(
      `INSERT INTO runtime_git_credentials (
         token_id, repository_id, installation_id, instance_id, runtime_id,
         runtime_epoch, lease_id, permission, expires_at, encrypted_secret_json,
         status, created_at, updated_at
       ) VALUES (?, 7001, 9001, ?, 'res_current-4', ?, 'res_current-4', 'read', ?, '{}', ?, ?, ?)`,
    )
    .run(
      "a".repeat(64),
      options.instanceId ?? "ins_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      options.runtimeEpoch ?? 4,
      options.expiresAt ?? NOW + 60_000,
      options.status,
      NOW - 1,
      NOW - 1,
    );
}

function seedInstance(
  db: SQLiteD1,
  options: {
    readonly repositoryId?: number;
    readonly installationId?: number;
    readonly suspended?: number;
    readonly targetStatus?: "reserved" | "allocated" | "pending";
    readonly targetClusterId?: string;
    readonly targetReservationId?: string;
    readonly proofRetiredRuntimeEpoch?: number | null;
    readonly operationLeaseExpiresAt?: number;
    readonly targetPhase?: "starting-target" | "complete";
    readonly currentReservationStatus?: "reserved" | "allocated" | "released";
    readonly operationCheckpointSequence?: number;
  } = {},
): void {
  const repositoryId = options.repositoryId ?? 7001;
  const installationId = options.installationId ?? 9001;
  const targetReservationId = options.targetReservationId ?? "res_target-5";
  const targetPhase = options.targetPhase ?? "starting-target";
  db.database
    .prepare(
      `INSERT INTO logical_instances (
         instance_id, repository_id, generation, runtime_epoch, desired_state,
         observed_generation, observed_runtime_epoch, observed_state,
         observed_revision_id, desired_revision_id, current_artifact_digest,
         desired_artifact_digest, reservation_state, reservation_id, created_at, updated_at
       ) VALUES (?, ?, 8, 5, 'running', 7, 4, 'ready', 'revision-4', 'revision-5',
         'sha256:current', 'sha256:target', 'reserved', ?, ?, ?)`,
    )
    .run(
      "ins_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      repositoryId,
      targetReservationId,
      NOW - 1000,
      NOW - 1000,
    );
  db.database
    .prepare(
      `INSERT INTO repository_bindings (
         repository_id, instance_id, installation_id, owner, name,
         authorization_revision, binding_epoch, suspended, created_at, updated_at
       ) VALUES (?, 'ins_01ARZ3NDEKTSV4RRFFQ69G5FAV', ?, 'owner', 'repo', 3, 2, ?, ?, ?)`,
    )
    .run(repositoryId, installationId, options.suspended ?? 0, NOW - 1000, NOW - 1000);
  db.database
    .prepare(
      `INSERT INTO runtime_reservations (
         reservation_id, instance_id, repository_id, runtime_epoch, generation,
         cluster_id, status, capacity_snapshot_epoch, cpu_milli, memory_mib,
         ephemeral_storage_mib, created_at, updated_at
       ) VALUES ('res_current-4', 'ins_01ARZ3NDEKTSV4RRFFQ69G5FAV', ?, 4, 7, 'cluster-1', ?, 1,
         100, 256, 128, ?, ?)`,
    )
    .run(repositoryId, options.currentReservationStatus ?? "reserved", NOW - 1000, NOW - 1000);
  db.database
    .prepare(
      `UPDATE logical_instances SET runtime_authority_reservation_id = 'res_current-4'
       WHERE instance_id = ?`,
    )
    .run("ins_01ARZ3NDEKTSV4RRFFQ69G5FAV");
  if (targetReservationId === "") return;

  const proof = {
    instanceId: "ins_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    repositoryId,
    retiredRuntimeEpoch:
      options.proofRetiredRuntimeEpoch === undefined ? 4 : options.proofRetiredRuntimeEpoch,
    providerObservationId: "provider-observation-61",
    censusObservedAt: new Date(NOW - 500).toISOString(),
    remainingWriters: 0,
    evidenceIdentities: [],
    source: "runtime-provider-census",
  };
  const absenceCheckpoint = JSON.stringify({
    schemaVersion: 1,
    lifecycle: {
      instanceId: "ins_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      repositoryId,
      writerAbsenceProof: proof,
    },
    writerAbsenceProof: proof,
  });
  const currentCheckpoint = JSON.stringify({
    schemaVersion: 1,
    lifecycle: {
      instanceId: "ins_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      repositoryId,
      phase: targetPhase,
      writerAbsenceProof: proof,
    },
    writerAbsenceProof: proof,
  });
  db.database
    .prepare(
      `INSERT INTO runtime_reservations (
         reservation_id, instance_id, repository_id, runtime_epoch, generation,
         cluster_id, status, capacity_snapshot_epoch, cpu_milli, memory_mib,
         ephemeral_storage_mib, created_at, updated_at
       ) VALUES (?, 'ins_01ARZ3NDEKTSV4RRFFQ69G5FAV', ?, 5, 8, ?, ?, 1, 100, 256, 128, ?, ?)`,
    )
    .run(
      targetReservationId,
      repositoryId,
      options.targetClusterId ?? "cluster-1",
      options.targetStatus ?? "reserved",
      NOW - 500,
      NOW - 500,
    );
  const checkpointSequence = options.operationCheckpointSequence ?? 2;
  db.database
    .prepare(
      `INSERT INTO operations (
         operation_id, instance_id, repository_id, generation, runtime_epoch, kind,
         status, phase, attempt, lease_epoch, worker_id, lease_token, lease_expires_at,
         report_sequence, checkpoint_sequence, checkpoint_json, cluster_id, reservation_id,
         idempotency_scope, idempotency_key, request_hash, actor_id,
         authorization_revision, created_at, updated_at
       ) VALUES ('op-target-5', 'ins_01ARZ3NDEKTSV4RRFFQ69G5FAV', ?, 8, 5, 'redeploy', 'running',
         ?, 1, 1, 'provisioner-1', 'lease-secret', ?, 1, ?, ?,
         'cluster-1', ?, 'repo:7001', 'request-5', 'request-hash', 'user-1', 3, ?, ?)`,
    )
    .run(
      repositoryId,
      targetPhase,
      options.operationLeaseExpiresAt ?? NOW + 30_000,
      checkpointSequence,
      currentCheckpoint,
      targetReservationId,
      NOW - 700,
      NOW - 100,
    );
  db.database
    .prepare(
      `INSERT INTO operation_checkpoints (
         operation_id, sequence, phase, runtime_epoch, checkpoint_json, actor_id, occurred_at
       ) VALUES ('op-target-5', 1, 'old-writer-absent', 5, ?, 'provisioner-1', ?)`,
    )
    .run(absenceCheckpoint, NOW - 500);
  db.database
    .prepare(
      `INSERT INTO operation_checkpoints (
         operation_id, sequence, phase, runtime_epoch, checkpoint_json, actor_id, occurred_at
       ) VALUES ('op-target-5', 2, ?, 5, ?, 'provisioner-1', ?)`,
    )
    .run(targetPhase, currentCheckpoint, NOW - 400);
  db.database
    .prepare(
      `UPDATE logical_instances
       SET runtime_authority_reservation_id = NULL, runtime_authority_operation_id = NULL
       WHERE instance_id = ?`,
    )
    .run("ins_01ARZ3NDEKTSV4RRFFQ69G5FAV");
}

async function createDatabase(options?: Parameters<typeof seedInstance>[1]): Promise<SQLiteD1> {
  const db = new SQLiteD1();
  installSchema(db);
  seedInstance(db, options);
  if (options?.targetReservationId !== "") {
    const publication = publishAuthority(db, "op-target-5");
    if (options?.operationLeaseExpiresAt !== undefined && options.operationLeaseExpiresAt <= NOW)
      await expect(publication).rejects.toBeInstanceOf(OperationFenceConflict);
    else await publication;
  }
  return db;
}

interface RetirementCheckpoint {
  readonly phase: string;
  readonly quiesceRequest: Readonly<Record<string, unknown>> | null;
  readonly quiesceReceipt: Readonly<Record<string, unknown>> | null;
}

function seedRetirement(
  db: SQLiteD1,
  checkpoints: readonly RetirementCheckpoint[],
  options: {
    readonly kind?: "stop" | "redeploy";
    readonly status?: "running" | "failed" | "blocked";
    readonly leaseExpiresAt?: number;
    readonly newerDesiredGeneration?: boolean;
    readonly operationId?: string;
    readonly generation?: number;
    readonly runtimeEpoch?: number;
  } = {},
): void {
  if (options.newerDesiredGeneration) {
    db.database
      .prepare(
        "UPDATE logical_instances SET generation = 9, runtime_epoch = 6 WHERE instance_id = ?",
      )
      .run("ins_01ARZ3NDEKTSV4RRFFQ69G5FAV");
  }

  const operationId = options.operationId ?? "op-retirement-5";
  const latest = checkpoints.at(-1);
  if (!latest) throw new TypeError("retirement fixture requires a checkpoint");
  const latestCheckpoint = JSON.stringify({
    schemaVersion: 1,
    lifecycle: {
      instanceId: "ins_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      repositoryId: 7001,
      phase: latest.phase,
      quiesceRequest: latest.quiesceRequest,
      quiesceReceipt: latest.quiesceReceipt,
    },
  });
  db.database
    .prepare(
      `INSERT INTO operations (
         operation_id, instance_id, repository_id, generation, runtime_epoch, kind,
         status, phase, attempt, lease_epoch, worker_id, lease_token, lease_expires_at,
         report_sequence, checkpoint_sequence, checkpoint_json, cluster_id, reservation_id,
         idempotency_scope, idempotency_key, request_hash, actor_id,
         authorization_revision, created_at, updated_at
       ) VALUES (?, 'ins_01ARZ3NDEKTSV4RRFFQ69G5FAV', 7001, ?, ?, ?, ?, ?, 1, 1, 'provisioner-1',
         'retirement-lease', ?, 1, ?, ?, 'cluster-1', NULL, 'repo:7001',
         ?, 'retirement-hash', 'user-1', 3, ?, ?)`,
    )
    .run(
      operationId,
      options.generation ?? 8,
      options.runtimeEpoch ?? 5,
      options.kind ?? "redeploy",
      options.status ?? "running",
      latest.phase,
      options.leaseExpiresAt ?? NOW + 30_000,
      checkpoints.length,
      latestCheckpoint,
      operationId,
      NOW - 700,
      NOW - 100,
    );

  const insertCheckpoint = db.database.prepare(
    `INSERT INTO operation_checkpoints (
       operation_id, sequence, phase, runtime_epoch, checkpoint_json, actor_id, occurred_at
     ) VALUES (?, ?, ?, ?, ?, 'provisioner-1', ?)`,
  );
  checkpoints.forEach((checkpoint, index) => {
    insertCheckpoint.run(
      operationId,
      index + 1,
      checkpoint.phase,
      options.runtimeEpoch ?? 5,
      JSON.stringify({
        schemaVersion: 1,
        lifecycle: {
          instanceId: "ins_01ARZ3NDEKTSV4RRFFQ69G5FAV",
          repositoryId: 7001,
          phase: checkpoint.phase,
          quiesceRequest: checkpoint.quiesceRequest,
          quiesceReceipt: checkpoint.quiesceReceipt,
        },
      }),
      NOW - 500 + index,
    );
  });
  if (
    checkpoints.some(
      ({ phase }) =>
        phase === "quiescing-old" ||
        phase === "old-quiesced" ||
        phase === "stopping-old" ||
        phase === "old-writer-absent",
    )
  ) {
    db.database
      .prepare(
        `UPDATE logical_instances
         SET runtime_authority_reservation_id = NULL, runtime_authority_operation_id = NULL
         WHERE instance_id = ?`,
      )
      .run("ins_01ARZ3NDEKTSV4RRFFQ69G5FAV");
  }
}

const QUIESCE_REQUEST = {
  operationId: "op-retirement-5",
  instanceId: "ins_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  runtimeEpoch: 4,
  reason: "redeploy",
  contractVersion: "scriptorium-platform/v1",
  deadline: new Date(NOW + 10_000).toISOString(),
} as const;

function retirementCheckpoint(
  phase: string,
  quiesceRequest: Readonly<Record<string, unknown>> | null = QUIESCE_REQUEST,
  quiesceReceipt: Readonly<Record<string, unknown>> | null = null,
): RetirementCheckpoint {
  return { phase, quiesceRequest, quiesceReceipt };
}

afterEach(() => {
  while (liveDatabases.length > 0) liveDatabases.pop()?.close();
});

describe("Control Plane runtime binding metadata", () => {
  it("keeps the observed ready writer during a pending build and returns the active reservation identity", async () => {
    const db = await createDatabase({ targetReservationId: "" });
    const reader = createRuntimeBindingMetadataReader({ db, now: () => NOW });

    await expect(reader.getCurrent(7001)).resolves.toEqual({
      repositoryId: 7001,
      installationId: 9001,
      instanceId: "ins_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      physicalInstanceId: "run_01ARZ3NDEKTSV4RRFFQ69G5FAV_4",
      runtimeId: "res_current-4",
      runtimeEpoch: 4,
      leaseId: "res_current-4",
      clusterId: "cluster-1",
      active: true,
      authority: "observed-writer",
    });
  });

  it("withdraws observed-writer authority at quiesce despite lease expiry and a newer desired generation and operation", async () => {
    const db = await createDatabase({ targetReservationId: "" });
    seedRetirement(db, [retirementCheckpoint("quiescing-old")], {
      leaseExpiresAt: NOW - 1,
      newerDesiredGeneration: true,
    });
    seedRetirement(db, [retirementCheckpoint("accepted", null, null)], {
      operationId: "op-newer-6",
      generation: 9,
      runtimeEpoch: 6,
    });

    await expect(
      createRuntimeBindingMetadataReader({ db, now: () => NOW }).getCurrent(7001),
    ).resolves.toBeNull();
  });

  it.each(["old-quiesced", "stopping-old"])(
    "keeps the observed writer withdrawn in the %s retirement phase",
    async (phase) => {
      const db = await createDatabase({ targetReservationId: "" });
      seedRetirement(db, [retirementCheckpoint(phase)]);

      await expect(
        createRuntimeBindingMetadataReader({ db, now: () => NOW }).getCurrent(7001),
      ).resolves.toBeNull();
    },
  );

  it("keeps a stopping operation fenced when its lease expires or its terminal checkpoint omits the request", async () => {
    const expiredLeaseDb = await createDatabase({ targetReservationId: "" });
    seedRetirement(expiredLeaseDb, [retirementCheckpoint("stopping-old")], {
      kind: "stop",
      leaseExpiresAt: NOW - 1,
    });
    await expect(
      createRuntimeBindingMetadataReader({ db: expiredLeaseDb, now: () => NOW }).getCurrent(7001),
    ).resolves.toBeNull();

    const terminalDb = await createDatabase({ targetReservationId: "" });
    seedRetirement(
      terminalDb,
      [retirementCheckpoint("quiescing-old"), retirementCheckpoint("failed", null, null)],
      { status: "failed", leaseExpiresAt: NOW - 1 },
    );
    await expect(
      createRuntimeBindingMetadataReader({ db: terminalDb, now: () => NOW }).getCurrent(7001),
    ).resolves.toBeNull();
  });

  it("restores the old writer only after Lifecycle's explicit confirmed-resume checkpoint", async () => {
    const db = await createDatabase({ targetReservationId: "" });
    seedRetirement(db, [
      retirementCheckpoint("quiescing-old"),
      retirementCheckpoint("accepted", null, null),
    ]);
    await publishAuthority(db, "op-retirement-5");

    await expect(
      createRuntimeBindingMetadataReader({ db, now: () => NOW }).getCurrent(7001),
    ).resolves.toMatchObject({
      runtimeEpoch: 4,
      leaseId: "res_current-4",
      authority: "observed-writer",
    });
  });

  it("selects a target only after a fresh bound absence checkpoint and exact reserved assignment", async () => {
    const db = await createDatabase();
    const reader = createRuntimeBindingMetadataReader({ db, now: () => NOW });

    await expect(reader.getCurrent(7001)).resolves.toEqual({
      repositoryId: 7001,
      installationId: 9001,
      instanceId: "ins_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      physicalInstanceId: "run_01ARZ3NDEKTSV4RRFFQ69G5FAV_5",
      runtimeId: "res_target-5",
      runtimeEpoch: 5,
      leaseId: "res_target-5",
      clusterId: "cluster-1",
      active: true,
      authority: "post-absence-target",
    });
  });

  it("uses the explicit current grant instead of reconstructing one from retained checkpoints", async () => {
    const db = await createDatabase();
    const reader = createRuntimeBindingMetadataReader({ db, now: () => NOW });
    await expect(reader.getCurrent(7001)).resolves.toMatchObject({
      runtimeEpoch: 5,
      authority: "post-absence-target",
    });

    db.database
      .prepare(
        `UPDATE logical_instances
         SET runtime_authority_reservation_id = NULL, runtime_authority_operation_id = NULL
         WHERE instance_id = ?`,
      )
      .run("ins_01ARZ3NDEKTSV4RRFFQ69G5FAV");
    await expect(reader.getCurrent(7001)).resolves.toBeNull();
  });

  it("rejects a writer-absence proof mutation after the target grant is published", async () => {
    const db = await createDatabase();
    const store = new D1PlatformStore(db);
    const operation = await store.getOperationById("op-target-5");
    expect(operation?.checkpoint?.writerAbsenceProof).toBeDefined();
    const proof = operation?.checkpoint?.writerAbsenceProof as Record<string, unknown>;
    const append = await store.appendOperationCheckpoint({
      operationId: "op-target-5",
      workerId: "provisioner-1",
      leaseToken: "lease-secret",
      leaseEpoch: 1,
      expectedCheckpointSequence: 2,
      phase: "starting-target",
      checkpoint: {
        ...(operation?.checkpoint ?? {}),
        writerAbsenceProof: { ...proof, providerObservationId: "mutated-observation" },
      },
      now: NOW,
    });

    expect(append).toBeNull();
    await expect(
      createRuntimeBindingMetadataReader({ db, now: () => NOW }).getCurrent(7001),
    ).resolves.toMatchObject({ runtimeEpoch: 5, authority: "post-absence-target" });
  });

  it("keeps exact post-absence target authority through complete while the operation lease is running", async () => {
    const db = await createDatabase({ targetPhase: "complete", proofRetiredRuntimeEpoch: null });
    db.database
      .prepare(
        "UPDATE logical_instances SET observed_state = 'absent', observed_runtime_epoch = NULL WHERE instance_id = ?",
      )
      .run("ins_01ARZ3NDEKTSV4RRFFQ69G5FAV");
    await publishAuthority(db, "op-target-5");
    const reader = createRuntimeBindingMetadataReader({ db, now: () => NOW });

    await expect(reader.getCurrent(7001)).resolves.toEqual({
      repositoryId: 7001,
      installationId: 9001,
      instanceId: "ins_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      physicalInstanceId: "run_01ARZ3NDEKTSV4RRFFQ69G5FAV_5",
      runtimeId: "res_target-5",
      runtimeEpoch: 5,
      leaseId: "res_target-5",
      clusterId: "cluster-1",
      active: true,
      authority: "post-absence-target",
    });

    const expired = await createDatabase({
      targetPhase: "complete",
      proofRetiredRuntimeEpoch: null,
      operationLeaseExpiresAt: NOW - 1,
    });
    expired.database
      .prepare(
        "UPDATE logical_instances SET observed_state = 'absent', observed_runtime_epoch = NULL WHERE instance_id = ?",
      )
      .run("ins_01ARZ3NDEKTSV4RRFFQ69G5FAV");
    await expect(
      createRuntimeBindingMetadataReader({ db: expired, now: () => NOW }).getCurrent(7001),
    ).resolves.toBeNull();

    const terminal = await createDatabase({
      targetPhase: "complete",
      proofRetiredRuntimeEpoch: null,
    });
    terminal.database
      .prepare(
        "UPDATE logical_instances SET observed_state = 'absent', observed_runtime_epoch = NULL WHERE instance_id = ?",
      )
      .run("ins_01ARZ3NDEKTSV4RRFFQ69G5FAV");
    terminal.database
      .prepare("UPDATE operations SET status = 'succeeded' WHERE operation_id = 'op-target-5'")
      .run();
    await expect(
      createRuntimeBindingMetadataReader({ db: terminal, now: () => NOW }).getCurrent(7001),
    ).resolves.toBeNull();

    const mismatchedProof = await createDatabase({
      targetPhase: "complete",
      proofRetiredRuntimeEpoch: null,
    });
    mismatchedProof.database
      .prepare(
        "UPDATE logical_instances SET observed_state = 'absent', observed_runtime_epoch = NULL WHERE instance_id = ?",
      )
      .run("ins_01ARZ3NDEKTSV4RRFFQ69G5FAV");
    const latest = JSON.parse(
      mismatchedProof.database
        .prepare(
          "SELECT checkpoint_json FROM operation_checkpoints WHERE operation_id = ? AND sequence = 2",
        )
        .get("op-target-5")?.checkpoint_json as string,
    ) as { writerAbsenceProof: { providerObservationId: string } };
    latest.writerAbsenceProof.providerObservationId = "different-provider-observation";
    const checkpointJson = JSON.stringify(latest);
    mismatchedProof.database
      .prepare(
        "UPDATE operation_checkpoints SET checkpoint_json = ? WHERE operation_id = ? AND sequence = 2",
      )
      .run(checkpointJson, "op-target-5");
    mismatchedProof.database
      .prepare("UPDATE operations SET checkpoint_json = ? WHERE operation_id = ?")
      .run(checkpointJson, "op-target-5");
    await publishAuthority(mismatchedProof, "op-target-5");
    await expect(
      createRuntimeBindingMetadataReader({ db: mismatchedProof, now: () => NOW }).getCurrent(7001),
    ).resolves.toBeNull();
  });

  it.each(["active", "revocation_pending"] as const)(
    "does not reconstruct an already-published target grant from %s credentials",
    async (status) => {
      const db = await createDatabase();
      seedRuntimeGitCredential(db, { status });

      await expect(
        createRuntimeBindingMetadataReader({ db, now: () => NOW }).getCurrent(7001),
      ).resolves.toMatchObject({ runtimeEpoch: 5, authority: "post-absence-target" });
    },
  );

  it.each(["active", "revocation_pending"] as const)(
    "does not publish a target grant while a retired-runtime credential is %s",
    async (status) => {
      const db = await createDatabase();
      db.database
        .prepare(
          `UPDATE logical_instances
           SET runtime_authority_reservation_id = NULL, runtime_authority_operation_id = NULL
           WHERE instance_id = ?`,
        )
        .run("ins_01ARZ3NDEKTSV4RRFFQ69G5FAV");
      seedRuntimeGitCredential(db, { status });
      await publishAuthority(db, "op-target-5");

      await expect(
        createRuntimeBindingMetadataReader({ db, now: () => NOW }).getCurrent(7001),
      ).resolves.toBeNull();
    },
  );

  it("does not add a credential retirement gate when the absence proof has no retired epoch", async () => {
    const db = await createDatabase({ proofRetiredRuntimeEpoch: null });
    db.database
      .prepare(
        "UPDATE logical_instances SET observed_state = 'absent', observed_runtime_epoch = NULL WHERE instance_id = ?",
      )
      .run("ins_01ARZ3NDEKTSV4RRFFQ69G5FAV");
    seedRuntimeGitCredential(db, { status: "active" });
    await publishAuthority(db, "op-target-5");

    await expect(
      createRuntimeBindingMetadataReader({ db, now: () => NOW }).getCurrent(7001),
    ).resolves.toMatchObject({ runtimeEpoch: 5, authority: "post-absence-target" });
  });

  it("rejects stale epochs, another repository, suspended bindings, and stale reservations", async () => {
    const staleProofDb = await createDatabase({ proofRetiredRuntimeEpoch: 3 });
    const staleProofReader = createRuntimeBindingMetadataReader({
      db: staleProofDb,
      now: () => NOW,
    });
    await expect(staleProofReader.getCurrent(7001)).resolves.toBeNull();
    await expect(staleProofReader.getCurrent(7002)).resolves.toBeNull();

    const suspendedDb = await createDatabase({ suspended: 1, targetReservationId: "" });
    await expect(
      createRuntimeBindingMetadataReader({ db: suspendedDb, now: () => NOW }).getCurrent(7001),
    ).resolves.toBeNull();

    const releasedDb = await createDatabase({
      currentReservationStatus: "released",
      targetReservationId: "",
    });
    await expect(
      createRuntimeBindingMetadataReader({ db: releasedDb, now: () => NOW }).getCurrent(7001),
    ).resolves.toBeNull();
  });

  it("does not infer writer absence from an expired operation lease or accept a mismatched target reservation", async () => {
    const expiredLeaseDb = await createDatabase({ operationLeaseExpiresAt: NOW - 1 });
    await expect(
      createRuntimeBindingMetadataReader({ db: expiredLeaseDb, now: () => NOW }).getCurrent(7001),
    ).resolves.toBeNull();

    const wrongClusterDb = await createDatabase({ targetClusterId: "cluster-2" });
    await expect(
      createRuntimeBindingMetadataReader({ db: wrongClusterDb, now: () => NOW }).getCurrent(7001),
    ).resolves.toBeNull();

    const pendingReservationDb = await createDatabase({ targetStatus: "pending" });
    await expect(
      createRuntimeBindingMetadataReader({ db: pendingReservationDb, now: () => NOW }).getCurrent(
        7001,
      ),
    ).resolves.toBeNull();
  });

  it("uses the current GitHub installation binding when installation membership changes", async () => {
    const db = await createDatabase({ targetReservationId: "" });
    db.database
      .prepare("UPDATE repository_bindings SET installation_id = 9002 WHERE repository_id = 7001")
      .run();
    await expect(
      createRuntimeBindingMetadataReader({ db, now: () => NOW }).getCurrent(7001),
    ).resolves.toMatchObject({ installationId: 9002, runtimeEpoch: 4, leaseId: "res_current-4" });
  });
});

it.each(["active", "revocation_pending"] as const)(
  "does not publish a target grant while a retired physical-runtime credential is %s",
  async (status) => {
    const db = await createDatabase();
    db.database
      .prepare(
        `UPDATE logical_instances
         SET runtime_authority_reservation_id = NULL, runtime_authority_operation_id = NULL
         WHERE instance_id = ?`,
      )
      .run("ins_01ARZ3NDEKTSV4RRFFQ69G5FAV");
    seedRuntimeGitCredential(db, {
      status,
      instanceId: "run_01ARZ3NDEKTSV4RRFFQ69G5FAV_4",
    });
    await publishAuthority(db, "op-target-5");
    await expect(
      createRuntimeBindingMetadataReader({ db, now: () => NOW }).getCurrent(7001),
    ).resolves.toBeNull();
  },
);
