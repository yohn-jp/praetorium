import { afterEach, describe, expect, it, vi } from "vitest";
import { createSession, type UserId } from "@praetorium/auth";
import { createInMemorySessionStore } from "@praetorium/auth/testing";
import type { GatewayContext } from "../src/context.js";
import { enterAdminFromGateway, completeAdminHandoff, adminReturnPath } from "../src/admin/session.js";
import { handleAdminHost } from "../src/admin/console.js";

const NOW = "2026-10-21T10:00:00.000Z";
const GATEWAY = "https://praetorium.yohn.jp";
const ADMIN = "https://admin.praetorium.yohn.jp";
afterEach(() => vi.unstubAllGlobals());

async function fixture(userId = "213253858") {
  const sessionStore = createInMemorySessionStore();
  const pepper = new TextEncoder().encode("admin-test-pepper-secret");
  const session = await createSession(sessionStore, {
    userId: userId as UserId,
    authenticationContext: "github-oauth",
    now: NOW,
    ttlSeconds: 3600,
    pepper,
    concurrentSessionLimit: 3,
  });
  if (!session.ok) throw new Error("Could not create test Gateway session");
  const storage = new Map<string, unknown>();
  const gatewayCalls: { path: string; method: string; body: unknown; headers: Headers }[] = [];
  const internal = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname + new URL(request.url).search;
    gatewayCalls.push({
      path,
      method: request.method,
      body: request.method === "POST" ? await request.json() : null,
      headers: request.headers,
    });
    if (path === "/v1/operator/releases")
      return request.method === "GET"
        ? Response.json({ items: [], nextCursor: null })
        : Response.json({ release: { id: "rel_test", status: "candidate" } }, { status: 201 });
    if (new URL(request.url).pathname === "/v1/operator/source-builds") {
      if (request.method === "GET") return Response.json({ items: [] });
      const value = gatewayCalls[gatewayCalls.length - 1]?.body as {
        sourceId: string;
        githubReleaseId: number;
        sourceTag: string;
        sourceRevision: string;
        releaseVersion: string;
      };
      return Response.json(
        {
          job: {
            id: "sr_00000000-0000-4000-a000-000000000001",
            sourceId: value.sourceId,
            releaseId: value.githubReleaseId,
            tag: value.sourceTag,
            commit: value.sourceRevision,
            version: value.releaseVersion,
            state: "queued",
            attempt: 0,
            revision: 0,
            retryable: false,
            error: null,
            admittedReleaseId: null,
          },
          duplicate:
            gatewayCalls.filter(
              (x) => x.path === "/v1/operator/source-builds" && x.method === "POST",
            ).length > 1,
        },
        { status: 202 },
      );
    }
    if (path === "/v1/operator/releases/audit") return Response.json({ events: [] });
    if (path === "/v1/operator/releases/rel_test/retry")
      return Response.json({ status: "queued" }, { status: 202 });
    return Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
  });
  const ephemeral = {
    idFromName: (id: string) => id,
    get: () => ({
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const payload = (await request.json()) as { key: string; record?: unknown };
        const route = new URL(request.url).pathname;
        if (route === "/release-dispatch/claim") {
          const claim = storage.get(payload.key);
          if (claim) return Response.json({ claimed: false });
          storage.set(payload.key, payload);
          return Response.json({ claimed: true });
        }
        if (route === "/release-dispatch/release") {
          const claim = storage.get(payload.key) as { claimId?: string } | undefined;
          const released = claim?.claimId === (payload as { claimId?: string }).claimId;
          if (released) storage.delete(payload.key);
          return Response.json({ released });
        }
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
      origin: GATEWAY,
      adminOrigin: ADMIN,
      adminGithubUserIds: ["213253858"],
      sessionPepper: pepper,
      handoffPepper: pepper,
      sessionTtlSeconds: 3600,
      controlPlaneSecret: "operator-internal-service-token-not-a-browser-secret",
    },
    requestId: "admin-test",
    requestNow: NOW,
    sessionStore,
    env: { EPHEMERAL_CODES: ephemeral, CONTROL_PLANE: { fetch: internal } },
  } as unknown as GatewayContext;
  const gatewaySession = `__Host-praetorium_session=${session.value.rawSessionId}`;
  return { context, gatewaySession, gatewayCalls, internal };
}

