import {
  AccessGrantId, deriveCodeChallengeS256, generateToken, generateUlid,
  isSafeRelativeRedirect, issueAccessGrant,
} from "@praetorium/auth";
import { applicationFromHostname, applicationHostname, publicRuntimeIdentity, type AppIdentity } from "@praetorium/contracts";
import type { GatewayContext } from "../context.js";
import { requireSession, hasValidGatewayCsrf } from "../http/session.js";
import { runtimeEpochForAccess } from "../active-runtime.js";
import { createOAuthStorage, type OAuthClientRecord, type OAuthCodeRecord, type OAuthRefreshRecord } from "./oauth-storage.js";

const MAX_BODY_BYTES = 8_192;
const SCOPE_SET = new Set(["read", "write"]);
const CODE_TTL_MS = 300_000;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: {
    "Cache-Control": "no-store", "Pragma": "no-cache", "Referrer-Policy": "no-referrer",
  } });
}
function oauthError(code: string, status = 400): Response {
  return json({ error: code }, status);
}
function redirect(uri: string): Response {
  return new Response(null, { status: 302, headers: {
    Location: uri, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
  } });
}
function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function htmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
function originOfResource(raw: string): { appIdentity: AppIdentity; repositoryId: number } | null {
  try {
    const uri = new URL(raw);
    if (uri.protocol !== "https:" || uri.origin !== raw || uri.username || uri.password ||
        uri.pathname !== "/" || uri.search || uri.hash) return null;
    const app = applicationFromHostname(uri.hostname);
    return applicationHostname(app.appIdentity, app.repositoryId) === uri.hostname ? app : null;
  } catch { return null; }
}
function scopesOf(raw: string): ("read" | "write")[] | null {
  const parts = raw.split(" ").filter(Boolean);
  if (parts.length < 1 || parts.length > 2 || parts.some((p) => !SCOPE_SET.has(p)) ||
      new Set(parts).size !== parts.length || !parts.includes("read")) return null;
  return parts as ("read" | "write")[];
}
function allowedRedirectUri(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.username || url.password || url.hash || raw.length > 1024) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]");
  } catch { return false; }
}
function single(params: URLSearchParams, key: string): string | null {
  const items = params.getAll(key);
  return items.length === 1 ? items[0]! : null;
}
async function boundedForm(request: Request): Promise<URLSearchParams | null> {
  if (request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !==
      "application/x-www-form-urlencoded") return null;
  const length = request.headers.get("Content-Length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let count = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      count += item.value.byteLength;
      if (count > MAX_BODY_BYTES) { await reader.cancel(); return null; }
      chunks.push(item.value);
    }
    const body = new Uint8Array(count);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
    const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
    decodeURIComponent(decoded.replace(/\+/g, " "));
    return new URLSearchParams(decoded);
  } catch { return null; }
}
function storage(context: GatewayContext) {
  return createOAuthStorage(context.env.EPHEMERAL_CODES, context.config.credentialPepper);
}
function clientIdFormat(id: string): boolean {
  return /^praetorium_cl_[A-Za-z0-9_-]{22}$/.test(id);
}
function formResource(data: URLSearchParams, key = "resource"): string | null {
  const raw = single(data, key);
  return raw && originOfResource(raw) ? raw : null;
}
function errorRedirect(target: string, state: string, issuer: string): Response {
  const url = new URL(target);
  url.searchParams.set("error", "access_denied");
  url.searchParams.set("state", state);
  url.searchParams.set("iss", issuer);
  return redirect(url.toString());
}
async function activeSession(context: GatewayContext, digest: string, userId: string) {
  const record = await context.sessionStore.get(digest);
  return record && record.userId === userId &&
    (!record.revokedAt || Date.parse(record.revokedAt) > Date.parse(context.requestNow)) &&
    Date.parse(record.expiresAt) > Date.parse(context.requestNow) ? record : null;
}
async function authorizedResource(
  context: GatewayContext, resource: string, userId: string, requested: readonly ("read" | "write")[],
) {
  const binding = originOfResource(resource);
  if (!binding) return null;
  const snapshot = await context.controlPlane.getByRepositoryId(binding.repositoryId);
  if (!snapshot || snapshot.binding.suspended ||
      snapshot.binding.repositoryId !== binding.repositoryId ||
      snapshot.instance.repositoryId !== binding.repositoryId ||
      (snapshot.binding.appIdentity ?? "scriptorium") !== binding.appIdentity) return null;
  const epoch = runtimeEpochForAccess(snapshot.instance);
  const access = await context.githubAccess.checkBoundAccess(
    userId, binding.repositoryId, snapshot.instance.instanceId, epoch, context.requestNow,
  );
  if (access.status !== "allowed" || access.repositoryId !== binding.repositoryId ||
      access.instanceId !== snapshot.instance.instanceId || access.runtimeEpoch !== epoch ||
      access.installationId !== snapshot.binding.installationId ||
      access.authorizationRevision !== snapshot.binding.authorizationRevision ||
      access.origin !== resource ||
      access.expiresAt <= Date.parse(context.requestNow) ||
      requested.some((permission) => !access.permissions.includes(permission))) return null;
  return { snapshot, access, epoch };
}

