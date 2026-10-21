import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { D1Database, D1PreparedStatement, D1Result } from "@praetorium/persistence/d1";
import { D1SourceReleaseBuildQueue, type SourceJobInput } from "./source-release-builds.js";

const JOB: SourceJobInput = {
  sourceId: "scriptorium",
  githubReleaseId: 416422590,
  sourceTag: "v0.2.1",
  sourceRevision: "a".repeat(40),
  releaseVersion: "0.2.1",
};
const ACTOR = "71";

class SQLiteD1 implements D1Database {
  readonly database = new DatabaseSync(":memory:");

  constructor() {
    this.database.exec(readFileSync(new URL("../migrations/0001_repository_platform.sql", import.meta.url), "utf8"));
    this.database.exec(readFileSync(new URL("../migrations/0004_source_release_builds.sql", import.meta.url), "utf8"));
    this.database.exec(readFileSync(new URL("../migrations/0007_source_release_recovery.sql", import.meta.url), "utf8"));
  }

  prepare(query: string): D1PreparedStatement {
    return new SQLiteD1Statement(query, this.database.prepare(query));
  }

  async batch<T = unknown>(statements: readonly D1PreparedStatement[]): Promise<readonly D1Result<T>[]> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results: D1Result<unknown>[] = [];
      for (const statement of statements) results.push(await (statement as SQLiteD1Statement).execute());
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

  constructor(private readonly query: string, private readonly statement: StatementSync) {}

  bind(...values: readonly (string | number | null | ArrayBuffer | Uint8Array)[]): D1PreparedStatement {
    this.values = values;
    return this;
  }

  private sqlValues(): SQLInputValue[] {
    return this.values.map((value) => value instanceof ArrayBuffer ? new Uint8Array(value) : value);
  }

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.sqlValues()) as T | undefined) ?? null;
  }

  async all<T>(): Promise<D1Result<T>> {
    const results = this.statement.all(...this.sqlValues()) as T[];
    return { results, meta: { changes: this.changeCount() } };
  }

  async run<T>(): Promise<D1Result<T>> {
    const result = this.statement.run(...this.sqlValues());
    return { results: [], meta: { changes: Number(result.changes) } };
  }

  async execute(): Promise<D1Result> {
    if (/\bRETURNING\b/iu.test(this.query) || /^\s*(SELECT|WITH)\b/iu.test(this.query)) {
      const results = this.statement.all(...this.sqlValues());
      return { results, meta: { changes: this.changeCount() } };
    }
    const result = this.statement.run(...this.sqlValues());
    return { results: [], meta: { changes: Number(result.changes) } };
  }

  private changeCount(): number {
    return Number((this.statement as unknown as { changes?: number }).changes ?? 0);
  }
}

const databases: SQLiteD1[] = [];
function harness(now = 1_800_000_000_000) {
  const db = new SQLiteD1();
  databases.push(db);
  let time = now;
  const queue = new D1SourceReleaseBuildQueue(db, () => time);
  return { db, queue, now: () => time, advance: (ms: number) => { time += ms; } };
}

afterEach(() => {
  databases.splice(0).forEach((db) => db.database.close());
});

