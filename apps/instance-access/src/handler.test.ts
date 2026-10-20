import { describe, expect, it } from "vitest";
import { createInstanceAccessHandler, type InstanceAccessEnvironment } from "./handler.js";

const host = "482901.scriptorium.yohn.jp";
const origin = `https://${host}`;
const now = Date.now();

function environment(fetch: (request: Request) => Promise<Response>): InstanceAccessEnvironment {
  return {
    INSTANCE_ACCESS_INSTANCE_HOSTNAME_SUFFIX: "instances.service.test",
    INSTANCE_ACCESS_SERVICE_AUTH_TOKEN: "s".repeat(48),
    GATEWAY_ORIGIN: "https://gateway.service.test",
    GATEWAY: { fetch },
  };
}

function grantResponse(): Response {
  return Response.json({
    contractVersion: "instance-access/v2",
    token: "app-access-token-secret",
    expiresAt: new Date(now + 120_000).toISOString(),
    refreshCredential: "opaque-refresh-credential-secret",
    refreshExpiresAt: new Date(now + 3_600_000).toISOString(),
  });
}

type CookieJar = Map<string, string>;

function applyCookies(jar: CookieJar, response: Response): void {
  for (const value of response.headers.getSetCookie()) {
    const separator = value.indexOf("=");
    const end = value.indexOf(";", separator + 1);
    if (separator <= 0 || end < 0) continue;
    const name = value.slice(0, separator);
    if (/;\s*Max-Age=0(?:;|$)/i.test(value)) {
      jar.delete(name);
    } else {
      jar.set(name, decodeURIComponent(value.slice(separator + 1, end)));
    }
  }
}

function cookieHeader(jar: CookieJar): string {
  return [...jar.entries()].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("; ");
}

function cookieValue(jar: CookieJar, name: string): string {
  return jar.get(name) ?? "";
}

