import type { GatewayContext } from "../context.js";
import { escapeHtml } from "../ui/presentation.js";
import { page } from "../ui/views/document.js";
import {
  authenticateAdmin, adminFormCsrf, boundedForm, completeAdminHandoff,
  logoutAdmin,
} from "./session.js";
import { generateToken } from "@praetorium/auth";
import { dispatchPublishedRelease, listRegisteredSources, sourceReleaseCards, type SourceReleaseView } from "./release-sources.js";

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
function str(value: unknown, limit = 256): string {
  return typeof value === "string" ? value.slice(0, limit) : "";
}
function errorCode(value: unknown): string {
  if (!value || typeof value !== "object" || !("error" in value)) return "OPERATOR_UNAVAILABLE";
  const error = (value as { error: unknown }).error;
  return error && typeof error === "object" && "code" in error
    ? str((error as { code: unknown }).code, 90) : "OPERATOR_UNAVAILABLE";
}

async function controlPlane(
  context: GatewayContext, actorId: string, method: "GET" | "POST",
  path: string, payload?: unknown,
): Promise<{ status: number; data: unknown }> {
  const result = await context.env.CONTROL_PLANE.fetch("https://control-plane.internal" + path, {
    method,
    headers: {
      "X-Control-Plane-Gateway-Auth": context.config.controlPlaneSecret,
      "X-Praetorium-Admin-Actor": actorId,
      "Cache-Control": "no-store",
      ...(payload !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
  });
  const length = result.headers.get("Content-Length");
  if (length && Number(length) > 256_000) throw new Error("Operator response too large");
  const raw = await result.text();
  if (raw.length > 256_000) throw new Error("Operator response too large");
  let data: unknown;
  try { data = JSON.parse(raw); } catch { data = null; }
  return { status: result.status, data };
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
  items: readonly Summary[], events: readonly Audit[], csrf: string, cursor: string | null,
  stableReleaseId: string | null, notice: string | null, sourceViews: readonly SourceReleaseView[],
): Response {
  const available = items.filter(item => item.release.status === "available").length;
  const waiting = items.filter(item => item.release.status !== "available").length;
  const rows = items.length ? items.map(item => releaseRow(item, csrf)).join("")
    : '<div class="admin-empty">No admitted releases yet. Choose a published service version above.</div>';
  const next = cursor && cursor.length <= 512 && /^(?:[A-Za-z0-9_.~:-]|%[0-9A-Fa-f]{2})+$/u.test(cursor)
    ? '<a class="button button-secondary" href="/?cursor=' + encodeURIComponent(cursor) +
      '">Older releases</a>' : "";
  return adminPage("Release administration",
    (notice ? '<p class="admin-notice" role="status">' + escapeHtml(notice) + '</p>' : '') +
    '<div class="admin-metrics"><div><strong>' + items.length + '</strong><span>Visible releases</span></div>' +
    '<div><strong>' + available + '</strong><span>Available</span></div>' +
    '<div><strong>' + waiting + '</strong><span>In admission / promotion</span></div></div>' +
    '<div class="admin-stable"><span class="admin-kicker">CURRENT STABLE CHANNEL</span>' +
    '<strong>' + escapeHtml(stableReleaseId ?? "No release promoted yet") + '</strong></div>' +
    '<section class="admin-section" aria-label="Source release selection">' +
    '<header class="admin-section-head"><div><span class="admin-kicker">01 / GITHUB RELEASES</span>' +
    '<h2>Deploy a published version</h2></div></header>' +
    '<p class="admin-subtext">Select a published GitHub Release. Praetorium resolves its exact commit and runs the signed Producer, OCI admission, Canary and Stable promotion. The GitHub Actions result alone does not mean Stable.</p>' +
    sourceReleaseCards(sourceViews,csrf) + '</section>' +
    '<section class="admin-section" aria-labelledby="admin-releases-title"><header class="admin-section-head">' +
    '<div><span class="admin-kicker">02 / PLATFORM RELEASES</span><h2 id="admin-releases-title">Release ledger</h2></div>' +
    '<a class="button button-secondary" href="/">Refresh status</a></header>' + rows + next + '</section>' +
    '<section class="admin-section" aria-labelledby="admin-audit-title"><header class="admin-section-head">' +
    '<div><span class="admin-kicker">03 / AUDIT</span><h2 id="admin-audit-title">Recent operator events</h2></div>' +
    '</header>' + auditRows(events) + '</section>',
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
    if (!isSourceDeploy && !retryMatch) return response(404, "Not found");
    const form = await boundedForm(request);
    if (!form || !(await adminFormCsrf(request, context, session, form))) return response(403, "CSRF rejected");
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
          "GitHub App Actions:write permission or service release authority is unavailable", 403);
        if (result.kind === "unavailable") return renderError(context, session.csrfToken,
          "GitHub Release dispatch unavailable. Check Actions access and workflow configuration.", 503);
        if (result.kind === "duplicate") return localRedirect("/?notice=" +
          encodeURIComponent("This GitHub Release was already selected for a Producer build. Check its Actions status."));
        return localRedirect("/?notice=" + encodeURIComponent(
          "Producer dispatched for " + result.tag + " (" + result.commit.slice(0,12) +
          "). Build/sign/publish/admission and Canary/Stable now run through their verified stages.",
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
  try {
    const [catalog, audit, sourceViews] = await Promise.all([
      controlPlane(context, session.actor.userId, "GET",
        "/v1/operator/releases" + (cursor ? "?cursor=" + encodeURIComponent(cursor) : "")),
      controlPlane(context, session.actor.userId, "GET", "/v1/operator/releases/audit"),
      listRegisteredSources(context, session.actor.userId),
    ]);
    if (catalog.status !== 200 || audit.status !== 200)
      return renderError(context, session.csrfToken,
        "Release authority unavailable: " + errorCode(catalog.status !== 200 ? catalog.data : audit.data), 503);
    const data = catalog.data as { items?: Summary[]; nextCursor?: string | null;
      stableChannel?: { currentReleaseId: string | null; revision: number } | null };
    const audited = audit.data as { events?: Audit[] };
    if (!Array.isArray(data?.items) || !Array.isArray(audited?.events))
      return renderError(context, session.csrfToken, "Invalid release authority response", 503);
    return overview(data.items.slice(0, 25), audited.events.slice(0, 25), session.csrfToken,
      data.nextCursor ?? null, data.stableChannel?.currentReleaseId ?? null,
      url.searchParams.get("notice")?.slice(0, 200) ?? null, sourceViews);
  } catch {
    return renderError(context, session.csrfToken, "Control Plane temporarily unavailable", 503);
  }
}

function renderError(context: GatewayContext, csrf: string, message: string, status: number): Response {
  const pageResult = adminPage("Operator action unavailable",
    '<p class="alert" role="alert">' + escapeHtml(message) + '</p>' +
    '<p><a class="button button-secondary" href="/">Return to release ledger</a></p>', csrf);
  void context;
  return new Response(pageResult.body, { status, headers: pageResult.headers });
}