async function issueToken(
  context: GatewayContext, input: OAuthCodeRecord | OAuthRefreshRecord,
): Promise<{ access_token: string; token_type: "Bearer"; expires_in: number } | null> {
  const session = await activeSession(context, input.sessionDigest, input.userId);
  if (!session) return null;
  const authorized = await authorizedResource(context, input.resource, input.userId, input.permissions);
  if (!authorized) return null;
  const seconds = Math.min(
    context.config.accessGrantTtlSeconds, 300,
    Math.floor((Date.parse(session.expiresAt) - Date.parse(context.requestNow)) / 1000),
    Math.floor((authorized.access.expiresAt - Date.parse(context.requestNow)) / 1000),
  );
  if (seconds < 1) return null;
  const grant = await issueAccessGrant(await context.getSigningKey(), {
    id: AccessGrantId.parse("agr_" + generateUlid()),
    issuer: context.config.origin, audience: input.resource, subjectUserId: input.userId,
    repositoryId: input.repositoryId,
    audienceInstanceId: publicRuntimeIdentity(authorized.snapshot.instance),
    runtimeEpoch: authorized.epoch, permissions: input.permissions,
    sessionRevision: session.sessionRevision, authorizationRevision: authorized.access.authorizationRevision,
    now: context.requestNow, ttlSeconds: seconds,
  });
  return { access_token: grant.token, token_type: "Bearer", expires_in: seconds };
}

export function authorizationServerMetadata(context: GatewayContext): Response {
  const issuer = context.config.origin;
  return json({
    issuer,
    authorization_endpoint: issuer + "/oauth/authorize",
    token_endpoint: issuer + "/oauth/token",
    registration_endpoint: issuer + "/oauth/register",
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["read", "write"],
    authorization_response_iss_parameter_supported: true,
  });
}

/** Dynamic registration is for public PKCE clients, not a grant of any repository authority. */
export async function registerOAuthClient(request: Request, context: GatewayContext): Promise<Response> {
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip || ip.length > 64 || /[,\s]/.test(ip)) return oauthError("temporarily_unavailable", 503);
  try {
    if (!(await context.tokenExchangeSourceRateLimiter.consume(ip, context.requestNow)))
      return oauthError("temporarily_unavailable", 429);
    if (request.headers.get("Content-Type")?.split(";", 1)[0]?.trim() !== "application/json")
      return oauthError("invalid_client_metadata");
    const announced = request.headers.get("Content-Length");
    if (announced && (!/^\d+$/.test(announced) || Number(announced) > MAX_BODY_BYTES))
      return oauthError("invalid_client_metadata");
    const reader = request.body?.getReader();
    if (!reader) return oauthError("invalid_client_metadata");
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > MAX_BODY_BYTES) { await reader.cancel(); return oauthError("invalid_client_metadata"); }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(length);
    let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
    const input: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
    if (!input || typeof input !== "object" || Array.isArray(input)) return oauthError("invalid_client_metadata");
    const data = input as Record<string, unknown>;
    const name = data.client_name;
    const redirects = data.redirect_uris;
    if (typeof name !== "string" || name.length < 1 || name.length > 80 ||
        hasControlCharacters(name) || !Array.isArray(redirects) ||
        redirects.length < 1 || redirects.length > 5 ||
        redirects.some((uri) => typeof uri !== "string" || !allowedRedirectUri(uri)) ||
        new Set(redirects).size !== redirects.length ||
        (data.token_endpoint_auth_method !== undefined && data.token_endpoint_auth_method !== "none") ||
        (data.grant_types !== undefined &&
          (!Array.isArray(data.grant_types) || !data.grant_types.includes("authorization_code"))) ||
        (data.response_types !== undefined &&
          (!Array.isArray(data.response_types) || !data.response_types.includes("code"))))
      return oauthError("invalid_client_metadata");
    const record: OAuthClientRecord = {
      clientId: "praetorium_cl_" + generateToken(128), clientName: name,
      redirectUris: redirects as string[],
    };
    await storage(context).saveClient(record);
    return json({
      client_id: record.clientId, client_id_issued_at: Math.floor(Date.parse(context.requestNow) / 1000),
      client_name: record.clientName, redirect_uris: record.redirectUris,
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
      token_endpoint_auth_method: "none",
    }, 201);
  } catch { return oauthError("temporarily_unavailable", 503); }
}

