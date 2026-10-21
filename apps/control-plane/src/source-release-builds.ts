import { Hono } from "hono";
import { z } from "zod";
import type { D1Database } from "@praetorium/persistence/d1";

const SHA = /^[0-9a-f]{40}$/u;
const SOURCE_TAG = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const ID = /^sr_[0-9a-f-]{36}$/u;
const WORKER = /^[a-zA-Z0-9_.:-]{1,128}$/u;
const MAX_ATTEMPTS = 3;

const NewJob = z.strictObject({
  sourceId: z.literal("scriptorium"),
  githubReleaseId: z.number().int().positive().safe(),
  sourceTag: z.string().regex(SOURCE_TAG).max(128),
  sourceRevision: z.string().regex(SHA),
  releaseVersion: z.string().regex(VERSION).max(128),
}).refine(x => x.sourceTag.replace(/^v/u,"") === x.releaseVersion);
const LeaseRequest = z.strictObject({
  workerId: z.string().regex(WORKER),
  leaseSeconds: z.number().int().min(30).max(300),
});
const HeartbeatRequest = z.strictObject({
  workerId: z.string().regex(WORKER),
  leaseToken: z.string().uuid(),
  leaseEpoch: z.number().int().positive().safe(),
  leaseSeconds: z.number().int().min(30).max(300),
});
const FailureRequest = z.strictObject({
  workerId: z.string().regex(WORKER),
  leaseToken: z.string().uuid(),
  leaseEpoch: z.number().int().positive().safe(),
  code: z.enum(["SOURCE_UNAVAILABLE","SOURCE_CHANGED","SOURCE_BUILD_FAILED","SOURCE_VERIFICATION_FAILED","SOURCE_WORKER_UNAVAILABLE"]),
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
  lease_worker: string|null;
  lease_token: string|null;
  lease_epoch: number;
  lease_expires_at: number|null;
  failure_code: string|null;
  admitted_release_id: string|null;
  created_at: number;
  updated_at: number;
}
type PublicJob = {
  readonly id: string;
  readonly sourceId: string;
  readonly releaseId: number;
  readonly tag: string;
  readonly commit: string;
  readonly version: string;
  readonly state: SourceJob["state"];
  readonly attempt: number;
  readonly error: string|null;
  readonly admittedReleaseId: string|null;
};
export function publicSourceJob(job: SourceJob): PublicJob {
  return { id:job.job_id,sourceId:job.source_id,releaseId:job.github_release_id,
    tag:job.source_tag,commit:job.source_revision,version:job.release_version,
    state:job.state,attempt:job.attempt,error:job.failure_code,
    admittedReleaseId:job.admitted_release_id };
}
export class D1SourceReleaseBuildQueue {
  constructor(private readonly db:D1Database,private readonly now:()=>number=Date.now){}
  async enqueue(input:SourceJobInput,actorId:string):Promise<{job:PublicJob;duplicate:boolean}> {
    const checked=NewJob.parse(input);
    if(!/^[1-9][0-9]{0,15}$/u.test(actorId)) throw new TypeError("Invalid admin actor");
    const now=this.now();
    const id="sr_"+crypto.randomUUID();
    const saved=await this.db.prepare(
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
  async list():Promise<readonly PublicJob[]> {
    const rows=await this.db.prepare(
      "SELECT * FROM source_release_builds ORDER BY created_at DESC LIMIT 40"
    ).all<SourceJob>();
    return rows.results.map(publicSourceJob);
  }
  async claim(workerId:string,leaseSeconds:number):Promise<SourceJob|null>{
    LeaseRequest.parse({workerId,leaseSeconds});
    const now=this.now();
    const token=crypto.randomUUID();
    // One guarded statement gives at most one claimant the current lease.
    const job=await this.db.prepare(
      `UPDATE source_release_builds SET state='building', lease_worker=?,
         lease_token=?, lease_epoch=lease_epoch+1, lease_expires_at=?,
         attempt=attempt+1, updated_at=?
       WHERE job_id=(
         SELECT job_id FROM source_release_builds
         WHERE state='queued' OR
           (state='building' AND lease_expires_at<=? AND attempt<?)
         ORDER BY created_at LIMIT 1
       )
       AND (state='queued' OR (state='building' AND lease_expires_at<=? AND attempt<?))
       RETURNING *`
    ).bind(workerId,token,now+leaseSeconds*1000,now,now,MAX_ATTEMPTS,
      now,MAX_ATTEMPTS).first<SourceJob>();
    return job??null;
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
  async fail(jobId:string,request:z.infer<typeof FailureRequest>):Promise<boolean>{
    if(!ID.test(jobId))throw new TypeError("Invalid source job id");
    const checked=FailureRequest.parse(request);
    const now=this.now();
    const result=await this.db.prepare(
      `UPDATE source_release_builds SET state='failed',failure_code=?,
         lease_worker=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=?
       WHERE job_id=? AND state='building' AND lease_worker=? AND lease_token=?
         AND lease_epoch=? AND lease_expires_at>?`
    ).bind(checked.code,now,jobId,checked.workerId,
      checked.leaseToken,checked.leaseEpoch,now).run();
    return (result.meta.changes??0)===1;
  }
}
export class SourceRevisionConflict extends Error {
  constructor(){super("GitHub Release identity changed after registration");}
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
  app.get("/",async(c)=>c.json({items:await input.queue.list()}));
  app.post("/",async(c)=>{
    const body=NewJob.parse(await c.req.json());
    try {
      const {job,duplicate}=await input.queue.enqueue(body,input.operatorActorId);
      // A hint is never the durable admission receipt; worker polls on loss.
      if(!duplicate)try{c.executionCtx.waitUntil(input.notifyBuild?.()??Promise.resolve());}catch{}
      return c.json({job,duplicate},duplicate?200:202);
    } catch(e) {
      if(e instanceof SourceRevisionConflict)
        return c.json({error:{code:"SOURCE_RELEASE_CHANGED"}},409);
      throw e;
    }
  });
  app.onError((e,c)=>e instanceof z.ZodError||e instanceof SyntaxError||e instanceof TypeError
    ?c.json({error:{code:"INVALID_REQUEST"}},400)
    :c.json({error:{code:"SOURCE_RELEASE_UNAVAILABLE"}},503));
  return app;
}

export function createSourceReleaseWorkerRoutes(input:{
  readonly queue:D1SourceReleaseBuildQueue;
  readonly workerId:string;
  readonly serviceToken:string;
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
    const body=LeaseRequest.parse(await c.req.json());
    if(body.workerId!==input.workerId)return c.json({error:{code:"UNAUTHORIZED"}},401);
    const job=await input.queue.claim(body.workerId,body.leaseSeconds);
    return job?c.json({job}):c.body(null,204);
  });
  app.post("/:jobId/heartbeat",async c=>{
    const data=HeartbeatRequest.parse(await c.req.json());
    if(data.workerId!==input.workerId)return c.json({error:{code:"UNAUTHORIZED"}},401);
    const accepted=await input.queue.heartbeat(c.req.param("jobId"),data);
    return c.json({accepted});
  });
  app.post("/:jobId/fail",async c=>{
    const data=FailureRequest.parse(await c.req.json());
    if(data.workerId!==input.workerId)return c.json({error:{code:"UNAUTHORIZED"}},401);
    const accepted=await input.queue.fail(c.req.param("jobId"),data);
    return c.json({accepted});
  });
  app.onError((e,c)=>e instanceof z.ZodError||e instanceof SyntaxError||e instanceof TypeError
    ?c.json({error:{code:"INVALID_REQUEST"}},400)
    :c.json({error:{code:"SOURCE_RELEASE_UNAVAILABLE"}},503));
  return app;
}
