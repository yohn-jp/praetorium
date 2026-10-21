import { createGitHubRestClient, GitHubApiError, type GitHubRestClient } from "@praetorium/github";
import { keyedDigest } from "@praetorium/auth";
import type { GatewayContext } from "../context.js";
import { escapeHtml } from "../ui/presentation.js";

/** Operator-selected source registrations; no untrusted repository or workflow is executable. */
export interface RegisteredReleaseSource {
  readonly id: string;
  readonly label: string;
  readonly githubRepository: string;
  readonly workflowRepository: string;
  readonly workflowFile: string;
  readonly adapter: "scriptorium-v1";
}
export interface PublishedSourceRelease {
  readonly id: number;
  readonly tag: string;
  readonly name: string;
  readonly version: string | null;
  readonly publishedAt: string;
  readonly prerelease: boolean;
  readonly notes: string;
}
export interface SourceWorkflowRun {
  readonly url: string;
  readonly commit: string;
  readonly tag: string;
  readonly status: string;
  readonly conclusion: string | null;
}
export interface SourceReleaseView {
  readonly source: RegisteredReleaseSource;
  readonly releases: readonly PublishedSourceRelease[];
  readonly workflows: readonly SourceWorkflowRun[];
  readonly error: string | null;
}

const SHA = /^[0-9a-f]{40}$/u;
const GITHUB_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const WORKFLOW_FILE = /^[a-z0-9][a-z0-9_.-]{0,100}\.yml$/u;
const TAG = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const MAX_RELEASES = 40;
const MAX_GITHUB_RUNS = 40;
const MAX_SOURCES = 8;

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function configuredReleaseSources(raw: string | undefined): readonly RegisteredReleaseSource[] {
  if (!raw) return [];
  let data: unknown;
  try { data = JSON.parse(raw); } catch { throw new TypeError("Release source registry is invalid"); }
  if (!Array.isArray(data) || data.length < 1 || data.length > MAX_SOURCES)
    throw new TypeError("Release source registry must be bounded and nonempty");
  const sources = data.map((item): RegisteredReleaseSource => {
    const r = object(item);
    if (!r || Object.keys(r).some(k => ![
      "id", "label", "githubRepository", "workflowRepository", "workflowFile", "adapter",
    ].includes(k)) || typeof r.id !== "string" || !/^[a-z][a-z0-9-]{0,31}$/u.test(r.id) ||
        typeof r.label !== "string" || r.label.length < 1 || r.label.length > 64 ||
        typeof r.githubRepository !== "string" || !GITHUB_REPOSITORY.test(r.githubRepository) ||
        typeof r.workflowRepository !== "string" || !GITHUB_REPOSITORY.test(r.workflowRepository) ||
        typeof r.workflowFile !== "string" || !WORKFLOW_FILE.test(r.workflowFile) ||
        r.adapter !== "scriptorium-v1")
      throw new TypeError("Release source registration has invalid or unsupported entries");
    // Scriptorium's current signed producer adapter must only build Scriptorium.
    // Additional services require a separately verified producer adapter.
    if (r.adapter === "scriptorium-v1" &&
        (r.githubRepository !== "yohn-jp/scriptorium" ||
         r.workflowRepository !== "yohn-jp/praetorium" ||
         r.workflowFile !== "scriptorium-producer-verification.yml"))
      throw new TypeError("Producer adapter cannot be retargeted to arbitrary GitHub source");
    return {
      id: r.id, label: r.label, githubRepository: r.githubRepository,
      workflowRepository: r.workflowRepository, workflowFile: r.workflowFile,
      adapter: r.adapter,
    };
  });
  if (new Set(sources.map(x => x.id)).size !== sources.length ||
      new Set(sources.map(x => x.githubRepository)).size !== sources.length)
    throw new TypeError("Release sources cannot contain duplicate identities");
  return sources;
}

