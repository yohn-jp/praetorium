import { Hono } from "hono";
import { z } from "zod";
import type { D1Database } from "@praetorium/persistence/d1";
import { SourceProofVerificationError } from "./source-producer-verifier.js";
import { metadataFailureReason } from "./http-failure.js";
import {
  SourceProducerResultSchema,
  SOURCE_DIAGNOSTIC_REQUEST_MAX_BYTES,
  SOURCE_DIAGNOSTIC_RETENTION_MS,
  SOURCE_PRODUCER_RESULT_MAX_BYTES,
  SOURCE_PRODUCER_REQUEST_MAX_BYTES,
  SourceBuildDiagnosticSchema,
  sanitizeSourceDiagnostic,
  sourceProducerResultByteLength,
  readBoundedJson,
  RequestTooLargeError,
  canonicalSourceProof,
  sourceProofDigest,
  type SourceBuildAttempt,
  type SourceBuildDetail,
  type SourceBuildDiagnostic,
  type SourceBuildSummary,
  type SourceProducerResult,
} from "@praetorium/contracts";

const SHA = /^[0-9a-f]{40}$/u;
const SOURCE_TAG = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const ID = /^sr_[0-9a-f-]{36}$/u;
const WORKER = /^[a-zA-Z0-9_.:-]{1,128}$/u;
const MAX_ATTEMPTS = 3;
const MAX_ADMISSION_ATTEMPTS = 5;
const MAX_ADMISSION_PAGE = 25;
const ADMISSION_LEASE_MS = 5 * 60_000;
const ADMISSION_BACKOFF_MS = [5_000, 30_000, 120_000, 600_000, 3_600_000] as const;

const SourceIdentity = z.strictObject({
  sourceId: z.literal("scriptorium"),
  githubReleaseId: z.number().int().positive().safe(),
  sourceTag: z.string().regex(SOURCE_TAG).max(128),
  sourceRevision: z.string().regex(SHA),
  releaseVersion: z.string().regex(VERSION).max(128),
});
const NewJob = SourceIdentity.refine(x => x.sourceTag.replace(/^v/u,"") === x.releaseVersion);
const RetryRequest = SourceIdentity.extend({
  expectedRevision: z.number().int().nonnegative().safe(),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u),
}).refine(x => x.sourceTag.replace(/^v/u,"") === x.releaseVersion);
const LeaseRequest = z.strictObject({
  workerId: z.string().regex(WORKER),
  leaseSeconds: z.number().int().min(15).max(300),
});
const HeartbeatRequest = z.strictObject({
  workerId: z.string().regex(WORKER),
  leaseToken: z.string().uuid(),
  leaseEpoch: z.number().int().positive().safe(),
  leaseSeconds: z.number().int().min(15).max(300),
});
const FailureRequest = z.strictObject({
  workerId: z.string().regex(WORKER),
  leaseToken: z.string().uuid(),
  leaseEpoch: z.number().int().positive().safe(),
  code: z.enum(["SOURCE_UNAVAILABLE","SOURCE_CHANGED","SOURCE_BUILD_FAILED","SOURCE_VERIFICATION_FAILED","SOURCE_WORKER_UNAVAILABLE"]),
  diagnostic: SourceBuildDiagnosticSchema.optional(),
});
const DiagnosticReportRequest = z.strictObject({
  workerId: z.string().regex(WORKER),
  leaseToken: z.string().uuid(),
  leaseEpoch: z.number().int().positive().safe(),
  diagnostic: SourceBuildDiagnosticSchema,
});
export type SourceJobInput = z.infer<typeof NewJob>;

