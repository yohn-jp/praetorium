import type { SourceBuildSummary } from "@praetorium/contracts";
import { createGitHubRestClient, GitHubApiError, type GitHubRestClient } from "@praetorium/github";
import type { GatewayContext } from "../context.js";
import { escapeHtml } from "../ui/presentation.js";

/** Operator-selected source registrations; no untrusted repository or workflow is executable. */
export interface RegisteredReleaseSource {
  readonly id: string;
  readonly label: string;
  readonly githubRepository: string;
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
export type SourceBuildStatus = SourceBuildSummary;

export type SourceRetryIdentityResult =
  | { readonly kind: "matched"; readonly sourceId: string; readonly githubReleaseId: number;
      readonly sourceTag: string; readonly sourceRevision: string; readonly releaseVersion: string }
  | { readonly kind: "conflict" | "forbidden" | "unavailable" };
export interface SourceReleaseView {
  readonly source: RegisteredReleaseSource;
  readonly releases: readonly PublishedSourceRelease[];
  readonly error: string | null;
  readonly endpoint: string;
  readonly status: number | null;
  readonly code: string | null;
}

const SHA = /^[0-9a-f]{40}$/u;
const GITHUB_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const TAG = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const MAX_RELEASES = 40;
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
      "id", "label", "githubRepository", "adapter",
    ].includes(k)) || typeof r.id !== "string" || !/^[a-z][a-z0-9-]{0,31}$/u.test(r.id) ||
        typeof r.label !== "string" || r.label.length < 1 || r.label.length > 64 ||
        typeof r.githubRepository !== "string" || !GITHUB_REPOSITORY.test(r.githubRepository) ||
        r.adapter !== "scriptorium-v1")
      throw new TypeError("Release source registration has invalid or unsupported entries");
    // Scriptorium's current signed producer adapter must only build Scriptorium.
    // Additional services require a separately verified producer adapter.
    if (r.adapter === "scriptorium-v1" && r.githubRepository !== "yohn-jp/scriptorium")
      throw new TypeError("Producer adapter cannot be retargeted to arbitrary GitHub source");
    return {
      id: r.id, label: r.label, githubRepository: r.githubRepository, adapter: r.adapter,
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
  return payload.map(parseRelease).filter((x): x is PublishedSourceRelease =>
    x !== null && x.version !== null && x.tag.startsWith("v"))
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

export async function fetchSourceReleases(
  source: RegisteredReleaseSource, client: GitHubRestClient, token: string,
): Promise<{releases: readonly PublishedSourceRelease[]}> {
  const response = await client.request(`/repos/${source.githubRepository}/releases?per_page=50`, token);
  return { releases: publishedReleases(response.body) };
}

export async function fetchSelectedRelease(
  source: RegisteredReleaseSource, releaseId: number, client: GitHubRestClient, token: string,
): Promise<{release: PublishedSourceRelease; commit: string}> {
  if (!Number.isSafeInteger(releaseId) || releaseId < 1) throw new TypeError("Invalid GitHub Release ID");
  const response = await client.request(`/repos/${source.githubRepository}/releases/${releaseId}`, token);
  const release = parseRelease(response.body);
  if (!release || release.id !== releaseId || release.version === null || !release.tag.startsWith("v"))
    throw new TypeError("Selected GitHub Release is unpublished or is not a deployable SemVer");
  const commit = await resolveTagCommit(source,release.tag,client,token);
  return {release,commit};
}

/** Re-fetch the published Release and resolved tag before an explicit Source retry. */
export async function revalidateSourceRetryIdentity(
  context: GatewayContext,
  userId: string,
  job: SourceBuildStatus,
): Promise<SourceRetryIdentityResult> {
  if (job.state !== "failed") return { kind: "conflict" };
  const source = configuredReleaseSources(context.env.PRAETORIUM_RELEASE_SOURCES_JSON)
    .find((value) => value.id === job.sourceId);
  if (!source) return { kind: "forbidden" };
  let token: string | null;
  try {
    token = await context.githubUserTokens.accessTokenFor(userId, context.requestNow);
  } catch {
    return { kind: "unavailable" };
  }
  if (!token) return { kind: "forbidden" };
  try {
    const selected = await fetchSelectedRelease(
      source, job.releaseId, createGitHubRestClient({ requestTimeoutMs: 8000 }), token,
    );
    if (selected.release.tag !== job.tag || selected.release.version !== job.version ||
        selected.commit !== job.commit) return { kind: "conflict" };
    return {
      kind: "matched", sourceId: source.id, githubReleaseId: selected.release.id,
      sourceTag: selected.release.tag, sourceRevision: selected.commit,
      releaseVersion: selected.release.version!,
    };
  } catch (error) {
    if (error instanceof GitHubApiError) {
      if (error.status === 401 || error.status === 403) return { kind: "forbidden" };
      if (error.status === 404 || error.status === 400 || error.status === 422) return { kind: "conflict" };
    }
    if (error instanceof TypeError && [
      "Selected GitHub Release is unpublished or is not a deployable SemVer",
      "Unsupported GitHub release tag",
      "Published tag does not resolve to a unique commit",
    ].includes(error.message)) return { kind: "conflict" };
    return { kind: "unavailable" };
  }
}


export type DispatchReleaseResult =
  | { readonly kind: "queued"; readonly job: SourceBuildStatus; readonly duplicate: boolean }
  | { readonly kind: "forbidden" }
  | { readonly kind: "conflict" }
  | { readonly kind: "unavailable" };

/** Source authority is GitHub; build/admission authority is Praetorium's Control Plane. */
export async function dispatchPublishedRelease(
  context: GatewayContext, userId: string, sourceId: string, releaseId: number,
): Promise<DispatchReleaseResult> {
  const source = configuredReleaseSources(context.env.PRAETORIUM_RELEASE_SOURCES_JSON)
    .find((value) => value.id === sourceId);
  if (!source) return { kind: "forbidden" };
  const token = await context.githubUserTokens.accessTokenFor(userId, context.requestNow);
  if (!token) return { kind: "unavailable" };
  const client = createGitHubRestClient({ requestTimeoutMs: 8000 });
  let selected: Awaited<ReturnType<typeof fetchSelectedRelease>>;
  try {
    selected = await fetchSelectedRelease(source, releaseId, client, token);
  } catch (error) {
    return { kind: error instanceof GitHubApiError && (error.status === 401 || error.status === 403)
      ? "forbidden" : "unavailable" };
  }
  let response: Response;
  try {
    response = await context.env.CONTROL_PLANE.fetch(
      "https://control-plane.internal/v1/operator/source-builds", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Control-Plane-Gateway-Auth": context.config.controlPlaneSecret,
          "X-Praetorium-Admin-Actor": userId,
        },
        body: JSON.stringify({
          sourceId: source.id, githubReleaseId: selected.release.id,
          sourceTag: selected.release.tag, sourceRevision: selected.commit,
          releaseVersion: selected.release.version,
        }),
      },
    );
  } catch { return { kind: "unavailable" }; }
  if (response.status === 409) return { kind: "conflict" };
  if (response.status === 401 || response.status === 403) return { kind: "forbidden" };
  if (response.status !== 200 && response.status !== 202) return { kind: "unavailable" };
  let body: unknown;
  try { body = await response.json(); } catch { return { kind: "unavailable" }; }
  const data = object(body), job = object(data?.job);
  if (!job || typeof job.id !== "string" || typeof job.state !== "string" ||
      job.releaseId !== selected.release.id || job.commit !== selected.commit ||
      typeof job.retryable !== "boolean") {
    return { kind: "unavailable" };
  }
  return { kind: "queued", job: job as unknown as SourceBuildStatus, duplicate: data?.duplicate === true };
}

