import { request as httpRequest } from "node:http";
import { WorkAvailability } from "@praetorium/application";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HealthServer } from "./health.js";
import { ProvisionerMetrics } from "./metrics.js";

const token = "work-notification-token-" + "x".repeat(32);

function postChunked(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/internal/work-available",
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "transfer-encoding": "chunked",
        },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.once("error", reject);
    request.write("x".repeat(600));
    request.end("y".repeat(600));
  });
}

describe("HealthServer work notification receiver", () => {
  let server: HealthServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  async function start(options: { readonly enabled?: boolean } = {}) {
    const workAvailability = new WorkAvailability();
    const notify = vi.spyOn(workAvailability, "notify");
    server = new HealthServer({
      metrics: new ProvisionerMetrics(),
      ...(options.enabled === false ? {} : { workAvailability, workNotificationToken: token }),
      port: 0,
      host: "127.0.0.1",
      isLive: () => true,
      isReady: () => true,
    });
    await server.start();
    const address = server.address;
    if (address === null || typeof address === "string") throw new Error("server did not bind TCP");
    return {
      notify,
      post: (body: string, authorization = `Bearer ${token}`) =>
        fetch(`http://127.0.0.1:${address.port}/internal/work-available`, {
          method: "POST",
          headers: {
            authorization,
            "content-type": "application/json",
          },
          body,
        }),
    };
  }

  it("accepts only an authenticated operation notification and signals the local worker", async () => {
    const h = await start();

    const response = await h.post('{"version":1,"kind":"operation"}');

    expect(response.status).toBe(202);
    expect(h.notify).toHaveBeenCalledOnce();
  });

  it("rejects wrong credentials, other work kinds, and oversized bodies", async () => {
    const h = await start();

    const wrongToken = await h.post('{"version":1,"kind":"operation"}', "Bearer wrong");
    const wrongKind = await h.post('{"version":1,"kind":"build"}');
    const oversized = await h.post("x".repeat(1_025));
    const address = server?.address;
    if (address === null || address === undefined || typeof address === "string")
      throw new Error("server did not bind TCP");
    const oversizedChunked = await postChunked(address.port);

    expect(wrongToken.status).toBe(401);
    expect(wrongKind.status).toBe(400);
    expect(oversized.status).toBe(413);
    expect(oversizedChunked).toBe(413);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("keeps the receiver unavailable when notification is not configured", async () => {
    const h = await start({ enabled: false });

    const response = await h.post('{"version":1,"kind":"operation"}');

    expect(response.status).toBe(404);
    expect(h.notify).not.toHaveBeenCalled();
  });
});
