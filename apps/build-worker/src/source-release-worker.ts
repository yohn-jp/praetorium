import { z } from "zod";
import {
  sanitizeSourceDiagnostic,
  SourceBuildDiagnosticSchema,
  SourceProducerResultSchema,
  type SourceBuildDiagnostic,
  type SourceProducerResult,
} from "@praetorium/contracts";
import type { BuildWorkerConfig } from "./config.js";
import {
  buildSourceRelease,
  SourceBuildChangedError,
  SourceBuildFailureError,
  SourceBuildVerificationError,
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
  reportDiagnostic(job:SourceBuildClaim,diagnostic:SourceBuildDiagnostic):Promise<boolean>;
  failSource(
    job:SourceBuildClaim,
    code:"SOURCE_BUILD_FAILED"|"SOURCE_VERIFICATION_FAILED"|"SOURCE_CHANGED",
    diagnostic?:SourceBuildDiagnostic,
  ):Promise<{accepted:boolean;diagnosticRecorded:boolean}>;
}

export class SourceBuildLeaseLostError extends Error {
  constructor(){super("Source build lease is no longer current");this.name="SourceBuildLeaseLostError";}
}

function failureDiagnostic(error:unknown):SourceBuildDiagnostic{
  if(error instanceof SourceBuildFailureError)return error.diagnostic;
  if(error instanceof SourceBuildChangedError&&error.diagnostic)return error.diagnostic;
  if(error instanceof SourceBuildVerificationError&&error.diagnostic)return error.diagnostic;
  const stage=error instanceof SourceBuildVerificationError?"verification":"unknown";
  const reason=error instanceof SourceBuildChangedError?"source_changed":
    error instanceof SourceBuildVerificationError?"verification_failed":"unknown";
  return sanitizeSourceDiagnostic({stage,reason,summary:"",truncated:false});
}

export class SourceReleaseBuildWorker {
  constructor(
    private readonly config:BuildWorkerConfig,
    private readonly client:SourceBuildQueueClient,
    private readonly execute:(
      job:SourceBuildClaim,
      config:BuildWorkerConfig,
      signal:AbortSignal,
      onStage:(diagnostic:SourceBuildDiagnostic)=>Promise<void>,
    )=>Promise<SourceProducerResult>=(job,config,signal,onStage)=>buildSourceRelease(job,config,signal,{onStage}),
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
    const onStage=async(input:SourceBuildDiagnostic):Promise<void>=>{
      const diagnostic=SourceBuildDiagnosticSchema.parse(sanitizeSourceDiagnostic(input));
      try{
        const accepted=await this.client.reportDiagnostic(job,diagnostic);
        if(!accepted){
          lost=true;
          controller.abort();
          throw new SourceBuildLeaseLostError();
        }
      }catch(error){
        if(error instanceof SourceBuildLeaseLostError)throw error;
        // Telemetry outages do not fail the build. Heartbeats and final reports
        // still fence execution and artifact acceptance.
      }
    };
    const timer=setInterval(tick,this.config.heartbeatIntervalMs);timer.unref();
    try{
      let result:SourceProducerResult;
      try{
        const produced=await this.execute(job,this.config,controller.signal,onStage);
        try{result=SourceProducerResultSchema.parse(produced);}
        catch{throw new SourceBuildVerificationError();}
      }catch(error){
        executing=false;
        if(!lost&&!controller.signal.aborted){
          const code=error instanceof SourceBuildChangedError||error instanceof SourceBuildVerificationError||error instanceof SourceBuildFailureError
            ?error.code:"SOURCE_BUILD_FAILED";
          await this.client.failSource(job,code,failureDiagnostic(error))
            .catch(()=>({accepted:false,diagnosticRecorded:false}));
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
