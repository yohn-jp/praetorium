import { describe, expect, it } from "vitest";
import { LifecycleService } from "./service.js";
import { isPersistenceRollbackCompatible, SCRIPTORIUM_PLATFORM_CONTRACT_VERSION } from "./index.js";
import type {
  LifecycleAuthProbeProvider,
  LifecycleDependencies,
  LifecycleJournal,
  LifecycleOperation,
  LifecycleReadinessEvidence,
  LifecycleRuntimeProvider,
  ProducerStatus,
  QuiesceRequest,
  QuiesceReceipt,
  RuntimeAssignment,
  RuntimeDeployment,
  RuntimeEpoch,
  RuntimeReadiness,
  RollbackCompatibilityEvidence,
  WriterCensus,
} from "./ports.js";

const digestA = `sha256:${"a".repeat(64)}`;
const digestB = `sha256:${"b".repeat(64)}`;
const platformDigest = `sha256:${"d".repeat(64)}`;

function deployment(revisionId = "rev-a", imageDigest = digestA): RuntimeDeployment {
  return {
    revisionId,
    repositoryId: 123456,
    repositoryLocator: "https://github.com/owner/repository",
    defaultBranchPolicy: "repository-default",
    imageDigest,
    artifactRef: `ghcr.io/praetorium/scriptorium@${imageDigest}`,
    platformManifestDigest: platformDigest,
    compositionManifestDigest: digestB,
    persistence: {
      contractVersion: "scriptorium-persistence/v1",
      readable: [
        { formatId: "scriptorium.git-operations", versions: [1] },
        { formatId: "scriptorium.git-publications", versions: [1] },
        { formatId: "scriptorium.git-proposal-legacy", versions: [1] },
        { formatId: "scriptorium.git-proposal-binding", versions: [2] },
        { formatId: "scriptorium.git-proposal-complete", versions: [2] },
        { formatId: "scriptorium.browser-recovery-indexeddb", versions: [3] },
      ],
      writable: [
        { formatId: "scriptorium.git-operations", version: 1 },
        { formatId: "scriptorium.git-publications", version: 1 },
        { formatId: "scriptorium.git-proposal-binding", version: 2 },
        { formatId: "scriptorium.git-proposal-complete", version: 2 },
        { formatId: "scriptorium.browser-recovery-indexeddb", version: 3 },
      ],
    },
    enabledModuleIds: ["core", "notes"],
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
    runtimeMetadata: {
      producerRevision: "a".repeat(40),
      listenerPort: 3000,
      livenessPath: "/health/live",
      readinessPath: "/health/ready",
      metadataPath: "/api/platform/v1/metadata",
      shutdownPath: "/shutdown",
      statusPath: "/api/platform/v1/status",
      quiescePath: "/api/platform/v1/quiesce",
      resumePath: "/api/platform/v1/resume",
      shutdownTimeoutSeconds: 30,
    },
    hostname: "instance.example.test",
    resourceProfileId: "small",
    resources: { cpuMilli: 500, memoryMiB: 512, ephemeralStorageMiB: 256 },
  };
}

function assignment(runtimeEpoch: RuntimeEpoch, value = deployment()): RuntimeAssignment {
  return {
    instanceId: "ins_01",
    repositoryId: 123456,
    runtimeEpoch,
    generation: 2,
    clusterId: "cluster-a",
    reservationId: `reservation-${runtimeEpoch}`,
    deployment: value,
  };
}

function operation(overrides: Partial<LifecycleOperation> = {}): LifecycleOperation {
  return {
    id: "op-01",
    version: 0,
    instanceId: "ins_01",
    repositoryId: 123456,
    clusterId: "cluster-a",
    generation: 2,
    kind: "redeploy",
    reason: "redeploy",
    phase: "accepted",
    runtimeEpoch: 5,
    targetRevisionId: "rev-a",
    current: assignment(4),
    target: null,
    targetEpoch: null,
    targetReservationId: null,
    rollbackEpoch: null,
    quiesceRequest: null,
    quiesceReceipt: null,
    writerAbsenceProof: null,
    readinessEvidence: null,
    rollbackCompatibilityEvidence: null,
    rollbackCompatible: null,
    buildId: null,
    failureCode: null,
    failureReason: null,
    lastAuthenticatedActivityAt: "2026-10-17T00:00:00.000Z",
    ...overrides,
  };
}

class MemoryJournal implements LifecycleJournal {
  value: LifecycleOperation;

  constructor(initial: LifecycleOperation) {
    this.value = initial;
  }

  async load(operationId: string): Promise<LifecycleOperation | null> {
    return operationId === this.value.id ? this.value : null;
  }

