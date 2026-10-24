import {
  base64UrlDecode, base64UrlEncode, createSession, exportPublicKeyJwk, generateSigningKeyPair,
  keyedDigest, ok, type KeyRecord, type SessionRecord, type UserId,
} from "@praetorium/auth";
import { createInMemorySessionStore } from "@praetorium/auth/testing";
import { describe, expect, it, vi } from "vitest";
import type { GatewayContext } from "../src/context.js";
import { createGatewayRouter } from "../src/router.js";
import { createDurableObjectSessionStore } from "../src/adapters/durable-objects/user-auth-state-client.js";
import { isSessionCacheRead, SESSION_CACHE_COOKIE_NAME } from "../src/http/session-cache.js";
import { requireSession } from "../src/http/session.js";

const NOW = "2026-10-24T12:00:00.000Z";
const ORIGIN = "https://gateway.service.test";
const COOKIE = "__Host-praetorium_session";
const CSRF = "__Host-praetorium_csrf";
const decode = (part: string) => JSON.parse(new TextDecoder().decode(base64UrlDecode(part))) as Record<string, unknown>;
const encode = (value: object) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));

async function setup(ttlSeconds = 3600) {
  const backing = createInMemorySessionStore();
  const index = new Map<string, UserId>();
  // Exercise the actual Gateway DO client and count the actual RPC path.
  const rpc = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as {
      digest: string; record: SessionRecord; concurrentSessionLimit: number; now: string;
      revokedAt: string; lastActivityBucket: string; expiresAt: string;
    };
    switch (new URL(url).pathname) {
      case "/sessions/create-within-limit": return Response.json({ created: await backing.createWithinLimit(body.digest, body.record, body.concurrentSessionLimit, body.now) });
      case "/sessions/get": return Response.json({ record: await backing.get(body.digest) });
      case "/sessions/revoke": await backing.revoke(body.digest, body.revokedAt); break;
      case "/sessions/revoke-all": await backing.revokeAllForUser("12345" as UserId, body.revokedAt); break;
      case "/sessions/touch": await backing.touch(body.digest, body.lastActivityBucket, body.expiresAt); break;
      default: throw new Error("unexpected session RPC");
    }
    return new Response(null, { status: 204 });
  });
  const sessionStore = createDurableObjectSessionStore({
    idFromName: (name: string) => name, get: () => ({ fetch: rpc }),
  } as unknown as DurableObjectNamespace, {
    get: async (digest) => index.get(digest) ?? null,
    set: async (digest, userId) => { index.set(digest, userId); },
    delete: async (digest) => { index.delete(digest); },
  });
  const sessionPepper = new TextEncoder().encode("session-cache-fixture-pepper");
  const create = async () => {
    const result = await createSession(sessionStore, { userId: "12345" as UserId, authenticationContext: "github-oauth",
      now: NOW, ttlSeconds, pepper: sessionPepper, concurrentSessionLimit: 3 });
    if (!result.ok) throw new Error("session fixture failed");
    return result.value;
  };
  const created = await create();
  const csrf = await keyedDigest(sessionPepper, `csrf:${created.rawSessionId}`);
  const cookie = `${COOKIE}=${created.rawSessionId}; ${CSRF}=${csrf}`;
  const pair = await generateSigningKeyPair();
  let keys: readonly KeyRecord[] = [{ kid: "cache-key-1", status: "active", publicKeyJwk: await exportPublicKeyJwk(pair.publicKey), createdAt: NOW, retiredAt: null }];
  const githubAccess = {
    listRepositories: vi.fn(async () => ok([{ repositoryId: 41, installationId: 52, owner: "owner", name: "repo", private: true, role: "maintain" }])),
    authorize: vi.fn(async () => ({ allowed: true, permissions: ["read", "maintain"], installationId: 52, repositoryId: 41 })),
  };
  const context = {
    config: { environment: "test", origin: ORIGIN, sessionPepper, sessionTtlSeconds: 3600, adminOrigin: null, adminGithubUserIds: [] },
    env: {}, requestId: "cache-test", requestNow: NOW, sessionStore, githubAccess,
    controlPlane: { getByRepositoryId: vi.fn(async () => null), listReleases: vi.fn(async () => []) },
    getSigningKey: vi.fn(async () => ({ kid: "cache-key-1", privateKey: pair.privateKey })),
    getKeyRegistry: vi.fn(async () => keys),
  } as unknown as GatewayContext;
  const request = (path = "/", cookies = cookie, init: RequestInit = {}) => new Request(`${ORIGIN}${path}`, {
    ...init, headers: { Cookie: cookies, ...init.headers },
  });
  const fetch = (path = "/", cookies = cookie, init: RequestInit = {}) => createGatewayRouter(context).fetch(request(path, cookies, init));
  const gets = () => rpc.mock.calls.filter(([url]) => new URL(url).pathname === "/sessions/get").length;
  const prime = async () => {
    const response = await fetch();
    expect(response.status).toBe(200);
    const setCookie = response.headers.getSetCookie().find((value) => value.startsWith(`${SESSION_CACHE_COOKIE_NAME}=`));
    expect(setCookie).toBeDefined();
    const cache = setCookie!.split(";", 1)[0]!;
    return { cache, cookies: `${cookie}; ${cache}`, setCookie: setCookie!, token: cache.slice(cache.indexOf("=") + 1) };
  };
  return { context, request, fetch, prime, gets, rpc, created, create, cookie, csrf, backing,
    setKeys: (value: readonly KeyRecord[]) => { keys = value; }, keys: () => keys, pair };
}

