import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { buildKey, canonicalBuildInput, type BuildInput } from "@praetorium/contracts";
import { D1BuildStore } from "../src/d1/build-store.js";
import type { D1Database, D1PreparedStatement, D1Result } from "../src/d1/types.js";

const schemaUrl = new URL(
  "../../../apps/control-plane/migrations/0001_repository_platform.sql",
  import.meta.url,
);
const liveDatabases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of liveDatabases.splice(0)) database.close();
});

describe("D1BuildStore against the repository SQLite schema", () => {
  it("writes the fenced build report audit event with a null request ID", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON;");
    database.exec(readFileSync(schemaUrl, "utf8"));
    liveDatabases.push(database);
    const store = new D1BuildStore(new SqliteD1Database(database));
    const input = makeBuildInput();
    const key = await buildKey(input);
    const buildId = "build-audit-test";
    database
      .prepare(
        `INSERT INTO builds (build_id, build_key, build_input_json, status, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', ?, ?)`,
      )
      .run(buildId, key, canonicalBuildInput(input), 100, 100);

    const claim = await store.claimNext({
      workerId: "worker-audit-test",
      attemptId: "attempt-audit-test",
      leaseToken: "lease-token-audit-test-000000000000",
      now: 101,
      leaseSeconds: 60,
    });
    expect(claim).not.toBeNull();
    if (!claim) throw new Error("expected the pending build to be claimed");

    const reportDigest = `sha256:${"f".repeat(64)}`;
    const result = await store.recordReport({
      request: {
        buildId: claim.buildId,
        attemptId: claim.attemptId,
        leaseEpoch: claim.leaseEpoch,
        leaseToken: claim.leaseToken,
        workerId: "worker-audit-test",
        sequence: 1,
        buildKey: claim.buildKey,
        result: {
          kind: "failed",
          code: "BUILD_FAILED",
          message: "test failure",
          retryable: false,
        },
      },
      serverNow: 102,
      reportDigest,
      artifact: null,
    });

    expect(result).toEqual({ accepted: true, duplicate: false });
    const audit = database
      .prepare("SELECT * FROM audit_events WHERE event_id = ?")
      .get(`build.report:${buildId}:1:1`) as Record<string, unknown> | undefined;
    expect(audit).toMatchObject({
      event_id: `build.report:${buildId}:1:1`,
      repository_id: null,
      instance_id: null,
      operation_id: null,
      actor_id: "worker-audit-test",
      actor_kind: "build-worker",
      action: "build.reported",
      outcome: "failed",
      request_id: null,
      occurred_at: 102,
    });
    expect(JSON.parse(String(audit?.metadata_json))).toEqual({
      buildKey: key,
      attemptId: "attempt-audit-test",
      leaseEpoch: 1,
      sequence: 1,
      admitted: false,
    });
    expect(
      database
        .prepare("SELECT report_sequence, last_report_digest FROM builds WHERE build_id = ?")
        .get(buildId),
    ).toEqual({ report_sequence: 1, last_report_digest: reportDigest });
  });
});

function makeBuildInput(): BuildInput {
  return {
    contractVersion: "scriptorium-build/v1",
    producerRevision: "a".repeat(40),
    runtimeBaseDigest: digest("1"),
    buildKitDigest: digest("2"),
    recipeDigest: digest("3"),
    sourceDigest: digest("4"),
    lockDigest: digest("5"),
    requestedModules: ["core"],
    resolvedModules: [{ id: "core", version: "1.0.0", artifactDigest: digest("6") }],
    platform: "linux/amd64",
    options: {},
  };
}

function digest(seed: string): `sha256:${string}` {
  return `sha256:${seed.repeat(64)}`;
}

class SqliteD1Database implements D1Database {
  constructor(private readonly database: DatabaseSync) {}

  prepare(query: string): D1PreparedStatement {
    return new SqliteD1Statement(this.database, query, []);
  }

  async batch<T = unknown>(
    statements: readonly D1PreparedStatement[],
  ): Promise<readonly D1Result<T>[]> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results: D1Result<T>[] = [];
      for (const statement of statements) results.push(await statement.run<T>());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
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
    const result = this.database.prepare(this.query).run(...this.values);
    return { results: [], success: true, meta: { changes: Number(result.changes) } };
  }
}

function sqlInput(value: string | number | null | ArrayBuffer | Uint8Array): SQLInputValue {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return value;
}
