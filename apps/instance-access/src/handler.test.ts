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

async function createCookieJar(handler: (request: Request) => Promise<Response>): Promise<CookieJar> {
  const response = await handler(new Request(`${origin}/_platform/handoff`, {
    method: "POST",
    headers: {
      Host: host,
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
    const logoutCookies = logout.headers.getSetCookie();
    expect(logoutCookies).toHaveLength(3);
    expect(logoutCookies.some((value) => value.startsWith("__Host-praetorium_access=") && value.includes("Max-Age=0"))).toBe(true);
    expect(logoutCookies.some((value) => value.startsWith("__Secure-praetorium_refresh=") && value.includes("Max-Age=0"))).toBe(true);
    expect(logoutCookies.some((value) => value.startsWith("__Host-praetorium_csrf=") && value.includes("Max-Age=0"))).toBe(true);
  });

  it("keeps reauthentication cookie-neutral when stale tab responses arrive after refresh rotation", async () => {
    let gatewayCalls = 0;
    const handler = createInstanceAccessHandler(environment(async (request) => {
      gatewayCalls += 1;
      if (new URL(request.url).pathname.endsWith("/refresh")) {
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
    const jar = await createCookieJar(handler);
    const staleReauthOne = reauthRequest(host, new Map(jar));
    const staleReauthTwo = reauthRequest(host, new Map(jar));
    const oldRefresh = cookieValue(jar, "__Secure-praetorium_refresh");
    expect(staleReauthOne.headers.get("Cookie")).toContain(encodeURIComponent(oldRefresh));
    expect(staleReauthTwo.headers.get("Cookie")).toContain(encodeURIComponent(oldRefresh));

    const winner = await handler(refreshRequest(host, jar, oldRefresh));
    expect(winner.status).toBe(303);
    applyCookies(jar, winner);
    expect(cookieValue(jar, "__Secure-praetorium_refresh")).toBe("rotated-refresh-credential-secret");
    expect(cookieValue(jar, "__Host-praetorium_access")).toBe("rotated-access-token-secret");

    // Each tab already built its reauth request with the old cookies, but the
    // response must not delete the winning refresh or CSRF cookies.
    for (const request of [staleReauthOne, staleReauthTwo]) {
      const response = await handler(request);
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("https://gateway.service.test/entry/scriptorium/482901");
      expect(response.headers.getSetCookie()).toHaveLength(0);
      applyCookies(jar, response);
      expect(cookieValue(jar, "__Secure-praetorium_refresh")).toBe("rotated-refresh-credential-secret");
      expect(cookieValue(jar, "__Host-praetorium_access")).toBe("rotated-access-token-secret");
      expect(cookieValue(jar, "__Host-praetorium_csrf")).not.toBe("");
    }
    expect(gatewayCalls).toBe(2);
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

  it("re-enters the current Gateway handoff without mutating cookies", async () => {
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
    expect(navigation.headers.getSetCookie()).toHaveLength(0);
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