  async advance(
    operationId: string,
    expectedVersion: number,
    patch: Partial<Omit<LifecycleOperation, "id" | "version">>,
  ): Promise<LifecycleOperation | null> {
    if (operationId !== this.value.id || expectedVersion !== this.value.version) return null;
    this.value = { ...this.value, ...patch, version: this.value.version + 1 };
    return this.value;
  }

  async allocateRollbackEpoch(_operationId: string, failedEpoch: number): Promise<number> {
    return failedEpoch + 1;
  }
}

interface HarnessOptions {
  readonly operation?: LifecycleOperation;
  readonly build?: LifecycleDependencies["builds"];
  readonly quiesce?: QuiesceReceipt | ((request: QuiesceRequest) => QuiesceReceipt);
  readonly leaveWriterAfterStop?: boolean;
  readonly crashAfterStart?: boolean;
  readonly crashAfterStartEpoch?: number;
  readonly crashAfterActivation?: boolean;
  readonly crashAfterActivationEpoch?: number;
  readonly readiness?: (assignment: RuntimeAssignment) => RuntimeReadiness;
  readonly initialWriters?: readonly RuntimeAssignment[];
  readonly compatibleRollback?: boolean;
  readonly now?: () => number;
  readonly producerObservedAt?: string | (() => string);
  readonly authObservedAt?: string;
  readonly readinessTimeoutMs?: number;
  readonly quiesceTimeoutMs?: number;
  readonly resumeFailure?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const journal = new MemoryJournal(options.operation ?? operation());
  const writers: RuntimeAssignment[] =
    options.initialWriters === undefined
      ? journal.value.current === null
        ? []
        : [journal.value.current]
      : [...options.initialWriters];
  const counters = {
    quiesces: [] as { readonly operationId: string; readonly runtimeEpoch: number }[],
    resumes: [] as string[],
    stops: [] as number[],
    starts: [] as number[],
    activations: [] as {
      readonly assignment: RuntimeAssignment;
      readonly evidence: LifecycleReadinessEvidence;
    }[],
    authProbeCalls: 0,
    deactivations: 0,
    released: [] as string[],
  };
  let crashedAfterStart = false;
  let crashedAfterActivation = false;
  const census = (): WriterCensus => ({
    complete: true,
    providerObservationId: `pods-rv-${counters.stops.length}-${counters.starts.length}-${writers.length}`,
    observedAt: new Date(options.now?.() ?? Date.now()).toISOString(),
    matchedWriterCount: writers.length,
    writers: writers.map((item) => ({
      runtimeEpoch: item.runtimeEpoch,
      phase: "running",
      identities: [`pod-${item.runtimeEpoch}`],
    })),
  });
  const producerStatus = (value: RuntimeAssignment): ProducerStatus => ({
    contractVersion: SCRIPTORIUM_PLATFORM_CONTRACT_VERSION,
    instanceId: value.instanceId,
    repositoryId: value.repositoryId,
    runtimeEpoch: value.runtimeEpoch,
    imageDigest: value.deployment.imageDigest,
    compositionManifestDigest: value.deployment.compositionManifestDigest,
    enabledModuleIds: value.deployment.enabledModuleIds,
    ready: true,
    activity: {
      lastMeaningfulActivityAt: "2026-10-17T00:00:00.000Z",
      activeApiRequests: 0,
      activeMcpRequests: 0,
      activeMutations: 0,
      activeJobs: 0,
      restartableJobs: 0,
      pendingCheckpoints: 0,
      uncertainPublication: false,
    },
    lastConfirmedRemoteRevision: "a".repeat(40),
    persistence: {
      state: "verified",
      observedRemoteCommit: "a".repeat(40),
      formats: [
        { formatId: "scriptorium.git-operations", version: 1 },
        { formatId: "scriptorium.git-publications", version: 1 },
        { formatId: "scriptorium.git-proposal-binding", version: 2 },
        { formatId: "scriptorium.git-proposal-complete", version: 2 },
      ],
    },
    observedAt:
      typeof options.producerObservedAt === "function"
        ? options.producerObservedAt()
        : (options.producerObservedAt ?? new Date(options.now?.() ?? Date.now()).toISOString()),
  });
  const runtime: LifecycleRuntimeProvider = {
    async censusWriters() {
      return census();
    },
    async stop(value) {
      counters.stops.push(value.runtimeEpoch);
      if (!options.leaveWriterAfterStop) {
        const index = writers.findIndex((writer) => writer.runtimeEpoch === value.runtimeEpoch);
        if (index >= 0) writers.splice(index, 1);
      }
    },
    async start(value) {
      counters.starts.push(value.runtimeEpoch);
      if (!writers.some((writer) => writer.runtimeEpoch === value.runtimeEpoch))
        writers.push(value);
      if (
        !crashedAfterStart &&
        (options.crashAfterStart || options.crashAfterStartEpoch === value.runtimeEpoch)
      ) {
        crashedAfterStart = true;
        throw new Error("simulated worker exit after runtime start");
      }
    },
    async readiness(value) {
      return (
        options.readiness?.(value) ?? {
          status: "ready",
          assignment: value,
          providerObservationId: `runtime-observation-${value.runtimeEpoch}`,
          actualImageDigest: value.deployment.platformManifestDigest,
          imageIdentityVerified: true,
          producer: producerStatus(value),
        }
      );
    },
  };
  const safeReceipt = (request: QuiesceRequest): QuiesceReceipt => ({
    contractVersion: SCRIPTORIUM_PLATFORM_CONTRACT_VERSION,
    operationId: request.operationId,
    instanceId: request.instanceId,
    runtimeEpoch: request.runtimeEpoch,
    quiesceRevision: `q-${request.operationId}-${request.runtimeEpoch}`,
    disposition: "safe",
    activeMutations: 0,
    activeJobs: 0,
    restartableJobs: 0,
    pendingCheckpoints: 0,
    uncertainPublication: false,
    lastConfirmedRemoteRevision: "a".repeat(40),
    reasonCodes: [],
    observedAt: new Date(options.now?.() ?? Date.now()).toISOString(),
  });
  const authProbe: LifecycleAuthProbeProvider = {
    async verify(value) {
      counters.authProbeCalls += 1;
      const prefix = `auth-${value.runtimeEpoch}`;
      return {
        applicationProbeId: `app-${prefix}`,
        uiApiMcpProbeId: `ui-api-mcp-${prefix}`,
        persistenceProbeId: `persistence-${prefix}`,
        grantPolicyMatched: true,
        controlServicePolicyMatched: true,
        validGrantAccepted: true,
        wrongRepositoryGrantRejected: true,
        wrongEpochGrantRejected: true,
        invalidServiceCredentialRejected: true,
        validGrantProbeId: `grant-${prefix}`,
        wrongRepositoryProbeId: `wrong-repo-${prefix}`,
        wrongEpochProbeId: `wrong-epoch-${prefix}`,
        invalidServiceCredentialProbeId: `bad-service-${prefix}`,
        observedAt: options.authObservedAt ?? new Date(options.now?.() ?? Date.now()).toISOString(),
      };
    },
  };
  const dependencies: LifecycleDependencies = {
    journal,
    builds: options.build ?? {
      async resolveOrBuild() {
        return { status: "admitted", deployment: deployment() };
      },
      async isRollbackCompatible(previous, target, evidence) {
        return (
          options.compatibleRollback === true &&
          isPersistenceRollbackCompatible(previous, target, evidence)
        );
      },
    },
    capacity: {
      async reserve() {
        return { status: "reserved", reservationId: "reservation-target" };
      },
      async release(reservationId) {
        counters.released.push(reservationId);
      },
    },
    producer: {
      async status(value) {
        return producerStatus(value);
      },
      async quiesce(request) {
        counters.quiesces.push({
          operationId: request.operationId,
          runtimeEpoch: request.runtimeEpoch,
        });
        return typeof options.quiesce === "function"
          ? options.quiesce(request)
          : (options.quiesce ?? safeReceipt(request));
      },
      async resume(request) {
        counters.resumes.push(request.operationId);
        if (options.resumeFailure) throw new Error("matching resume could not be confirmed");
      },
    },
    authProbe,
    runtime,
    routes: {
      async activate(value, evidence) {
        counters.activations.push({ assignment: value, evidence });
        if (
          !crashedAfterActivation &&
          (options.crashAfterActivation || options.crashAfterActivationEpoch === value.runtimeEpoch)
        ) {
          crashedAfterActivation = true;
          throw new Error("simulated worker exit after route activation");
        }
      },
      async deactivate() {
        counters.deactivations += 1;
      },
    },
    ...(options.now === undefined ? {} : { now: options.now }),
    readinessTimeoutMs: options.readinessTimeoutMs ?? 20,
    quiesceTimeoutMs: options.quiesceTimeoutMs ?? 20,
    pollIntervalMs: 1,
  };
  const service = new LifecycleService(dependencies);
  return {
    service,
    journal,
    writers,
    counters,
    context: {
      signal: new AbortController().signal,
      async assertLease() {},
    },
  };
}

