import { createSession, keyedDigest, ok, type UserId } from "@praetorium/auth";
import { createInMemorySessionStore } from "@praetorium/auth/testing";
import { describe, expect, it, vi } from "vitest";
import type { GatewayContext } from "../src/context.js";
import { createGatewayRouter } from "../src/router.js";

const NOW = "2026-10-19T04:00:00.000Z";
const ORIGIN = "https://gateway.service.test";

async function setup() {
  const sessionStore = createInMemorySessionStore();
  const sessionPepper = new TextEncoder().encode("browser-session-test-pepper");
  const created = await createSession(sessionStore, {
    userId: "1234567" as UserId,
    authenticationContext: "github-oauth",
    now: NOW,
    ttlSeconds: 3600,
    pepper: sessionPepper,
    concurrentSessionLimit: 3,
  });
  if (!created.ok) throw new Error("session fixture failed");
  const csrf = await keyedDigest(sessionPepper, `csrf:${created.value.rawSessionId}`);
  const cookie = `__Host-praetorium_session=${created.value.rawSessionId}; __Host-praetorium_csrf=${csrf}`;
  const listRepositories = vi.fn(async () => ok([]));
  const context = {
    config: { environment: "test", origin: ORIGIN, sessionPepper, sessionTtlSeconds: 3600 },
    env: {},
    requestId: "browser-session-test",
    requestNow: NOW,
    sessionStore,
    githubAccess: { listRepositories },
  } as unknown as GatewayContext;
  const app = createGatewayRouter(context);
  const session = () => app.fetch(new Request(`${ORIGIN}/auth/session`, { headers: { Cookie: cookie } }));
  const logout = (body: URLSearchParams | string, headers: Record<string, string> = {}) => app.fetch(new Request(`${ORIGIN}/auth/logout`, {
    method: "POST",
    headers: { Cookie: cookie, Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body,
  }));
  return { app, cookie, csrf, logout, session, listRepositories };
}

describe("browser session boundary", () => {
  it("accepts the rendered native logout form and rejects replay of its revoked session", async () => {
    const fixture = await setup();
    const page = await fixture.app.fetch(new Request(`${ORIGIN}/`, { headers: { Cookie: fixture.cookie } }));
    expect(page.status).toBe(200);
    const html = await page.text();
    const form = html.match(/<form\b[^>]*action="\/auth\/logout"[^>]*>([\s\S]*?)<\/form>/)?.[1];
    expect(form).toBeDefined();
    const token = form!.match(/name="csrfToken" value="([^"]+)"/)?.[1];
    expect(token).toBe(fixture.csrf);
    const response = await fixture.logout(new URLSearchParams({ csrfToken: token! }));
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/auth/login");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    for (const name of ["__Host-praetorium_session", "__Host-praetorium_csrf"]) {
      expect(response.headers.getSetCookie().some((value) => value.startsWith(`${name}=`) && value.includes("Max-Age=0"))).toBe(true);
    }
    expect((await fixture.session()).status).toBe(401);
    fixture.listRepositories.mockClear();
    const replay = await fixture.app.fetch(new Request(`${ORIGIN}/`, { headers: { Cookie: fixture.cookie } }));
    expect(replay.status).toBe(302);
    expect(new URL(replay.headers.get("Location")!, ORIGIN).pathname).toBe("/auth/login");
    expect(fixture.listRepositories).not.toHaveBeenCalled();
  });

  it("stops cookie-free navigation at an explicit login page instead of starting OAuth", async () => {
    const { app, listRepositories } = await setup();
    const response = await app.fetch(new Request(`${ORIGIN}/repositories/482901`));
    expect(response.status).toBe(302);
    const target = new URL(response.headers.get("Location")!, ORIGIN);
    expect(target.origin).toBe(ORIGIN);
    expect(target.pathname).toBe("/auth/login");
    expect(target.searchParams.get("redirect_to")).toBe("/repositories/482901");
    const page = await app.fetch(new Request(target));
    expect(page.status).toBe(200);
    expect(page.headers.get("Location")).toBeNull();
    expect(page.headers.get("Cache-Control")).toBe("no-store");
    const html = await page.text();
    expect(html).toContain("Sign in with GitHub");
    expect(html).toContain("/auth/github/start");
    expect(html).not.toMatch(/http-equiv=["']refresh|location\.(?:replace|assign)|\.submit\(/i);
    expect(listRepositories).not.toHaveBeenCalled();
  });

  it("retains header-based API logout", async () => {
    const { app, cookie, csrf, session } = await setup();
    const response = await app.fetch(new Request(`${ORIGIN}/auth/logout`, {
      method: "POST", headers: { Cookie: cookie, Origin: ORIGIN, "X-CSRF-Token": csrf },
    }));
    expect(response.status).toBe(204);
    expect((await session()).status).toBe(401);
  });

  it.each(["missing", "incorrect", "duplicate", "cross-origin"])("rejects %s form authorization without revoking the session", async (kind) => {
    const { csrf, logout, session } = await setup();
    const body = new URLSearchParams();
    if (kind !== "missing") body.append("csrfToken", kind === "incorrect" ? "wrong" : csrf);
    if (kind === "duplicate") body.append("csrfToken", csrf);
    const response = await logout(body, kind === "cross-origin" ? { Origin: "https://attacker.test", "Sec-Fetch-Site": "cross-site" } : {});
    expect(response.status).toBe(403);
    expect((await session()).status).toBe(200);
  });

  it("bounds form decoding and retains the session on oversized input", async () => {
    const { csrf, logout, session } = await setup();
    const response = await logout(new URLSearchParams({ csrfToken: csrf, padding: "x".repeat(8192) }));
    expect(response.status).toBe(400);
    expect((await session()).status).toBe(200);
  });
});
