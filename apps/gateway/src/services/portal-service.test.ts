import { describe, expect, it, vi } from "vitest";
import type { InstanceDashboard, RepositorySnapshot } from "@praetorium/contracts";
import type { AccessibleRepository } from "@praetorium/github";
import { keyedDigest } from "@praetorium/auth";
import { createInMemoryHandoffCodeStore } from "@praetorium/auth/testing";
import type { GatewayContext } from "../context.js";
import { createPortalService } from "./portal-service.js";

const digest = `sha256:${"a".repeat(64)}`;
const instanceId = "ins_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const snapshot: RepositorySnapshot = {
  binding: {
    repositoryId: 41,
    instanceId,
    installationId: 52,
    owner: "praetorium",
    name: "workspace",
    authorizationRevision: 3,
    bindingEpoch: 4,
    suspended: false,
  },
  instance: {
    instanceId,
    repositoryId: 41,
    generation: 2,
    runtimeEpoch: 5,
    desiredState: "running",
    policy: "stable",
    observedGeneration: 1,
    currentArtifactDigest: digest,
    desiredArtifactDigest: digest,
    observedState: "starting",
    observedRuntimeEpoch: 4,
    observedSequence: 9,
    desiredRevisionId: "revision-desired",
    observedRevisionId: "revision-current",
    reservationState: "reserved",
    reservationId: "reservation-1",
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_001,
  },
};

const runtimeMetadata = {
  contractVersion: "scriptorium-platform/v1" as const,
  producerRevision: "a".repeat(40),
  listener: { port: 8080 },
  paths: {
    liveness: "/healthz",
    readiness: "/readyz",
    metadata: "/metadata",
    shutdown: "/shutdown",
    status: "/api/platform/v1/status" as const,
    quiesce: "/api/platform/v1/quiesce" as const,
    resume: "/api/platform/v1/resume" as const,
  },
  shutdownTimeoutSeconds: 30,
};

const revision = {
  revisionId: "revision-desired",
  instanceId,
  repositoryId: 41,
  generation: 2,
  buildKey: digest,
  buildId: "build-1",
  selection: {
    releaseId: "release-1",
    requestedModules: ["editor"],
    resourceProfileId: "balanced",
    policy: "stable" as const,
  },
  resources: { cpuMilli: 1000, memoryMiB: 2048, ephemeralStorageMiB: 1024 },
  runtimeMetadata,
  resolvedModules: [
    { id: "editor", version: "2.0.0", artifactDigest: digest },
    { id: "search", version: "1.4.0", artifactDigest: digest },
  ],
  artifactDigest: digest,
  status: "building" as const,
  actorId: "12345",
  createdAt: 1_800_000_000_000,
};

const catalog = {
  contractVersion: "scriptorium-build/v1" as const,
  producerRevision: "a".repeat(40),
  runtimeBaseDigest: digest,
  buildKitDigest: digest,
  recipeDigest: digest,
  lockDigest: digest,
  sourceDigest: digest,
  supportedPlatforms: ["linux/amd64"],
  modules: [
    {
      id: "editor",
      version: "2.0.0",
      artifactDigest: digest,
      requires: ["search"],
      conflicts: [],
      contractRange: "*",
      exclusiveResources: { cpuMilli: 0, memoryMiB: 0, ephemeralStorageMiB: 0 },
      sharedResourceGroupIds: [],
      workerLimits: {},
    },
    {
      id: "search",
      version: "1.4.0",
      artifactDigest: digest,
      requires: [],
      conflicts: [],
      contractRange: "*",
      exclusiveResources: { cpuMilli: 0, memoryMiB: 0, ephemeralStorageMiB: 0 },
      sharedResourceGroupIds: [],
      workerLimits: {},
    },
  ],
  baseResources: { cpuMilli: 500, memoryMiB: 1024, ephemeralStorageMiB: 512 },
  sharedResourceGroups: [],
  resourceProfiles: [
    { id: "balanced", cpuMilli: 1000, memoryMiB: 2048, ephemeralStorageMiB: 1024 },
  ],
};

const release = {
  releaseId: "release-1",
  version: "1.2.0",
  imageDigest: digest,
  catalog,
};

