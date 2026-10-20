import { Hono } from "hono";
import {
  RedeemHandoffRequestSchema,
  RedeemHandoffResponseSchema,
  RefreshAccessRequestSchema,
  RefreshAccessResponseSchema,
  RevokeAccessRequestSchema,
  RevokeAccessResponseSchema,
  applicationFromHostname,
} from "@praetorium/contracts";

const ACCESS_COOKIE = "__Host-praetorium_access";
const REFRESH_COOKIE = "__Secure-praetorium_refresh";
const CSRF_COOKIE = "__Host-praetorium_csrf";
const MAX_FORM_BYTES = 8_192;
const RETRY_AFTER_SECONDS = 5;

export interface InstanceAccessEnvironment {
  readonly INSTANCE_ACCESS_INSTANCE_HOSTNAME_SUFFIX?: string;
  readonly INSTANCE_ACCESS_SERVICE_AUTH_TOKEN?: string;
  readonly GATEWAY_ORIGIN?: string;
  readonly GATEWAY?: { fetch(request: Request): Promise<Response> };
  /** Node adapter only. Workers use the service binding above. */
  readonly GATEWAY_URL?: string;
  readonly NODE_ENV?: string;
}

interface InstanceAccessConfig {
  readonly hostnameSuffix: string;
  readonly serviceToken: string;
  readonly gatewayOrigin: string;
  readonly gatewayUrl: URL | null;
  readonly gatewayBinding: { fetch(request: Request): Promise<Response> } | null;
}

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type Instance = { readonly appIdentity: "scriptorium"; readonly repositoryId: number; readonly hostname: string; readonly origin: string };

function fail(message: string): never {
  throw new Error(`Instance Access configuration: ${message}`);
}

function loadConfig(env: InstanceAccessEnvironment): InstanceAccessConfig {
  const suffix = env.INSTANCE_ACCESS_INSTANCE_HOSTNAME_SUFFIX?.toLowerCase();
  if (
    !suffix ||
    suffix.length > 200 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(suffix) ||
    /(?:^|\.)(?:localhost|example\.(?:com|org|net))(?:\.|$)/.test(suffix)
  ) {
    return fail("a concrete instance hostname suffix is required");
  }
  const serviceToken = env.INSTANCE_ACCESS_SERVICE_AUTH_TOKEN;
  if (!serviceToken || serviceToken.length < 32 || /^(placeholder|changeme|example)/i.test(serviceToken)) {
    return fail("a strong Gateway service token is required");
  }
  let gatewayOriginUrl: URL;
  try {
    gatewayOriginUrl = new URL(env.GATEWAY_ORIGIN ?? "");
  } catch {
    return fail("an exact Gateway HTTPS origin is required");
  }
  if (
    gatewayOriginUrl.protocol !== "https:" ||
    gatewayOriginUrl.origin !== env.GATEWAY_ORIGIN ||
    gatewayOriginUrl.username ||
    gatewayOriginUrl.password ||
    gatewayOriginUrl.pathname !== "/" ||
    gatewayOriginUrl.search ||
    gatewayOriginUrl.hash
  ) {
    return fail("Gateway origin must be an exact HTTPS origin");
  }
  let gatewayUrl: URL | null = null;
  if (!env.GATEWAY && env.GATEWAY_URL) {
    try {
      gatewayUrl = new URL(env.GATEWAY_URL);
    } catch {
      return fail("Gateway URL is invalid");
    }
    if (
      !["http:", "https:"].includes(gatewayUrl.protocol) ||
      gatewayUrl.username ||
      gatewayUrl.password ||
      gatewayUrl.search ||
      gatewayUrl.hash ||
      (gatewayUrl.protocol === "http:" && env.NODE_ENV !== "test")
    ) {
      return fail("Gateway URL must be a trusted service URL");
    }
  }
  if (!env.GATEWAY && !gatewayUrl) return fail("Gateway service binding is required");
  return {
    hostnameSuffix: suffix,
    serviceToken,
    gatewayOrigin: gatewayOriginUrl.origin,
    gatewayUrl,
    gatewayBinding: env.GATEWAY ?? null,
  };
}

function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  const result = new Headers(headers);
  result.set("Cache-Control", "no-store");
  result.set("Referrer-Policy", "no-referrer");
  result.set("X-Content-Type-Options", "nosniff");
  return Response.json(body, { status, headers: result });
}

function problem(status: number, code: string, retryAfter = false): Response {
  return json(
    { error: { code } },
    status,
    retryAfter ? { "Retry-After": String(RETRY_AFTER_SECONDS) } : {},
  );
}

