import { describe, expect, it } from "vitest";
import type { ReleaseCandidate } from "./model.js";
import {
  ServiceBackedDisposableCanary,
  type CanaryConfigurationService,
  type CanaryInstanceService,
  type CanaryOperationService,
  type CanaryPlanReceipt,
} from "./canary-service.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const PRODUCER = "a".repeat(40);
const NOW = Date.parse("2026-01-01T00:00:00.000Z");

function release(): ReleaseCandidate {
  return {
    schemaVersion: 1,
    id: "release-1",
    version: "1.0.0",
    imageRepository: "example/runtime",
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
      modules: [],
      baseResources: { cpuMilli: 0, memoryMiB: 0, ephemeralStorageMiB: 0 },
      sharedResourceGroups: [],
      resourceProfiles: [],
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
      evidence: ["verified"],
      verifiedAt: "2026-01-01T00:00:00.000Z",
    },
    status: "candidate",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function planReceipt(): CanaryPlanReceipt {
  return {
    instance: {
      instanceId: "canary-instance",
      repositoryId: 900,
      generation: 0,
      runtimeEpoch: 0,
      desiredState: "stopped",
      observedState: "stopped",
      desiredRevisionId: null,
      observedRevisionId: null,
      observedRuntimeEpoch: null,
    },
    revision: {
      revisionId: "revision-canary",
      generation: 0,
      status: "admitted",
      artifactDigest: `sha256:${"b".repeat(64)}`,
      selection: {
        releaseId: "release-1",
        requestedModules: ["forms"],
        resourceProfileId: "small",
        policy: "pinned",
      },
      resources: {},
      runtimeMetadata: release().runtimeMetadata,
    },
    operation: null,
    buildId: "build-1",
    buildKey: "build-key-1",
    replayed: false,
  };
}

function health(runtimeId: string, operationId: string) {
  return {
    artifactDigest: `sha256:${"b".repeat(64)}`,
    runtimeId,
    operationId,
    runtimeEpoch: 1,
    providerObservationId: "observation-ready-1",
    source: "runtime-provisioner-observation",
    imageIdentityVerified: true,
    observedAt: NOW,
    checks: { startup: true, auth: true, uiApiMcp: true, persistence: true },
    checkEvidence: {
      startup: "probe-startup-1",
      auth: "probe-auth-1",
      uiApiMcp: "probe-ui-api-mcp-1",
      persistence: "probe-persistence-1",
    },
  };
}

describe("service-backed disposable release canary", () => {
  it.each([
    { bindingEpoch: 3, authorizationRevision: 4 },
    { bindingEpoch: 1, authorizationRevision: 0 },
    { bindingEpoch: 0, authorizationRevision: 0 },
  ])(
    "pins and runs a candidate with binding $bindingEpoch/$authorizationRevision",
    async ({ bindingEpoch, authorizationRevision }) => {
      const receipt = planReceipt();
      const calls: string[] = [];
      let planned: CanaryPlanReceipt | null = null;
      let currentInstance = receipt.instance;
      let startOperation: {
        id: string;
        kind: "start";
        status: "running" | "succeeded";
        generation: number;
        runtimeEpoch: number;
        deploymentRevisionId: string;
        result: null;
      } | null = null;
      let stopOperation: {
        id: string;
        kind: "stop";
        status: "running" | "succeeded";
        generation: number;
        runtimeEpoch: number;
        deploymentRevisionId: string;
        result: null;
      } | null = null;
      let observationEpoch = 1;
      const instances: CanaryInstanceService = {
        async getByRepositoryId() {
          return {
            binding: {
              repositoryId: 900,
              instanceId: "canary-instance",
              bindingEpoch,
              authorizationRevision,
              suspended: false,
            },
            instance: currentInstance,
          };
        },
        async requestDesiredState(input) {
          calls.push(`desired:${input.desiredState}:${input.forceNewRuntime === true}`);
          if (input.desiredState === "stopped") {
            stopOperation ??= {
              id: "operation-stop-1",
              kind: "stop",
              status: "running",
              generation: 2,
              runtimeEpoch: 1,
              deploymentRevisionId: "revision-canary",
              result: null,
            };
            currentInstance = {
              ...currentInstance,
              generation: 2,
              desiredState: "stopped",
              observedState: stopOperation.status === "succeeded" ? "stopped" : "stopping",
              observedRuntimeEpoch: 1,
            };
            return { instance: currentInstance, operation: stopOperation };
          }
          startOperation = {
            id: "operation-start-1",
            kind: "start",
            status: "running",
            generation: 1,
            runtimeEpoch: 1,
            deploymentRevisionId: "revision-canary",
            result: null,
          };
          currentInstance = {
            ...currentInstance,
            generation: 1,
            runtimeEpoch: 1,
            desiredState: "running",
            observedState: "ready",
            observedRuntimeEpoch: 1,
          };
          return {
            instance: currentInstance,
            operation: startOperation,
          };
        },
      };
      const configurations: CanaryConfigurationService = {
        async plan(input) {
          calls.push(`plan:${input.selection.releaseId}:${input.selection.policy}`);
          planned = receipt;
          return receipt;
        },
        async findByIdempotency(repositoryId, idempotencyKey) {
          expect(repositoryId).toBe(900);
          expect(idempotencyKey).toBe("stable-canary-plan:release-1");
          return planned;
        },
      };
      const operations: CanaryOperationService = {
        async getById(operationId) {
          if (operationId === "operation-start-1") return startOperation;
          if (operationId === "operation-stop-1") return stopOperation;
          return null;
        },
      };
      const canary = new ServiceBackedDisposableCanary({
        binding: {
          repositoryId: 900,
          instanceId: "canary-instance",
          bindingEpoch,
          authorizationRevision,
          requestedModules: ["forms"],
          resourceProfileId: "small",
        },
        instances,
        configurations,
        operations,
        observations: {
          latestHealth: async ({ operationId }) => ({
            ...health("canary-instance", operationId),
            runtimeEpoch: observationEpoch,
          }),
          writerAbsence: async ({ instanceId, repositoryId, retiredEpoch }) => ({
            instanceId,
            repositoryId,
            retiredEpoch,
            providerObservationId: "writer-census-1",
            censusObservedAt: NOW,
            remainingWriters: 0,
            evidenceIdentities: [],
            source: "runtime-provider-census",
          }),
        },
        now: () => NOW,
        newRequestId: () => "request-1",
      });
      const target = release();

      const composition = await canary.compose({ release: target, idempotencyKey: "ignored" });
      expect(composition.kind).toBe("ready");
      if (composition.kind !== "ready") throw new Error("expected a ready canary build");
      expect(composition.artifactDigest).toBe(receipt.revision.artifactDigest);
      const started = await canary.ensureRunning({
        release: target,
        artifactDigest: composition.artifactDigest,
        idempotencyKey: "stable-canary-runtime:release-1",
      });
      expect(started).toEqual({ runtimeId: "canary-instance", operationId: "operation-start-1" });
      expect(calls).toContain("desired:running:true");
      expect((await canary.observe(started)).kind).toBe("unknown");

      startOperation = { ...startOperation!, status: "succeeded" };
      observationEpoch = 2;
      expect((await canary.observe(started)).kind).toBe("unknown");
      observationEpoch = 1;
      const observed = await canary.observe(started);
      expect(observed.kind).toBe("healthy");
      const pendingStop = await canary.stop({
        ...started,
        startedOperationId: started.operationId,
        idempotencyKey: "stable-canary-stop:release-1",
      });
      expect(pendingStop.kind).toBe("pending");
      stopOperation = { ...stopOperation!, status: "succeeded" };
      currentInstance = { ...currentInstance, observedState: "stopped" };
      const stopped = await canary.stop({
        ...started,
        startedOperationId: started.operationId,
        idempotencyKey: "stable-canary-stop:release-1",
      });
      expect(stopped.kind).toBe("stopped");
      if (stopped.kind === "stopped") {
        expect(stopped.evidence.startedOperationId).toBe(started.operationId);
        expect(stopped.evidence.writerAbsence.remainingWriters).toBe(0);
      }
    },
  );

  it("does not turn a mismatched repository binding into a disposable canary", async () => {
    const canary = new ServiceBackedDisposableCanary({
      binding: {
        repositoryId: 900,
        instanceId: "canary-instance",
        bindingEpoch: 3,
        authorizationRevision: 4,
        requestedModules: [],
        resourceProfileId: "small",
      },
      instances: {
        async getByRepositoryId() {
          return {
            binding: {
              repositoryId: 900,
              instanceId: "user-instance",
              bindingEpoch: 3,
              authorizationRevision: 4,
              suspended: false,
            },
            instance: planReceipt().instance,
          };
        },
        async requestDesiredState() {
          throw new Error("must not mutate a different instance");
        },
      },
      configurations: {
        async plan() {
          return planReceipt();
        },
        async findByIdempotency() {
          return null;
        },
      },
      operations: {
        async getById() {
          return null;
        },
      },
      observations: {
        async latestHealth() {
          return null;
        },
        async writerAbsence() {
          return null;
        },
      },
      now: () => NOW,
    });
    await expect(canary.compose({ release: release(), idempotencyKey: "build" })).rejects.toThrow(
      /binding changed/u,
    );
  });

  it("rejects a recovered plan after its configured module selection changes", async () => {
    const receipt = planReceipt();
    const canary = new ServiceBackedDisposableCanary({
      binding: {
        repositoryId: 900,
        instanceId: "canary-instance",
        bindingEpoch: 3,
        authorizationRevision: 4,
        requestedModules: ["forms", "calendar"],
        resourceProfileId: "small",
      },
      instances: {
        async getByRepositoryId() {
          return {
            binding: {
              repositoryId: 900,
              instanceId: "canary-instance",
              bindingEpoch: 3,
              authorizationRevision: 4,
              suspended: false,
            },
            instance: receipt.instance,
          };
        },
        async requestDesiredState() {
          throw new Error("plan mismatch must be rejected before an operation is requested");
        },
      },
      configurations: {
        async plan() {
          return receipt;
        },
        async findByIdempotency() {
          return receipt;
        },
      },
      operations: {
        async getById() {
          return null;
        },
      },
      observations: {
        async latestHealth() {
          return null;
        },
        async writerAbsence() {
          return null;
        },
      },
      now: () => NOW,
    });
    await expect(canary.compose({ release: release(), idempotencyKey: "build" })).rejects.toThrow(
      /idempotency receipt/u,
    );
  });
});
