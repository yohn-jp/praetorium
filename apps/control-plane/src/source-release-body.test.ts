import { describe, expect, it, vi } from "vitest";
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
