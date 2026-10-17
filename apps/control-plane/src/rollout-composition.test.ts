import { describe, expect, it, vi } from "vitest";
import { ReleaseCandidateSchema } from "@praetorium/application/releases";
import { stableRolloutStageIdempotencyKey } from "@praetorium/application/rollouts";
import type { ConfigurationStageReceipt } from "@praetorium/application/configurations";
import type {
  CanaryHealthProgressState,
  T11D1Database,
} from "./adapters/d1/t11-release-rollouts.js";
import {
  createT11RolloutComposition,
  progressCanaryHealthAfterEvidence,
} from "./rollout-composition.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const PRODUCER = "a".repeat(40);
const BUILD_KEY = `sha256:${"b".repeat(64)}`;
const now = Date.parse("2026-01-01T00:00:00.000Z");

function release() {
  return ReleaseCandidateSchema.parse({
    schemaVersion: 1,
    id: "release-2",
    version: "2.0.0",
    imageRepository: "ghcr.io/example/runtime",
    imageDigest: DIGEST,
    catalog: {
      contractVersion: "scriptorium-build/v1",
      producerRevision: PRODUCER,
      runtimeBaseDigest: DIGEST,
      buildKitDigest: DIGEST,
      recipeDigest: DIGEST,
      lockDigest: DIGEST,
      sourceDigest: DIGEST,
      supportedPlatforms: ["linux/amd64"],
      modules: [
        {
          id: "forms",
          version: "1.0.0",
          artifactDigest: DIGEST,
          requires: [],
          conflicts: [],
          contractRange: "*",
          exclusiveResources: { cpuMilli: 0, memoryMiB: 0, ephemeralStorageMiB: 0 },
          sharedResourceGroupIds: [],
          workerLimits: {},
        },
      ],
      baseResources: { cpuMilli: 0, memoryMiB: 0, ephemeralStorageMiB: 0 },
      sharedResourceGroups: [],
      resourceProfiles: [
        { id: "balanced", cpuMilli: 100, memoryMiB: 128, ephemeralStorageMiB: 256 },
      ],
    },
    runtimeMetadata: {
      contractVersion: "scriptorium-platform/v1",
      producerRevision: PRODUCER,
      listener: { port: 3000 },
      paths: {
        liveness: "/health/live",
        readiness: "/health/ready",
        metadata: "/api/platform/v1/metadata",
        shutdown: "/api/platform/v1/shutdown",
        status: "/api/platform/v1/status",
        quiesce: "/api/platform/v1/quiesce",
        resume: "/api/platform/v1/resume",
      },
      shutdownTimeoutSeconds: 30,
    },
    signatureRef: "https://evidence.example/signature",
    provenanceRef: "https://evidence.example/provenance",
    admission: {
      registryConfirmed: true,
      provenanceVerified: true,
      runtimeMetadataVerified: true,
      evidence: ["verified test evidence"],
      verifiedAt: "2026-01-01T00:00:00.000Z",
    },
    status: "available",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}

async function stageReceipt(): Promise<ConfigurationStageReceipt> {
  const candidate = release();
  const idempotencyKey = await stableRolloutStageIdempotencyKey(
    candidate.id,
    "instance-1",
    "revision-7",
  );
  const selection = {
    releaseId: candidate.id,
    requestedModules: ["forms"],
    resourceProfileId: "balanced",
    policy: "stable" as const,
  };
  const buildInput = {
    contractVersion: "scriptorium-build/v1" as const,
    producerRevision: PRODUCER,
    runtimeBaseDigest: DIGEST,
    buildKitDigest: DIGEST,
    recipeDigest: DIGEST,
    sourceDigest: DIGEST,
    lockDigest: DIGEST,
    requestedModules: ["forms"],
    resolvedModules: [{ id: "forms", version: "1.0.0", artifactDigest: DIGEST }],
    platform: "linux/amd64" as const,
    options: {},
  };
  return {
    replayed: false,
    stage: {
      stageId: "stage-1",
      repositoryId: 101,
      instanceId: "instance-1",
      bindingEpoch: 2,
      authorizationRevision: 3,
      expectedGeneration: 7,
      expectedRuntimeEpoch: 4,
      expectedPolicy: "stable",
      expectedDesiredState: "running",
      selection,
      buildInput,
      buildKey: BUILD_KEY,
      buildId: "build-1",
      resources: { cpuMilli: 100, memoryMiB: 128, ephemeralStorageMiB: 256 },
      runtimeMetadata: candidate.runtimeMetadata,
      actorId: "system:stable-release",
      idempotencyKey,
      requestHash: "sha256:request",
      requestId: "stable-rollout-build:release-2:instance-1",
      createdAt: now,
      status: "staged",
      activationGeneration: null,
      deploymentRevisionId: null,
      operationId: null,
      updatedAt: now,
    },
    build: {
      buildId: "build-1",
      buildKey: BUILD_KEY,
      status: "succeeded",
      artifactDigest: `sha256:${"c".repeat(64)}`,
      progress: null,
      errorCode: null,
      updatedAt: now,
    },
  };
}

function follower() {
  return {
    instanceId: "instance-1",
    repositoryId: 101,
    bindingEpoch: 2,
    authorizationRevision: 3,
    clusterId: "cluster-1",
    generation: 7,
    runtimeEpoch: 4,
    desiredState: "running" as const,
    policy: "stable" as const,
    desiredReleaseId: "release-1",
    desiredArtifactDigest: `sha256:${"d".repeat(64)}`,
    currentArtifactDigest: `sha256:${"d".repeat(64)}`,
    configurationRevision: "revision-7",
    selectedModuleIds: ["forms"],
    resourceProfileId: "balanced",
    platform: "linux/amd64" as const,
  };
}

describe("canary health progress retry", () => {
  it("rechecks automatically after a concurrent rollout lease clears", async () => {
    let elapsed = 0;
    const prepare = vi.fn(async (): Promise<CanaryHealthProgressState> =>
      elapsed < 600
        ? { kind: "leased", releaseId: "release-2", leaseExpiresAt: now + 1_000 }
        : { kind: "due", releaseId: "release-2" },
    );
    const advance = vi.fn(async () => 1);
    const waits: number[] = [];

    await progressCanaryHealthAfterEvidence({
      findReleaseId: async () => "release-2",
      prepare,
      advance,
      monotonicNow: () => elapsed,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
        elapsed += milliseconds;
      },
    });

    expect(prepare).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([200, 400]);
    expect(advance).toHaveBeenCalledExactlyOnceWith("release-2");
  });

  it("caps D1 rechecks and uses exponential delays when the lease remains active", async () => {
    let elapsed = 0;
    const prepare = vi.fn(async (): Promise<CanaryHealthProgressState> => ({
      kind: "leased",
      releaseId: "release-2",
      leaseExpiresAt: now + 60_000,
    }));
    const waits: number[] = [];

    await progressCanaryHealthAfterEvidence({
      findReleaseId: async () => "release-2",
      prepare,
      advance: vi.fn(async () => 0),
      monotonicNow: () => elapsed,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
        elapsed += milliseconds;
      },
    });

    expect(prepare).toHaveBeenCalledTimes(8);
    expect(waits).toEqual([200, 400, 800, 1_600, 3_200, 3_200, 3_200]);
    expect(elapsed).toBe(12_600);
  });
});