type AuthorizationInput = {
  clientId: string; redirectUri: string; resource: string;
  state: string; challenge: string; permissions: ("read" | "write")[];
  clientName: string;
};
async function validateAuthorization(
  params: URLSearchParams, context: GatewayContext,
): Promise<AuthorizationInput | null> {
  const clientId = single(params, "client_id");
  const redirectUri = single(params, "redirect_uri");
  const resource = formResource(params);
  const state = single(params, "state");
  const challenge = single(params, "code_challenge");
  const scopes = scopesOf(single(params, "scope") ?? "read");
  if (!clientId || !clientIdFormat(clientId) || !redirectUri || !resource ||
      !state || state.length < 8 || state.length > 512 || !challenge ||
      !/^[A-Za-z0-9_-]{43}$/.test(challenge) || !scopes ||
      single(params, "response_type") !== "code" || single(params, "code_challenge_method") !== "S256")
    return null;
  const client = await storage(context).getClient(clientId);
  if (!client || !client.redirectUris.includes(redirectUri)) return null;
  return { clientId, redirectUri, resource, state, challenge, permissions: scopes, clientName: client.clientName };
}

export async function authorizeOAuth(
  request: Request, context: GatewayContext,
): Promise<Response> {
  const params = request.method === "GET"
    ? new URL(request.url).searchParams : await boundedForm(request);
  if (!params) return oauthError("invalid_request");
  try {
    const input = await validateAuthorization(params, context);
    if (!input) return oauthError("invalid_request");
    const session = await requireSession(request, context);
    if (!session.ok) {
      const back = new URL(request.url);
      // A login round-trip must retain the entire validated OAuth request.
      if (request.method === "POST") return oauthError("login_required", 401);
      const login = new URL("/auth/login", context.config.origin);
      const returnPath = back.pathname + back.search;
      if (!isSafeRelativeRedirect(returnPath)) return oauthError("invalid_request");
      login.searchParams.set("redirect_to", returnPath);
      return redirect(login.toString());
    }
    const resource = originOfResource(input.resource)!;
    const fresh = await authorizedResource(context, input.resource, session.session.actor.userId, input.permissions);
    if (!fresh || fresh.snapshot.binding.repositoryId !== resource.repositoryId)
      return oauthError("access_denied", 403);
    if (request.method === "GET") {
      const hidden: Record<string, string> = {
        client_id: input.clientId, redirect_uri: input.redirectUri,
        resource: input.resource, state: input.state,
        code_challenge: input.challenge, code_challenge_method: "S256",
        response_type: "code", scope: input.permissions.join(" "),
      };
      const fields = Object.entries(hidden).map(([key, value]) =>
        '<input type="hidden" name="' + key + '" value="' + htmlEscape(value) + '">').join("");
      return new Response('<!doctype html><html lang="en"><meta charset="utf-8">' +
        '<meta name="referrer" content="no-referrer"><title>MCP access approval</title>' +
        '<main><h1>Allow MCP access?</h1><p>' + htmlEscape(input.clientName) +
        ' requests ' + htmlEscape(input.permissions.join(", ")) + ' access to ' +
        htmlEscape(input.resource) + '.</p><form method="post" action="/oauth/authorize">' +
        fields + '<input type="hidden" name="csrfToken" value="' +
        htmlEscape(session.session.csrfToken) + '">' +
        '<button type="submit" name="decision" value="approve">Allow</button>' +
        '<button type="submit" name="decision" value="deny">Deny</button></form></main></html>', {
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer", "Content-Security-Policy":
              "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; style-src 'none'" },
        });
    }
    const csrfForm = new FormData();
    csrfForm.set("csrfToken", single(params, "csrfToken") ?? "");
    if (!(await hasValidGatewayCsrf(request, context, session.session, csrfForm)))
      return oauthError("access_denied", 403);
    if (single(params, "decision") !== "approve")
      return errorRedirect(input.redirectUri, input.state, context.config.origin);
    const code = generateToken(256);
    const record: OAuthCodeRecord = {
      clientId: input.clientId, redirectUri: input.redirectUri, resource: input.resource,
      challenge: input.challenge, permissions: input.permissions,
      repositoryId: resource.repositoryId, userId: session.session.actor.userId,
      sessionDigest: session.session.resolved.digest,
      expiresAt: new Date(Date.parse(context.requestNow) + CODE_TTL_MS).toISOString(),
    };
    await storage(context).saveCode(code, record);
    const callback = new URL(input.redirectUri);
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", input.state);
    callback.searchParams.set("iss", context.config.origin);
    return redirect(callback.toString());
  } catch { return oauthError("temporarily_unavailable", 503); }
}

