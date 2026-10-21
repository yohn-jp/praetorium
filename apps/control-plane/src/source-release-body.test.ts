import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createControlPlaneApp, type ControlPlaneDependencies } from "./app.js";
import { D1SourceReleaseBuildQueue, createSourceReleaseOperatorRoutes, createSourceReleaseWorkerRoutes } from "./source-release-builds.js";

const jobId = "sr_11111111-1111-4111-8111-111111111111";
const token = "a".repeat(40);

function request(path: string, bytes: Uint8Array, headers: Record<string, string>, canceled: () => void): Request {
  return new Request("https://control.example" + path, {
    method: "POST", headers: { ...headers, "Content-Length": "1" },
    body: new ReadableStream({
      pull(controller) { controller.enqueue(bytes); },
      cancel: canceled,
    }),
    duplex: "half",
  } as RequestInit);
}

describe("Source HTTP body admission", () => {
  it("accepts the canonical Source operator POST through the complete Control Plane route", async () => {
    // Source mounts are strict about trailing slashes. Exercise the same public
    // route as Gateway and the disposable Source→Stable CI fixture.
    const operator = new Hono();
    operator.post("/", c => c.json({ job: { id: jobId }, duplicate: false }, 202));
    const app = createControlPlaneApp({
      registry: null as unknown as ControlPlaneDependencies["registry"],
      instances: null as unknown as ControlPlaneDependencies["instances"],
      gatewaySecret: "g".repeat(40),
      sourceReleaseOperator: operator,
    });
    const response = await app.request("/v1/operator/source-builds", {
      method: "POST",
      headers: { "X-Control-Plane-Gateway-Auth": "g".repeat(40) },
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({job:{id:jobId}});
  });

  it("leaves internal Source body enforcement to its mounted route instead of the Gateway cap", async () => {
    const source = new Hono();
    source.post("/:jobId/produced", async c => c.json({ bytes: (await c.req.arrayBuffer()).byteLength }));
    const app = createControlPlaneApp({
      registry: null as unknown as ControlPlaneDependencies["registry"],
      instances: null as unknown as ControlPlaneDependencies["instances"],
      gatewaySecret: "g".repeat(40),
      builds: {
        queue: null as unknown as NonNullable<ControlPlaneDependencies["builds"]>["queue"],
        serviceToken: token, workerId: "worker",
      },
      sourceReleaseWorker: source,
    });
    const bytes = new Uint8Array(66_000);
    const response = await app.request(`/internal/builds/source/${jobId}/produced`, {
      method: "POST", headers: { Authorization: "Bearer " + token, "Content-Length": String(bytes.length) }, body: bytes,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ bytes: bytes.length });
  });

  it("reports a missing migration without leaking the provider error", async () => {
    const queue = new D1SourceReleaseBuildQueue({
      prepare: () => { throw new Error("D1 request failed", { cause: new Error("no such table: private_source_table") }); },
      batch: vi.fn(),
    });
    const app = createSourceReleaseOperatorRoutes({ queue, operatorActorId: "71" });
    const response = await app.request("/", { headers: { "X-Praetorium-Admin-Actor": "71" } });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "SOURCE_RELEASE_UNAVAILABLE", reason: "schema_missing" } });
  });

  it.each([
    ["operator", "/", 2048], ["operator", `/${jobId}/retry`, 2048],
    ["worker", "/claim", 1024], ["worker", `/${jobId}/heartbeat`, 1024],
    ["worker", `/${jobId}/fail`, 1024], ["worker", `/${jobId}/produced`, 70 * 1024],
  ] as const)("bounds actual streamed bytes on %s %s before JSON or database work", async (kind, path, limit) => {
    const prepare = vi.fn(() => { throw new Error("database must not be reached"); });
    const queue = new D1SourceReleaseBuildQueue({ prepare, batch: vi.fn() });
    const app = kind === "operator"
      ? createSourceReleaseOperatorRoutes({ queue, operatorActorId: "71" })
      : createSourceReleaseWorkerRoutes({ queue, workerId: "worker", serviceToken: token, verifyProduced: async () => undefined });
    let canceled = false;
    const response = await app.request(request(path, new Uint8Array(limit + 1),
      kind === "operator" ? { "X-Praetorium-Admin-Actor": "71" } : { Authorization: "Bearer " + token },
      () => { canceled = true; }));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: { code: "REQUEST_TOO_LARGE" } });
    expect(canceled).toBe(true);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("rejects malformed UTF-8 and malformed JSON without database access", async () => {
    const prepare = vi.fn(() => { throw new Error("database must not be reached"); });
    const app = createSourceReleaseOperatorRoutes({
      queue: new D1SourceReleaseBuildQueue({ prepare, batch: vi.fn() }), operatorActorId: "71",
    });
    for (const bytes of [new Uint8Array([0xff]), new TextEncoder().encode("{")]) {
      const response = await app.request(new Request("https://control.example/", {
        method: "POST", headers: { "X-Praetorium-Admin-Actor": "71" }, body: bytes,
      }));
      expect(response.status).toBe(400);
    }
    expect(prepare).not.toHaveBeenCalled();
  });
});
