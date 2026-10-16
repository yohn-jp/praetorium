import { describe, expect, it, vi } from "vitest";
import { ControlPlaneError, createControlPlaneClient } from "../src/adapters/control-plane-client.js";

const snapshot = {
  binding: {
    repositoryId: 41,
    instanceId: "ins_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    installationId: 52,
    owner: "praetorium",
    name: "workspace",
    authorizationRevision: 3,
    bindingEpoch: 4,
    suspended: false,
  },
  instance: {
    instanceId: "ins_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    repositoryId: 41,
    generation: 2,
    runtimeEpoch: 5,
    desiredState: "running",
    policy: "stable",
    observedGeneration: 2,
    currentArtifactDigest: "sha256:current",
    desiredArtifactDigest: "sha256:desired",
    observedState: "ready",
    observedRuntimeEpoch: 5,
    observedSequence: 9,
    desiredRevisionId: null,
    observedRevisionId: null,
    reservationState: "reserved",
    reservationId: "reservation-1",
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_001,
  },
} as const;
const digest = `sha256:${"a".repeat(64)}`;
const runtimeMetadata = {
  contractVersion: "scriptorium-platform/v1",
  producerRevision: "a".repeat(40),
  listener: { port: 8080 },
  paths: {
    liveness: "/healthz",
    readiness: "/readyz",
    metadata: "/metadata",
    shutdown: "/shutdown",
    status: "/api/platform/v1/status",
    quiesce: "/api/platform/v1/quiesce",
    resume: "/api/platform/v1/resume",
  },
  shutdownTimeoutSeconds: 30,
};
const configurationSelection = {
  releaseId: "release-1",
  requestedModules: [],
  resourceProfileId: "balanced",
  policy: "stable",
};
const configurationRevision = {
  revisionId: "revision-1",
  instanceId: snapshot.instance.instanceId,
  repositoryId: 41,
  generation: 3,
  buildKey: digest,
  buildId: "build-1",
  selection: configurationSelection,
  resources: { cpuMilli: 1000, memoryMiB: 2048, ephemeralStorageMiB: 1024 },
  runtimeMetadata,
  resolvedModules: [],
  artifactDigest: null,
  status: "building",
  actorId: "12345",
  createdAt: 1_800_000_000_000,
};
const buildInput = {
  contractVersion: "scriptorium-build/v1",
  producerRevision: "a".repeat(40),
  runtimeBaseDigest: digest,
  buildKitDigest: digest,
  recipeDigest: digest,
  sourceDigest: digest,
  lockDigest: digest,
  requestedModules: [],
  resolvedModules: [],
  platform: "linux/amd64",
  options: {},
};

function client(fetchImpl: (request: Request) => Promise<Response>) {
  const binding = {
    fetch(input: RequestInfo | URL, init?: RequestInit) {
      return fetchImpl(input instanceof Request ? input : new Request(input, init));
    },
  };
  return createControlPlaneClient(binding as unknown as Fetcher, "c".repeat(48));
}

