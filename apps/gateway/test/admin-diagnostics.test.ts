import { afterEach, describe, expect, it, vi } from "vitest";
import { createSession, type UserId } from "@praetorium/auth";
import type {
  SourceBuildAttempt,
  SourceBuildDetail,
  SourceBuildSummary,
} from "@praetorium/contracts";
import { createInMemorySessionStore } from "@praetorium/auth/testing";
import type { GatewayContext } from "../src/context.js";
import { sessionCsrfToken } from "../src/http/session.js";
import { handleAdminHost } from "../src/admin/console.js";

const NOW = "2026-10-23T10:00:00.000Z";
const GATEWAY = "https://praetorium.test";
const ADMIN = "https://admin.praetorium.test";
const ADMIN_ID = "213253858";
const JOB_ID = "sr_00000000-0000-4000-a000-000000000001";
const GITHUB_RELEASE_ID = 416_422_590;
const SOURCE_COMMIT = "a".repeat(40);
const CONTROL_PLANE_SECRET = "test-only-control-plane-service-key";
const SESSION_COOKIE = "__Host-praetorium_session";
const CSRF_COOKIE = "__Host-praetorium_csrf";

const sourceRegistry = JSON.stringify([
  {
    id: "scriptorium",
    label: "Scriptorium",
    githubRepository: "yohn-jp/scriptorium",
    adapter: "scriptorium-v1",
  },
]);

function job(
  state: SourceBuildSummary["state"],
  attempt: number,
  revision: number,
  retryable = false,
): SourceBuildSummary {
  return {
    id: JOB_ID,
    sourceId: "scriptorium",
    releaseId: GITHUB_RELEASE_ID,
    tag: "v0.3.3",
    commit: SOURCE_COMMIT,
    version: "0.3.3",
    state,
    attempt,
    revision,
    retryable,
    error: state === "failed" ? "SOURCE_BUILD_FAILED" : null,
    admittedReleaseId: state === "admitted" ? "rel_v033" : null,
  };
}

function buildAttempt(
  input: Partial<SourceBuildAttempt> &
    Pick<SourceBuildAttempt, "id" | "attempt" | "revision" | "leaseEpoch" | "state" | "stage">,
): SourceBuildAttempt {
  const finishedAt = input.state === "building" ? null : 1_792_744_800_000;
  return {
    id: input.id,
    attempt: input.attempt,
    revision: input.revision,
    leaseEpoch: input.leaseEpoch,
    state: input.state,
    stage: input.stage,
    startedAt: 1_792_744_700_000,
    finishedAt,
    failureCode: input.state === "failed" ? "SOURCE_BUILD_FAILED" : null,
    evidence: "not_recorded",
    expiresAt: null,
    diagnostic: null,
    ...input,
  };
}

function detail(
  current: SourceBuildSummary,
  attempts: readonly SourceBuildAttempt[] = [],
  evidence: SourceBuildDetail["evidence"] = "not_recorded",
): SourceBuildDetail {
  return { job: current, attempts: [...attempts], nextCursor: null, evidence };
}

interface ControlPlaneCall {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly headers: Headers;
}

interface FixtureOptions {
  readonly userId?: string;
  readonly initialDetail?: SourceBuildDetail;
  readonly listItems?: readonly SourceBuildSummary[];
  readonly handleControlPlane?: (request: Request) => Promise<Response>;
}