describe("LifecycleService", () => {
  it("re-observes the exact ready target before reporting a recovered completed replacement", async () => {
    const target = assignment(5);
    const h = harness({
      operation: operation({
        phase: "complete",
        target: target.deployment,
        targetEpoch: target.runtimeEpoch,
        targetReservationId: target.reservationId,
        writerAbsenceProof: {
          instanceId: "ins_01",
          repositoryId: 123456,
          retiredRuntimeEpoch: 4,
          providerObservationId: "pods-rv-before-start",
          censusObservedAt: new Date().toISOString(),
          remainingWriters: 0,
          evidenceIdentities: [],
          source: "runtime-provider-census",
        },
      }),
      initialWriters: [target],
    });

    const result = await h.service.execute("op-01", h.context);

    expect(result).toEqual({ status: "complete", observed: target });
    expect(h.counters.authProbeCalls).toBeGreaterThan(0);
  });

  it("does not report a completed replacement when its target is no longer the sole writer", async () => {
    const target = assignment(5);
    const h = harness({
      operation: operation({
        phase: "complete",
        target: target.deployment,
        targetEpoch: target.runtimeEpoch,
        targetReservationId: target.reservationId,
        writerAbsenceProof: {
          instanceId: "ins_01",
          repositoryId: 123456,
          retiredRuntimeEpoch: 4,
          providerObservationId: "pods-rv-before-start",
          censusObservedAt: new Date().toISOString(),
          remainingWriters: 0,
          evidenceIdentities: [],
          source: "runtime-provider-census",
        },
      }),
      initialWriters: [],
    });

    const result = await h.service.execute("op-01", h.context);

    expect(result).toMatchObject({ status: "unknown", code: "completed_target_writer_mismatch" });
    expect(h.counters.authProbeCalls).toBe(0);
  });

  it("re-censuses a completed stop before publishing stopped observation", async () => {
    const h = harness({
      operation: operation({
        kind: "stop",
        phase: "complete",
        target: null,
        targetEpoch: null,
        writerAbsenceProof: {
          instanceId: "ins_01",
          repositoryId: 123456,
          retiredRuntimeEpoch: 4,
          providerObservationId: "pods-rv-stopped",
          censusObservedAt: new Date().toISOString(),
          remainingWriters: 0,
          evidenceIdentities: [],
          source: "runtime-provider-census",
        },
      }),
      initialWriters: [],
    });

    const result = await h.service.execute("op-01", h.context);

    expect(result).toEqual({ status: "complete", observed: null });
  });

  it("keeps the current writer active while the target artifact is still building", async () => {
    const current = assignment(4);
    const h = harness({
      operation: operation({ current }),
      build: {
        async resolveOrBuild() {
          return { status: "pending", buildId: "build-1" };
        },
        async isRollbackCompatible() {
          return false;
        },
      },
    });

    const result = await h.service.execute("op-01", h.context);

    expect(result).toEqual({
      status: "waiting",
      phase: "waiting-for-artifact",
      reason: "target artifact is still building; current runtime remains active",
    });
    expect(h.writers.map((writer) => writer.runtimeEpoch)).toEqual([4]);
    expect(h.counters.quiesces).toHaveLength(0);
    expect(h.counters.stops).toHaveLength(0);
    expect(h.counters.starts).toHaveLength(0);
  });

  it("resumes the matching producer quiesce and blocks retirement with a checkpoint", async () => {
    const h = harness({
      quiesce: (request) => ({
        contractVersion: SCRIPTORIUM_PLATFORM_CONTRACT_VERSION,
        operationId: request.operationId,
        instanceId: request.instanceId,
        runtimeEpoch: request.runtimeEpoch,
        quiesceRevision: "q-1",
        disposition: "blocked",
        activeMutations: 0,
        activeJobs: 1,
        restartableJobs: 0,
        pendingCheckpoints: 1,
        uncertainPublication: false,
        lastConfirmedRemoteRevision: "a".repeat(40),
        reasonCodes: ["PENDING_CHECKPOINT"],
        observedAt: new Date().toISOString(),
      }),
    });

    const result = await h.service.execute("op-01", h.context);

    expect(result.status).toBe("blocked");
    expect(h.counters.resumes).toEqual(["op-01"]);
    expect(h.journal.value.quiesceRequest).toBeNull();
    expect(h.counters.stops).toHaveLength(0);
    expect(h.counters.starts).toHaveLength(0);
  });

  it("retains retirement authority fences when matching resume is unconfirmed", async () => {
    const h = harness({
      resumeFailure: true,
      quiesce: (request) => ({
        contractVersion: SCRIPTORIUM_PLATFORM_CONTRACT_VERSION,
        operationId: request.operationId,
        instanceId: request.instanceId,
        runtimeEpoch: request.runtimeEpoch,
        quiesceRevision: "q-unconfirmed-resume",
        disposition: "blocked",
        activeMutations: 0,
        activeJobs: 0,
        restartableJobs: 0,
        pendingCheckpoints: 1,
        uncertainPublication: false,
        lastConfirmedRemoteRevision: "a".repeat(40),
        reasonCodes: ["PENDING_CHECKPOINT"],
        observedAt: new Date().toISOString(),
      }),
    });
    const result = await h.service.execute("op-01", h.context);
    expect(result.status).toBe("blocked");
    expect(h.journal.value.quiesceRequest?.operationId).toBe("op-01");
    expect(h.counters.stops).toHaveLength(0);
    expect(h.counters.starts).toHaveLength(0);
  });

  it("rejects a safe quiesce observation recorded at its deadline", async () => {
    const clock = 1_800_000_000_000;
    const h = harness({
      now: () => clock,
      quiesceTimeoutMs: 10,
      quiesce: (request) => ({
        contractVersion: SCRIPTORIUM_PLATFORM_CONTRACT_VERSION,
        operationId: request.operationId,
        instanceId: request.instanceId,
        runtimeEpoch: request.runtimeEpoch,
        quiesceRevision: "q-late-observation",
        disposition: "safe",
        activeMutations: 0,
        activeJobs: 0,
        restartableJobs: 0,
        pendingCheckpoints: 0,
        uncertainPublication: false,
        lastConfirmedRemoteRevision: "a".repeat(40),
        reasonCodes: [],
        observedAt: request.deadline,
      }),
    });

    const result = await h.service.execute("op-01", h.context);

    expect(result.status).toBe("unknown");
    expect(h.counters.resumes).toEqual(["op-01"]);
    expect(h.journal.value.quiesceRequest).toBeNull();
    expect(h.counters.stops).toHaveLength(0);
  });

  it("rejects a safe quiesce result received at the deadline", async () => {
    let clock = 1_800_000_000_000;
    const h = harness({
      now: () => clock,
      quiesceTimeoutMs: 10,
      quiesce: (request) => {
        const observationTime = clock;
        clock = Date.parse(request.deadline);
        return {
          contractVersion: SCRIPTORIUM_PLATFORM_CONTRACT_VERSION,
          operationId: request.operationId,
          instanceId: request.instanceId,
          runtimeEpoch: request.runtimeEpoch,
          quiesceRevision: "q-late-receive",
          disposition: "safe",
          activeMutations: 0,
          activeJobs: 0,
          restartableJobs: 0,
          pendingCheckpoints: 0,
          uncertainPublication: false,
          lastConfirmedRemoteRevision: "a".repeat(40),
          reasonCodes: [],
          observedAt: new Date(observationTime).toISOString(),
        };
      },
    });

    const result = await h.service.execute("op-01", h.context);

    expect(result.status).toBe("unknown");
    expect(h.counters.resumes).toEqual(["op-01"]);
    expect(h.counters.stops).toHaveLength(0);
  });

  it("reuses a timely persisted quiesce receipt after a worker crash past its deadline", async () => {
    let clock = 1_800_000_000_000;
    const h = harness({ now: () => clock, quiesceTimeoutMs: 10 });
    const firstContext = {
      ...h.context,
      async report(phase: string) {
        if (phase === "old-quiesced")
          throw new Error("simulated worker exit after durable quiesce checkpoint");
      },
    };

    await expect(h.service.execute("op-01", firstContext)).rejects.toThrow("simulated worker exit");
    expect(h.journal.value.phase).toBe("old-quiesced");
    expect(h.journal.value.quiesceReceipt?.observedAt).toBe(new Date(clock).toISOString());
    clock += 11;

    const recovered = await h.service.execute("op-01", h.context);

    expect(recovered).toMatchObject({ status: "complete" });
    expect(h.counters.quiesces).toHaveLength(1);
    expect(h.counters.stops).toEqual([4]);
  });

  it("does not treat a lease timeout as proof that the old writer stopped", async () => {
    const h = harness({ leaveWriterAfterStop: true, quiesceTimeoutMs: 5 });

    const result = await h.service.execute("op-01", h.context);

    expect(result.status).toBe("unknown");
    expect(h.counters.stops).toEqual([4]);
    expect(h.counters.starts).toHaveLength(0);
    expect(h.writers.map((writer) => writer.runtimeEpoch)).toEqual([4]);
  });

  it("redeploys an unchanged digest under a new epoch and activates only with live evidence", async () => {
    const h = harness({ operation: operation({ kind: "redeploy", runtimeEpoch: 5 }) });

    const result = await h.service.execute("op-01", h.context);

    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected completion");
    expect(result.observed?.runtimeEpoch).toBe(5);
    expect(h.counters.stops).toEqual([4]);
    expect(h.counters.starts).toEqual([5]);
    expect(h.counters.activations).toHaveLength(1);
    expect(h.counters.activations[0]?.evidence.actualImageDigest).toBe(platformDigest);
    expect(h.counters.activations[0]?.evidence.providerObservationId).toBe("runtime-observation-5");
    expect(h.counters.activations[0]?.evidence.validGrantProbeId).toBe("grant-auth-5");
  });

  it("does not activate a target whose actual image digest differs from its admitted digest", async () => {
    const h = harness({
      readinessTimeoutMs: 2,
      readiness: (value) => ({
        status: "ready",
        assignment: value,
        providerObservationId: "runtime-observation",
        actualImageDigest: digestB,
        imageIdentityVerified: true,
        producer: null,
      }),
    });

    const result = await h.service.execute("op-01", h.context);

    expect(result.status).toBe("unknown");
    expect(h.counters.activations).toHaveLength(0);
  });

  it("does not activate on stale producer status or stale authentication probes", async () => {
    const now = Date.now();
    let producerTicks = 0;
    const staleProducer = harness({
      now: () => now + producerTicks++ * 10,
      producerObservedAt: new Date(now - 60_000).toISOString(),
      readinessTimeoutMs: 1_000,
      quiesceTimeoutMs: 10_000,
    });
    const staleProducerResult = await staleProducer.service.execute("op-01", staleProducer.context);
    expect(staleProducerResult.status).toBe("unknown");
    expect(staleProducer.counters.authProbeCalls).toBe(0);
    expect(staleProducer.counters.activations).toHaveLength(0);

    let authTicks = 0;
    const staleAuth = harness({
      now: () => now + authTicks++ * 10,
      producerObservedAt: () => new Date(now + authTicks++).toISOString(),
      authObservedAt: new Date(now - 60_000).toISOString(),
      readinessTimeoutMs: 1_000,
      quiesceTimeoutMs: 10_000,
    });
    const staleAuthResult = await staleAuth.service.execute("op-01", staleAuth.context);
    expect(staleAuthResult.status).toBe("unknown");
    expect(staleAuth.counters.authProbeCalls).toBeGreaterThan(0);
    expect(staleAuth.counters.activations).toHaveLength(0);
  });

  it("recovers a worker exit after the target starts without starting a second writer", async () => {
    const h = harness({ crashAfterStart: true });

    await expect(h.service.execute("op-01", h.context)).rejects.toThrow("simulated worker exit");
    expect(h.journal.value.phase).toBe("starting-target");
    expect(h.writers.map((writer) => writer.runtimeEpoch)).toEqual([5]);

    const recovered = await h.service.execute("op-01", h.context);

    expect(recovered.status).toBe("complete");
    expect(h.counters.starts).toEqual([5]);
    expect(h.counters.stops).toEqual([4]);
    expect(h.counters.activations).toHaveLength(1);
  });

  it("recovers an endpoint activation whose worker exited before its checkpoint", async () => {
    const h = harness({ crashAfterActivation: true });

    await expect(h.service.execute("op-01", h.context)).rejects.toThrow("simulated worker exit");
    expect(h.journal.value.phase).toBe("target-ready");

    const recovered = await h.service.execute("op-01", h.context);

    expect(recovered.status).toBe("complete");
    expect(h.counters.starts).toEqual([5]);
    expect(h.counters.stops).toEqual([4]);
    expect(h.counters.activations).toHaveLength(2);
    expect(h.counters.activations[0]?.assignment.runtimeEpoch).toBe(5);
    expect(h.counters.activations[1]?.assignment.runtimeEpoch).toBe(5);
  });

  it("uses the same quiesce and writer fences for a compatible rollback", async () => {
    let ticks = 0;
    const h = harness({
      operation: operation({
        kind: "update",
        reason: "update",
        runtimeEpoch: 5,
        targetRevisionId: "rev-b",
      }),
      build: {
        async resolveOrBuild() {
          return { status: "admitted", deployment: deployment("rev-b", digestB) };
        },
        async isRollbackCompatible(previous, target, evidence) {
          return isPersistenceRollbackCompatible(previous, target, evidence);
        },
      },
      readinessTimeoutMs: 40,
      quiesceTimeoutMs: 40,
      now: () => ticks++ * 10,
      readiness: (value) => {
        if (value.deployment.revisionId === "rev-b") {
          return {
            status: "not-ready",
            assignment: value,
            providerObservationId: `observation-${value.runtimeEpoch}`,
            actualImageDigest: null,
            imageIdentityVerified: false,
            producer: null,
            reasonCode: "artifact_failed_readiness",
          };
        }
        return {
          status: "ready",
          assignment: value,
          providerObservationId: `observation-${value.runtimeEpoch}`,
          actualImageDigest: value.deployment.platformManifestDigest,
          imageIdentityVerified: true,
          producer: null,
        };
      },
    });

    const result = await h.service.execute("op-01", h.context);

    expect(result.status).toBe("failed");
    expect(h.journal.value.phase).toBe("failed");
    expect(h.counters.starts).toEqual([5, 6]);
    expect(h.counters.stops).toEqual([4, 5]);
    expect(h.counters.activations).toHaveLength(1);
    expect(h.counters.activations[0]?.assignment.deployment.revisionId).toBe("rev-a");
    expect(h.counters.activations[0]?.assignment.runtimeEpoch).toBe(6);
    expect(h.counters.quiesces).toEqual([
      { operationId: "op-01", runtimeEpoch: 4 },
      { operationId: "op-01:rollback", runtimeEpoch: 5 },
    ]);
    expect(h.journal.value.rollbackCompatibilityEvidence).toMatchObject({
      runtimeEpoch: 5,
      imageDigest: digestB,
      compositionManifestDigest: digestB,
      observedRemoteCommit: "a".repeat(40),
      quiesceRemoteCommit: "a".repeat(40),
    });
    expect(h.journal.value.rollbackCompatible).toBe(true);
  });

  it("resumes failed-target retirement when a worker exits after rollback quiesce", async () => {
    let oldQuiescedReports = 0;
    const h = harness({
      operation: operation({
        kind: "update",
        reason: "update",
        runtimeEpoch: 5,
        targetRevisionId: "rev-b",
      }),
      build: {
        async resolveOrBuild() {
          return { status: "admitted", deployment: deployment("rev-b", digestB) };
        },
        async isRollbackCompatible(previous, target, evidence) {
          return isPersistenceRollbackCompatible(previous, target, evidence);
        },
      },
      readinessTimeoutMs: 20,
      quiesceTimeoutMs: 20,
      readiness: (value) => ({
        status: value.deployment.revisionId === "rev-b" ? "not-ready" : "ready",
        assignment: value,
        providerObservationId: `observation-${value.runtimeEpoch}`,
        actualImageDigest:
          value.deployment.revisionId === "rev-b" ? null : value.deployment.platformManifestDigest,
        imageIdentityVerified: value.deployment.revisionId !== "rev-b",
        producer: null,
      }),
    });
    const crashAtRollbackQuiesce = {
      ...h.context,
      async report(phase: string) {
        if (phase === "old-quiesced" && ++oldQuiescedReports === 2)
          throw new Error("simulated worker exit after rollback quiesce");
      },
    };

    await expect(h.service.execute("op-01", crashAtRollbackQuiesce)).rejects.toThrow(
      "simulated worker exit after rollback quiesce",
    );
    expect(h.journal.value.quiesceRequest?.reason).toBe("rollback");
    expect(h.journal.value.rollbackCompatible).toBeNull();

    const recovered = await h.service.execute("op-01", h.context);

    expect(recovered.status).toBe("failed");
    expect(h.journal.value.rollbackCompatible).toBe(true);
    expect(h.journal.value.rollbackEpoch).toBe(6);
    expect(h.counters.stops).toEqual([4, 5]);
    expect(h.counters.starts).toEqual([5, 6]);
  });

  it("finishes a compatible rollback after a worker exits just after starting its fresh epoch", async () => {
    let ticks = 0;
    const h = harness({
      operation: operation({
        kind: "update",
        reason: "update",
        runtimeEpoch: 5,
        targetRevisionId: "rev-b",
      }),
      build: {
        async resolveOrBuild() {
          return { status: "admitted", deployment: deployment("rev-b", digestB) };
        },
        async isRollbackCompatible(previous, target, evidence) {
          return isPersistenceRollbackCompatible(previous, target, evidence);
        },
      },
      crashAfterStartEpoch: 6,
      readinessTimeoutMs: 40,
      quiesceTimeoutMs: 40,
      now: () => ticks++ * 10,
      readiness: (value) => ({
        status: value.runtimeEpoch === 5 ? "not-ready" : "ready",
        assignment: value,
        providerObservationId: `observation-${value.runtimeEpoch}`,
        actualImageDigest:
          value.runtimeEpoch === 5 ? null : value.deployment.platformManifestDigest,
        imageIdentityVerified: value.runtimeEpoch !== 5,
        producer: null,
      }),
    });

    await expect(h.service.execute("op-01", h.context)).rejects.toThrow("simulated worker exit");
    expect(h.journal.value.rollbackEpoch).toBe(6);
    expect(h.journal.value.phase).toBe("starting-target");

    const recovered = await h.service.execute("op-01", h.context);

    expect(recovered.status).toBe("failed");
    expect(h.journal.value.phase).toBe("failed");
    expect(h.writers.map((writer) => writer.runtimeEpoch)).toEqual([6]);
    expect(h.counters.starts).toEqual([5, 6]);
    expect(h.counters.activations.map(({ assignment: value }) => value.runtimeEpoch)).toEqual([6]);
  });
});

