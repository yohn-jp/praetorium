import { describe, expect, it } from "vitest";
import {
  OperationServiceHttpClient,
} from "./operation-client.js";

const resources = { cpuMilli: 500, memoryMiB: 512, ephemeralStorageMiB: 256 };

function claimBody(overrides: Record<string, unknown> = {}) {
  return {
    operation: {
      id: "op_01",
      instanceId: "ins_01",
      repositoryId: 123456,
      generation: 2,
      runtimeEpoch: 5,
      kind: "redeploy",
      status: "claimed",
      attempt: 1,
      leaseEpoch: 1,
      leaseToken: "opaque-lease-token",
      leaseExpiresAt: 1_900_000_000_000,
      reportSequence: 0,
      phase: "accepted",
      checkpointSequence: 0,
      checkpoint: null,
      clusterId: "cluster-a",
      reservationId: null,
      deploymentRevisionId: "rev_01",
      buildId: "build_01",
      prerequisiteBuildId: null,
    },
    snapshot: {
      binding: {
        repositoryId: 123456,
        instanceId: "ins_01",
        installationId: 42,
        owner: "owner",
        name: "repository",
        authorizationRevision: 3,
        bindingEpoch: 1,
        suspended: false,
      },
      instance: {
        instanceId: "ins_01",
        repositoryId: 123456,
        generation: 2,
        runtimeEpoch: 5,
        desiredState: "running",
        observedState: "stopped",
        observedGeneration: 1,
        observedRuntimeEpoch: 4,
        observedRevisionId: "rev_old",
        desiredRevisionId: "rev_01",
        currentArtifactDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        desiredArtifactDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
    },
    reservation: null,
    deploymentRevision: null,
    ...overrides,
  };
}

function client(fetch: typeof globalThis.fetch) {
  return new OperationServiceHttpClient({
    baseUrl: "https://control.example.test",
    credential: "provisioner-service-secret",
    fetch,
  });
}

describe("OperationServiceHttpClient", () => {
  it("claims through the authenticated internal API and validates identity", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const service = client(async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return Response.json(claimBody());
    });

    const claim = await service.claimNext({ workerId: "worker-a", clusterId: "cluster-a", leaseSeconds: 30 });

    expect(requestUrl).toBe("https://control.example.test/internal/provisioner/claim");
    expect(requestInit?.method).toBe("POST");
    expect(new Headers(requestInit?.headers).get("authorization")).toBe("Bearer provisioner-service-secret");
    expect(JSON.parse(String(requestInit?.body))).toEqual({ workerId: "worker-a", clusterId: "cluster-a", leaseSeconds: 30 });
    expect(claim?.operation).toMatchObject({ id: "op_01", leaseEpoch: 1, runtimeEpoch: 5, clusterId: "cluster-a" });
    expect(claim?.snapshot.binding.suspended).toBe(false);
  });

  it("rejects a claimed response whose operation, binding and instance identities diverge", async () => {
    const body = claimBody({
      operation: { ...(claimBody() as { operation: Record<string, unknown> }).operation, repositoryId: 987654 },
    });
    const service = client(async () => Response.json(body));

    await expect(service.claimNext({ workerId: "worker-a", clusterId: "cluster-a", leaseSeconds: 30 }))
      .rejects.toThrow("claimed operation identity is inconsistent");
  });

  it("records complete capacity evidence and parses the monotonic epoch", async () => {
    let path = "";
    let body: unknown;
    const service = client(async (input, init) => {
      path = String(input);
      body = JSON.parse(String(init?.body));
      return Response.json({ capacityEpoch: 12 });
    });

    const epoch = await service.recordCapacitySnapshot({
      clusterId: "cluster-a",
      observedAt: 1_800_000_000_000,
      complete: true,
      capacity: {
        allocatable: resources,
        requested: { cpuMilli: 250, memoryMiB: 256, ephemeralStorageMiB: 128 },
        nodeResourceVersion: "node-rv-3",
        podResourceVersion: "pod-rv-8",
      },
      representedReservationIds: ["res_01"],
    });

    expect(path).toBe("https://control.example.test/internal/provisioner/capacity/record");
    expect(epoch).toBe(12);
    expect(body).toMatchObject({ clusterId: "cluster-a", complete: true, representedReservationIds: ["res_01"] });
  });

  it("maps capacity conflicts to bounded non-retryable service errors", async () => {
    const service = client(async () => Response.json(
      { error: { code: "CAPACITY_UNAVAILABLE" } },
      { status: 409 },
    ));

    await expect(service.reserveRuntime({
      operationId: "op_01",
      workerId: "worker-a",
      leaseToken: "opaque-lease-token",
      leaseEpoch: 1,
      expectedRuntimeEpoch: 5,
      clusterId: "cluster-a",
      expectedCapacityEpoch: 12,
      resources,
      reservationId: "res_02",
    })).rejects.toMatchObject({
      code: "capacity_unavailable",
      status: 409,
      retryable: false,
    });
  });

  it("refuses non-TLS remote Control Plane endpoints and header injection", () => {
    expect(() => new OperationServiceHttpClient({ baseUrl: "http://control.example.test", credential: "secret" }))
      .toThrow("HTTPS outside localhost");
    expect(() => new OperationServiceHttpClient({ baseUrl: "https://control.example.test", credential: "bad\r\nvalue" }))
      .toThrow("credential is invalid");
  });
});
