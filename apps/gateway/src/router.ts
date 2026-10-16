import {
  buildExpiredSessionCookie,
  buildSessionCookie,
  completeInstanceHandoff,
  constantTimeEqual,
  createAccessRefreshCredential,
  createMcpCredential,
  createSession,
  exchangeMcpCredentialForAccessToken,
  generateToken,
  handleGithubCallbackWithCredentialSink,
  isSafeRelativeRedirect,
  keyedDigest,
  listMcpCredentialsForUser,
  issueMutationAuthorizationReceipt,
  refreshAccessGrant,
  revokeAccessRefreshCredential,
  revokeAllMcpCredentialsForUser,
  revokeAllSessionsForUser,
  revokeMcpCredential,
  revokeSession,
  startGithubLogin,
  touchSession,
  type UserId,
  type McpCredentialId,
} from "@praetorium/auth";
import {
  RedeemHandoffRequestSchema,
  DigestSchema,
  RefreshAccessRequestSchema,
  RevokeAccessRequestSchema,
  instanceHostname,
} from "@praetorium/contracts";
import { newMcpCredentialId } from "@praetorium/domain";
import { GITHUB_PUBLISH_RECEIPT_AUDIENCE } from "@praetorium/github";
import { Hono } from "hono";
import { z } from "zod";
import {
  LOGIN_ATTEMPT_TTL_SECONDS,
  SESSION_CONCURRENCY_LIMIT,
} from "./constants.js";
import type { GatewayContext } from "./context.js";
import { createGitHubWebhookRoutes, createGitHubWebhookControlPlaneClient } from "./github-webhook.js";
import { runtimeEpochForAccess } from "./active-runtime.js";
import { createPortalHandler } from "./ui/index.js";
import type { PortalActor, PortalSession } from "./ui/index.js";
import { createPortalService } from "./services/portal-service.js";
import { errorResponse } from "./middleware/error-response.js";
import {
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  LOGIN_NONCE_COOKIE_NAME,
  hasCookieName,
  hasValidGatewayCsrf,
  readCookie,
  requireSession,
  sessionCsrfToken,
} from "./http/session.js";

const MAX_INTERNAL_BODY_BYTES = 8_192;
const INSTANCE_STARTING_RETRY_SECONDS = 5;
const MAX_DIRECT_ENTRY_POLLS = 5;
const TOKEN_PERMISSIONS = new Set(["read", "write", "maintain", "admin"]);
const MutationReceiptRequestSchema = z.strictObject({
  operationId: z.string().min(1).max(128).refine((value) => !hasControlCharacters(value)),
  payloadDigest: DigestSchema,
});
const RuntimeIdentityProofSchema = z.strictObject({
  serviceToken: z.string().min(16).max(4_096),
  runtimeId: z.string().min(1).max(128).refine((value) => !hasControlCharacters(value)),
  instanceId: z.string().min(1).max(128).refine((value) => !hasControlCharacters(value)),
  repositoryId: z.number().int().positive().safe(),
  installationId: z.number().int().positive().safe(),
  runtimeEpoch: z.number().int().nonnegative().safe(),
  leaseId: z.string().min(1).max(256).refine((value) => !hasControlCharacters(value)),
});
const RuntimeGitCredentialRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("fetch"), proof: RuntimeIdentityProofSchema }),
  z.strictObject({
    operation: z.literal("publish"),
    proof: RuntimeIdentityProofSchema,
    mutationReceipt: z.string().min(16).max(16_384),
    operationId: z.string().min(1).max(128).refine((value) => !hasControlCharacters(value)),
    payloadDigest: DigestSchema,
  }),
]);

function json(body: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Cache-Control", "no-store");
  headers.set("Referrer-Policy", "no-referrer");
  return Response.json(body, { status, headers });
}

