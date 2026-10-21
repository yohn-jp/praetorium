import { describe, expect, it, vi } from "vitest";
import { createSession, type UserId } from "@praetorium/auth";
import { createInMemorySessionStore } from "@praetorium/auth/testing";
import type { GatewayContext } from "../src/context.js";
import { enterAdminFromGateway, completeAdminHandoff } from "../src/admin/session.js";
import { handleAdminHost } from "../src/admin/console.js";

const NOW = "2026-10-21T10:00:00.000Z";
const GATEWAY = "https://praetorium.yohn.jp";
const ADMIN = "https://admin.praetorium.yohn.jp";

async function fixture(userId = "213253858") {
  const sessionStore = createInMemorySessionStore();
  const pepper = new TextEncoder().encode("admin-test-pepper-secret");
  const session = await createSession(sessionStore, {
    userId: userId as UserId, authenticationContext: "github-oauth",
    now: NOW, ttlSeconds: 3600, pepper, concurrentSessionLimit: 3,
  });
  if (!session.ok) throw new Error("Could not create test Gateway session");
  const storage = new Map<string, unknown>();
  const gatewayCalls: { path: string; method: string; body: unknown; headers: Headers }[] = [];
  const internal = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname + new URL(request.url).search;
    gatewayCalls.push({ path, method: request.method,
      body: request.method === "POST" ? await request.json() : null,
      headers: request.headers });
    if (path === "/v1/operator/releases")
      return request.method === "GET"
        ? Response.json({ items: [], nextCursor: null })
        : Response.json({ release: { id: "rel_test", status: "candidate" } }, { status: 201 });
    if (path === "/v1/operator/releases/audit")
      return Response.json({ events: [] });
    if (path === "/v1/operator/releases/rel_test/retry")
      return Response.json({ status: "queued" }, { status: 202 });
    return Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
  });
  const ephemeral = {
    idFromName: (id: string) => id,
    get: () => ({
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const payload = await request.json() as { key: string; record?: unknown };
        const route = new URL(request.url).pathname;
        if (route === "/save") {
          storage.set(payload.key, payload.record);
          return new Response(null, { status: 204 });
        }
        if (route === "/consume") {
          const record = storage.get(payload.key) ?? null;
          storage.delete(payload.key);
          return Response.json({ record });
        }
        return new Response(null, { status: 404 });
      },
    }),
  };
  const context = {
    config: {
      origin: GATEWAY, adminOrigin: ADMIN, adminGithubUserIds: ["213253858"],
      sessionPepper: pepper, handoffPepper: pepper, sessionTtlSeconds: 3600,
      controlPlaneSecret: "operator-internal-service-token-not-a-browser-secret",
    },
    requestId: "admin-test", requestNow: NOW, sessionStore,
    env: { EPHEMERAL_CODES: ephemeral, CONTROL_PLANE: { fetch: internal } },
  } as unknown as GatewayContext;
  const gatewaySession = `__Host-praetorium_session=${session.value.rawSessionId}`;
  return { context, gatewaySession, gatewayCalls, internal };
}

