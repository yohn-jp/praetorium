import type { GatewayContext } from "../context.js";
import { escapeHtml } from "../ui/presentation.js";
import { page } from "../ui/views/document.js";
import {
  authenticateAdmin, adminFormCsrf, boundedForm, completeAdminHandoff,
  logoutAdmin,
} from "./session.js";
import { generateToken } from "@praetorium/auth";
import {
  dispatchPublishedRelease, listRegisteredSources, revalidateSourceRetryIdentity,
  sourceReleaseCards, type SourceReleaseView, type SourceBuildStatus,
} from "./release-sources.js";

const RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;

type Summary = {
  release: { id: string; version: string; imageDigest: string; status: string; createdAt: string };
  workflow: {
    workflow: {
      state: string; revision: number; failureCode: string | null; attempts: number;
      nextAttemptAt: number | null;
    };
    build: { status: string; failure: { code: string } | null } | null;
  } | null;
};
type Audit = { actorId: string | null; action: string; outcome: string; occurredAt: number };

function response(status: number, message: string): Response {
  return new Response(message, { status, headers: {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
  } });
}
function localRedirect(path: string): Response {
  return new Response(null, { status: 303, headers: {
    Location: path, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
  } });
}
function csrfInput(token: string): string {
  return '<input type="hidden" name="csrfToken" value="' + escapeHtml(token) + '">';
}
function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function errorCode(value: unknown): string {
  if (!value || typeof value !== "object" || !("error" in value)) return "OPERATOR_UNAVAILABLE";
  const error = (value as { error: unknown }).error;
  const code = error && typeof error === "object" && "code" in error
    ? (error as { code: unknown }).code : null;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,89}$/u.test(code)
    ? code : "OPERATOR_UNAVAILABLE";
}
type SafeFailureReason = "schema_missing" | "binding_invalid" | "constraint" | "query_limit" | "provider_unavailable";
const FAILURE_REASON_COPY: Record<SafeFailureReason, string> = {
  schema_missing: "Required D1 schema is missing; check applied migrations.",
  binding_invalid: "The Control Plane binding is missing or invalid; check its configured binding.",
  constraint: "The database rejected the operation because a required data constraint was not satisfied.",
  query_limit: "The database rejected the operation at its configured query limit; review database capacity and query limits.",
  provider_unavailable: "The database provider is temporarily unavailable; retry after it recovers.",
};

function failureReason(value: unknown): SafeFailureReason | null {
  const reason = objectValue(objectValue(value)?.error)?.reason;
  return typeof reason === "string" && Object.hasOwn(FAILURE_REASON_COPY, reason)
    ? reason as SafeFailureReason : null;
}