async function createCookieJar(handler: (request: Request) => Promise<Response>, targetHost = host): Promise<CookieJar> {
  const targetOrigin = `https://${targetHost}`;
  const response = await handler(new Request(`${targetOrigin}/_platform/handoff`, {
    method: "POST",
    headers: {
      Host: targetHost,
      Origin: "https://gateway.service.test",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "code=single-use-cookie-jar-code&returnPath=%2F",
  }));
  expect(response.status).toBe(303);
  const jar: CookieJar = new Map();
  applyCookies(jar, response);
  return jar;
}

function refreshRequest(targetHost: string, jar: CookieJar, credential = cookieValue(jar, "__Secure-praetorium_refresh")): Request {
  return new Request(`https://${targetHost}/_platform/refresh`, {
    method: "POST",
    headers: {
      Host: targetHost,
      Origin: `https://${targetHost}`,
      Cookie: [
        `__Secure-praetorium_refresh=${encodeURIComponent(credential)}`,
        `__Host-praetorium_csrf=${encodeURIComponent(cookieValue(jar, "__Host-praetorium_csrf"))}`,
      ].join("; "),
      "X-CSRF-Token": cookieValue(jar, "__Host-praetorium_csrf"),
    },
  });
}

function reauthRequest(targetHost: string, jar: CookieJar): Request {
  return new Request(`https://${targetHost}/_platform/reauth`, {
    headers: {
      Host: targetHost,
      Cookie: cookieHeader(jar),
      Accept: "text/html",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Site": "same-origin",
    },
  });
}

describe("Instance Access production handler", () => {
  it("redeems only the exact form host and keeps all credentials out of the browser response", async () => {
    let internalRequest: Request | undefined;
    const handler = createInstanceAccessHandler(
      environment(async (request) => {
        internalRequest = request;
        return grantResponse();
      }),
      fetch,
      () => now,
    );
    const response = await handler(
      new Request(`${origin}/_platform/handoff`, {
        method: "POST",
        headers: {
          Host: host,
          Origin: "https://gateway.service.test",
          "Content-Type": "application/x-www-form-urlencoded",
          "Sec-Fetch-Site": "cross-site",
        },
        body: "code=once-only-handoff-code&returnPath=%2F",
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const publicBody = await response.text();
    expect(publicBody).not.toContain("app-access-token-secret");
    expect(publicBody).not.toContain("opaque-refresh-credential-secret");
    expect(response.headers.get("Location")).not.toContain("once-only-handoff-code");

    expect(internalRequest?.url).toBe("https://gateway.internal/internal/instance-access/handoff");
    expect(internalRequest?.headers.get("Authorization")).toBe(`Bearer ${"s".repeat(48)}`);
    const gatewayBody = await internalRequest?.json();
    expect(gatewayBody).toMatchObject({
      contractVersion: "instance-access/v2",
      audience: "instance-access",
      appIdentity: "scriptorium", repositoryId: 482901,
      hostname: host,
      origin,
      code: "once-only-handoff-code",
      returnPath: "/",
    });

    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(3);
    const accessCookie = cookies.find((value) => value.startsWith("__Host-praetorium_access="));
    const refreshCookie = cookies.find((value) => value.startsWith("__Secure-praetorium_refresh="));
    const csrfCookie = cookies.find((value) => value.startsWith("__Host-praetorium_csrf="));
    expect(accessCookie).toContain("Secure");
    expect(accessCookie).toContain("HttpOnly");
    expect(refreshCookie).toContain("Secure");
    expect(refreshCookie).toContain("HttpOnly");
    expect(refreshCookie).toContain("Path=/_platform");
    expect(csrfCookie).toContain("Secure");
    expect(csrfCookie).not.toContain("HttpOnly");
    for (const value of cookies) expect(value).not.toContain("Domain=");
    expect(cookies.join("\n")).toContain("app-access-token-secret");
    expect(cookies.join("\n")).toContain("opaque-refresh-credential-secret");
  });

  it("does not resolve, allocate, wake or replay a guessed origin API request", async () => {
    let gatewayCalls = 0;
    const handler = createInstanceAccessHandler(environment(async () => {
      gatewayCalls += 1;
      return grantResponse();
    }));
    const request = new Request(`https://not-an-instance.instances.service.test/api/write`, {
      method: "POST",
      headers: { Host: "not-an-instance.instances.service.test", Accept: "application/json" },
      body: "must-not-be-read-or-replayed",
    });
    const response = await handler(request);

    expect(response.status).toBe(404);
    expect(gatewayCalls).toBe(0);
    expect(request.bodyUsed).toBe(false);
  });

  it("returns bounded startup responses without reading application bodies", async () => {
    let gatewayCalls = 0;
    const handler = createInstanceAccessHandler(environment(async () => {
      gatewayCalls += 1;
      return grantResponse();
    }));
    const request = new Request(`${origin}/api/write`, {
      method: "POST",
      headers: { Host: host, Accept: "application/json", "Content-Type": "application/json" },
      body: "do not buffer",
    });
    const response = await handler(request);

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("5");
    expect(await response.json()).toEqual({ error: { code: "INSTANCE_STARTING" } });
    expect(gatewayCalls).toBe(0);
    expect(request.bodyUsed).toBe(false);
  });

  it("requires the configured exact Gateway origin and one field value", async () => {
    let gatewayCalls = 0;
    const handler = createInstanceAccessHandler(environment(async () => {
      gatewayCalls += 1;
      return grantResponse();
    }));
    const invalidOrigin = await handler(new Request(`${origin}/_platform/handoff`, {
      method: "POST",
      headers: { Host: host, Origin: "https://attacker.test", "Content-Type": "application/x-www-form-urlencoded" },
      body: "code=once-only-handoff-code&returnPath=%2F",
    }));
    const duplicateCode = await handler(new Request(`${origin}/_platform/handoff`, {
      method: "POST",
      headers: { Host: host, Origin: "https://gateway.service.test", "Content-Type": "application/x-www-form-urlencoded" },
      body: "code=once-only-handoff-code&code=second-handoff-code&returnPath=%2F",
    }));
    const mismatchedHost = await handler(new Request("https://attacker.test/_platform/handoff", {
      method: "POST",
      headers: { Host: host, Origin: "https://gateway.service.test", "Content-Type": "application/x-www-form-urlencoded" },
      body: "code=once-only-handoff-code&returnPath=%2F",
    }));

    expect(invalidOrigin.status).toBe(403);
    expect(duplicateCode.status).toBe(400);
    expect(mismatchedHost.status).toBe(404);
    expect(gatewayCalls).toBe(0);
  });

  it("rotates refresh credentials and revokes them through CSRF-checked same-origin posts", async () => {
    const internalPaths: string[] = [];
    const handler = createInstanceAccessHandler(environment(async (request) => {
      const path = new URL(request.url).pathname;
      internalPaths.push(path);
      if (path.endsWith("/revoke")) {
        return Response.json({ contractVersion: "instance-access/v2", revoked: true });
      }
      if (path.endsWith("/refresh")) {
        return Response.json({
          contractVersion: "instance-access/v2",
          token: "rotated-access-token-secret",
          expiresAt: new Date(now + 120_000).toISOString(),
          refreshCredential: "rotated-refresh-credential-secret",
          refreshExpiresAt: new Date(now + 3_600_000).toISOString(),
        });
      }
      return grantResponse();
    }), fetch, () => now);
    const handoff = await handler(new Request(`${origin}/_platform/handoff`, {
      method: "POST",
      headers: {
        Host: host,
        Origin: "https://gateway.service.test",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "code=single-use-code-for-refresh&returnPath=%2F",
    }));
    const initialCookies = handoff.headers.getSetCookie();
    const readCookie = (cookies: readonly string[], name: string) => {
      const value = cookies.find((entry) => entry.startsWith(`${name}=`));
      return value ? /^([^;]+);/.exec(value)?.[1]?.slice(name.length + 1) ?? "" : "";
    };
    const csrf = decodeURIComponent(readCookie(initialCookies, "__Host-praetorium_csrf"));
    const initialRefresh = decodeURIComponent(readCookie(initialCookies, "__Secure-praetorium_refresh"));
    expect(csrf).not.toBe("");
    expect(initialRefresh).not.toBe("");

    const unauthenticatedRefresh = await handler(new Request(`${origin}/_platform/refresh`, {
      method: "POST",
      headers: { Host: host, Origin: origin },
    }));
    expect(unauthenticatedRefresh.status).toBe(401);
    expect(await unauthenticatedRefresh.json()).toEqual({ error: { code: "SESSION_REQUIRED" } });
    expect(unauthenticatedRefresh.headers.getSetCookie()).toHaveLength(0);
    expect(internalPaths).toEqual(["/internal/instance-access/handoff"]);

    const duplicateCsrf = await handler(new Request(`${origin}/_platform/refresh`, {
      method: "POST",
      headers: {
        Host: host,
        Origin: origin,
        Cookie: `__Secure-praetorium_refresh=${encodeURIComponent(initialRefresh)}; __Host-praetorium_csrf=${encodeURIComponent(csrf)}; __Host-praetorium_csrf=attacker-value`,
        "X-CSRF-Token": csrf,
      },
    }));
    const duplicateRefresh = await handler(new Request(`${origin}/_platform/refresh`, {
      method: "POST",
      headers: {
        Host: host,
        Origin: origin,
        Cookie: `__Secure-praetorium_refresh=${encodeURIComponent(initialRefresh)}; __Secure-praetorium_refresh=attacker-value; __Host-praetorium_csrf=${encodeURIComponent(csrf)}`,
        "X-CSRF-Token": csrf,
      },
    }));
    expect(duplicateCsrf.status).toBe(403);
    expect(duplicateCsrf.headers.getSetCookie()).toHaveLength(0);
    expect(duplicateRefresh.status).toBe(401);
    expect(internalPaths).toEqual(["/internal/instance-access/handoff"]);

    const rejected = await handler(new Request(`${origin}/_platform/refresh`, {
      method: "POST",
      headers: {
        Host: host,
        Origin: "https://attacker.service.test",
        Cookie: `__Secure-praetorium_refresh=${encodeURIComponent(initialRefresh)}; __Host-praetorium_csrf=${encodeURIComponent(csrf)}`,
        "X-CSRF-Token": csrf,
      },
    }));
    expect(rejected.status).toBe(403);
    expect(rejected.headers.getSetCookie()).toHaveLength(0);
    expect(internalPaths).toEqual(["/internal/instance-access/handoff"]);

    const refreshed = await handler(new Request(`${origin}/_platform/refresh`, {
      method: "POST",
      headers: {
        Host: host,
        Origin: origin,
        Cookie: `__Secure-praetorium_refresh=${encodeURIComponent(initialRefresh)}; __Host-praetorium_csrf=${encodeURIComponent(csrf)}`,
        "X-CSRF-Token": csrf,
      },
    }));
    expect(refreshed.status).toBe(303);
    expect(refreshed.headers.get("Location")).toBe("/");
    expect(refreshed.headers.get("Set-Cookie")).not.toContain("Domain=");
    expect((await refreshed.text())).not.toContain("app-access-token-secret");
    expect(internalPaths.at(-1)).toBe("/internal/instance-access/refresh");
    const refreshedCookies = refreshed.headers.getSetCookie();
    const rotatedRefresh = decodeURIComponent(readCookie(refreshedCookies, "__Secure-praetorium_refresh"));
    expect(rotatedRefresh).not.toBe(initialRefresh);
    const refreshedCsrf = decodeURIComponent(readCookie(refreshedCookies, "__Host-praetorium_csrf"));
    expect(refreshedCsrf).toBe(csrf);
    expect(refreshedCookies.some((value) => value.startsWith("__Host-praetorium_refresh_failure="))).toBe(false);

    const logout = await handler(new Request(`${origin}/_platform/logout`, {
      method: "POST",
      headers: {
        Host: host,
        Origin: origin,
        Cookie: `__Secure-praetorium_refresh=${encodeURIComponent(rotatedRefresh)}; __Host-praetorium_csrf=${encodeURIComponent(csrf)}`,
        "X-CSRF-Token": csrf,
      },
    }));
    expect(logout.status).toBe(303);
    expect(logout.headers.get("Location")).toBe("/");
    expect(internalPaths.at(-1)).toBe("/internal/instance-access/revoke");
    expect(logout.headers.getSetCookie().some((value) => value.startsWith("__Host-praetorium_access=") && value.includes("Max-Age=0"))).toBe(true);
    expect(logout.headers.getSetCookie().some((value) => value.startsWith("__Secure-praetorium_refresh=") && value.includes("Max-Age=0"))).toBe(true);
  });

  it("recovers cross-tab refresh races in either response order without making the marker authority", async () => {
    let outcome: "success" | "failure" = "success";
    const handler = createInstanceAccessHandler(environment(async (request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/refresh")) {
        if (outcome === "failure") return new Response(null, { status: 401 });
        return Response.json({
          contractVersion: "instance-access/v2",
          token: "rotated-access-token-secret",
          expiresAt: new Date(now + 120_000).toISOString(),
          refreshCredential: "rotated-refresh-credential-secret",
          refreshExpiresAt: new Date(now + 3_600_000).toISOString(),
        });
      }
      return grantResponse();
    }), fetch, () => now);

    // Winner response arrives first; the later stale 401 must not clear its cookies.
    const winnerFirstJar = await createCookieJar(handler);
    const originalRefresh = cookieValue(winnerFirstJar, "__Secure-praetorium_refresh");
    outcome = "success";
    const winnerFirstSuccess = await handler(refreshRequest(host, winnerFirstJar, originalRefresh));
    expect(winnerFirstSuccess.status).toBe(303);
    applyCookies(winnerFirstJar, winnerFirstSuccess);
    outcome = "failure";
    const staleFailure = await handler(refreshRequest(host, winnerFirstJar, originalRefresh));
    expect(staleFailure.status).toBe(401);
    const failureMarker = staleFailure.headers.getSetCookie().find((value) => value.startsWith("__Host-praetorium_refresh_failure="));
    expect(failureMarker).toContain("Path=/");
    expect(failureMarker).toContain("Secure");
    expect(failureMarker).toContain("HttpOnly");
    expect(failureMarker).toContain("SameSite=Lax");
    expect(failureMarker).toContain("Max-Age=60");
    expect(failureMarker).not.toContain("Domain=");
    expect(failureMarker).not.toContain(originalRefresh);
    expect(await staleFailure.text()).not.toContain("rotated-refresh-credential-secret");
    applyCookies(winnerFirstJar, staleFailure);

    // A second losing tab can have its own already-queued reauth navigation.
    const secondStaleFailure = await handler(refreshRequest(host, winnerFirstJar, originalRefresh));
    expect(secondStaleFailure.status).toBe(401);
    applyCookies(winnerFirstJar, secondStaleFailure);

    const preserveResponse = await handler(reauthRequest(host, winnerFirstJar));
    expect(preserveResponse.status).toBe(303);
    expect(preserveResponse.headers.get("Location")).toBe("/");
    expect(preserveResponse.headers.getSetCookie()).toHaveLength(0);
    applyCookies(winnerFirstJar, preserveResponse);
    expect(cookieValue(winnerFirstJar, "__Secure-praetorium_refresh")).toBe("rotated-refresh-credential-secret");
    expect(cookieValue(winnerFirstJar, "__Host-praetorium_access")).toBe("rotated-access-token-secret");
    expect(cookieValue(winnerFirstJar, "__Host-praetorium_csrf")).not.toBe("");

    const secondPreserveResponse = await handler(reauthRequest(host, winnerFirstJar));
    expect(secondPreserveResponse.status).toBe(303);
    expect(secondPreserveResponse.headers.get("Location")).toBe("/");
    expect(secondPreserveResponse.headers.getSetCookie()).toHaveLength(0);
    expect(cookieValue(winnerFirstJar, "__Secure-praetorium_refresh")).toBe("rotated-refresh-credential-secret");
    expect(cookieValue(winnerFirstJar, "__Host-praetorium_access")).toBe("rotated-access-token-secret");
    expect(cookieValue(winnerFirstJar, "__Host-praetorium_csrf")).not.toBe("");
    expect(winnerFirstJar.has("__Host-praetorium_refresh_failure")).toBe(true);

    // Losing response and reauth happen first; the in-flight winner must restore the full cookie set.
    const loserFirstJar = await createCookieJar(handler);
    const inFlightCookies = new Map(loserFirstJar);
    const losingRefresh = cookieValue(loserFirstJar, "__Secure-praetorium_refresh");
    outcome = "failure";
    const loserFirstFailure = await handler(refreshRequest(host, loserFirstJar, losingRefresh));
    expect(loserFirstFailure.status).toBe(401);
    applyCookies(loserFirstJar, loserFirstFailure);
    const sameCredentialReauth = await handler(reauthRequest(host, loserFirstJar));
    expect(sameCredentialReauth.status).toBe(302);
    expect(sameCredentialReauth.headers.get("Location")).toBe("https://gateway.service.test/entry/scriptorium/482901");
    expect(sameCredentialReauth.headers.getSetCookie()).toHaveLength(4);
    applyCookies(loserFirstJar, sameCredentialReauth);
    expect(loserFirstJar.size).toBe(0);

    outcome = "success";
    const lateWinner = await handler(refreshRequest(host, inFlightCookies, losingRefresh));
    expect(lateWinner.status).toBe(303);
    applyCookies(loserFirstJar, lateWinner);
    expect(cookieValue(loserFirstJar, "__Secure-praetorium_refresh")).toBe("rotated-refresh-credential-secret");
    expect(cookieValue(loserFirstJar, "__Host-praetorium_access")).toBe("rotated-access-token-secret");
    expect(cookieValue(loserFirstJar, "__Host-praetorium_csrf")).toBe(cookieValue(inFlightCookies, "__Host-praetorium_csrf"));
  });

  it("records a refresh failure marker only for a Gateway 401", async () => {
    let refreshStatus = 503;
    const handler = createInstanceAccessHandler(environment(async (request) => {
      if (new URL(request.url).pathname.endsWith("/refresh")) return new Response(null, { status: refreshStatus });
      return grantResponse();
    }), fetch, () => now);
    const jar = await createCookieJar(handler);

    const unavailable = await handler(refreshRequest(host, jar));
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.getSetCookie()).toHaveLength(0);

    refreshStatus = 401;
    const rejected = await handler(refreshRequest(host, jar));
    expect(rejected.status).toBe(401);
    expect(rejected.headers.getSetCookie().some((value) => value.startsWith("__Host-praetorium_refresh_failure="))).toBe(true);
  });

  it("clears unchanged, invalid, and foreign-origin refresh markers through the existing entry flow", async () => {
    let clock = now;
    const handler = createInstanceAccessHandler(environment(async (request) => {
      if (new URL(request.url).pathname.endsWith("/refresh")) return new Response(null, { status: 401 });
      return grantResponse();
    }), fetch, () => clock);

    const sameCredentialJar = await createCookieJar(handler);
    const failed = await handler(refreshRequest(host, sameCredentialJar));
    expect(failed.status).toBe(401);
    applyCookies(sameCredentialJar, failed);
    const unchanged = await handler(reauthRequest(host, sameCredentialJar));
    expect(unchanged.status).toBe(302);
    expect(unchanged.headers.get("Location")).toBe("https://gateway.service.test/entry/scriptorium/482901");
    expect(unchanged.headers.getSetCookie()).toHaveLength(4);

    const invalidMarkerJar = await createCookieJar(handler);
    invalidMarkerJar.set("__Secure-praetorium_refresh", "newer-refresh-credential");
    invalidMarkerJar.set("__Host-praetorium_refresh_failure", "not-a-valid-marker");
    const invalidMarker = await handler(reauthRequest(host, invalidMarkerJar));
    expect(invalidMarker.status).toBe(302);
    expect(invalidMarker.headers.getSetCookie()).toHaveLength(4);

    const expiredMarkerJar = await createCookieJar(handler);
    const expiredFailure = await handler(refreshRequest(host, expiredMarkerJar));
    expect(expiredFailure.status).toBe(401);
    applyCookies(expiredMarkerJar, expiredFailure);
    expiredMarkerJar.set("__Secure-praetorium_refresh", "newer-refresh-credential");
    clock += 61_000;
    const expiredMarker = await handler(reauthRequest(host, expiredMarkerJar));
    expect(expiredMarker.status).toBe(302);
    expect(expiredMarker.headers.getSetCookie()).toHaveLength(4);

    const currentJar = await createCookieJar(handler);
    const foreignHost = "482902.scriptorium.yohn.jp";
    const foreignJar = await createCookieJar(handler, foreignHost);
    const foreignFailure = await handler(refreshRequest(foreignHost, foreignJar));
    expect(foreignFailure.status).toBe(401);
    applyCookies(foreignJar, foreignFailure);
    const foreignMarker = cookieValue(foreignJar, "__Host-praetorium_refresh_failure");
    expect(foreignMarker).not.toBe("");

    currentJar.set("__Secure-praetorium_refresh", "newer-refresh-credential");
    currentJar.set("__Host-praetorium_refresh_failure", foreignMarker);
    const wrongOrigin = await handler(reauthRequest(host, currentJar));
    expect(wrongOrigin.status).toBe(302);
    expect(wrongOrigin.headers.getSetCookie()).toHaveLength(4);

    const duplicateMarkerRequest = new Request(`https://${host}/_platform/reauth`, {
      headers: {
        Host: host,
        Cookie: `${cookieHeader(currentJar)}; __Host-praetorium_refresh_failure=second-value`,
        Accept: "text/html",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Site": "same-origin",
      },
    });
    const duplicateMarker = await handler(duplicateMarkerRequest);
    expect(duplicateMarker.status).toBe(302);
    expect(duplicateMarker.headers.getSetCookie()).toHaveLength(4);

    const duplicateRefreshRequest = new Request(`https://${host}/_platform/reauth`, {
      headers: {
        Host: host,
        Cookie: `${cookieHeader(currentJar)}; __Secure-praetorium_refresh=second-value`,
        Accept: "text/html",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Site": "same-origin",
      },
    });
    const duplicateRefresh = await handler(duplicateRefreshRequest);
    expect(duplicateRefresh.status).toBe(302);
    expect(duplicateRefresh.headers.getSetCookie()).toHaveLength(4);
  });

  it("sends direct HTML navigation to Gateway and returns API startup without forwarding its body", async () => {
    let gatewayCalls = 0;
    const handler = createInstanceAccessHandler(environment(async () => {
      gatewayCalls += 1;
      return grantResponse();
    }));
    const navigation = await handler(new Request(`${origin}/`, {
      headers: {
        Host: host,
        Accept: "text/html",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "document",
      },
    }));
    expect(navigation.status).toBe(302);
    expect(navigation.headers.get("Location")).toBe(`https://gateway.service.test/entry/scriptorium/482901?fallback=1`);
    const apiRequest = new Request(`${origin}/api/write`, {
      method: "POST",
      headers: { Host: host, Accept: "application/json" },
      body: "manuscript body stays at the instance origin",
    });
    const api = await handler(apiRequest);
    expect(api.status).toBe(503);
    expect(await api.json()).toEqual({ error: { code: "INSTANCE_STARTING" } });
    expect(apiRequest.bodyUsed).toBe(false);
    expect(gatewayCalls).toBe(0);
  });

  it("clears stale same-origin grants and re-enters the current Gateway handoff", async () => {
    let gatewayCalls = 0;
    const handler = createInstanceAccessHandler(environment(async () => {
      gatewayCalls += 1;
      return grantResponse();
    }));
    const fetchRequest = await handler(new Request(`${origin}/_platform/reauth`, {
      headers: { Host: host, Accept: "application/json", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty" },
    }));
    expect(fetchRequest.status).toBe(400);
    expect(fetchRequest.headers.getSetCookie()).toHaveLength(0);

    const crossSite = await handler(new Request(`${origin}/_platform/reauth`, {
      headers: { Host: host, Accept: "text/html", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document", "Sec-Fetch-Site": "cross-site" },
    }));
    expect(crossSite.status).toBe(400);
    expect(crossSite.headers.getSetCookie()).toHaveLength(0);

    const navigation = await handler(new Request(`${origin}/_platform/reauth`, {
      headers: {
        Host: host,
        Accept: "text/html",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Site": "same-origin",
      },
    }));
    expect(navigation.status).toBe(302);
    expect(navigation.headers.get("Location")).toBe(
      `https://gateway.service.test/entry/scriptorium/482901`,
    );
    const cookies = navigation.headers.getSetCookie();
    expect(cookies).toHaveLength(4);
    expect(cookies.some((value) => value.startsWith("__Host-praetorium_access=") && value.includes("Max-Age=0"))).toBe(true);
    expect(cookies.some((value) => value.startsWith("__Secure-praetorium_refresh=") && value.includes("Max-Age=0"))).toBe(true);
    expect(cookies.some((value) => value.startsWith("__Host-praetorium_csrf=") && value.includes("Max-Age=0"))).toBe(true);
    expect(gatewayCalls).toBe(0);
  });

  it("does not send image, iframe, or other subresource requests through the wake path", async () => {
    let gatewayCalls = 0;
    const handler = createInstanceAccessHandler(
      environment(async () => {
        gatewayCalls += 1;
        return grantResponse();
      }),
    );
    const image = await handler(
      new Request(`${origin}/logo.svg`, {
        headers: {
          Host: host,
          Accept: "text/html,image/avif,image/webp,*/*",
          "Sec-Fetch-Mode": "no-cors",
          "Sec-Fetch-Dest": "image",
        },
      }),
    );
    const frame = await handler(
      new Request(`${origin}/embedded`, {
        headers: {
          Host: host,
          Accept: "text/html",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Dest": "iframe",
        },
      }),
    );
    const missingMetadata = await handler(
      new Request(`${origin}/document`, {
        headers: { Host: host, Accept: "text/html" },
      }),
    );

    expect(image.status).toBe(503);
    expect(frame.status).toBe(503);
    expect(missingMetadata.status).toBe(503);
    expect(
      [image, frame, missingMetadata].every((response) => response.headers.get("Location") === null),
    ).toBe(true);
    expect(gatewayCalls).toBe(0);
  });

  it("fails composition when production secrets or host configuration are missing", () => {
    expect(() => createInstanceAccessHandler({
      INSTANCE_ACCESS_INSTANCE_HOSTNAME_SUFFIX: "instances.service.test",
      GATEWAY_ORIGIN: "https://gateway.service.test",
      GATEWAY: { fetch: async () => new Response() },
    })).toThrow(/service token/i);
    expect(() => createInstanceAccessHandler({
      INSTANCE_ACCESS_INSTANCE_HOSTNAME_SUFFIX: "localhost",
      INSTANCE_ACCESS_SERVICE_AUTH_TOKEN: "s".repeat(48),
      GATEWAY_ORIGIN: "https://gateway.service.test",
      GATEWAY: { fetch: async () => new Response() },
    })).toThrow(/hostname suffix/i);
  });
});
