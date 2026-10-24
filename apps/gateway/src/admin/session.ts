import {
  adminReturnPath, buildSessionCookie, createSession, generateToken, keyedDigest, revokeSession,
} from "@praetorium/auth";
import type { GatewayContext } from "../context.js";
import { SESSION_CONCURRENCY_LIMIT } from "../constants.js";
import {
  CSRF_COOKIE_NAME, SESSION_COOKIE_NAME,
  readCookie, requireSession, sessionCsrfToken,
} from "../http/session.js";
import { escapeHtml } from "../ui/presentation.js";
import { page } from "../ui/views/document.js";
import { shardNameFor } from "../adapters/durable-objects/shard.js";

type Handoff = {
  readonly userId: string;
  readonly gatewaySessionDigest: string;
  readonly expiresAt: number;
  readonly audience: string;
  readonly returnTo?: string;
};
export { adminReturnPath } from "@praetorium/auth";
}

const HANDOFF_TTL_MS = 60_000;
const ADMIN_SESSION_TTL_SECONDS = 3600;
const MAX_FORM_BYTES = 4096;

function noStore(status: number, body: string): Response {
  return new Response(body, { status, headers: {
    "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  } });
}

function redirect(to: string): Response {
  return new Response(null, { status: 303, headers: {
    Location: to, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
  } });
}

async function doRequest(
  context: GatewayContext, digest: string, action: "save" | "consume", record?: Handoff,
): Promise<Handoff | null> {
  const stub = context.env.EPHEMERAL_CODES.get(
    context.env.EPHEMERAL_CODES.idFromName(shardNameFor(digest)),
  );
  const response = await stub.fetch("https://ephemeral-code/" + action, {
    method: "POST",
    body: JSON.stringify({
      key: "admin-handoff:" + digest,
      ...(record ? { record } : {}),
    }),
  });
  if (!response.ok) throw new Error("Admin handoff authority unavailable");
  if (action === "save") return null;
  const body: unknown = await response.json();
  return body && typeof body === "object" && "record" in body
    ? (body.record as Handoff | null) : null;
}

async function boundedForm(request: Request): Promise<URLSearchParams | null> {
  if (request.headers.get("Content-Type")?.split(";", 1)[0]?.trim() !==
      "application/x-www-form-urlencoded") return null;
  const length = request.headers.get("Content-Length");
  if (length && (!/^[0-9]+$/.test(length) || Number(length) > MAX_FORM_BYTES)) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.length;
      if (total > MAX_FORM_BYTES) { await reader.cancel(); return null; }
      parts.push(item.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    decodeURIComponent(raw.replace(/\+/g, " "));
    return new URLSearchParams(raw);
  } catch { return null; }
}

export function isAdmin(context: GatewayContext, userId: string): boolean {
  return context.config.adminOrigin !== null &&
    context.config.adminGithubUserIds.includes(userId);
}

export async function enterAdminFromGateway(request: Request, context: GatewayContext): Promise<Response> {
  if (new URL(request.url).origin !== context.config.origin || request.method !== "GET" ||
      !context.config.adminOrigin) return noStore(404, "Not found");
  const returnTo = adminReturnPath(new URL(request.url).searchParams.get("return_to"));
  const entry = "/_admin/entry" + (returnTo === "/" ? "" : "?return_to=" + encodeURIComponent(returnTo));
  const session = await requireSession(request, context);
  if (!session.ok) {
    const url = new URL("/auth/login", context.config.origin);
    url.searchParams.set("redirect_to", entry);
    return redirect(url.toString());
  }
  if (!isAdmin(context, session.session.actor.userId)) return noStore(403, "Operator access denied");
  try {
    const code = generateToken(256);
    const digest = await keyedDigest(context.config.handoffPepper, "admin-session:" + code);
    await doRequest(context, digest, "save", {
      userId: session.session.actor.userId,
      gatewaySessionDigest: session.session.resolved.digest,
      expiresAt: Date.parse(context.requestNow) + HANDOFF_TTL_MS,
      audience: context.config.adminOrigin,
      returnTo,
    });
    // A one-use POST transfers the authenticated identity, not a Gateway
    // cookie. The raw code is never sent in a redirect URL or referrer.
    const nonce = generateToken(160);
    const action = context.config.adminOrigin + "/_admin/handoff";
    return page(
      "Enter Praetorium Admin",
      '<section class="admin-handoff"><p class="admin-kicker">PLATFORM / OPERATOR</p>' +
      '<h1>Opening administration</h1><p>Verifying your operator session.</p>' +
      '<form id="admin-handoff" method="post" action="' + escapeHtml(action) + '">' +
      '<input type="hidden" name="code" value="' + escapeHtml(code) + '">' +
      '<button type="submit">Continue to Admin</button></form></section>' +
      '<script nonce="' + nonce + '">document.getElementById("admin-handoff")?.submit();</script>',
      { layout: "handoff", formAction: context.config.adminOrigin,
        scriptNonce: nonce, referrerPolicy: "strict-origin" },
    );
  } catch {
    return noStore(503, "Admin login temporarily unavailable");
  }
}

export async function completeAdminHandoff(request: Request, context: GatewayContext): Promise<Response> {
  if (!context.config.adminOrigin ||
      new URL(request.url).origin !== context.config.adminOrigin ||
      request.method !== "POST" ||
      request.headers.get("Origin") !== context.config.origin ||
      new URL(request.url).search) return noStore(403, "Admin handoff origin rejected");
  const form = await boundedForm(request);
  const codes = form?.getAll("code") ?? [];
  if (!form || [...form.keys()].some((key) => key !== "code") ||
      codes.length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(codes[0]!))
    return noStore(400, "Invalid admin handoff");
  try {
    const result = await redeemAdminHandoffCode(codes[0]!, context);
    if (result.kind === "expired") return noStore(401, "Admin handoff expired");
    if (result.kind === "limit") return noStore(503, "Admin session limit reached");
    const response = redirect(adminReturnPath(result.returnTo));
    response.headers.append("Set-Cookie",
      buildSessionCookie({ name: SESSION_COOKIE_NAME, ttlSeconds: result.ttlSeconds },
        result.rawSessionId));
    response.headers.append("Set-Cookie",
      CSRF_COOKIE_NAME + "=" + encodeURIComponent(result.csrfToken) +
      "; Path=/; Secure; SameSite=Lax; Max-Age=" + result.ttlSeconds);
    return response;
  } catch {
    return noStore(503, "Admin handoff unavailable");
  }
}

export async function authenticateAdmin(request: Request, context: GatewayContext) {
  const session = await requireSession(request, context);
  return session.ok && isAdmin(context, session.session.actor.userId)
    ? session.session : null;
}

export async function adminFormCsrf(
  request: Request, context: GatewayContext,
  session: NonNullable<Awaited<ReturnType<typeof authenticateAdmin>>>,
  form: URLSearchParams,
): Promise<boolean> {
  if (request.headers.get("Origin") !== context.config.adminOrigin ||
      request.headers.get("Sec-Fetch-Site") === "cross-site") return false;
  const token = form.getAll("csrfToken");
  if (token.length !== 1) return false;
  const csrf = readCookie(request, CSRF_COOKIE_NAME);
  return csrf !== null && csrf === session.csrfToken && token[0] === csrf &&
    // The verified admin session contains the exact presented session cookie.
    readCookie(request, SESSION_COOKIE_NAME) === session.rawSessionId;
}

export async function logoutAdmin(
  request: Request, context: GatewayContext,
  session: NonNullable<Awaited<ReturnType<typeof authenticateAdmin>>>,
): Promise<Response> {
  try {
    await revokeSession(context.sessionStore, session.resolved.digest, context.requestNow);
  } catch { return noStore(503, "Admin logout unavailable"); }
  // A redirect to "/" would immediately re-run the Gateway OAuth handoff
  // while the ordinary repository session remains valid. Keep the admin
  // session signed out until the operator explicitly chooses to sign in.
  const response = redirect("/signed-out");
  response.headers.append("Set-Cookie",
    SESSION_COOKIE_NAME + "=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0");
  response.headers.append("Set-Cookie",
    CSRF_COOKIE_NAME + "=; Path=/; Secure; SameSite=Lax; Max-Age=0");
  return response;
}

/** Only a bounded native form body can reach administrator mutation handlers. */
export { boundedForm };

export type AdminHandoffRedemption =
  | { readonly kind: "ok"; readonly rawSessionId: string; readonly csrfToken: string; readonly ttlSeconds: number; readonly returnTo?: string }
  | { readonly kind: "expired" }
  | { readonly kind: "limit" };

/** Shared atomically-consumed handoff authority for the existing host and the private RPC entrypoint. */
export async function redeemAdminHandoffCode(
  code: string, context: GatewayContext,
): Promise<AdminHandoffRedemption> {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(code) || !context.config.adminOrigin)
    return { kind: "expired" };
  const digest = await keyedDigest(context.config.handoffPepper, "admin-session:" + code);
  const record = await doRequest(context, digest, "consume");
  if (!record || record.audience !== context.config.adminOrigin ||
      record.expiresAt <= Date.parse(context.requestNow) || !isAdmin(context, record.userId))
    return { kind: "expired" };
  const original = await context.sessionStore.get(record.gatewaySessionDigest);
  if (!original || original.userId !== record.userId ||
      original.expiresAt <= context.requestNow ||
      (original.revokedAt !== null && original.revokedAt <= context.requestNow))
    return { kind: "expired" };
  const ttlSeconds = Math.min(ADMIN_SESSION_TTL_SECONDS,
    Math.floor((Date.parse(original.expiresAt) - Date.parse(context.requestNow)) / 1000));
  if (ttlSeconds <= 0) return { kind: "expired" };
  const created = await createSession(context.sessionStore, {
    userId: record.userId as typeof original.userId,
    authenticationContext: "github-oauth",
    now: context.requestNow,
    ttlSeconds,
    pepper: context.config.sessionPepper,
    concurrentSessionLimit: SESSION_CONCURRENCY_LIMIT,
  });
  if (!created.ok) return { kind: "limit" };
  return { kind: "ok", rawSessionId: created.value.rawSessionId,
    csrfToken: await sessionCsrfToken(context, created.value.rawSessionId), ttlSeconds,
    returnTo: adminReturnPath(record.returnTo) };
}