describe("source Release build queue against migrated SQLite D1", () => {
  it("retries a failed unique release through a revision CAS and replays one receipt", async () => {
    const h = harness();
    const created = await h.queue.enqueue(JOB, ACTOR);
    const claimed = await h.queue.claim("worker-1", 30);
    if (!claimed) throw new Error("expected a claimed source build");
    const report = {
      workerId: claimed.lease_worker!,
      leaseToken: claimed.lease_token!,
      leaseEpoch: claimed.lease_epoch,
      code: "SOURCE_BUILD_FAILED" as const,
    };
    expect(await h.queue.fail(claimed.job_id, report)).toBe(true);
    expect((await h.queue.enqueue(JOB, ACTOR)).job.state).toBe("failed");

    const retry = await h.queue.retry(created.job.id, {
      ...JOB,
      expectedRevision: created.job.revision,
      idempotencyKey: "retry-issue-31-1",
    }, ACTOR);
    expect(retry).toMatchObject({ duplicate: false, job: { state: "queued", attempt: 0, revision: 1 } });
    expect(await h.queue.retry(created.job.id, {
      ...JOB,
      expectedRevision: created.job.revision,
      idempotencyKey: "retry-issue-31-1",
    }, ACTOR)).toMatchObject({ duplicate: true, job: { state: "queued", revision: 1 } });
    await expect(h.queue.retry(created.job.id, {
      ...JOB,
      expectedRevision: created.job.revision,
      idempotencyKey: "retry-issue-31-competing",
    }, ACTOR)).rejects.toMatchObject({ name: "SourceRetryConflict" });

    const next = await h.queue.claim("worker-1", 30);
    expect(next).toMatchObject({ attempt: 1, lease_epoch: claimed.lease_epoch + 1 });
    expect(h.db.database.prepare("SELECT count(*) AS count FROM source_release_builds").get()).toEqual({ count: 1 });
    expect(h.db.database.prepare("SELECT count(*) AS count FROM idempotency_records WHERE response_kind='source-release-build-retry'").get()).toEqual({ count: 1 });
    expect(h.db.database.prepare("SELECT count(*) AS count FROM audit_events WHERE action='source-release-build.retried'").get()).toEqual({ count: 1 });
  });

  it("terminalizes a third expired worker lease and rejects stale reports before explicit retry", async () => {
    const h = harness();
    const created = await h.queue.enqueue(JOB, ACTOR);
    let expired: Awaited<ReturnType<typeof h.queue.claim>>;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claim = await h.queue.claim(`worker-${attempt}`, 30);
      expect(claim?.attempt).toBe(attempt);
      expired = claim;
      h.advance(30_001);
    }
    expect(await h.queue.claim("worker-recovery", 30)).toBeNull();
    const terminal = await h.queue.byId(created.job.id);
    expect(terminal).toMatchObject({ state: "failed", attempt: 3, failure_code: "SOURCE_ATTEMPTS_EXHAUSTED", lease_worker: null, lease_token: null, lease_expires_at: null });
    expect(await h.queue.fail(expired!.job_id, {
      workerId: expired!.lease_worker!, leaseToken: expired!.lease_token!,
      leaseEpoch: expired!.lease_epoch, code: "SOURCE_BUILD_FAILED",
    })).toBe(false);

    const retried = await h.queue.retry(created.job.id, {
      ...JOB, expectedRevision: 0, idempotencyKey: "retry-expired-1",
    }, ACTOR);
    const reclaimed = await h.queue.claim("worker-recovered", 30);
    expect(retried.job).toMatchObject({ state: "queued", attempt: 0, revision: 1 });
    expect(reclaimed).toMatchObject({ attempt: 1, lease_epoch: expired!.lease_epoch + 1 });
  });

  it("pages due Produced rows past five deferred jobs and terminal-audits bounded exhaustion", async () => {
    const h = harness();
    const jobs = await Promise.all(Array.from({ length: 6 }, (_, index) => h.queue.enqueue({
      ...JOB,
      githubReleaseId: JOB.githubReleaseId + index,
    }, ACTOR)));
    for (const [index, item] of jobs.entries()) {
      h.db.database.prepare(
        "UPDATE source_release_builds SET state='produced',result_json='{}',created_at=? WHERE job_id=?",
      ).run(index, item.job.id);
    }

    const firstPage = await h.queue.claimProduced(5, 60_000);
    expect(firstPage).toHaveLength(5);
    for (const job of firstPage) await h.queue.deferProduced(job.job_id, job.admission_attempt);
    const secondPage = await h.queue.claimProduced(5, 60_000);
    expect(secondPage.map((job) => job.job_id)).toEqual([jobs[5]!.job.id]);

    const terminal = firstPage[0]!;
    h.db.database.prepare(
      "UPDATE source_release_builds SET admission_attempt=4,next_attempt_at=NULL WHERE job_id=?",
    ).run(terminal.job_id);
    const fifth = (await h.queue.claimProduced(1, 60_000))[0];
    expect(fifth).toMatchObject({ job_id: terminal.job_id, admission_attempt: 5 });
    await h.queue.deferProduced(fifth!.job_id, fifth!.admission_attempt);
    expect(await h.queue.byId(fifth!.job_id)).toMatchObject({
      state: "failed", failure_code: "SOURCE_ADMISSION_RETRIES_EXHAUSTED", next_attempt_at: null,
    });
    expect(h.db.database.prepare(
      "SELECT count(*) AS count FROM audit_events WHERE action='source-release-build.admission-exhausted'",
    ).get()).toEqual({ count: 1 });
  });

  it("accepts only exact duplicate terminal reports for the same attempt", async () => {
    const h = harness();
    const created = await h.queue.enqueue(JOB, ACTOR);
    const claim = await h.queue.claim("worker-1", 30);
    if (!claim) throw new Error("expected a source lease");
    const failure = {
      workerId: claim.lease_worker!, leaseToken: claim.lease_token!,
      leaseEpoch: claim.lease_epoch, code: "SOURCE_BUILD_FAILED" as const,
    };
    expect(await h.queue.fail(created.job.id, failure)).toBe(true);
    expect(await h.queue.fail(created.job.id, failure)).toBe(true);
    expect(await h.queue.fail(created.job.id, { ...failure, code: "SOURCE_VERIFICATION_FAILED" })).toBe(false);
  });
});
