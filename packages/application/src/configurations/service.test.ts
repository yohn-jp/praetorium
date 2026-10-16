import { describe, expect, it, vi } from "vitest";
import { buildKey, type BuildInput } from "@praetorium/contracts";
import {
  ConfigurationService,
  type ConfigurationContext,
  type ConfigurationPlanOutput,
  type ConfigurationStageMutation,
  type ConfigurationStore,
} from "./index.js";

const KEY = `sha256:${"a".repeat(64)}`;
const SELECTION = {
  releaseId: "release-1",
  requestedModules: ["web"],
  resourceProfileId: "small",
  policy: "stable",
} as const;
const BUILD_INPUT: BuildInput = {
  contractVersion: "scriptorium-build/v1",
  producerRevision: "b".repeat(40),
  runtimeBaseDigest: KEY,
  buildKitDigest: KEY,
  recipeDigest: KEY,
  sourceDigest: KEY,
  lockDigest: KEY,
  requestedModules: ["web"],
  resolvedModules: [{ id: "web", version: "1.2.3", artifactDigest: KEY }],
  platform: "linux/amd64",
  options: {},
};
const PLAN: ConfigurationPlanOutput = {
  buildInput: BUILD_INPUT,
  resources: { cpuMilli: 500, memoryMiB: 512, ephemeralStorageMiB: 1024 },
  runtimeMetadata: {
    contractVersion: "scriptorium-platform/v1",
    producerRevision: "b".repeat(40),
    listener: { port: 8080 },
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
};
const CONTEXT: ConfigurationContext = {
  binding: {
    repositoryId: 101,
    instanceId: "instance-1",
    bindingEpoch: 7,
    authorizationRevision: 4,
    suspended: false,
  },
  instance: {
    instanceId: "instance-1",
    repositoryId: 101,
    generation: 2,
    runtimeEpoch: 3,
    desiredState: "running",
    policy: "stable",
    observedGeneration: null,
    observedRuntimeEpoch: null,
    observedSequence: 0,
    observedState: "ready",
    desiredRevisionId: "revision-current",
    observedRevisionId: "revision-current",
    desiredArtifactDigest: KEY,
    currentArtifactDigest: KEY,
    reservationState: "allocated",
    reservationId: "reservation-1",
    createdAt: 1,
    updatedAt: 1,
  },
};

describe("ConfigurationService stage", () => {
  it("persists a producer-planned stage without committing desired configuration", async () => {
    const stageConfiguration = vi.fn(async (input: ConfigurationStageMutation) => ({
      stage: {
        ...input,
        createdAt: input.now,
        status: "staged" as const,
        activationGeneration: null,
        deploymentRevisionId: null,
        operationId: null,
        updatedAt: input.now,
      },
      build: {
        buildId: input.buildId,
        buildKey: input.buildKey,
        status: "pending" as const,
        artifactDigest: null,
        progress: null,
        errorCode: null,
        updatedAt: input.now,
      },
      replayed: false,
    }));
    const findStageByIdempotency = vi.fn(async () => null);
    const commitPlan = vi.fn();
    const store = {
      findStageByIdempotency,
      getPlanContext: vi.fn(async () => CONTEXT),
      stageConfiguration,
      commitPlan,
    } as unknown as ConfigurationStore;
    const planner = { plan: vi.fn(async () => PLAN) };
    const ids = { stage: 0, build: 0 };
    const service = new ConfigurationService(store, planner, {
      newId: (kind) => `${kind}-${++ids[kind === "stage" ? "stage" : "build"]}`,
    });
    const request = {
      repositoryId: 101,
      instanceId: "instance-1",
      bindingEpoch: 7,
      authorizationRevision: 4,
      expectedGeneration: 2,
      selection: { ...SELECTION, requestedModules: [...SELECTION.requestedModules] },
      actorId: "system:stable-release",
      idempotencyKey: "stable-rollout-build:release-1:instance-1:revision-current",
      requestId: "request-1",
      now: 50,
    };

    const receipt = await service.stage(request);

    expect(receipt).toMatchObject({
      stage: {
        stageId: "stage-1",
        instanceId: "instance-1",
        expectedGeneration: 2,
        expectedRuntimeEpoch: 3,
        buildKey: await buildKey(BUILD_INPUT),
        buildId: "build-1",
        status: "staged",
      },
      build: { buildId: "build-1", status: "pending" },
      replayed: false,
    });
    expect(planner.plan).toHaveBeenCalledWith(SELECTION);
    expect(stageConfiguration).toHaveBeenCalledOnce();
    expect(stageConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedPolicy: "stable",
        expectedRuntimeEpoch: 3,
        expectedDesiredState: "running",
        buildInput: BUILD_INPUT,
        actorId: request.actorId,
        idempotencyKey: request.idempotencyKey,
        now: 50,
      }),
    );
    expect(commitPlan).not.toHaveBeenCalled();
    expect(findStageByIdempotency).toHaveBeenCalledOnce();
  });
});