describe("persistence rollback compatibility", () => {
  function evidence(
    target: RuntimeDeployment,
    overrides: Partial<RollbackCompatibilityEvidence> = {},
  ): RollbackCompatibilityEvidence {
    return {
      contractVersion: "praetorium-rollback-compatibility/v1",
      instanceId: "ins_01",
      repositoryId: target.repositoryId,
      runtimeEpoch: 5,
      imageDigest: target.imageDigest,
      compositionManifestDigest: target.compositionManifestDigest,
      providerObservationId: "pods-rv-17",
      providerObservedAt: "2026-10-17T00:00:01.000Z",
      observedAt: "2026-10-17T00:00:02.000Z",
      observedRemoteCommit: "a".repeat(40),
      quiesceRevision: "q-op-01-5",
      quiesceRemoteCommit: "a".repeat(40),
      formats: [
        { formatId: "scriptorium.git-operations", version: 1 },
        { formatId: "scriptorium.git-publications", version: 1 },
        { formatId: "scriptorium.git-proposal-legacy", version: 1 },
        { formatId: "scriptorium.git-proposal-binding", version: 2 },
        { formatId: "scriptorium.git-proposal-complete", version: 2 },
      ],
      ...overrides,
    };
  }

  it("accepts exact target writes and observed read-only legacy data", () => {
    const previous = deployment("rev-a", digestA);
    const target = deployment("rev-b", digestB);

    expect(isPersistenceRollbackCompatible(previous, target, evidence(target))).toBe(true);
  });

  it("rejects persisted versions the previous image cannot read", () => {
    const previous = deployment("rev-a", digestA);
    const target = deployment("rev-b", digestB);

    expect(
      isPersistenceRollbackCompatible(
        previous,
        target,
        evidence(target, {
          formats: [{ formatId: "scriptorium.git-proposal-legacy", version: 2 }],
        }),
      ),
    ).toBe(false);
  });

  it("rejects a target write version the previous image cannot read", () => {
    const previous = deployment("rev-a", digestA);
    const target = deployment("rev-b", digestB);
    const incompatibleTarget = {
      ...target,
      persistence: {
        ...target.persistence!,
        writable: [
          ...target.persistence!.writable,
          { formatId: "scriptorium.git-proposal-binding", version: 3 },
        ],
      },
    };

    expect(
      isPersistenceRollbackCompatible(previous, incompatibleTarget, evidence(incompatibleTarget)),
    ).toBe(false);
  });

  it("allows the previous image to keep writing its own version after reading target writes", () => {
    const previous = deployment("rev-a", digestA);
    const target = deployment("rev-b", digestB);
    const { persistence: previousPersistence, ...previousWithoutPersistence } = previous;
    const directionalPrevious: RuntimeDeployment = {
      ...previousWithoutPersistence,
      persistence: {
        ...previousPersistence!,
        writable: previousPersistence!.writable.filter(
          (item) => item.formatId !== "scriptorium.git-proposal-binding",
        ),
      },
    };

    expect(isPersistenceRollbackCompatible(directionalPrevious, target, evidence(target))).toBe(
      true,
    );
  });

  it("rejects missing legacy manifest declarations and a remote commit mismatch", () => {
    const previous = deployment("rev-a", digestA);
    const target = deployment("rev-b", digestB);
    const legacyPrevious = { ...previous };
    delete legacyPrevious.persistence;

    expect(isPersistenceRollbackCompatible(legacyPrevious, target, evidence(target))).toBe(false);
    expect(
      isPersistenceRollbackCompatible(
        previous,
        target,
        evidence(target, { observedRemoteCommit: "b".repeat(40) }),
      ),
    ).toBe(false);
  });
});