export interface SourceJob {
  job_id: string;
  source_id: string;
  github_release_id: number;
  source_repository: string;
  source_tag: string;
  source_revision: string;
  release_version: string;
  actor_id: string;
  state: "queued"|"building"|"produced"|"admitted"|"failed";
  attempt: number;
  revision: number;
  admission_attempt: number;
  next_attempt_at: number|null;
  lease_worker: string|null;
  lease_token: string|null;
  lease_epoch: number;
  lease_expires_at: number|null;
  failure_code: string|null;
  result_json: string|null;
  admitted_release_id: string|null;
  created_at: number;
  updated_at: number;
}
type PublicJob = SourceBuildSummary;
type SourceBuildAttemptRow = {
  job_id:string; lease_epoch:number; attempt:number; revision:number;
  state:SourceBuildAttempt["state"]; stage:SourceBuildAttempt["stage"];
  started_at:number|null; finished_at:number|null; failure_code:string|null;
  diagnostic_json:string|null; evidence_expires_at:number|null;
};
type SourceBuildListCursor = {createdAt:number;jobId:string};
export function publicSourceJob(job: SourceJob): PublicJob {
  return { id:job.job_id,sourceId:job.source_id,releaseId:job.github_release_id,
    tag:job.source_tag,commit:job.source_revision,version:job.release_version,
    state:job.state,attempt:job.attempt,revision:job.revision,error:job.failure_code,
    admittedReleaseId:job.admitted_release_id,
    retryable:job.state==="failed" && isRetryableSourceFailure(job.failure_code) };
}
function storedDiagnostic(value:SourceBuildDiagnostic):string {
  let safe=sanitizeSourceDiagnostic(SourceBuildDiagnosticSchema.parse(value));
  let encoded=JSON.stringify(safe);
  while(new TextEncoder().encode(encoded).byteLength>SOURCE_DIAGNOSTIC_REQUEST_MAX_BYTES && safe.excerpt) {
    const points=Array.from(safe.excerpt);
    points.splice(Math.max(0,points.length-256));
    const excerpt=points.join("");
    safe={
      stage:safe.stage,reason:safe.reason,summary:safe.summary,
      ...(excerpt?{excerpt}:{}),truncated:true,
    };
    encoded=JSON.stringify(safe);
  }
  if(new TextEncoder().encode(encoded).byteLength>SOURCE_DIAGNOSTIC_REQUEST_MAX_BYTES)
    throw new TypeError("Sanitized source diagnostic exceeds bound");
  return encoded;
}
function publicSourceBuildAttempt(row:SourceBuildAttemptRow,now:number):SourceBuildAttempt {
  const expired=row.evidence_expires_at!==null && row.evidence_expires_at<=now;
  let diagnostic:SourceBuildDiagnostic|null=null;
  if(row.diagnostic_json!==null && !expired) {
    try {
      diagnostic=sanitizeSourceDiagnostic(
        SourceBuildDiagnosticSchema.parse(JSON.parse(row.diagnostic_json)),
      );
    } catch {
      // Invalid stored evidence is never sent back to the operator.
      diagnostic=null;
    }
  }
  const evidence=diagnostic!==null?"available":expired?"expired":"not_recorded";
  return {
    id:`${row.job_id}:epoch:${row.lease_epoch}`,
    attempt:row.attempt,revision:row.revision,leaseEpoch:row.lease_epoch,
    state:row.state,stage:row.stage,startedAt:row.started_at,finishedAt:row.finished_at,
    failureCode:row.failure_code,evidence,
    expiresAt:evidence==="not_recorded"?null:row.evidence_expires_at,
    diagnostic,
  };
}
function encodeSourceBuildListCursor(cursor:SourceBuildListCursor):string {
  return `${cursor.createdAt}.${cursor.jobId}`;
}
function parseSourceBuildListCursor(value:string|undefined):SourceBuildListCursor|undefined {
  if(value===undefined)return undefined;
  if(value.length>128)throw new TypeError("Invalid source build cursor");
  const match=/^(0|[1-9][0-9]{0,15})\.(sr_[0-9a-f-]{36})$/u.exec(value);
  if(!match)throw new TypeError("Invalid source build cursor");
  const createdAt=Number(match[1]);
  if(!Number.isSafeInteger(createdAt))throw new TypeError("Invalid source build cursor");
  return {createdAt,jobId:match[2]!};
}
export class D1SourceReleaseBuildQueue {
  constructor(private readonly db:D1Database,private readonly now:()=>number=Date.now){}
  async enqueue(input:SourceJobInput,actorId:string):Promise<{job:PublicJob;duplicate:boolean}> {
    const checked=NewJob.parse(input);
    if(!/^[1-9][0-9]{0,15}$/u.test(actorId)) throw new TypeError("Invalid admin actor");
    const now=this.now();
    const id="sr_"+crypto.randomUUID();
    await this.db.prepare(
      `INSERT OR IGNORE INTO source_release_builds
       (job_id,source_id,github_release_id,source_repository,source_tag,
        source_revision,release_version,actor_id,state,created_at,updated_at)
       VALUES (?, ?, ?, 'yohn-jp/scriptorium', ?, ?, ?, ?, 'queued', ?, ?)`
    ).bind(id,checked.sourceId,checked.githubReleaseId,checked.sourceTag,
      checked.sourceRevision,checked.releaseVersion,actorId,now,now).run();
    const row=await this.db.prepare(
      "SELECT * FROM source_release_builds WHERE source_id=? AND github_release_id=?"
    ).bind(checked.sourceId,checked.githubReleaseId).first<SourceJob>();
    if(!row)throw new Error("Source build insert was not persisted");
    // A moved GitHub tag never aliases the prior release or queues a new build.
    if(row.source_revision!==checked.sourceRevision || row.source_tag!==checked.sourceTag ||
       row.release_version!==checked.releaseVersion)throw new SourceRevisionConflict();
    return {job:publicSourceJob(row),duplicate:row.job_id!==id};
  }
  async retry(jobId:string,input:z.infer<typeof RetryRequest>,actorId:string):Promise<{job:PublicJob;duplicate:boolean}> {
    if(!ID.test(jobId))throw new TypeError("Invalid source job ID");
    const checked=RetryRequest.parse(input);
    if(!/^[1-9][0-9]{0,15}$/u.test(actorId))throw new TypeError("Invalid admin actor");
    const current=await this.byId(jobId);
    if(!current)throw new SourceRetryConflict("not_found");
    if(!sameSourceIdentity(current,checked))throw new SourceRevisionConflict();
    const scope=`source-release:${jobId}`;
    const requestHash=await sourceProofDigest({jobId,actorId,...checked});
    const prior=await this.readRetryReceipt(scope,checked.idempotencyKey);
    if(prior)return this.replayRetry(jobId,prior,requestHash);
    if(current.revision!==checked.expectedRevision || current.state!=="failed" ||
      !isRetryableSourceFailure(current.failure_code))
      throw new SourceRetryConflict("stale_or_ineligible");

    const now=this.now();
    const nextRevision=checked.expectedRevision+1;
    const resumeProduced=current.failure_code==="SOURCE_ADMISSION_RETRIES_EXHAUSTED";
    const nextState=resumeProduced?"produced":"queued";
    const metadata=JSON.stringify({
      jobId,sourceId:current.source_id,githubReleaseId:current.github_release_id,
      sourceTag:current.source_tag,sourceRevision:current.source_revision,
      expectedRevision:checked.expectedRevision,revision:nextRevision,
      state:nextState,retryMode:resumeProduced?"reverify_produced_result":"rebuild_source",
    });
    try {
      await this.db.batch([
        this.db.prepare(
          `INSERT OR IGNORE INTO source_release_build_attempts
             (job_id,lease_epoch,attempt,revision,state,stage,started_at,finished_at,
              failure_code,diagnostic_json,evidence_expires_at)
           SELECT job_id,lease_epoch,attempt,revision,'failed','unknown',NULL,updated_at,
                  failure_code,NULL,NULL
             FROM source_release_builds
            WHERE job_id=? AND state='failed' AND revision=? AND attempt>0
              AND lease_epoch>0 AND source_id=? AND github_release_id=?
              AND source_tag=? AND source_revision=? AND release_version=?`,
        ).bind(jobId,checked.expectedRevision,checked.sourceId,checked.githubReleaseId,
          checked.sourceTag,checked.sourceRevision,checked.releaseVersion),
        this.db.prepare(
          `UPDATE source_release_builds SET state=?,attempt=?,revision=revision+1,
             admission_attempt=0,next_attempt_at=NULL,failure_code=NULL,
             result_json=CASE WHEN failure_code='SOURCE_ADMISSION_RETRIES_EXHAUSTED'
                              THEN result_json ELSE NULL END,updated_at=?
           WHERE job_id=? AND revision=? AND state='failed'
             AND failure_code IN ('SOURCE_UNAVAILABLE','SOURCE_BUILD_FAILED',
               'SOURCE_WORKER_UNAVAILABLE','SOURCE_ATTEMPTS_EXHAUSTED',
               'SOURCE_ADMISSION_RETRIES_EXHAUSTED','SOURCE_VERIFICATION_FAILED')
             AND source_id=? AND github_release_id=? AND source_tag=?
             AND source_revision=? AND release_version=?`,
        ).bind(nextState,resumeProduced?current.attempt:0,now,jobId,
          checked.expectedRevision,checked.sourceId,checked.githubReleaseId,
          checked.sourceTag,checked.sourceRevision,checked.releaseVersion),
        this.assertOneChange(),
        this.db.prepare(
          `INSERT INTO idempotency_records
             (scope,idempotency_key,request_hash,response_kind,response_id,created_at)
           VALUES (?, ?, ?, 'source-release-build-retry', ?, ?)`,
        ).bind(scope,checked.idempotencyKey,requestHash,jobId,now),
        this.assertOneChange(),
        this.db.prepare(
          `INSERT INTO audit_events
             (event_id,repository_id,instance_id,operation_id,actor_id,actor_kind,
              action,outcome,request_id,metadata_json,occurred_at)
           VALUES (?,NULL,NULL,NULL,?,'operator','source-release-build.retried',
                   'accepted',NULL,?,?)`,
        ).bind(`source-retry:${jobId}:${nextRevision}`,actorId,metadata,now),
        this.assertOneChange(),
      ]);
    } catch(error) {
      if(isTransactionAssertion(error)||isConstraintError(error)) {
        const raced=await this.readRetryReceipt(scope,checked.idempotencyKey);
        if(raced)return this.replayRetry(jobId,raced,requestHash);
        throw new SourceRetryConflict("stale_or_ineligible");
      }
      throw error;
    }
    const updated=await this.byId(jobId);
    if(!updated)throw new Error("Retried source build disappeared");
    return {job:publicSourceJob(updated),duplicate:false};
  }
  async list(limit=40,cursor?:SourceBuildListCursor,attention=false,state?:PublicJob["state"]):Promise<{
    readonly items:readonly PublicJob[];readonly nextCursor:string|null;
  }> {
    if(!Number.isSafeInteger(limit)||limit<1||limit>40||(attention&&(cursor!==undefined||state!==undefined))||
      (state!==undefined&&!["queued","building","produced","admitted","failed"].includes(state)))
      throw new TypeError("Invalid source build page size");
    const rows=attention
      ?await this.db.prepare(
          `SELECT * FROM source_release_builds
            WHERE state IN ('building','queued','produced') OR job_id IN (
              SELECT job_id FROM source_release_builds WHERE state='failed'
               ORDER BY updated_at DESC,job_id DESC LIMIT 5
            )
            ORDER BY CASE state WHEN 'failed' THEN 0 WHEN 'building' THEN 1
              WHEN 'queued' THEN 2 WHEN 'produced' THEN 3 ELSE 4 END,
              updated_at DESC,job_id DESC LIMIT ?`,
        ).bind(limit+1).all<SourceJob>()
      :cursor
      ?await this.db.prepare(
          `SELECT * FROM source_release_builds
            WHERE (? IS NULL OR state=?) AND
              (created_at<? OR (created_at=? AND job_id<?))
            ORDER BY created_at DESC,job_id DESC LIMIT ?`,
        ).bind(state??null,state??null,cursor.createdAt,cursor.createdAt,cursor.jobId,limit+1).all<SourceJob>()
      :await this.db.prepare(
          `SELECT * FROM source_release_builds WHERE (? IS NULL OR state=?)
           ORDER BY created_at DESC,job_id DESC LIMIT ?`,
        ).bind(state??null,state??null,limit+1).all<SourceJob>();
    const hasMore=rows.results.length>limit;
    const page=rows.results.slice(0,limit);
    const last=page.at(-1);
    return {
      items:page.map(publicSourceJob),
      nextCursor:!attention&&hasMore&&last
        ?encodeSourceBuildListCursor({createdAt:last.created_at,jobId:last.job_id})
        :null,
    };
  }
  async detail(jobId:string,limit=25,beforeLeaseEpoch?:number):Promise<SourceBuildDetail|null> {
    const job=await this.byId(jobId);
    if(!job)return null;
    if(!Number.isSafeInteger(limit)||limit<1||limit>25||
      (beforeLeaseEpoch!==undefined&&(!Number.isSafeInteger(beforeLeaseEpoch)||beforeLeaseEpoch<1)))
      throw new TypeError("Invalid source build attempt page");
    const rows=beforeLeaseEpoch===undefined
      ?await this.db.prepare(
          `SELECT * FROM source_release_build_attempts WHERE job_id=?
           ORDER BY lease_epoch DESC LIMIT ?`,
        ).bind(jobId,limit+1).all<SourceBuildAttemptRow>()
      :await this.db.prepare(
          `SELECT * FROM source_release_build_attempts WHERE job_id=? AND lease_epoch<?
           ORDER BY lease_epoch DESC LIMIT ?`,
        ).bind(jobId,beforeLeaseEpoch,limit+1).all<SourceBuildAttemptRow>();
    const hasMore=rows.results.length>limit;
    const page=rows.results.slice(0,limit).map(row=>publicSourceBuildAttempt(row,this.now()));
    const last=page.at(-1);
    return {
      job:publicSourceJob(job),attempts:page,
      nextCursor:hasMore&&last?String(last.leaseEpoch):null,
      evidence:page[0]?.evidence??"not_recorded",
    };
  }
  async reportDiagnostic(jobId:string,request:z.infer<typeof DiagnosticReportRequest>):Promise<boolean> {
    if(!ID.test(jobId))throw new TypeError("Invalid source job ID");
    const checked=DiagnosticReportRequest.parse(request);
    const diagnostic=storedDiagnostic(checked.diagnostic);
    const now=this.now();
    const result=await this.db.prepare(
      `UPDATE source_release_build_attempts
          SET stage=?,diagnostic_json=?,evidence_expires_at=?
        WHERE job_id=? AND lease_epoch=? AND state='building'
          AND EXISTS (
            SELECT 1 FROM source_release_builds AS job
             WHERE job.job_id=source_release_build_attempts.job_id
               AND job.state='building' AND job.lease_worker=? AND job.lease_token=?
               AND job.lease_epoch=source_release_build_attempts.lease_epoch
               AND job.revision=source_release_build_attempts.revision
               AND job.lease_expires_at>?
          )`,
    ).bind(checked.diagnostic.stage,diagnostic,now+SOURCE_DIAGNOSTIC_RETENTION_MS,
      jobId,checked.leaseEpoch,checked.workerId,checked.leaseToken,now).run();
    return (result.meta.changes??0)===1;
  }
  async expireDiagnostics(limit=100):Promise<number> {
    if(!Number.isSafeInteger(limit)||limit<1||limit>1000)
      throw new TypeError("Invalid source diagnostic cleanup limit");
    const result=await this.db.prepare(
      `UPDATE source_release_build_attempts SET diagnostic_json=NULL
        WHERE rowid IN (
          SELECT rowid FROM source_release_build_attempts
           WHERE diagnostic_json IS NOT NULL AND evidence_expires_at<=?
           ORDER BY evidence_expires_at,job_id,lease_epoch LIMIT ?
        )`,
    ).bind(this.now(),limit).run();
    return result.meta.changes??0;
  }
  async claim(workerId:string,leaseSeconds:number):Promise<SourceJob|null>{
    LeaseRequest.parse({workerId,leaseSeconds});
    const now=this.now();
    const token=crypto.randomUUID();
    const result=await this.db.batch([
      this.db.prepare(
        `UPDATE source_release_builds SET state='failed',failure_code='SOURCE_ATTEMPTS_EXHAUSTED',
           lease_worker=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=?
         WHERE state='building' AND lease_expires_at<=? AND attempt>=?`,
      ).bind(now,now,MAX_ATTEMPTS),
      this.db.prepare(
        `INSERT OR IGNORE INTO audit_events
           (event_id,repository_id,instance_id,operation_id,actor_id,actor_kind,
            action,outcome,request_id,metadata_json,occurred_at)
         SELECT 'source-expired:' || job_id || ':' || lease_epoch,NULL,NULL,NULL,
                'system:source-build-worker','system','source-release-build.exhausted',
                'failed',job_id,json_object('failureCode',failure_code,'attempt',attempt,
                'leaseEpoch',lease_epoch),updated_at
           FROM source_release_builds
          WHERE state='failed' AND failure_code='SOURCE_ATTEMPTS_EXHAUSTED'
            AND updated_at=? AND attempt>=?`,
      ).bind(now,MAX_ATTEMPTS),
      this.db.prepare(
        `UPDATE source_release_build_attempts AS attempt SET
           state=CASE WHEN EXISTS (
             SELECT 1 FROM source_release_builds AS job
              WHERE job.job_id=attempt.job_id AND job.lease_epoch=attempt.lease_epoch
                AND job.state='failed' AND job.failure_code='SOURCE_ATTEMPTS_EXHAUSTED'
           ) THEN 'failed' ELSE 'lease_expired' END,
           failure_code=CASE WHEN EXISTS (
             SELECT 1 FROM source_release_builds AS job
              WHERE job.job_id=attempt.job_id AND job.lease_epoch=attempt.lease_epoch
                AND job.state='failed' AND job.failure_code='SOURCE_ATTEMPTS_EXHAUSTED'
           ) THEN 'SOURCE_ATTEMPTS_EXHAUSTED' ELSE NULL END,
           finished_at=?
         WHERE attempt.state='building' AND EXISTS (
           SELECT 1 FROM source_release_builds AS job
            WHERE job.job_id=attempt.job_id AND job.lease_epoch=attempt.lease_epoch
              AND ((job.state='failed' AND job.failure_code='SOURCE_ATTEMPTS_EXHAUSTED')
                OR (job.state='building' AND job.lease_expires_at<=?))
         )`,
      ).bind(now,now),
      this.db.prepare(
        `UPDATE source_release_builds SET state='building',lease_worker=?,
           lease_token=?,lease_epoch=lease_epoch+1,lease_expires_at=?,
           attempt=attempt+1,updated_at=?
         WHERE job_id=(
           SELECT job_id FROM source_release_builds
           WHERE state='queued' OR
             (state='building' AND lease_expires_at<=? AND attempt<?)
           ORDER BY created_at,job_id LIMIT 1
         )
         AND (state='queued' OR (state='building' AND lease_expires_at<=? AND attempt<?))
         RETURNING *`,
      ).bind(workerId,token,now+leaseSeconds*1000,now,now,MAX_ATTEMPTS,now,MAX_ATTEMPTS),
      this.db.prepare(
        `INSERT OR IGNORE INTO source_release_build_attempts
           (job_id,lease_epoch,attempt,revision,state,stage,started_at,finished_at,
            failure_code,diagnostic_json,evidence_expires_at)
         SELECT job_id,lease_epoch,attempt,revision,'building','unknown',?,NULL,NULL,NULL,NULL
           FROM source_release_builds
          WHERE state='building' AND lease_worker=? AND lease_token=?
            AND lease_expires_at>?`,
      ).bind(now,workerId,token,now),
    ]);
    return (result[3]?.results[0] as SourceJob|undefined)??null;
  }
  async heartbeat(jobId:string,request:z.infer<typeof HeartbeatRequest>):Promise<boolean>{
    if(!ID.test(jobId))throw new TypeError("Invalid source job id");
    const checked=HeartbeatRequest.parse(request);
    const now=this.now();
    const result=await this.db.prepare(
      `UPDATE source_release_builds SET lease_expires_at=?,updated_at=?
       WHERE job_id=? AND state='building' AND lease_worker=? AND lease_token=?
         AND lease_epoch=? AND lease_expires_at>?`
    ).bind(now+checked.leaseSeconds*1000,now,jobId,checked.workerId,
      checked.leaseToken,checked.leaseEpoch,now).run();
    return (result.meta.changes??0)===1;
  }
  async byId(jobId:string):Promise<SourceJob|null> {
    if(!ID.test(jobId))throw new TypeError("Invalid source job ID");
    return (await this.db.prepare("SELECT * FROM source_release_builds WHERE job_id=?")
      .bind(jobId).first<SourceJob>())??null;
  }
  async claimProduced(limit=5,leaseMs=ADMISSION_LEASE_MS):Promise<readonly (SourceJob&{result_json:string})[]> {
    if(!Number.isSafeInteger(limit)||limit<1||limit>MAX_ADMISSION_PAGE||
      !Number.isSafeInteger(leaseMs)||leaseMs<30_000||leaseMs>15*60_000)
      throw new TypeError("Invalid source admission lease");
    const now=this.now();
    const result=await this.db.batch([
      this.db.prepare(
        `UPDATE source_release_builds SET state='failed',
           failure_code='SOURCE_ADMISSION_RETRIES_EXHAUSTED',next_attempt_at=NULL,updated_at=?
         WHERE state='produced' AND admission_attempt>=? AND next_attempt_at IS NOT NULL
           AND next_attempt_at<=?`,
      ).bind(now,MAX_ADMISSION_ATTEMPTS,now),
      this.db.prepare(
        `INSERT OR IGNORE INTO audit_events
           (event_id,repository_id,instance_id,operation_id,actor_id,actor_kind,
            action,outcome,request_id,metadata_json,occurred_at)
         SELECT 'source-admission-exhausted:' || job_id,NULL,NULL,NULL,
                'system:source-admission','system','source-release-build.admission-exhausted',
                'failed',job_id,json_object('failureCode',failure_code,
                'admissionAttempt',admission_attempt),updated_at
           FROM source_release_builds
          WHERE state='failed' AND failure_code='SOURCE_ADMISSION_RETRIES_EXHAUSTED'
            AND updated_at=?`,
      ).bind(now),
      this.db.prepare(
        `UPDATE source_release_builds SET admission_attempt=admission_attempt+1,
           next_attempt_at=?,updated_at=?
         WHERE job_id IN (
           SELECT job_id FROM source_release_builds
            WHERE state='produced' AND admission_attempt<?
              AND (next_attempt_at IS NULL OR next_attempt_at<=?)
            ORDER BY COALESCE(next_attempt_at,0),created_at,job_id LIMIT ?
         ) AND state='produced' AND admission_attempt<?
             AND (next_attempt_at IS NULL OR next_attempt_at<=?)
         RETURNING *`,
      ).bind(now+leaseMs,now,MAX_ADMISSION_ATTEMPTS,now,limit,
        MAX_ADMISSION_ATTEMPTS,now),
    ]);
    return (result[2]?.results??[]) as readonly (SourceJob&{result_json:string})[];
  }
  async produced(jobId:string,input:{
    workerId:string;leaseToken:string;leaseEpoch:number;result:SourceProducerResult;
  }):Promise<boolean>{
    const result=SourceProducerResultSchema.parse(input.result);
    const current=await this.byId(jobId);
    if(!current)return false;
    const json=canonicalSourceProof(result);
    if(sourceProducerResultByteLength(result)>SOURCE_PRODUCER_RESULT_MAX_BYTES)
      throw new RangeError("Source release evidence exceeds bound");
    if((current.state==="produced"||current.state==="admitted"||current.state==="failed") &&
      current.lease_epoch===input.leaseEpoch && current.result_json!==null) {
      try {
        if(canonicalSourceProof(SourceProducerResultSchema.parse(JSON.parse(current.result_json)))===json)
          return true;
      } catch { return false; }
      return false;
    }
    const now=this.now();
    try {
      const response=await this.db.batch([
        this.db.prepare(
          `UPDATE source_release_builds SET state='produced', result_json=?,
             lease_worker=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=?
           WHERE job_id=? AND state='building' AND lease_worker=? AND lease_token=?
             AND lease_epoch=? AND lease_expires_at>?`,
        ).bind(json,now,jobId,input.workerId,input.leaseToken,input.leaseEpoch,now),
        this.assertOneChange(),
        this.db.prepare(
          `UPDATE source_release_build_attempts SET state='produced',finished_at=?,failure_code=NULL
            WHERE job_id=? AND lease_epoch=? AND state='building'`,
        ).bind(now,jobId,input.leaseEpoch),
      ]);
      return (response[0]?.meta.changes??0)===1;
    } catch(error) {
      if(isTransactionAssertion(error))return false;
      throw error;
    }
  }
  async listProduced():Promise<readonly (SourceJob&{result_json:string})[]>{
    const rows=await this.db.prepare(
      `SELECT * FROM source_release_builds WHERE state='produced'
        AND (next_attempt_at IS NULL OR next_attempt_at<=?)
        AND admission_attempt<?
       ORDER BY COALESCE(next_attempt_at,0),created_at,job_id LIMIT 5`,
    ).bind(this.now(),MAX_ADMISSION_ATTEMPTS).all<SourceJob&{result_json:string}>();
    return rows.results;
  }
  async deferProduced(jobId:string,expectedAdmissionAttempt:number):Promise<boolean>{
    if(!ID.test(jobId)||!Number.isSafeInteger(expectedAdmissionAttempt)||expectedAdmissionAttempt<1)
      throw new TypeError("Invalid source admission attempt");
    const now=this.now();
    if(expectedAdmissionAttempt>=MAX_ADMISSION_ATTEMPTS) {
      try {
        const result=await this.db.batch([
          this.db.prepare(
            `UPDATE source_release_builds SET state='failed',
               failure_code='SOURCE_ADMISSION_RETRIES_EXHAUSTED',next_attempt_at=NULL,updated_at=?
             WHERE job_id=? AND state='produced' AND admission_attempt=? AND next_attempt_at>?`,
          ).bind(now,jobId,expectedAdmissionAttempt,now),
          this.assertOneChange(),
          this.db.prepare(
            `INSERT INTO audit_events
               (event_id,repository_id,instance_id,operation_id,actor_id,actor_kind,
                action,outcome,request_id,metadata_json,occurred_at)
             SELECT 'source-admission-exhausted:' || job_id,NULL,NULL,NULL,
                    'system:source-admission','system','source-release-build.admission-exhausted',
                    'failed',job_id,json_object('failureCode',failure_code,
                    'admissionAttempt',admission_attempt),updated_at
               FROM source_release_builds WHERE job_id=? AND state='failed'
                 AND failure_code='SOURCE_ADMISSION_RETRIES_EXHAUSTED'
                 AND admission_attempt=?`,
          ).bind(jobId,expectedAdmissionAttempt),
          this.assertOneChange(),
        ]);
        return (result[0]?.meta.changes??0)===1;
      } catch(error) {
        if(isTransactionAssertion(error))return false;
        throw error;
      }
    }
    const delay=ADMISSION_BACKOFF_MS[expectedAdmissionAttempt-1]??ADMISSION_BACKOFF_MS.at(-1)!;
    const result=await this.db.prepare(
      `UPDATE source_release_builds SET next_attempt_at=?,updated_at=?
       WHERE job_id=? AND state='produced' AND admission_attempt=? AND next_attempt_at>?`,
    ).bind(now+delay,now,jobId,expectedAdmissionAttempt,now).run();
    return (result.meta.changes??0)===1;
  }
  async markAdmitted(jobId:string,releaseId:string,expectedAdmissionAttempt:number):Promise<boolean>{
    if(!Number.isSafeInteger(expectedAdmissionAttempt)||expectedAdmissionAttempt<1)
      throw new TypeError("Invalid source admission attempt");
    const now=this.now();
    const response=await this.db.prepare(
      `UPDATE source_release_builds SET state='admitted',
         admitted_release_id=?,next_attempt_at=NULL,updated_at=?
       WHERE job_id=? AND state='produced'
         AND admission_attempt=? AND next_attempt_at>?`
    ).bind(releaseId,now,jobId,expectedAdmissionAttempt,now).run();
    return (response.meta.changes??0)===1;
  }
  async rejectProduced(jobId:string,code:string,expectedAdmissionAttempt:number):Promise<boolean>{
    if(!ID.test(jobId)||!/^[A-Z_]{3,64}$/u.test(code))throw new TypeError("Invalid failure code");
    if(!Number.isSafeInteger(expectedAdmissionAttempt)||expectedAdmissionAttempt<1)
      throw new TypeError("Invalid source admission attempt");
    const now=this.now();
    try {
      const result=await this.db.batch([
        this.db.prepare(
          `UPDATE source_release_builds SET state='failed',failure_code=?,next_attempt_at=NULL,updated_at=?
           WHERE job_id=? AND state='produced' AND admission_attempt=? AND next_attempt_at>?`,
        ).bind(code,now,jobId,expectedAdmissionAttempt,now),
        this.assertOneChange(),
        this.db.prepare(
          `INSERT INTO audit_events
             (event_id,repository_id,instance_id,operation_id,actor_id,actor_kind,
              action,outcome,request_id,metadata_json,occurred_at)
           SELECT 'source-admission-denied:' || job_id,NULL,NULL,NULL,
                  'system:source-admission','system','source-release-build.admission-denied',
                  'failed',job_id,json_object('failureCode',failure_code,
                  'admissionAttempt',admission_attempt),updated_at
             FROM source_release_builds WHERE job_id=? AND state='failed'
               AND failure_code=? AND admission_attempt=?`,
        ).bind(jobId,code,expectedAdmissionAttempt,expectedAdmissionAttempt),
        this.assertOneChange(),
      ]);
      return (result[0]?.meta.changes??0)===1;
    } catch(error) {
      if(isTransactionAssertion(error))return false;
      throw error;
    }
  }
  async fail(jobId:string,request:z.infer<typeof FailureRequest>):Promise<boolean>{
    if(!ID.test(jobId))throw new TypeError("Invalid source job id");
    const checked=FailureRequest.parse(request);
    const diagnostic=checked.diagnostic?storedDiagnostic(checked.diagnostic):null;
    const current=await this.byId(jobId);
    if(!current)return false;
    if(current.state==="failed" && current.lease_epoch===checked.leaseEpoch &&
      current.failure_code===checked.code)return true;
    const now=this.now();
    try {
      const result=await this.db.batch([
        this.db.prepare(
          `UPDATE source_release_builds SET state='failed',failure_code=?,
             lease_worker=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=?
           WHERE job_id=? AND state='building' AND lease_worker=? AND lease_token=?
             AND lease_epoch=? AND lease_expires_at>?`,
        ).bind(checked.code,now,jobId,checked.workerId,checked.leaseToken,checked.leaseEpoch,now),
        this.assertOneChange(),
        this.db.prepare(
          `UPDATE source_release_build_attempts SET state='failed',finished_at=?,failure_code=?,
             stage=COALESCE(?,stage),
             diagnostic_json=CASE WHEN ? IS NULL THEN diagnostic_json ELSE ? END,
             evidence_expires_at=CASE WHEN ? IS NULL THEN evidence_expires_at ELSE ? END
           WHERE job_id=? AND lease_epoch=? AND state='building'`,
        ).bind(now,checked.code,checked.diagnostic?.stage??null,
          diagnostic,diagnostic,diagnostic,diagnostic===null?null:now+SOURCE_DIAGNOSTIC_RETENTION_MS,
          jobId,checked.leaseEpoch),
        this.db.prepare(
          `INSERT INTO audit_events
             (event_id,repository_id,instance_id,operation_id,actor_id,actor_kind,
              action,outcome,request_id,metadata_json,occurred_at)
           SELECT 'source-failure:' || job_id || ':' || lease_epoch,NULL,NULL,NULL,
                  ?, 'build-worker','source-release-build.failed','failed',job_id,
                  json_object('failureCode',failure_code,'attempt',attempt,
                    'leaseEpoch',lease_epoch),updated_at
             FROM source_release_builds WHERE job_id=? AND state='failed'
               AND failure_code=? AND lease_epoch=?`,
        ).bind(checked.workerId,jobId,checked.code,checked.leaseEpoch),
        this.assertOneChange(),
      ]);
      return (result[0]?.meta.changes??0)===1;
    } catch(error) {
      if(isTransactionAssertion(error)) {
        const raced=await this.byId(jobId);
        return raced?.state==="failed" && raced.lease_epoch===checked.leaseEpoch &&
          raced.failure_code===checked.code;
      }
      throw error;
    }
  }
  private assertOneChange() {
    return this.db.prepare(
      "INSERT INTO platform_transaction_sentinel(id) SELECT 1 WHERE changes() <> 1",
    );
  }
  private async readRetryReceipt(scope:string,key:string):Promise<RetryReceipt|null> {
    return (await this.db.prepare(
      "SELECT request_hash,response_kind,response_id FROM idempotency_records WHERE scope=? AND idempotency_key=?",
    ).bind(scope,key).first<RetryReceipt>())??null;
  }
  private async replayRetry(jobId:string,prior:RetryReceipt,requestHash:string):Promise<{job:PublicJob;duplicate:boolean}> {
    if(prior.request_hash!==requestHash || prior.response_kind!=="source-release-build-retry" ||
      prior.response_id!==jobId)throw new SourceRetryConflict("idempotency_key_reused");
    const current=await this.byId(jobId);
    if(!current)throw new SourceRetryConflict("not_found");
    return {job:publicSourceJob(current),duplicate:true};
  }
}
export class SourceRevisionConflict extends Error {
  constructor(){super("GitHub Release identity changed after registration");}
}
export class SourceRetryConflict extends Error {
  constructor(readonly reason:"stale_or_ineligible"|"idempotency_key_reused"|"not_found") {
    super("Source build retry is stale or ineligible");
    this.name="SourceRetryConflict";
  }
}
type RetryReceipt={request_hash:string;response_kind:string;response_id:string};
function sameSourceIdentity(job:SourceJob,input:z.infer<typeof SourceIdentity>):boolean {
  return job.source_id===input.sourceId && job.github_release_id===input.githubReleaseId &&
    job.source_tag===input.sourceTag && job.source_revision===input.sourceRevision &&
    job.release_version===input.releaseVersion;
}
function isRetryableSourceFailure(code:string|null):boolean {
  return code!==null && ["SOURCE_UNAVAILABLE","SOURCE_BUILD_FAILED",
    "SOURCE_WORKER_UNAVAILABLE","SOURCE_ATTEMPTS_EXHAUSTED",
    "SOURCE_ADMISSION_RETRIES_EXHAUSTED","SOURCE_VERIFICATION_FAILED"].includes(code);
}
function isTransactionAssertion(error:unknown):boolean {
  return (error instanceof Error?error.message:String(error)).includes("platform_transaction_sentinel");
}
function isConstraintError(error:unknown):boolean {
  return /unique constraint|constraint failed/iu.test(error instanceof Error?error.message:String(error));
}
function readPageLimit(value:string|undefined,fallback:number,max:number):number {
  if(value===undefined)return fallback;
  if(value.length>3||!/^[1-9][0-9]*$/u.test(value))
    throw new TypeError("Invalid page size");
  const limit=Number(value);
  if(!Number.isSafeInteger(limit)||limit>max)throw new TypeError("Invalid page size");
  return limit;
}
function readAttemptCursor(value:string|undefined):number|undefined {
  if(value===undefined)return undefined;
  if(value.length>16||!/^[1-9][0-9]*$/u.test(value))
    throw new TypeError("Invalid source attempt cursor");
  const cursor=Number(value);
  if(!Number.isSafeInteger(cursor))throw new TypeError("Invalid source attempt cursor");
  return cursor;
}

