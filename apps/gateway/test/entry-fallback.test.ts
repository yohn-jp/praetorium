import { createSession, type UserId } from "@praetorium/auth";
import { createInMemorySessionStore } from "@praetorium/auth/testing";
import { describe, expect, it, vi } from "vitest";
import type { GatewayContext } from "../src/context.js";
import { createGatewayRouter } from "../src/router.js";
import { createPortalService } from "../src/services/portal-service.js";

vi.mock("../src/services/portal-service.js", () => ({ createPortalService: vi.fn() }));

const NOW = "2026-10-19T04:00:00.000Z";
const ORIGIN = "https://gateway.service.test";
const INSTANCE = "ins_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const HOST = "ins-01arz3ndektsv4rrffq69g5fav.instances.service.test";
const REPOSITORY = 482901;

async function setup(ready = true) {
  const sessionPepper = new TextEncoder().encode("entry-fallback-test-pepper");
  const sessionStore = createInMemorySessionStore();
  const created = await createSession(sessionStore, {
    userId: "1234567" as UserId, authenticationContext: "github-oauth", now: NOW,
    ttlSeconds: 3600, pepper: sessionPepper, concurrentSessionLimit: 3,
  });
  if (!created.ok) throw new Error("session fixture failed");
  const execute = vi.fn(async () => ready
    ? { ok: true as const, value: { kind: "handoff" as const, handoff: { origin: `https://${HOST}`, code: "one-use-handoff-code", returnPath: "/" as const } } }
    : { ok: true as const, value: { kind: "operation" as const, operation: {
      operationId: "op_start", kind: "start", state: "queued" as const,
      progressPercent: null, message: "Waiting for the runtime", error: null, retryable: false,
    } } });
  vi.mocked(createPortalService).mockReturnValue({ execute } as unknown as ReturnType<typeof createPortalService>);
  const snapshot = {
    binding: { repositoryId: REPOSITORY, instanceId: INSTANCE, installationId: 83104, authorizationRevision: 9 },
    instance: { instanceId: INSTANCE, runtimeEpoch: 7, observedRuntimeEpoch: ready ? 7 : null,
      observedState: ready ? "ready" : "stopped", currentArtifactDigest: ready ? `sha256:${"a".repeat(64)}` : null,
      desiredArtifactDigest: `sha256:${"a".repeat(64)}` },
  };
  const context = {
    config: { environment: "test", origin: ORIGIN, sessionPepper, sessionTtlSeconds: 3600 },
    env: {}, requestId: "entry-fallback-test", requestNow: NOW, sessionStore,
    controlPlane: { getByInstanceId: async () => snapshot },
    githubAccess: { checkBoundAccess: async () => ({
      status: "allowed", repositoryId: REPOSITORY, instanceId: INSTANCE, runtimeEpoch: 7,
      installationId: 83104, authorizationRevision: 9, permissions: ["read"], expiresAt: Date.parse(NOW) + 25000,
    }) },
  } as unknown as GatewayContext;
  const app = createGatewayRouter(context);
  const request = (query = "?fallback=1", authenticated = true) => app.fetch(new Request(`${ORIGIN}/entry/${INSTANCE}${query}`, {
    headers: { Accept: "text/html", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document",
      ...(authenticated ? { Cookie: `__Host-praetorium_session=${created.value.rawSessionId}` } : {}) },
  }));
  return { request, execute };
}

describe("instance fallback entry", () => {
  it("stops a ready record returning through fallback before issuing another handoff", async () => {
    const { request, execute } = await setup();
    const response = await request();
    expect(response.status).toBe(503);
    const html = await response.text();
    expect(html).toContain("Application route unavailable");
    expect(html).toContain(`/repositories/${REPOSITORY}`);
    expect(html).toContain(`/entry/${INSTANCE}`);
    expect(html).not.toMatch(/http-equiv=["']refresh|\.submit\(/i);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps normal ready entry and stopped-instance wake paths", async () => {
    const ready = await setup();
    const opened = await ready.request("");
    expect(opened.status).toBe(200);
    expect(await opened.text()).toContain("/_platform/handoff");
    expect(ready.execute).toHaveBeenCalledOnce();
    const stopped = await setup(false);
    const waiting = await stopped.request();
    expect(waiting.status).toBe(202);
    expect(stopped.execute).toHaveBeenCalledOnce();
  });

  it("authenticates a fallback report before disclosing instance status", async () => {
    const { request, execute } = await setup();
    const response = await request("?fallback=1", false);
    expect(response.status).toBe(302);
    expect(await response.text()).not.toContain("Application route unavailable");
    expect(execute).not.toHaveBeenCalled();
  });
});
