import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type {
  RuntimeGitCredentialRecord,
  RuntimeGitCredentialRegistration,
} from "@praetorium/contracts";
import type { D1Database, D1PreparedStatement, D1Result } from "@praetorium/persistence/d1";
import {
  createRuntimeGitCredentialRoutes,
  type RuntimeGitCredentialStore,
} from "./runtime-git-credential-routes.js";
import type { RuntimeBindingMetadata } from "./runtime-binding.js";

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
    ])
      this.database.exec(readFileSync(new URL(migration, import.meta.url), "utf8"));
    this.database
      .prepare(
        `INSERT INTO logical_instances (instance_id, repository_id, desired_state, created_at, updated_at)
         VALUES ('ins_repo-7001', 7001, 'running', ?, ?)`,
      )
      .run(NOW, NOW);
    this.database
      .prepare(
        `INSERT INTO repository_bindings (
           repository_id, instance_id, installation_id, owner, name, created_at, updated_at
         ) VALUES (7001, 'ins_repo-7001', 9001, 'owner', 'repo', ?, ?)`,
      )
      .run(NOW, NOW);
    this.database
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

class MemoryCredentials implements RuntimeGitCredentialStore {
  readonly records = new Map<string, RuntimeGitCredentialRecord>();
  readonly purgeCalls: { readonly now: number; readonly limit: number }[] = [];
  afterRegister?: () => void;
  isCurrentAuthority: (input: {
    readonly repositoryId: number;
    readonly installationId: number;
    readonly instanceId: string;
    readonly runtimeId: string;
    readonly runtimeEpoch: number;
    readonly leaseId: string;
  }) => boolean = () => true;

  async purgeExpired(now: number, limit: number): Promise<number> {
    this.purgeCalls.push({ now, limit });
    return 0;
  }