export function createSourceReleaseOperatorRoutes(input:{
  readonly queue:D1SourceReleaseBuildQueue;
  readonly operatorActorId:string;
  readonly notifyBuild?:()=>Promise<void>;
}){
  const app=new Hono();
  app.use("*",async(c,next)=>{
    c.header("Cache-Control","no-store");
    if(c.req.header("X-Praetorium-Admin-Actor")!==input.operatorActorId)
      return c.json({error:{code:"OPERATOR_AUTH_REQUIRED"}},403);
    await next();
  });
  app.get("/",async(c)=>{
    const limit=readPageLimit(c.req.query("limit"),40,40);
    const rawCursor=c.req.query("cursor");
    const cursor=parseSourceBuildListCursor(rawCursor);
    const attention=c.req.query("attention");
    if(attention!==undefined&&attention!=="1")throw new TypeError("Invalid source build view");
    const state=c.req.query("state");
    if(state!==undefined&&!["queued","building","produced","admitted","failed"].includes(state))
      throw new TypeError("Invalid Source state filter");
    return c.json(await input.queue.list(limit,cursor,attention==="1",state as PublicJob["state"]|undefined));
  });
  app.get("/:jobId",async(c)=>{
    const limit=readPageLimit(c.req.query("limit"),10,25);
    const beforeLeaseEpoch=readAttemptCursor(c.req.query("cursor"));
    const detail=await input.queue.detail(c.req.param("jobId"),limit,beforeLeaseEpoch);
    return detail?c.json(detail):c.json({error:{code:"SOURCE_BUILD_NOT_FOUND"}},404);
  });
  app.post("/",async(c)=>{
    const body=NewJob.parse(await readBoundedJson(c.req.raw,2048));
    try {
      const {job,duplicate}=await input.queue.enqueue(body,input.operatorActorId);
      // A hint is never the durable admission receipt; worker polls on loss.
      if(!duplicate)try{c.executionCtx.waitUntil(input.notifyBuild?.()??Promise.resolve());}catch{ /* Recovery polling remains authoritative. */ }
      return c.json({job,duplicate},duplicate?200:202);
    } catch(e) {
      if(e instanceof SourceRevisionConflict)
        return c.json({error:{code:"SOURCE_RELEASE_CHANGED"}},409);
      throw e;
    }
  });
  app.post("/:jobId/retry",async(c)=>{
    const body=RetryRequest.parse(await readBoundedJson(c.req.raw,2048));
    try {
      const {job,duplicate}=await input.queue.retry(c.req.param("jobId"),body,input.operatorActorId);
      if(!duplicate)try{c.executionCtx.waitUntil(input.notifyBuild?.()??Promise.resolve());}catch{ /* Polling recovers a missed hint. */ }
      return c.json({job,duplicate},duplicate?200:202);
    } catch(e) {
      if(e instanceof SourceRevisionConflict)
        return c.json({error:{code:"SOURCE_RELEASE_CHANGED"}},409);
      if(e instanceof SourceRetryConflict) {
        if(e.reason==="not_found")return c.json({error:{code:"SOURCE_BUILD_NOT_FOUND"}},404);
        return c.json({error:{code:"SOURCE_BUILD_RETRY_CONFLICT",reason:e.reason}},409);
      }
      throw e;
    }
  });
  app.onError((e,c)=>e instanceof RequestTooLargeError
    ?c.json({error:{code:"REQUEST_TOO_LARGE"}},413)
    :e instanceof z.ZodError||e instanceof SyntaxError||e instanceof TypeError
    ?c.json({error:{code:"INVALID_REQUEST"}},400)
    :c.json({error:{code:"SOURCE_RELEASE_UNAVAILABLE",reason:metadataFailureReason(e)}},503));
  return app;
}

