import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import { createSession } from "../../packages/auth/dist/index.js";
import { createInMemorySessionStore } from "../../packages/auth/dist/testing/index.js";
import { sessionCsrfToken } from "../../apps/gateway/dist/http/session.js";
import { handleAdminHost } from "../../apps/gateway/dist/admin/console.js";

const JOB_ID = "sr_00000000-0000-4000-a000-000000000001";
const SOURCE_ID = "scriptorium";
const RELEASE_ID = 416_422_590;
const COMMIT = "a".repeat(40);
const SESSION_COOKIE = "__Host-praetorium_session";
const CSRF_COOKIE = "__Host-praetorium_csrf";
const ADMIN_ID = "213253858";
const EVIDENCE_DIR = process.env.PRAETORIUM_OPERATOR_EVIDENCE_DIR ??
  "/data/praetorium-console-browser/artifacts";

function summary(state, attempt, revision, retryable = false) {
  return {
    id: JOB_ID,
    sourceId: SOURCE_ID,
    releaseId: RELEASE_ID,
    tag: "v0.3.3",
    commit: COMMIT,
    version: "0.3.3",
    state,
    attempt,
    revision,
    retryable,
    error: state === "failed" ? "SOURCE_BUILD_FAILED" : null,
    admittedReleaseId: state === "admitted" ? "rel_v033" : null,
  };
}

function attempt({
  id,
  number,
  revision,
  epoch,
  state,
  stage,
  failureCode = null,
  evidence = "not_recorded",
  diagnostic = null,
}) {
  return {
    id,
    attempt: number,
    revision,
    leaseEpoch: epoch,
    state,
    stage,
    startedAt: 1_792_744_700_000 + epoch * 1_000,
    finishedAt: state === "building" ? null : 1_792_744_800_000 + epoch * 1_000,
    failureCode,
    evidence,
    expiresAt: evidence === "available" ? 1_795_000_000_000 : null,
    diagnostic,
  };
}

function detail(state) {
  if (state === "queued") {
    return { job: summary("queued", 0, 0), attempts: [], nextCursor: null, evidence: "not_recorded" };
  }
  if (state === "building") {
    return {
      job: summary("building", 1, 0),
      attempts: [attempt({
        id: "source-attempt-building-1", number: 1, revision: 0, epoch: 1,
        state: "building", stage: "build_environment", evidence: "available",
        diagnostic: {
          stage: "build_environment", reason: "stage_started",
          summary: "Build environment is starting.", truncated: false,
        },
      })],
      nextCursor: null,
      evidence: "available",
    };
  }
  if (state === "failed") {
    return {
      job: summary("failed", 1, 0, true),
      attempts: [attempt({
        id: "source-attempt-failed-1", number: 1, revision: 0, epoch: 1,
        state: "failed", stage: "buildkit", failureCode: "SOURCE_BUILD_FAILED",
        evidence: "available",
        diagnostic: {
          stage: "buildkit", reason: "build_failed",
          summary: 'BuildKit failed <img src=x onerror="alert(1)">.',
          excerpt: "Dependency compilation failed.", truncated: false,
        },
      })],
      nextCursor: null,
      evidence: "available",
    };
  }
  if (state === "retry_queued") {
    return {
      job: summary("queued", 0, 1),
      attempts: detail("failed").attempts,
      nextCursor: null,
      evidence: "available",
    };
  }
  if (state === "admitted") {
    return {
      job: summary("admitted", 1, 1),
      attempts: [
        ...detail("failed").attempts,
        attempt({
          id: "source-attempt-produced-2", number: 1, revision: 1, epoch: 2,
          state: "produced", stage: "admission", evidence: "available",
          diagnostic: {
            stage: "admission", reason: "completed",
            summary: "Source artifact admitted.", truncated: false,
          },
        }),
      ],
      nextCursor: null,
      evidence: "available",
    };
  }
  throw new Error(`Unknown fixture state: ${state}`);
}

