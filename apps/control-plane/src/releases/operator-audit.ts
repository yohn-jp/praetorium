import type { D1Database } from "@praetorium/persistence/d1";

export interface OperatorAuditQuery { readonly cursor:string|null; readonly query:string }
export interface OperatorAuditEvent {
  readonly eventId:string; readonly action:string; readonly outcome:string;
  readonly actorId:string|null; readonly occurredAt:number;
  readonly jobId:string|null; readonly releaseId:string|null; readonly operationId:string|null;
  readonly failureCode:string|null; readonly revision:number|null; readonly leaseEpoch:number|null;
}
export interface OperatorAuditPage {
  readonly events:readonly OperatorAuditEvent[]; readonly nextCursor:string|null;
}
interface AuditRow {
  event_id:string; action:string; outcome:string; actor_id:string|null; occurred_at:number;
  request_id:string|null; operation_id:string|null; metadata_json:string;
}
const JOB=/^sr_[0-9a-f-]{36}$/u;
const RELEASE=/^rel_[A-Za-z0-9_.:-]{1,124}$/u;
const OPERATION=/^op_[A-Za-z0-9_.:-]{1,124}$/u;
const FAILURE=/^[A-Z][A-Z0-9_]{0,89}$/u;
function safeMeta(raw:string):Record<string,unknown>{
  try {const v:unknown=JSON.parse(raw);return v&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:{};}
  catch{return {};}
}
function id(value:unknown,pattern:RegExp):string|null{return typeof value==="string"&&pattern.test(value)?value:null;}
function count(value:unknown):number|null{return typeof value==="number"&&Number.isSafeInteger(value)&&value>=0?value:null;}
export function parseAuditCursor(cursor:string|null):{time:number;id:string}|null{
  if(cursor===null)return null;
  const m=/^(0|[1-9][0-9]{0,15}):([A-Za-z0-9_.:-]{1,255})$/u.exec(cursor);
  if(!m||!Number.isSafeInteger(Number(m[1])))throw new TypeError("Invalid audit cursor");
  return {time:Number(m[1]),id:m[2]!};
}
/** Project only safe, allowlisted IDs; never expose audit metadata or secrets. */
export async function readOperatorAudit(db:D1Database,input:OperatorAuditQuery):Promise<OperatorAuditPage>{
  const cursor=parseAuditCursor(input.cursor);
  if(input.query.length>100||[...input.query].some(char=>char.charCodeAt(0)<32||char.charCodeAt(0)===127))
    throw new TypeError("Invalid audit search");
  const rows=await db.prepare(`
    SELECT event_id,actor_id,action,outcome,occurred_at,request_id,operation_id,metadata_json
    FROM audit_events
    WHERE (action LIKE 'release.%' OR action LIKE 'source-release-build.%')
      AND (? IS NULL OR occurred_at<? OR (occurred_at=? AND event_id<?))
      AND (?='' OR instr(lower(action||' '||outcome||' '||coalesce(actor_id,'')||' '||
        coalesce(request_id,'')||' '||coalesce(json_extract(metadata_json,'$.failureCode'),'')),lower(?))>0)
    ORDER BY occurred_at DESC,event_id DESC LIMIT 26
  `).bind(cursor?.time??null,cursor?.time??null,cursor?.time??null,cursor?.id??null,
    input.query,input.query).all<AuditRow>();
  const page=rows.results.slice(0,25),last=page.at(-1);
  return {
    events:page.map(row=>{
      const meta=safeMeta(row.metadata_json),source=row.action.startsWith("source-release-build.");
      return {eventId:row.event_id,actorId:row.actor_id,action:row.action,
        outcome:row.outcome,occurredAt:row.occurred_at,
        jobId:source?(id(row.request_id,JOB)??id(meta.jobId,JOB)):null,
        releaseId:id(meta.releaseId,RELEASE),
        operationId:id(row.operation_id,OPERATION)??id(meta.operationId,OPERATION),
        failureCode:source?id(meta.failureCode,FAILURE):null,
        revision:source?count(meta.revision):null,leaseEpoch:source?count(meta.leaseEpoch):null};
    }),
    nextCursor:rows.results.length>25&&last?`${last.occurred_at}:${last.event_id}`:null,
  };
}