export function createSourceReleaseWorkerRoutes(input:{
  readonly queue:D1SourceReleaseBuildQueue;
  readonly workerId:string;
  readonly serviceToken:string;
  readonly verifyProduced?: (job:SourceJob,result:SourceProducerResult)=>Promise<void>;
  readonly afterProduced?: () => Promise<void>;
}){
  const app=new Hono();
  app.use("*",async(c,next)=>{
    const auth=c.req.header("Authorization")??"";
    const expected="Bearer "+input.serviceToken;
    let diff=auth.length^expected.length;
    for(let i=0;i<Math.max(auth.length,expected.length);i++)
      diff|=(auth.charCodeAt(i)||0)^(expected.charCodeAt(i)||0);
    if(diff!==0)return c.json({error:{code:"UNAUTHORIZED"}},401);
    await next();
  });
  app.post("/claim",async c=>{
    const body=LeaseRequest.parse(await readBoundedJson(c.req.raw,1024));
    if(body.workerId!==input.workerId)return c.json({error:{code:"UNAUTHORIZED"}},401);
    const job=await input.queue.claim(body.workerId,body.leaseSeconds);
    return job?c.json({job}):c.body(null,204);
  });
  app.post("/:jobId/heartbeat",async c=>{
    const data=HeartbeatRequest.parse(await readBoundedJson(c.req.raw,1024));
    if(data.workerId!==input.workerId)return c.json({error:{code:"UNAUTHORIZED"}},401);
    const accepted=await input.queue.heartbeat(c.req.param("jobId"),data);
    return c.json({accepted});
  });
  app.post("/:jobId/diagnostics",async c=>{
    const data=DiagnosticReportRequest.parse(
      await readBoundedJson(c.req.raw,SOURCE_DIAGNOSTIC_REQUEST_MAX_BYTES),
    );
    if(data.workerId!==input.workerId)return c.json({error:{code:"UNAUTHORIZED"}},401);
    const accepted=await input.queue.reportDiagnostic(c.req.param("jobId"),data);
    return c.json({accepted});
  });
  app.post("/:jobId/produced",async c=>{
    if(!input.verifyProduced)return c.json({error:{code:"SOURCE_PRODUCER_UNAVAILABLE"}},503);
    const data=z.strictObject({
      workerId:z.string().regex(WORKER),leaseToken:z.string().uuid(),
      leaseEpoch:z.number().int().positive().safe(),
      result:SourceProducerResultSchema,
    }).parse(await readBoundedJson(c.req.raw,SOURCE_PRODUCER_REQUEST_MAX_BYTES));
    if(sourceProducerResultByteLength(data.result)>SOURCE_PRODUCER_RESULT_MAX_BYTES)
      return c.json({error:{code:"REQUEST_TOO_LARGE"}},413);
    if(data.workerId!==input.workerId)return c.json({error:{code:"UNAUTHORIZED"}},401);
    const current=await input.queue.byId(c.req.param("jobId"));
    if(!current)return c.json({error:{code:"SOURCE_BUILD_LEASE_CONFLICT"}},409);
    if(current.state!=="building") {
      const duplicate=await input.queue.produced(current.job_id,data);
      if(!duplicate)return c.json({error:{code:"SOURCE_BUILD_LEASE_CONFLICT"}},409);
      if(input.afterProduced)try{c.executionCtx.waitUntil(input.afterProduced());}catch{ /* Cron reconciles durable proof rows. */ }
      return c.json({accepted:true});
    }
    if(current.lease_worker!==data.workerId ||
      current.lease_token!==data.leaseToken || current.lease_epoch!==data.leaseEpoch ||
      !current.lease_expires_at || current.lease_expires_at<=Date.now())
      return c.json({error:{code:"SOURCE_BUILD_LEASE_CONFLICT"}},409);
    // Cryptographic proof + Registry admission must complete before any D1
    // source result is trusted or before the worker's lease is retired.
    try {
      await input.verifyProduced(current,data.result);
    } catch(error) {
      if(error instanceof SourceProofVerificationError) {
        if(error.retryable)return c.json({error:{code:"SOURCE_PROOF_UNAVAILABLE"}},503);
        const accepted=await input.queue.fail(c.req.param("jobId"),{
          workerId:data.workerId,leaseToken:data.leaseToken,leaseEpoch:data.leaseEpoch,
          code:error.code,
        });
        return accepted
          ?c.json({error:{code:error.code}},422)
          :c.json({error:{code:"SOURCE_BUILD_LEASE_CONFLICT"}},409);
      }
      return c.json({error:{code:"SOURCE_PROOF_UNAVAILABLE"}},503);
    }
    const accepted=await input.queue.produced(current.job_id,data);
    if(accepted && input.afterProduced) {
      try {c.executionCtx.waitUntil(input.afterProduced());}catch{ /* Cron will reconcile durable source proofs. */ }
    }
    return c.json({accepted});
  });
  app.post("/:jobId/fail",async c=>{
    const data=FailureRequest.parse(
      await readBoundedJson(c.req.raw,SOURCE_DIAGNOSTIC_REQUEST_MAX_BYTES),
    );
    if(data.workerId!==input.workerId)return c.json({error:{code:"UNAUTHORIZED"}},401);
    const accepted=await input.queue.fail(c.req.param("jobId"),data);
    return c.json({accepted});
  });
  app.onError((e,c)=>e instanceof RequestTooLargeError
    ?c.json({error:{code:"REQUEST_TOO_LARGE"}},413)
    :e instanceof z.ZodError||e instanceof SyntaxError||e instanceof TypeError
    ?c.json({error:{code:"INVALID_REQUEST"}},400)
    :c.json({error:{code:"SOURCE_RELEASE_UNAVAILABLE",reason:metadataFailureReason(e)}},503));
  return app;
}
