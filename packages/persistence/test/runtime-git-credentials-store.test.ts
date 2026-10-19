import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeGitCredentialRegistration } from "@praetorium/contracts";
import { D1PlatformStore } from "../src/d1/platform-store.js";
import {
  D1RuntimeGitCredentialStore,
  RuntimeGitCredentialConflictError,
} from "../src/d1/runtime-git-credentials-store.js";
import type { D1Database, D1PreparedStatement, D1Result } from "../src/d1/types.js";

const NOW = Date.parse("2026-10-17T00:00:10.000Z");
const liveDatabases: DatabaseSync[] = [];

class SQLiteD1 implements D1Database {
  readonly database = new DatabaseSync(":memory:");

  constructor() {
    liveDatabases.push(this.database);
    this.database.exec("PRAGMA foreign_keys = ON");
    for (const migration of [
      "../../../apps/control-plane/migrations/0001_repository_platform.sql",
      "../../../apps/control-plane/migrations/0002_stable_release_rollouts.sql",
      "../../../apps/control-plane/migrations/0003_staged_configurations.sql",
      "../../../apps/control-plane/migrations/0004_runtime_git_credentials.sql",
      "../../../apps/control-plane/migrations/0006_application_origins.sql",
    ])
      this.database.exec(readFileSync(new URL(migration, import.meta.url), "utf8"));
    seedBinding(this);
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

function seedBinding(db: SQLiteD1): void {
  db.database
    .prepare(
      `INSERT INTO logical_instances (instance_id, repository_id, desired_state, created_at, updated_at)
       VALUES ('ins_repo-7001', 7001, 'running', ?, ?)`,
    )
    .run(NOW, NOW);
  db.database
    .prepare(
      `INSERT INTO repository_bindings (
         repository_id, instance_id, installation_id, owner, name, created_at, updated_at
       ) VALUES (7001, 'ins_repo-7001', 9001, 'owner', 'repo', ?, ?)`,
    )
    .run(NOW, NOW);
  db.database
    .prepare(
      `INSERT INTO runtime_reservations (
         reservation_id, instance_id, repository_id, runtime_epoch, generation,
         cluster_id, status, capacity_snapshot_epoch, cpu_milli, memory_mib,
         ephemeral_storage_mib, created_at, updated_at
       ) VALUES ('res_epoch-4', 'ins_repo-7001', 7001, 4, 7, 'cluster-1', 'released',
         1, 100, 256, 128, ?, ?)`,
    )
    .run(NOW, NOW);
}

function registration(
  index = 1,
  options: {
    readonly runtimeEpoch?: number;
    readonly expiresAt?: string;
    readonly permission?: "read" | "write";
    readonly repositoryId?: number;
    readonly installationId?: number;
    readonly instanceId?: string;
  } = {},
): RuntimeGitCredentialRegistration {
  return {
    tokenId: index.toString(16).padStart(64, "0"),
    repositoryId: options.repositoryId ?? 7001,
    installationId: options.installationId ?? 9001,
    instanceId: options.instanceId ?? "ins_repo-7001",
    runtimeId: `res_epoch-${options.runtimeEpoch ?? 4}`,
    runtimeEpoch: options.runtimeEpoch ?? 4,
    leaseId: `res_epoch-${options.runtimeEpoch ?? 4}`,
    permission: options.permission ?? "read",
    expiresAt: options.expiresAt ?? new Date(NOW + 60_000).toISOString(),
    encryptedSecret: {
      version: 1,
      keyId: "gateway-kek-1",
      iv: "AAAAAAAAAAAAAAAA",
      ciphertext: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    },
  };
}

afterEach(() => {
  for (const database of liveDatabases.splice(0)) database.close();
});

describe("D1RuntimeGitCredentialStore", () => {
  it("stores only the encrypted envelope and preserves immutable identity across idempotent registration", async () => {
    const db = new SQLiteD1();
    const store = new D1RuntimeGitCredentialStore(db);
    const input = registration();

    const first = await store.register(input, NOW);
    const replay = await store.register(input, NOW + 1);

    expect(first).toMatchObject({ ...input, status: "active", createdAt: NOW, updatedAt: NOW });
    expect(replay).toEqual(first);
    const stored = db.database
      .prepare("SELECT encrypted_secret_json FROM runtime_git_credentials WHERE token_id = ?")
      .get(input.tokenId) as { encrypted_secret_json: string };
    expect(stored.encrypted_secret_json).toBe(JSON.stringify(input.encryptedSecret));
    expect(stored.encrypted_secret_json).not.toContain("gho_");
  });

  it("rejects token ID reuse with changed binding, permission, expiry, or ciphertext", async () => {
    const store = new D1RuntimeGitCredentialStore(new SQLiteD1());
    const original = registration();
    await store.register(original, NOW);

    const changed = [
      { ...original, runtimeEpoch: 5, runtimeId: "res_epoch-5", leaseId: "res_epoch-5" },
      { ...original, permission: "write" as const },
      { ...original, expiresAt: new Date(NOW + 120_000).toISOString() },
      { ...original, encryptedSecret: { ...original.encryptedSecret, ciphertext: "CCCCCCCCCCCCCCCC" } },
    ];
    for (const input of changed)
      await expect(store.register(input, NOW + 1)).rejects.toBeInstanceOf(
        RuntimeGitCredentialConflictError,
      );
  });

  it("never reactivates pending or revoked duplicate IDs and acknowledges revocation idempotently", async () => {
    const store = new D1RuntimeGitCredentialStore(new SQLiteD1());
    const input = registration();
    await store.register(input, NOW);
    expect(await store.markPending(input.tokenId, NOW + 1)).toMatchObject({
      status: "revocation_pending",
      updatedAt: NOW + 1,
    });
    expect(await store.register(input, NOW + 2)).toMatchObject({
      status: "revocation_pending",
      updatedAt: NOW + 1,
    });
    expect(await store.markRevoked(input.tokenId, NOW + 3)).toMatchObject({
      status: "revoked",
      updatedAt: NOW + 3,
    });
    expect(await store.register(input, NOW + 4)).toMatchObject({
      status: "revoked",
      updatedAt: NOW + 3,
    });
    expect(await store.markRevoked(input.tokenId, NOW + 5)).toMatchObject({
      status: "revoked",
      updatedAt: NOW + 3,
    });
  });

  it("marks only the exact repository, instance, and epoch pending", async () => {
    const store = new D1RuntimeGitCredentialStore(new SQLiteD1());
    const current = registration(1);
    const otherEpoch = registration(2, { runtimeEpoch: 5 });
    await store.register(current, NOW);
    await store.register(otherEpoch, NOW);

    await expect(store.markPendingForRuntime(7001, "ins_repo-7001", 4, NOW + 1)).resolves.toBe(1);
    await expect(store.listPending(7001, 4, NOW + 1, 8)).resolves.toMatchObject([
      { tokenId: current.tokenId, status: "revocation_pending" },
    ]);
    await expect(store.listPending(7001, 5, NOW + 1, 8)).resolves.toEqual([]);
  });

  it("bounds pending batches, excludes expired records from count, and purges in bounded batches", async () => {
    const store = new D1RuntimeGitCredentialStore(new SQLiteD1());
    for (let index = 1; index <= 10; index += 1) {
      const expiresAt = index === 10 ? new Date(NOW).toISOString() : new Date(NOW + 60_000).toISOString();
      const input = registration(index, { expiresAt });
      await store.register(input, NOW);
      await store.markPending(input.tokenId, NOW);
    }

    await expect(store.listPending(7001, 4, NOW, 9)).rejects.toThrow(/limit/iu);
    await expect(store.listPending(7001, 4, NOW, 8)).resolves.toHaveLength(8);
    await expect(store.pendingCount(7001, 4, NOW)).resolves.toBe(9);
    await expect(store.purgeExpired(NOW, 65)).rejects.toThrow(/limit/iu);
    await expect(store.purgeExpired(NOW, 64)).resolves.toBe(1);
    await expect(store.pendingCount(7001, 4, NOW)).resolves.toBe(9);
  });

  it("retires only exact active credentials in the atomic current-lease quiescing checkpoint", async () => {
    const db = new SQLiteD1();
    const credentialStore = new D1RuntimeGitCredentialStore(db);
    const current = registration(101);
    const otherEpoch = registration(102, { runtimeEpoch: 5 });
    const otherRepository = registration(103, {
      repositoryId: 7002,
      installationId: 9002,
      instanceId: "ins_repo-7002",
    });
    seedOtherBinding(db);
    await credentialStore.register(current, NOW);
    await credentialStore.register(otherEpoch, NOW);
    await credentialStore.register(otherRepository, NOW);
    seedRunningOperation(db);

    const platform = new D1PlatformStore(db);
    const checkpoint = {
      operationId: "op_retire-1",
      workerId: "worker-1",
      leaseToken: "operation-lease-token-long-enough",
      leaseEpoch: 2,
      expectedCheckpointSequence: 0,
      phase: "quiescing-old" as const,
      checkpoint: {
        lifecycle: {
          quiesceRequest: { instanceId: "ins_repo-7001", runtimeEpoch: 4 },
        },
      },
      now: NOW + 1,
    };

    await expect(
      platform.appendOperationCheckpoint({ ...checkpoint, leaseToken: "stale-lease-token-long-enough" }),
    ).resolves.toBeNull();
    await expect(
      platform.appendOperationCheckpoint({ ...checkpoint, expectedCheckpointSequence: 1 }),
    ).resolves.toBeNull();
    expect(await credentialStore.listPending(7001, 4, NOW + 1, 8)).toEqual([]);
    expect(await credentialStore.listPending(7001, 5, NOW + 1, 8)).toEqual([]);
    expect(await credentialStore.listPending(7002, 4, NOW + 1, 8)).toEqual([]);

    await expect(platform.appendOperationCheckpoint(checkpoint)).resolves.toMatchObject({
      id: "op_retire-1",
      phase: "quiescing-old",
      checkpointSequence: 1,
    });
    await expect(credentialStore.listPending(7001, 4, NOW + 1, 8)).resolves.toMatchObject([
      { tokenId: current.tokenId, status: "revocation_pending" },
    ]);
    await expect(credentialStore.listPending(7001, 5, NOW + 1, 8)).resolves.toEqual([]);
    await expect(credentialStore.listPending(7002, 4, NOW + 1, 8)).resolves.toEqual([]);
    expect(
      db.database
        .prepare("SELECT status FROM runtime_git_credentials WHERE token_id = ?")
        .get(otherEpoch.tokenId),
    ).toMatchObject({ status: "active" });
    expect(
      db.database
        .prepare("SELECT status FROM runtime_git_credentials WHERE token_id = ?")
        .get(otherRepository.tokenId),
    ).toMatchObject({ status: "active" });
  });

  it.each([false, true])("retires the proof-bound old epoch atomically (physical identity: %s)", async (physical) => {
    const db = new SQLiteD1();
    const credentialStore = new D1RuntimeGitCredentialStore(db);
    const retired = registration(111, physical ? { instanceId: "run_repo-7001_4" } : {});
    const otherEpoch = registration(112, { runtimeEpoch: 5 });
    const otherInstance = registration(113, { instanceId: "ins_repo-7001-other" });
    const otherRepository = registration(114, {
      repositoryId: 7002,
      installationId: 9002,
      instanceId: "ins_repo-7002",
    });
    seedOtherBinding(db);
    await credentialStore.register(retired, NOW);
    await credentialStore.register(otherEpoch, NOW);
    await credentialStore.register(otherInstance, NOW);
    await credentialStore.register(otherRepository, NOW);
    seedRunningOperation(db, 5);

    const platform = new D1PlatformStore(db);
    const checkpoint = {
      operationId: "op_retire-1",
      workerId: "worker-1",
      leaseToken: "operation-lease-token-long-enough",
      leaseEpoch: 2,
      expectedCheckpointSequence: 0,
      phase: "old-writer-absent" as const,
      checkpoint: {
        writerAbsenceProof: absenceProof({ retiredRuntimeEpoch: 4 }),
      },
      now: NOW + 1,
    };

    await expect(
      platform.appendOperationCheckpoint({ ...checkpoint, leaseToken: "stale-lease-token-long-enough" }),
    ).resolves.toBeNull();
    await expect(
      platform.appendOperationCheckpoint({ ...checkpoint, expectedCheckpointSequence: 1 }),
    ).resolves.toBeNull();
    expect(await credentialStore.listPending(7001, 4, NOW + 1, 8)).toEqual([]);

    const absentProof = (retiredRuntimeEpoch: number | null, instanceId = "ins_repo-7001", repositoryId = 7001) => ({
      writerAbsenceProof: absenceProof({ retiredRuntimeEpoch, instanceId, repositoryId }),
    });
    for (const [sequence, proof] of [
      [0, absentProof(null)],
      [1, absentProof(4, "ins_repo-7001-other")],
      [2, absentProof(4, "ins_repo-7001", 7002)],
      [3, absentProof(6)],
    ] as const) {
      await expect(
        platform.appendOperationCheckpoint({
          ...checkpoint,
          expectedCheckpointSequence: sequence,
          checkpoint: proof,
        }),
      ).resolves.toMatchObject({
        id: "op_retire-1",
        phase: "old-writer-absent",
        checkpointSequence: sequence + 1,
      });
      expect(await credentialStore.listPending(7001, 4, NOW + 1, 8)).toEqual([]);
    }

    await expect(
      platform.appendOperationCheckpoint({
        ...checkpoint,
        expectedCheckpointSequence: 4,
        checkpoint: absentProof(4),
      }),
    ).resolves.toMatchObject({
      id: "op_retire-1",
      phase: "old-writer-absent",
      checkpointSequence: 5,
    });
    await expect(credentialStore.listPending(7001, 4, NOW + 1, 8)).resolves.toMatchObject([
      { tokenId: retired.tokenId, status: "revocation_pending" },
    ]);
    await expect(credentialStore.listPending(7001, 5, NOW + 1, 8)).resolves.toEqual([]);
    await expect(credentialStore.listPending(7002, 4, NOW + 1, 8)).resolves.toEqual([]);
    for (const token of [otherEpoch, otherInstance, otherRepository])
      expect(
        db.database
          .prepare("SELECT status FROM runtime_git_credentials WHERE token_id = ?")
          .get(token.tokenId),
      ).toMatchObject({ status: "active" });
  });
});

function absenceProof(input: {
  readonly retiredRuntimeEpoch: number | null;
  readonly instanceId?: string;
  readonly repositoryId?: number;
}) {
  return {
    instanceId: input.instanceId ?? "ins_repo-7001",
    repositoryId: input.repositoryId ?? 7001,
    retiredRuntimeEpoch: input.retiredRuntimeEpoch,
    providerObservationId: "provider-census-1",
    censusObservedAt: new Date(NOW).toISOString(),
    remainingWriters: 0,
    evidenceIdentities: [],
    source: "runtime-provider-census" as const,
  };
}

function seedOtherBinding(db: SQLiteD1): void {
  db.database
    .prepare(
      `INSERT INTO logical_instances (instance_id, repository_id, desired_state, created_at, updated_at)
       VALUES ('ins_repo-7002', 7002, 'running', ?, ?)`,
    )
    .run(NOW, NOW);
  db.database
    .prepare(
      `INSERT INTO repository_bindings (
         repository_id, instance_id, installation_id, owner, name, created_at, updated_at
       ) VALUES (7002, 'ins_repo-7002', 9002, 'owner', 'other-repo', ?, ?)`,
    )
    .run(NOW, NOW);
}

function seedRunningOperation(db: SQLiteD1, runtimeEpoch = 4): void {
  db.database
    .prepare(
      `INSERT INTO operations (
         operation_id, instance_id, repository_id, generation, runtime_epoch, kind, status, phase,
         attempt, lease_epoch, worker_id, lease_token, lease_expires_at, report_sequence, last_report_digest,
         checkpoint_sequence, checkpoint_json, result_json, cluster_id, reservation_id,
         deployment_revision_id, build_id, prerequisite_build_id, idempotency_scope, idempotency_key,
         request_hash, actor_id, authorization_revision, request_id, created_at, updated_at
       ) VALUES (
         'op_retire-1', 'ins_repo-7001', 7001, 7, ?, 'redeploy', 'running', 'accepted',
         1, 2, 'worker-1', 'operation-lease-token-long-enough', ?, 0, NULL,
         0, NULL, NULL, 'cluster-1', 'res_epoch-4',
         NULL, NULL, NULL, 'repo:7001', 'retire-checkpoint-1',
         'request-hash', 'actor-1', 1, NULL, ?, ?
       )`,
    )
    .run(runtimeEpoch, NOW + 30_000, NOW, NOW);
}