describe("T11 rollout production composition", () => {
  it("stages a stable follower through ConfigurationService without planning or mutating desired state", async () => {
    const receipt = await stageReceipt();
    const stage = vi.fn(async () => receipt);
    const findStageByIdempotency = vi.fn(async () => null);
    const activateStageUnderClusterFence = vi.fn(async () => null);
    const db = {
      prepare() {
        throw new Error("unexpected D1 query");
      },
      batch() {
        throw new Error("unexpected D1 batch");
      },
    } as unknown as T11D1Database;
    const composition = createT11RolloutComposition({
      db,
      configurations: { stage, findStageByIdempotency, activateStageUnderClusterFence },
      canaryConfigurations: {
        plan: vi.fn(),
        findByIdempotency: vi.fn(),
      },
      instances: {} as never,
      operations: {} as never,
      canaryBinding: {
        repositoryId: 202,
        instanceId: "canary-1",
        bindingEpoch: 1,
        authorizationRevision: 1,
        requestedModules: [],
        resourceProfileId: "balanced",
      },
      canaryObservations: {
        latestHealth: vi.fn(async () => null),
        writerAbsence: vi.fn(async () => null),
      },
      defaultClusterId: "cluster-default",
      clock: { now: () => new Date(now).toISOString(), nowMs: () => now },
      ids: { newReleaseId: () => "release-id" },
      workerId: "t11-worker",
      authorizeOperator: async () => null,
      registry: {
        async verifyImage(repository, manifestDigest, platform) {
          return { repository, manifestDigest, platform };
        },
      },
      provenance: {
        async verify() {
          return { verified: true, evidence: [] };
        },
      },
      producerMetadata: {
        async verify() {
          return { kind: "verified", evidence: [] };
        },
      },
    });

    const idempotencyKey = await stableRolloutStageIdempotencyKey(
      "release-2",
      "instance-1",
      "revision-7",
    );
    const result = await composition.scheduled.rollouts.composition.compose({
      release: release(),
      follower: follower(),
      idempotencyKey,
    });

    expect(stage).toHaveBeenCalledWith({
      repositoryId: 101,
      bindingEpoch: 2,
      authorizationRevision: 3,
      instanceId: "instance-1",
      expectedGeneration: 7,
      selection: {
        releaseId: "release-2",
        requestedModules: ["forms"],
        resourceProfileId: "balanced",
        policy: "stable",
      },
      actorId: "system:stable-release",
      idempotencyKey,
      requestId: idempotencyKey,
      now,
    });
    expect(result).toEqual({
      kind: "ready",
      buildKey: BUILD_KEY,
      buildId: "build-1",
      artifactDigest: `sha256:${"c".repeat(64)}`,
    });

    const omittedDependency = await stageReceipt();
    stage.mockResolvedValue({
      ...omittedDependency,
      stage: {
        ...omittedDependency.stage,
        buildInput: { ...omittedDependency.stage.buildInput, resolvedModules: [] },
      },
    });
    await expect(
      composition.scheduled.rollouts.composition.compose({
        release: release(),
        follower: follower(),
        idempotencyKey,
      }),
    ).resolves.toEqual({
      kind: "failed",
      code: "staged_configuration_snapshot_mismatch",
      retryable: false,
    });
  });
});