function validInstanceFromHost(request: Request): Instance | null {
  const rawHost = request.headers.get("Host");
  if (!rawHost || rawHost.includes("@") || rawHost.includes("/") || rawHost.includes("\\")) return null;
  let hostname: string;
  try {
    const parsed = new URL(`https://${rawHost}`);
    if (parsed.port || parsed.username || parsed.password || parsed.hostname !== rawHost.toLowerCase()) return null;
    const requestUrl = new URL(request.url);
    if (requestUrl.hostname !== parsed.hostname || requestUrl.port !== "") return null;
    hostname = parsed.hostname;
  } catch {
    return null;
  }
  try {
    return { ...applicationFromHostname(hostname), hostname, origin: `https://${hostname}` };
  } catch {
    return null;
  }
}

interface ParsedCookies {
  readonly values: Map<string, string>;
  readonly duplicates: Set<string>;
  readonly invalid: Set<string>;
}

function parseCookies(request: Request): ParsedCookies {
  const values = new Map<string, string>();
  const duplicates = new Set<string>();
  const invalid = new Set<string>();
  for (const piece of (request.headers.get("Cookie") ?? "").split(";")) {
    const separator = piece.indexOf("=");
    if (separator <= 0) continue;
    const name = piece.slice(0, separator).trim();
    if (values.has(name) || duplicates.has(name) || invalid.has(name)) {
      values.delete(name);
      duplicates.add(name);
      continue;
    }
    try {
      values.set(name, decodeURIComponent(piece.slice(separator + 1).trim()));
    } catch {
      invalid.add(name);
    }
  }
  return { values, duplicates, invalid };
}

function readCookie(request: Request, name: string): string | null {
  const cookies = parseCookies(request);
  if (cookies.duplicates.has(name) || cookies.invalid.has(name)) return null;
  return cookies.values.get(name) ?? null;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function csrfValue(config: InstanceAccessConfig, instance: Instance): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(config.serviceToken),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`praetorium-instance-access-csrf:v1:${instance.appIdentity}:${instance.repositoryId}:${instance.origin}`),
  );
  return base64Url(new Uint8Array(signature));
}

function cookie(name: string, value: string, path: string, maxAge: number, httpOnly: boolean): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${path}`,
    "Secure",
    ...(httpOnly ? ["HttpOnly"] : []),
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(maxAge))}`,
  ].join("; ");
}

function expiredCookie(name: string, path: string, httpOnly: boolean): string {
  return [
    `${name}=`,
    `Path=${path}`,
    "Secure",
    ...(httpOnly ? ["HttpOnly"] : []),
    "SameSite=Lax",
    "Max-Age=0",
  ].join("; ");
}