function parseRelease(item: unknown): PublishedSourceRelease | null {
  const x = object(item);
  if (!x || x.draft !== false || typeof x.published_at !== "string" ||
      !Number.isFinite(Date.parse(x.published_at)) ||
      !Number.isSafeInteger(x.id) || Number(x.id) < 1 ||
      typeof x.tag_name !== "string" || x.tag_name.length > 128 ||
      typeof x.prerelease !== "boolean")
    return null;
  const version = TAG.test(x.tag_name) && !x.tag_name.includes("..")
    ? x.tag_name.replace(/^v/u, "") : null;
  return {
    id: Number(x.id), tag: x.tag_name,
    name: typeof x.name === "string" && x.name.trim() ? x.name.slice(0, 160) : x.tag_name,
    version,
    publishedAt: x.published_at,
    prerelease: x.prerelease,
    notes: typeof x.body === "string" ? x.body.slice(0, 280) : "",
  };
}

export function publishedReleases(payload: unknown): readonly PublishedSourceRelease[] {
  if (!Array.isArray(payload)) throw new TypeError("GitHub Releases response is invalid");
  if (payload.length > 100) throw new TypeError("GitHub Releases response exceeded limit");
  return payload.map(parseRelease).filter((x): x is PublishedSourceRelease => x !== null)
    .sort((a,b) => Date.parse(b.publishedAt)-Date.parse(a.publishedAt))
    .slice(0, MAX_RELEASES);
}

/** Resolve annotated tags with bounded recursion; never use target_commitish/main. */
export async function resolveTagCommit(
  source: RegisteredReleaseSource, tag: string, client: GitHubRestClient, token: string,
): Promise<string> {
  if (!TAG.test(tag) || tag.includes("..")) throw new TypeError("Unsupported GitHub release tag");
  let ref = await client.request(
    `/repos/${source.githubRepository}/git/ref/tags/${encodeURIComponent(tag)}`, token,
  );
  let obj = object(object(ref.body)?.object);
  const visited = new Set<string>();
  for (let attempt=0; attempt<5; attempt++) {
    if (!obj || typeof obj.sha !== "string" || !SHA.test(obj.sha)) break;
    if (obj.type === "commit") return obj.sha;
    if (obj.type !== "tag" || visited.has(obj.sha)) break;
    visited.add(obj.sha);
    ref = await client.request(`/repos/${source.githubRepository}/git/tags/${obj.sha}`, token);
    obj = object(object(ref.body)?.object);
  }
  throw new TypeError("Published tag does not resolve to a unique commit");
}

function parseWorkflowRuns(payload: unknown): readonly SourceWorkflowRun[] {
  const body = object(payload);
  if (!body || !Array.isArray(body.workflow_runs)) throw new TypeError("GitHub workflow response is invalid");
  const runs: SourceWorkflowRun[] = [];
  for (const value of body.workflow_runs.slice(0, MAX_GITHUB_RUNS)) {
    const x = object(value);
    if (!x || typeof x.display_title !== "string" || typeof x.html_url !== "string" ||
        x.event !== "workflow_dispatch" || !["completed", "in_progress", "queued", "pending", "requested", "waiting"].includes(String(x.status))) continue;
    const match = /^Producer (v?\S+) @ ([0-9a-f]{40})$/u.exec(x.display_title);
    if (!match || !TAG.test(match[1]!)) continue;
    const u = new URL(x.html_url);
    if (u.protocol !== "https:" || u.hostname !== "github.com") continue;
    runs.push({tag:match[1]!,commit:match[2]!,url:u.toString(),
      status:String(x.status),conclusion:typeof x.conclusion === "string"?x.conclusion:null});
  }
  return runs;
}

