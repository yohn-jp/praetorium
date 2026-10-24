import { adminReturnPath, constantTimeEqual } from "@praetorium/auth";
import type { AdminContext } from "./context.js";

const SESSION = "__Host-praetorium_session";
const CSRF = "__Host-praetorium_csrf";
const MAX_FORM = 4096;

export { adminReturnPath } from "@praetorium/auth";
}

export interface AdminSession {
  readonly actor: { readonly userId: string };
  readonly rawSessionId: string;
  readonly csrfToken: string;
}
function respond(status: number, message: string): Response {
  return new Response(message, { status, headers: {
    "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
    "Content-Type": "text/plain; charset=utf-8",
  } });
}
function cookie(request: Request, name: string): string | null {
  const matches = (request.headers.get("Cookie") ?? "").split(";")
    .map(part => part.trim()).filter(part => part.startsWith(name + "="));
  if (matches.length !== 1) return null;
  try { return decodeURIComponent(matches[0]!.slice(name.length + 1)); }
  catch { return null; }
}
export async function boundedForm(request: Request): Promise<URLSearchParams | null> {
  if (request.headers.get("Content-Type")?.split(";", 1)[0]?.trim() !==
      "application/x-www-form-urlencoded") return null;
  const declared = request.headers.get("Content-Length");
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > MAX_FORM)) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_FORM) { await reader.cancel(); return null; }
      parts.push(part.value);
    }
    const buf = new Uint8Array(size);
    let off = 0;
    for (const part of parts) { buf.set(part, off); off += part.byteLength; }
    const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf);
    decodeURIComponent(raw.replace(/\+/gu, " "));
    return new URLSearchParams(raw);
  } catch { return null; }
  finally { reader.releaseLock(); }
}
export async function completeAdminHandoff(request: Request, context: AdminContext): Promise<Response> {
  if (request.method !== "POST" ||
      new URL(request.url).origin !== context.config.adminOrigin ||
      request.headers.get("Origin") !== context.config.origin ||
      new URL(request.url).search) return respond(403, "Admin handoff origin rejected");
  const form = await boundedForm(request);
  const codes = form?.getAll("code") ?? [];
  if (!form || [...form.keys()].some(k => k !== "code") ||
      codes.length !== 1 || !/^[A-Za-z0-9_-]{43}$/u.test(codes[0]!))
    return respond(400, "Invalid admin handoff");
  let result;
  try { result = await context.env.ADMIN_IDENTITY.redeemAdminHandoff(codes[0]!); }
  catch { return respond(503, "Admin handoff unavailable"); }
  if (result.kind === "expired") return respond(401, "Admin handoff expired");
  if (result.kind !== "ok") return respond(503, "Admin handoff unavailable");
  const response = new Response(null, { status: 303, headers: {
    Location: adminReturnPath(result.returnTo), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
  } });
  response.headers.append("Set-Cookie", SESSION + "=" + encodeURIComponent(result.sessionId) +
    "; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=" + result.ttlSeconds);
  response.headers.append("Set-Cookie", CSRF + "=" + encodeURIComponent(result.csrfToken) +
    "; Path=/; Secure; SameSite=Lax; Max-Age=" + result.ttlSeconds);
  return response;
}
export async function authenticateAdmin(
  request: Request, context: AdminContext,
): Promise<AdminSession | null> {
  const sessionId = cookie(request, SESSION);
  if (!sessionId || !/^[A-Za-z0-9_-]{43}$/u.test(sessionId)) return null;
  let result;
  try { result = await context.env.ADMIN_IDENTITY.verifyAdminSession(sessionId); }
  catch { return null; }
  if (!result) return null;
  return { rawSessionId: sessionId, actor: { userId: result.actorId }, csrfToken: result.csrfToken };
}
export async function adminFormCsrf(
  request: Request, context: AdminContext, session: AdminSession, form: URLSearchParams,
): Promise<boolean> {
  const token = form.getAll("csrfToken");
  return request.headers.get("Origin") === context.config.adminOrigin &&
    request.headers.get("Sec-Fetch-Site") !== "cross-site" &&
    token.length === 1 && cookie(request, SESSION) === session.rawSessionId &&
    !!cookie(request, CSRF) &&
    constantTimeEqual(cookie(request, CSRF)!, session.csrfToken) &&
    constantTimeEqual(token[0]!, session.csrfToken);
}
export async function logoutAdmin(
  _request: Request, context: AdminContext, session: AdminSession,
): Promise<Response> {
  let revoked = false;
  try { revoked = await context.env.ADMIN_IDENTITY.revokeAdminSession(session.rawSessionId); }
  catch { return respond(503, "Admin logout unavailable"); }
  if (!revoked) return respond(401, "Admin session expired");
  const response = new Response(null, { status: 303, headers: {
    Location: "/signed-out", "Cache-Control": "no-store",
  } });
  response.headers.append("Set-Cookie", SESSION + "=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0");
  response.headers.append("Set-Cookie", CSRF + "=; Path=/; Secure; SameSite=Lax; Max-Age=0");
  return response;
}
