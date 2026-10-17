import { describe, expect, it, vi } from "vitest";
import type { BuildClaim, BuildInput } from "@praetorium/contracts";
import type { BuildQueuePort } from "@praetorium/application/builds";
import { createBuildRoutes } from "./build-routes.js";

const TOKEN = "build-worker-service-token-0123456789";
const KEY = `sha256:${"a".repeat(64)}`;
const BUILD_INPUT: BuildInput = {
  contractVersion: "scriptorium-build/v1",
  producerRevision: "a".repeat(40),
  runtimeBaseDigest: KEY,
  buildKitDigest: KEY,
  recipeDigest: KEY,
  sourceDigest: KEY,
  lockDigest: KEY,
  requestedModules: [],
  resolvedModules: [],
  platform: "linux/amd64",
  options: {},
};

function claim(): BuildClaim {
  return {
    buildId: "build-1",
    buildKey: KEY,
    input: BUILD_INPUT,
    attemptId: "attempt-1",
    attempt: 1,
    leaseEpoch: 1,
    leaseToken: "lease-token-012345678901234567890123",
    leaseExpiresAt: 1_900_000_000_000,
  };
}

function request(
  path: string,
  body: unknown,
  options: { token?: string; method?: string } = {},
): Request {
  return new Request(`https://control-plane.internal${path}`, {
    method: options.method ?? "POST",
    headers: {
      "content-type": "application/json",
      ...(options.token === undefined
        ? { authorization: `Bearer ${TOKEN}` }
        : { authorization: options.token }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function queue(): BuildQueuePort {
  return {
    claimNext: vi.fn(async () => claim()),
    heartbeat: vi.fn(async () => ({
      accepted: false,
      cancelRequested: false,
      leaseExpiresAt: null,
    })),
    report: vi.fn(async () => ({ accepted: true, duplicate: false })),
  };
}

describe("Control Plane build routes", () => {
  it("claims with the worker contract and returns no work as 204", async () => {
    const buildQueue = queue();
    const routes = createBuildRoutes({ queue: buildQueue, serviceToken: TOKEN, now: () => 42 });
    const response = await routes.fetch(
      request("/internal/builds/claim", { workerId: "worker-1", leaseSeconds: 90 }),
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual(claim());
    expect(buildQueue.claimNext).toHaveBeenCalledWith({
      workerId: "worker-1",
      leaseSeconds: 90,
      now: 42,
    });

    vi.mocked(buildQueue.claimNext).mockResolvedValueOnce(null);
    const empty = await routes.fetch(
      request("/internal/builds/claim", { workerId: "worker-1", leaseSeconds: 90 }),
    );
    expect(empty?.status).toBe(204);
    expect(await empty?.text()).toBe("");
  });

  it("passes heartbeat leases and preserves accepted false as a successful response", async () => {
    const buildQueue = queue();
    const routes = createBuildRoutes({ queue: buildQueue, serviceToken: TOKEN, now: () => 123 });
    const body = {
      buildId: "build-1",
      attemptId: "attempt-1",
      leaseEpoch: 1,
      leaseToken: "lease-token-012345678901234567890123",
      workerId: "worker-1",
      sequence: 1,
      leaseSeconds: 90,
      progress: { stage: "building", percent: 25 },
    };
    const response = await routes.fetch(request("/internal/builds/build-1/heartbeat", body));

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      accepted: false,
      cancelRequested: false,
      leaseExpiresAt: null,
    });
    expect(buildQueue.heartbeat).toHaveBeenCalledWith({ ...body, now: 123 });
    const mismatch = await routes.fetch(request("/internal/builds/other/heartbeat", body));
    expect(mismatch?.status).toBe(400);
    expect(buildQueue.heartbeat).toHaveBeenCalledOnce();
  });

  it("reports bounded failures and rejects malformed, oversized, or unauthenticated calls", async () => {
    const buildQueue = queue();
    const routes = createBuildRoutes({ queue: buildQueue, serviceToken: TOKEN, now: () => 123 });
    const failure = {
      buildId: "build-1",
      buildKey: KEY,
      attemptId: "attempt-1",
      leaseEpoch: 1,
      leaseToken: "lease-token-012345678901234567890123",
      workerId: "worker-1",
      sequence: 1,
      result: { kind: "failed", code: "BUILD_FAILED", message: "recipe failed", retryable: true },
    };
    const response = await routes.fetch(request("/internal/builds/build-1/report", failure));
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ accepted: true, duplicate: false });
    expect(buildQueue.report).toHaveBeenCalledWith({ ...failure, now: 123 });

    const unauthorized = await routes.fetch(
      request(
        "/internal/builds/claim",
        { workerId: "w", leaseSeconds: 90 },
        { token: "Bearer wrong" },
      ),
    );
    expect(unauthorized?.status).toBe(401);
    const malformed = await routes.fetch(
      request("/internal/builds/claim", { workerId: "worker-1", leaseSeconds: 90, extra: true }),
    );
    expect(malformed?.status).toBe(400);
    const tooLarge = await routes.fetch(
      new Request("https://control-plane.internal/internal/builds/claim", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: `{"value":"${"x".repeat(1_048_577)}"}`,
      }),
    );
    expect(tooLarge?.status).toBe(413);
    expect(await tooLarge?.json()).toEqual({ error: { code: "REQUEST_TOO_LARGE" } });
    expect(buildQueue.report).toHaveBeenCalledOnce();
  });

  it("hints only after an accepted terminal report can release runnable work", async () => {
    const buildQueue = queue();
    const notifications: string[] = [];
    const notifyWorkAvailable = vi.fn(async (kind: "build" | "operation") => {
      notifications.push(kind);
    });
    const routes = createBuildRoutes({
      queue: buildQueue,
      serviceToken: TOKEN,
      notifyWorkAvailable,
    });
    const pending: Promise<unknown>[] = [];
    const context = {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
      passThroughOnException() {},
      props: {},
    };
    const succeeded = {
      buildId: "build-1",
      buildKey: KEY,
      attemptId: "attempt-1",
      leaseEpoch: 1,
      leaseToken: "lease-token-012345678901234567890123",
      workerId: "worker-1",
      sequence: 1,
      result: {
        kind: "succeeded",
        candidateRef: `ghcr.io/example/runtime@${KEY}`,
        manifestDigest: KEY,
        compositionManifest: { repository: "ghcr.io/example/composition", digest: KEY },
        statement: {
          schemaVersion: "praetorium.build-artifact/v1",
          buildKey: KEY,
          artifact: {
            repository: "example/runtime",
            digest: KEY,
            platformManifestDigest: KEY,
            platform: "linux/amd64",
          },
          compositionManifest: { repository: "ghcr.io/example/composition", digest: KEY },
          producerRevision: "a".repeat(40),
          resolvedModules: [],
          contractVersion: "scriptorium-build/v1",
          issuedAt: "2026-01-01T00:00:00.000Z",
        },
        signature: { algorithm: "Ed25519", keyId: "key-1", signature: "AA==" },
      },
    };
    const accepted = await routes.fetch(
      request("/internal/builds/build-1/report", succeeded),
      {},
      context,
    );

    expect(accepted.status).toBe(200);
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(notifications).toEqual(["operation"]);

    vi.mocked(buildQueue.report).mockResolvedValueOnce({ accepted: false, duplicate: false });
    const rejected = await routes.fetch(
      request("/internal/builds/build-1/report", {
        ...succeeded,
        result: { kind: "failed", code: "BUILD_FAILED", message: "rejected", retryable: true },
      }),
      {},
      context,
    );
    expect(rejected.status).toBe(200);
    expect(pending).toHaveLength(1);
    expect(notifyWorkAvailable).toHaveBeenCalledOnce();
  });

  it("keeps unmatched paths out of the build API and rejects non-POST worker calls", async () => {
    const routes = createBuildRoutes({ queue: queue(), serviceToken: TOKEN });
    const other = await routes.fetch(request("/v1/instances/one/configuration", undefined));
    expect(other.status).toBe(404);
    const method = await routes.fetch(
      request("/internal/builds/claim", undefined, { method: "GET" }),
    );
    expect(method.status).toBe(405);
  });
});
