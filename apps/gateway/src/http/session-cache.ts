import {
  base64UrlDecode, base64UrlEncode, buildSessionCookie, constantTimeEqual,
  importPublicKeyJwk, keyedDigest, type ResolvedSession,
} from "@praetorium/auth";
import { z } from "zod";
import type { GatewayContext } from "../context.js";
import { readCookie } from "./session.js";

export const SESSION_CACHE_COOKIE_NAME = "__Host-praetorium_session_cache";
const TYPE = "praetorium-session-cache-v1";
const encode = (value: object) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
const headerSchema = z.strictObject({ alg: z.literal("ES256"), typ: z.literal(TYPE), kid: z.string().min(1).max(64) });
const claimsSchema = z.strictObject({
  version: z.literal(1), origin: z.string(), digest: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  userId: z.string().min(1).max(128), sessionRevision: z.number().int().nonnegative().safe(),
  iat: z.number().int().nonnegative().safe(), exp: z.number().int().nonnegative().safe(),
  sessionExp: z.number().int().nonnegative().safe(),
});

/** Explicit allowlist: neither new GET routes nor side-effectful GETs inherit cache eligibility. */
export function isSessionCacheRead(request: Request, context: GatewayContext): boolean {
  const url = new URL(request.url);
  return request.method === "GET" && !request.headers.has("Authorization") &&
    url.origin === context.config.origin &&
    (url.pathname === "/" || /^\/repositories\/[1-9][0-9]*$/.test(url.pathname));
}

/** Cache identity deliberately cannot be passed as an authoritative ResolvedSession. */
export interface CachedBrowserIdentity {
  readonly actor: { readonly userId: string };
  readonly digest: string;
}

export async function readSessionCache(
  request: Request, context: GatewayContext, rawSessionId: string,
): Promise<CachedBrowserIdentity | null> {
  const token = readCookie(request, SESSION_CACHE_COOKIE_NAME);
  if (!token || token.length > 2048) return null;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [head, body, signature] = parts as [string, string, string];
    if (![head, body, signature].every((part) => /^[A-Za-z0-9_-]+$/.test(part))) return null;
    const header = headerSchema.parse(JSON.parse(new TextDecoder().decode(base64UrlDecode(head))));
    const claims = claimsSchema.parse(JSON.parse(new TextDecoder().decode(base64UrlDecode(body))));
    const now = Math.floor(Date.parse(context.requestNow) / 1000);
    if (!Number.isFinite(now) || claims.origin !== context.config.origin || claims.iat > now ||
      claims.exp <= now || claims.exp <= claims.iat || claims.exp - claims.iat > 300 ||
      claims.exp > claims.sessionExp) return null;
    const digest = await keyedDigest(context.config.sessionPepper, rawSessionId);
    if (!constantTimeEqual(claims.digest, digest)) return null;
    // Unlike long-lived Runtime grants, this optimization rejects retired keys:
    // rotation falls back to the DO and issues a cache under the active key.
    const key = (await context.getKeyRegistry()).find((entry) => entry.kid === header.kid && entry.status === "active");
    if (!key) return null;
    const bytes = base64UrlDecode(signature);
    if (bytes.length !== 64 || base64UrlEncode(bytes) !== signature) return null;
    if (!(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" },
      await importPublicKeyJwk(key.publicKeyJwk), bytes as BufferSource,
      new TextEncoder().encode(`${head}.${body}`)))) return null;
    return { actor: { userId: claims.userId }, digest };
  } catch {
    // Untrusted/expired cookies and unavailable key metadata use the existing authority.
    return null;
  }
}

export async function issueSessionCache(context: GatewayContext, resolved: ResolvedSession): Promise<string | null> {
  try {
    const iat = Math.floor(Date.parse(context.requestNow) / 1000);
    const sessionExp = Math.floor(Date.parse(resolved.record.expiresAt) / 1000);
    const exp = Math.min(iat + 300, sessionExp);
    if (exp <= iat) return null;
    const key = await context.getSigningKey();
    const header = encode({ alg: "ES256", typ: TYPE, kid: key.kid });
    const payload = encode(claimsSchema.parse({ version: 1, origin: context.config.origin,
      digest: resolved.digest, userId: resolved.record.userId, sessionRevision: resolved.record.sessionRevision,
      iat, exp, sessionExp }));
    const input = `${header}.${payload}`;
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.privateKey, new TextEncoder().encode(input));
    return buildSessionCookie({ name: SESSION_CACHE_COOKIE_NAME, ttlSeconds: exp - iat },
      `${input}.${base64UrlEncode(new Uint8Array(signature))}`);
  } catch {
    // Cache availability must not turn a successful authoritative browser read into an outage.
    return null;
  }
}