export async function fetchSourceReleases(
  source: RegisteredReleaseSource, client: GitHubRestClient, token: string,
): Promise<{releases: readonly PublishedSourceRelease[]; workflows: readonly SourceWorkflowRun[]}> {
  const releases = await client.request(`/repos/${source.githubRepository}/releases?per_page=50`, token);
  // The workflow status is best-effort, but does not mutate release authority.
  let workflows: readonly SourceWorkflowRun[] = [];
  try {
    const runs = await client.request(
      `/repos/${source.workflowRepository}/actions/workflows/${source.workflowFile}/runs?event=workflow_dispatch&per_page=40`, token,
    );
    workflows = parseWorkflowRuns(runs.body);
  } catch { /* Unavailable actions permission must not falsify the release catalog. */ }
  return {releases:publishedReleases(releases.body),workflows};
}

export async function fetchSelectedRelease(
  source: RegisteredReleaseSource, releaseId: number, client: GitHubRestClient, token: string,
): Promise<{release: PublishedSourceRelease; commit: string}> {
  if (!Number.isSafeInteger(releaseId) || releaseId < 1) throw new TypeError("Invalid GitHub Release ID");
  const response = await client.request(`/repos/${source.githubRepository}/releases/${releaseId}`, token);
  const release = parseRelease(response.body);
  if (!release || release.id !== releaseId || release.version === null)
    throw new TypeError("Selected GitHub Release is unpublished or is not a deployable SemVer");
  const commit = await resolveTagCommit(source,release.tag,client,token);
  return {release,commit};
}

async function oneShotClaim(context: GatewayContext, key: string, claimId: string, action: "claim"|"release"): Promise<boolean> {
  const hash = await keyedDigest(context.config.handoffPepper,"release-dispatch:"+key);
  const stub = context.env.EPHEMERAL_CODES.get(
    context.env.EPHEMERAL_CODES.idFromName("release-dispatch:"+hash.slice(0,2)),
  );
  const response = await stub.fetch("https://ephemeral-code/release-dispatch/"+action,{
    method:"POST", body:JSON.stringify({
      key:"release-dispatch:"+hash, claimId, now:Date.parse(context.requestNow),
    }),
  });
  if (!response.ok) throw new Error("Release dispatch coordination unavailable");
  const result: unknown = await response.json();
  return object(result)?.[action==="claim"?"claimed":"released"] === true;
}

export type DispatchReleaseResult =
  | {readonly kind:"dispatched";readonly tag:string;readonly commit:string}
  | {readonly kind:"duplicate"}
  | {readonly kind:"forbidden"}
  | {readonly kind:"unavailable"};

export async function dispatchPublishedRelease(
  context:GatewayContext, userId:string, sourceId:string,releaseId:number,
):Promise<DispatchReleaseResult>{
  const sources=configuredReleaseSources(context.env.PRAETORIUM_RELEASE_SOURCES_JSON);
  const source=sources.find(x=>x.id===sourceId);
  if(!source) return {kind:"forbidden"};
  const token=await context.githubUserTokens.accessTokenFor(userId,context.requestNow);
  if(!token) return {kind:"unavailable"};
  const client=createGitHubRestClient({requestTimeoutMs:8000});
  let selected;
  try {selected=await fetchSelectedRelease(source,releaseId,client,token);}
  catch(e){return {kind:e instanceof GitHubApiError && (e.status===403||e.status===401)?"forbidden":"unavailable"};}
  const key=`${source.id}:${selected.release.id}:${selected.commit}`;
  const claimId=crypto.randomUUID();
  if(!(await oneShotClaim(context,key,claimId,"claim")))return {kind:"duplicate"};
  try{
    await client.request(`/repos/${source.workflowRepository}/actions/workflows/${source.workflowFile}/dispatches`,token,{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({ref:"main",inputs:{
        source_revision:selected.commit,source_tag:selected.release.tag,
        release_version:selected.release.version,publish_public_producer_inputs:"true",
      }}),
    });
    return {kind:"dispatched",tag:selected.release.tag,commit:selected.commit};
  }catch(e){
    // Only a definite authorization failure proves the workflow was not queued.
    // Network timeouts/5xx are ambiguous and retain the claim to prevent duplicates.
    if(e instanceof GitHubApiError && [401,403,404,422].includes(e.status)){
      await oneShotClaim(context,key,claimId,"release").catch(()=>false);
      return {kind:e.status===401||e.status===403?"forbidden":"unavailable"};
    }
    return {kind:"unavailable"};
  }
}

