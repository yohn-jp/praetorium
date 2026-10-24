import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { D1Database, D1PreparedStatement, D1Result } from "@praetorium/persistence/d1";
import {
  canonicalSourceProof,
  SOURCE_DIAGNOSTIC_RETENTION_MS,
  SOURCE_PRODUCER_REQUEST_MAX_BYTES,
  SOURCE_PRODUCER_RESULT_MAX_BYTES,
  SourceProducerResultSchema,
  SourceBuildDetailSchema,
  sourceProducerResultByteLength,
  sourceProofDigest,
} from "@praetorium/contracts";
import catalogFixture from "../../../plugins/scriptorium/test/fixtures/build-catalog.v1.fixture.json" with { type: "json" };
import {
  createSourceReleaseOperatorRoutes,
  createSourceReleaseWorkerRoutes,
  D1SourceReleaseBuildQueue,
  publicSourceJob,
  SourceRevisionConflict,
  SourceRetryConflict,
  type SourceJobInput,
} from "./source-release-builds.js";
import { SourceProofVerificationError } from "./source-producer-verifier.js";
import { parseBuildCursor } from "./source-build-list.js";

const JOB: SourceJobInput = {
  sourceId: "scriptorium",
  githubReleaseId: 416422590,
  sourceTag: "v0.2.1",
  sourceRevision: "a".repeat(40),
  releaseVersion: "0.2.1",
};
const ACTOR = "71";
const SOURCE_WORKER = "source-worker-1";
const SOURCE_TOKEN = "x".repeat(32);
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

async function sourceResult(jobId: string, extraUnicodePathChars = 0) {
  const catalog = {
    ...catalogFixture,
    producerRevision: JOB.sourceRevision,
    runtimeBaseDigest: DIGEST_A,
    buildKitDigest: DIGEST_B,
  };
  const runtimeMetadata = {
    contractVersion: "scriptorium-platform/v1",
    producerRevision: JOB.sourceRevision,
    listener: { port: 3000 },
    paths: {
      liveness: `/healthz${"é".repeat(extraUnicodePathChars)}`,
      readiness: "/readyz", metadata: "/metadata",
      shutdown: "/shutdown", status: "/api/platform/v1/status",
      quiesce: "/api/platform/v1/quiesce", resume: "/api/platform/v1/resume",
    },
    shutdownTimeoutSeconds: 25,
  } as const;
  return SourceProducerResultSchema.parse({
    statement: {
      schemaVersion: 3,
      jobId,
      githubReleaseId: JOB.githubReleaseId,
      sourceId: JOB.sourceId,
      sourceRepository: "yohn-jp/scriptorium",
      sourceTag: JOB.sourceTag,
      sourceRevision: JOB.sourceRevision,
      releaseVersion: JOB.releaseVersion,
      imageRepository: "ghcr.io/yohn-jp/praetorium/scriptorium-producer",
      runtimeBaseDigest: DIGEST_A,
      buildKitDigest: DIGEST_B,
      nodeImage:"docker.io/library/node@"+DIGEST_A,buildEnvironmentDigest:DIGEST_B,
      resolverDigest:DIGEST_A,resolverProvenanceDigest:DIGEST_B,
      catalogDigest: await sourceProofDigest(catalog),
      runtimeMetadataDigest: await sourceProofDigest(runtimeMetadata),
    },
    signature: { algorithm: "Ed25519", keyId: "test-builder", signature: "dGVzdA==" },
    catalog,
    runtimeMetadata,
    resolver:{producerRevision:JOB.sourceRevision,resolverRevision:DIGEST_A,contractVersion:"scriptorium-build/v1",provenanceDigest:DIGEST_B},
  });
}

class SQLiteD1 implements D1Database {
  readonly database = new DatabaseSync(":memory:");