export async function exchangeOAuthToken(
  request: Request, context: GatewayContext,
): Promise<Response> {
  const params = await boundedForm(request);
  if (!params || request.headers.has("Authorization") || request.headers.has("Cookie"))
    return oauthError("invalid_request");
  const grantType = single(params, "grant_type");
  const clientId = single(params, "client_id");
  const resource = formResource(params);
  if (!clientId || !clientIdFormat(clientId) || !resource) return oauthError("invalid_client", 401);
  try {
    const client = await storage(context).getClient(clientId);
    if (!client) return oauthError("invalid_client", 401);
    if (grantType === "authorization_code") {
      const code = single(params, "code");
      const verifier = single(params, "code_verifier");
      const redirectUri = single(params, "redirect_uri");
      if (!code || !/^[A-Za-z0-9_-]{43}$/.test(code) ||
          !verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
          !redirectUri || !client.redirectUris.includes(redirectUri)) return oauthError("invalid_grant");
      const record = await storage(context).consumeCode(code);
      if (!record || record.clientId !== clientId || record.redirectUri !== redirectUri ||
          record.resource !== resource || Date.parse(record.expiresAt) <= Date.parse(context.requestNow) ||
          record.challenge !== await deriveCodeChallengeS256(verifier)) return oauthError("invalid_grant");
      const token = await issueToken(context, record);
      if (!token) return oauthError("invalid_grant");
      const session = await activeSession(context, record.sessionDigest, record.userId);
      if (!session) return oauthError("invalid_grant");
      const refresh = await storage(context).createRefresh({
        clientId, resource, userId: record.userId, sessionDigest: record.sessionDigest,
        repositoryId: record.repositoryId, permissions: record.permissions,
        expiresAt: session.expiresAt, revokedAt: null,
      });
      return json({ ...token, refresh_token: refresh, scope: record.permissions.join(" ") });
    }
    if (grantType === "refresh_token") {
      const raw = single(params, "refresh_token");
      if (!raw) return oauthError("invalid_grant");
      const store = storage(context);
      const current = await store.getRefresh(raw, clientId, resource, context.requestNow);
      if (!current) return oauthError("invalid_grant");
      // Do not consume a refresh secret when upstream repository authority is unavailable.
      const token = await issueToken(context, current);
      if (!token) return oauthError("invalid_grant");
      // Rotation is atomic: only one racing refresh may return a token.
      const rotated = await store.rotateRefresh(raw, clientId, resource, context.requestNow);
      if (!rotated) return oauthError("invalid_grant");
      return json({ ...token, refresh_token: rotated.nextToken,
        scope: rotated.record.permissions.join(" ") });
    }
    return oauthError("unsupported_grant_type");
  } catch { return oauthError("temporarily_unavailable", 503); }
}
