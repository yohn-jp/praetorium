import { z } from "zod";
import { SourceProducerResultSchema, type SourceProducerResult } from "@praetorium/contracts";
import type { BuildWorkerConfig } from "./config.js";
import {
  buildSourceRelease,
  SourceBuildChangedError,
  type SourceBuildClaim,
} from "./source-producer-builder.js";

const ClaimSchema=z.strictObject({
  job_id:z.string().regex(/^sr_[0-9a-f-]{36}$/u),
  source_id:z.literal("scriptorium"),
  source_repository:z.literal("yohn-jp/scriptorium"),
  github_release_id:z.number().int().positive().safe(),
  source_tag:z.string().min(1).max(128),
  source_revision:z.string().regex(/^[a-f0-9]{40}$/u),
  release_version:z.string().min(1).max(128),
  actor_id:z.string().min(1).max(128),
  state:z.literal("building"),
  attempt:z.number().int().positive().safe(),
  revision:z.number().int().nonnegative().safe(),
  admission_attempt:z.number().int().nonnegative().safe(),
  next_attempt_at:z.number().int().nullable(),
  lease_worker:z.string().min(1),
  lease_token:z.string().uuid(),
  lease_epoch:z.number().int().positive().safe(),
  lease_expires_at:z.number().int().positive().safe(),
  created_at:z.number().int(),
  updated_at:z.number().int(),
  failure_code:z.string().nullable(),
  admitted_release_id:z.string().nullable(),
  result_json:z.string().nullable().optional(),
  progress_json:z.string().nullable().optional(),
});
export interface SourceBuildQueueClient {
  claimSource(workerId:string,leaseSeconds:number):Promise<unknown|null>;
  heartbeatSource(job:SourceBuildClaim,leaseSeconds:number):Promise<boolean>;
  producedSource(job:SourceBuildClaim,result:SourceProducerResult):Promise<boolean>;
  failSource(job:SourceBuildClaim,code:"SOURCE_BUILD_FAILED"|"SOURCE_VERIFICATION_FAILED"|"SOURCE_CHANGED"):Promise<boolean>;
}
export class SourceReleaseBuildWorker {
  constructor(
    private readonly config:BuildWorkerConfig,
    private readonly client:SourceBuildQueueClient,
    private readonly execute:(job:SourceBuildClaim,config:BuildWorkerConfig,signal:AbortSignal)=>Promise<SourceProducerResult>=buildSourceRelease,
  ){}
  async runOnce(shutdown?:AbortSignal):Promise<boolean>{
    if(shutdown?.aborted)return false;
    const payload=await this.client.claimSource(this.config.workerId,this.config.leaseSeconds);
    if(payload===null)return false;
    const job=ClaimSchema.parse(payload) as SourceBuildClaim;
    if(job.lease_worker!==this.config.workerId)throw new Error("Source build claim worker mismatch");
    const controller=new AbortController();
    const abort=()=>controller.abort();
    shutdown?.addEventListener("abort",abort,{once:true});
    let lost=false;
    let inflight=false;
    let executing=true;
    let reportAccepted=false;
    let heartbeat:Promise<void>=Promise.resolve();
    const sendHeartbeat=async()=>{
      try{
        const accepted=await this.client.heartbeatSource(job,this.config.leaseSeconds);
        if(!accepted&&!reportAccepted){lost=true;if(executing)controller.abort();}
      }catch{
        if(!reportAccepted){lost=true;if(executing)controller.abort();}
      }
    };
    const tick=()=>{
      if(inflight||controller.signal.aborted||reportAccepted)return;
      inflight=true;
      heartbeat=heartbeat.then(sendHeartbeat).finally(()=>{inflight=false;});
    };
    const renewNow=async()=>{
      if(inflight)await heartbeat;
      if(lost||controller.signal.aborted)return false;
      inflight=true;
      try{await sendHeartbeat();}finally{inflight=false;}
      return !lost;
    };
    const timer=setInterval(tick,this.config.heartbeatIntervalMs);timer.unref();
    try{
      let result:SourceProducerResult;
      try{
        result=SourceProducerResultSchema.parse(
          await this.execute(job,this.config,controller.signal),
        );
      }catch(error){
        executing=false;
        if(!lost&&!controller.signal.aborted){
          const code=error instanceof SourceBuildChangedError?error.code:"SOURCE_BUILD_FAILED";
          await this.client.failSource(job,code).catch(()=>false);
        }
        return true;
      }
      executing=false;
      await heartbeat;
      if(lost||controller.signal.aborted)return true;
      // Always renew the current lease before a durable result is accepted.
      if(!(await renewNow()))return true;
      try{
        reportAccepted=await this.client.producedSource(job,result);
      }catch{
        // A failed report remains safely fenced: the job is reclaimed on
        // expiry and rebuilt. No unverified artifact enters admission.
      }
      return true;
    }finally{
      executing=false;
      clearInterval(timer);
      await heartbeat;
      shutdown?.removeEventListener("abort",abort);
    }
  }
}
