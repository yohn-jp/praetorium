import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoordinationConfig } from "../src/config.js";
import { loadCoordinationConfig } from "../src/config.js";
import { closeCoordinationServer, startCoordinationServer } from "../src/notification-relay.js";

const operationToken = "provisioner-notification-token-000000000000";
const buildToken = "build-notification-token-00000000000000";

const targets: CoordinationConfig["targets"] = {
  operation: {
    url: "http://127.0.0.1:8080/internal/work-available",
    token: operationToken,
  },
  build: {
    url: "http://127.0.0.1:8788/internal/work-available",
    token: buildToken,
  },
};

const servers: Array<Awaited<ReturnType<typeof startCoordinationServer>>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeCoordinationServer(server)));
});

async function start(fetcher: typeof fetch = fetch): Promise<string> {
  const server = await startCoordinationServer({ host: "127.0.0.1", port: 0, targets }, fetcher);
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

function notificationRequest(token: string, body: unknown): RequestInit {
  return {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

describe("Coordination work notification relay", () => {
  it("dispatches each hint once to its configured target using the target credential", async () => {
    const dispatched: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      dispatched.push({ input, init });
      return new Response(null, { status: 202 });
    };
    const base = await start(fetcher);

    const buildResponse = await fetch(
      `${base}/internal/work-available`,
      notificationRequest(buildToken, { version: 1, kind: "build" }),
    );
    const operationResponse = await fetch(
      `${base}/internal/work-available`,
      notificationRequest(operationToken, {
        version: 1,
        kind: "operation",
        instanceId: "12345",
      }),
    );

    expect(buildResponse.status).toBe(202);
    expect(operationResponse.status).toBe(202);
    expect(dispatched).toHaveLength(2);
    expect(dispatched.map(({ input }) => input)).toEqual([
      targets.build.url,
      targets.operation.url,
    ]);
    expect(dispatched.map(({ init }) => init?.headers)).toEqual([
      { Authorization: `Bearer ${buildToken}`, "Content-Type": "application/json" },
      { Authorization: `Bearer ${operationToken}`, "Content-Type": "application/json" },
    ]);
    expect(dispatched.map(({ init }) => init?.body)).toEqual([
      JSON.stringify({ version: 1, kind: "build" }),
      JSON.stringify({ version: 1, kind: "operation", instanceId: "12345" }),
    ]);
    expect(dispatched.every(({ init }) => init?.redirect === "manual")).toBe(true);
  });

  it("returns healthy diagnostics without probing downstream workers", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const base = await start(fetcher);

    const live = await fetch(`${base}/healthz`);
    const ready = await fetch(`${base}/readyz`);

    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: "ok" });
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: "ready" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated, invalid, and oversized notifications without dispatch", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const base = await start(fetcher);

    const unauthorized = await fetch(
      `${base}/internal/work-available`,
      notificationRequest("wrong-notification-token-00000000000", {
        version: 1,
        kind: "build",
      }),
    );
    const malformed = await fetch(
      `${base}/internal/work-available`,
      notificationRequest(buildToken, { version: 1, kind: "build", extra: true }),
    );
    const oversized = await fetch(`${base}/internal/work-available`, {
      ...notificationRequest(buildToken, { version: 1, kind: "build" }),
      body: JSON.stringify({ version: 1, kind: "build", padding: "x".repeat(2_000) }),
    });

    expect(unauthorized.status).toBe(401);
    expect(malformed.status).toBe(400);
    expect(oversized.status).toBe(413);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("requires the existing per-kind credential to match the notification kind", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const base = await start(fetcher);

    const response = await fetch(
      `${base}/internal/work-available`,
      notificationRequest(buildToken, { version: 1, kind: "operation" }),
    );

    expect(response.status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports downstream failures without changing durable state or retrying", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }));
    const base = await start(fetcher);

    const response = await fetch(
      `${base}/internal/work-available`,
      notificationRequest(operationToken, { version: 1, kind: "operation" }),
    );

    expect(response.status).toBe(503);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("bounds dispatch time and returns an unavailable response after timeout", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error("dispatch timeout signal is missing"));
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const base = await start(fetcher);

    const response = await fetch(
      `${base}/internal/work-available`,
      notificationRequest(buildToken, { version: 1, kind: "build" }),
    );

    expect(response.status).toBe(503);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});

describe("Coordination configuration", () => {
  const environment = {
    PRAETORIUM_COORDINATION_PROVISIONER_NOTIFICATION_URL:
      "http://runtime.internal:8080/internal/work-available",
    PRAETORIUM_COORDINATION_PROVISIONER_NOTIFICATION_TOKEN_FILE: "/run/secrets/provisioner",
    PRAETORIUM_COORDINATION_BUILD_NOTIFICATION_URL:
      "https://builder.internal/internal/work-available",
    PRAETORIUM_COORDINATION_BUILD_NOTIFICATION_TOKEN_FILE: "/run/secrets/build",
  };

  it("loads the existing per-kind credentials with a container listener default", async () => {
    const config = await loadCoordinationConfig(environment, async (filePath) => {
      if (filePath.endsWith("provisioner")) return operationToken;
      return buildToken;
    });

    expect(config).toEqual({
      host: "0.0.0.0",
      port: 8789,
      targets: {
        operation: {
          url: "http://runtime.internal:8080/internal/work-available",
          token: operationToken,
        },
        build: {
          url: "https://builder.internal/internal/work-available",
          token: buildToken,
        },
      },
    });
  });

  it("rejects credentials reused between provisioner and build notifications", async () => {
    await expect(loadCoordinationConfig(environment, async () => operationToken)).rejects.toThrow(
      "provisioner and build notification credentials must be distinct",
    );
  });
});