describe("signed browser session cache", () => {
  it("measures representative list/detail browsing through the DO client before and after caching", async () => {
    const f = await setup();
    const paths = ["/", "/repositories/41", "/repositories/41?poll=1", "/", "/repositories/41?view=mobile"];
    f.rpc.mockClear();
    for (const path of paths) expect((await requireSession(f.request(path), f.context)).ok).toBe(true);
    const before = f.gets();
    f.rpc.mockClear();
    const cached = await f.prime();
    for (const path of paths.slice(1)) expect((await f.fetch(path, cached.cookies)).status).toBe(200);
    const cold = f.gets();
    f.rpc.mockClear();
    for (const path of paths) expect((await f.fetch(path, cached.cookies)).status).toBe(200);
    expect([before, cold, f.gets()]).toEqual([5, 1, 0]);
    expect(f.context.githubAccess.listRepositories).toHaveBeenCalled();
    expect(f.context.githubAccess.authorize).toHaveBeenCalled();
  });

  it("sets host-only protected cookies with bounded, nonsecret and revision-bound claims", async () => {
    const f = await setup(120);
    const c = await f.prime();
    for (const flag of ["Secure", "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=120"]) expect(c.setCookie).toContain(flag);
    expect(c.setCookie).not.toContain("Domain=");
    expect(c.token).not.toContain(f.created.rawSessionId);
    const claims = decode(c.token.split(".")[1]!);
    expect(claims).toMatchObject({ userId: "12345", digest: f.created.digest, sessionRevision: 0, version: 1 });
    expect(Number(claims.exp) - Number(claims.iat)).toBe(120);
    expect(claims.exp).toBe(claims.sessionExp);
    expect(Object.keys(claims).sort()).toEqual(["version", "origin", "digest", "userId", "sessionRevision", "iat", "exp", "sessionExp"].sort());
  });

  it.each(["missing", "expired", "tampered", "malformed", "duplicate", "unknown-key", "retired-key", "compromised-key", "next-key", "wrong-origin", "future", "overlong", "wrong-revision-type", "wrong-type"])("falls back once for %s cache", async (kind) => {
    const f = await setup();
    const c = await f.prime();
    let cookies = c.cookies;
    const parts = c.token.split(".") as [string, string, string];
    if (kind === "missing") cookies = f.cookie;
    if (kind === "expired") Object.assign(f.context, { requestNow: "2026-10-24T12:05:00.000Z" });
    if (kind === "tampered") cookies = `${f.cookie}; ${SESSION_CACHE_COOKIE_NAME}=${parts[0]}.${encode({ ...decode(parts[1]), userId: "999" })}.${parts[2]}`;
    if (kind === "malformed") cookies = `${f.cookie}; ${SESSION_CACHE_COOKIE_NAME}=%FF`;
    if (kind === "duplicate") cookies += `; ${c.cache}`;
    if (kind === "unknown-key") f.setKeys([]);
    for (const status of ["retired", "compromised", "next"] as const) {
      if (kind === `${status}-key`) f.setKeys(f.keys().map((key) => ({ ...key, status })));
    }
    if (["wrong-origin", "future", "overlong", "wrong-revision-type", "wrong-type"].includes(kind)) {
      const claims = decode(parts[1]);
      const header = decode(parts[0]);
      if (kind === "wrong-origin") claims.origin = "https://other.test";
      if (kind === "future") claims.iat = Number(claims.iat) + 1;
      if (kind === "overlong") claims.exp = Number(claims.iat) + 301;
      if (kind === "wrong-revision-type") claims.sessionRevision = "0";
      if (kind === "wrong-type") header.typ = "JWT";
      const input = `${encode(header)}.${encode(claims)}`;
      const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, f.pair.privateKey, new TextEncoder().encode(input));
      cookies = `${f.cookie}; ${SESSION_CACHE_COOKIE_NAME}=${input}.${base64UrlEncode(new Uint8Array(signature))}`;
    }
    f.rpc.mockClear();
    expect((await f.fetch("/", cookies)).status).toBe(200);
    expect(f.gets()).toBe(1);
  });

  it("rejects cross-session substitution, cache-only theft, and session fixation", async () => {
    const f = await setup();
    const c = await f.prime();
    const second = await f.create();
    expect(second.rawSessionId).not.toBe(f.created.rawSessionId);
    f.rpc.mockClear();
    expect((await f.fetch("/", `${COOKIE}=${second.rawSessionId}; ${c.cache}`)).status).toBe(200);
    expect(f.gets()).toBe(1);
    for (const cookie of [c.cache, `${COOKIE}=attacker-fixed; ${c.cache}`, `${f.cookie}; ${COOKIE}=attacker-fixed; ${c.cache}`]) {
      expect((await f.fetch("/", cookie)).status).toBe(302);
    }
  });

  it("bounds stolen-pair replay after revocation and immediately denies sensitive operations", async () => {
    const f = await setup();
    const c = await f.prime();
    await f.backing.revoke(f.created.digest, NOW);
    f.rpc.mockClear();
    expect((await f.fetch("/", c.cookies)).status).toBe(200);
    expect(f.gets()).toBe(0);
    for (const [path, method] of [["/api/session", "GET"], ["/api/credentials", "GET"], ["/entry/scriptorium/41", "GET"],
      ["/api/credentials", "POST"], ["/api/repositories/41/mutation-authorizations", "POST"], ["/repositories/41/actions", "POST"]]) {
      const response = await f.fetch(path, c.cookies, { method, headers: { Origin: ORIGIN, "X-CSRF-Token": f.csrf,
        "Content-Type": path.endsWith("mutation-authorizations") ? "application/json" : "application/x-www-form-urlencoded",
        Accept: "text/html", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" },
        ...(method === "POST" ? { body: path.endsWith("mutation-authorizations")
          ? JSON.stringify({ operationId: "op-1", payloadDigest: `sha256:${"a".repeat(64)}` })
          : "csrfToken=x&action=enter" } : {}) });
      expect(response.status).not.toBe(200);
    }
    expect(f.gets()).toBe(6);
    Object.assign(f.context, { requestNow: "2026-10-24T12:05:00.000Z" });
    expect((await f.fetch("/", c.cookies)).status).toBe(302);
  });

  it.each(["/auth/logout", "/auth/logout-all"])("%s clears cookies and revokes the correct sessions", async (path) => {
    const f = await setup();
    const second = await f.create();
    const c = await f.prime();
    f.rpc.mockClear();
    const response = await f.fetch(path, c.cookies, { method: "POST", headers: { Origin: ORIGIN, "X-CSRF-Token": f.csrf } });
    expect(response.status).toBe(204);
    expect(f.gets()).toBe(1);
    for (const name of [COOKIE, CSRF, SESSION_CACHE_COOKIE_NAME]) expect(response.headers.getSetCookie().some((value) => value.startsWith(`${name}=`) && value.includes("Max-Age=0"))).toBe(true);
    expect((await f.backing.get(f.created.digest))?.revokedAt).toBe(NOW);
    expect((await f.backing.get(second.digest))?.revokedAt).toBe(path.endsWith("-all") ? NOW : null);
  });

  it("retains CSRF/Origin checks even with a valid cache", async () => {
    const f = await setup();
    const c = await f.prime();
    for (const headers of [{ Origin: ORIGIN }, { Origin: "https://attacker.test", "X-CSRF-Token": f.csrf },
      { Origin: ORIGIN, "X-CSRF-Token": "wrong" }]) {
      expect((await f.fetch("/auth/logout", c.cookies, { method: "POST", headers })).status).toBe(403);
    }
    expect((await f.backing.get(f.created.digest))?.revokedAt).toBeNull();
  });

  it("does not use cache on mixed Bearer/Cookie input and preserves authoritative failures", async () => {
    const f = await setup();
    const c = await f.prime();
    f.rpc.mockClear();
    expect((await f.fetch("/", c.cookies, { headers: { Authorization: "Bearer invalid" } })).status).toBe(200);
    expect(f.gets()).toBe(1);
    f.rpc.mockRejectedValue(new Error("DO unavailable"));
    expect((await f.fetch("/", f.cookie)).status).toBe(302);
    expect((await f.fetch("/", c.cookies)).status).toBe(200);
    expect((await f.fetch("/api/session", c.cookies)).status).toBe(401);
  });

  it("does not renew cache on concurrent hits and retains authoritative touch/sliding expiry", async () => {
    const f = await setup();
    const c = await f.prime();
    f.rpc.mockClear();
    const responses = await Promise.all(Array.from({ length: 10 }, () => f.fetch("/", c.cookies)));
    expect(responses.every((response) => response.status === 200 && !response.headers.getSetCookie().some((value) => value.startsWith(`${SESSION_CACHE_COOKIE_NAME}=`)))).toBe(true);
    expect(f.gets()).toBe(0);
    Object.assign(f.context, { requestNow: "2026-10-24T12:06:00.000Z" });
    expect((await f.fetch("/api/session", c.cookies)).status).toBe(200);
    expect(f.gets()).toBe(1);
    expect((await f.backing.get(f.created.digest))?.expiresAt).toBe("2026-10-24T13:06:00.000Z");
    const replaced = await f.fetch("/", c.cookies);
    expect(replaced.headers.getSetCookie().some((value) => value.startsWith(`${SESSION_CACHE_COOKIE_NAME}=`))).toBe(true);
  });

  it("rotates to the new active signing key through one authoritative resolution", async () => {
    const f = await setup();
    const old = await f.prime();
    const next = await generateSigningKeyPair();
    f.setKeys([
      ...f.keys().map((key) => ({ ...key, status: "retired" as const, retiredAt: NOW })),
      { kid: "cache-key-2", status: "active", publicKeyJwk: await exportPublicKeyJwk(next.publicKey), createdAt: NOW, retiredAt: null },
    ]);
    vi.mocked(f.context.getSigningKey).mockResolvedValue({ kid: "cache-key-2", privateKey: next.privateKey });
    f.rpc.mockClear();
    const response = await f.fetch("/", old.cookies);
    const cache = response.headers.getSetCookie().find((value) => value.startsWith(`${SESSION_CACHE_COOKIE_NAME}=`))!.split(";", 1)[0]!;
    expect(f.gets()).toBe(1);
    expect(decode(cache.split("=")[1]!.split(".")[0]!).kid).toBe("cache-key-2");
    f.rpc.mockClear();
    expect((await f.fetch("/", `${f.cookie}; ${cache}`)).status).toBe(200);
    expect(f.gets()).toBe(0);
  });

  it("resolves concurrent misses once per request and never shares identity between requests", async () => {
    const f = await setup();
    const second = await f.create();
    f.rpc.mockClear();
    const cookies = [f.cookie, `${COOKIE}=${second.rawSessionId}`];
    const responses = await Promise.all(cookies.map((cookie) => f.fetch("/", cookie)));
    expect(f.gets()).toBe(2);
    const digests = responses.map((response) => {
      const cache = response.headers.getSetCookie().find((value) => value.startsWith(`${SESSION_CACHE_COOKIE_NAME}=`))!;
      return decode(cache.split(";")[0]!.split("=")[1]!.split(".")[1]!).digest;
    });
    expect(digests).toEqual([f.created.digest, second.digest]);
  });

  it("never extends the original session expiry or replaces failed authority with a cache", async () => {
    const f = await setup(120);
    const c = await f.prime();
    Object.assign(f.context, { requestNow: "2026-10-24T12:02:00.000Z" });
    f.rpc.mockClear();
    const response = await f.fetch("/", c.cookies);
    expect(response.status).toBe(302);
    expect(f.gets()).toBe(1);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("keeps GitHub permission decisions on cached repository reads", async () => {
    const f = await setup();
    const c = await f.prime();
    vi.mocked(f.context.githubAccess.authorize).mockResolvedValue({ allowed: false, permissions: [], checkedAt: Date.parse(NOW), expiresAt: Date.parse(NOW) + 60_000, installationId: 52, repositoryId: 41 });
    f.rpc.mockClear();
    expect((await f.fetch("/repositories/41", c.cookies)).status).toBe(403);
    expect(f.gets()).toBe(0);
    expect(f.context.githubAccess.authorize).toHaveBeenCalledWith("12345", 41, "read");
  });

  it("falls back when key metadata is unavailable and tolerates cache signing failure", async () => {
    const f = await setup();
    const c = await f.prime();
    vi.mocked(f.context.getKeyRegistry).mockRejectedValue(new Error("KV unavailable"));
    vi.mocked(f.context.getSigningKey).mockRejectedValue(new Error("signer unavailable"));
    f.rpc.mockClear();
    const response = await f.fetch("/", c.cookies);
    expect(response.status).toBe(200);
    expect(f.gets()).toBe(1);
    expect(response.headers.getSetCookie().some((value) => value.startsWith(`${SESSION_CACHE_COOKIE_NAME}=`))).toBe(false);
  });

  it("allows only the classified portal reads", async () => {
    const f = await setup();
    for (const path of ["/api/session", "/api/credentials", "/_admin/entry", "/oauth/authorize", "/auth/github/callback", "/entry/scriptorium/41", "/repositories/41/actions", "/unknown"]) {
      expect(isSessionCacheRead(f.request(path), f.context)).toBe(false);
    }
    expect(isSessionCacheRead(f.request("/", f.cookie, { method: "POST" }), f.context)).toBe(false);
    expect(isSessionCacheRead(new Request("https://other.test/"), f.context)).toBe(false);
  });
});
