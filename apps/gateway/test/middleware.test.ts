import { afterEach, describe, expect, it, vi } from "vitest";
import { errorResponse } from "../src/middleware/error-response.js";
import { applySecurityHeaders } from "../src/middleware/security-headers.js";
import { getOrCreateRequestId, withRequestId } from "../src/middleware/request-id.js";
import { logRequest, redactedPath } from "../src/middleware/logging.js";

afterEach(() => vi.restoreAllMocks());

describe("Gateway response middleware", () => {
  it("maps errors to bounded JSON statuses and suppresses HEAD bodies", async () => {
    const request = new Request("https://gateway.service.test/path");
    const response = errorResponse(request, "RATE_LIMITED", "slow down", "req-1");
    expect(response.status).toBe(429);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: { code: "RATE_LIMITED", message: "slow down" }, requestId: "req-1" });

    const head = errorResponse(new Request(request, { method: "HEAD" }), "NOT_FOUND", "missing", "req-2");
    expect(head.status).toBe(404);
    expect(await head.text()).toBe("");
  });

  it("sets strict browser headers and only adds HSTS in production", () => {
    const dev = applySecurityHeaders(new Response("ok"), { isProductionLike: false });
    expect(dev.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(dev.headers.get("X-Frame-Options")).toBe("DENY");
    expect(dev.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(dev.headers.get("Strict-Transport-Security")).toBeNull();

    const production = applySecurityHeaders(new Response("ok"), { isProductionLike: true });
    expect(production.headers.get("Strict-Transport-Security")).toContain("max-age=");
  });

  it("omits query strings and whitelists request logs", () => {
    const url = new URL(
      "https://gateway.service.test/auth/callback?state=secret&redirect_to=%2Fentry%3Ftoken%3Dnested-secret",
    );
    expect(redactedPath(url)).toBe("/auth/callback");
    expect(redactedPath(url)).not.toContain("nested-secret");
    expect(getOrCreateRequestId(new Request("https://gateway.service.test", { headers: { "X-Request-Id": "edge-id" } }))).toBe("edge-id");
    expect(withRequestId(new Response("ok"), "req-3").headers.get("X-Request-Id")).toBe("req-3");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    logRequest({ requestId: "req-4", method: "POST", path: "/api/private", status: 200, durationMs: 4 });
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]?.[0]).not.toContain("cookie");
    expect(log.mock.calls[0]?.[0]).not.toContain("body");
  });
});