export async function listRegisteredSources(
  context:GatewayContext,userId:string,
):Promise<readonly SourceReleaseView[]>{
  const sources=configuredReleaseSources(context.env.PRAETORIUM_RELEASE_SOURCES_JSON);
  if(!sources.length)return [];
  const token=await context.githubUserTokens.accessTokenFor(userId,context.requestNow);
  if(!token)return sources.map(source=>({source,releases:[],workflows:[],error:"GitHub authorization unavailable"}));
  const client=createGitHubRestClient({requestTimeoutMs:8000});
  return Promise.all(sources.map(async source=>{
    try{
      const result=await fetchSourceReleases(source,client,token);
      return {source,...result,error:null};
    }catch(e){
      const err=e instanceof GitHubApiError && (e.status===401||e.status===403)
        ? "GitHub App access to this repository is missing" : "GitHub Releases are temporarily unavailable";
      return {source,releases:[],workflows:[],error:err};
    }
  }));
}

/** Markup is escaped even when Release titles and notes contain arbitrary Markdown/HTML. */
export function sourceReleaseCards(views:readonly SourceReleaseView[],csrf:string):string {
  if(!views.length)return '<p class="admin-empty">No release sources registered. Configure trusted service sources in Wrangler.</p>';
  return views.map(({source,releases,workflows,error})=>{
    const entries=error?'<p class="alert" role="status">'+escapeHtml(error)+'</p>':
      releases.length===0?'<p class="admin-empty">No published GitHub Releases were found.</p>':
      releases.map(release=>{
        const run=workflows.find(x=>x.tag===release.tag);
        const workflow=run?'<p class="admin-subtext">Producer: <a href="'+escapeHtml(run.url)+'" rel="noopener noreferrer">'+escapeHtml(run.status+(run.conclusion?" / "+run.conclusion:""))+'</a></p>':"";
        const action=release.version?
          '<form method="post" action="/source-releases/deploy">'+
          '<input type="hidden" name="csrfToken" value="'+escapeHtml(csrf)+'">'+
          '<input type="hidden" name="sourceId" value="'+escapeHtml(source.id)+'">'+
          '<input type="hidden" name="releaseId" value="'+release.id+'">'+
          '<button type="submit">Build &amp; deploy</button></form>':
          '<span class="admin-subtext">Not deployable: release tag is not SemVer</span>';
        return '<article class="admin-release admin-source-release">'+
          '<div><span class="admin-kicker">'+(release.prerelease?"PRERELEASE":"PUBLISHED RELEASE")+'</span>'+
          '<h3>'+escapeHtml(release.tag)+'</h3><p>'+escapeHtml(release.name)+'</p></div>'+
          '<div><span class="admin-kicker">PUBLISHED</span><p class="admin-subtext">'+escapeHtml(release.publishedAt.slice(0,10))+'</p></div>'+
          '<div><p class="admin-subtext">'+escapeHtml(release.notes.slice(0,200))+'</p>'+workflow+'</div>'+
          '<div class="admin-actions">'+action+'</div></article>';
      }).join("");
    return '<section class="admin-section" aria-label="'+escapeHtml(source.label)+' GitHub releases">'+
      '<header class="admin-section-head"><div><span class="admin-kicker">SOURCE / '+escapeHtml(source.githubRepository)+'</span>'+
      '<h2>'+escapeHtml(source.label)+'</h2></div></header>'+entries+'</section>';
  }).join("");
}