const management: InstanceDashboard = {
  snapshot,
  current: { ...revision, revisionId: "revision-current", generation: 1, artifactDigest: digest },
  desired: revision,
  build: {
    id: "build-1",
    buildKey: digest,
    status: "running",
    progress: { stage: "building", percent: 63 },
    errorCode: null,
    updatedAt: 1_800_000_000_005,
  },
  operations: [
    {
      id: "operation-1",
      instanceId,
      generation: 2,
      runtimeEpoch: 5,
      kind: "update",
      status: "running",
      phase: "waiting for build",
      attempt: 1,
      createdAt: 1_800_000_000_001,
      updatedAt: 1_800_000_000_004,
    },
  ],
  releases: [release],
  resourceLimits: { cpuMilli: 4000, memoryMiB: 8192, ephemeralStorageMiB: 8192 },
};

const repository: AccessibleRepository = {
  repositoryId: 41,
  installationId: 52,
  owner: "praetorium",
  name: "workspace",
  private: true,
  role: "maintain",
};

function serviceContext(value: InstanceDashboard = management, repositoryValue: RepositorySnapshot = snapshot) {
  const controlPlane = {
    getByRepositoryId: vi.fn(async () => repositoryValue),
    getDashboard: vi.fn(async () => value),
  };
  const githubAccess = {
    authorize: vi.fn(async () => ({
      allowed: true,
      permissions: ["read", "write", "maintain"],
      checkedAt: 1_800_000_000_000,
      expiresAt: 1_800_000_100_000,
      installationId: repository.installationId,
      repositoryId: repository.repositoryId,
    })),
    listRepositories: vi.fn(async () => ({ ok: true as const, value: [repository] })),
  };
  const context = {
    requestNow: "2027-01-15T00:00:00.000Z",
    githubAccess,
    controlPlane,
  } as unknown as GatewayContext;
  return { service: createPortalService(context), controlPlane, githubAccess };
}

function actionService(allowMaintain = true) {
  const activeSnapshot: RepositorySnapshot = {
    ...snapshot,
    instance: {
      ...snapshot.instance,
      observedState: "ready",
      observedGeneration: 1,
      observedRuntimeEpoch: 4,
    },
  };
  const activeManagement = { ...management, snapshot: activeSnapshot };
  const checkedEpochs: number[] = [];
  const planResult = {
    instance: activeSnapshot.instance,
    revision: { ...revision, revisionId: "revision-next", generation: 3 },
    operation: management.operations[0],
    buildId: "build-next",
    buildKey: digest,
    replayed: false,
  };
  const previewResult = {
    buildInput: {},
    resources: revision.resources,
    runtimeMetadata,
    buildKey: digest,
    requestedModules: ["editor"],
    resolvedModules: revision.resolvedModules,
  };
  const controlPlane = {
    getByRepositoryId: vi.fn(async () => activeSnapshot),
    getDashboard: vi.fn(async () => activeManagement),
    previewConfiguration: vi.fn(async () => previewResult),
    planConfiguration: vi.fn(async () => planResult),
    requestDesiredState: vi.fn(async (requestedInstanceId: string, input: Record<string, unknown>) => {
      void requestedInstanceId;
      void input;
      return {
        ...activeSnapshot,
        operation: management.operations[0],
        replayed: false,
      };
    }),
    retryOperation: vi.fn(async () => ({
      id: "operation-retry-1",
      instanceId,
      generation: activeSnapshot.instance.generation + 1,
      runtimeEpoch: activeSnapshot.instance.runtimeEpoch + 1,
      kind: "redeploy" as const,
      status: "pending" as const,
      phase: "queued",
      attempt: 0,
      createdAt: 1_800_000_000_010,
      updatedAt: 1_800_000_000_010,
    })),
  };
  const githubAccess = {
    authorize: vi.fn(async (_userId: string, _repositoryId: number, action: string) => ({
      allowed: action === "read" || allowMaintain,
      permissions: allowMaintain ? ["read", "write", "maintain"] : ["read"],
      checkedAt: 1_800_000_000_000,
      expiresAt: 1_900_000_000_000,
      installationId: repository.installationId,
      repositoryId: repository.repositoryId,
    })),
    listRepositories: vi.fn(async () => ({ ok: true as const, value: [repository] })),
    checkBoundAccess: vi.fn(async (
      _userId: string,
      repositoryId: number,
      checkedInstanceId: string,
      runtimeEpoch: number,
      now: string,
    ) => {
      checkedEpochs.push(runtimeEpoch);
      return {
        status: "allowed" as const,
        repositoryId,
        installationId: repository.installationId,
        instanceId: checkedInstanceId,
        runtimeEpoch,
        authorizationRevision: activeSnapshot.binding.authorizationRevision,
        permissions: allowMaintain ? ["read", "write", "maintain"] as const : ["read"] as const,
        checkedAt: Date.parse(now),
        expiresAt: Date.parse(now) + 300_000,
      };
    }),
  };
  const context = {
    requestId: "config-request",
    requestNow: "2027-01-15T00:00:00.000Z",
    githubAccess,
    controlPlane,
  } as unknown as GatewayContext;
  return { service: createPortalService(context), controlPlane, githubAccess, checkedEpochs, activeSnapshot };
}