  constructor() {
    this.database.exec(readFileSync(new URL("../migrations/0001_repository_platform.sql", import.meta.url), "utf8"));
    this.database.exec(readFileSync(new URL("../migrations/0004_source_release_builds.sql", import.meta.url), "utf8"));
    this.database.exec(readFileSync(new URL("../migrations/0007_source_release_recovery.sql", import.meta.url), "utf8"));
    this.database.exec(readFileSync(new URL("../migrations/0008_source_build_diagnostics.sql", import.meta.url), "utf8"));
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
    }, ACTOR)).rejects.toBeInstanceOf(SourceRetryConflict);
    await expect(h.queue.retry(created.job.id, {
      ...JOB,
      sourceRevision: "b".repeat(40),
      expectedRevision: created.job.revision,
      idempotencyKey: "retry-moved-tag",
    }, ACTOR)).rejects.toBeInstanceOf(SourceRevisionConflict);
    await expect(h.queue.retry(created.job.id, {
      ...JOB,
      expectedRevision: 1,
      idempotencyKey: "retry-issue-31-1",
    }, ACTOR)).rejects.toMatchObject({ reason: "idempotency_key_reused" });

    const next = await h.queue.claim("worker-1", 30);
    expect(next).toMatchObject({ attempt: 1, lease_epoch: claimed.lease_epoch + 1 });
    expect(await h.queue.retry(created.job.id, {
      ...JOB,
      expectedRevision: created.job.revision,
      idempotencyKey: "retry-issue-31-1",
    }, ACTOR)).toMatchObject({ duplicate: true, job: { state: "building", attempt: 1, revision: 1 } });
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

  it("accepts the worker's 15-second lease through claim and heartbeat, while rejecting 14 seconds", async () => {
    const h = harness();
    await Promise.all(Array.from({ length: 2 }, (_, index) => h.queue.enqueue({
      ...JOB,
      githubReleaseId: JOB.githubReleaseId + index,
    }, ACTOR)));
    const app = createSourceReleaseWorkerRoutes({
      queue: h.queue,
      workerId: SOURCE_WORKER,
      serviceToken: SOURCE_TOKEN,
    });
    const headers = {
      Authorization: `Bearer ${SOURCE_TOKEN}`,
      "content-type": "application/json",
    };
    const claimedResponse = await app.request("/claim", {
      method: "POST", headers,
      body: JSON.stringify({ workerId: SOURCE_WORKER, leaseSeconds: 15 }),
    });
    expect(claimedResponse.status).toBe(200);
    const { job } = await claimedResponse.json() as { job: Awaited<ReturnType<typeof h.queue.claim>> };
    if (!job) throw new Error("expected a 15-second source lease");

    const heartbeat = await app.request(`/${job.job_id}/heartbeat`, {
      method: "POST", headers,
      body: JSON.stringify({
        workerId: SOURCE_WORKER, leaseToken: job.lease_token,
        leaseEpoch: job.lease_epoch, leaseSeconds: 15,
      }),
    });
    expect(heartbeat.status).toBe(200);
    expect(await heartbeat.json()).toEqual({ accepted: true });

    const claimed29 = await app.request("/claim", {
      method: "POST", headers,
      body: JSON.stringify({ workerId: SOURCE_WORKER, leaseSeconds: 29 }),
    });
    expect(claimed29.status).toBe(200);
    const rejected14 = await app.request("/claim", {
      method: "POST", headers,
      body: JSON.stringify({ workerId: SOURCE_WORKER, leaseSeconds: 14 }),
    });
    expect(rejected14.status).toBe(400);
    const rejectedHeartbeat = await app.request(`/${job.job_id}/heartbeat`, {
      method: "POST", headers,
      body: JSON.stringify({
        workerId: SOURCE_WORKER, leaseToken: job.lease_token,
        leaseEpoch: job.lease_epoch, leaseSeconds: 14,
      }),
    });
    expect(rejectedHeartbeat.status).toBe(400);
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

  it("claims one Produced row at a time so later rows do not lose their lease while it is processed", async () => {
    const h = harness();
    const jobs = await Promise.all(Array.from({ length: 2 }, (_, index) => h.queue.enqueue({
      ...JOB,
      githubReleaseId: JOB.githubReleaseId + index,
    }, ACTOR)));
    for (const [index, item] of jobs.entries()) {
      h.db.database.prepare(
        "UPDATE source_release_builds SET state='produced',result_json='{}',created_at=? WHERE job_id=?",
      ).run(index, item.job.id);
    }

    const first = (await h.queue.claimProduced(1, 60_000))[0];
    expect(first?.job_id).toBe(jobs[0]!.job.id);
    expect(first?.admission_attempt).toBe(1);
    expect(await h.queue.byId(jobs[1]!.job.id)).toMatchObject({
      state: "produced", admission_attempt: 0, next_attempt_at: null,
    });

    expect(await h.queue.markAdmitted(first!.job_id, "admitted-first", first!.admission_attempt)).toBe(true);
    h.advance(60_001);
    const second = (await h.queue.claimProduced(1, 60_000))[0];
    expect(second).toMatchObject({ job_id: jobs[1]!.job.id, admission_attempt: 1 });
  });

  it("fences admission outcomes after the claimed Produced lease expires", async () => {
    const h = harness();
    const created = await h.queue.enqueue(JOB, ACTOR);
    h.db.database.prepare(
      "UPDATE source_release_builds SET state='produced',result_json='{}' WHERE job_id=?",
    ).run(created.job.id);
    const claim = (await h.queue.claimProduced(1, 60_000))[0];
    if (!claim) throw new Error("expected a claimed Produced result");
    h.advance(60_001);

    expect(await h.queue.markAdmitted(claim.job_id, "stale-release", claim.admission_attempt)).toBe(false);
    expect(await h.queue.rejectProduced(claim.job_id, "ADMISSION_DENIED", claim.admission_attempt)).toBe(false);
    expect(await h.queue.deferProduced(claim.job_id, claim.admission_attempt)).toBe(false);
    expect(await h.queue.byId(claim.job_id)).toMatchObject({
      state: "produced", admission_attempt: 1, next_attempt_at: claim.next_attempt_at,
      admitted_release_id: null,
    });
  });

  it("retries admission exhaustion by re-verifying the same proof without rebuilding or admitting it", async () => {
    const h = harness();
    const created = await h.queue.enqueue(JOB, ACTOR);
    const proof = await sourceResult(created.job.id);
    const proofJson = canonicalSourceProof(proof);
    h.db.database.prepare(
      `UPDATE source_release_builds SET state='produced',attempt=2,lease_epoch=7,
         admission_attempt=4,result_json=?,created_at=0 WHERE job_id=?`,
    ).run(proofJson, created.job.id);
    const finalAttempt = (await h.queue.claimProduced(1, 60_000))[0];
    expect(finalAttempt).toMatchObject({ job_id: created.job.id, admission_attempt: 5 });
    expect(await h.queue.deferProduced(created.job.id, finalAttempt!.admission_attempt)).toBe(true);
    const exhausted = await h.queue.byId(created.job.id);
    expect(exhausted).toMatchObject({
      state: "failed", attempt: 2, revision: 0, lease_epoch: 7,
      failure_code: "SOURCE_ADMISSION_RETRIES_EXHAUSTED", result_json: proofJson,
    });
    expect(publicSourceJob(exhausted!).retryable).toBe(true);

    const retryInput = { ...JOB, expectedRevision: 0, idempotencyKey: "retry-admission-outage" };
    const retried = await h.queue.retry(created.job.id, retryInput, ACTOR);
    expect(retried).toMatchObject({
      duplicate: false,
      job: { state: "produced", attempt: 2, revision: 1, retryable: false },
    });
    const resumed = await h.queue.byId(created.job.id);
    expect(resumed).toMatchObject({
      state: "produced", attempt: 2, revision: 1, lease_epoch: 7,
      admission_attempt: 0, next_attempt_at: null, failure_code: null,
      result_json: proofJson, admitted_release_id: null,
    });
    expect(h.db.database.prepare(
      "SELECT metadata_json FROM audit_events WHERE action='source-release-build.retried'",
    ).get()).toEqual({
      metadata_json: JSON.stringify({
        jobId: created.job.id, sourceId: JOB.sourceId, githubReleaseId: JOB.githubReleaseId,
        sourceTag: JOB.sourceTag, sourceRevision: JOB.sourceRevision,
        expectedRevision: 0, revision: 1, state: "produced", retryMode: "reverify_produced_result",
      }),
    });

    const replay = await h.queue.retry(created.job.id, retryInput, ACTOR);
    expect(replay).toMatchObject({ duplicate: true, job: { state: "produced", revision: 1 } });
    await expect(h.queue.retry(created.job.id, {
      ...JOB, expectedRevision: 0, idempotencyKey: "retry-admission-competing-key",
    }, ACTOR)).rejects.toMatchObject({ reason: "stale_or_ineligible" });

    const verifyAgain = (await h.queue.claimProduced(1, 60_000))[0];
    expect(verifyAgain).toMatchObject({ job_id: created.job.id, admission_attempt: 1, result_json: proofJson });
    expect(await h.queue.byId(created.job.id)).toMatchObject({ state: "produced", admitted_release_id: null });
    expect(await h.queue.markAdmitted(created.job.id, "canonical-admission", verifyAgain!.admission_attempt)).toBe(true);
    expect(await h.queue.retry(created.job.id, retryInput, ACTOR)).toMatchObject({
      duplicate: true, job: { state: "admitted", admittedReleaseId: "canonical-admission" },
    });
    expect(h.db.database.prepare(
      "SELECT count(*) AS count FROM idempotency_records WHERE response_kind='source-release-build-retry'",
    ).get()).toEqual({ count: 1 });
    expect(h.db.database.prepare(
      "SELECT count(*) AS count FROM audit_events WHERE action='source-release-build.retried'",
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

  it("terminalizes permanent proof failures and leaves retryable verification failures leased", async () => {
    const cases = [
      { retryable: false, code: "SOURCE_VERIFICATION_FAILED" as const },
      { retryable: false, code: "SOURCE_CHANGED" as const },
      { retryable: true, code: "SOURCE_VERIFICATION_FAILED" as const },
    ];
    for (const { retryable, code } of cases) {
      const h = harness();
      const created = await h.queue.enqueue(JOB, ACTOR);
      const claim = await h.queue.claim(SOURCE_WORKER, 30);
      if (!claim) throw new Error("expected a source lease");
      const app = createSourceReleaseWorkerRoutes({
        queue: h.queue,
        workerId: SOURCE_WORKER,
        serviceToken: SOURCE_TOKEN,
        verifyProduced: async () => {
          throw new SourceProofVerificationError(retryable, code);
        },
      });
      const response = await app.request(`/${claim.job_id}/produced`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SOURCE_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          workerId: SOURCE_WORKER,
          leaseToken: claim.lease_token,
          leaseEpoch: claim.lease_epoch,
          result: await sourceResult(claim.job_id),
        }),
      });
      expect(response.status).toBe(retryable ? 503 : 422);
      if (retryable) {
        expect(await h.queue.byId(claim.job_id)).toMatchObject({ state: "building", attempt: 1 });
      } else {
        expect(await h.queue.byId(claim.job_id)).toMatchObject({
          state: "failed", failure_code: code, lease_token: null,
        });
        const retry = h.queue.retry(created.job.id, {
          ...JOB, expectedRevision: 0, idempotencyKey: `retry-invalid-proof-${code}`,
        }, ACTOR);
        if (code === "SOURCE_CHANGED") {
          await expect(retry).rejects.toBeInstanceOf(SourceRetryConflict);
        } else {
          // An explicit admin retry rebuilds from the immutable source; the
          // rejected proof is never reused or admitted and no automatic retry runs.
          await expect(retry).resolves.toMatchObject({job:{state:"queued",revision:1}});
          expect(await h.queue.byId(claim.job_id)).toMatchObject({
            attempt:0,result_json:null,admitted_release_id:null,
          });
          const next = await h.queue.claim(SOURCE_WORKER,30);
          expect(next?.lease_epoch).toBeGreaterThan(claim.lease_epoch);
        }
      }
    }
  });

  it("rejects a UTF-8-expanded Source proof before verification or database access", async () => {
    const h = harness();
    const created = await h.queue.enqueue(JOB, ACTOR);
    const claim = await h.queue.claim(SOURCE_WORKER, 30);
    if (!claim) throw new Error("expected a source lease");
    const oversized = await sourceResult(claim.job_id, 33_000);
    const jsonResult = JSON.stringify(oversized);
    const requestBody = JSON.stringify({
      workerId: SOURCE_WORKER,
      leaseToken: claim.lease_token,
      leaseEpoch: claim.lease_epoch,
      result: oversized,
    });
    expect(jsonResult.length).toBeLessThan(SOURCE_PRODUCER_RESULT_MAX_BYTES);
    expect(sourceProducerResultByteLength(oversized)).toBeGreaterThan(SOURCE_PRODUCER_RESULT_MAX_BYTES);
    expect(new TextEncoder().encode(requestBody).byteLength).toBeLessThan(SOURCE_PRODUCER_REQUEST_MAX_BYTES);

    const prepare = vi.spyOn(h.db, "prepare");
    const verifyProduced = vi.fn(async () => undefined);
    const app = createSourceReleaseWorkerRoutes({
      queue: h.queue,
      workerId: SOURCE_WORKER,
      serviceToken: SOURCE_TOKEN,
      verifyProduced,
    });
    const response = await app.request(`/${claim.job_id}/produced`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SOURCE_TOKEN}`, "content-type": "application/json" },
      body: requestBody,
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: { code: "REQUEST_TOO_LARGE" } });
    expect(prepare).not.toHaveBeenCalled();
    expect(verifyProduced).not.toHaveBeenCalled();

    await expect(h.queue.produced(claim.job_id, {
      workerId: claim.lease_worker!,
      leaseToken: claim.lease_token!,
      leaseEpoch: claim.lease_epoch,
      result: oversized,
    })).rejects.toThrow("Source release evidence exceeds bound");
    expect(await h.queue.byId(created.job.id)).toMatchObject({
      state: "building", result_json: null, lease_epoch: claim.lease_epoch,
    });
  });

  it("returns strict detail for a pre-diagnostics failure without inventing attempt evidence", async () => {
    const h = harness();
    // Identity/state read from production D1; the legacy deployed handler returned only {job}.
    // This is a local regression fixture, not an authenticated production response capture.
    const jobId = "sr_730c616f-329c-4d2f-aabb-d143eaa2db01";
    const input: SourceJobInput = {
      sourceId: "scriptorium", githubReleaseId: 422035682,
      sourceTag: "v0.3.4", sourceRevision: "588eddcfff20fa2fc76aa8eae54c9551e0c6048b",
      releaseVersion: "0.3.4",
    };
    const created = await h.queue.enqueue(input, ACTOR);
    h.db.database.prepare(
      `UPDATE source_release_builds SET job_id=?,state='failed',attempt=1,lease_epoch=1,
         failure_code='SOURCE_BUILD_FAILED' WHERE job_id=?`,
    ).run(jobId, created.job.id);
    const app = createSourceReleaseOperatorRoutes({ queue: h.queue, operatorActorId: ACTOR });
    const response = await app.request(`/${jobId}?limit=10`, {
      headers: { "X-Praetorium-Admin-Actor": ACTOR },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(SourceBuildDetailSchema.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      job: {
        id: jobId, sourceId: input.sourceId, releaseId: input.githubReleaseId,
        tag: input.sourceTag, commit: input.sourceRevision, version: input.releaseVersion,
        state: "failed", attempt: 1, revision: 0, error: "SOURCE_BUILD_FAILED",
        admittedReleaseId: null, retryable: true,
      },
      attempts: [], nextCursor: null, evidence: "not_recorded",
    });
    const legacy = SourceBuildDetailSchema.safeParse({ job: body.job });
    expect(legacy.success).toBe(false);
    if (legacy.success) throw new Error("Legacy detail must not satisfy the strict contract");
    expect(legacy.error.issues.map(issue => issue.path)).toEqual([
      ["attempts"], ["nextCursor"], ["evidence"],
    ]);
    expect(h.db.database.prepare(
      "SELECT count(*) AS count FROM source_release_build_attempts WHERE job_id=?",
    ).get(jobId)).toEqual({ count: 0 });
    expect((await h.queue.byId(jobId))?.revision).toBe(0);
  });

  it("round-trips captured production detail and pages recorded and legacy evidence separately", async () => {
    const captured = SourceBuildDetailSchema.parse(JSON.parse(readFileSync(new URL(
      "../test/fixtures/source-build-detail-production.fixture.json", import.meta.url,
    ), "utf8")));
    const latest = captured.attempts[0]!;
    const h = harness(latest.finishedAt!);
    const job = captured.job;
    const created = await h.queue.enqueue({
      sourceId: "scriptorium", githubReleaseId: job.releaseId, sourceTag: job.tag,
      sourceRevision: job.commit, releaseVersion: job.version,
    }, ACTOR);
    h.db.database.prepare(
      `UPDATE source_release_builds SET job_id=?,state=?,attempt=?,revision=?,lease_epoch=?,
         failure_code=?,admitted_release_id=? WHERE job_id=?`,
    ).run(job.id, job.state, job.attempt, job.revision, latest.leaseEpoch,
      job.error, job.admittedReleaseId, created.job.id);
    const insert = h.db.database.prepare(
      `INSERT INTO source_release_build_attempts
         (job_id,lease_epoch,attempt,revision,state,stage,started_at,finished_at,
          failure_code,diagnostic_json,evidence_expires_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const a of captured.attempts) {
      insert.run(job.id, a.leaseEpoch, a.attempt, a.revision, a.state, a.stage,
        a.startedAt, a.finishedAt, a.failureCode,
        a.diagnostic === null ? null : JSON.stringify(a.diagnostic), a.expiresAt);
    }
    const app = createSourceReleaseOperatorRoutes({ queue: h.queue, operatorActorId: ACTOR });
    const headers = { "X-Praetorium-Admin-Actor": ACTOR };
    const full = await app.request(`/${job.id}?limit=10`, { headers });
    expect(full.status).toBe(200);
    expect(SourceBuildDetailSchema.parse(await full.json())).toEqual(captured);
    const first = await app.request(`/${job.id}?limit=1`, { headers });
    expect(SourceBuildDetailSchema.parse(await first.json())).toEqual({
      job, attempts: [latest], nextCursor: "3", evidence: "available",
    });
    const older = await app.request(`/${job.id}?limit=10&cursor=3`, { headers });
    expect(SourceBuildDetailSchema.parse(await older.json())).toEqual({
      job, attempts: captured.attempts.slice(1), nextCursor: null, evidence: "not_recorded",
    });
  });

  it("serves the immutable retry identity and explicit retry through the operator route", async () => {
    const h = harness();
    const created = await h.queue.enqueue(JOB, ACTOR);
    const claim = await h.queue.claim("worker-1", 30);
    if (!claim) throw new Error("expected a source lease");
    await h.queue.fail(claim.job_id, {
      workerId: claim.lease_worker!, leaseToken: claim.lease_token!,
      leaseEpoch: claim.lease_epoch, code: "SOURCE_BUILD_FAILED",
    });
    const app = createSourceReleaseOperatorRoutes({ queue: h.queue, operatorActorId: ACTOR });
    const headers = { "X-Praetorium-Admin-Actor": ACTOR };
    const current = await app.request(`/${created.job.id}`, { headers });
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({
      job: {
        id: created.job.id, sourceId: JOB.sourceId, releaseId: JOB.githubReleaseId,
        tag: JOB.sourceTag, commit: JOB.sourceRevision, version: JOB.releaseVersion,
        revision: 0, state: "failed", retryable: true,
      },
      attempts: [{state:"failed",stage:"unknown",evidence:"not_recorded",diagnostic:null}],
      evidence: "not_recorded", nextCursor: null,
    });
    const retryInput = {
      ...JOB, expectedRevision: 0, idempotencyKey: "route-retry-1",
    };
    const accepted = await app.request(`/${created.job.id}/retry`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(retryInput),
    });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({
      duplicate: false, job: { state: "queued", revision: 1, retryable: false },
    });
    const replay = await app.request(`/${created.job.id}/retry`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(retryInput),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ duplicate: true, job: { revision: 1 } });
    expect((await app.request(`/${created.job.id}`)).status).toBe(403);
  });

  it("stores only sanitized, lease-fenced attempt diagnostics and expires their evidence after 30 days", async () => {
    const h = harness();
    const created = await h.queue.enqueue(JOB, ACTOR);
    const claim = await h.queue.claim(SOURCE_WORKER, 30);
    if (!claim) throw new Error("expected a source lease");
    const diagnostic = {
      stage: "buildkit" as const,
      reason: "build_failed" as const,
      summary: "token=summary-secret",
      excerpt: [
        "npm ERR! code ERESOLVE",
        "Authorization: Bearer header-secret",
        "ENV REGISTRY_TOKEN=environment-secret",
        "RUN npm install --registry=https://user:password@example.invalid",
        "ERROR: https://user:password@example.invalid/registry failed",
        "-----BEGIN PRIVATE KEY-----",
        "private-key-secret",
        "-----END PRIVATE KEY-----",
      ].join("\n"),
      truncated: false,
    };
    expect(await h.queue.reportDiagnostic(claim.job_id, {
      workerId: claim.lease_worker!, leaseToken: claim.lease_token!,
      leaseEpoch: claim.lease_epoch, diagnostic,
    })).toBe(true);
    const accepted = await h.queue.fail(claim.job_id, {
      workerId: claim.lease_worker!, leaseToken: claim.lease_token!,
      leaseEpoch: claim.lease_epoch, code: "SOURCE_BUILD_FAILED", diagnostic,
    });
    expect(accepted).toBe(true);
    expect(await h.queue.diagnosticRecorded(claim.job_id, claim.lease_epoch)).toBe(true);
    const route = createSourceReleaseWorkerRoutes({
      queue: h.queue, workerId: SOURCE_WORKER, serviceToken: SOURCE_TOKEN,
    });
    const duplicate = await route.request(`/${claim.job_id}/fail`, {
      method: "POST", headers: {
        Authorization: `Bearer ${SOURCE_TOKEN}`, "content-type": "application/json",
      }, body: JSON.stringify({
        workerId: claim.lease_worker, leaseToken: claim.lease_token,
        leaseEpoch: claim.lease_epoch, code: "SOURCE_BUILD_FAILED", diagnostic,
      }),
    });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual({ accepted: true, diagnosticRecorded: true });

    const raw = h.db.database.prepare(
      "SELECT state,stage,failure_code,diagnostic_json,evidence_expires_at FROM source_release_build_attempts WHERE job_id=? AND lease_epoch=?",
    ).get(created.job.id, claim.lease_epoch) as {
      state: string; stage: string; failure_code: string|null;
      diagnostic_json: string|null; evidence_expires_at: number|null;
    };
    expect(raw).toMatchObject({
      state: "failed", stage: "buildkit", failure_code: "SOURCE_BUILD_FAILED",
      evidence_expires_at: h.now() + SOURCE_DIAGNOSTIC_RETENTION_MS,
    });
    expect(raw.diagnostic_json).not.toContain("summary-secret");
    expect(raw.diagnostic_json).not.toContain("header-secret");
    expect(raw.diagnostic_json).not.toContain("environment-secret");
    expect(raw.diagnostic_json).not.toContain("password");
    expect(raw.diagnostic_json).not.toContain("private-key-secret");
    expect(JSON.parse(raw.diagnostic_json!)).toMatchObject({
      stage: "buildkit", reason: "build_failed",
      summary: "BuildKit reported a build failure. Inspect the sanitized diagnostic excerpt when available.",
      excerpt: "npm ERR! code ERESOLVE", truncated: true,
    });

    const details = await h.queue.detail(created.job.id);
    expect(details).toMatchObject({
      job: { state: "failed", error: "SOURCE_BUILD_FAILED" }, evidence: "available",
      attempts: [{
        attempt: 1, revision: 0, leaseEpoch: claim.lease_epoch,
        state: "failed", stage: "buildkit", failureCode: "SOURCE_BUILD_FAILED",
        evidence: "available", diagnostic: { excerpt: "npm ERR! code ERESOLVE" },
      }],
    });
    expect(JSON.stringify(details)).not.toMatch(/summary-secret|header-secret|environment-secret|password|private-key-secret/u);

    h.advance(SOURCE_DIAGNOSTIC_RETENTION_MS + 1);
    expect((await h.queue.detail(created.job.id))?.attempts[0]).toMatchObject({
      evidence: "expired", diagnostic: null,
    });
    expect(await h.queue.expireDiagnostics()).toBe(1);
    const expiredRow = h.db.database.prepare(
      "SELECT diagnostic_json,evidence_expires_at FROM source_release_build_attempts WHERE job_id=? AND lease_epoch=?",
    ).get(created.job.id, claim.lease_epoch) as {diagnostic_json:string|null;evidence_expires_at:number|null};
    expect(expiredRow).toMatchObject({diagnostic_json:null,evidence_expires_at:h.now()-1});
    expect(await h.queue.diagnosticRecorded(claim.job_id, claim.lease_epoch)).toBe(false);
  });

  it("records every claimed epoch and rejects a diagnostic callback from an expired lease", async () => {
    const h = harness();
    const created = await h.queue.enqueue(JOB, ACTOR);
    const first = await h.queue.claim("worker-first", 15);
    if (!first) throw new Error("expected first lease");
    expect(await h.queue.reportDiagnostic(first.job_id, {
      workerId: first.lease_worker!, leaseToken: first.lease_token!,
      leaseEpoch: first.lease_epoch,
      diagnostic: {
        stage: "source_checkout", reason: "stage_started", summary: "ignored",
        truncated: false,
      },
    })).toBe(true);
    h.advance(15_001);
    const second = await h.queue.claim("worker-second", 30);
    if (!second) throw new Error("expected replacement lease");
    expect(second.lease_epoch).toBe(first.lease_epoch + 1);
    expect(await h.queue.reportDiagnostic(first.job_id, {
      workerId: first.lease_worker!, leaseToken: first.lease_token!,
      leaseEpoch: first.lease_epoch,
      diagnostic: {
        stage: "buildkit", reason: "build_failed", summary: "stale",
        truncated: false,
      },
    })).toBe(false);
    const history = h.db.database.prepare(
      "SELECT lease_epoch,state,stage,started_at,finished_at FROM source_release_build_attempts WHERE job_id=? ORDER BY lease_epoch",
    ).all(created.job.id) as Array<Record<string, unknown>>;
    expect(history).toMatchObject([
      {lease_epoch:first.lease_epoch,state:"lease_expired",stage:"source_checkout",started_at:h.now()-15_001},
      {lease_epoch:second.lease_epoch,state:"building",stage:"unknown",finished_at:null},
    ]);
    expect((await h.queue.detail(created.job.id))?.attempts.map(attempt=>attempt.leaseEpoch))
      .toEqual([second.lease_epoch,first.lease_epoch]);
  });

  it("keeps a legacy failed row's known failure when retry snapshots it without inventing evidence", async () => {
    const h = harness();
    const created = await h.queue.enqueue(JOB, ACTOR);
    h.db.database.prepare(
      `UPDATE source_release_builds SET state='failed',attempt=1,lease_epoch=1,
        failure_code='SOURCE_BUILD_FAILED',updated_at=? WHERE job_id=?`,
    ).run(h.now(),created.job.id);
    expect(h.db.database.prepare(
      "SELECT count(*) AS count FROM source_release_build_attempts WHERE job_id=?",
    ).get(created.job.id)).toEqual({count:0});

    await h.queue.retry(created.job.id, {
      ...JOB, expectedRevision: 0, idempotencyKey: "retry-legacy-source-failure",
    }, ACTOR);
    const detail = await h.queue.detail(created.job.id);
    expect(detail).toMatchObject({
      job: {state:"queued",revision:1},
      evidence:"not_recorded",
      attempts:[{
        attempt:1,revision:0,leaseEpoch:1,state:"failed",stage:"unknown",
        startedAt:null,finishedAt:h.now(),failureCode:"SOURCE_BUILD_FAILED",
        evidence:"not_recorded",expiresAt:null,diagnostic:null,
      }],
    });
  });

  it("paginates source jobs and attempt history with stable bounded cursors", async () => {
    const h = harness();
    const jobs = await Promise.all(Array.from({length:41},(_,index)=>h.queue.enqueue({
      ...JOB,githubReleaseId:JOB.githubReleaseId+index,
    },ACTOR)));
    const first = await h.queue.list(40);
    expect(first.items).toHaveLength(40);
    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/u);
    const cursor = parseBuildCursor(first.nextCursor!, "recent", null);
    const second = await h.queue.list(40,cursor);
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items,...second.items].map(job=>job.id)).size).toBe(41);
    // An old registration that failed recently must appear on the first filtered page.
    h.db.database.prepare(
      "UPDATE source_release_builds SET state='failed',failure_code='SOURCE_BUILD_FAILED',updated_at=updated_at+100000 WHERE job_id=?",
    ).run(jobs[0]!.job.id);
    const operator=createSourceReleaseOperatorRoutes({queue:h.queue,operatorActorId:ACTOR});
    const headersList={"X-Praetorium-Admin-Actor":ACTOR};
    const failedPage=await operator.request("/?state=failed&sort=recent",{headers:headersList});
    expect(failedPage.status).toBe(200);
    const filtered=await failedPage.json() as {items:Array<{id:string;state:string}>};
    expect(filtered.items).toHaveLength(1);
    expect(filtered.items[0]?.id).toBe(jobs[0]!.job.id);
    expect((await operator.request("/?sort=state&cursor="+encodeURIComponent(first.nextCursor!),{headers:headersList})).status).toBe(400);
    expect((await operator.request("/?state=invalid",{headers:headersList})).status).toBe(400);

    const selected = jobs[0]!.job;
    const insertAttempt = h.db.database.prepare(
      `INSERT INTO source_release_build_attempts
         (job_id,lease_epoch,attempt,revision,state,stage,started_at,finished_at,
          failure_code,diagnostic_json,evidence_expires_at)
       VALUES (?, ?, 1, ?, 'failed', 'unknown', ?, ?, 'SOURCE_BUILD_FAILED', NULL, NULL)`,
    );
    for(let epoch=1;epoch<=30;epoch+=1)
      insertAttempt.run(selected.id,epoch,epoch-1,epoch,epoch+1);
    const app = createSourceReleaseOperatorRoutes({queue:h.queue,operatorActorId:ACTOR});
    const headers = {"X-Praetorium-Admin-Actor":ACTOR};
    const pageOne = await app.request(`/${selected.id}?limit=25`,{headers});
    const pageOneBody = await pageOne.json() as {attempts:Array<{leaseEpoch:number}>;nextCursor:string|null};
    expect(pageOne.status).toBe(200);
    expect(pageOneBody.attempts.map(attempt=>attempt.leaseEpoch)).toEqual(
      Array.from({length:25},(_,index)=>30-index),
    );
    expect(pageOneBody.nextCursor).toBe("6");
    const pageTwo = await app.request(`/${selected.id}?limit=25&cursor=6`,{headers});
    const pageTwoBody = await pageTwo.json() as {attempts:Array<{leaseEpoch:number}>;nextCursor:string|null};
    expect(pageTwoBody.attempts.map(attempt=>attempt.leaseEpoch)).toEqual([5,4,3,2,1]);
    expect(pageTwoBody.nextCursor).toBeNull();
    expect((await app.request(`/${selected.id}?limit=26`,{headers})).status).toBe(400);
    expect((await app.request(`/${selected.id}?cursor=not-an-epoch`,{headers})).status).toBe(400);
  });

  it("includes latest admitted Source as well as failed history in bounded overview attention", async () => {
    const h = harness();
    const failed = await h.queue.enqueue(JOB,ACTOR);
    h.db.database.prepare(
      `UPDATE source_release_builds SET state='failed',attempt=1,lease_epoch=1,
         failure_code='SOURCE_BUILD_FAILED' WHERE job_id=?`,
    ).run(failed.job.id);
    h.advance(1);
    const completed = await Promise.all(Array.from({length:41},(_,index)=>h.queue.enqueue({
      ...JOB,githubReleaseId:JOB.githubReleaseId+index+1,
    },ACTOR)));
    for(const item of completed)h.db.database.prepare(
      "UPDATE source_release_builds SET state='admitted',admitted_release_id=? WHERE job_id=?",
    ).run(`release-${item.job.id}`,item.job.id);

    const history=await h.queue.list(40);
    expect(history.items).toHaveLength(40);
    expect(history.items.some(job=>job.id===failed.job.id)).toBe(false);
    const attention=await h.queue.list(40,undefined,true);
    expect(attention.items).toHaveLength(2);
    expect(attention.items[0]).toMatchObject({id:failed.job.id,state:"failed"});
    expect(attention.items[1]).toMatchObject({sourceId:JOB.sourceId,state:"admitted"});
    expect(attention.nextCursor).toBeNull();

    const app=createSourceReleaseOperatorRoutes({queue:h.queue,operatorActorId:ACTOR});
    const response=await app.request("/?attention=1",{
      headers:{"X-Praetorium-Admin-Actor":ACTOR},
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({items:[{id:failed.job.id,state:"failed"},{state:"admitted"}],nextCursor:null});

    const failures = await Promise.all(Array.from({length:45},(_,index)=>h.queue.enqueue({
      ...JOB,githubReleaseId:JOB.githubReleaseId+100+index,
    },ACTOR)));
    for (const item of failures) h.db.database.prepare(
      "UPDATE source_release_builds SET state='failed',failure_code='SOURCE_BUILD_FAILED' WHERE job_id=?",
    ).run(item.job.id);
    const active = await h.queue.enqueue({...JOB,githubReleaseId:JOB.githubReleaseId+200},ACTOR);
    const visible = await h.queue.list(40,undefined,true);
    expect(visible.items.filter(job=>job.state==="failed")).toHaveLength(5);
    expect(visible.items).toContainEqual(expect.objectContaining({id:active.job.id,state:"queued"}));
  });
});
