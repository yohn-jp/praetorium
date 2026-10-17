import { describe, expect, it } from "vitest";
import { OperationServiceHttpClient } from "./operation-client.js";

const resources = { cpuMilli: 500, memoryMiB: 512, ephemeralStorageMiB: 256 };

const metadata = {
  contractVersion: "scriptorium-platform/v1",
  producerRevision: "a".repeat(40),
  listener: { port: 3000 },
  paths: {
    liveness: "/health/live",
    readiness: "/health/ready",
    metadata: "/api/platform/v1/metadata",
    shutdown: "/shutdown",
    status: "/api/platform/v1/status",
    quiesce: "/api/platform/v1/quiesce",
    resume: "/api/platform/v1/resume",
  },
  shutdownTimeoutSeconds: 30,
};

function resolvedRuntime(revisionId: string, epoch: number, digest: string) {
  return {
    revisionId,
    artifactRef: `ghcr.io/example/scriptorium@${digest}`,
    platformManifestDigest: `sha256:${"d".repeat(64)}`,
    resourceProfileId: "small",
    hostname: "instance.example.test",
    resources,
    assignment: {
      contractVersion: "scriptorium-platform/v1",
      instanceId: "ins_01",
      repositoryId: 123456,
      repositoryLocator: "https://github.com/owner/repository",
      defaultBranchPolicy: "repository-default",
      runtimeEpoch: epoch,
      imageDigest: digest,
      compositionManifestDigest: `sha256:${"c".repeat(64)}`,
      enabledModuleIds: ["core"],
      credentialBrokerLocator: "platform://credential-broker",
      grantPolicy: {
        issuer: "https://platform.example.test",
        jwksUrl: "https://platform.example.test/.well-known/jwks.json",
        audience: "https://instance.example.test",
      },
      controlServicePolicy: {
        issuer: "https://platform.example.test",
        jwksUrl: "https://platform.example.test/.well-known/jwks.json",
        audience: "praetorium-runtime-control",
      },
    },
    metadata,
  };
}

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
        currentArtifactDigest:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        desiredArtifactDigest:
          "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        reservationState: "allocated",
        reservationId: "res_old",
        clusterId: "cluster-a",
      },
    },
    reservation: null,
    currentReservation: {
      reservationId: "res_old",
      instanceId: "ins_01",
      repositoryId: 123456,
      runtimeEpoch: 4,
      generation: 1,
      clusterId: "cluster-a",
      status: "allocated",
      resources,
      capacitySnapshotEpoch: 7,
      createdAt: 1_800_000_000_000,
      updatedAt: 1_800_000_000_100,
    },
    deploymentRevision: {
      revisionId: "rev_01",
      instanceId: "ins_01",
      repositoryId: 123456,
      generation: 2,
      buildKey: "build-key-01",
      buildId: "build_01",
      selection: { modules: ["core"] },
      resources,
      artifactDigest: `sha256:${"b".repeat(64)}`,
      status: "admitted",
    },
    currentDeploymentRevision: null,
    runtimeContext: {
      current: resolvedRuntime("rev_old", 4, `sha256:${"a".repeat(64)}`),
      target: resolvedRuntime("rev_01", 5, `sha256:${"b".repeat(64)}`),
    },
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
  it("uses bounded idle candidate and generation-fenced stop/observation routes", async () => {
    const requests: { path: string; body: Record<string, unknown> }[] = [];
    const service = client(async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ path, body });
      if (path.endsWith("/idle-candidates")) {
        return Response.json({ items: [], nextCursor: "cursor-next" });
      }
      if (path.endsWith("/idle-stop")) return Response.json({ operationId: "op_idle" });
      return Response.json({
        token: "short-lived-observation-token",
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
        operationId: "op_observation",
      });
    });

    const page = await service.listIdleCandidates({
      workerId: "worker-a",
      clusterId: "cluster-a",
      limit: 25,
      cursor: null,
    });
    const operationId = await service.createIdleStop({
      workerId: "worker-a",
      clusterId: "cluster-a",
      instanceId: "ins_01",
      repositoryId: 123456,
      expectedGeneration: 7,
      expectedRuntimeEpoch: 9,
    });
    const credential = await service.issueObservationCredential({
      workerId: "worker-a",
      clusterId: "cluster-a",
      instanceId: "ins_01",
      repositoryId: 123456,
      expectedGeneration: 7,
      runtimeEpoch: 9,
    });

    expect(page).toEqual({ items: [], nextCursor: "cursor-next" });
    expect(operationId).toBe("op_idle");
    expect(credential.operationId).toBe("op_observation");
    expect(requests).toEqual([
      {
        path: "/internal/provisioner/idle-candidates",
        body: { workerId: "worker-a", clusterId: "cluster-a", limit: 25, cursor: null },
      },
      {
        path: "/internal/provisioner/idle-stop",
        body: {
          workerId: "worker-a",
          clusterId: "cluster-a",
          instanceId: "ins_01",
          repositoryId: 123456,
          expectedGeneration: 7,
          expectedRuntimeEpoch: 9,
        },
      },
      {
        path: "/internal/provisioner/observation-credential",
        body: {
          workerId: "worker-a",
          clusterId: "cluster-a",
          instanceId: "ins_01",
          repositoryId: 123456,
          expectedGeneration: 7,
          runtimeEpoch: 9,
        },
      },
    ]);
  });

  it("parses a typed current-runtime candidate and keeps pagination bounded", async () => {
    const runtime = resolvedRuntime(
      "rev_idle",
      9,
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    const service = client(async () =>
      Response.json({
        items: [
          {
            instanceId: "ins_01",
            repositoryId: 123456,
            generation: 7,
            runtimeEpoch: 9,
            clusterId: "cluster-a",
            desiredState: "running",
            bindingSuspended: false,
            hasActiveOperation: false,
            healthOperationId: null,
            activeCanaryHealth: false,
            healthNextCheckAt: null,
            currentRuntime: runtime,
          },
        ],
        nextCursor: null,
      }),
    );

    const page = await service.listIdleCandidates({
      workerId: "worker-a",
      clusterId: "cluster-a",
      limit: 1,
      cursor: null,
    });

    expect(page.items[0]).toMatchObject({
      instanceId: "ins_01",
      repositoryId: 123456,
      generation: 7,
      runtimeEpoch: 9,
      desiredState: "running",
      currentRuntime: { revisionId: "rev_idle" },
    });
    expect(page.nextCursor).toBeNull();
  });

  it("rejects malformed idle candidates and excessive page bounds", async () => {
    const service = client(async (input) => {
      if (String(input).endsWith("/idle-candidates")) {
        const runtime = resolvedRuntime(
          "rev_idle",
          9,
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        );
        return Response.json({
          items: [
            {
              instanceId: "ins_01",
              repositoryId: 123456,
              generation: 7,
              runtimeEpoch: 9,
              clusterId: "cluster-a",
              desiredState: "running",
              bindingSuspended: false,
              hasActiveOperation: false,
              healthOperationId: null,
              activeCanaryHealth: false,
              healthNextCheckAt: null,
              currentRuntime: {
                ...runtime,
                assignment: { ...runtime.assignment, instanceId: "ins_other" },
              },
            },
          ],
          nextCursor: null,
        });
      }
      return Response.json({});
    });

    await expect(
      service.listIdleCandidates({
        workerId: "worker-a",
        clusterId: "cluster-a",
        limit: 25,
        cursor: null,
      }),
    ).rejects.toThrow("idle candidate current runtime identity mismatch");
    await expect(
      service.listIdleCandidates({
        workerId: "worker-a",
        clusterId: "cluster-a",
        limit: 26,
        cursor: null,
      }),
    ).rejects.toThrow("idle candidate page limit");
  });

  it("claims through the authenticated internal API and validates identity", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const service = client(async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return Response.json(claimBody());
    });

    const claim = await service.claimNext({
      workerId: "worker-a",
      clusterId: "cluster-a",
      leaseSeconds: 30,
    });

    expect(requestUrl).toBe("https://control.example.test/internal/provisioner/claim");
    expect(requestInit?.method).toBe("POST");
    expect(new Headers(requestInit?.headers).get("authorization")).toBe(
      "Bearer provisioner-service-secret",
    );
    expect(JSON.parse(String(requestInit?.body))).toEqual({
      workerId: "worker-a",
      clusterId: "cluster-a",
      leaseSeconds: 30,
    });
    expect(claim?.operation).toMatchObject({
      id: "op_01",
      leaseEpoch: 1,
      runtimeEpoch: 5,
      clusterId: "cluster-a",
    });
    expect(claim?.snapshot.binding.suspended).toBe(false);
  });

  it("accepts the Control Plane's JSON null when its operation queue is empty", async () => {
    const service = client(async () => Response.json(null));

    await expect(
      service.claimNext({ workerId: "worker-a", clusterId: "cluster-a", leaseSeconds: 30 }),
    ).resolves.toBeNull();

    const malformed = client(async () => Response.json({}));
    await expect(
      malformed.claimNext({ workerId: "worker-a", clusterId: "cluster-a", leaseSeconds: 30 }),
    ).rejects.toThrow("invalid claimed operation");
  });

  it("rejects a claimed response whose operation, binding and instance identities diverge", async () => {
    const body = claimBody({
      operation: {
        ...(claimBody() as { operation: Record<string, unknown> }).operation,
        repositoryId: 987654,
      },
    });
    const service = client(async () => Response.json(body));

    await expect(
      service.claimNext({ workerId: "worker-a", clusterId: "cluster-a", leaseSeconds: 30 }),
    ).rejects.toThrow("claimed operation identity is inconsistent");
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
    expect(body).toMatchObject({
      clusterId: "cluster-a",
      complete: true,
      representedReservationIds: ["res_01"],
    });
  });

  it("requests a short-lived control credential bound to the lease, runtime and exact payload digest", async () => {
    let path = "";
    let body: unknown;
    const service = client(async (input, init) => {
      path = String(input);
      body = JSON.parse(String(init?.body));
      return Response.json({
        token: "signed.runtime.control.jwt",
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      });
    });

    const result = await service.issueControlCredential({
      operationId: "op_01",
      workerId: "worker-a",
      leaseToken: "opaque-lease-token",
      leaseEpoch: 7,
      instanceId: "ins_01",
      repositoryId: 123456,
      runtimeEpoch: 9,
      action: "quiesce",
      payloadDigest: `sha256:${"a".repeat(64)}`,
    });

    expect(path).toBe("https://control.example.test/internal/provisioner/control-credential");
    expect(body).toEqual({
      operationId: "op_01",
      workerId: "worker-a",
      leaseToken: "opaque-lease-token",
      leaseEpoch: 7,
      instanceId: "ins_01",
      repositoryId: 123456,
      runtimeEpoch: 9,
      action: "quiesce",
      payloadDigest: `sha256:${"a".repeat(64)}`,
    });
    expect(result).toMatchObject({ token: "signed.runtime.control.jwt" });
  });

  it("keeps progress reports separate from observed runtime state", async () => {
    let body: Record<string, unknown> | undefined;
    const service = client(async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        operation: (claimBody() as { operation: unknown }).operation,
        applied: true,
        duplicate: false,
      });
    });

    await service.report({
      operationId: "op_01",
      workerId: "worker-a",
      leaseToken: "opaque-lease-token",
      leaseEpoch: 1,
      sequence: 4,
      observation: null,
    });

    expect(body).toEqual({
      operationId: "op_01",
      workerId: "worker-a",
      leaseToken: "opaque-lease-token",
      leaseEpoch: 1,
      sequence: 4,
      observation: null,
    });
  });

  it("sends actual observations with their own target epoch and generation", async () => {
    let body: Record<string, unknown> | undefined;
    const service = client(async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        operation: (claimBody() as { operation: unknown }).operation,
        applied: true,
        duplicate: false,
      });
    });

    const observation = {
      instanceId: "ins_01",
      repositoryId: 123456,
      generation: 2,
      runtimeEpoch: 5,
      sequence: 5,
      observedState: "ready",
      observedArtifactDigest: `sha256:${"b".repeat(64)}`,
      observedRevisionId: "rev_01",
      reportedAt: new Date().toISOString(),
    } as const;
    await service.report({
      operationId: "op_01",
      workerId: "worker-a",
      leaseToken: "opaque-lease-token",
      leaseEpoch: 1,
      sequence: 5,
      observation,
      terminal: "succeeded",
    });

    expect(body?.observation).toEqual(observation);
    expect(body).not.toHaveProperty("observation.operationId");
  });

  it("maps capacity conflicts to bounded non-retryable service errors", async () => {
    const service = client(async () =>
      Response.json({ error: { code: "CAPACITY_UNAVAILABLE" } }, { status: 409 }),
    );

    await expect(
      service.reserveRuntime({
        operationId: "op_01",
        workerId: "worker-a",
        leaseToken: "opaque-lease-token",
        leaseEpoch: 1,
        expectedRuntimeEpoch: 5,
        clusterId: "cluster-a",
        expectedCapacityEpoch: 12,
        resources,
        reservationId: "res_02",
      }),
    ).rejects.toMatchObject({
      code: "capacity_unavailable",
      status: 409,
      retryable: false,
    });
  });

  it("uses the exact assignment for the canary health due point query", async () => {
    let request: { path: string; body: Record<string, unknown> } | undefined;
    const service = client(async (input, init) => {
      request = {
        path: new URL(String(input)).pathname,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      };
      return Response.json({
        active: true,
        nextCheckAt: 1_900_000_300_000,
        sampleDueAt: 1_900_000_000_000,
        healthOperationId: "op_canary_health_01",
      });
    });

    const result = await service.runtimeCanaryHealthDue({
      workerId: "worker-a",
      clusterId: "cluster-a",
      instanceId: "ins_01",
      repositoryId: 123456,
      expectedGeneration: 2,
      expectedRuntimeEpoch: 5,
    });

    expect(request).toEqual({
      path: "/internal/provisioner/runtime-health-due",
      body: {
        workerId: "worker-a",
        clusterId: "cluster-a",
        instanceId: "ins_01",
        repositoryId: 123456,
        expectedGeneration: 2,
        expectedRuntimeEpoch: 5,
      },
    });
    expect(result).toEqual({
      active: true,
      nextCheckAt: 1_900_000_300_000,
      sampleDueAt: 1_900_000_000_000,
      healthOperationId: "op_canary_health_01",
    });
  });

  it("parses an explicitly advertised canary health schedule", async () => {
    const service = client(async () =>
      Response.json({
        items: [
          {
            instanceId: "ins_01",
            repositoryId: 123456,
            generation: 2,
            runtimeEpoch: 5,
            clusterId: "cluster-a",
            desiredState: "running",
            bindingSuspended: false,
            hasActiveOperation: false,
            healthOperationId: null,
            activeCanaryHealth: true,
            healthNextCheckAt: 1_900_000_000_000,
            currentRuntime: resolvedRuntime("rev_01", 5, `sha256:${"b".repeat(64)}`),
          },
        ],
        nextCursor: null,
      }),
    );

    const page = await service.listIdleCandidates({
      workerId: "worker-a",
      clusterId: "cluster-a",
      limit: 25,
      cursor: null,
    });

    expect(page.items[0]).toMatchObject({
      activeCanaryHealth: true,
      healthNextCheckAt: 1_900_000_000_000,
    });
  });

  it("rejects inconsistent canary health due hints", async () => {
    const service = client(async () =>
      Response.json({
        active: false,
        nextCheckAt: 1_900_000_300_000,
        sampleDueAt: null,
        healthOperationId: null,
      }),
    );

    await expect(
      service.runtimeCanaryHealthDue({
        workerId: "worker-a",
        clusterId: "cluster-a",
        instanceId: "ins_01",
        repositoryId: 123456,
        expectedGeneration: 2,
        expectedRuntimeEpoch: 5,
      }),
    ).rejects.toThrow();
  });

  it("refuses non-TLS remote Control Plane endpoints and header injection", () => {
    expect(
      () =>
        new OperationServiceHttpClient({
          baseUrl: "http://control.example.test",
          credential: "secret",
        }),
    ).toThrow("HTTPS outside localhost");
    expect(
      () =>
        new OperationServiceHttpClient({
          baseUrl: "https://control.example.test",
          credential: "bad\r\nvalue",
        }),
    ).toThrow("credential is invalid");
  });
});