async function login(f: Awaited<ReturnType<typeof fixture>>) {
  const entry = await enterAdminFromGateway(
    new Request(GATEWAY + "/_admin/entry", {
      headers: { Cookie: f.gatewaySession },
    }),
    f.context,
  );
  expect(entry.status).toBe(200);
  const html = await entry.text();
  const code = /name="code" value="([A-Za-z0-9_-]+)"/u.exec(html)?.[1];
  expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(entry.headers.get("Content-Security-Policy")).toContain("form-action " + ADMIN);
  const complete = () =>
    completeAdminHandoff(
      new Request(ADMIN + "/_admin/handoff", {
        method: "POST",
        headers: { Origin: GATEWAY, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code: code! }),
      }),
      f.context,
    );
  return { complete, code };
}
function cookiesFrom(response: Response) {
  const cookies = response.headers.getSetCookie();
  const session = /__Host-praetorium_session=([^;]+)/u.exec(cookies.join("; "))?.[1];
  const csrf = /__Host-praetorium_csrf=([^;]+)/u.exec(cookies.join("; "))?.[1];
  expect(session).toBeTruthy();
  expect(csrf).toBeTruthy();
  return {
    raw: `__Host-praetorium_session=${session}; __Host-praetorium_csrf=${csrf}`,
    csrf: decodeURIComponent(csrf!),
  };
}
function post(
  path: string,
  cookies: ReturnType<typeof cookiesFrom>,
  fields: Record<string, string>,
  origin = ADMIN,
) {
  return new Request(ADMIN + path, {
    method: "POST",
    headers: {
      Origin: origin,
      Cookie: cookies.raw,
      "Content-Type": "application/x-www-form-urlencoded",
    },
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
    const forbidden = await enterAdminFromGateway(
      new Request(GATEWAY + "/_admin/entry", {
        headers: { Cookie: nonadmin.gatewaySession },
      }),
      nonadmin.context,
    );
    expect(forbidden.status).toBe(403);
    expect(nonadmin.gatewayCalls).toHaveLength(0);
  });

  it("restores a validated read-only job after the one-use OAuth handoff", async () => {
    const f = await fixture();
    const job = "sr_730c616f-329c-4d2f-aabb-d143eaa2db01";
    const returnTo = `/builds/${job}?ui=mobile`;
    const entry = await enterAdminFromGateway(
      new Request(GATEWAY + "/_admin/entry?return_to=" + encodeURIComponent(returnTo),
        { headers: { Cookie: f.gatewaySession } }), f.context);
    expect(entry.status).toBe(200);
    const code = /name="code" value="([A-Za-z0-9_-]+)"/u.exec(await entry.text())?.[1];
    expect(code).toBeTruthy();
    const done = await completeAdminHandoff(new Request(ADMIN + "/_admin/handoff", {
      method: "POST", headers: { Origin: GATEWAY, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code: code! }),
    }), f.context);
    expect(done.status).toBe(303);
    expect(done.headers.get("Location")).toBe(returnTo);
    for (const input of ["//evil.example/", "https://evil.example/", "/source-builds/invalid/retry",
      "/builds/../../secrets", "/builds?ui=desktop&redirect=https://evil.example"])
      expect(adminReturnPath(input)).toBe("/");
  });
  it("requires the exact Gateway origin, consumes handoff once and isolates admin cookies", async () => {
    const f = await fixture();
    const { code, complete } = await login(f);
    const foreign = await completeAdminHandoff(
      new Request(ADMIN + "/_admin/handoff", {
        method: "POST",
        headers: {
          Origin: "https://attacker.test",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ code: code! }),
      }),
      f.context,
    );
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
    const page = await handleAdminHost(
      new Request(ADMIN, {
        headers: { Cookie: cookies.raw },
      }),
      f.context,
    );
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Overview");
    expect(html).toContain("Active incidents");
    expect(html).toContain('href="/builds?ui=desktop"');
    expect(html).not.toContain("Release manifest (JSON)");
    expect(html).not.toContain("operator-internal-service-token-not-a-browser-secret");
    expect(f.gatewayCalls.map((x) => x.path).sort()).toEqual([
      "/v1/operator/releases",
      "/v1/operator/source-builds?attention=1",
    ]);
    expect(f.gatewayCalls.some((x) => x.path === "/v1/operator/releases/audit")).toBe(false);
    expect(
      (
        await handleAdminHost(
          new Request(ADMIN + "/api/credentials", {
            headers: { Cookie: cookies.raw },
          }),
          f.context,
        )
      ).status,
    ).toBe(404);
  });

  it("keeps Admin sections independent and reports the failed endpoint, status, and code", async () => {
    const f = await fixture();
    const { complete } = await login(f);
    const cookies = cookiesFrom(await complete());
    const healthyCatalog = {
      items: [
        {
          release: {
            id: "rel_healthy",
            version: "2.3.4",
            imageDigest: "sha256:" + "b".repeat(64),
            status: "available",
            createdAt: NOW,
          },
          workflow: null,
        },
      ],
      nextCursor: null,
      stableChannel: { currentReleaseId: "rel_healthy", revision: 2 },
    };
    const healthyAudit = {
      events: [
        {
          actorId: "213253858",
          action: "healthy-audit-event",
          outcome: "accepted",
          occurredAt: Date.parse(NOW),
        },
      ],
    };
    const healthySources = {
      items: [
        {
          id: "sr_00000000-0000-4000-a000-000000000001",
          sourceId: "scriptorium",
          releaseId: 416422590,
          tag: "v0.2.1",
          commit: "c".repeat(40),
          version: "0.2.1",
          state: "queued",
          attempt: 1,
          revision: 0,
          retryable: false,
          error: null,
          admittedReleaseId: null,
        },
      ],
    };
    let failedPath = "";
    const sectionCalls: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      sectionCalls.push(path);
      if (path === failedPath)
        return Response.json(
          {
            error: {
              code: "SECTION_FAILED",
              reason:
                path === "/v1/operator/source-builds"
                  ? "schema_missing"
                  : "internal database secret",
            },
          },
          { status: 503 },
        );
      if (path === "/v1/operator/releases") return Response.json(healthyCatalog);
      if (path === "/v1/operator/releases/audit") return Response.json(healthyAudit);
      if (path === "/v1/operator/source-builds") return Response.json(healthySources);
      return Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
    });
    Object.assign(f.context.env, { CONTROL_PLANE: { fetch: fetcher } });

    const cases = [
      { route: "/?ui=desktop", endpoint: "/v1/operator/releases" },
      { route: "/builds?ui=desktop", endpoint: "/v1/operator/source-builds" },
      { route: "/audit?ui=desktop", endpoint: "/v1/operator/releases/audit" },
    ];
    for (const testCase of cases) {
      failedPath = testCase.endpoint;
      sectionCalls.length = 0;
      const page = await handleAdminHost(
        new Request(ADMIN + testCase.route, { headers: { Cookie: cookies.raw } }),
        f.context,
      );
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("HTTP <code>503</code>");
      expect(html).toContain("<code>SECTION_FAILED</code>");
      expect(html).not.toContain("internal database secret");
      expect(sectionCalls).toContain(testCase.endpoint);
      expect(
        sectionCalls.every(
          (path) =>
            path === testCase.endpoint ||
            (testCase.route === "/?ui=desktop" && path === "/v1/operator/source-builds"),
        ),
      ).toBe(true);
    }
  });

  it("lists published Releases and dispatches exact SHA from GitHub rather than trusting browser ref", async () => {
    const f = await fixture();
    const { complete } = await login(f);
    const cookies = cookiesFrom(await complete());
    Object.assign(f.context.env, {
      PRAETORIUM_RELEASE_SOURCES_JSON: JSON.stringify([
        {
          id: "scriptorium",
          label: "Scriptorium",
          githubRepository: "yohn-jp/scriptorium",
          adapter: "scriptorium-v1",
        },
      ]),
    });
    Object.assign(f.context, {
      githubUserTokens: { accessTokenFor: async () => "operator-oauth-token" },
    });
    const SHA = "a".repeat(40);
    const selected = {
      id: 416422590,
      tag_name: "v0.2.1",
      name: "Scriptorium v0.2.1",
      body: "Current release",
      draft: false,
      prerelease: false,
      published_at: NOW,
    };
    const githubRequests: Array<{ url: string; method: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        githubRequests.push({
          url: url.pathname + url.search,
          method: request.method,
          body: request.method === "POST" ? await request.json() : null,
        });
        if (url.pathname === "/repos/yohn-jp/scriptorium/releases")
          return Response.json([
            selected,
            { ...selected, id: 5, tag_name: "perf-wave1", prerelease: true },
          ]);
        if (url.pathname === "/repos/yohn-jp/scriptorium/releases/416422590")
          return Response.json(selected);
        if (url.pathname === "/repos/yohn-jp/scriptorium/git/ref/tags/v0.2.1")
          return Response.json({ object: { type: "commit", sha: SHA } });
        return Response.json({ message: "not found" }, { status: 404 });
      }),
    );
    const view = await handleAdminHost(
      new Request(ADMIN + "/releases?ui=desktop", { headers: { Cookie: cookies.raw } }),
      f.context,
    );
    expect(view.status).toBe(200);
    const html = await view.text();
    expect(html).toContain("Scriptorium v0.2.1");
    expect(html).toContain("Build &amp; deploy");
    expect(html).toContain("Not deployable");
    expect(html).not.toContain("Release manifest (JSON)");
    const invalid = await handleAdminHost(
      post("/source-releases/deploy", cookies, {
        sourceId: "scriptorium",
        releaseId: "416422590",
        source_revision: "b".repeat(40),
      }),
      f.context,
    );
    expect(invalid.status).toBe(400);
    const refused = await handleAdminHost(
      post(
        "/source-releases/deploy",
        cookies,
        {
          sourceId: "scriptorium",
          releaseId: "416422590",
        },
        "https://attacker.test",
      ),
      f.context,
    );
    expect(refused.status).toBe(403);
    const dispatched = await handleAdminHost(
      post("/source-releases/deploy", cookies, {
        sourceId: "scriptorium",
        releaseId: "416422590",
      }),
      f.context,
    );
    expect(dispatched.status).toBe(303);
    expect(dispatched.headers.get("Location")).toContain("Source%20build%20queued");
    expect(githubRequests.some((x) => x.url.includes("/actions/"))).toBe(false);
    const request = f.gatewayCalls.find(
      (x) => x.path === "/v1/operator/source-builds" && x.method === "POST",
    );
    expect(request?.body).toEqual({
      sourceId: "scriptorium",
      githubReleaseId: 416422590,
      sourceTag: "v0.2.1",
      sourceRevision: SHA,
      releaseVersion: "0.2.1",
    });
    const duplicate = await handleAdminHost(
      post("/source-releases/deploy", cookies, {
        sourceId: "scriptorium",
        releaseId: "416422590",
      }),
      f.context,
    );
    expect(duplicate.status).toBe(303);
    expect(duplicate.headers.get("Location")).toContain("already%20accepted");
    expect(githubRequests.some((x) => x.url.includes("/actions/"))).toBe(false);
    expect(
      f.gatewayCalls.filter((x) => x.path === "/v1/operator/source-builds" && x.method === "POST"),
    ).toHaveLength(2);
  });

  it("revalidates failed Source identity before sending the canonical retry command", async () => {
    const f = await fixture();
    const { complete } = await login(f);
    const cookies = cookiesFrom(await complete());
    const jobId = "sr_00000000-0000-4000-a000-000000000001";
    const job = {
      id: jobId,
      sourceId: "scriptorium",
      releaseId: 416422590,
      tag: "v0.2.1",
      commit: "a".repeat(40),
      version: "0.2.1",
      state: "failed",
      attempt: 3,
      revision: 4,
      retryable: true,
      error: "SOURCE_BUILD_FAILED",
      admittedReleaseId: null,
    };
    let resolvedCommit = job.commit;
    const calls: Array<{ path: string; method: string; body: unknown }> = [];
    const controlPlane = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      const body = request.method === "POST" ? await request.json() : null;
      calls.push({ path, method: request.method, body });
      if (path === "/v1/operator/releases") return Response.json({ items: [], nextCursor: null });
      if (path === "/v1/operator/releases/audit") return Response.json({ events: [] });
      if (path === "/v1/operator/source-builds") return Response.json({ items: [job] });
      if (path === "/v1/operator/source-builds/" + jobId && request.method === "GET")
        return new URL(request.url).searchParams.has("limit")
          ? Response.json({ job, attempts: [], nextCursor: null, evidence: "not_recorded" })
          : Response.json({ job });
      if (path === "/v1/operator/source-builds/" + jobId + "/retry")
        return Response.json(
          {
            job: { ...job, state: "queued", attempt: 0, revision: 5, retryable: false },
            duplicate: false,
          },
          { status: 202 },
        );
      return Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
    });
    Object.assign(f.context.env, {
      CONTROL_PLANE: { fetch: controlPlane },
      PRAETORIUM_RELEASE_SOURCES_JSON: JSON.stringify([
        {
          id: "scriptorium",
          label: "Scriptorium",
          githubRepository: "yohn-jp/scriptorium",
          adapter: "scriptorium-v1",
        },
      ]),
    });
    Object.assign(f.context, {
      githubUserTokens: { accessTokenFor: async () => "operator-oauth-token" },
    });
    const github = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (
        url.pathname === "/repos/yohn-jp/scriptorium/releases" ||
        url.pathname === "/repos/yohn-jp/scriptorium/releases/416422590"
      ) {
        const release = {
          id: 416422590,
          tag_name: "v0.2.1",
          name: "v0.2.1",
          body: "",
          draft: false,
          prerelease: false,
          published_at: NOW,
        };
        if (url.pathname.endsWith("/releases")) return Response.json([release]);
        return Response.json({
          id: 416422590,
          tag_name: "v0.2.1",
          name: "v0.2.1",
          body: "",
          draft: false,
          prerelease: false,
          published_at: NOW,
        });
      }
      if (url.pathname === "/repos/yohn-jp/scriptorium/git/ref/tags/v0.2.1") {
        return Response.json({ object: { type: "commit", sha: resolvedCommit } });
      }
      return Response.json({ message: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", github);

    const page = await handleAdminHost(
      new Request(ADMIN + "/builds/" + jobId + "?ui=desktop", { headers: { Cookie: cookies.raw } }),
      f.context,
    );
    const html = await page.text();
    const form =
      new RegExp(
        `<form method="post" action="/source-builds/${jobId}/retry\\?ui=desktop"[^>]*>([\\s\\S]*?)</form>`,
      ).exec(html)?.[1] ?? "";
    expect(form).toContain('name="expectedRevision" value="4"');
    expect(form).toContain('name="idempotencyKey"');
    expect(form).not.toContain('name="sourceTag"');
    expect(form).not.toContain('name="sourceRevision"');

    const injected = await handleAdminHost(
      post(`/source-builds/${jobId}/retry`, cookies, {
        expectedRevision: "4",
        idempotencyKey: "retry-operation-1",
        sourceTag: "v0.2.1",
      }),
      f.context,
    );
    expect(injected.status).toBe(400);
    expect(calls.filter((call) => call.path.endsWith("/retry"))).toHaveLength(0);

    const accepted = await handleAdminHost(
      post(`/source-builds/${jobId}/retry`, cookies, {
        expectedRevision: "4",
        idempotencyKey: "retry-operation-1",
      }),
      f.context,
    );
    expect(accepted.status).toBe(303);
    const retry = calls.find((call) => call.path.endsWith("/retry"));
    expect(retry?.body).toEqual({
      sourceId: "scriptorium",
      githubReleaseId: 416422590,
      sourceTag: "v0.2.1",
      sourceRevision: job.commit,
      releaseVersion: "0.2.1",
      expectedRevision: 4,
      idempotencyKey: "retry-operation-1",
    });
    expect(github).toHaveBeenCalledTimes(2);

    job.retryable = false;
    const exhaustedPage = await handleAdminHost(
      new Request(ADMIN + "/builds/" + jobId + "?ui=desktop", {
        headers: { Cookie: cookies.raw },
      }),
      f.context,
    );
    expect(await exhaustedPage.text()).not.toContain(`/source-builds/${jobId}/retry`);
    const githubCallsAfterExhaustedPage = github.mock.calls.length;
    const exhausted = await handleAdminHost(
      post(`/source-builds/${jobId}/retry`, cookies, {
        expectedRevision: "4",
        idempotencyKey: "retry-operation-exhausted",
      }),
      f.context,
    );
    expect(exhausted.status).toBe(409);
    expect(calls.filter((call) => call.path.endsWith("/retry"))).toHaveLength(1);
    expect(github).toHaveBeenCalledTimes(githubCallsAfterExhaustedPage);

    job.retryable = true;
    resolvedCommit = "b".repeat(40);
    const moved = await handleAdminHost(
      post(`/source-builds/${jobId}/retry`, cookies, {
        expectedRevision: "4",
        idempotencyKey: "retry-operation-2",
      }),
      f.context,
    );
    expect(moved.status).toBe(409);
    expect(calls.filter((call) => call.path.endsWith("/retry"))).toHaveLength(1);
    expect(github).toHaveBeenCalledTimes(githubCallsAfterExhaustedPage + 2);
  });

  it("offers retry only for the canonical failed pre-runtime Canary build", async () => {
    const f = await fixture();
    const { complete } = await login(f);
    const cookies = cookiesFrom(await complete());
    const candidate = (id: string, failureCode: string) => ({
      release: {
        id,
        version: "1.2.3",
        imageDigest: "sha256:" + "a".repeat(64),
        status: "candidate",
        createdAt: NOW,
      },
      workflow: {
        workflow: { state: "blocked", revision: 3, failureCode, attempts: 1, nextAttemptAt: null },
        build: { status: "failed", failure: { code: "BUILD_FAILED" } },
      },
    });
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/operator/source-builds") return Response.json({ items: [] });
      if (path === "/v1/operator/releases")
        return Response.json({
          items: [
            candidate("rel_ineligible", "canary_health_missing"),
            candidate("rel_eligible", "canary_build_failed"),
          ],
          nextCursor: null,
          stableChannel: { currentReleaseId: null, revision: 0 },
        });
      return Response.json({ events: [] });
    });
    Object.assign(f.context.env, { CONTROL_PLANE: { fetch: fetcher } });
    const result = await handleAdminHost(
      new Request(ADMIN + "/releases?ui=desktop", {
        headers: { Cookie: cookies.raw },
      }),
      f.context,
    );
    expect(result.status).toBe(200);
    const html = await result.text();
    expect(html.match(/Retry Canary build/g)).toHaveLength(1);
    expect(html).toContain("/releases/rel_eligible/retry?ui=desktop");
    expect(html).not.toContain("/releases/rel_ineligible/retry?ui=desktop");
  });

  it("removes browser raw-manifest authority while keeping canonical CSRF-gated Canary retry", async () => {
    const f = await fixture();
    const { complete } = await login(f);
    const cookies = cookiesFrom(await complete());
    const rawJson = await handleAdminHost(
      post("/releases", cookies, {
        manifest: JSON.stringify({ version: "1.2.3" }),
      }),
      f.context,
    );
    expect(rawJson.status).toBe(404);
    expect(f.gatewayCalls).toHaveLength(0);
    const malicious = await handleAdminHost(
      post(
        "/releases/rel_test/retry",
        cookies,
        {
          expectedRevision: "5",
          idempotencyKey: "retry-operation-1",
        },
        "https://attacker.test",
      ),
      f.context,
    );
    expect(malicious.status).toBe(403);
    expect(f.gatewayCalls).toHaveLength(0);
    const retry = await handleAdminHost(
      post("/releases/rel_test/retry", cookies, {
        expectedRevision: "5",
        idempotencyKey: "retry-operation-1",
      }),
      f.context,
    );
    expect(retry.status).toBe(303);
    expect(f.gatewayCalls[0]?.path).toBe("/v1/operator/releases/rel_test/retry");
    expect(f.gatewayCalls[0]?.body).toEqual({
      expectedRevision: 5,
      idempotencyKey: "retry-operation-1",
    });
    const logout = await handleAdminHost(post("/logout", cookies, {}), f.context);
    expect(logout.status).toBe(303);
    expect(logout.headers.get("Location")).toBe("/signed-out");
    const signedOut = await handleAdminHost(new Request(ADMIN + "/signed-out"), f.context);
    expect(signedOut.status).toBe(200);
    expect(await signedOut.text()).toContain("Signed out of Admin");
    expect(
      (
        await handleAdminHost(
          new Request(ADMIN, {
            headers: { Cookie: cookies.raw },
          }),
          f.context,
        )
      ).status,
    ).toBe(303);
  });
});
