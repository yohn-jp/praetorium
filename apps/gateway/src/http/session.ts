import {
  constantTimeEqual,
  keyedDigest,
  resolveSession,
  type ResolvedSession,
} from "@praetorium/auth";
import type { GatewayContext } from "../context.js";

export const SESSION_COOKIE_NAME = "__Host-praetorium_session";
export const CSRF_COOKIE_NAME = "__Host-praetorium_csrf";
export const LOGIN_NONCE_COOKIE_NAME = "__Host-praetorium_login_nonce";

interface ParsedCookies {
  readonly values: Map<string, string>;
  readonly duplicates: Set<string>;
  readonly invalid: Set<string>;
}

function parseCookies(request: Request): ParsedCookies {
  const values = new Map<string, string>();
  const duplicates = new Set<string>();
  const invalid = new Set<string>();
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    if (values.has(name) || duplicates.has(name) || invalid.has(name)) {
      values.delete(name);
      duplicates.add(name);
      continue;
    }
    try {
      values.set(name, decodeURIComponent(part.slice(separator + 1).trim()));
    } catch {
      invalid.add(name);
    }
  }
  return { values, duplicates, invalid };
}

/** Return only a unique, well-formed cookie value; duplicate names fail closed. */
export function readCookie(request: Request, name: string): string | null {
  const cookies = parseCookies(request);
  if (cookies.duplicates.has(name) || cookies.invalid.has(name)) return null;
  return cookies.values.get(name) ?? null;
}

export function hasCookieName(request: Request, name: string): boolean {
  const cookies = parseCookies(request);
  return cookies.values.has(name) || cookies.duplicates.has(name) || cookies.invalid.has(name);
}

export function rawSessionCookie(request: Request): string | null {
  return readCookie(request, SESSION_COOKIE_NAME);
}

export async function sessionCsrfToken(context: GatewayContext, rawSessionId: string): Promise<string> {
  return keyedDigest(context.config.sessionPepper, `csrf:${rawSessionId}`);
}

export interface PortalSession {
  readonly actor: { readonly userId: string };
  readonly csrfToken: string;
  readonly resolved: ResolvedSession;
  readonly rawSessionId: string;
}

export type RequireSessionResult =
  | { readonly ok: true; readonly session: PortalSession }
  | { readonly ok: false; readonly response: Response };

export async function requireSession(
  request: Request,
  context: GatewayContext,
  now = context.requestNow,
): Promise<RequireSessionResult> {
  const rawSessionId = rawSessionCookie(request);
  if (!rawSessionId) {
    return { ok: false, response: jsonError(request, context, 401, "UNAUTHENTICATED", "Authentication required.") };
  }
  const resolved = await resolveSession(context.sessionStore, context.config.sessionPepper, rawSessionId, now);
  if (!resolved.ok) {
    return { ok: false, response: jsonError(request, context, 401, "UNAUTHENTICATED", "Authentication required.") };
  }
  const csrfToken = await sessionCsrfToken(context, rawSessionId);
  return {
    ok: true,
    session: {
      actor: { userId: resolved.value.record.userId },
      csrfToken,
      resolved: resolved.value,
      rawSessionId,
    },
  };
}

export async function hasValidGatewayCsrf(
  request: Request,
  context: GatewayContext,
  session?: Pick<PortalSession, "csrfToken">,
  form?: FormData,
): Promise<boolean> {
  const expectedOrigin = new URL(context.config.origin).origin;
  if (
    request.headers.get("Origin") !== expectedOrigin ||
    request.headers.get("Sec-Fetch-Site") === "cross-site"
  ) return false;
  const cookies = parseCookies(request);
  const raw = cookies.values.get(SESSION_COOKIE_NAME);
  const cookieToken = cookies.values.get(CSRF_COOKIE_NAME);
  if (
    cookies.duplicates.has(SESSION_COOKIE_NAME) ||
    cookies.duplicates.has(CSRF_COOKIE_NAME) ||
    cookies.invalid.has(SESSION_COOKIE_NAME) ||
    cookies.invalid.has(CSRF_COOKIE_NAME)
  ) return false;
  if (!raw || !cookieToken) return false;
  let submitted = request.headers.get("X-CSRF-Token");
  if (form) {
    const values = form.getAll("csrfToken");
    if (values.length !== 1 || typeof values[0] !== "string") return false;
    submitted = values[0];
  }
  const expected = session?.csrfToken ?? await sessionCsrfToken(context, raw);
  return !!submitted && constantTimeEqual(cookieToken, expected) && constantTimeEqual(submitted, expected);
}

function jsonError(
  request: Request,
  context: GatewayContext,
  status: number,
  code: string,
  message: string,
): Response {
  return Response.json({ error: { code, message }, requestId: context.requestId }, {
    status,
    headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}