  async register(
    registration: RuntimeGitCredentialRegistration,
    now: number,
  ): Promise<RuntimeGitCredentialRecord> {
    const current = this.isCurrentAuthority(registration);
    const existing = this.records.get(registration.tokenId);
    if (existing) {
      if (existing.status === "active" && !current) {
        const pending = { ...existing, status: "revocation_pending" as const, updatedAt: now };
        this.records.set(existing.tokenId, pending);
        return pending;
      }
      return existing;
    }
    const record: RuntimeGitCredentialRecord = {
      ...registration,
      status: current ? "active" : "revocation_pending",
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(record.tokenId, record);
    this.afterRegister?.();
    return record;
  }

  async findReusable(
    input: {
      readonly repositoryId: number;
      readonly installationId: number;
      readonly instanceId: string;
      readonly runtimeId: string;
      readonly runtimeEpoch: number;
      readonly leaseId: string;
      readonly permission: "read" | "write";
    },
    now: number,
  ): Promise<RuntimeGitCredentialRecord | null> {
    if (!this.isCurrentAuthority(input)) return null;
    return [...this.records.values()].find((record) =>
      record.status === "active" &&
      Date.parse(record.expiresAt) > now &&
      record.repositoryId === input.repositoryId &&
      record.installationId === input.installationId &&
      record.instanceId === input.instanceId &&
      record.runtimeId === input.runtimeId &&
      record.runtimeEpoch === input.runtimeEpoch &&
      record.leaseId === input.leaseId &&
      record.permission === input.permission
    ) ?? null;
  }

  async markPending(tokenId: string, now: number): Promise<RuntimeGitCredentialRecord | null> {
    const record = this.records.get(tokenId);
    if (!record) return null;
    if (record.status === "active") {
      const pending = { ...record, status: "revocation_pending" as const, updatedAt: now };
      this.records.set(tokenId, pending);
      return pending;
    }
    return record;
  }

  async listPending(
    repositoryId: number,
    runtimeEpoch: number,
    now: number,
    limit: number,
  ): Promise<RuntimeGitCredentialRecord[]> {
    return [...this.records.values()]
      .filter(
        (record) =>
          record.repositoryId === repositoryId &&
          record.runtimeEpoch === runtimeEpoch &&
          record.status === "revocation_pending" &&
          Date.parse(record.expiresAt) > now,
      )
      .sort((left, right) => left.tokenId.localeCompare(right.tokenId))
      .slice(0, limit);
  }

  async pendingCount(repositoryId: number, runtimeEpoch: number, now: number): Promise<number> {
    return [...this.records.values()].filter(
      (record) =>
        record.repositoryId === repositoryId &&
        record.runtimeEpoch === runtimeEpoch &&
        record.status === "revocation_pending" &&
        Date.parse(record.expiresAt) > now,
    ).length;
  }

  async markRevoked(tokenId: string, now: number): Promise<RuntimeGitCredentialRecord | null> {
    const record = this.records.get(tokenId);
    if (!record) return null;
    if (record.status === "revoked") return record;
    const revoked = { ...record, status: "revoked" as const, updatedAt: now };
    this.records.set(tokenId, revoked);
    return revoked;
  }
}

const registration = (index = 1): RuntimeGitCredentialRegistration => ({
  tokenId: index.toString(16).padStart(64, "0"),
  repositoryId: 7001,
  installationId: 9001,
  instanceId: "ins_repo-7001",
  runtimeId: "res_epoch-4",
  runtimeEpoch: 4,
  leaseId: "res_epoch-4",
  permission: "read",
  expiresAt: new Date(NOW + 60_000).toISOString(),
  encryptedSecret: {
    version: 1,
    keyId: "gateway-kek-1",
    iv: "AAAAAAAAAAAAAAAA",
    ciphertext: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  },
});

const lookup = {
  repositoryId: 7001,
  installationId: 9001,
  instanceId: "ins_repo-7001",
  runtimeId: "res_epoch-4",
  runtimeEpoch: 4,
  leaseId: "res_epoch-4",
  permission: "read" as const,
};

const currentBinding: RuntimeBindingMetadata = {
  repositoryId: 7001,
  installationId: 9001,
  instanceId: "ins_repo-7001",
  runtimeId: "res_epoch-4",
  runtimeEpoch: 4,
  leaseId: "res_epoch-4",
  clusterId: "cluster-1",
  active: true,
  authority: "observed-writer",
};

function createRoutes(input: {
  readonly db: SQLiteD1;
  readonly credentials?: MemoryCredentials;
  readonly binding?: RuntimeBindingMetadata | null;
  readonly onReadBinding?: () => void;
}): { readonly app: ReturnType<typeof createRuntimeGitCredentialRoutes>; readonly credentials: MemoryCredentials } {
  const credentials = input.credentials ?? new MemoryCredentials();
  credentials.isCurrentAuthority = (candidate) => {
    input.onReadBinding?.();
    const binding = input.binding === undefined ? currentBinding : input.binding;
    return (
      binding !== null &&
      binding.active &&
      binding.repositoryId === candidate.repositoryId &&
      binding.installationId === candidate.installationId &&
      (binding.physicalInstanceId ?? binding.instanceId) === candidate.instanceId &&
      binding.runtimeId === candidate.runtimeId &&
      binding.runtimeEpoch === candidate.runtimeEpoch &&
      binding.leaseId === candidate.leaseId
    );
  };
  return {
    credentials,
    app: createRuntimeGitCredentialRoutes({
      db: input.db,
      credentials,
      now: () => NOW,
    }),
  };
}

function jsonRequest(body: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

afterEach(() => {
  for (const database of liveDatabases.splice(0)) database.close();
});

describe("Control Plane runtime Git credential routes", () => {
  it("persists ciphertext and determines registration status from current authority", async () => {
    const db = new SQLiteD1();
    const credentials = new MemoryCredentials();
    credentials.afterRegister = () => {
      expect(credentials.records.has(registration().tokenId)).toBe(true);
    };
    const route = createRoutes({ db, credentials });
    const response = await route.app.request(
      "/internal/runtime-credentials",
      jsonRequest(registration()),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "active" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(credentials.purgeCalls).toEqual([]);
  });

  it("returns only an active unexpired credential for the exact requested identity and permission", async () => {
    const db = new SQLiteD1();
    const credentials = new MemoryCredentials();
    const active = await credentials.register(registration(), NOW);
    const pending = await credentials.register(registration(2), NOW);
    await credentials.markPending(pending.tokenId, NOW);
    const { app } = createRoutes({ db, credentials });

    const response = await app.request(
      "/internal/runtime-credentials/reuse",
      jsonRequest(lookup),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ credential: active });

    const wrongScope = await app.request(
      "/internal/runtime-credentials/reuse",
      jsonRequest({ ...lookup, permission: "write" }),
    );
    expect(await wrongScope.json()).toEqual({ credential: null });
  });

  it("marks inactive or mismatched registrations pending and preserves an already-revoked duplicate", async () => {
    const db = new SQLiteD1();
    const route = createRoutes({
      db,
      binding: { ...currentBinding, installationId: 9002 },
    });
    const response = await route.app.request(
      "/internal/runtime-credentials",
      jsonRequest(registration()),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "revocation_pending" });

    const revokedCredentials = new MemoryCredentials();
    const revokedRecord = {
      ...registration(2),
      status: "revoked" as const,
      createdAt: NOW,
      updatedAt: NOW,
    };
    revokedCredentials.records.set(revokedRecord.tokenId, revokedRecord);
    const revokedRoute = createRoutes({
      db,
      credentials: revokedCredentials,
      binding: null,
    });
    const revokedResponse = await revokedRoute.app.request(
      "/internal/runtime-credentials",
      jsonRequest(registration(2)),
    );
    expect(await revokedResponse.json()).toEqual({ status: "revoked" });
  });

  it("fails closed when an inactive or unavailable binding cannot confirm the stored registration", async () => {
    const unavailableCredentials = new MemoryCredentials();
    const unavailable = createRoutes({
      db: new SQLiteD1(),
      credentials: unavailableCredentials,
      onReadBinding: () => {
        throw new Error("binding read failed");
      },
    });
    const unavailableResponse = await unavailable.app.request(
      "/internal/runtime-credentials",
      jsonRequest(registration(2)),
    );
    expect(unavailableResponse.status).toBe(503);
    expect(await unavailableResponse.json()).toEqual({
      error: { code: "RUNTIME_GIT_CREDENTIAL_STATE_UNAVAILABLE" },
    });
    expect(unavailable.credentials.records.size).toBe(0);
  });

  it("rejects plaintext or extra fields and credential expiries outside the bounded GitHub lifetime", async () => {
    const { app } = createRoutes({ db: new SQLiteD1() });
    const plaintext = await app.request(
      "/internal/runtime-credentials",
      jsonRequest({ ...registration(), token: "gho_secret_bearer" }),
    );
    expect(plaintext.status).toBe(400);

    const expired = await app.request(
      "/internal/runtime-credentials",
      jsonRequest({ ...registration(), expiresAt: new Date(NOW).toISOString() }),
    );
    expect(expired.status).toBe(400);

    const tooLong = await app.request(
      "/internal/runtime-credentials",
      jsonRequest({ ...registration(), expiresAt: new Date(NOW + 3_605_001).toISOString() }),
    );
    expect(tooLong.status).toBe(400);
  });

  it("lists only pending encrypted credentials in batches of eight after validating a historical reservation", async () => {
    const db = new SQLiteD1();
    const credentials = new MemoryCredentials();
    for (let index = 1; index <= 10; index += 1) {
      const input = registration(index);
      credentials.records.set(input.tokenId, {
        ...input,
        status: index === 10 ? "active" : "revocation_pending",
        createdAt: NOW,
        updatedAt: NOW,
      });
    }
    const { app } = createRoutes({ db, credentials });
    const response = await app.request(
      "/internal/runtime-credentials/pending",
      jsonRequest({ repositoryId: 7001, runtimeEpoch: 4 }),
    );
    const body = (await response.json()) as {
      readonly credentials: readonly RuntimeGitCredentialRecord[];
      readonly remaining: number;
    };
    expect(response.status).toBe(200);
    expect(body.credentials).toHaveLength(8);
    expect(body.credentials.every((record) => record.status === "revocation_pending")).toBe(true);
    expect(body.remaining).toBe(9);
    expect(JSON.stringify(body)).not.toContain("gho_");
  });

  it("does not list pending credentials for a repository epoch without a durable reservation", async () => {
    const db = new SQLiteD1();
    const { app } = createRoutes({ db });
    const response = await app.request(
      "/internal/runtime-credentials/pending",
      jsonRequest({ repositoryId: 7001, runtimeEpoch: 5 }),
    );
    expect(response.status).toBe(404);
  });

  it("acknowledges a successful revocation for active or pending registrations idempotently", async () => {
    const { app, credentials } = createRoutes({ db: new SQLiteD1() });
    const input = registration();
    await credentials.register(input, NOW);
    const response = await app.request(
      `/internal/runtime-credentials/${input.tokenId}/revoked`,
      jsonRequest({}),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revoked: true });
    const replay = await app.request(
      `/internal/runtime-credentials/${input.tokenId}/revoked`,
      jsonRequest({}),
    );
    expect(await replay.json()).toEqual({ revoked: true });
  });
});
