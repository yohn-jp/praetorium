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
  it("fences a delayed v0.3.8 cleanup from stopping v0.3.9 and retries only the selected revision", async () => {
    const oldRelease = { ...release(), id: "release-v038", version: "0.3.8" };
    const newRelease = { ...release(), id: "release-v039", version: "0.3.9" };
    const oldReceipt: CanaryPlanReceipt = {
      ...planReceipt(),
      instance: { ...planReceipt().instance, generation: 18, runtimeEpoch: 8,
        desiredState: "running", desiredRevisionId: "revision-v038" },
      revision: { ...planReceipt().revision, revisionId: "revision-v038", generation: 18,
        selection: { ...planReceipt().revision.selection, releaseId: oldRelease.id } },
      operation: {
        id: "operation-v038", instanceId: "canary-instance", repositoryId: 900,
        kind: "update", status: "blocked", generation: 18, runtimeEpoch: 8,
        deploymentRevisionId: "revision-v038", result: null,
      },
    };
    const newReceipt: CanaryPlanReceipt = {
      ...planReceipt(),
      instance: { ...planReceipt().instance, generation: 19, runtimeEpoch: 9,
        desiredState: "running", desiredRevisionId: "revision-v039" },
      revision: { ...planReceipt().revision, revisionId: "revision-v039", generation: 19,
        selection: { ...planReceipt().revision.selection, releaseId: newRelease.id } },
      operation: {
        id: "operation-v039", instanceId: "canary-instance", repositoryId: 900,
        kind: "update", status: "running", generation: 19, runtimeEpoch: 9,
        deploymentRevisionId: "revision-v039", result: null,
      },
    };
    let currentInstance: CanaryPlanReceipt["instance"] = {
      ...newReceipt.instance,
      observedState: "ready" as const,
      observedRuntimeEpoch: 7,
    };
    const operationsById = new Map<string, NonNullable<CanaryPlanReceipt["operation"]>>([
      ["operation-v038", oldReceipt.operation!],
      ["operation-v039", newReceipt.operation!],
    ]);
    const desiredStateCalls: Array<Record<string, unknown>> = [];
    const binding = {
      repositoryId: 900,
      instanceId: "canary-instance",
      bindingEpoch: 3,
      authorizationRevision: 4,
      suspended: false,
    };
    const instances: CanaryInstanceService = {
      async getByRepositoryId() { return { binding, instance: currentInstance }; },
      async requestDesiredState(input) {
        desiredStateCalls.push(input);
        expect(input.expectedGeneration).toBe(20);
        expect(input.desiredState).toBe("running");
        expect(input.forceNewRuntime).toBe(true);
        const operation = {
          id: "operation-v039-retry", instanceId: "canary-instance", repositoryId: 900,
          kind: "redeploy" as const, status: "running" as const,
          generation: 21, runtimeEpoch: 10, deploymentRevisionId: "revision-v039", result: null,
        };
        operationsById.set(operation.id, operation);
        currentInstance = {
          ...currentInstance,
          generation: operation.generation,
          runtimeEpoch: operation.runtimeEpoch,
          desiredState: "running",
          desiredRevisionId: "revision-v039",
          observedState: "starting",
        };
        return { instance: currentInstance, operation };
      },
    };
    const configurations: CanaryConfigurationService = {
      async plan() { throw new Error("expected both release plans to be replayed"); },
      async findByIdempotency(_repositoryId, key) {
        if (key === "stable-canary-plan:release-v038") return oldReceipt;
        if (key === "stable-canary-plan:release-v039") return newReceipt;
        return null;
      },
    };
    const operations: CanaryOperationService = {
      async getById(id) { return operationsById.get(id) ?? null; },
    };
    const makeCanary = () => new ServiceBackedDisposableCanary({
      binding: { ...binding, requestedModules: ["forms"], resourceProfileId: "small" },
      instances,
      configurations,
      operations,
      observations: {
        async latestHealth() { return null; },
        async writerAbsence() { return null; },
      },
      now: () => NOW,
    });

    const staleCleanup = await makeCanary().stop({
      runtimeId: "canary-instance",
      startedOperationId: "operation-v038",
      idempotencyKey: "stable-canary-stop:release-v038",
    });
    expect(staleCleanup).toEqual({ kind: "blocked" });
    expect(desiredStateCalls).toHaveLength(0);
    const failedCandidateCleanup = await makeCanary().stop({
      runtimeId: "canary-instance",
      startedOperationId: "operation-v039",
      idempotencyKey: "stable-canary-stop:release-v039",
    });
    expect(failedCandidateCleanup).toEqual({ kind: "blocked" });
    expect(desiredStateCalls).toHaveLength(0);

    const canary = makeCanary();
    const current = await canary.ensureRunning({
      release: newRelease,
      artifactDigest: newReceipt.revision.artifactDigest!,
      idempotencyKey: "stable-canary-runtime:release-v039",
    });
    expect(current).toEqual({ runtimeId: "canary-instance", operationId: "operation-v039" });

    // If a same-revision stop already completed, retry that selected revision
    // from its new current generation; never reuse its old generation-19 op.
    currentInstance = {
      ...currentInstance,
      generation: 20,
      desiredState: "stopped",
      observedState: "stopped",
    };
    const retried = await canary.ensureRunning({
      release: newRelease,
      artifactDigest: newReceipt.revision.artifactDigest!,
      idempotencyKey: "stable-canary-runtime:release-v039",
    });
    expect(retried).toEqual({ runtimeId: "canary-instance", operationId: "operation-v039-retry" });
    expect(desiredStateCalls).toHaveLength(1);
    expect(desiredStateCalls[0]).toMatchObject({
      expectedGeneration: 20,
      idempotencyKey: "stable-canary-runtime:release-v039:recovery:20",
    });

    currentInstance = {
      ...currentInstance,
      generation: 22,
      desiredState: "stopped",
      desiredRevisionId: "revision-v038",
      observedState: "stopped",
    };
    await expect(canary.ensureRunning({
      release: newRelease,
      artifactDigest: newReceipt.revision.artifactDigest!,
      idempotencyKey: "stable-canary-runtime:release-v039",
    })).rejects.toThrow(/no longer owns/u);
    expect(desiredStateCalls).toHaveLength(1);
  });

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
      let startOperation: {
        id: string;
        instanceId: string;
        repositoryId: number;
        kind: "start";
        status: "running" | "succeeded";
        generation: number;
        runtimeEpoch: number;
        deploymentRevisionId: string;
        result: null;
      } = {
        id: "operation-start-1",
        instanceId: "canary-instance",
        repositoryId: 900,
        kind: "start",
        status: "running",
        generation: 1,
        runtimeEpoch: 1,
        deploymentRevisionId: "revision-canary",
        result: null,
      };
      let currentInstance: CanaryPlanReceipt["instance"] = {
        ...receipt.instance,
        generation: startOperation.generation,
        runtimeEpoch: startOperation.runtimeEpoch,
        desiredState: "running" as const,
        desiredRevisionId: startOperation.deploymentRevisionId,
      };
      let stopOperation: {
        id: string;
        instanceId: string;
        repositoryId: number;
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
            const operation = stopOperation ??= {
              id: "operation-stop-1",
              instanceId: "canary-instance",
              repositoryId: 900,
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
              observedState: operation.status === "succeeded" ? "stopped" : "stopping",
              observedRuntimeEpoch: 1,
            };
            return { instance: currentInstance, operation };
          }
          startOperation = { ...startOperation, status: "running" };
          currentInstance = {
            ...currentInstance,
            generation: 1,
            runtimeEpoch: 1,
            desiredState: "running",
            observedState: "ready",
            observedRuntimeEpoch: 1,
            desiredRevisionId: "revision-canary",
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
          const currentReceipt = { ...receipt, instance: currentInstance, operation: startOperation };
          planned = currentReceipt;
          return currentReceipt;
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
      expect(calls).not.toContain("desired:running:true");
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

  it.each([
    { generation: 8, observed: "ready", recovery: "valid", expected: "blocked" },
    { generation: 9, observed: "stopped", recovery: "missing", expected: "blocked" },
    { generation: 9, observed: "stopped", recovery: "generation", expected: "blocked" },
    { generation: 9, observed: "stopped", recovery: "epoch", expected: "blocked" },
    { generation: 9, observed: "stopped", recovery: "revision", expected: "blocked" },
    { generation: 9, observed: "stopped", recovery: "proof", expected: "pending" },
    { generation: 9, observed: "stopped", recovery: "valid", expected: "stopped" },
  ] as const)("reconciles blocked stop receipts only with fenced recovery and writer proof: $recovery/$generation", async ({ generation, observed, recovery, expected }) => {
    const started = {
      id: "canary-start", instanceId: "canary-instance", repositoryId: 900,
      kind: "update" as const, status: "blocked" as const,
      generation: 7, runtimeEpoch: 4, deploymentRevisionId: "revision-canary", result: null,
    };
    const blocked = {
      id: "operation-stop-blocked", kind: "stop" as const, status: "blocked" as const,
      instanceId: "canary-instance", repositoryId: 900,
      generation: 8, runtimeEpoch: 4, deploymentRevisionId: "revision-canary",
      result: null,
    };
    let currentInstance: CanaryPlanReceipt["instance"] = {
      ...planReceipt().instance,
      generation: 7,
      runtimeEpoch: 4,
      desiredState: "running",
      desiredRevisionId: "revision-canary",
      observedState: "ready",
      observedRuntimeEpoch: 4,
    };
    const canary = new ServiceBackedDisposableCanary({
      binding: {
        repositoryId: 900, instanceId: "canary-instance", bindingEpoch: 3,
        authorizationRevision: 4, requestedModules: [], resourceProfileId: "small",
      },
      instances: {
        async getByRepositoryId() {
          return {
            binding: { repositoryId: 900, instanceId: "canary-instance",
              bindingEpoch: 3, authorizationRevision: 4, suspended: false },
            instance: currentInstance,
          };
        },
        async requestDesiredState(input) {
          expect(input.expectedGeneration).toBe(7);
          currentInstance = { ...currentInstance, generation, runtimeEpoch:4,
            desiredRevisionId:"revision-canary", observedRuntimeEpoch: 4,
            desiredState:"stopped", observedState:observed };
          return { instance: currentInstance, operation: blocked };
        },
      },
      configurations: {
        async plan() { throw new Error("unexpected plan"); },
        async findByIdempotency() { return null; },
      },
      operations: {
        async getById(operationId) { return operationId === "canary-start" ? started : blocked; },
        async findSucceededStop(input) {
          expect(input).toEqual({instanceId:"canary-instance",repositoryId:900,generation:9,runtimeEpoch:4});
          return recovery === "missing" ? null : {
            ...blocked, id:"operation-stop-recovered", status:"succeeded" as const,
            generation: recovery === "generation" ? 8 : 9,
            runtimeEpoch: recovery === "epoch" ? 5 : 4,
            deploymentRevisionId: recovery === "revision" ? "other-revision" : "revision-canary",
          };
        },
      },
      observations: {
        async latestHealth() { throw new Error("unexpected health"); },
        async writerAbsence(input) {
          expect(expected).not.toBe("blocked");
          expect(input.afterOperationId).toBe("operation-stop-recovered");
          return recovery === "proof" ? null : {
            instanceId:"canary-instance",repositoryId:900,retiredEpoch:4,
            providerObservationId:"recovered-census",censusObservedAt:NOW,
            remainingWriters:0,evidenceIdentities:[],source:"runtime-provider-census",
          };
        },
      },
      now: () => NOW,
    });
    const result = await canary.stop({
      runtimeId:"canary-instance", startedOperationId:"canary-start",
      idempotencyKey:"stable-canary-stop:release-1",
    });
    expect(result.kind).toBe(expected);
    if (result.kind === "stopped") expect(result.evidence.operationId).toBe("operation-stop-recovered");
  });

});