async function fixture(options: FixtureOptions = {}) {
  const sessionStore = createInMemorySessionStore();
  const pepper = new TextEncoder().encode("admin-diagnostics-test-pepper");
  const actorId = options.userId ?? ADMIN_ID;
  const session = await createSession(sessionStore, {
    userId: actorId as UserId,
    authenticationContext: "github-oauth",
    now: NOW,
    ttlSeconds: 3600,
    pepper,
    concurrentSessionLimit: 3,
  });
  if (!session.ok) throw new Error("Could not create admin test session");

  const calls: ControlPlaneCall[] = [];
  const internal = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = request.method === "POST" ? await request.clone().json() : null;
    calls.push({
      method: request.method,
      path: url.pathname + url.search,
      body,
      headers: request.headers,
    });
    if (options.handleControlPlane) return options.handleControlPlane(request);
    if (url.pathname === "/v1/operator/releases") {
      return Response.json({
        items: [],
        nextCursor: null,
        stableChannel: { currentReleaseId: null, revision: 0 },
      });
    }
    if (url.pathname === "/v1/operator/releases/audit") return Response.json({ events: [] });
    if (url.pathname === "/v1/operator/source-builds" && request.method === "GET") {
      return Response.json({ items: options.listItems ?? [], nextCursor: null });
    }
    if (url.pathname === `/v1/operator/source-builds/${JOB_ID}` && request.method === "GET") {
      return options.initialDetail
        ? Response.json(options.initialDetail)
        : Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
    }
    return Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
  };
  const context = {
    config: {
      origin: GATEWAY,
      adminOrigin: ADMIN,
      adminGithubUserIds: [ADMIN_ID],
      sessionPepper: pepper,
      handoffPepper: pepper,
      sessionTtlSeconds: 3600,
      controlPlaneSecret: CONTROL_PLANE_SECRET,
    },
    requestId: "admin-diagnostics-test",
    requestNow: NOW,
    sessionStore,
    env: {
      CONTROL_PLANE: { fetch: internal },
      PRAETORIUM_RELEASE_SOURCES_JSON: sourceRegistry,
    },
    githubUserTokens: { accessTokenFor: async () => "test-github-user-token" },
  } as unknown as GatewayContext;
  const csrf = await sessionCsrfToken(context, session.value.rawSessionId);
  const cookies = `${SESSION_COOKIE}=${session.value.rawSessionId}; ${CSRF_COOKIE}=${csrf}`;
  return { context, cookies, csrf, calls, internal };
}

function get(path: string, cookies?: string, origin = ADMIN): Request {
  return new Request(origin + path, {
    headers: cookies ? { Cookie: cookies } : undefined,
  });
}

function post(
  path: string,
  cookies: string,
  csrf: string,
  fields: Record<string, string>,
  origin = ADMIN,
): Request {
  return new Request(ADMIN + path, {
    method: "POST",
    headers: {
      Origin: origin,
      Cookie: cookies,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ csrfToken: csrf, ...fields }),
  });
}

