import type { GatewayContext } from "../context.js";
import { escapeHtml, resolvePresentation } from "../ui/presentation.js";
import { SourceBuildDetailSchema, SourceBuildSummarySchema, type SourceBuildDetail } from "@praetorium/contracts";
import { renderDesktopConsole } from "./desktop.js";
import { renderMobileConsole } from "./mobile.js";
import { buildHref, type ConsoleViewModel, type ConsoleMode, type ConsoleSection, type ConsoleReleaseStatus, type ConsoleOperationEvidence } from "./view-model.js";
import { page } from "../ui/views/document.js";
import {
  authenticateAdmin, adminFormCsrf, boundedForm, completeAdminHandoff,
  logoutAdmin,
} from "./session.js";
import {
  dispatchPublishedRelease, listRegisteredSources, revalidateSourceRetryIdentity,
  type SourceReleaseView, type SourceBuildStatus,
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

function validPageCursor(value: unknown): boolean {
  const cursor = objectValue(value)?.nextCursor;
  return cursor === undefined || cursor === null || (typeof cursor === "string" && cursor.length <= 512 &&
    /^(?:[A-Za-z0-9_.~:-]|%[0-9A-Fa-f]{2})+$/u.test(cursor));
}
function isCatalog(value: unknown): value is {
  items: Summary[]; nextCursor?: string | null;
  stableChannel?: { currentReleaseId: string | null; revision: number } | null;
} {
  const data = objectValue(value);
  if (!data || !validPageCursor(value) || !Array.isArray(data.items) || data.items.length > 25) return false;
  const stable = objectValue(data.stableChannel);
  if (data.stableChannel !== undefined && data.stableChannel !== null &&
      (!stable || !(stable.currentReleaseId === null || typeof stable.currentReleaseId === "string") ||
        !Number.isSafeInteger(stable.revision))) return false;
  return data.items.every(item => {
    const row = objectValue(item), release = objectValue(row?.release);
    if (!release || !["id", "version", "imageDigest", "status", "createdAt"].every(key => typeof release[key] === "string")) return false;
    if (row?.workflow === null) return true;
    const status = objectValue(row?.workflow), workflow = objectValue(status?.workflow), build = objectValue(status?.build);
    return !!workflow && typeof workflow.state === "string" && Number.isSafeInteger(workflow.revision) &&
      Number.isSafeInteger(workflow.attempts) && (workflow.failureCode === null || typeof workflow.failureCode === "string") &&
      (workflow.nextAttemptAt === null || Number.isSafeInteger(workflow.nextAttemptAt)) &&
      (status?.build === null || (!!build && typeof build.status === "string" &&
        (build.failure === null || typeof objectValue(build.failure)?.code === "string")));
  });
}
function isAudit(value: unknown): value is { events: Audit[]; nextCursor?: string | null } {
  return !!value && typeof value === "object" && validPageCursor(value) &&
    Array.isArray((value as { events?: unknown }).events) &&
    (value as { events: unknown[] }).events.length <= 25 &&
    (value as { events: unknown[] }).events.every(item => {
      const event = objectValue(item);
      return event && typeof event.action === "string" && typeof event.outcome === "string" &&
        (event.actorId === null || typeof event.actorId === "string") && Number.isSafeInteger(event.occurredAt);
    });
}
function isSourceBuilds(value: unknown): value is { items: SourceBuildStatus[]; nextCursor?: string | null } {
  return !!value && typeof value === "object" && validPageCursor(value) &&
    Array.isArray((value as { items?: unknown }).items) &&
    (value as {items: unknown[]}).items.length <= 40 &&
    (value as {items: unknown[]}).items.every(item => SourceBuildSummarySchema.safeParse(item).success);
}
function parseSourceBuildStatus(value: unknown): SourceBuildStatus | null {
  const result = SourceBuildSummarySchema.safeParse(value);
  return result.success ? result.data : null;
}
function adminPage(title: string, content: string, csrf: string, mode: ConsoleMode = "desktop"): Response {
  return page("Praetorium Admin — " + title,
    '<div class="admin-console"><header class="admin-bar"><a href="/?ui=' + mode + '">Praetorium Admin</a>' +
    '<form method="post" action="/logout"><input type="hidden" name="csrfToken" value="' + escapeHtml(csrf) +
    '"><button type="submit">Sign out</button></form></header><div class="admin-main"><h1>' + escapeHtml(title) +
    '</h1>' + content + '</div></div>', { layout: "handoff", presentation: { mode } });
}

export async function handleAdminHost(request: Request, context: GatewayContext): Promise<Response> {
  const presentation = resolvePresentation(request);
  const result = await handleAdminRequest(request, context, presentation.mode);
  if (!presentation.cookie) return result;
  const headers = new Headers(result.headers);
  headers.append("Set-Cookie", presentation.cookie);
  return new Response(result.body, { status: result.status, headers });
}

async function handleAdminRequest(request: Request, context: GatewayContext, mode: ConsoleMode): Promise<Response> {
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
    if (request.method === "GET" &&
        (url.pathname === "/" || url.pathname === "/builds" || url.pathname === "/releases" ||
         url.pathname === "/audit" || /^\/builds\/sr_[0-9a-f-]{36}$/u.test(url.pathname) ||
         /^\/releases\/[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(url.pathname))) {
      const destination=url.pathname+url.search;
      const redirect=localRedirect(context.config.origin + "/_admin/entry");
      if (destination.length<=512 && !/[\r\n]/u.test(destination))
        redirect.headers.append("Set-Cookie",
          "__Host-praetorium_admin_return="+encodeURIComponent(destination)+
          "; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=300");
      return redirect;
    }
    return response(403, "Operator authorization required");
  }

  const actionError = (message: string, status: number) => renderError(context, session.csrfToken, message, status, mode);
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
      const sourceActionError = (message: string, status: number) =>
        renderError(context, session.csrfToken, message, status, mode, buildHref(jobId, mode));
      try {
        const loaded = await controlPlane(context, session.actor.userId, "GET",
          "/v1/operator/source-builds/" + encodeURIComponent(jobId));
        if (loaded.status !== 200) {
          return sourceActionError(errorCode(loaded.data), loaded.status);
        }
        const job = parseSourceBuildStatus(objectValue(loaded.data)?.job);
        if (!job || job.id !== jobId) {
          return sourceActionError("Invalid Source build status", 503);
        }
        if (job.revision !== Number(revision[0])) {
          return sourceActionError("Source build changed. Refresh the queue.", 409);
        }
        if (job.state !== "failed" || !job.retryable) {
          return sourceActionError("This Source failure cannot be retried.", 409);
        }
        const identity = await revalidateSourceRetryIdentity(context, session.actor.userId, job);
        if (identity.kind !== "matched") {
          const status = identity.kind === "forbidden" ? 403
            : identity.kind === "unavailable" ? 503 : 409;
          const message = identity.kind === "forbidden" ? "GitHub Release access is unavailable"
            : identity.kind === "unavailable" ? "Published GitHub Release is temporarily unavailable"
              : "Published Source identity changed. Refresh the queue.";
          return sourceActionError(message, status);
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
          return sourceActionError(errorCode(accepted.data), accepted.status);
        }
        return localRedirect(buildHref(jobId, mode) + "&notice=" + encodeURIComponent("Source retry accepted for " + jobId));
      } catch {
        return sourceActionError("Source retry authority unavailable", 503);
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
        if (result.kind === "forbidden") return actionError(
          "Operator authorization or GitHub Release access is unavailable", 403);
        if (result.kind === "unavailable") return actionError(
          "Praetorium source build admission unavailable. Check Control Plane and Build Worker.", 503);
        if (result.kind === "conflict") return actionError(
          "GitHub Release source identity changed. Refresh releases.", 409);
        return localRedirect(buildHref(result.job.id, mode) + "&notice=" + encodeURIComponent(
          result.duplicate ? "This source build was already accepted by Control Plane."
            : "Source build queued in Praetorium (" + result.job.id + "). Open its current execution status and evidence.",
        ));
      } catch {
        return actionError("Release dispatch authority unavailable", 503);
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
        return actionError(errorCode(accepted.data), accepted.status);
      return localRedirect("/releases/" + encodeURIComponent(id) + "?ui=" + mode + "&notice=" + encodeURIComponent("Retry accepted for " + id));
    } catch {
      return actionError("Control Plane unavailable", 503);
    }
  }

  if (request.method !== "GET") return response(405, "Method not allowed");
  const releaseMatch = /^\/releases\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})$/u.exec(url.pathname);
  const detailMatch = /^\/builds\/(sr_[0-9a-f-]{36})$/u.exec(url.pathname);
  const operationMatch = /^\/operations\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})$/u.exec(url.pathname);
  const section: ConsoleSection | null = url.pathname === "/" ? "overview"
    : url.pathname === "/releases" || releaseMatch || operationMatch ? "releases"
    : url.pathname === "/builds" || detailMatch ? "builds"
    : url.pathname === "/audit" ? "audit" : null;
  if (!section) return response(404, "Not found");
  const cursor = url.searchParams.get("cursor");
  if (cursor && (cursor.length > 512 || !/^(?:[A-Za-z0-9_.~:-]|%[0-9A-Fa-f]{2})+$/u.test(cursor)))
    return response(400, "Invalid cursor");
  const state = url.searchParams.get("state");
  if (state && !["queued", "building", "produced", "admitted", "failed"].includes(state))
    return response(400, "Invalid build state");
  const sort = url.searchParams.get("sort") ?? "recent";
  if (!["recent", "source", "state", "attempt"].includes(sort)) return response(400, "Invalid build sort");
  const auditQuery = url.searchParams.get("q") ?? "";
  if (auditQuery.length > 100 || [...auditQuery].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return response(400, "Invalid audit search");
  const selectedBuildId = detailMatch?.[1] ?? null;
  const selectedOperationId = operationMatch?.[1] ?? null;
  const selectedReleaseId = releaseMatch?.[1] ?? null;
  const withCursor = cursor ? "?cursor=" + encodeURIComponent(cursor) : "";
  const empty = <T>(value: T): OperatorSection<T> => ({ endpoint: "", status: 200, code: null, value });
  const [catalog, audit, builds, sourceViews, detail, releaseDetail, operationDetail] = await Promise.all([
    section === "overview" || (section === "releases" && !selectedReleaseId)
      ? controlPlaneSection(context, session.actor.userId, "GET /v1/operator/releases",
        "/v1/operator/releases" + (section === "releases" ? withCursor : ""), isCatalog)
      : Promise.resolve(empty({ items: [] as Summary[], stableChannel: null })),
    section === "audit"
      ? controlPlaneSection(context, session.actor.userId, "GET /v1/operator/releases/audit",
        "/v1/operator/releases/audit" + withCursor + (auditQuery ? (cursor ? "&" : "?") + "q=" + encodeURIComponent(auditQuery) : ""), isAudit)
      : Promise.resolve(empty({ events: [] as Audit[] })),
    section !== "audit" && !selectedBuildId && !selectedReleaseId
      ? controlPlaneSection(context, session.actor.userId, "GET /v1/operator/source-builds",
        "/v1/operator/source-builds" + (section === "overview" ? "?attention=1" : section === "builds" ? withCursor : ""), isSourceBuilds)
      : Promise.resolve(empty({ items: [] as SourceBuildStatus[] })),
    section === "releases" && !selectedReleaseId ? listRegisteredSources(context, session.actor.userId).then(
      (value): OperatorSection<readonly SourceReleaseView[]> =>
        ({ endpoint: "GitHub Releases / configured sources", status: 200, code: null, value }),
      (): OperatorSection<readonly SourceReleaseView[]> => ({ endpoint: "GitHub Releases / configured sources", status: null,
        code: "SOURCE_CATALOG_UNAVAILABLE", value: null }),
    ) : Promise.resolve(empty([] as readonly SourceReleaseView[])),
    selectedBuildId ? controlPlaneSection(context, session.actor.userId, "GET /v1/operator/source-builds/" + selectedBuildId,
      "/v1/operator/source-builds/" + selectedBuildId + "?limit=10" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
      (value): value is SourceBuildDetail => {
        const parsed = SourceBuildDetailSchema.safeParse(value);
        return parsed.success && parsed.data.job.id === selectedBuildId;
      }) : Promise.resolve(null),
    selectedReleaseId ? controlPlaneSection(context, session.actor.userId, "GET /v1/operator/releases/" + selectedReleaseId,
      "/v1/operator/releases/" + encodeURIComponent(selectedReleaseId),
      (value): value is ConsoleReleaseStatus => {
        const data = objectValue(value), release = objectValue(data?.release), workflow = objectValue(data?.workflow);
        const build = objectValue(data?.build);
        return release?.id === selectedReleaseId && typeof release.version === "string" &&
          typeof release.status === "string" && typeof release.imageDigest === "string" &&
          !!workflow && typeof workflow.state === "string" && Number.isSafeInteger(workflow.revision) &&
          Number.isSafeInteger(workflow.attempts) &&
          (workflow.failureCode === null || typeof workflow.failureCode === "string") &&
          (workflow.nextAttemptAt === null || Number.isSafeInteger(workflow.nextAttemptAt)) &&
          (data?.build === null || (!!build && typeof build.id === "string" && typeof build.status === "string" &&
            Number.isSafeInteger(build.attemptCount) && (build.failure === null ||
              typeof objectValue(build.failure)?.code === "string")));
      }) : Promise.resolve(null),
    selectedOperationId ? controlPlaneSection(context, session.actor.userId,
      "GET /v1/operations/" + selectedOperationId + "/evidence",
      "/v1/operations/" + encodeURIComponent(selectedOperationId) + "/evidence",
      (value): value is ConsoleOperationEvidence => {
        const data=objectValue(value), operation=objectValue(data?.operation);
        return operation?.id===selectedOperationId && typeof operation.instanceId==="string" &&
          typeof operation.kind==="string" && typeof operation.status==="string" &&
          typeof operation.phase==="string" && Number.isSafeInteger(operation.generation) &&
          Number.isSafeInteger(operation.runtimeEpoch) && Number.isSafeInteger(operation.updatedAt) &&
          (data?.rollbackCompatible===null || typeof data?.rollbackCompatible==="boolean") &&
          !!data && "readinessEvidence" in data;
      }) : Promise.resolve(null),
  ]);
  const model: ConsoleViewModel = {
    section, mode, csrf: session.csrfToken, notice: url.searchParams.get("notice")?.slice(0, 200) ?? null,
    catalog, audit, builds, sourceViews, detail, selectedBuildId, selectedOperationId, operationDetail, selectedReleaseId, releaseDetail, buildStateFilter: state,
    buildSort: sort as "recent" | "source" | "state" | "attempt", auditQuery,
  };
  return page("Praetorium Admin — " + (selectedBuildId ? "Source build detail" : selectedOperationId ? "Operation evidence" : selectedReleaseId ? "Release status" : section),
    mode === "mobile" ? renderMobileConsole(model) : renderDesktopConsole(model),
    { layout: "handoff", presentation: { mode } });
}

function renderError(context: GatewayContext, csrf: string, message: string, status: number, mode: ConsoleMode, returnPath?: string): Response {
  const pageResult = adminPage("Operator action unavailable",
    '<p class="alert" role="alert">' + escapeHtml(message) + '</p>' +
    '<p><a class="button button-secondary" href="' + escapeHtml(returnPath ?? "/releases?ui=" + mode) + '">Return to selected record</a></p>', csrf, mode);
  void context;
  return new Response(pageResult.body, { status, headers: pageResult.headers });
}