async function browserLaunchOptions() {
  const environmentPath = process.env.PRAETORIUM_OPERATOR_BROWSER_ENVIRONMENT_PATH ??
    "/tmp/praetorium-browser-env.json";
  let browserEnvironment = {};
  try {
    browserEnvironment = JSON.parse(await readFile(environmentPath, "utf8"));
  } catch {
    // Playwright's installed default browser remains the fallback in CI.
  }
  const executablePath = process.env.PRAETORIUM_OPERATOR_BROWSER_PATH ??
    browserEnvironment.executablePath;
  return {
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    env: {
      PATH: process.env.PATH ?? "",
      ...(browserEnvironment.LD_LIBRARY_PATH
        ? { LD_LIBRARY_PATH: browserEnvironment.LD_LIBRARY_PATH }
        : {}),
      ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    },
    args: ["--no-sandbox", "--disable-background-networking", "--disable-default-apps"],
  };
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

async function startServer(controller) {
  const sessionStore = createInMemorySessionStore();
  const now = new Date().toISOString();
  const pepper = new TextEncoder().encode("operator-console-browser-fixture-only");
  const session = await createSession(sessionStore, {
    userId: ADMIN_ID,
    authenticationContext: "github-oauth",
    now,
    ttlSeconds: 3600,
    pepper,
    concurrentSessionLimit: 3,
  });
  assert.equal(session.ok, true);
  const csrf = await sessionCsrfToken({ config: { sessionPepper: pepper } }, session.value.rawSessionId);
  const cookies = `${SESSION_COOKIE}=${session.value.rawSessionId}; ${CSRF_COOKIE}=${csrf}`;

  const serviceBinding = {
    async fetch(input, init) {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.clone().json() : null;
      controller.cpCalls.push({
        method: request.method,
        path: url.pathname + url.search,
        headers: request.headers,
        body,
      });
      return controller.controlPlane(request);
    },
  };

  const server = createServer(async (incoming, outgoing) => {
    try {
      const requestUrl = new URL(incoming.url ?? "/", controller.origin);
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) headers.set(key, value.join(", "));
        else if (value !== undefined) headers.set(key, value);
      }
      // This SSR fixture models an authenticated browser after Gateway OAuth. The
      // real cookie/session contract is exercised by the Gateway route tests.
      headers.set("Cookie", cookies);
      if (incoming.method === "POST" && !headers.has("Origin"))
        headers.set("Origin", controller.origin);
      const body = incoming.method === "GET" || incoming.method === "HEAD"
        ? undefined
        : await readBody(incoming);
      const request = new Request(requestUrl, {
        method: incoming.method,
        headers,
        ...(body ? { body } : {}),
      });
      const response = await handleAdminHost(request, controller.context);
      outgoing.statusCode = response.status;
      response.headers.forEach((value, key) => {
        if (key.toLowerCase() !== "set-cookie") outgoing.setHeader(key, value);
      });
      const setCookies = response.headers.getSetCookie?.() ?? [];
      if (setCookies.length) outgoing.setHeader("Set-Cookie", setCookies);
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      outgoing.statusCode = 500;
      outgoing.setHeader("Content-Type", "text/plain; charset=utf-8");
      outgoing.end("Local browser fixture failed.");
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  controller.origin = origin;
  controller.context = {
    config: {
      origin: "https://gateway.test",
      adminOrigin: origin,
      adminGithubUserIds: [ADMIN_ID],
      sessionPepper: pepper,
      handoffPepper: pepper,
      sessionTtlSeconds: 3600,
      controlPlaneSecret: "local-test-service-key-never-exposed-to-browser",
    },
    requestId: "operator-console-browser-local",
    requestNow: now,
    sessionStore,
    env: {
      CONTROL_PLANE: serviceBinding,
      PRAETORIUM_RELEASE_SOURCES_JSON: JSON.stringify([{
        id: SOURCE_ID,
        label: "Scriptorium",
        githubRepository: "yohn-jp/scriptorium",
        adapter: "scriptorium-v1",
      }]),
    },
    githubUserTokens: { accessTokenFor: async () => "local-test-github-user-token" },
  };
  return { origin, server, csrf };
}

function stableReleasePayload() {
  return {
    items: [],
    nextCursor: null,
    stableChannel: { currentReleaseId: null, revision: 0 },
  };
}

test("operator console browser diagnostics contract uses local fixture data", { timeout: 120_000 }, async (t) => {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  const controller = {
    state: "queued",
    detailUnavailable: false,
    dispatches: [],
    retries: [],
    cpCalls: [],
    origin: "http://127.0.0.1",
    context: null,
    controlPlane: async (request) => {
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.clone().json() : null;
      if (url.pathname === "/v1/operator/source-builds" && request.method === "GET") {
        const current = controller.state === "retry_queued" ? detail("retry_queued") : detail(controller.state);
        return Response.json({ items: [current.job], nextCursor: null });
      }
      if (url.pathname === `/v1/operator/source-builds/${JOB_ID}` && request.method === "GET") {
        if (controller.detailUnavailable) {
          return Response.json({
            error: { code: "SOURCE_DIAGNOSTIC_UNAVAILABLE", message: "private registry credential" },
          }, { status: 503 });
        }
        return Response.json(controller.state === "retry_queued"
          ? detail("retry_queued")
          : detail(controller.state));
      }
      if (url.pathname === "/v1/operator/source-builds" && request.method === "POST") {
        assert.equal(request.headers.get("X-Control-Plane-Gateway-Auth"),
          "local-test-service-key-never-exposed-to-browser");
        assert.equal(request.headers.get("X-Praetorium-Admin-Actor"), ADMIN_ID);
        assert.deepEqual(body, {
          sourceId: SOURCE_ID,
          githubReleaseId: RELEASE_ID,
          sourceTag: "v0.3.3",
          sourceRevision: COMMIT,
          releaseVersion: "0.3.3",
        });
        controller.dispatches.push(body);
        controller.state = "queued";
        return Response.json({ job: summary("queued", 0, 0), duplicate: false }, { status: 202 });
      }
      if (url.pathname === `/v1/operator/source-builds/${JOB_ID}/retry` && request.method === "POST") {
        assert.equal(request.headers.get("X-Control-Plane-Gateway-Auth"),
          "local-test-service-key-never-exposed-to-browser");
        assert.equal(request.headers.get("X-Praetorium-Admin-Actor"), ADMIN_ID);
        controller.retries.push(body);
        controller.state = "retry_queued";
        return Response.json({ job: detail("retry_queued").job, duplicate: false }, { status: 202 });
      }
      if (url.pathname === "/v1/operator/releases/rel_v033") {
        return Response.json({
          release: {
            id: "rel_v033",
            version: "0.3.3",
            imageDigest: `sha256:${"b".repeat(64)}`,
            status: "available",
          },
          workflow: {
            state: "promoted",
            revision: 4,
            failureCode: null,
            attempts: 1,
            nextAttemptAt: null,
            canaryBuildKey: null,
            canaryOperationId: null,
          },
          build: null,
        });
      }
      if (url.pathname === "/v1/operator/releases") return Response.json(stableReleasePayload());
      if (url.pathname === "/v1/operator/releases/audit") return Response.json({ events: [] });
      return Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
    },
  };
  const serverFixture = await startServer(controller);
  let browser;
  let currentPage;
  const result = {
    proof: "local-server-rendered operator diagnostics browser contract",
    hostedAcceptance: "NOT_CHECKED",
    viewports: [],
    states: [],
  };
  const oldFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/repos/yohn-jp/scriptorium/releases") {
        return Response.json([{
          id: RELEASE_ID,
          draft: false,
          published_at: "2026-10-22T08:00:00.000Z",
          tag_name: "v0.3.3",
          prerelease: false,
          name: "v0.3.3",
          body: "Fixture release for the local browser contract.",
        }]);
      }
      if (url.pathname === `/repos/yohn-jp/scriptorium/releases/${RELEASE_ID}`) {
        return Response.json({
          id: RELEASE_ID,
          draft: false,
          published_at: "2026-10-22T08:00:00.000Z",
          tag_name: "v0.3.3",
          prerelease: false,
          name: "v0.3.3",
          body: "",
        });
      }
      if (url.pathname === "/repos/yohn-jp/scriptorium/git/ref/tags/v0.3.3") {
        return Response.json({ object: { type: "commit", sha: COMMIT } });
      }
      throw new Error(`Unexpected external request in local browser fixture: ${url.origin}${url.pathname}`);
    };

    browser = await chromium.launch(await browserLaunchOptions());
    const context = await browser.newContext({ serviceWorkers: "block" });
    currentPage = await context.newPage();
    currentPage.setDefaultTimeout(8_000);
    const consoleErrors = [];
    currentPage.on("pageerror", (error) => consoleErrors.push(error.message));

    async function runBuildJourney(mode, width) {
      await currentPage.setViewportSize({ width, height: mode === "mobile" ? 900 : 1000 });
      await currentPage.goto(`${serverFixture.origin}/releases?ui=${mode}`, { waitUntil: "domcontentloaded" });
      await currentPage.getByRole("heading", { name: "Releases", exact: true }).waitFor();
      assert.equal(await currentPage.getByRole("navigation", { name: "Operator sections" }).count(), 1);
      await currentPage.getByRole("button", { name: "Build & deploy" }).click();
      await currentPage.waitForURL((url) => url.pathname === `/builds/${JOB_ID}` &&
        url.searchParams.get("ui") === mode && url.searchParams.get("notice") !== null);
      assert.match(await currentPage.locator("body").innerText(), /Source build queued/i);
      assert.equal(controller.dispatches.length, mode === "desktop" ? 1 : 2);
      result.states.push(`${mode}: release selected and source build queued`);

      await currentPage.getByRole("heading", { name: /v0\.3\.3/ }).waitFor();
      assert.match(await currentPage.locator("body").innerText(), /queued/i);
      controller.state = "building";
      await currentPage.reload({ waitUntil: "domcontentloaded" });
      assert.match(await currentPage.locator("body").innerText(), /building/i);
      result.states.push(`${mode}: building`);

      controller.state = "failed";
      await currentPage.reload({ waitUntil: "domcontentloaded" });
      await currentPage.getByText("SOURCE_BUILD_FAILED").first().waitFor();
      const failureText = await currentPage.locator("body").innerText();
      assert.match(failureText, /BuildKit failed <img src=x onerror="alert\(1\)">/i);
      assert.equal(await currentPage.locator('img[src="x"]').count(), 0);
      result.states.push(`${mode}: failed with escaped diagnostic`);

      // The failed attempt remains visible after retry; notices stay out of
      // the document flow so neither the header nor content jumps.
      assert.equal(await currentPage.locator("input[name='expectedRevision']").inputValue(), "0");
      const beforeRetry = await currentPage.evaluate(() => {
        const header = document.querySelector(".desktop-operator-topbar, .admin-mobile-header");
        const main = document.querySelector(".desktop-operator-content, .admin-mobile-main, main");
        return {
          headerHeight: header?.getBoundingClientRect().height ?? null,
          mainTop: main?.getBoundingClientRect().top ?? null,
        };
      });
      await currentPage.getByRole("button", { name: "Retry Source build" }).click();
      await currentPage.waitForURL((url) => url.pathname === `/builds/${JOB_ID}` &&
        url.searchParams.get("ui") === mode && url.searchParams.get("notice") !== null);
      assert.match(await currentPage.locator("body").innerText(), /retry accepted/i);
      assert.match(await currentPage.locator("body").innerText(), /BuildKit failed <img src=x/i);
      const afterNotice = await currentPage.evaluate(() => {
        const header = document.querySelector(".desktop-operator-topbar, .admin-mobile-header");
        const main = document.querySelector(".desktop-operator-content, .admin-mobile-main, main");
        const notice = document.querySelector(".desktop-notice, .admin-mobile-toast");
        const noticeSurface = document.querySelector(".desktop-notice-slot, .admin-mobile-toast");
        return {
          headerHeight: header?.getBoundingClientRect().height ?? null,
          mainTop: main?.getBoundingClientRect().top ?? null,
          noticeRole: notice?.getAttribute("role") ?? null,
          noticeLive: notice?.getAttribute("aria-live") ?? notice?.parentElement?.getAttribute("aria-live") ?? null,
          noticePosition: noticeSurface ? getComputedStyle(noticeSurface).position : null,
        };
      });
      if (beforeRetry.headerHeight !== null && afterNotice.headerHeight !== null)
        assert.equal(afterNotice.headerHeight, beforeRetry.headerHeight, "notice must not resize the header");
      if (beforeRetry.mainTop !== null && afterNotice.mainTop !== null)
        assert.equal(afterNotice.mainTop, beforeRetry.mainTop, "notice must not push the main content down");
      assert.equal(afterNotice.noticeRole, "status");
      assert.equal(afterNotice.noticeLive, "polite");
      assert.equal(afterNotice.noticePosition, "fixed");
      assert.equal(controller.retries.length, mode === "desktop" ? 1 : 2);
      result.states.push(`${mode}: retry accepted with prior failure retained`);

      // Direct navigation remains server-rendered and authoritative after a
      // back/forward round trip and a fresh reload.
      await currentPage.goBack({ waitUntil: "domcontentloaded" });
      assert.equal(new URL(currentPage.url()).pathname, `/builds/${JOB_ID}`);
      await currentPage.getByText("SOURCE_BUILD_FAILED").first().waitFor();
      assert.match(await currentPage.locator("body").innerText(), /queued/i);
      await currentPage.goForward({ waitUntil: "domcontentloaded" });
      assert.equal(new URL(currentPage.url()).pathname, `/builds/${JOB_ID}`);
      await currentPage.getByText("SOURCE_BUILD_FAILED").first().waitFor();
      assert.match(await currentPage.locator("body").innerText(), /retry accepted/i);
      await currentPage.reload({ waitUntil: "domcontentloaded" });
      await currentPage.getByText("SOURCE_BUILD_FAILED").first().waitFor();

      controller.state = "admitted";
      await currentPage.goto(`${serverFixture.origin}/builds/${JOB_ID}?ui=${mode}`, { waitUntil: "domcontentloaded" });
      await currentPage.getByText("admitted", { exact: true }).waitFor();
      assert.match(await currentPage.locator("body").innerText(), /source-attempt-failed-1/);
      assert.match(await currentPage.locator("body").innerText(), /source-attempt-produced-2/);
      await currentPage.locator(`a[href="/releases/rel_v033?ui=${mode}"]`).click();
      await currentPage.getByRole("heading", {
        name: mode === "desktop" ? "Release 0.3.3" : "0.3.3",
        exact: true,
      }).waitFor();
      assert.match(await currentPage.locator("body").innerText(), /canonical release status/i);
      assert.match(await currentPage.locator("body").innerText(), /promoted/i);
      assert.equal(await currentPage.locator("pre").count(), 0, "release status must remain typed, not raw JSON");
      result.states.push(`${mode}: admitted build follows canonical release status`);
    }

    await runBuildJourney("desktop", 1440);

    controller.state = "failed";
    await runBuildJourney("mobile", 390);
    controller.detailUnavailable = true;
    await currentPage.goto(`${serverFixture.origin}/builds/${JOB_ID}?ui=desktop`, { waitUntil: "domcontentloaded" });
    await currentPage.reload({ waitUntil: "domcontentloaded" });
    const unavailableText = await currentPage.locator("body").innerText();
    assert.match(unavailableText, /status unavailable/i);
    assert.doesNotMatch(unavailableText, /private registry credential/);
    assert.doesNotMatch(unavailableText, /SOURCE_BUILD_FAILED/);
    result.states.push("status outage distinct from failed");
    controller.detailUnavailable = false;

    // Exercise the independent mobile composition at the requested widths and
    // check for horizontal overflow and visible navigation/content.
    controller.state = "failed";
    for (const width of [320, 375, 390, 430]) {
      await currentPage.setViewportSize({ width, height: 900 });
      await currentPage.goto(`${serverFixture.origin}/builds/${JOB_ID}?ui=mobile`, { waitUntil: "domcontentloaded" });
      await currentPage.getByRole("heading", { name: "v0.3.3" }).waitFor();
      const measurement = await currentPage.evaluate(() => ({
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
        headingVisible: document.querySelector("h1")?.getBoundingClientRect().width > 0,
        navVisible: document.querySelector('nav[aria-label="Operator sections"]')?.getBoundingClientRect().height > 0,
      }));
      assert.ok(measurement.documentWidth <= width + 1, `horizontal overflow at ${width}px: ${JSON.stringify(measurement)}`);
      assert.ok(measurement.bodyWidth <= width + 1, `body overflow at ${width}px`);
      assert.equal(measurement.headingVisible, true);
      assert.equal(measurement.navVisible, true);
      await currentPage.screenshot({
        path: path.join(EVIDENCE_DIR, `operator-console-mobile-${width}.png`),
        fullPage: true,
      });
      result.viewports.push({ mode: "mobile", width, ...measurement });
    }

    await currentPage.setViewportSize({ width: 1440, height: 1000 });
    await currentPage.goto(`${serverFixture.origin}/builds/${JOB_ID}?ui=desktop`, { waitUntil: "domcontentloaded" });
    await currentPage.getByRole("heading", { name: /v0\.3\.3/ }).waitFor();
    const desktop = await currentPage.evaluate(() => ({
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      hasSidebar: document.querySelector(".desktop-operator-sidebar") !== null,
      hasTableOrDetail: document.querySelector(".desktop-attempt-timeline, .desktop-build-table") !== null,
    }));
    assert.ok(desktop.documentWidth <= 1441, `desktop horizontal overflow: ${JSON.stringify(desktop)}`);
    assert.equal(desktop.hasSidebar, true);
    assert.equal(desktop.hasTableOrDetail, true);
    await currentPage.screenshot({
      path: path.join(EVIDENCE_DIR, "operator-console-desktop-1440.png"),
      fullPage: true,
    });
    result.viewports.push({ mode: "desktop", width: 1440, ...desktop });

    assert.deepEqual(consoleErrors, []);
    await writeFile(path.join(EVIDENCE_DIR, "operator-console-diagnostics-result.json"),
      `${JSON.stringify(result, null, 2)}\n`);
    t.diagnostic(JSON.stringify(result));
  } catch (error) {
    if (currentPage) {
      await currentPage.screenshot({
        path: path.join(EVIDENCE_DIR, "operator-console-diagnostics-failure.png"),
        fullPage: true,
      }).catch(() => undefined);
    }
    await writeFile(path.join(EVIDENCE_DIR, "operator-console-diagnostics-result.json"),
      `${JSON.stringify({ ...result, failure: String(error) }, null, 2)}\n`).catch(() => undefined);
    throw error;
  } finally {
    globalThis.fetch = oldFetch;
    if (browser) await browser.close();
    await new Promise((resolve) => serverFixture.server.close(resolve));
  }
});