async function login(f: Awaited<ReturnType<typeof fixture>>) {
  const entry = await enterAdminFromGateway(new Request(GATEWAY + "/_admin/entry", {
    headers: { Cookie: f.gatewaySession },
  }), f.context);
  expect(entry.status).toBe(200);
  const html = await entry.text();
  const code = /name="code" value="([A-Za-z0-9_-]+)"/u.exec(html)?.[1];
  expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(entry.headers.get("Content-Security-Policy")).toContain("form-action " + ADMIN);
  const complete = () => completeAdminHandoff(new Request(ADMIN + "/_admin/handoff", {
    method: "POST", headers: { Origin: GATEWAY, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code: code! }),
  }), f.context);
  return { complete, code };
}
function cookiesFrom(response: Response) {
  const cookies = response.headers.getSetCookie();
  const session = /__Host-praetorium_session=([^;]+)/u.exec(cookies.join("; "))?.[1];
  const csrf = /__Host-praetorium_csrf=([^;]+)/u.exec(cookies.join("; "))?.[1];
  expect(session).toBeTruthy();
  expect(csrf).toBeTruthy();
  return { raw: `__Host-praetorium_session=${session}; __Host-praetorium_csrf=${csrf}`,
    csrf: decodeURIComponent(csrf!) };
}
function post(path: string, cookies: ReturnType<typeof cookiesFrom>, fields: Record<string, string>, origin = ADMIN) {
  return new Request(ADMIN + path, {
    method: "POST", headers: { Origin: origin, Cookie: cookies.raw,
      "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrfToken: cookies.csrf, ...fields }),
  });
}

describe("operator-only admin origin", () => {
  it("requires login and rejects non-admin GitHub identities before creating a handoff", async () => {
    const guest = await fixture();
    const noSession = await handleAdminHost(new Request(ADMIN), guest.context);
    expect(noSession.status).toBe(303);
    expect(noSession.headers.get("Location")).toBe(GATEWAY + "/_admin/entry");
    expect(guest.gatewayCalls).toHaveLength(0);

    const nonadmin = await fixture("9876543");
    const forbidden = await enterAdminFromGateway(new Request(GATEWAY + "/_admin/entry", {
      headers: { Cookie: nonadmin.gatewaySession },
    }), nonadmin.context);
    expect(forbidden.status).toBe(403);
    expect(nonadmin.gatewayCalls).toHaveLength(0);
  });

  it("requires the exact Gateway origin, consumes handoff once and isolates admin cookies", async () => {
    const f = await fixture();
    const { code, complete } = await login(f);
    const foreign = await completeAdminHandoff(new Request(ADMIN + "/_admin/handoff", {
      method: "POST",
      headers: { Origin: "https://attacker.test", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code: code! }),
    }), f.context);
    expect(foreign.status).toBe(403);
    const received = await complete();
    expect(received.status).toBe(303);
    expect(received.headers.get("Location")).toBe("/");
    const rawCookies = received.headers.getSetCookie().join("\n");
    expect(rawCookies).toContain("HttpOnly");
    expect(rawCookies).toContain("Secure");
    expect(rawCookies).not.toContain("Domain=");
    const cookies = cookiesFrom(received);
    expect((await complete()).status).toBe(401);
    const page = await handleAdminHost(new Request(ADMIN, {
      headers: { Cookie: cookies.raw },
    }), f.context);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Release administration");
    expect(html).toContain("Register producer release");
    expect(html).not.toContain("operator-internal-service-token-not-a-browser-secret");
    expect(f.gatewayCalls.map(x => x.path)).toEqual([
      "/v1/operator/releases", "/v1/operator/releases/audit",
    ]);
    expect((await handleAdminHost(new Request(ADMIN + "/api/credentials", {
      headers: { Cookie: cookies.raw },
    }), f.context)).status).toBe(404);
  });

  it("uses the real authenticated Control Plane service binding for CSRF-gated admission and retry", async () => {
    const f = await fixture();
    const { complete } = await login(f);
    const cookies = cookiesFrom(await complete());
    const manifest = { schemaVersion: 1, version: "1.2.3", imageRepository: "ghcr.io/example/release" };
    const malicious = await handleAdminHost(post("/releases", cookies,
      { manifest: JSON.stringify(manifest) }, "https://attacker.test"), f.context);
    expect(malicious.status).toBe(403);
    expect(f.gatewayCalls).toHaveLength(0);
    const registered = await handleAdminHost(post("/releases", cookies,
      { manifest: JSON.stringify(manifest) }), f.context);
    expect(registered.status).toBe(303);
    expect(registered.headers.get("Location")).toContain("Release%20admitted");
    expect(f.gatewayCalls).toHaveLength(1);
    expect(f.gatewayCalls[0]?.body).toEqual(manifest);
    expect(f.gatewayCalls[0]?.headers.get("X-Praetorium-Admin-Actor")).toBe("213253858");
    expect(f.gatewayCalls[0]?.headers.get("X-Control-Plane-Gateway-Auth"))
      .toBe("operator-internal-service-token-not-a-browser-secret");
    expect(f.gatewayCalls[0]?.headers.has("Authorization")).toBe(false);
    const retry = await handleAdminHost(post("/releases/rel_test/retry", cookies, {
      expectedRevision: "5", idempotencyKey: "retry-operation-1",
    }), f.context);
    expect(retry.status).toBe(303);
    expect(f.gatewayCalls[1]?.path).toBe("/v1/operator/releases/rel_test/retry");
    expect(f.gatewayCalls[1]?.body).toEqual({
      expectedRevision: 5, idempotencyKey: "retry-operation-1",
    });
    const logout = await handleAdminHost(post("/logout", cookies, {}), f.context);
    expect(logout.status).toBe(303);
    expect((await handleAdminHost(new Request(ADMIN, {
      headers: { Cookie: cookies.raw },
    }), f.context)).status).toBe(303);
  });
});