describe("PortalService Control Plane projection", () => {
  it("maps the authenticated management view without fabricating release or build data", async () => {
    const { service, controlPlane } = serviceContext();
    const result = await service.getRepository({ userId: "12345" }, "41");

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("expected repository dashboard");
    expect(result.value).toMatchObject({
      generation: 2,
      releasePolicy: { kind: "stable" },
      current: {
        releaseId: "release-1",
        releaseLabel: "1.2.0",
        baseImageDigest: digest,
        composedImageDigest: digest,
        requestedModules: ["editor"],
        includedModules: ["editor", "search"],
        resources: { cpuMilli: 1000, memoryMiB: 2048, ephemeralStorageMiB: 1024 },
      },
      desired: { releaseId: "release-1", includedModules: ["editor", "search"] },
      build: {
        buildId: "build-1",
        status: "running",
        stage: "building",
        progressPercent: 63,
        errorCode: null,
      },
      operations: [{ operationId: "operation-1", state: "running", message: "waiting for build" }],
      approvedReleases: [{ releaseId: "release-1", label: "1.2.0", imageDigest: digest }],
      modules: [
        { moduleId: "editor", label: "editor", version: "2.0.0", artifactDigest: digest },
        { moduleId: "search", label: "search", version: "1.4.0", artifactDigest: digest },
      ],
      resourceProfiles: [{ profileId: "balanced", resources: { cpuMilli: 1000, memoryMiB: 2048, ephemeralStorageMiB: 1024 } }],
      resourceLimits: { cpuMilli: 4000, memoryMiB: 8192, ephemeralStorageMiB: 8192 },
      canConfigure: true,
    });
    expect(controlPlane.getDashboard).toHaveBeenCalledWith(instanceId);
  });

  it("fails closed when the management view no longer matches the GitHub repository binding", async () => {
    const stale = {
      ...management,
      snapshot: {
        ...snapshot,
        binding: { ...snapshot.binding, installationId: 99 },
      },
    };
    const { service } = serviceContext(stale);
    await expect(service.getRepository({ userId: "12345" }, "41")).resolves.toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
  });

  it("projects the old current app as ready while the desired replacement is building", async () => {
    const pendingSnapshot: RepositorySnapshot = {
      ...snapshot,
      instance: {
        ...snapshot.instance,
        observedState: "ready",
        observedGeneration: 1,
        observedRuntimeEpoch: 4,
        reservationState: "blocked",
      },
    };
    const pendingManagement = { ...management, snapshot: pendingSnapshot };
    const { service } = serviceContext(pendingManagement, pendingSnapshot);
    const result = await service.getRepository({ userId: "12345" }, "41");

    expect(result).toMatchObject({
      ok: true,
      value: {
        repository: { instance: { state: "ready" } },
        current: { composedImageDigest: digest },
        desired: { composedImageDigest: digest },
        build: { status: "running", stage: "building" },
        operations: [{ state: "running", message: "waiting for build" }],
      },
    });
  });

  it("previews and plans the approved selection with active authorization and desired-generation CAS", async () => {
    const { service, controlPlane, checkedEpochs, activeSnapshot } = actionService();
    const selection = {
      releaseId: "release-1",
      moduleIds: ["editor"],
      resourceProfileId: "balanced",
      releasePolicy: "stable" as const,
    };
    const preview = await service.execute({ userId: "12345" }, "41", { kind: "preview", ...selection });
    expect(preview).toMatchObject({
      ok: true,
      value: { kind: "preview", preview: { state: "valid", includedModules: ["editor", "search"] } },
    });
    expect(controlPlane.previewConfiguration).toHaveBeenCalledWith(instanceId, {
      bindingEpoch: activeSnapshot.binding.bindingEpoch,
      authorizationRevision: activeSnapshot.binding.authorizationRevision,
      expectedGeneration: activeSnapshot.instance.generation,
      selection: { releaseId: "release-1", requestedModules: ["editor"], resourceProfileId: "balanced", policy: "stable" },
    });

    const planned = await service.execute({ userId: "12345" }, "41", {
      kind: "configure",
      expectedGeneration: activeSnapshot.instance.generation,
      idempotencyKey: "configuration-idempotency-key-01",
      ...selection,
    });
    expect(planned).toEqual({ ok: true, value: { kind: "configuration", revisionId: "revision-next", buildId: "build-next" } });
    expect(controlPlane.planConfiguration).toHaveBeenCalledWith(instanceId, {
      actorId: "12345",
      bindingEpoch: activeSnapshot.binding.bindingEpoch,
      authorizationRevision: activeSnapshot.binding.authorizationRevision,
      expectedGeneration: activeSnapshot.instance.generation,
      selection: { releaseId: "release-1", requestedModules: ["editor"], resourceProfileId: "balanced", policy: "stable" },
      idempotencyKey: "configuration-idempotency-key-01",
      requestId: "config-request",
    });
    expect(checkedEpochs).toEqual([4, 4]);
  });

  it("denies a read-only principal before configuration planning", async () => {
    const { service, controlPlane } = actionService(false);
    const result = await service.execute({ userId: "12345" }, "41", {
      kind: "configure",
      expectedGeneration: 2,
      idempotencyKey: "configuration-idempotency-key-02",
      releasePolicy: "stable",
      releaseId: "release-1",
      moduleIds: ["editor"],
      resourceProfileId: "balanced",
    });
    expect(result).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(controlPlane.planConfiguration).not.toHaveBeenCalled();
  });

  it("marks only failed or blocked operations on the current generation retryable", async () => {
    const statuses = [
      { id: "failed-current", generation: 2, status: "failed" as const },
      { id: "blocked-current", generation: 2, status: "blocked" as const },
      { id: "failed-old", generation: 1, status: "failed" as const },
      { id: "blocked-old", generation: 1, status: "blocked" as const },
      { id: "running-current", generation: 2, status: "running" as const },
      { id: "succeeded-current", generation: 2, status: "succeeded" as const },
    ];
    const view: InstanceDashboard = {
      ...management,
      operations: statuses.map((item) => ({ ...management.operations[0]!, ...item })),
    };
    const { service } = serviceContext(view);

    const result = await service.getRepository({ userId: "12345" }, "41");

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("expected repository dashboard");
    expect(result.value.operations.map(({ operationId, retryable }) => [operationId, retryable])).toEqual([
      ["failed-current", true],
      ["blocked-current", true],
      ["failed-old", false],
      ["blocked-old", false],
      ["running-current", false],
      ["succeeded-current", false],
    ]);
  });

  it("retries a failed current-generation operation after fresh maintain authorization", async () => {
    const { service, controlPlane, githubAccess, checkedEpochs, activeSnapshot } = actionService();
    controlPlane.getDashboard.mockResolvedValue({
      ...management,
      snapshot: activeSnapshot,
      operations: [{ ...management.operations[0]!, status: "failed" }],
    });

    const result = await service.execute({ userId: "12345" }, "41", {
      kind: "retry",
      operationId: "operation-1",
      idempotencyKey: "retry-idempotency-key-01",
    });

    expect(result).toMatchObject({
      ok: true,
      value: { kind: "operation", operation: { operationId: "operation-retry-1", retryable: false } },
    });
    expect(githubAccess.authorize).toHaveBeenCalledWith("12345", 41, "maintain");
    expect(githubAccess.checkBoundAccess).toHaveBeenCalledOnce();
    expect(checkedEpochs).toEqual([4]);
    expect(controlPlane.retryOperation).toHaveBeenCalledWith("operation-1", {
      actorId: "12345",
      bindingEpoch: activeSnapshot.binding.bindingEpoch,
      authorizationRevision: activeSnapshot.binding.authorizationRevision,
      expectedGeneration: activeSnapshot.instance.generation,
      idempotencyKey: "retry-idempotency-key-01",
      requestId: "config-request",
    });
  });

  it("lets the Control Plane reject stale retries and refuses active operations", async () => {
    const { service, controlPlane, activeSnapshot } = actionService();
    const stale = {
      ...management.operations[0]!,
      generation: activeSnapshot.instance.generation - 1,
      status: "failed" as const,
    };
    controlPlane.getDashboard.mockResolvedValueOnce({
      ...management,
      snapshot: activeSnapshot,
      operations: [stale],
    });
    controlPlane.retryOperation.mockRejectedValueOnce({ status: 409, code: "OPERATION_RETRY_CONFLICT" });
    await expect(service.execute({ userId: "12345" }, "41", {
      kind: "retry",
      operationId: stale.id,
      idempotencyKey: "retry-idempotency-key-02",
    })).resolves.toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(controlPlane.retryOperation).toHaveBeenCalledWith(stale.id, expect.objectContaining({
      expectedGeneration: stale.generation,
      idempotencyKey: "retry-idempotency-key-02",
    }));

    const active = {
      ...management.operations[0]!,
      generation: activeSnapshot.instance.generation,
      status: "running" as const,
    };
    controlPlane.getDashboard.mockResolvedValueOnce({
      ...management,
      snapshot: activeSnapshot,
      operations: [active],
    });
    await expect(service.execute({ userId: "12345" }, "41", {
      kind: "retry",
      operationId: active.id,
      idempotencyKey: "retry-idempotency-key-04",
    })).resolves.toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(controlPlane.retryOperation).toHaveBeenCalledOnce();
  });

  it("denies a read-only principal before retrying", async () => {
    const { service, controlPlane } = actionService(false);
    const result = await service.execute({ userId: "12345" }, "41", {
      kind: "retry",
      operationId: "operation-1",
      idempotencyKey: "retry-idempotency-key-03",
    });

    expect(result).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(controlPlane.retryOperation).not.toHaveBeenCalled();
  });

  it("redeploys the current immutable selection in a new runtime epoch", async () => {
    const { service, controlPlane, checkedEpochs, activeSnapshot } = actionService();
    const result = await service.execute({ userId: "12345" }, "41", {
      kind: "redeploy",
      expectedGeneration: activeSnapshot.instance.generation,
      idempotencyKey: "redeploy-idempotency-key-01",
    });
    expect(result).toMatchObject({ ok: true, value: { kind: "operation", operation: { operationId: "operation-1" } } });
    expect(controlPlane.requestDesiredState).toHaveBeenCalledWith(instanceId, expect.objectContaining({
      actorId: "12345",
      desiredState: "running",
      expectedGeneration: activeSnapshot.instance.generation,
      bindingEpoch: activeSnapshot.binding.bindingEpoch,
      authorizationRevision: activeSnapshot.binding.authorizationRevision,
      forceNewRuntime: true,
      idempotencyKey: "redeploy-idempotency-key-01",
    }));
    expect(checkedEpochs).toEqual([4]);
  });

  it("stops a ready runtime through the normal fenced desired-state request", async () => {
    const { service, controlPlane, githubAccess, checkedEpochs, activeSnapshot } = actionService();
    const result = await service.execute({ userId: "12345" }, "41", {
      kind: "stop",
      expectedGeneration: activeSnapshot.instance.generation,
      idempotencyKey: "stop-idempotency-key-01",
    });

    expect(result).toMatchObject({ ok: true, value: { kind: "operation" } });
    expect(githubAccess.authorize).toHaveBeenCalledWith("12345", 41, "maintain");
    expect(controlPlane.requestDesiredState).toHaveBeenCalledWith(instanceId, expect.objectContaining({
      actorId: "12345",
      desiredState: "stopped",
      expectedGeneration: activeSnapshot.instance.generation,
      bindingEpoch: activeSnapshot.binding.bindingEpoch,
      authorizationRevision: activeSnapshot.binding.authorizationRevision,
      idempotencyKey: "stop-idempotency-key-01",
      requestId: "config-request",
      now: Date.parse("2027-01-15T00:00:00.000Z"),
    }));
    expect(controlPlane.requestDesiredState.mock.calls[0]?.[1]).not.toHaveProperty("forceNewRuntime");
    expect(checkedEpochs).toEqual([4]);
  });

  it("denies stop to read-only users without mutating the Control Plane", async () => {
    const { service, controlPlane } = actionService(false);
    const result = await service.execute({ userId: "12345" }, "41", {
      kind: "stop",
      expectedGeneration: 2,
      idempotencyKey: "stop-idempotency-key-02",
    });

    expect(result).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(controlPlane.requestDesiredState).not.toHaveBeenCalled();
  });

  it("rejects stale stop generations without mutating the Control Plane", async () => {
    const { service, controlPlane, activeSnapshot } = actionService();
    const result = await service.execute({ userId: "12345" }, "41", {
      kind: "stop",
      expectedGeneration: activeSnapshot.instance.generation - 1,
      idempotencyKey: "stop-idempotency-key-03",
    });

    expect(result).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(controlPlane.requestDesiredState).not.toHaveBeenCalled();
  });

  it("keeps a ready current runtime accessible while a desired build advances the epoch", async () => {
    const pendingSnapshot: RepositorySnapshot = {
      ...snapshot,
      instance: {
        ...snapshot.instance,
        observedState: "ready",
        observedGeneration: 1,
        observedRuntimeEpoch: 4,
      },
    };
    const handoffStore = createInMemoryHandoffCodeStore();
    const handoffPepper = new TextEncoder().encode("active-runtime-handoff-pepper");
    const epochChecks: number[] = [];
    const requestDesiredState = vi.fn(async () => { throw new Error("ready current runtime must not start another operation"); });
    const context = {
      requestId: "request-pending-build",
      requestNow: "2027-01-15T00:00:00.000Z",
      config: {
        origin: "https://gateway.example",
        instanceHostnameSuffix: "instances.example",
        handoffPepper,
        handoffTtlSeconds: 60,
      },
      wakeRateLimiter: { consume: vi.fn(async () => true) },
      handoffStore,
      githubAccess: {
        listRepositories: vi.fn(async () => ({ ok: true as const, value: [repository] })),
        authorize: vi.fn(async () => ({
          allowed: true,
          permissions: ["read", "write", "maintain"],
          checkedAt: Date.parse("2027-01-15T00:00:00.000Z"),
          expiresAt: Date.parse("2027-01-15T00:05:00.000Z"),
          installationId: repository.installationId,
          repositoryId: repository.repositoryId,
        })),
        checkBoundAccess: vi.fn(async (_userId, repositoryId, checkedInstanceId, epoch, now) => {
          epochChecks.push(epoch);
          return {
            status: "allowed" as const,
            repositoryId,
            installationId: repository.installationId,
            instanceId: checkedInstanceId,
            origin: `https://ins-${instanceId.slice(4).toLowerCase()}.instances.example`,
            runtimeEpoch: epoch,
            authorizationRevision: pendingSnapshot.binding.authorizationRevision,
            permissions: ["read", "write", "maintain"] as const,
            checkedAt: Date.parse(now),
            expiresAt: Date.parse(now) + 300_000,
          };
        }),
      },
      controlPlane: {
        getByRepositoryId: vi.fn(async () => pendingSnapshot),
        resolveRepository: vi.fn(async () => ({ ...pendingSnapshot, created: false })),
        requestDesiredState,
      },
    } as unknown as GatewayContext;
    const service = createPortalService(context);
    const actor = { userId: "12345", gatewaySessionDigest: "gateway-session-digest-with-at-least-32-characters" };
    const result = await service.execute(
      actor,
      "41",
      { kind: "enter" },
    );

    expect(result).toMatchObject({ ok: true, value: { kind: "handoff" } });
    if (!result.ok || result.value.kind !== "handoff") throw new Error("expected an old-runtime handoff");
    expect(requestDesiredState).not.toHaveBeenCalled();
    expect(context.wakeRateLimiter.consume).not.toHaveBeenCalled();
    expect(epochChecks).toEqual([4, 4]);
    const digest = await keyedDigest(handoffPepper, result.value.handoff.code);
    const record = await handoffStore.consume(digest);
    expect(record).toMatchObject({
      repositoryId: 41,
      instanceId,
      runtimeEpoch: 4,
      origin: result.value.handoff.origin,
    });
  });
});