export async function listRegisteredSources(
  context:GatewayContext,userId:string,
):Promise<readonly SourceReleaseView[]>{
  const sources=configuredReleaseSources(context.env.PRAETORIUM_RELEASE_SOURCES_JSON);
  if(!sources.length)return [];
  const token=await context.githubUserTokens.accessTokenFor(userId,context.requestNow);
  if(!token)return sources.map(source=>({
    source,releases:[],error:"GitHub authorization unavailable",
    endpoint:`GET /repos/${source.githubRepository}/releases`,status:null,code:"GITHUB_AUTH_UNAVAILABLE",
  }));
  const client=createGitHubRestClient({requestTimeoutMs:8000});
  return Promise.all(sources.map(async source=>{
    try{
      const result=await fetchSourceReleases(source,client,token);
      return {source,...result,error:null,endpoint:`GET /repos/${source.githubRepository}/releases`,status:200,code:null};
    }catch(e){
      const githubError=e instanceof GitHubApiError;
      const status=githubError?e.status:null;
      const err=githubError && (e.status===401||e.status===403)
        ? "GitHub App access to this repository is missing" : "GitHub Releases are temporarily unavailable";
      const code=githubError && (e.status===401||e.status===403)
        ? "GITHUB_ACCESS_MISSING" : githubError ? "GITHUB_RELEASES_UNAVAILABLE" : "GITHUB_API_UNAVAILABLE";
      return {source,releases:[],error:err,endpoint:`GET /repos/${source.githubRepository}/releases`,status,code};
    }
  }));
}

/** Markup is escaped even when Release titles and notes contain arbitrary Markdown/HTML. */
export function sourceReleaseCards(views:readonly SourceReleaseView[],csrf:string,builds:readonly SourceBuildStatus[]=[]):string {
  if(!views.length)return '<p class="admin-empty">No release sources registered. Configure trusted service sources in Wrangler.</p>';
  return views.map(({source,releases,error,endpoint,status,code})=>{
    const entries=error?'<p class="alert" role="status">'+escapeHtml(error)+
      ' Endpoint: <code>'+escapeHtml(endpoint)+'</code>; HTTP status: <code>'+
      escapeHtml(status===null?"unavailable":String(status))+'</code>; code: <code>'+
      escapeHtml(code??"GITHUB_RELEASES_UNAVAILABLE")+'</code>.</p>':
      releases.length===0?'<p class="admin-empty">No published GitHub Releases were found.</p>':
      releases.map(release=>{
        const build = builds.find(x => x.sourceId === source.id && x.releaseId === release.id);
        const progress = build ? '<p class="admin-subtext">Build Worker: ' + escapeHtml(build.state) +
          (build.error ? ' / ' + escapeHtml(build.error) : '') + '</p>' : '';
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
          '<div><p class="admin-subtext">'+escapeHtml(release.notes.slice(0,200))+'</p>'+progress+'</div>'+
          '<div class="admin-actions">'+action+'</div></article>';
      }).join("");
    return '<section class="admin-section" aria-label="'+escapeHtml(source.label)+' GitHub releases">'+
      '<header class="admin-section-head"><div><span class="admin-kicker">SOURCE / '+escapeHtml(source.githubRepository)+'</span>'+
      '<h2>'+escapeHtml(source.label)+'</h2></div></header>'+entries+'</section>';
  }).join("");
}
