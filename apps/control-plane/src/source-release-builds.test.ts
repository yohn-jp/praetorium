import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { D1Database, D1PreparedStatement, D1Result } from "@praetorium/persistence/d1";
import {
  canonicalSourceProof,
  SOURCE_PRODUCER_REQUEST_MAX_BYTES,
  SOURCE_PRODUCER_RESULT_MAX_BYTES,
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
  return {
    statement: {
      schemaVersion: 1,
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
      catalogDigest: await sourceProofDigest(catalog),
      runtimeMetadataDigest: await sourceProofDigest(runtimeMetadata),
    },
    signature: { algorithm: "Ed25519", keyId: "test-builder", signature: "dGVzdA==" },
    catalog,
    runtimeMetadata,
  };
}

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
        expect(publicSourceJob((await h.queue.byId(claim.job_id))!).retryable).toBe(false);
        await expect(h.queue.retry(created.job.id, {
          ...JOB, expectedRevision: 0, idempotencyKey: `retry-invalid-proof-${code}`,
        }, ACTOR)).rejects.toBeInstanceOf(SourceRetryConflict);
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
    expect(await current.json()).toMatchObject({ job: {
      id: created.job.id, sourceId: JOB.sourceId, releaseId: JOB.githubReleaseId,
      tag: JOB.sourceTag, commit: JOB.sourceRevision, version: JOB.releaseVersion,
      revision: 0, state: "failed", retryable: true,
    } });
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
});