function setCookie(response: Response, cookie: string): Response {
  const headers = new Headers(response.headers);
  headers.append("Set-Cookie", cookie);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function csrfCookie(token: string, maxAge: number): string {
  return `${CSRF_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Secure; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAge))}`;
}

function expiredCsrfCookie(): string {
  return `${CSRF_COOKIE_NAME}=; Path=/; Secure; SameSite=Lax; Max-Age=0`;
}

function loginNonceCookie(value: string, maxAge: number): string {
  return `${LOGIN_NONCE_COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

function expireLoginNonceCookie(): string {
  return `${LOGIN_NONCE_COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function safeRedirectTarget(url: URL): string {
  const requested = url.searchParams.get("redirect_to") ?? "/";
  return isSafeRelativeRedirect(requested) ? requested : "/";
}

function loginRedirect(request: Request, context: GatewayContext): Response {
  const url = new URL(request.url);
  const path = request.method === "GET" && !url.pathname.startsWith("/auth/")
    ? url.pathname
    : "/";
  const start = new URL("/auth/github/start", context.config.origin);
  start.searchParams.set("redirect_to", isSafeRelativeRedirect(path) ? path : "/");
  return new Response(null, {
    status: 302,
    headers: { Location: start.toString(), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}

async function readBoundedJson(request: Request): Promise<Record<string, unknown> | null> {
  const mediaType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") return null;
  const rawLength = request.headers.get("Content-Length");
  if (rawLength !== null && (!/^(0|[1-9][0-9]*)$/.test(rawLength) || Number(rawLength) > MAX_INTERNAL_BODY_BYTES)) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_INTERNAL_BODY_BYTES) {
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
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function safeUserId(value: string): UserId | null {
  return /^[1-9][0-9]{0,15}$/.test(value) && Number.isSafeInteger(Number(value))
    ? value as UserId
    : null;
}

function numericRepositoryId(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value !== "string" || !/^[1-9][0-9]{0,15}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function safePermissions(value: unknown): readonly ("read" | "write" | "maintain" | "admin")[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > TOKEN_PERMISSIONS.size) return null;
  if (!value.every((item) => typeof item === "string" && TOKEN_PERMISSIONS.has(item))) return null;
  const unique = [...new Set(value as string[])];
  return unique.includes("read") ? unique as ("read" | "write" | "maintain" | "admin")[] : null;
}

function accessDenied(request: Request, context: GatewayContext): Response {
  return errorResponse(request, "FORBIDDEN", "current GitHub repository access is required", context.requestId);
}

function unavailable(request: Request, context: GatewayContext): Response {
  const response = errorResponse(request, "UPSTREAM_UNAVAILABLE", "repository authority is temporarily unavailable", context.requestId);
  response.headers.set("Retry-After", String(INSTANCE_STARTING_RETRY_SECONDS));
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function exactOriginRequest(request: Request, context: GatewayContext): boolean {
  return request.headers.get("Origin") === context.config.origin && request.headers.get("Sec-Fetch-Site") !== "cross-site";
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint < 0x20 || codePoint === 0x7f) return true;
  }
  return false;
}

async function handleGithubStart(request: Request, context: GatewayContext, now: string): Promise<Response> {
  const url = new URL(request.url);
  const allowed = await context.loginRateLimiter.consume(request.headers.get("CF-Connecting-IP") ?? "unknown", now);
  if (!allowed) return errorResponse(request, "RATE_LIMITED", "too many login attempts", context.requestId);
  const browserNonce = generateToken(256);
  try {
    const login = await startGithubLogin(context.githubProvider, context.loginAttemptStore, {
      browserNonce,
      redirectUri: `${context.config.origin}/auth/github/callback`,
      redirectTo: safeRedirectTarget(url),
      scopes: ["offline_access"],
      now,
      attemptTtlSeconds: LOGIN_ATTEMPT_TTL_SECONDS,
    });
    return new Response(null, {
      status: 302,
      headers: {
        Location: login.authorizeUrl,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Set-Cookie": loginNonceCookie(browserNonce, LOGIN_ATTEMPT_TTL_SECONDS),
      },
    });
  } catch {
    return unavailable(request, context);
  }
}

async function handleGithubCallback(request: Request, context: GatewayContext, now: string): Promise<Response> {
  try {
    return setCookie(await completeGithubCallback(request, context, now), expireLoginNonceCookie());
  } catch {
    return setCookie(
      errorResponse(request, "UNAUTHENTICATED", "GitHub login failed", context.requestId),
      expireLoginNonceCookie(),
    );
  }
}

async function completeGithubCallback(request: Request, context: GatewayContext, now: string): Promise<Response> {
  const url = new URL(request.url);
  const query = {
    state: url.searchParams.get("state") ?? undefined,
    code: url.searchParams.get("code") ?? undefined,
    error: url.searchParams.get("error") ?? undefined,
  };
  const browserNonce = readCookie(request, LOGIN_NONCE_COOKIE_NAME);
  let result;
  try {
    result = await handleGithubCallbackWithCredentialSink(
      context.githubProvider,
      context.loginAttemptStore,
      `${context.config.origin}/auth/github/callback`,
      query,
      browserNonce,
      now,
      context.githubUserTokens,
    );
  } catch {
    return errorResponse(request, "UNAUTHENTICATED", "GitHub login failed", context.requestId);
  }
  if (!result.ok) {
    return errorResponse(request, "UNAUTHENTICATED", "GitHub login failed", context.requestId);
  }
  const userId = safeUserId(result.value.githubSubjectRef);
  if (!userId) {
    return errorResponse(request, "UNAUTHENTICATED", "GitHub identity is invalid", context.requestId);
  }
  const created = await createSession(context.sessionStore, {
    userId,
    authenticationContext: "github-oauth",
    now,
    ttlSeconds: context.config.sessionTtlSeconds,
    pepper: context.config.sessionPepper,
    concurrentSessionLimit: SESSION_CONCURRENCY_LIMIT,
  });
  if (!created.ok) {
    return errorResponse(request, "UPSTREAM_UNAVAILABLE", "Gateway session could not be created", context.requestId);
  }
  const csrf = await sessionCsrfToken(context, created.value.rawSessionId);
  const response = new Response(null, {
    status: 303,
    headers: {
      Location: isSafeRelativeRedirect(result.value.redirectTo) ? result.value.redirectTo : "/",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
  let withSession = setCookie(response, buildSessionCookie({ name: SESSION_COOKIE_NAME, ttlSeconds: context.config.sessionTtlSeconds }, created.value.rawSessionId));
  withSession = setCookie(withSession, csrfCookie(csrf, context.config.sessionTtlSeconds));
  return withSession;
}

async function handleSession(request: Request, context: GatewayContext, now: string): Promise<Response> {
  const result = await requireSession(request, context, now);
  if (!result.ok) return result.response;
  try {
    await touchSession(context.sessionStore, {
      digest: result.session.resolved.digest,
      record: result.session.resolved.record,
      now,
      bucketSeconds: 300,
      slidingTtlSeconds: context.config.sessionTtlSeconds,
    });
  } catch {
    return unavailable(request, context);
  }
  return json({ userId: result.session.actor.userId, expiresAt: result.session.resolved.record.expiresAt });
}

async function handleLogout(request: Request, context: GatewayContext, now: string, allDevices = false): Promise<Response> {
  if (!exactOriginRequest(request, context)) return errorResponse(request, "UNAUTHORIZED", "request origin or CSRF token is invalid", context.requestId);
  const result = await requireSession(request, context, now);
  if (!result.ok) {
    if (allDevices) return result.response;
  } else {
    if (!(await hasValidGatewayCsrf(request, context, result.session))) {
      return errorResponse(request, "UNAUTHORIZED", "request origin or CSRF token is invalid", context.requestId);
    }
    try {
      if (allDevices) await revokeAllSessionsForUser(context.sessionStore, result.session.actor.userId as UserId, now);
      else await revokeSession(context.sessionStore, result.session.resolved.digest, now);
    } catch {
      return unavailable(request, context);
    }
  }
  const response = new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  return setCookie(setCookie(response, buildExpiredSessionCookie({ name: SESSION_COOKIE_NAME })), expiredCsrfCookie());
}

async function handleCreateMcpCredential(request: Request, context: GatewayContext, now: string): Promise<Response> {
  const session = await requireSession(request, context, now);
  if (!session.ok) return session.response;
  if (!(await hasValidGatewayCsrf(request, context, session.session))) {
    return errorResponse(request, "UNAUTHORIZED", "request origin or CSRF token is invalid", context.requestId);
  }
  const body = await readBoundedJson(request);
  if (!body) return errorResponse(request, "INVALID_REQUEST", "credential request is invalid", context.requestId);
  const repositoryId = numericRepositoryId(body["repositoryId"]);
  const name = body["name"];
  const permissions = safePermissions(body["permissions"] ?? ["read"]);
  if (repositoryId === null || typeof name !== "string" || name.length < 1 || name.length > 80 || hasControlCharacters(name) || !permissions) {
    return errorResponse(request, "INVALID_REQUEST", "credential request is invalid", context.requestId);
  }
  try {
    const repository = await context.controlPlane.getByRepositoryId(repositoryId);
    if (!repository) return errorResponse(request, "NOT_FOUND", "repository instance not found", context.requestId);
    const decision = await context.githubAccess.checkBoundAccess(
      session.session.actor.userId,
      repositoryId,
      repository.instance.instanceId,
      runtimeEpochForAccess(repository.instance),
      now,
    );
    if (decision.status === "unavailable") return unavailable(request, context);
    if (!decisionMatches(decision, repository, repositoryId, now) || permissions.some((permission) => !decision.permissions.includes(permission))) {
      return accessDenied(request, context);
    }
    const created = await createMcpCredential(context.mcpCredentialStore, {
      id: newMcpCredentialId(Date.parse(now), crypto.getRandomValues(new Uint8Array(10))) as unknown as McpCredentialId,
      userId: session.session.actor.userId as UserId,
      sessionRevision: session.session.resolved.record.sessionRevision,
      repositoryId,
      instanceId: repository.instance.instanceId,
      runtimeEpoch: runtimeEpochForAccess(repository.instance),
      name,
      permissions,
      now,
      ttlSeconds: Math.min(90 * 24 * 60 * 60, Math.floor((Date.parse(session.session.resolved.record.expiresAt) - Date.parse(now)) / 1000)),
      pepper: context.config.credentialPepper,
    });
    return json({
      id: created.record.id,
      repositoryId,
      instanceId: created.record.instanceId,
      runtimeEpoch: created.record.runtimeEpoch,
      name,
      permissions: created.record.permissions,
      createdAt: created.record.createdAt,
      expiresAt: created.record.expiresAt,
      credential: created.plaintext,
    }, 201);
  } catch {
    return unavailable(request, context);
  }
}

/** Issues a metadata-only publication capability for one active session and current binding. */
async function handleMutationAuthorization(
  request: Request,
  context: GatewayContext,
  rawRepositoryId: string,
  now: string,
): Promise<Response> {
  if (!exactOriginRequest(request, context)) {
    return errorResponse(request, "UNAUTHORIZED", "request origin or CSRF token is invalid", context.requestId);
  }
  const session = await requireSession(request, context, now);
  if (!session.ok) return session.response;
  if (!(await hasValidGatewayCsrf(request, context, session.session))) {
    return errorResponse(request, "UNAUTHORIZED", "request origin or CSRF token is invalid", context.requestId);
  }
  const repositoryId = numericRepositoryId(rawRepositoryId);
  const body = await readBoundedJson(request);
  const parsed = body ? MutationReceiptRequestSchema.safeParse(body) : null;
  if (repositoryId === null || !parsed?.success) {
    return errorResponse(request, "INVALID_REQUEST", "mutation authorization request is invalid", context.requestId);
  }
  try {
    if (!(await context.mutationReceiptRateLimiter.consume(
      `${session.session.actor.userId}:${repositoryId}`,
      now,
    ))) return errorResponse(request, "RATE_LIMITED", "mutation authorization is rate limited", context.requestId);

    const snapshot = await context.controlPlane.getByRepositoryId(repositoryId);
    if (!snapshot) return errorResponse(request, "NOT_FOUND", "repository instance not found", context.requestId);
    const access = await context.githubAccess.checkBoundAccess(
      session.session.actor.userId,
      repositoryId,
      snapshot.instance.instanceId,
      runtimeEpochForAccess(snapshot.instance),
      now,
    );
    if (access.status === "unavailable") return unavailable(request, context);
    if (
      !decisionMatches(access, snapshot, repositoryId, now) ||
      !access.permissions.includes("write")
    ) return accessDenied(request, context);
    const receiptTtlSeconds = Math.min(
      60,
      context.config.accessGrantTtlSeconds,
      Math.floor((access.expiresAt - Date.parse(now)) / 1000),
      Math.floor((Date.parse(session.session.resolved.record.expiresAt) - Date.parse(now)) / 1000),
    );
    if (receiptTtlSeconds < 1) return accessDenied(request, context);

    const issued = await issueMutationAuthorizationReceipt(context.signingKey, {
      issuer: context.config.origin,
      audience: GITHUB_PUBLISH_RECEIPT_AUDIENCE,
      subjectUserId: session.session.actor.userId,
      repositoryId,
      instanceId: snapshot.instance.instanceId,
      runtimeEpoch: runtimeEpochForAccess(snapshot.instance),
      operationId: parsed.data.operationId,
      payloadDigest: parsed.data.payloadDigest,
      authorizationRevision: access.authorizationRevision,
      sessionRevision: session.session.resolved.record.sessionRevision,
      now,
      ttlSeconds: receiptTtlSeconds,
    });
    return json({
      contractVersion: issued.descriptor.contractVersion,
      receipt: issued.token,
      operationId: issued.descriptor.operationId,
      payloadDigest: issued.descriptor.payloadDigest,
      expiresAt: new Date(issued.descriptor.exp * 1000).toISOString(),
    }, 201);
  } catch {
    return unavailable(request, context);
  }
}

type BoundAccess = Awaited<ReturnType<GatewayContext["githubAccess"]["checkBoundAccess"]>>;

function decisionMatches(
  decision: BoundAccess,
  snapshot: Awaited<ReturnType<GatewayContext["controlPlane"]["getByRepositoryId"]>>,
  repositoryId: number,
  now: string,
): decision is Extract<BoundAccess, { status: "allowed" }> {
  return Boolean(snapshot && decision.status === "allowed" && decision.repositoryId === repositoryId &&
    decision.instanceId === snapshot.instance.instanceId && decision.runtimeEpoch === runtimeEpochForAccess(snapshot.instance) &&
    decision.installationId === snapshot.binding.installationId &&
    decision.authorizationRevision === snapshot.binding.authorizationRevision &&
    decision.expiresAt > Date.parse(now) && decision.permissions.includes("read"));
}

async function handleListMcpCredentials(request: Request, context: GatewayContext, now: string): Promise<Response> {
  const session = await requireSession(request, context, now);
  if (!session.ok) return session.response;
  try {
    const entries = await listMcpCredentialsForUser(context.mcpCredentialStore, session.session.actor.userId as UserId);
    return json({ credentials: entries.map(({ record }) => ({
      id: record.id,
      repositoryId: record.repositoryId,
      instanceId: record.instanceId,
      runtimeEpoch: record.runtimeEpoch,
      name: record.name,
      permissions: record.permissions,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      lastUsedAt: record.lastUsedAt,
      revokedAt: record.revokedAt,
    })) });
  } catch {
    return unavailable(request, context);
  }
}

async function handleRevokeMcpCredential(request: Request, context: GatewayContext, now: string, id: string | null): Promise<Response> {
  const session = await requireSession(request, context, now);
  if (!session.ok) return session.response;
  if (!(await hasValidGatewayCsrf(request, context, session.session))) {
    return errorResponse(request, "UNAUTHORIZED", "request origin or CSRF token is invalid", context.requestId);
  }
  try {
    if (id === null) {
      await revokeAllMcpCredentialsForUser(context.mcpCredentialStore, session.session.actor.userId as UserId, now);
      return json({ revoked: true });
    }
    const entries = await listMcpCredentialsForUser(context.mcpCredentialStore, session.session.actor.userId as UserId);
    const entry = entries.find(({ record }) => record.id === id);
    if (!entry) return errorResponse(request, "NOT_FOUND", "credential not found", context.requestId);
    await revokeMcpCredential(context.mcpCredentialStore, entry.digest, now);
    return json({ revoked: true });
  } catch {
    return unavailable(request, context);
  }
}

async function handleTokenExchange(request: Request, context: GatewayContext, now: string): Promise<Response> {
  const authorization = request.headers.get("Authorization") ?? "";
  if (!authorization.startsWith("Bearer ") || hasCookieName(request, SESSION_COOKIE_NAME)) {
    return errorResponse(request, "UNAUTHENTICATED", "a single MCP bearer credential is required", context.requestId);
  }
  const body = await readBoundedJson(request);
  if (!body) return errorResponse(request, "INVALID_REQUEST", "token exchange request is invalid", context.requestId);
  const repositoryId = numericRepositoryId(body["repositoryId"]);
  const instanceId = body["instanceId"];
  const runtimeEpoch = body["runtimeEpoch"];
  const permissions = safePermissions(body["permissions"]);
  if (repositoryId === null || typeof instanceId !== "string" || !Number.isSafeInteger(runtimeEpoch) || (runtimeEpoch as number) < 0 || !permissions) {
    return errorResponse(request, "INVALID_REQUEST", "token exchange request is invalid", context.requestId);
  }
  try {
    const snapshot = await context.controlPlane.getByInstanceId(instanceId);
    if (!snapshot || snapshot.binding.repositoryId !== repositoryId || runtimeEpochForAccess(snapshot.instance) !== runtimeEpoch) {
      return errorResponse(request, "UNAUTHENTICATED", "credential is invalid", context.requestId);
    }
    const rateKey = await keyedDigest(context.config.credentialPepper, `exchange:${authorization.slice("Bearer ".length)}`);
    const exchanged = await exchangeMcpCredentialForAccessToken({
      credentialStore: context.mcpCredentialStore,
      credentialPepper: context.config.credentialPepper,
      repositoryAccessChecker: context.githubAccess,
      rateLimiter: context.tokenExchangeRateLimiter,
      signingKey: context.signingKey,
      issuer: context.config.origin,
      tokenTtlSeconds: context.config.accessGrantTtlSeconds,
      lastUsedBucketSeconds: 300,
    }, {
      credentialPlaintext: authorization.slice("Bearer ".length),
      requestedRepositoryId: repositoryId,
      requestedInstanceId: instanceId,
      requestedRuntimeEpoch: runtimeEpoch as number,
      requestedPermissions: permissions,
      now,
      rateLimitKey: rateKey,
    });
    if (!exchanged.ok) return errorResponse(request, exchanged.error.code === "RATE_LIMITED" ? "RATE_LIMITED" : "UNAUTHENTICATED", "credential is invalid or access has changed", context.requestId);
    return json(exchanged.value);
  } catch {
    return unavailable(request, context);
  }
}

/** Runtime Git credentials are issued only by the configured T02 broker, after its proof and binding checks. */
async function handleRuntimeGitCredential(request: Request, context: GatewayContext): Promise<Response> {
  const body = await readBoundedJson(request);
  const parsed = body ? RuntimeGitCredentialRequestSchema.safeParse(body) : null;
  if (!parsed?.success) return errorResponse(request, "INVALID_REQUEST", "runtime credential request is invalid", context.requestId);
  if (hasCookieName(request, SESSION_COOKIE_NAME)) return errorResponse(request, "UNAUTHENTICATED", "runtime credentials cannot use a browser session", context.requestId);
  if (!context.githubCredentialBroker) return unavailable(request, context);
  const remote = request.headers.get("CF-Connecting-IP") ?? "unknown";
  try {
    const rateKey = await keyedDigest(context.config.credentialPepper, `runtime-git-credential:${remote}`);
    if (!(await context.runtimeCredentialRateLimiter.consume(rateKey, context.requestNow))) {
      return errorResponse(request, "RATE_LIMITED", "runtime credential issuance is rate limited", context.requestId);
    }
    const result = await context.githubCredentialBroker.issue({ ...parsed.data, now: context.requestNow });
    if (result.status === "issued") return json(result.credential);
    if (result.status === "denied") return errorResponse(request, "UNAUTHENTICATED", "runtime credential is not authorized", context.requestId);
    return unavailable(request, context);
  } catch {
    return unavailable(request, context);
  }
}

function serviceAuthenticated(request: Request, context: GatewayContext): boolean {
  const value = request.headers.get("Authorization");
  return value?.startsWith("Bearer ") === true && constantTimeEqual(value.slice(7), context.config.instanceAccessSecret);
}

async function instanceAccessBinding(request: Request, context: GatewayContext): Promise<{
  readonly input: ReturnType<typeof RedeemHandoffRequestSchema.parse> | ReturnType<typeof RefreshAccessRequestSchema.parse>;
  readonly snapshot: NonNullable<Awaited<ReturnType<GatewayContext["controlPlane"]["getByInstanceId"]>>>;
  readonly origin: string;
} | Response> {
  const body = await readBoundedJson(request);
  if (!body) return errorResponse(request, "INVALID_REQUEST", "instance access request is invalid", context.requestId);
  const handoff = RedeemHandoffRequestSchema.safeParse(body);
  const refresh = RefreshAccessRequestSchema.safeParse(body);
  const input = handoff.success ? handoff.data : refresh.success ? refresh.data : null;
  if (!input) return errorResponse(request, "INVALID_REQUEST", "instance access request is invalid", context.requestId);
  if (!serviceAuthenticated(request, context)) return errorResponse(request, "UNAUTHENTICATED", "instance access service authentication failed", context.requestId);
  let expectedHost: string;
  try {
    expectedHost = instanceHostname(input.instanceId, context.config.instanceHostnameSuffix);
  } catch {
    return errorResponse(request, "INVALID_REQUEST", "instance access binding is invalid", context.requestId);
  }
  const expectedOrigin = `https://${expectedHost}`;
  if (input.hostname !== expectedHost || input.origin !== expectedOrigin || new URL(input.origin).origin !== expectedOrigin) {
    return errorResponse(request, "INVALID_REQUEST", "instance access binding is invalid", context.requestId);
  }
  let snapshot;
  try {
    snapshot = await context.controlPlane.getByInstanceId(input.instanceId);
  } catch {
    return unavailable(request, context);
  }
  if (!snapshot || snapshot.binding.instanceId !== input.instanceId || snapshot.instance.instanceId !== input.instanceId) {
    return errorResponse(request, "NOT_FOUND", "instance not found", context.requestId);
  }
  return { input, snapshot, origin: expectedOrigin };
}

async function handleInstanceAccessHandoff(request: Request, context: GatewayContext, now: string): Promise<Response> {
  const bound = await instanceAccessBinding(request, context);
  if (bound instanceof Response) return bound;
  if (!("code" in bound.input)) return errorResponse(request, "INVALID_REQUEST", "handoff request is invalid", context.requestId);
  const completed = await completeInstanceHandoff({
    handoffStore: context.handoffStore,
    sessionStore: context.sessionStore,
    repositoryAccessChecker: context.githubAccess,
    codePepper: context.config.handoffPepper,
    signingKey: context.signingKey,
    issuer: context.config.origin,
    tokenTtlSeconds: context.config.accessGrantTtlSeconds,
  }, {
    rawCode: bound.input.code,
    presentedHostname: bound.input.hostname,
    presentedRepositoryId: bound.snapshot.binding.repositoryId,
    presentedInstanceId: bound.input.instanceId,
    presentedRuntimeEpoch: runtimeEpochForAccess(bound.snapshot.instance),
    presentedOrigin: bound.origin,
    presentedReturnPath: bound.input.returnPath,
    presentedAudience: bound.input.audience,
    now,
  });
  if (!completed.ok) return errorResponse(request, "UNAUTHENTICATED", "handoff code is invalid or expired", context.requestId);
  try {
    const refresh = await createAccessRefreshCredential(context.accessRefreshCredentialStore, {
      userId: completed.value.userId,
      gatewaySessionDigest: completed.value.gatewaySessionDigest,
      repositoryId: completed.value.repositoryId,
      instanceId: completed.value.instanceId,
      runtimeEpoch: completed.value.runtimeEpoch,
      origin: completed.value.origin,
      permissions: completed.value.permissions,
      now,
      sessionExpiresAt: completed.value.sessionExpiresAt,
      pepper: context.config.credentialPepper,
    });
    return json({
      contractVersion: "instance-access/v1",
      token: completed.value.token,
      expiresAt: completed.value.expiresAt,
      refreshCredential: refresh.plaintext,
      refreshExpiresAt: refresh.record.expiresAt,
    });
  } catch {
    return unavailable(request, context);
  }
}

async function handleInstanceAccessRefresh(request: Request, context: GatewayContext, now: string): Promise<Response> {
  const bound = await instanceAccessBinding(request, context);
  if (bound instanceof Response) return bound;
  if (!("refreshCredential" in bound.input)) return errorResponse(request, "INVALID_REQUEST", "refresh request is invalid", context.requestId);
  const refreshed = await refreshAccessGrant({
    credentialStore: context.accessRefreshCredentialStore,
    credentialPepper: context.config.credentialPepper,
    sessionStore: context.sessionStore,
    repositoryAccessChecker: context.githubAccess,
    signingKey: context.signingKey,
    issuer: context.config.origin,
    tokenTtlSeconds: context.config.accessGrantTtlSeconds,
  }, {
    plaintext: bound.input.refreshCredential,
    repositoryId: bound.snapshot.binding.repositoryId,
    instanceId: bound.input.instanceId,
    runtimeEpoch: runtimeEpochForAccess(bound.snapshot.instance),
    origin: bound.origin,
    now,
  });
  if (!refreshed.ok) return errorResponse(request, "UNAUTHENTICATED", "refresh credential is invalid or access has changed", context.requestId);
  return json({ contractVersion: "instance-access/v1", ...refreshed.value });
}

async function handleInstanceAccessRevoke(request: Request, context: GatewayContext, now: string): Promise<Response> {
  const body = await readBoundedJson(request);
  const input = body ? RevokeAccessRequestSchema.safeParse(body) : null;
  if (!input?.success) return errorResponse(request, "INVALID_REQUEST", "revoke request is invalid", context.requestId);
  if (!serviceAuthenticated(request, context)) return errorResponse(request, "UNAUTHENTICATED", "instance access service authentication failed", context.requestId);
  let expectedHost: string;
  try {
    expectedHost = instanceHostname(input.data.instanceId, context.config.instanceHostnameSuffix);
  } catch {
    return errorResponse(request, "INVALID_REQUEST", "instance access binding is invalid", context.requestId);
  }
  const origin = `https://${expectedHost}`;
  if (input.data.hostname !== expectedHost || input.data.origin !== origin) return errorResponse(request, "INVALID_REQUEST", "instance access binding is invalid", context.requestId);
  let snapshot;
  try {
    snapshot = await context.controlPlane.getByInstanceId(input.data.instanceId);
  } catch {
    return unavailable(request, context);
  }
  if (!snapshot || snapshot.binding.instanceId !== input.data.instanceId || snapshot.instance.instanceId !== input.data.instanceId) {
    return errorResponse(request, "NOT_FOUND", "instance not found", context.requestId);
  }
  const revoked = await revokeAccessRefreshCredential(context.accessRefreshCredentialStore, context.config.credentialPepper, {
    plaintext: input.data.refreshCredential,
    repositoryId: snapshot.binding.repositoryId,
    instanceId: input.data.instanceId,
    runtimeEpoch: runtimeEpochForAccess(snapshot.instance),
    origin,
    now,
  });
  if (!revoked.ok) return unavailable(request, context);
  return json({ contractVersion: "instance-access/v1", revoked: true });
}

async function handleDirectEntry(request: Request, context: GatewayContext, rawInstanceId: string): Promise<Response> {
  if (
    request.method !== "GET" ||
    !request.headers.get("Accept")?.toLowerCase().includes("text/html") ||
    request.headers.get("Sec-Fetch-Mode") !== "navigate" ||
    request.headers.get("Sec-Fetch-Dest") !== "document"
  ) return errorResponse(request, "INVALID_REQUEST", "repository entry requires a top-level HTML navigation", context.requestId);
  const session = await requireSession(request, context);
  if (!session.ok) return loginRedirect(request, context);
  let snapshot;
  try {
    snapshot = await context.controlPlane.getByInstanceId(rawInstanceId);
  } catch {
    return unavailable(request, context);
  }
  if (!snapshot) return errorResponse(request, "NOT_FOUND", "instance not found", context.requestId);
  const repositoryId = snapshot.binding.repositoryId;
  const fresh = await context.githubAccess.checkBoundAccess(
    session.session.actor.userId,
    repositoryId,
    snapshot.instance.instanceId,
    runtimeEpochForAccess(snapshot.instance),
    context.requestNow,
  );
  if (fresh.status === "unavailable") return unavailable(request, context);
  if (!decisionMatches(fresh, snapshot, repositoryId, context.requestNow)) return accessDenied(request, context);
  if (!snapshot.instance.currentArtifactDigest && !snapshot.instance.desiredArtifactDigest) {
    const dashboard = new URL(`/repositories/${repositoryId}`, context.config.origin).toString();
    return new Response(
      `<!doctype html><html lang="en"><meta charset="utf-8"><title>Configuration required</title><body><main><h1>Configuration required</h1><p>This repository instance has no approved artifact configured yet. Review its available setup before starting it.</p><p><a href="${escapeHtml(dashboard)}">Open repository dashboard</a></p></main></body></html>`,
      { status: 409, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" } },
    );
  }
  const actor = Object.assign({}, session.session.actor, { gatewaySessionDigest: session.session.resolved.digest });
  const result = await createPortalService(context).execute(actor, String(repositoryId), { kind: "enter" });
  if (!result.ok) {
    const response = errorResponse(request, result.error.code, result.error.message, context.requestId);
    if (result.error.retryable) response.headers.set("Retry-After", String(INSTANCE_STARTING_RETRY_SECONDS));
    return response;
  }
  if (result.value.kind === "handoff") {
    const { renderHandoff } = await import("./ui/index.js");
    return renderHandoff(result.value.handoff, generateToken(128));
  }
  const operation = result.value.kind === "operation" ? result.value.operation : null;
  const url = new URL(request.url);
  const pollValue = url.searchParams.get("poll");
  const pollCount = pollValue && /^(?:0|[1-5])$/.test(pollValue) ? Number(pollValue) : 0;
  const continueUrl = new URL(url.pathname, context.config.origin);
  const automaticRefresh = pollCount < MAX_DIRECT_ENTRY_POLLS
    ? `<meta http-equiv="refresh" content="5; url=${escapeHtml(`${continueUrl.pathname}?poll=${pollCount + 1}`)}">`
    : "";
  const operationDetail = operation
    ? `<p>Operation <code>${escapeHtml(operation.operationId)}</code> (${escapeHtml(operation.state)}).</p>`
    : "";
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">${automaticRefresh}<title>Starting repository instance</title></head><body><main><h1>Repository instance is starting</h1><p>${operation ? escapeHtml(operation.message ?? operation.state) : "The runtime has no ready observation yet."}</p>${operationDetail}<p><a href="${escapeHtml(continueUrl.pathname)}">Check status</a></p></main></body></html>`,
    { status: 202, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Retry-After": String(INSTANCE_STARTING_RETRY_SECONDS), "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" } },
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

function publicJwks(context: GatewayContext): Response {
  const keys = context.keyRegistry
    .filter((record) => record.status !== "compromised")
    .map((record) => ({
      kty: "EC",
      crv: "P-256",
      x: record.publicKeyJwk.x,
      y: record.publicKeyJwk.y,
      kid: record.kid,
      alg: "ES256",
      use: "sig",
    }));
  return Response.json({ keys }, { headers: { "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff" } });
}

export function createGatewayRouter(context: GatewayContext): Hono {
  const app = new Hono();
  if (context.env.GATEWAY_GITHUB_WEBHOOK_SECRET) {
    app.route("/api/github/webhooks", createGitHubWebhookRoutes({
      webhookSecret: context.env.GATEWAY_GITHUB_WEBHOOK_SECRET,
      controlPlane: createGitHubWebhookControlPlaneClient(context.env.CONTROL_PLANE, context.config.controlPlaneSecret),
    }));
  } else {
    app.post("/api/github/webhooks", (c) => c.json({ error: { code: "WEBHOOK_AUTHORITY_UNAVAILABLE" } }, 503));
  }
  const portal = createPortalHandler({
    service: createPortalService(context),
    authenticate: async (request) => {
      const result = await requireSession(request, context);
      if (!result.ok) return { ok: false, response: loginRedirect(request, context) };
      const actor = Object.assign({}, result.session.actor, { gatewaySessionDigest: result.session.resolved.digest }) as PortalActor;
      const session: PortalSession = { actor, csrfToken: result.session.csrfToken };
      return { ok: true, session };
    },
    verifyCsrf: (request, session, form) => hasValidGatewayCsrf(request, context, session, form),
    createToken: () => generateToken(256),
  });

  app.get("/healthz", () => json({ status: "ok" }));
  app.get("/readyz", () => json({ status: "ready" }));
  app.get("/.well-known/jwks.json", () => publicJwks(context));
  app.get("/auth/github/start", (c) => handleGithubStart(c.req.raw, context, context.requestNow));
  app.get("/auth/github/callback", (c) => handleGithubCallback(c.req.raw, context, context.requestNow));
  app.get("/api/session", (c) => handleSession(c.req.raw, context, context.requestNow));
  app.post("/auth/logout", (c) => handleLogout(c.req.raw, context, context.requestNow));
  app.post("/auth/logout-all", (c) => handleLogout(c.req.raw, context, context.requestNow, true));

  app.post("/internal/instance-access/handoff", (c) => handleInstanceAccessHandoff(c.req.raw, context, context.requestNow));
  app.post("/internal/instance-access/refresh", (c) => handleInstanceAccessRefresh(c.req.raw, context, context.requestNow));
  app.post("/internal/instance-access/revoke", (c) => handleInstanceAccessRevoke(c.req.raw, context, context.requestNow));

  app.post("/api/credentials", (c) => handleCreateMcpCredential(c.req.raw, context, context.requestNow));
  app.get("/api/credentials", (c) => handleListMcpCredentials(c.req.raw, context, context.requestNow));
  app.post("/api/credentials/revoke-all", (c) => handleRevokeMcpCredential(c.req.raw, context, context.requestNow, null));
  app.post("/api/credentials/:id/revoke", (c) => handleRevokeMcpCredential(c.req.raw, context, context.requestNow, c.req.param("id")));
  app.post("/api/token", (c) => handleTokenExchange(c.req.raw, context, context.requestNow));
  app.post("/internal/github/credential", (c) => handleRuntimeGitCredential(c.req.raw, context));
  app.post("/api/repositories/:repositoryId/mutation-authorizations", (c) =>
    handleMutationAuthorization(c.req.raw, context, c.req.param("repositoryId"), context.requestNow));

  app.get("/entry/:instanceId", (c) => handleDirectEntry(c.req.raw, context, c.req.param("instanceId")));
  app.get("/", (c) => portal(c.req.raw));
  app.get("/repositories/:repositoryId", (c) => portal(c.req.raw));
  app.post("/repositories/:repositoryId/actions", (c) => portal(c.req.raw));
  app.notFound((c) => errorResponse(c.req.raw, "NOT_FOUND", "no route matches this request", context.requestId));
  app.onError(() => errorResponse(new Request(context.config.origin), "INTERNAL", "internal error", context.requestId));
  return app;
}