function githubRelease() {
  return {
    id: GITHUB_RELEASE_ID,
    draft: false,
    published_at: "2026-10-22T08:00:00.000Z",
    tag_name: "v0.3.3",
    prerelease: false,
    name: "v0.3.3",
    body: "",
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("operator Source diagnostics routes", () => {
  it("authorizes reads before calling the internal Control Plane binding", async () => {
    const unauthenticated = await fixture({ initialDetail: detail(job("failed", 1, 2, true)) });
    const denied = await handleAdminHost(get(`/builds/${JOB_ID}`), unauthenticated.context);
    expect(denied.status).toBe(403);
    expect(unauthenticated.calls).toHaveLength(0);

    const nonAdmin = await fixture({
      userId: "9876543",
      initialDetail: detail(job("failed", 1, 2, true)),
    });
    const deniedUser = await handleAdminHost(
      get(`/builds/${JOB_ID}`, nonAdmin.cookies),
      nonAdmin.context,
    );
    expect(deniedUser.status).toBe(403);
    expect(nonAdmin.calls).toHaveLength(0);

    const admin = await fixture({ initialDetail: detail(job("failed", 1, 2, true)) });
    const response = await handleAdminHost(get(`/builds/${JOB_ID}`, admin.cookies), admin.context);
    expect(response.status).toBe(200);
    expect(admin.calls).toHaveLength(1);
    expect(admin.calls[0]?.path).toBe(`/v1/operator/source-builds/${JOB_ID}?limit=10`);
    expect(admin.calls[0]?.headers.get("X-Control-Plane-Gateway-Auth")).toBe(CONTROL_PLANE_SECRET);
    expect(admin.calls[0]?.headers.get("X-Praetorium-Admin-Actor")).toBe(ADMIN_ID);
    expect(await response.text()).not.toContain(CONTROL_PLANE_SECRET);
  });

  it("shows each canonical queue state and preserves the failed attempt across retry", async () => {
    const failedAttempt = buildAttempt({
      id: "attempt-failed-1",
      attempt: 1,
      revision: 0,
      leaseEpoch: 1,
      state: "failed",
      stage: "buildkit",
      evidence: "available",
      expiresAt: 1_795_000_000_000,
      diagnostic: {
        stage: "buildkit",
        reason: "build_failed",
        summary: "BuildKit exited with code 1.",
        excerpt: "dependency compilation failed",
        truncated: false,
      },
    });
    let currentDetail = detail(job("failed", 1, 0, true), [failedAttempt], "available");
    let listItems: readonly SourceBuildSummary[] = [
      job("queued", 0, 0),
      job("building", 1, 0),
      job("failed", 1, 0, true),
    ];
    let retryCalls = 0;
    const f = await fixture({
      initialDetail: currentDetail,
      listItems,
      handleControlPlane: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/v1/operator/source-builds" && request.method === "GET") {
          return Response.json({ items: listItems, nextCursor: null });
        }
        if (url.pathname === `/v1/operator/source-builds/${JOB_ID}` && request.method === "GET") {
          return Response.json(currentDetail);
        }
        if (
          url.pathname === `/v1/operator/source-builds/${JOB_ID}/retry` &&
          request.method === "POST"
        ) {
          retryCalls += 1;
          currentDetail = detail(job("queued", 0, 1), [failedAttempt], "available");
          listItems = [currentDetail.job];
          return Response.json({ job: currentDetail.job, duplicate: false }, { status: 202 });
        }
        return Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
      },
    });

    const queue = await handleAdminHost(get("/builds?ui=mobile", f.cookies), f.context);
    expect(queue.status).toBe(200);
    const queueHtml = await queue.text();
    expect(queueHtml).toContain('data-ui="mobile"');
    expect(queueHtml).toContain(`/builds/${JOB_ID}?ui=mobile`);
    expect(queueHtml).not.toContain(`/source-builds/${JOB_ID}/retry`);

    const snapshots = [
      detail(job("queued", 0, 0)),
      detail(
        job("building", 1, 0),
        [
          buildAttempt({
            id: "attempt-building-1",
            attempt: 1,
            revision: 0,
            leaseEpoch: 1,
            state: "building",
            stage: "build_environment",
            evidence: "available",
            diagnostic: {
              stage: "build_environment",
              reason: "stage_started",
              summary: "Build environment is starting.",
              truncated: false,
            },
          }),
        ],
        "available",
      ),
      detail(job("failed", 1, 0, true), [failedAttempt], "available"),
      detail(
        job("admitted", 1, 1),
        [
          failedAttempt,
          buildAttempt({
            id: "attempt-produced-2",
            attempt: 1,
            revision: 1,
            leaseEpoch: 2,
            state: "produced",
            stage: "admission",
            evidence: "available",
            diagnostic: {
              stage: "admission",
              reason: "completed",
              summary: "Source artifact admitted.",
              truncated: false,
            },
          }),
        ],
        "available",
      ),
    ];
    for (const snapshot of snapshots) {
      currentDetail = snapshot;
      const page = await handleAdminHost(get(`/builds/${JOB_ID}?ui=desktop`, f.cookies), f.context);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html.toLowerCase()).toContain(snapshot.job.state);
      expect(html).toContain(JOB_ID);
      if (snapshot.job.state === "failed") {
        expect(html).toContain("SOURCE_BUILD_FAILED");
        expect(html).toContain("BuildKit exited with code 1.");
        expect(html).toContain(`/source-builds/${JOB_ID}/retry`);
      }
      if (snapshot.job.state === "building") {
        expect(html).not.toContain("aria-valuenow");
        const visibleText = html
          .replace(/<style\b[\s\S]*?<\/style>/giu, " ")
          .replace(/<[^>]+>/gu, " ")
          .replace(/\s+/gu, " ");
        expect(visibleText).not.toMatch(/\bETA\b/iu);
        expect(visibleText).not.toMatch(/\b\d+(?:\.\d+)?%\b/u);
      }
      if (snapshot.job.state === "admitted") {
        expect(html).toContain("attempt-failed-1");
        expect(html).toContain("attempt-produced-2");
        expect(html).toContain("/releases/rel_v033?ui=desktop");
      }
    }

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === `/repos/yohn-jp/scriptorium/releases/${GITHUB_RELEASE_ID}`)
          return Response.json(githubRelease());
        if (url.pathname === "/repos/yohn-jp/scriptorium/git/ref/tags/v0.3.3")
          return Response.json({ object: { type: "commit", sha: SOURCE_COMMIT } });
        return Response.json({ message: "not found" }, { status: 404 });
      }),
    );
    currentDetail = detail(job("failed", 1, 0, true), [failedAttempt], "available");
    const retry = await handleAdminHost(
      post(`/source-builds/${JOB_ID}/retry?ui=mobile`, f.cookies, f.csrf, {
        expectedRevision: "0",
        idempotencyKey: "retry-operation-1",
      }),
      f.context,
    );
    expect(retry.status).toBe(303);
    const retryLocation = new URL(retry.headers.get("Location")!, ADMIN);
    expect(retryLocation.pathname).toBe(`/builds/${JOB_ID}`);
    expect(retryLocation.searchParams.get("ui")).toBe("mobile");
    expect(retryLocation.searchParams.get("notice")).toMatch(/accepted|queued/i);
    expect(retryCalls).toBe(1);
    const retryCommand = f.calls.find(
      (call) =>
        call.method === "POST" && call.path === `/v1/operator/source-builds/${JOB_ID}/retry`,
    );
    expect(retryCommand?.body).toEqual({
      sourceId: "scriptorium",
      githubReleaseId: GITHUB_RELEASE_ID,
      sourceTag: "v0.3.3",
      sourceRevision: SOURCE_COMMIT,
      releaseVersion: "0.3.3",
      expectedRevision: 0,
      idempotencyKey: "retry-operation-1",
    });
    expect(retryCommand?.headers.get("X-Praetorium-Admin-Actor")).toBe(ADMIN_ID);
    expect(retryCommand?.headers.get("X-Control-Plane-Gateway-Auth")).toBe(CONTROL_PLANE_SECRET);
    expect(currentDetail.job.state).toBe("queued");
    expect(currentDetail.attempts).toEqual([failedAttempt]);
    const retryPage = await handleAdminHost(
      get(retryLocation.pathname + retryLocation.search, f.cookies),
      f.context,
    );
    const retryHtml = await retryPage.text();
    expect(retryPage.status).toBe(200);
    expect(retryHtml.toLowerCase()).toContain("queued");
    expect(retryHtml).toContain("attempt-failed-1");
    expect(retryHtml).toContain(retryLocation.searchParams.get("notice")!);
  });

  it("fails closed on CSRF, reports status outages separately, and shows absent or expired evidence truthfully", async () => {
    const failedAttempt = buildAttempt({
      id: "attempt-expired-1",
      attempt: 1,
      revision: 0,
      leaseEpoch: 1,
      state: "failed",
      stage: "unknown",
      evidence: "expired",
      expiresAt: 1_795_000_000_000,
    });
    const f = await fixture({
      initialDetail: detail(job("failed", 1, 0, true), [failedAttempt], "expired"),
    });
    const badCsrf = await handleAdminHost(
      post(`/source-builds/${JOB_ID}/retry`, f.cookies, "invalid", {
        expectedRevision: "0",
        idempotencyKey: "retry-operation-2",
      }),
      f.context,
    );
    expect(badCsrf.status).toBe(403);
    expect(f.calls).toHaveLength(0);
    const badOrigin = await handleAdminHost(
      post(
        `/source-builds/${JOB_ID}/retry`,
        f.cookies,
        f.csrf,
        {
          expectedRevision: "0",
          idempotencyKey: "retry-operation-cross-origin",
        },
        "https://attacker.test",
      ),
      f.context,
    );
    expect(badOrigin.status).toBe(403);
    const duplicateCsrfCookie = await handleAdminHost(
      post(`/source-builds/${JOB_ID}/retry`, `${f.cookies}; ${CSRF_COOKIE}=invalid`, f.csrf, {
        expectedRevision: "0",
        idempotencyKey: "retry-operation-duplicate-csrf",
      }),
      f.context,
    );
    expect(duplicateCsrfCookie.status).toBe(403);
    expect(f.calls).toHaveLength(0);

    const expired = await handleAdminHost(get(`/builds/${JOB_ID}`, f.cookies), f.context);
    expect(expired.status).toBe(200);
    const expiredHtml = await expired.text();
    expect(expiredHtml).toMatch(
      /evidence (?:is )?(?:not )?available|evidence expired|not recorded/iu,
    );
    expect(expiredHtml).toContain("SOURCE_BUILD_FAILED");

    const outage = await fixture({
      handleControlPlane: async () =>
        Response.json(
          {
            error: {
              code: "SOURCE_DIAGNOSTIC_UNAVAILABLE",
              message: "private registry credential leak",
            },
          },
          { status: 503 },
        ),
    });
    const unavailable = await handleAdminHost(
      get(`/builds/${JOB_ID}`, outage.cookies),
      outage.context,
    );
    expect(unavailable.status).toBe(200);
    const unavailableHtml = await unavailable.text();
    expect(unavailableHtml.toLowerCase()).toContain("status unavailable");
    expect(unavailableHtml.toLowerCase()).not.toContain("failed");
    expect(unavailableHtml).not.toContain("private registry credential leak");
  });

  it("rejects stale and ineligible retry commands before GitHub or retry admission", async () => {
    const current = detail(job("failed", 1, 5, true));
    const f = await fixture({ initialDetail: current });
    const github = vi.fn();
    vi.stubGlobal("fetch", github);

    const stale = await handleAdminHost(
      post(`/source-builds/${JOB_ID}/retry`, f.cookies, f.csrf, {
        expectedRevision: "4",
        idempotencyKey: "retry-operation-stale",
      }),
      f.context,
    );
    expect(stale.status).toBe(409);
    expect(github).not.toHaveBeenCalled();
    expect(f.calls.map((call) => call.method)).toEqual(["GET"]);

    const notRetryable = await fixture({
      initialDetail: detail(job("failed", 1, 5, false)),
    });
    const refused = await handleAdminHost(
      post(`/source-builds/${JOB_ID}/retry`, notRetryable.cookies, notRetryable.csrf, {
        expectedRevision: "5",
        idempotencyKey: "retry-operation-ineligible",
      }),
      notRetryable.context,
    );
    expect(refused.status).toBe(409);
    expect(notRetryable.calls.map((call) => call.method)).toEqual(["GET"]);
    expect(github).not.toHaveBeenCalled();
  });

  it("escapes diagnostic text and forwards bounded attempt cursors through the service binding", async () => {
    const hostileText = '<img src=x onerror="alert(1)">';
    const safeAttempt = buildAttempt({
      id: "attempt-hostile-text",
      attempt: 1,
      revision: 0,
      leaseEpoch: 1,
      state: "failed",
      stage: "buildkit",
      evidence: "available",
      expiresAt: 1_795_000_000_000,
      diagnostic: {
        stage: "buildkit",
        reason: "build_failed",
        summary: hostileText,
        excerpt: hostileText,
        truncated: false,
      },
    });
    const f = await fixture({
      initialDetail: {
        ...detail(job("failed", 1, 0, true), [safeAttempt], "available"),
        nextCursor: "epoch.17",
      },
    });
    const response = await handleAdminHost(
      get(`/builds/${JOB_ID}?ui=mobile&cursor=epoch.17`, f.cookies),
      f.context,
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).not.toContain(hostileText);
    expect(f.calls[0]?.path).toContain("cursor=epoch.17");
    expect(f.calls[0]?.headers.get("X-Control-Plane-Gateway-Auth")).toBe(CONTROL_PLANE_SECRET);
    expect(f.calls[0]?.headers.get("X-Praetorium-Admin-Actor")).toBe(ADMIN_ID);
  });
});