function withCookies(response: Response, cookies: readonly string[]): Response {
  const headers = new Headers(response.headers);
  for (const value of cookies) headers.append("Set-Cookie", value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function validCsrf(request: Request, instance: Instance, expected: string): boolean {
  if (
    request.headers.get("Origin") !== instance.origin ||
    request.headers.get("Sec-Fetch-Site") === "cross-site"
  ) return false;
  const cookieValue = readCookie(request, CSRF_COOKIE);
  const headerValue = request.headers.get("X-CSRF-Token");
  if (!cookieValue || !headerValue || cookieValue.length !== expected.length || headerValue.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i += 1) {
    mismatch |= cookieValue.charCodeAt(i) ^ expected.charCodeAt(i);
    mismatch |= headerValue.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

async function postGateway(
  config: InstanceAccessConfig,
  path: string,
  body: unknown,
  fetcher: Fetch,
): Promise<Response> {
  const destination = config.gatewayUrl ? new URL(path, config.gatewayUrl) : new URL(`https://gateway.internal${path}`);
  const request = new Request(destination, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.serviceToken}`,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  let upstream: Response;
  try {
    upstream = config.gatewayBinding
      ? await config.gatewayBinding.fetch(request)
      : await fetcher(request);
  } catch {
    return problem(503, "GATEWAY_UNAVAILABLE");
  }
  if (!upstream.ok) return problem(upstream.status === 401 ? 401 : 503, "GATEWAY_REJECTED_REQUEST");
  return upstream;
}

async function singleForm(request: Request): Promise<{ code: string; returnPath: "/" } | null> {
  if (request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/x-www-form-urlencoded") return null;
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null && (!/^(0|[1-9][0-9]*)$/.test(contentLength) || Number(contentLength) > MAX_FORM_BYTES)) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FORM_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  const form = new URLSearchParams(body);
  if ([...form.keys()].some((key) => key !== "code" && key !== "returnPath")) return null;
  const codes = form.getAll("code");
  const paths = form.getAll("returnPath");
  if (codes.length !== 1 || paths.length !== 1 || paths[0] !== "/") return null;
  const code = codes[0] ?? "";
  if (code.length < 16 || code.length > 256) return null;
  return { code, returnPath: "/" };
}

function isHtmlNavigation(request: Request): boolean {
  return (
    request.method === "GET" &&
    request.headers.get("Accept")?.toLowerCase().includes("text/html") === true &&
    request.headers.get("Sec-Fetch-Mode") === "navigate" &&
    request.headers.get("Sec-Fetch-Dest") === "document"
  );
}

function redirect(location: string, status = 302): Response {
  return new Response(null, {
    status,
    headers: {
      Location: location,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function fallbackEntry(instance: Instance, config: InstanceAccessConfig, routeFallback = false): Response {
  const target = new URL(`/entry/${instance.appIdentity}/${instance.repositoryId}`, config.gatewayOrigin);
  // A route hint only; Gateway still authenticates and revalidates access.
  if (routeFallback) target.searchParams.set("fallback", "1");
  return redirect(target.toString());
}

function noStoreRedirect(path: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      Location: path,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    },
  });
}

/** Constructing the handler validates every required binding and secret; production never falls back to a fake. */
export function createInstanceAccessHandler(
  env: InstanceAccessEnvironment,
  fetcher: Fetch = fetch,
  now: () => number = Date.now,
): (request: Request) => Promise<Response> {
  const config = loadConfig(env);
  const app = new Hono();
  app.use("*", async (_c, next) => {
    await next();
  });

  app.get("/healthz", () => json({ status: "ok" }));
  app.get("/readyz", () => json({ status: "ready" }));
  app.all("*", async (c) => {
    const request = c.req.raw;
    const url = new URL(request.url);
    const instance = validInstanceFromHost(request);
    if (!instance) return problem(404, "INSTANCE_NOT_FOUND");

    if (request.method === "POST" && url.pathname === "/_platform/handoff") {
      if (
        url.search ||
        request.headers.get("Origin") !== config.gatewayOrigin
      ) return problem(403, "HANDOFF_ORIGIN_INVALID");
      const form = await singleForm(request);
      if (!form) return problem(400, "HANDOFF_REQUEST_INVALID");
      const input = RedeemHandoffRequestSchema.safeParse({
        contractVersion: "instance-access/v2",
        audience: "instance-access",
        appIdentity: instance.appIdentity,
        repositoryId: instance.repositoryId,
        hostname: instance.hostname,
        origin: instance.origin,
        code: form.code,
        returnPath: form.returnPath,
      });
      if (!input.success) return problem(400, "HANDOFF_REQUEST_INVALID");
      const upstream = await postGateway(config, "/internal/instance-access/handoff", input.data, fetcher);
      if (!upstream.ok) return upstream;
      const grant = RedeemHandoffResponseSchema.safeParse(await upstream.json().catch(() => null));
      if (!grant.success) return problem(502, "INVALID_GATEWAY_RESPONSE");
      const accessSeconds = Math.floor((Date.parse(grant.data.expiresAt) - now()) / 1000);
      const refreshSeconds = Math.floor((Date.parse(grant.data.refreshExpiresAt) - now()) / 1000);
      if (accessSeconds < 1 || refreshSeconds < 1) return problem(401, "HANDOFF_EXPIRED");
      const csrf = await csrfValue(config, instance);
      return withCookies(noStoreRedirect("/"), [
        cookie(ACCESS_COOKIE, grant.data.token, "/", Math.min(accessSeconds, 300), true),
        cookie(REFRESH_COOKIE, grant.data.refreshCredential, "/_platform", refreshSeconds, true),
        cookie(CSRF_COOKIE, csrf, "/", refreshSeconds, false),
      ]);
    }

    if (request.method === "POST" && url.pathname === "/_platform/refresh") {
      const refreshCredential = readCookie(request, REFRESH_COOKIE);
      if (!refreshCredential) return problem(401, "SESSION_REQUIRED");
      const csrf = await csrfValue(config, instance);
      if (!validCsrf(request, instance, csrf)) return problem(403, "CSRF_INVALID");
      const input = RefreshAccessRequestSchema.safeParse({
        contractVersion: "instance-access/v2",
        audience: "instance-access",
        appIdentity: instance.appIdentity,
        repositoryId: instance.repositoryId,
        hostname: instance.hostname,
        origin: instance.origin,
        refreshCredential,
      });
      if (!input.success) return problem(401, "SESSION_INVALID");
      const upstream = await postGateway(config, "/internal/instance-access/refresh", input.data, fetcher);
      if (!upstream.ok) return upstream;
      const grant = RefreshAccessResponseSchema.safeParse(await upstream.json().catch(() => null));
      if (!grant.success) return problem(502, "INVALID_GATEWAY_RESPONSE");
      const accessSeconds = Math.floor((Date.parse(grant.data.expiresAt) - now()) / 1000);
      const refreshSeconds = Math.floor((Date.parse(grant.data.refreshExpiresAt) - now()) / 1000);
      if (accessSeconds < 1 || refreshSeconds < 1) return problem(401, "SESSION_EXPIRED");
      return withCookies(noStoreRedirect("/"), [
        cookie(ACCESS_COOKIE, grant.data.token, "/", Math.min(accessSeconds, 300), true),
        cookie(REFRESH_COOKIE, grant.data.refreshCredential, "/_platform", refreshSeconds, true),
        cookie(CSRF_COOKIE, csrf, "/", refreshSeconds, false),
      ]);
    }

    if (request.method === "POST" && url.pathname === "/_platform/logout") {
      const csrf = await csrfValue(config, instance);
      if (!validCsrf(request, instance, csrf)) return problem(403, "CSRF_INVALID");
      const refreshCredential = readCookie(request, REFRESH_COOKIE);
      if (refreshCredential) {
        const input = RevokeAccessRequestSchema.safeParse({
          contractVersion: "instance-access/v2",
          audience: "instance-access",
          appIdentity: instance.appIdentity,
        repositoryId: instance.repositoryId,
          hostname: instance.hostname,
          origin: instance.origin,
          refreshCredential,
        });
        if (input.success) {
          const upstream = await postGateway(config, "/internal/instance-access/revoke", input.data, fetcher);
          if (!upstream.ok) return upstream;
          const revoked = RevokeAccessResponseSchema.safeParse(await upstream.json().catch(() => null));
          if (!revoked.success) return problem(502, "INVALID_GATEWAY_RESPONSE");
        }
      }
      return withCookies(noStoreRedirect("/"), [
        expiredCookie(ACCESS_COOKIE, "/", true),
        expiredCookie(REFRESH_COOKIE, "/_platform", true),
        expiredCookie(CSRF_COOKIE, "/", false),
      ]);
    }

    if (request.method === "GET" && url.pathname === "/_platform/reauth") {
      if (!isHtmlNavigation(request) || request.headers.get("Sec-Fetch-Site") !== "same-origin")
        return problem(400, "REAUTH_REQUIRES_NAVIGATION");
      return fallbackEntry(instance, config);
    }

    if (isHtmlNavigation(request)) return fallbackEntry(instance, config, true);
    // MCP/API callers do not use the browser handoff. A bearer grant can
    // authorize a wake through the Gateway without forwarding application
    // headers, buffering the request body or minting an instance cookie.
    const authorization = request.headers.get("Authorization");
    if (authorization && /^Bearer [A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$/.test(authorization) &&
        authorization.length <= 16_400 && !request.headers.has("Cookie")) {
      const wake = await postGateway(config, "/internal/instance-access/wake", {
        appIdentity: instance.appIdentity,
        repositoryId: instance.repositoryId,
        origin: instance.origin,
        accessGrant: authorization.slice(7),
      }, fetcher);
      if (!wake.ok) return wake;
    } else if (authorization) {
      return problem(401, "ACCESS_GRANT_INVALID");
    }
    if (request.method === "HEAD") return new Response(null, { status: 503, headers: { "Retry-After": String(RETRY_AFTER_SECONDS), "Cache-Control": "no-store" } });
    return problem(503, "INSTANCE_STARTING", true);
  });

  app.onError(() => problem(500, "INSTANCE_ACCESS_UNAVAILABLE"));
  return async (request) => {
    const response = await app.fetch(request);
    if (response.status < 400 || !request.headers.get("Accept")?.includes("text/html")) return response;
    const appBinding = validInstanceFromHost(request);
    if (!appBinding) return response;
    const authError = response.status === 401 || response.status === 403;
    const state = authError ? "AuthError" : "RouteError";
    const retry = `${config.gatewayOrigin}/entry/scriptorium/${appBinding.repositoryId}`;
    return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${state}</title></head><body><main><h1>${state}</h1><p>Application entry could not be completed. Automatic entry has stopped.</p><p><a href="${retry}">Retry application entry</a></p><p><a href="${config.gatewayOrigin}/repositories/${appBinding.repositoryId}">Open repository dashboard</a></p></main></body></html>`, {
      status: response.status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" },
    });
  };
}

/** Backwards-compatible Node adapter entry point; validation remains fail-closed. */
export function handleInstanceAccessRequest(
  request: Request,
  env: InstanceAccessEnvironment,
  fetcher: Fetch = fetch,
  now: () => number = Date.now,
): Promise<Response> {
  return createInstanceAccessHandler(env, fetcher, now)(request);
}
