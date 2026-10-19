import { describe, expect, it, vi } from "vitest";
import { createInstanceAccessHandler } from "./handler.js";

const HOST = "482901.scriptorium.yohn.jp";
const ORIGIN = `https://${HOST}`;
const ENTRY = "https://gateway.service.test/entry/scriptorium/482901";

function setup() {
  const gateway = vi.fn(async () => { throw new Error("fallback must not call Gateway"); });
  const handler = createInstanceAccessHandler({
    INSTANCE_ACCESS_INSTANCE_HOSTNAME_SUFFIX: "instances.service.test",
    INSTANCE_ACCESS_SERVICE_AUTH_TOKEN: "s".repeat(48),
    GATEWAY_ORIGIN: "https://gateway.service.test",
    GATEWAY: { fetch: gateway },
  });
  const request = (path: string) => handler(new Request(`${ORIGIN}${path}`, {
    headers: { Host: HOST, Accept: "text/html", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document", "Sec-Fetch-Site": "same-origin" },
  }));
  return { request, gateway };
}

describe("fallback entry routing", () => {
  it("marks ordinary fallback so Gateway can stop a contradictory ready handoff cycle", async () => {
    const { request, gateway } = setup();
    const response = await request("/");
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(`${ENTRY}?fallback=1`);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(gateway).not.toHaveBeenCalled();
  });

  it("does not mistake explicit reauthentication for a missing runtime route", async () => {
    const { request, gateway } = setup();
    const response = await request("/_platform/reauth");
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(ENTRY);
    expect(response.headers.getSetCookie()).toHaveLength(3);
    expect(gateway).not.toHaveBeenCalled();
  });
});
