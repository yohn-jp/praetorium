import { afterEach, describe, expect, it, vi } from "vitest";
import { createSession, deriveCodeChallengeS256, type UserId } from "@praetorium/auth";
import { createInMemorySessionStore } from "@praetorium/auth/testing";
import type { GatewayContext } from "../context.js";
import { sessionCsrfToken } from "../http/session.js";
import { authorizationServerMetadata, registerOAuthClient, authorizeOAuth, exchangeOAuthToken } from "./oauth-service.js";

const NOW = "2026-10-21T00:00:00.000Z";
const GATEWAY = "https://gateway.service.test";
const RESOURCE = "https://482901.scriptorium.yohn.jp";
const REDIRECT = "https://client.example.test/oauth/callback";
const VERIFIER = "v".repeat(48);
const INSTANCE = "ins_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CIMD = "https://chatgpt.com/oauth/client.json";

afterEach(() => vi.unstubAllGlobals());

type Entry = { digest: string; record: Record<string, unknown> };

function ephemeralStore() {
  const state = new Map<string, unknown>();
  const fetcher = vi.fn(async (request: Request) => {
    const { pathname } = new URL(request.url);
    const body = await request.json() as Record<string, unknown>;
    const key = body.key as string;
    if (pathname === "/save") {
      state.set(key, body.record);
      return new Response(null, { status: 204 });
    }
    if (pathname === "/get") return Response.json({ record: state.get(key) ?? null });
    if (pathname === "/consume") {
      const record = state.get(key) ?? null;
      state.delete(key);
      return Response.json({ record });
    }
    if (pathname === "/refresh/create") {
      const k = "refresh:" + String(body.credentialId);
      if (state.has(k)) return new Response(null, { status: 409 });
      state.set(k, { digest: body.digest, record: body.record });
      return new Response(null, { status: 204 });
    }
    if (pathname === "/refresh/get") {
      return Response.json({ entry: state.get("refresh:" + String(body.credentialId)) ?? null });
    }
    if (pathname === "/refresh/rotate") {
      const k = "refresh:" + String(body.credentialId);
      const entry = state.get(k) as Entry | undefined;
      const rotated = entry?.digest === body.currentDigest;
      if (rotated) state.set(k, { ...entry, digest: body.nextDigest });
      return Response.json({ rotated });
    }
    return new Response(null, { status: 404 });
  });
  return {
    namespace: { idFromName: (s: string) => s, get: () => ({
      fetch: (input: string | Request, init?: RequestInit) => fetcher(new Request(input, init)),
    }) },
    fetcher, state,
  };
}

async function fixture() {
  const sessionPepper = new TextEncoder().encode("session-test-pepper");
  const credentialPepper = new TextEncoder().encode("credential-test-pepper");
  const sessionStore = createInMemorySessionStore();
  const created = await createSession(sessionStore, {
    userId: "4242" as UserId, authenticationContext: "github-oauth",
    now: NOW, ttlSeconds: 3600, pepper: sessionPepper, concurrentSessionLimit: 3,
  });
  if (!created.ok) throw new Error("test session failed");
  const ephemeral = ephemeralStore();
  const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const checkBoundAccess = vi.fn(async () => ({
    status: "allowed", repositoryId: 482901, instanceId: INSTANCE, runtimeEpoch: 7,
    installationId: 31, authorizationRevision: 9, origin: RESOURCE,
    expiresAt: Date.parse(NOW) + 120_000, permissions: ["read", "write"],
  }));
  const context = {
    requestNow: NOW, requestId: "oauth-test",
    config: { origin: GATEWAY, sessionPepper, credentialPepper, accessGrantTtlSeconds: 120 },
    env: { EPHEMERAL_CODES: ephemeral.namespace },
    sessionStore,
    githubAccess: { checkBoundAccess },
    controlPlane: { getByRepositoryId: async () => ({
      binding: { appIdentity: "scriptorium", suspended: false, repositoryId: 482901,
        installationId: 31, authorizationRevision: 9 },
      instance: { repositoryId: 482901, instanceId: INSTANCE, runtimeEpoch: 7,
        legacyRuntimeEpoch: undefined, observedRuntimeEpoch: null, observedState: "stopped" },
    }) },
    tokenExchangeSourceRateLimiter: { consume: async () => true },
    getSigningKey: async () => ({ kid: "test-key", privateKey: key.privateKey }),
  } as unknown as GatewayContext;
  return { context, ephemeral, cookie: `__Host-praetorium_session=${created.value.rawSessionId}`,
    csrf: await sessionCsrfToken(context, created.value.rawSessionId), checkBoundAccess };
}

async function registered(f: Awaited<ReturnType<typeof fixture>>) {
  const result = await registerOAuthClient(new Request(GATEWAY + "/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.10" },
    body: JSON.stringify({ client_name: "Test MCP client", redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none" }),
  }), f.context);
  expect(result.status).toBe(201);
  return (await result.json() as { client_id: string }).client_id;
}

