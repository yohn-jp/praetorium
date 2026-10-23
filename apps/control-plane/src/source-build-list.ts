/** Immutable, query-bound keyset for the server-side Source Build listing. */
export type BuildListSort = "recent" | "source" | "state" | "attempt";
export type BuildListState = "queued" | "building" | "produced" | "admitted" | "failed";
export type BuildListRow = {
  job_id:string; updated_at:number; source_id:string; source_tag:string; state:string; attempt:number;
};
export type BuildListCursor = { sort:BuildListSort; state:BuildListState|null;
  first:string|number; second:string|number|null; jobId:string };
const SORTS:readonly string[]=["recent","source","state","attempt"];
const STATES:readonly string[]=["queued","building","produced","admitted","failed"];
export function parseBuildSort(value:string|undefined):BuildListSort {
  if(value===undefined)return "recent";
  if(!SORTS.includes(value))throw new TypeError("Invalid Source Build sorting");
  return value as BuildListSort;
}
export function parseBuildState(value:string|undefined):BuildListState|null {
  if(value===undefined)return null;
  if(!STATES.includes(value))throw new TypeError("Invalid Source Build state");
  return value as BuildListState;
}
function encode(value:BuildListCursor):string{
  return btoa(JSON.stringify(value)).replace(/\+/gu,"-").replace(/\//gu,"_").replace(/=+$/gu,"");
}
export function cursorForBuild(row:BuildListRow,sort:BuildListSort,state:BuildListState|null):string {
  const [first,second]:[string|number,string|number|null]=
    sort==="recent"?[row.updated_at,null]:sort==="source"?[row.source_id,row.source_tag]:
      sort==="state"?[row.state,row.updated_at]:[row.attempt,row.updated_at];
  return encode({sort,state,first,second,jobId:row.job_id});
}
export function parseBuildCursor(raw:string|undefined,sort:BuildListSort,state:BuildListState|null):BuildListCursor|null {
  if(raw===undefined)return null;
  if(raw.length>512||!/^[A-Za-z0-9_-]+$/u.test(raw))throw new TypeError("Invalid Source Build cursor");
  try {
    const standard=raw.replace(/-/gu,"+").replace(/_/gu,"/");
    const decoded=atob(standard+"=".repeat((4-standard.length%4)%4));
    const v:unknown=JSON.parse(decoded);
    if(!v||typeof v!=="object"||Array.isArray(v))throw new Error("bad cursor");
    const c=v as BuildListCursor;
    if(c.sort!==sort||c.state!==state||!/^sr_[0-9a-f-]{36}$/u.test(c.jobId)||
       (sort==="recent"&&(typeof c.first!=="number"||c.second!==null))||
       (sort==="source"&&(typeof c.first!=="string"||typeof c.second!=="string"))||
       (sort==="state"&&(typeof c.first!=="string"||typeof c.second!=="number"))||
       (sort==="attempt"&&(typeof c.first!=="number"||typeof c.second!=="number"))||
       encode(c)!==raw)throw new Error("bad cursor");
    if((typeof c.first==="number"&&!Number.isSafeInteger(c.first))||
       (typeof c.second==="number"&&!Number.isSafeInteger(c.second)))throw new Error("bad number");
    return c;
  }catch{throw new TypeError("Invalid Source Build cursor");}
}
export function buildListSql(sort:BuildListSort,state:BuildListState|null,cursor:BuildListCursor|null,limit:number) {
  const predicates:string[]=[];
  const binds:(string|number)[]=[];
  if(state){predicates.push("state=?");binds.push(state);}
  let order:string;
  if(sort==="recent"){
    order="updated_at DESC,job_id DESC";
    if(cursor){predicates.push("(updated_at<? OR (updated_at=? AND job_id<?))");
      binds.push(cursor.first as number,cursor.first as number,cursor.jobId);}
  }else if(sort==="source"){
    order="source_id ASC,source_tag ASC,job_id DESC";
    if(cursor){predicates.push("(source_id>? OR (source_id=? AND source_tag>?) OR (source_id=? AND source_tag=? AND job_id<?))");
      binds.push(cursor.first as string,cursor.first as string,cursor.second as string,
        cursor.first as string,cursor.second as string,cursor.jobId);}
  }else if(sort==="state"){
    order="state ASC,updated_at DESC,job_id DESC";
    if(cursor){predicates.push("(state>? OR (state=? AND updated_at<?) OR (state=? AND updated_at=? AND job_id<?))");
      binds.push(cursor.first as string,cursor.first as string,cursor.second as number,
        cursor.first as string,cursor.second as number,cursor.jobId);}
  }else{
    order="attempt DESC,updated_at DESC,job_id DESC";
    if(cursor){predicates.push("(attempt<? OR (attempt=? AND updated_at<?) OR (attempt=? AND updated_at=? AND job_id<?))");
      binds.push(cursor.first as number,cursor.first as number,cursor.second as number,
        cursor.first as number,cursor.second as number,cursor.jobId);}
  }
  return {sql:"SELECT * FROM source_release_builds"+
    (predicates.length?" WHERE "+predicates.join(" AND "):"")+" ORDER BY "+order+" LIMIT ?",
    binds:[...binds,limit+1]};
}