async function controlPlane(
  context: GatewayContext, actorId: string, method: "GET" | "POST",
  path: string, payload?: unknown,
): Promise<{ status: number; data: unknown }> {
  const result = await context.env.CONTROL_PLANE.fetch("https://control-plane.internal" + path, {
    method,
    signal: AbortSignal.timeout(8_000),
    headers: {
      "X-Control-Plane-Gateway-Auth": context.config.controlPlaneSecret,
      "X-Praetorium-Admin-Actor": actorId,
      "Cache-Control": "no-store",
      ...(payload !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
  });
  const length = result.headers.get("Content-Length");
  if (length && (!/^[0-9]+$/u.test(length) || Number(length) > 256_000)) {
    throw new Error("Operator response too large");
  }
  let raw: string;
  try {
    raw = await boundedResponseText(result, 256_000);
  } catch {
    throw new Error("Operator response unavailable");
  }
  let data: unknown;
  try { data = JSON.parse(raw); } catch { data = null; }
  return { status: result.status, data };
}

async function boundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        try { await reader.cancel(); } catch { /* The byte limit remains authoritative. */ }
        throw new Error("Operator response too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

interface OperatorSection<T> {
  readonly endpoint: string;
  readonly status: number | null;
  readonly code: string | null;
  readonly reason?: SafeFailureReason | null;
  readonly value: T | null;
}

function sectionFailure(title: string, section: OperatorSection<unknown>): string {
  if (section.value !== null) return "";
  return '<p class="alert" role="status"><strong>' + escapeHtml(title) +
    ' unavailable.</strong> Endpoint: <code>' + escapeHtml(section.endpoint) +
    '</code>; HTTP status: <code>' + escapeHtml(section.status === null ? "unavailable" : String(section.status)) +
    '</code>; code: <code>' + escapeHtml(section.code ?? "OPERATOR_UNAVAILABLE") + '</code>.' +
    (section.reason ? ' Reason: <code>' + escapeHtml(section.reason) + '</code>. ' +
      escapeHtml(FAILURE_REASON_COPY[section.reason]) : "") + '</p>';
}

async function controlPlaneSection<T>(
  context: GatewayContext,
  actorId: string,
  endpoint: string,
  path: string,
  isValid: (value: unknown) => value is T,
): Promise<OperatorSection<T>> {
  try {
    const result = await controlPlane(context, actorId, "GET", path);
    if (result.status !== 200) return {
      endpoint, status: result.status, code: errorCode(result.data),
      reason: failureReason(result.data), value: null,
    };
    if (!isValid(result.data)) return {
      endpoint, status: result.status, code: "INVALID_RESPONSE", reason: null, value: null,
    };
    return { endpoint, status: result.status, code: null, reason: null, value: result.data };
  } catch {
    return { endpoint, status: null, code: "OPERATOR_UNAVAILABLE", reason: null, value: null };
  }
}

function isCatalog(value: unknown): value is {
  items: Summary[]; nextCursor?: string | null;
  stableChannel?: { currentReleaseId: string | null; revision: number } | null;
} {
  if (!value || typeof value !== "object") return false;
  const v = value as { items?: unknown };
  return Array.isArray(v.items);
}
function isAudit(value: unknown): value is { events: Audit[] } {
  return !!value && typeof value === "object" &&
    Array.isArray((value as { events?: unknown }).events);
}
function isSourceBuilds(value: unknown): value is { items: SourceBuildStatus[] } {
  return !!value && typeof value === "object" &&
    Array.isArray((value as { items?: unknown }).items);
}
function parseSourceBuildStatus(value: unknown): SourceBuildStatus | null {
  if (!value || typeof value !== "object") return null;
  const job = value as Partial<SourceBuildStatus>;
  if (typeof job.id !== "string" || !/^sr_[0-9a-f-]{36}$/u.test(job.id) ||
      typeof job.sourceId !== "string" || !/^[a-z][a-z0-9-]{0,31}$/u.test(job.sourceId) ||
      !Number.isSafeInteger(job.releaseId) || job.releaseId! < 1 ||
      typeof job.tag !== "string" || job.tag.length > 128 ||
      typeof job.commit !== "string" || !/^[0-9a-f]{40}$/u.test(job.commit) ||
      typeof job.version !== "string" || job.version.length > 128 ||
      !["queued", "building", "produced", "admitted", "failed"].includes(job.state ?? "") ||
      !Number.isSafeInteger(job.attempt) || job.attempt! < 0 ||
      !Number.isSafeInteger(job.revision) || job.revision! < 0 ||
      !(job.error === null || typeof job.error === "string") ||
      !(job.admittedReleaseId === null || typeof job.admittedReleaseId === "string")) return null;
  return job as SourceBuildStatus;
}
function statusTone(state: string): string {
  return ["available", "complete", "promoted", "succeeded"].includes(state) ? "status-good"
    : ["blocked", "failed", "rejected"].includes(state) ? "status-bad" : "status-warn";
}
function releaseRow(input: Summary, csrf: string): string {
  const r = input.release;
  const workflow = input.workflow?.workflow;
  const state = workflow?.state ?? r.status;
  const revision = workflow?.revision;
  // Canonical retry only accepts a failed pre-runtime canary build. Other
  // blocked states require investigation, not an ineligible retry button.
  const preRuntimeFailure = (state === "blocked" && workflow?.failureCode === "canary_build_failed") ||
    (state === "canary_building" && workflow?.failureCode === null);
  const retryable = revision !== undefined && Number.isSafeInteger(revision) &&
    preRuntimeFailure && input.workflow?.build?.status === "failed";
  const retry = retryable
    ? '<form method="post" action="/releases/' + encodeURIComponent(r.id) + '/retry">' +
      csrfInput(csrf) +
      '<input type="hidden" name="expectedRevision" value="' + revision + '">' +
      '<input type="hidden" name="idempotencyKey" value="' + generateToken(128) + '">' +
      '<button class="button button-secondary" type="submit">Retry Canary build</button></form>'
    : "";
  const issue = workflow?.failureCode ?? input.workflow?.build?.failure?.code ?? "";
  return '<article class="admin-release">' +
    '<div><span class="admin-kicker">PRODUCER / RELEASE</span>' +
    '<h3><a href="/releases/' + encodeURIComponent(r.id) + '">' + escapeHtml(r.version) + '</a></h3>' +
    '<p class="admin-subtext"><code>' + escapeHtml(r.id) + '</code></p></div>' +
    '<div class="admin-release-state"><span class="status-badge ' + statusTone(state) + '">' +
    escapeHtml(state.replaceAll("_", " ")) + '</span>' +
    '<p class="admin-subtext">' + escapeHtml(r.status) + '</p></div>' +
    '<div><span class="admin-kicker">OCI IMAGE</span><code class="admin-digest">' +
    escapeHtml(r.imageDigest) + '</code>' +
    (issue ? '<p class="alert" role="status">' + escapeHtml(issue) + '</p>' : '') +
    '</div><div class="admin-actions">' + retry + '</div></article>';
}
function auditRows(events: readonly Audit[]): string {
  if (events.length === 0) return '<p class="admin-empty">No release operator events recorded.</p>';
  return '<ol class="admin-audit-list">' + events.map(event => {
    const when = new Date(event.occurredAt);
    const timestamp = Number.isFinite(when.getTime())
      ? when.toISOString().slice(0, 19).replace("T", " ") + " UTC"
      : "Time unavailable";
    return '<li><span class="admin-audit-time">' + timestamp +
      '</span><strong>' + escapeHtml(event.action) + '</strong>' +
      '<span class="status-badge ' + statusTone(event.outcome) + '">' +
      escapeHtml(event.outcome) + '</span></li>';
  }).join("") + '</ol>';
}

function sourceBuildRows(section: OperatorSection<{ items: SourceBuildStatus[] }>, csrf: string): string {
  if (!section.value) return sectionFailure("Source build queue", section);
  const jobs = section.value.items.slice(0, 40);
  if (!jobs.length) return '<p class="admin-empty">No Source builds have been queued.</p>';
  return '<div class="admin-source-builds">' + jobs.map(job => {
    const retry = job.state === "failed" && Number.isSafeInteger(job.revision) && job.revision >= 0
      ? '<form method="post" action="/source-builds/' + encodeURIComponent(job.id) + '/retry">' +
        csrfInput(csrf) +
        '<input type="hidden" name="expectedRevision" value="' + job.revision + '">' +
        '<input type="hidden" name="idempotencyKey" value="' + generateToken(128) + '">' +
        '<button class="button button-secondary" type="submit">Retry Source build</button></form>'
      : "";
    return '<article class="admin-release"><div><span class="admin-kicker">SOURCE BUILD</span>' +
      '<h3>' + escapeHtml(job.sourceId) + ' / ' + escapeHtml(job.tag) + '</h3>' +
      '<p class="admin-subtext"><code>' + escapeHtml(job.id) + '</code></p></div>' +
      '<div><span class="admin-kicker">STATE / ATTEMPT</span><p>' + escapeHtml(job.state) +
      ' / ' + escapeHtml(String(job.attempt)) + '</p></div>' +
      '<div>' + (job.error ? '<p class="alert" role="status">' + escapeHtml(job.error) + '</p>' :
        '<p class="admin-subtext">' + escapeHtml(job.commit) + '</p>') + '</div>' +
      '<div class="admin-actions">' + retry + '</div></article>';
  }).join("") + '</div>';
}

function adminPage(title: string, content: string, csrf: string): Response {
  const body = '<div class="admin-console">' +
    '<header class="admin-bar"><a class="admin-logo" href="/"><span class="admin-mark">P</span>' +
    '<span>Praetorium <em>Admin</em></span></a><nav aria-label="Admin navigation">' +
    '<a href="/">Releases</a><a href="https://praetorium.yohn.jp/">Workspace</a></nav>' +
    '<form method="post" action="/logout">' + csrfInput(csrf) +
    '<button class="button button-secondary" type="submit">Sign out</button></form></header>' +
    '<div class="admin-main"><div class="admin-heading"><span class="admin-kicker">OPERATOR / CONTROL PLANE</span>' +
    '<h1>' + escapeHtml(title) + '</h1><p>Immutable release admission and promotion evidence.</p></div>' +
    content + '</div><footer class="admin-footer">Praetorium / Operator-authorized actions only</footer></div>';
  return page("Praetorium Admin — " + title, body, { layout: "handoff" });
}
function overview(
  catalog: OperatorSection<{ items: Summary[]; nextCursor?: string | null;
    stableChannel?: { currentReleaseId: string | null; revision: number } | null }>,
  audit: OperatorSection<{ events: Audit[] }>,
  sourceViews: OperatorSection<readonly SourceReleaseView[]>,
  sourceBuilds: OperatorSection<{ items: SourceBuildStatus[] }>,
  csrf: string,
  notice: string | null,
): Response {
  const items = catalog.value?.items ?? [];
  const events = audit.value?.events ?? [];
  const cursor = catalog.value?.nextCursor ?? null;
  const stableReleaseId = catalog.value?.stableChannel?.currentReleaseId ?? null;
  const builds = sourceBuilds.value?.items ?? [];
  const available = items.filter(item => item.release.status === "available").length;
  const waiting = items.filter(item => item.release.status !== "available").length;
  const rows = items.length ? items.map(item => releaseRow(item, csrf)).join("")
    : '<div class="admin-empty">No admitted releases yet. Choose a published service version above.</div>';
  const next = cursor && cursor.length <= 512 && /^(?:[A-Za-z0-9_.~:-]|%[0-9A-Fa-f]{2})+$/u.test(cursor)
    ? '<a class="button button-secondary" href="/?cursor=' + encodeURIComponent(cursor) +
      '">Older releases</a>' : "";
  const metrics = catalog.value
    ? '<div class="admin-metrics"><div><strong>' + items.length + '</strong><span>Visible releases</span></div>' +
      '<div><strong>' + available + '</strong><span>Available</span></div>' +
      '<div><strong>' + waiting + '</strong><span>In admission / promotion</span></div></div>'
    : sectionFailure("Release ledger", catalog);
  const sourceCards = sourceViews.value
    ? sourceReleaseCards(sourceViews.value, csrf, builds)
    : sectionFailure("GitHub Release catalog", sourceViews);
  const ledger = catalog.value ? rows + next : sectionFailure("Release ledger", catalog);
  const auditContent = audit.value ? auditRows(events) : sectionFailure("Operator audit", audit);
  return adminPage("Release administration",
    (notice ? '<p class="admin-notice" role="status">' + escapeHtml(notice) + '</p>' : '') +
    metrics +
    '<div class="admin-stable"><span class="admin-kicker">CURRENT STABLE CHANNEL</span>' +
    '<strong>' + escapeHtml(catalog.value ? stableReleaseId ?? "No release promoted yet" : "Unavailable") + '</strong></div>' +
    '<section class="admin-section" aria-label="Source release selection">' +
    '<header class="admin-section-head"><div><span class="admin-kicker">01 / GITHUB RELEASES</span>' +
    '<h2>Deploy a published version</h2></div></header>' +
    '<p class="admin-subtext">Select a published GitHub Release. Praetorium resolves its exact commit and runs the signed Producer, OCI admission, Canary and Stable promotion. The GitHub Actions result alone does not mean Stable.</p>' +
    sourceCards + '</section>' +
    '<section class="admin-section" aria-labelledby="admin-releases-title"><header class="admin-section-head">' +
    '<div><span class="admin-kicker">02 / PLATFORM RELEASES</span><h2 id="admin-releases-title">Release ledger</h2></div>' +
    '<a class="button button-secondary" href="/">Refresh status</a></header>' + ledger + '</section>' +
    '<section class="admin-section" aria-labelledby="admin-source-builds-title"><header class="admin-section-head">' +
    '<div><span class="admin-kicker">03 / SOURCE BUILD WORKERS</span><h2 id="admin-source-builds-title">Source build queue</h2></div>' +
    '</header>' + sourceBuildRows(sourceBuilds, csrf) + '</section>' +
    '<section class="admin-section" aria-labelledby="admin-audit-title"><header class="admin-section-head">' +
    '<div><span class="admin-kicker">04 / AUDIT</span><h2 id="admin-audit-title">Recent operator events</h2></div>' +
    '</header>' + auditContent + '</section>',
    csrf);
}

export async function handleAdminHost(request: Request, context: GatewayContext): Promise<Response> {
  const origin = context.config.adminOrigin;
  if (!origin || new URL(request.url).origin !== origin) return response(404, "Not found");
  const url = new URL(request.url);
  if (url.pathname === "/signed-out" && request.method === "GET") {
    return page("Praetorium Admin — Signed out",
      '<section class="signin-panel" aria-labelledby="admin-signed-out">' +
      '<div class="signin-mark" aria-hidden="true">P</div>' +
      '<p class="signin-kicker">OPERATOR / SESSION</p>' +
      '<h1 id="admin-signed-out">Signed out of Admin</h1>' +
      '<p class="signin-description">Your administration session has ended. Your repository workspace session was not changed.</p>' +
      '<a class="button signin-action" href="/">Sign in to Admin</a></section>',
      { layout: "handoff" });
  }
  if (url.pathname === "/_admin/handoff" && request.method === "POST")
    return completeAdminHandoff(request, context);

  const session = await authenticateAdmin(request, context);
  if (!session) {
    // No operator data, application state or Control Plane calls before authentication.
    if (url.pathname === "/" && request.method === "GET") {
      return localRedirect(context.config.origin + "/_admin/entry");
    }
    return response(403, "Operator authorization required");
  }

  if (url.pathname === "/logout" && request.method === "POST") {
    const form = await boundedForm(request);
    if (!form || !(await adminFormCsrf(request, context, session, form))) return response(403, "CSRF rejected");
    return logoutAdmin(request, context, session);
  }

  if (request.method === "POST") {
    const isSourceDeploy = url.pathname === "/source-releases/deploy";
    const retryMatch = /^\/releases\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})\/retry$/u.exec(url.pathname);
    const sourceRetryMatch = /^\/source-builds\/(sr_[0-9a-f-]{36})\/retry$/u.exec(url.pathname);
    if (!isSourceDeploy && !retryMatch && !sourceRetryMatch) return response(404, "Not found");
    const form = await boundedForm(request);
    if (!form || !(await adminFormCsrf(request, context, session, form))) return response(403, "CSRF rejected");
    if (sourceRetryMatch) {
      const revision = form.getAll("expectedRevision");
      const idempotencyKey = form.getAll("idempotencyKey");
      if (revision.length !== 1 || !/^(0|[1-9][0-9]*)$/u.test(revision[0]!) ||
          idempotencyKey.length !== 1 || !RELEASE_ID.test(idempotencyKey[0]!) ||
          [...form.keys()].some(key => !["csrfToken", "expectedRevision", "idempotencyKey"].includes(key)))
        return response(400, "Invalid Source retry command");
      const jobId = sourceRetryMatch[1]!;
      try {
        const loaded = await controlPlane(context, session.actor.userId, "GET",
          "/v1/operator/source-builds/" + encodeURIComponent(jobId));
        if (loaded.status !== 200) {
          return renderError(context, session.csrfToken, errorCode(loaded.data), loaded.status);
        }
        const job = parseSourceBuildStatus(objectValue(loaded.data)?.job);
        if (!job || job.id !== jobId) {
          return renderError(context, session.csrfToken, "Invalid Source build status", 503);
        }
        if (job.revision !== Number(revision[0])) {
          return renderError(context, session.csrfToken, "Source build changed. Refresh the queue.", 409);
        }
        const identity = await revalidateSourceRetryIdentity(context, session.actor.userId, job);
        if (identity.kind !== "matched") {
          const status = identity.kind === "forbidden" ? 403
            : identity.kind === "unavailable" ? 503 : 409;
          const message = identity.kind === "forbidden" ? "GitHub Release access is unavailable"
            : identity.kind === "unavailable" ? "Published GitHub Release is temporarily unavailable"
              : "Published Source identity changed. Refresh the queue.";
          return renderError(context, session.csrfToken, message, status);
        }
        const accepted = await controlPlane(context, session.actor.userId, "POST",
          "/v1/operator/source-builds/" + encodeURIComponent(jobId) + "/retry", {
            sourceId: identity.sourceId,
            githubReleaseId: identity.githubReleaseId,
            sourceTag: identity.sourceTag,
            sourceRevision: identity.sourceRevision,
            releaseVersion: identity.releaseVersion,
            expectedRevision: job.revision,
            idempotencyKey: idempotencyKey[0],
          });
        if (![200, 202].includes(accepted.status)) {
          return renderError(context, session.csrfToken, errorCode(accepted.data), accepted.status);
        }
        return localRedirect("/?notice=" + encodeURIComponent("Source retry accepted for " + jobId));
      } catch {
        return renderError(context, session.csrfToken, "Source retry authority unavailable", 503);
      }
    }
    if (isSourceDeploy) {
      const sources = form.getAll("sourceId");
      const releases = form.getAll("releaseId");
      if (sources.length !== 1 || releases.length !== 1 ||
          !/^[a-z][a-z0-9-]{0,31}$/u.test(sources[0]!) ||
          !/^[1-9][0-9]{0,15}$/u.test(releases[0]!) ||
          !Number.isSafeInteger(Number(releases[0])) ||
          [...form.keys()].some(key => !["csrfToken", "sourceId", "releaseId"].includes(key)))
        return response(400, "Invalid selected GitHub Release");
      try {
        const result = await dispatchPublishedRelease(context,session.actor.userId,sources[0]!,Number(releases[0]));
        if (result.kind === "forbidden") return renderError(context, session.csrfToken,
          "Operator authorization or GitHub Release access is unavailable", 403);
        if (result.kind === "unavailable") return renderError(context, session.csrfToken,
          "Praetorium source build admission unavailable. Check Control Plane and Build Worker.", 503);
        if (result.kind === "conflict") return renderError(context, session.csrfToken,
          "GitHub Release source identity changed. Refresh releases.", 409);
        return localRedirect("/?notice=" + encodeURIComponent(
          result.duplicate ? "This source build was already accepted by Control Plane."
            : "Source build queued in Praetorium (" + result.job.id + "). Verify its worker progress below.",
        ));
      } catch {
        return renderError(context, session.csrfToken, "Release dispatch authority unavailable", 503);
      }
    }
    try {
      const id = retryMatch![1]!;
      const revision = form.getAll("expectedRevision");
      const idempotencyKey = form.getAll("idempotencyKey");
      if (revision.length !== 1 || !/^(0|[1-9][0-9]*)$/.test(revision[0]!) ||
          idempotencyKey.length !== 1 || !RELEASE_ID.test(idempotencyKey[0]!) ||
          [...form.keys()].some(key => !["csrfToken", "expectedRevision", "idempotencyKey"].includes(key)))
        return response(400, "Invalid retry command");
      const accepted = await controlPlane(context, session.actor.userId, "POST",
        "/v1/operator/releases/" + encodeURIComponent(id) + "/retry", {
          expectedRevision: Number(revision[0]), idempotencyKey: idempotencyKey[0],
        });
      if (![200, 202].includes(accepted.status))
        return renderError(context, session.csrfToken, errorCode(accepted.data), accepted.status);
      return localRedirect("/?notice=" + encodeURIComponent("Retry accepted for " + id));
    } catch {
      return renderError(context, session.csrfToken, "Control Plane unavailable", 503);
    }
  }

  if (request.method !== "GET") return response(405, "Method not allowed");
  if (url.pathname.startsWith("/releases/")) {
    const id = url.pathname.slice("/releases/".length);
    if (!RELEASE_ID.test(id)) return response(404, "Not found");
    try {
      const record = await controlPlane(context, session.actor.userId, "GET",
        "/v1/operator/releases/" + encodeURIComponent(id));
      if (record.status !== 200) return renderError(context, session.csrfToken, errorCode(record.data), record.status);
      return adminPage("Release " + id,
        '<p><a class="button button-secondary" href="/">Back to release ledger</a></p>' +
        '<section class="admin-section"><span class="admin-kicker">CANONICAL RELEASE STATUS</span>' +
        '<pre class="admin-json">' + escapeHtml(JSON.stringify(record.data, null, 2)) + '</pre></section>',
        session.csrfToken);
    } catch { return renderError(context, session.csrfToken, "Control Plane unavailable", 503); }
  }
  if (url.pathname !== "/") return response(404, "Not found");
  const cursor = url.searchParams.get("cursor");
  if (cursor && (cursor.length > 512 || !/^(?:[A-Za-z0-9_.~:-]|%[0-9A-Fa-f]{2})+$/u.test(cursor)))
    return response(400, "Invalid cursor");
  const [catalogResult, auditResult, sourceBuildResult, sourceViewsResult] = await Promise.all([
    controlPlaneSection(context, session.actor.userId, "GET /v1/operator/releases",
      "/v1/operator/releases" + (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""), isCatalog),
    controlPlaneSection(context, session.actor.userId, "GET /v1/operator/releases/audit",
      "/v1/operator/releases/audit", isAudit),
    controlPlaneSection(context, session.actor.userId, "GET /v1/operator/source-builds",
      "/v1/operator/source-builds", isSourceBuilds),
    listRegisteredSources(context, session.actor.userId).then(
      (value): OperatorSection<readonly SourceReleaseView[]> =>
        ({ endpoint: "GitHub Releases / configured sources", status: 200, code: null, value }),
      (): OperatorSection<readonly SourceReleaseView[]> => ({ endpoint: "GitHub Releases / configured sources", status: null,
        code: "SOURCE_CATALOG_UNAVAILABLE", value: null }),
    ),
  ]);
  const catalog: OperatorSection<{
    items: Summary[]; nextCursor?: string | null;
    stableChannel?: { currentReleaseId: string | null; revision: number } | null;
  }> = { ...catalogResult, value: catalogResult.value ? {
    ...catalogResult.value, items: catalogResult.value.items.slice(0, 25),
  } : null };
  const audit: OperatorSection<{ events: Audit[] }> = { ...auditResult, value: auditResult.value ? {
    events: auditResult.value.events.slice(0, 25),
  } : null };
  const sourceBuilds: OperatorSection<{ items: SourceBuildStatus[] }> = {
    ...sourceBuildResult, value: sourceBuildResult.value ? {
      items: sourceBuildResult.value.items.slice(0, 40),
    } : null,
  };
  return overview(catalog, audit, sourceViewsResult, sourceBuilds, session.csrfToken,
    url.searchParams.get("notice")?.slice(0, 200) ?? null);
}

function renderError(context: GatewayContext, csrf: string, message: string, status: number): Response {
  const pageResult = adminPage("Operator action unavailable",
    '<p class="alert" role="alert">' + escapeHtml(message) + '</p>' +
    '<p><a class="button button-secondary" href="/">Return to release ledger</a></p>', csrf);
  void context;
  return new Response(pageResult.body, { status, headers: pageResult.headers });
}
