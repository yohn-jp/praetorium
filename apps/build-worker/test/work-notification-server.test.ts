import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { WorkAvailability } from "@praetorium/application";
import { BuildWorkerService } from "@praetorium/application/builds";
import type { BuildQueuePort } from "@praetorium/application/builds";
import {
  closeBuildWorkNotificationServer,
  startBuildWorkNotificationServer,
} from "../src/work-notification-server.js";

const token = "build-notification-token".padEnd(48, "x");
const servers: Array<Awaited<ReturnType<typeof startBuildWorkNotificationServer>>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeBuildWorkNotificationServer));
});

describe("build work notification listener", () => {
  it("requires the dedicated bearer, rejects other kinds and oversized bodies, and accepts a build hint", async () => {
    const availability = new WorkAvailability();
    const server = await startBuildWorkNotificationServer(
      { notificationHost: "127.0.0.1", notificationPort: 0, notificationToken: token },
      availability,
    );
    servers.push(server);
    const address = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}/internal/work-available`;
    const json = { "content-type": "application/json" };

    const unauthorized = await fetch(url, {
      method: "POST",
      headers: { ...json, authorization: `Bearer ${"w".repeat(48)}` },
      body: JSON.stringify({ version: 1, kind: "build" }),
    });
    expect(unauthorized.status).toBe(401);

    const wrongKind = await fetch(url, {
      method: "POST",
      headers: { ...json, authorization: `Bearer ${token}` },
      body: JSON.stringify({ version: 1, kind: "operation" }),
    });
    expect(wrongKind.status).toBe(422);

    const oversized = await fetch(url, {
      method: "POST",
      headers: { ...json, authorization: `Bearer ${token}` },
      body: "x".repeat(1025),
    });
    expect(oversized.status).toBe(413);

    const notification = await fetch(url, {
      method: "POST",
      headers: { ...json, authorization: `Bearer ${token}` },
      body: JSON.stringify({ version: 1, kind: "build" }),
    });
    expect(notification.status).toBe(202);

    const startedAt = performance.now();
    const shutdown = new AbortController();
    await availability.wait(shutdown.signal, 1000);
    expect(performance.now() - startedAt).toBeLessThan(500);
    shutdown.abort();
  });

  it("coalesces duplicate accepted notifications into one pending hint", async () => {
    const availability = new WorkAvailability();
    const server = await startBuildWorkNotificationServer(
      { notificationHost: "127.0.0.1", notificationPort: 0, notificationToken: token },
      availability,
    );
    servers.push(server);
    const address = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}/internal/work-available`;
    const send = (): Promise<Response> =>
      fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ version: 1, kind: "build" }),
      });

    const responses = await Promise.all([send(), send()]);
    expect(responses.map((response) => response.status)).toEqual([202, 202]);

    const controller = new AbortController();
    const firstWaitStartedAt = performance.now();
    await availability.wait(controller.signal, 100);
    expect(performance.now() - firstWaitStartedAt).toBeLessThan(50);
    const secondWaitStartedAt = performance.now();
    await availability.wait(controller.signal, 50);
    expect(performance.now() - secondWaitStartedAt).toBeGreaterThanOrEqual(25);
    controller.abort();
  });

  it("claims immediately at startup and claims again after the authenticated webhook wakes it", async () => {
    const availability = new WorkAvailability();
    const server = await startBuildWorkNotificationServer(
      { notificationHost: "127.0.0.1", notificationPort: 0, notificationToken: token },
      availability,
    );
    servers.push(server);
    const address = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}/internal/work-available`;
    const shutdown = new AbortController();
    let claims = 0;
    const queue: BuildQueuePort = {
      claimNext: vi.fn(async () => {
        claims++;
        if (claims === 2) shutdown.abort();
        return null;
      }),
      heartbeat: vi.fn(async () => ({
        accepted: true,
        cancelRequested: false,
        leaseExpiresAt: Date.now() + 60_000,
      })),
      report: vi.fn(async () => ({ accepted: true, duplicate: false })),
    };
    const worker = new BuildWorkerService(
      queue,
      { execute: async () => { throw new Error("Unexpected build execution"); } },
      { attest: async () => { throw new Error("Unexpected build attestation"); } },
      {
        workerId: "worker-1",
        leaseSeconds: 60,
        heartbeatIntervalMs: 30_000,
        workAvailability: availability,
      },
    );

    const running = worker.runUntilStopped(shutdown.signal, 300_000);
    await vi.waitFor(() => expect(queue.claimNext).toHaveBeenCalledOnce());
    expect(claims).toBe(1);

    const notification = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ version: 1, kind: "build" }),
    });
    expect(notification.status).toBe(202);
    await running;

    expect(queue.claimNext).toHaveBeenCalledTimes(2);
    expect(claims).toBe(2);
  });
});