describe("generic service MCP OAuth", () => {
  it("advertises OAuth2 PKCE issuer metadata without revealing credentials", async () => {
    const f = await fixture();
    const response = authorizationServerMetadata(f.context);
    expect(response.status).toBe(200);
    const metadata = await response.json();
    expect(metadata).toMatchObject({
      issuer: GATEWAY, code_challenge_methods_supported: ["S256"],
      token_endpoint: GATEWAY + "/oauth/token",
      registration_endpoint: GATEWAY + "/oauth/register",
      client_id_metadata_document_supported: true,
      token_endpoint_auth_methods_supported: ["none"],
    });
    expect(metadata).toMatchObject({ registration_endpoint: GATEWAY + "/oauth/register" });
  });

  it.each(["legacy DCR", "CIMD"])("%s consents, exchanges one-use PKCE code and atomically rotates refresh", async (kind) => {
    const f = await fixture();
    const clientId = kind === "legacy DCR" ? await registered(f) : CIMD;
    if (kind === "CIMD") vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      client_id: CIMD, client_name: "Test MCP client", redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "private_key_jwt",
      token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
    })));
    const challenge = await deriveCodeChallengeS256(VERIFIER);
    const parameters = new URLSearchParams({
      client_id: clientId, redirect_uri: REDIRECT, resource: RESOURCE,
      response_type: "code", state: "testing-client-state-123", scope: "read",
      code_challenge: challenge, code_challenge_method: "S256",
    });
    const consent = await authorizeOAuth(new Request(GATEWAY + "/oauth/authorize?" + parameters, {
      headers: { Cookie: f.cookie },
    }), f.context);
    expect(consent.status).toBe(200);
    expect(consent.headers.get("Referrer-Policy")).toBe("same-origin");
    const consentHtml = await consent.text();
    expect(consentHtml).toContain("Test MCP client");
    expect(consentHtml).toContain('<meta name="referrer" content="same-origin">');
    const submitted = new URLSearchParams(parameters);
    submitted.set("csrfToken", f.csrf);
    submitted.set("decision", "approve");
    const approved = await authorizeOAuth(new Request(GATEWAY + "/oauth/authorize", {
      method: "POST",
      headers: { Cookie: `${f.cookie}; __Host-praetorium_csrf=${f.csrf}`, Origin: GATEWAY, "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/x-www-form-urlencoded",
        "X-OAuth-Test": "1" },
      body: submitted,
    }), f.context);
    expect(approved.status).toBe(302);
    const callback = new URL(approved.headers.get("Location")!);
    expect(callback.origin).toBe("https://client.example.test");
    const code = callback.searchParams.get("code")!;
    const tokenParameters = new URLSearchParams({
      grant_type: "authorization_code", client_id: clientId,
      code, code_verifier: VERIFIER, redirect_uri: REDIRECT, resource: RESOURCE,
    });
    const exchange = () => exchangeOAuthToken(new Request(GATEWAY + "/oauth/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenParameters,
    }), f.context);
    if (kind === "CIMD") {
      vi.mocked(fetch).mockRejectedValueOnce(new Error("metadata unavailable"));
      expect((await exchange()).status).toBe(503);
    }
    const granted = await exchange();
    expect(granted.status).toBe(200);
    const data = await granted.json() as { access_token: string; refresh_token: string };
    const claims = JSON.parse(atob(data.access_token.split(".")[1]!.replaceAll("-", "+").replaceAll("_", "/"))) as Record<string, unknown>;
    expect(claims.aud).toBe(RESOURCE);
    expect(claims.repositoryId).toBe(482901);
    expect(claims.permissions).toEqual(["read"]);
    const replay = await exchange();
    expect(replay.status).toBe(400);
    const refresh = (raw: string) => exchangeOAuthToken(new Request(GATEWAY + "/oauth/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, resource: RESOURCE, refresh_token: raw }),
    }), f.context);
    if (kind === "CIMD") {
      vi.mocked(fetch).mockRejectedValueOnce(new Error("metadata unavailable"));
      expect((await refresh(data.refresh_token)).status).toBe(503);
    }
    const rotated = await refresh(data.refresh_token);
    expect(rotated.status).toBe(200);
    expect((await rotated.json() as { refresh_token: string }).refresh_token).not.toBe(data.refresh_token);
    expect((await refresh(data.refresh_token)).status).toBe(400);
    expect(f.checkBoundAccess).toHaveBeenCalled();
    if (kind === "CIMD") expect(f.ephemeral.state.has("oauth-client:" + CIMD)).toBe(false);
  });

  it("does not consume an authorization code when a client supplies unsupported authentication", async () => {
    const f = await fixture();
    const clientId = await registered(f);
    for (const field of ["client_secret", "client_assertion", "client_assertion_type"]) {
      const response = await exchangeOAuthToken(new Request(GATEWAY + "/oauth/token", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId,
          resource: RESOURCE, [field]: "unsupported" }),
      }), f.context);
      expect(response.status).toBe(400);
    }
    expect(f.ephemeral.fetcher.mock.calls.some(([request]) => new URL(request.url).pathname === "/consume")).toBe(false);
  });

  it.each(["legacy DCR", "CIMD"])("%s rejects an unregistered redirect URI and requires GitHub-backed login", async (kind) => {
    const f = await fixture();
    const id = kind === "legacy DCR" ? await registered(f) : CIMD;
    if (kind === "CIMD") vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      client_id: CIMD, client_name: "ChatGPT", redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
    })));
    const params = new URLSearchParams({
      client_id: id, response_type: "code", redirect_uri: "https://attacker.test/callback",
      resource: RESOURCE, state: "oauth-request-state", scope: "read",
      code_challenge: "z".repeat(43), code_challenge_method: "S256",
    });
    const invalid = await authorizeOAuth(new Request(GATEWAY + "/oauth/authorize?" + params), f.context);
    expect(invalid.status).toBe(400);
    params.set("redirect_uri", REDIRECT);
    const unauth = await authorizeOAuth(new Request(GATEWAY + "/oauth/authorize?" + params), f.context);
    expect(unauth.status).toBe(302);
    expect(unauth.headers.get("Location")).toContain("/auth/login");
  });
});
