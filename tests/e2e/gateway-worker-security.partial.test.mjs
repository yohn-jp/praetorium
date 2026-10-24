import assert from "node:assert/strict";
import { randomBytes, webcrypto } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { createServer as createTcpServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

const checkoutRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sourceRoot = path.resolve(process.env.PRAETORIUM_GATEWAY_SOURCE_ROOT ?? checkoutRoot);
const gatewayEntry = path.join(sourceRoot, "apps/gateway/src/worker.ts");
const gatewayWrangler = path.join(sourceRoot, "apps/gateway/wrangler.toml");
const browserEnvironmentPath =
  process.env.PRAETORIUM_T14_BROWSER_ENVIRONMENT_PATH ?? "/tmp/praetorium-browser-env.json";
const SESSION_COOKIE = "__Host-praetorium_session";
const CSRF_COOKIE = "__Host-praetorium_csrf";
const LOGIN_NONCE_COOKIE = "__Host-praetorium_login_nonce";
const INSTANCE_ID = "ins_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const REDACT_CANARY = "T14_QUERY_REDACTION_CANARY";

function git(...arguments_) {
  return execFileSync("git", ["-C", sourceRoot, ...arguments_], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function responseHeader(response, name) {
  return response.headers[name.toLowerCase()] ?? null;
}

function setCookieHeaders(response) {
  return response.setCookies ?? [];
}

function findResponse(responses, pathname, hostname) {
  return responses.find((response) => {
    const url = new URL(response.url);
    return url.pathname === pathname && (!hostname || url.hostname === hostname);
  });
}

async function getAvailablePort() {
  const socket = createTcpServer();
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const { port } = socket.address();
  await new Promise((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

test("actual Gateway Worker partial browser security proof on owned local Miniflare bindings", async (t) => {
  const sourceHead = git("rev-parse", "HEAD");
  assert.equal(git("diff", "--quiet", "HEAD", "--", "apps/gateway") || "", "");
  const entryInfo = await stat(gatewayEntry).catch(() => null);
  assert.ok(entryInfo?.isFile(), "the actual apps/gateway/src/worker.ts entry must exist");
  const workerConfig = await readFile(gatewayWrangler, "utf8");
  const dateMatch = workerConfig.match(/^compatibility_date\s*=\s*"(\d{4}-\d{2}-\d{2})"\s*$/m);
  const flagsMatch = workerConfig.match(/^compatibility_flags\s*=\s*(\[[^\]]*\])\s*$/m);
  assert.ok(dateMatch, "Gateway Wrangler compatibility date is required");
  assert.ok(flagsMatch, "Gateway Wrangler compatibility flags are required");
  const compatibilityFlags = JSON.parse(flagsMatch[1]);
  assert.ok(compatibilityFlags.includes("nodejs_compat"));

  const browserEnvironment = JSON.parse(await readFile(browserEnvironmentPath, "utf8"));
  const executablePath = await realpath(browserEnvironment.executablePath);
  assert.ok((await stat(executablePath)).isFile(), "cached Chromium executable must exist");
  const bundle = await build({
    absWorkingDir: sourceRoot,
    entryPoints: [gatewayEntry],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    tsconfig: path.join(sourceRoot, "apps/gateway/tsconfig.json"),
    external: ["node:*", "cloudflare:workers"],
    write: false,
    logLevel: "silent",
  });
  const workerScript = bundle.outputFiles[0]?.text;
  assert.ok(workerScript, "esbuild must bundle the committed Gateway Worker entry");

  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "praetorium-gateway-browser-partial-"),
  );
  const structuredLogs = [];
  const controlPlaneCalls = [];
  const outboundCalls = [];
  let miniflare;
  let browser;
  let serverPort;
  let trustedOrigin;

  try {
    serverPort = await getAvailablePort();
    trustedOrigin = `https://gateway.test:${serverPort}`;

    const signingPair = await webcrypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const privateKeyJwk = await webcrypto.subtle.exportKey("jwk", signingPair.privateKey);
    const publicKeyJwk = await webcrypto.subtle.exportKey("jwk", signingPair.publicKey);
    const signingKeyId = "t14-local-gateway-signing-key";
    const sessionPepper = randomBytes(32).toString("base64url");
    const testBindings = {
      GATEWAY_ENVIRONMENT: "test",
      GATEWAY_ORIGIN: trustedOrigin,
      GATEWAY_SESSION_TTL_SECONDS: "3600",
      GATEWAY_HANDOFF_TTL_SECONDS: "30",
      GATEWAY_ACCESS_GRANT_TTL_SECONDS: "120",
      GATEWAY_INSTANCE_HOSTNAME_SUFFIX: "instances.test",
      GATEWAY_ALLOWED_REPOSITORY_OWNER: "praetorium",
      GITHUB_APP_ID: "123456",
      GITHUB_OAUTH_CLIENT_ID: "Iv1.t14-local-browser-test",
      GITHUB_OAUTH_CLIENT_SECRET: randomBytes(32).toString("base64url"),
      GATEWAY_SESSION_DIGEST_PEPPER: sessionPepper,
      GATEWAY_CREDENTIAL_DIGEST_PEPPER: randomBytes(32).toString("base64url"),
      GATEWAY_HANDOFF_DIGEST_PEPPER: randomBytes(32).toString("base64url"),
      GATEWAY_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64url"),
      GATEWAY_TOKEN_ENCRYPTION_KEY_ID: "t14-local-token-key",
      GATEWAY_SIGNING_KEY: JSON.stringify({ kid: signingKeyId, privateKeyJwk }),
      CONTROL_PLANE_GATEWAY_AUTH: randomBytes(32).toString("base64url"),
      INSTANCE_ACCESS_SERVICE_AUTH_TOKEN: randomBytes(32).toString("base64url"),
    };

    miniflare = new Miniflare({
      name: "praetorium-gateway-local-browser-partial",
      script: workerScript,
      modules: true,
      host: "127.0.0.1",
      port: serverPort,
      https: true,
      compatibilityDate: dateMatch[1],
      compatibilityFlags,
      bindings: testBindings,
      kvNamespaces: ["GATEWAY_KV"],
      kvPersist: path.join(temporaryRoot, "kv"),
      durableObjects: {
        USER_AUTH_STATE: { className: "UserAuthStateDurableObject", useSQLite: true },
        EPHEMERAL_CODES: { className: "EphemeralCodeDurableObject", useSQLite: true },
      },
      durableObjectsPersist: path.join(temporaryRoot, "durable-objects"),
      defaultPersistRoot: path.join(temporaryRoot, "other-storage"),
      serviceBindings: {
        CONTROL_PLANE: async (request) => {
          controlPlaneCalls.push({
            method: request.method,
            pathname: new URL(request.url).pathname,
          });
          return Response.json(
            {
              error: {
                code: "UPSTREAM_UNAVAILABLE",
                message: "local fail-closed Control Plane boundary",
              },
            },
            { status: 503 },
          );
        },
      },
      outboundService: async (request) => {
        outboundCalls.push({
          method: request.method,
          origin: new URL(request.url).origin,
          pathname: new URL(request.url).pathname,
        });
        return new Response("outbound network disabled in local acceptance", { status: 503 });
      },
      structuredWorkerdLogs: true,
      handleStructuredLogs: (event) => {
        structuredLogs.push(event);
      },
    });
    const readyUrl = await miniflare.ready;
    assert.equal(readyUrl.protocol, "https:");
    assert.equal(Number(readyUrl.port), serverPort);
    const kv = await miniflare.getKVNamespace("GATEWAY_KV");
    await kv.put(
      "gateway-signing-key-registry",
      JSON.stringify([
        {
          kid: signingKeyId,
          status: "active",
          createdAt: new Date().toISOString(),
          retiredAt: null,
          publicKeyJwk: { kty: "EC", crv: "P-256", x: publicKeyJwk.x, y: publicKeyJwk.y },
        },
      ]),
    );

    const browserRuntimeEnvironment = {
      PATH: process.env.PATH ?? "",
      ...(browserEnvironment.LD_LIBRARY_PATH
        ? { LD_LIBRARY_PATH: browserEnvironment.LD_LIBRARY_PATH }
        : {}),
      ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    };
    browser = await chromium.launch({
      executablePath,
      headless: true,
      env: browserRuntimeEnvironment,
      args: [
        "--no-sandbox",
        "--disable-background-networking",
        "--disable-default-apps",
        "--host-resolver-rules=MAP gateway.test 127.0.0.1,MAP attacker.test 127.0.0.1",
      ],
    });
    const browserContext = await browser.newContext({
      ignoreHTTPSErrors: true,
      serviceWorkers: "block",
    });
    const externalRequests = [];
    await browserContext.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === "gateway.test" || url.hostname === "attacker.test") {
        await route.continue();
      } else {
        externalRequests.push({
          origin: url.origin,
          pathname: url.pathname,
          method: route.request().method(),
        });
        await route.abort("blockedbyclient");
      }
    });
    const page = await browserContext.newPage();
    page.setDefaultTimeout(8_000);
    const browserResponses = [];
    const browserRequests = [];
    const responseTasks = [];
    const requestTasks = [];
    page.on("request", (request) => {
      const hostname = new URL(request.url()).hostname;
      if (hostname !== "gateway.test" && hostname !== "attacker.test") return;
      requestTasks.push(
        (async () => {
          const headers = await request.allHeaders();
          browserRequests.push({
            url: request.url(),
            method: request.method(),
            cookie: headers.cookie ?? "",
            accept: headers.accept ?? "",
          });
        })(),
      );
    });
    page.on("response", (response) => {
      const hostname = new URL(response.url()).hostname;
      if (hostname !== "gateway.test" && hostname !== "attacker.test") return;
      responseTasks.push(
        (async () => {
          browserResponses.push({
            url: response.url(),
            status: response.status(),
            headers: await response.allHeaders(),
            setCookies: await response.headerValues("set-cookie"),
          });
        })(),
      );
    });
    async function flushResponses() {
      const pending = responseTasks.splice(0);
      const pendingRequests = requestTasks.splice(0);
      await Promise.all([...pending, ...pendingRequests]);
    }
    async function visit(url, targetPage = page) {
      const startResponse = browserResponses.length;
      const startExternal = externalRequests.length;
      let navigationResponse = null;
      try {
        navigationResponse = await targetPage.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 8_000,
        });
      } catch (error) {
        if (externalRequests.length === startExternal) throw error;
      }
      await flushResponses();
      return {
        navigationResponse,
        responses: browserResponses.slice(startResponse),
      };
    }
    const actualRoutes = [
      {
        path: `/repositories/899998001?access_token=${REDACT_CANARY}&nested=must-not-survive`,
        redirectPath: "/repositories/899998001",
      },
      {
        path: `/entry/${INSTANCE_ID}?access_token=${REDACT_CANARY}&nested=must-not-survive`,
        redirectPath: `/entry/${INSTANCE_ID}`,
      },
    ];
    const loginStates = [];
    for (const route of actualRoutes) {
      const result = await visit(`https://attacker.test:${serverPort}${route.path}`);
      const entryResponse = findResponse(
        result.responses,
        new URL(route.path, "https://attacker.test").pathname,
        "attacker.test",
      );
      assert.ok(entryResponse, `browser reached the real Worker route ${route.path}`);
      assert.equal(entryResponse.status, 302);
      assert.equal(responseHeader(entryResponse, "cache-control"), "no-store");
      assert.equal(responseHeader(entryResponse, "referrer-policy"), "no-referrer");
      const trustedStart = new URL(responseHeader(entryResponse, "location"));
      assert.equal(
        trustedStart.origin,
        trustedOrigin,
        "untrusted Host must not control the authentication origin",
      );
      assert.equal(trustedStart.pathname, "/auth/github/start");
      assert.equal(trustedStart.searchParams.get("redirect_to"), route.redirectPath);
      assert.ok(
        !trustedStart.href.includes(REDACT_CANARY),
        "sensitive incoming query must not be copied to the redirect",
      );

      const routePath = route.path.split("?", 1)[0];
      const browserEntryRequest = browserRequests.findLast(
        (request) =>
          new URL(request.url).hostname === "attacker.test" &&
          new URL(request.url).pathname === routePath,
      );
      assert.ok(browserEntryRequest, "browser issued the requested Host and route");
      assert.equal(new URL(browserEntryRequest.url).host, `attacker.test:${serverPort}`);
      if (route.path.startsWith("/entry/")) {
        assert.ok(browserEntryRequest?.method === "GET");
        assert.equal(browserEntryRequest?.accept.includes("text/html"), true);
      }

      const startResponse = findResponse(result.responses, "/auth/github/start", "gateway.test");
      assert.ok(
        startResponse,
        "browser followed the redirect to the actual trusted Gateway origin",
      );
      assert.equal(startResponse.status, 302);
      assert.equal(responseHeader(startResponse, "cache-control"), "no-store");
      assert.equal(responseHeader(startResponse, "referrer-policy"), "no-referrer");
      const authorize = new URL(responseHeader(startResponse, "location"));
      assert.equal(authorize.origin, "https://github.com");
      assert.equal(
        authorize.searchParams.get("redirect_uri"),
        `${trustedOrigin}/auth/github/callback`,
      );
      assert.ok(
        !authorize.href.includes(REDACT_CANARY),
        "OAuth URL must not inherit caller query credentials",
      );
      const nonceCookie = setCookieHeaders(startResponse).find((cookie) =>
        cookie.startsWith(`${LOGIN_NONCE_COOKIE}=`),
      );
      assert.ok(nonceCookie, "OAuth start sets the browser-bound nonce cookie");
      assert.match(nonceCookie, /; Path=\//i);
      assert.match(nonceCookie, /; Secure/i);
      assert.match(nonceCookie, /; HttpOnly/i);
      assert.match(nonceCookie, /; SameSite=Lax/i);
      assert.ok(!nonceCookie.includes("Domain="), "__Host nonce cookie must remain host-only");
      const state = authorize.searchParams.get("state");
      assert.ok(state);
      loginStates.push({
        state,
        nonce: nonceCookie.slice(LOGIN_NONCE_COOKIE.length + 1).split(";", 1)[0],
      });
    }

    const sessionPageResponse = await page.goto(
      `${trustedOrigin}/api/session?access_token=${REDACT_CANARY}`,
      {
        waitUntil: "domcontentloaded",
      },
    );
    await flushResponses();
    assert.equal(
      sessionPageResponse?.status(),
      401,
      "session API remains unauthenticated without a session cookie",
    );
    assert.equal(sessionPageResponse?.headers()["cache-control"], "no-store");
    assert.ok(!(await sessionPageResponse?.text())?.includes(REDACT_CANARY));

    const jwksPageResponse = await page.goto(`${trustedOrigin}/.well-known/jwks.json`, {
      waitUntil: "domcontentloaded",
    });
    await flushResponses();
    assert.equal(jwksPageResponse?.status(), 200);
    const jwks = await jwksPageResponse.json();
    assert.equal(jwks.keys.length, 1);
    assert.equal(jwks.keys[0].kid, "t14-local-gateway-signing-key");
    assert.equal(jwks.keys[0].alg, "ES256");
    assert.equal(
      Object.hasOwn(jwks.keys[0], "d"),
      false,
      "public JWK response must not include private key material",
    );

    const authPackage = path.join(
      sourceRoot,
      "apps/gateway/node_modules/@praetorium/auth/dist/index.js",
    );
    const auth = await import(pathToFileURL(authPackage).href);
    const userId = "424242";
    const gatewayKv = await miniflare.getKVNamespace("GATEWAY_KV");
    const userAuthState = await miniflare.getDurableObjectNamespace("USER_AUTH_STATE");
    const userStub = userAuthState.get(userAuthState.idFromName(userId));
    async function seedLocalSession() {
      const rawSessionId = randomBytes(32).toString("base64url");
      const digest = await auth.keyedDigest(new TextEncoder().encode(sessionPepper), rawSessionId);
      const now = new Date().toISOString();
      const record = {
        userId,
        sessionRevision: 0,
        createdAt: now,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        lastActivityBucket: now,
        authenticationContext: "github-oauth",
        rotatedFromDigest: null,
        revokedAt: null,
      };
      await gatewayKv.put(`praetorium:digest-user:session:${digest}`, userId);
      const response = await userStub.fetch("https://user-auth-state/sessions/create", {
        method: "POST",
        body: JSON.stringify({ digest, record }),
      });
      assert.equal(
        response.status,
        204,
        "seeded browser session is stored in the actual disposable Gateway DO",
      );
      return {
        rawSessionId,
        csrfToken: await auth.keyedDigest(
          new TextEncoder().encode(sessionPepper),
          `csrf:${rawSessionId}`,
        ),
      };
    }
    const sessionForEntry = await seedLocalSession();
    const sessionForCsrf = await seedLocalSession();

    const directSessionCheck = await miniflare.dispatchFetch(`${trustedOrigin}/api/session`, {
      headers: { Cookie: `${SESSION_COOKIE}=${sessionForEntry.rawSessionId}` },
    });
    assert.equal(
      directSessionCheck.status,
      200,
      `test-owned session seed must resolve through actual D1/DO/KV bindings: ${await directSessionCheck.text()}`,
    );

    await browserContext.addCookies([
      {
        name: SESSION_COOKIE,
        value: sessionForEntry.rawSessionId,
        url: trustedOrigin,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ]);
    const authenticatedSessionResponse = await page.goto(`${trustedOrigin}/api/session`, {
      waitUntil: "domcontentloaded",
    });
    await flushResponses();
    assert.equal(
      authenticatedSessionResponse?.status(),
      200,
      "the real browser returns its host-only session cookie to Gateway",
    );
    assert.equal((await authenticatedSessionResponse?.json())?.userId, userId);

    const duplicateSession = `${SESSION_COOKIE}=${sessionForEntry.rawSessionId}; ${SESSION_COOKIE}=invalid-second-value`;
    const duplicateSessionResponse = await miniflare.dispatchFetch(`${trustedOrigin}/api/session`, {
      headers: { Cookie: duplicateSession },
    });
    assert.equal(
      duplicateSessionResponse.status,
      401,
      "duplicate session cookies fail closed in the actual Worker",
    );
    assert.equal(
      controlPlaneCalls.length,
      0,
      "unauthenticated session probes must not reach Control Plane",
    );
    const latestLogin = loginStates.at(-1);
    assert.ok(latestLogin);
    const duplicateNonce = `${LOGIN_NONCE_COOKIE}=${latestLogin.nonce}; ${LOGIN_NONCE_COOKIE}=invalid-second-value`;
    const callbackUrl = `${trustedOrigin}/auth/github/callback?state=${encodeURIComponent(latestLogin.state)}&code=T14-NONEXISTENT-CODE`;
    const duplicateNonceResponse = await miniflare.dispatchFetch(callbackUrl, {
      headers: { Cookie: duplicateNonce },
    });
    assert.equal(
      duplicateNonceResponse.status,
      401,
      "duplicate nonce cookies cannot complete an OAuth callback",
    );
    assert.ok(
      (duplicateNonceResponse.headers.getSetCookie?.() ?? []).some(
        (cookie) => cookie.startsWith(`${LOGIN_NONCE_COOKIE}=`) && /Max-Age=0/i.test(cookie),
      ),
    );
    assert.equal(controlPlaneCalls.length, 0, "nonce failure cannot call Control Plane");
    assert.equal(
      outboundCalls.length,
      0,
      "duplicate nonce failure must stop before external OAuth exchange",
    );

    const logoutUrl = `${trustedOrigin}/auth/logout`;
    const validCsrfResult = await miniflare.dispatchFetch(logoutUrl, {
      method: "POST",
      headers: {
        Origin: trustedOrigin,
        "Sec-Fetch-Site": "same-origin",
        Cookie: `${SESSION_COOKIE}=${sessionForCsrf.rawSessionId}; ${CSRF_COOKIE}=${sessionForCsrf.csrfToken}`,
        "X-CSRF-Token": sessionForCsrf.csrfToken,
      },
    });
    assert.equal(
      validCsrfResult.status,
      204,
      "unique session and matching CSRF cookie/token authorize the local test logout",
    );
    const duplicateCsrf = `${SESSION_COOKIE}=${sessionForEntry.rawSessionId}; ${CSRF_COOKIE}=${sessionForEntry.csrfToken}; ${CSRF_COOKIE}=invalid-second-value`;
    const csrfResult = await miniflare.dispatchFetch(logoutUrl, {
      method: "POST",
      headers: {
        Origin: trustedOrigin,
        "Sec-Fetch-Site": "same-origin",
        Cookie: duplicateCsrf,
        "X-CSRF-Token": sessionForEntry.csrfToken,
      },
    });
    assert.equal(
      csrfResult.status,
      403,
      "duplicate CSRF cookies fail closed even with a valid session and matching submitted token",
    );
    assert.ok(!(await csrfResult.text()).includes(sessionForEntry.rawSessionId));
    assert.equal(outboundCalls.length, 0, "local security probes must not make external fetches");

    const requestLogs = structuredLogs
      .map((event) => event.message)
      .filter((message) => message.includes('"type":"request"'));
    assert.ok(requestLogs.length > 0, "real Worker request logs are captured from Miniflare");
    assert.ok(requestLogs.some((line) => line.includes('"path":"/repositories/899998001"')));
    assert.ok(
      requestLogs.every(
        (line) => !line.includes(REDACT_CANARY) && !line.includes("T14-NONEXISTENT-CODE"),
      ),
    );
    assert.ok(
      externalRequests.every(
        (request) =>
          request.origin === "https://github.com" ||
          request.origin === "https://github.githubassets.com",
      ),
      `browser external requests are limited to the configured OAuth redirect and its blocked page assets`,
    );
    assert.ok(
      !externalRequests.some((request) => request.pathname === "/login/oauth/access_token"),
    );
    assert.equal(
      outboundCalls.length,
      0,
      "Worker network egress is blocked in the local Miniflare runtime",
    );
    assert.equal(
      controlPlaneCalls.length,
      0,
      "this partial security probe requires no Control Plane responses",
    );
    assert.equal(
      git("rev-parse", "HEAD"),
      sourceHead,
      "source HEAD must not change during the evidence run",
    );
    assert.equal(git("diff", "--quiet", "HEAD", "--", "apps/gateway") || "", "");

    t.diagnostic(
      JSON.stringify({
        proof: "partial-source-execution",
        sourceHead,
        sourceEntry: "apps/gateway/src/worker.ts",
        workerRuntime: "Miniflare 4.20260730.0",
        browserExecutable: executablePath,
        browserCases: [
          "attacker Host redirects to configured Gateway origin",
          "incoming query credentials omitted from login redirect and request logs",
          "configured OAuth callback and secure HttpOnly host nonce cookie",
          "valid local browser session resolves through Gateway DO and KV",
          "duplicate session, OAuth nonce, and CSRF cookies fail closed",
          "unauthenticated session API and public-only JWKS",
        ],
        limitations: [
          "no owned stable origin or actual Instance Access integration",
          "no successful GitHub App/OAuth login or producer artifact",
          "Control Plane service boundary intentionally fails closed",
        ],
      }),
    );
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    if (miniflare) await miniflare.dispose();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