describe("Control Plane service client", () => {
  it("sends Gateway service authority and parses the frozen snapshot schema", async () => {
    const fetch = vi.fn(async (request: Request) => {
      expect(request.url).toBe("https://control-plane.internal/v1/repositories/41");
      return Response.json(snapshot);
    });
    const controlPlane = client(fetch);

    await expect(controlPlane.getByRepositoryId(41)).resolves.toEqual(snapshot);
    expect(fetch).toHaveBeenCalledOnce();
    const request = fetch.mock.calls[0]?.[0];
    expect(request?.url).toBe("https://control-plane.internal/v1/repositories/41");
    expect(request?.headers.get("X-Control-Plane-Gateway-Auth")).toBe("c".repeat(48));
  });

  it("sends only the authority-scoped resolve and desired-state metadata", async () => {
    const calls: Request[] = [];
    const fetch = async (request: Request) => {
      calls.push(request);
      const body = request.method === "POST"
        ? request.url.endsWith("/resolve")
          ? { ...snapshot, created: true }
          : { ...snapshot, operation: null, replayed: false }
        : snapshot;
      return Response.json(body);
    };
    const controlPlane = client(fetch);

    await expect(controlPlane.resolveRepository({
      repositoryId: 41,
      installationId: 52,
      owner: "praetorium",
      name: "workspace",
      authorizationRevision: 3,
      bindingEpoch: 4,
      actorId: "12345",
      idempotencyKey: "entry-key",
      requestId: "request-1",
      now: 1_800_000_000_000,
    })).resolves.toMatchObject({ created: true, binding: snapshot.binding });

    await controlPlane.requestDesiredState(snapshot.instance.instanceId, {
      actorId: "12345",
      expectedGeneration: 2,
      desiredState: "running",
      idempotencyKey: "wake-key",
      bindingEpoch: 4,
      authorizationRevision: 3,
      requestId: "request-2",
      now: 1_800_000_000_002,
    });

    expect(calls.map((request) => new URL(request.url).pathname)).toEqual([
      "/v1/repositories/resolve",
      `/v1/instances/${snapshot.instance.instanceId}/desired`,
    ]);
    expect(calls.map((request) => request.headers.get("X-Request-Id"))).toEqual(["request-1", "request-2"]);
    expect(await calls[0]?.json()).toEqual({
      repositoryId: 41,
      installationId: 52,
      owner: "praetorium",
      name: "workspace",
      authorizationRevision: 3,
      bindingEpoch: 4,
      actorId: "12345",
      idempotencyKey: "entry-key",
    });
    expect(await calls[1]?.json()).toEqual({
      actorId: "12345",
      expectedGeneration: 2,
      desiredState: "running",
      idempotencyKey: "wake-key",
      bindingEpoch: 4,
      authorizationRevision: 3,
    });
  });

  it("maps 404 to no binding and rejects malformed successful projections", async () => {
    const missing = client(async () => Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 }));
    await expect(missing.getByRepositoryId(404)).resolves.toBeNull();

    const malformed = client(async () => Response.json({ ...snapshot, actorId: "untrusted-extra" }));
    await expect(malformed.getByRepositoryId(41)).rejects.toThrow();
  });

  it("loads only canonical management projections from the authenticated Control Plane", async () => {
    const dashboard = {
      snapshot,
      current: null,
      desired: null,
      build: null,
      operations: [],
      releases: [],
      resourceLimits: null,
    };
    const operation = {
      id: "operation-1",
      instanceId: snapshot.instance.instanceId,
      generation: 2,
      runtimeEpoch: 5,
      kind: "update",
      status: "running",
      phase: "building",
      attempt: 1,
      createdAt: 1_800_000_000_000,
      updatedAt: 1_800_000_000_001,
    };
    const calls: Request[] = [];
    const controlPlane = client(async (request) => {
      calls.push(request);
      if (request.url.endsWith("/dashboard")) return Response.json(dashboard);
      if (request.url.endsWith("/v1/releases")) return Response.json({ releases: [] });
      return Response.json(operation);
    });

    await expect(controlPlane.getDashboard(snapshot.instance.instanceId)).resolves.toEqual(dashboard);
    await expect(controlPlane.listReleases()).resolves.toEqual([]);
    await expect(controlPlane.getOperation(operation.id)).resolves.toEqual(operation);

    expect(calls.map((request) => new URL(request.url).pathname)).toEqual([
      `/v1/instances/${snapshot.instance.instanceId}/dashboard`,
      "/v1/releases",
      `/v1/operations/${operation.id}`,
    ]);
    expect(calls.every((request) => request.headers.get("X-Control-Plane-Gateway-Auth") === "c".repeat(48))).toBe(true);
  });

  it("uses bounded configuration endpoints and binds plan idempotency in headers", async () => {
    const calls: Request[] = [];
    const configurationSnapshot = {
      binding: {
        repositoryId: 41,
        instanceId: snapshot.instance.instanceId,
        bindingEpoch: 4,
        authorizationRevision: 3,
        suspended: false,
      },
      instance: snapshot.instance,
      revision: configurationRevision,
    };
    const preview = {
      buildInput,
      resources: configurationRevision.resources,
      runtimeMetadata,
      buildKey: digest,
      requestedModules: [],
      resolvedModules: [],
    };
    const plan = {
      instance: snapshot.instance,
      revision: configurationRevision,
      operation: null,
      buildId: "build-1",
      buildKey: digest,
      replayed: false,
    };
    const controlPlane = client(async (request) => {
      calls.push(request);
      if (request.method === "GET") return Response.json(configurationSnapshot);
      if (request.url.endsWith("/preview")) return Response.json(preview);
      return Response.json(plan);
    });

    await expect(controlPlane.getConfiguration(snapshot.instance.instanceId)).resolves.toEqual(configurationSnapshot);
    await expect(controlPlane.previewConfiguration(snapshot.instance.instanceId, {
      bindingEpoch: 4,
      authorizationRevision: 3,
      expectedGeneration: 2,
      selection: configurationSelection,
    })).resolves.toEqual(preview);
    await expect(controlPlane.planConfiguration(snapshot.instance.instanceId, {
      actorId: "12345",
      bindingEpoch: 4,
      authorizationRevision: 3,
      expectedGeneration: 2,
      selection: configurationSelection,
      idempotencyKey: "plan-key-1234567890",
      requestId: "request-3",
    })).resolves.toEqual(plan);

    expect(calls.map((request) => new URL(request.url).pathname)).toEqual([
      `/v1/instances/${snapshot.instance.instanceId}/configuration`,
      `/v1/instances/${snapshot.instance.instanceId}/configuration/preview`,
      `/v1/instances/${snapshot.instance.instanceId}/configuration`,
    ]);
    expect(calls[1]?.headers.get("X-Control-Plane-Gateway-Auth")).toBe("c".repeat(48));
    expect(await calls[1]?.json()).toEqual({
      bindingEpoch: 4,
      authorizationRevision: 3,
      expectedGeneration: 2,
      selection: configurationSelection,
    });
    expect(calls[2]?.headers.get("Idempotency-Key")).toBe("plan-key-1234567890");
    expect(calls[2]?.headers.get("X-Request-Id")).toBe("request-3");
    expect(await calls[2]?.json()).toEqual({
      actorId: "12345",
      bindingEpoch: 4,
      authorizationRevision: 3,
      expectedGeneration: 2,
      selection: configurationSelection,
    });
  });

  it("preserves the upstream error code and status without leaking response bodies", async () => {
    const unavailable = client(async () => Response.json({ error: { code: "BINDING_CONFLICT" } }, { status: 409 }));

    const error = await unavailable.getByRepositoryId(41).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ControlPlaneError);
    expect(error).toMatchObject({ status: 409, code: "BINDING_CONFLICT" });
    expect((error as Error).message).not.toContain("secret");
  });
});
