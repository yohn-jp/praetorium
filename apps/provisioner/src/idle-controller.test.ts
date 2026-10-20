import { afterEach, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { physicalInstanceId } from "@praetorium/contracts";
import type { ProducerStatus } from "@praetorium/application/lifecycle";
import {
  parseRuntimeInstanceId,
  parseRuntimeRepositoryId,
  parseRuntimeReleaseId,
  runtimeNamespaceName,
  runtimeResourceName,
  type ManagedRuntimeSummary,
  type RuntimeObservation,
  type RuntimePage,
  type RuntimeNeutralState,
} from "@praetorium/kubernetes";
import type {
  ProvisionerIdleCandidate,
  ProvisionerOperationService,
  ProvisionerResolvedRuntime,
} from "./operation-client.js";
import { OperationServiceHttpError } from "./operation-client.js";
import { ProvisionerIdleController, type IdleRuntimeInspector } from "./idle-controller.js";
import { IdleDeadlineJournal } from "./idle-deadline-journal.js";
import type { RuntimeAuthAcceptanceProbe } from "./scriptorium-control-client.js";
import type { ProvisionerLogger } from "./worker.js";

const now = Date.parse("2026-10-17T12:00:00.000Z");
const instanceId = "ins_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const repositoryId = 123456;
const clusterId = "clu_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const imageDigest = "sha256:" + "a".repeat(64);
const platformDigest = "sha256:" + "b".repeat(64);
const compositionDigest = "sha256:" + "c".repeat(64);
const journalDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    journalDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function resolvedRuntime(): ProvisionerResolvedRuntime {
  return {
    revisionId: "rev_01",
    artifactRef: "ghcr.io/praetorium/scriptorium@" + imageDigest,
    platformManifestDigest: platformDigest,
    resourceProfileId: "small",
    hostname: "instance.example.test",
    resources: { cpuMilli: 500, memoryMiB: 512, ephemeralStorageMiB: 256 },
    assignment: {
      contractVersion: "scriptorium-platform/v1",
      instanceId,
      repositoryId,
      repositoryLocator: "https://github.com/owner/repository",
      defaultBranchPolicy: "repository-default",
      runtimeEpoch: 9,
      imageDigest,
      compositionManifestDigest: compositionDigest,
      enabledModuleIds: ["core", "search"],
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
    metadata: {
      contractVersion: "scriptorium-platform/v1",
      producerRevision: "d".repeat(40),
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
    },
  };
}

function candidate(overrides: Partial<ProvisionerIdleCandidate> = {}): ProvisionerIdleCandidate {
  return {
    instanceId,
    repositoryId,
    generation: 7,
    runtimeEpoch: 9,
    clusterId,
    desiredState: "running",
    bindingSuspended: false,
    hasActiveOperation: false,
    healthOperationId: null,
    activeCanaryHealth: false,
    healthNextCheckAt: null,
    currentRuntime: resolvedRuntime(),
    ...overrides,
  };
}

function status(
  overrides: {
    readonly activity?: Partial<ProducerStatus["activity"]>;
    readonly ready?: boolean;
    readonly imageDigest?: string;
    readonly compositionManifestDigest?: string;
    readonly enabledModuleIds?: readonly string[];
    readonly observedAt?: string;
  } = {},
): ProducerStatus {
  return {
    contractVersion: "scriptorium-platform/v1",
    instanceId,
    repositoryId,
    runtimeEpoch: 9,
    imageDigest: overrides.imageDigest ?? imageDigest,
    compositionManifestDigest: overrides.compositionManifestDigest ?? compositionDigest,
    enabledModuleIds: [...(overrides.enabledModuleIds ?? ["core", "search"])],
    ready: overrides.ready ?? true,
    activity: {
      lastMeaningfulActivityAt: new Date(now - 16 * 60_000).toISOString(),
      activeApiRequests: 0,
      activeMcpRequests: 0,
      activeMutations: 0,
      activeJobs: 0,
      restartableJobs: 0,
      pendingCheckpoints: 0,
      uncertainPublication: false,
      ...overrides.activity,
    },
    lastConfirmedRemoteRevision: "e".repeat(40),
    observedAt: overrides.observedAt ?? new Date(now).toISOString(),
  };
}

function verifiedProducerStatus(): ProducerStatus {
  return {
    ...status(),
    persistence: {
      state: "verified",
      observedRemoteCommit: "f".repeat(40),
      formats: [],
    },
  };
}

function verifiedHealthEvidence(observedAt = new Date(now).toISOString()) {
  return {
    applicationProbeId: "application-probe",
    uiApiMcpProbeId: "ui-api-mcp-probe",
    persistenceProbeId: "persistence-probe",
    grantPolicyMatched: true,
    controlServicePolicyMatched: true,
    validGrantAccepted: true,
    wrongRepositoryGrantRejected: true,
    wrongEpochGrantRejected: true,
    invalidServiceCredentialRejected: true,
    validGrantProbeId: "valid-grant-probe",
    wrongRepositoryProbeId: "wrong-repository-probe",
    wrongEpochProbeId: "wrong-epoch-probe",
    invalidServiceCredentialProbeId: "invalid-service-credential-probe",
    observedAt,
  };
}

function managedRuntime(
  overrides: {
    readonly generation?: number;
    readonly runtimeEpoch?: number;
    readonly state?: RuntimeNeutralState;
    readonly releaseId?: string | null;
    readonly releaseDigest?: string | null;
  } = {},
): ManagedRuntimeSummary {
  const releaseId =
    overrides.releaseId === null
      ? undefined
      : parseRuntimeReleaseId(overrides.releaseId ?? "rev_01");
  const releaseDigest =
    overrides.releaseDigest === null ? undefined : (overrides.releaseDigest ?? imageDigest);
  return {
    instanceId: parseRuntimeInstanceId(instanceId),
    repositoryId: parseRuntimeRepositoryId(repositoryId),
    generation: overrides.generation ?? 7,
    runtimeEpoch: overrides.runtimeEpoch ?? 9,
    clusterId,
    managedGeneration: overrides.generation ?? 7,
    state: overrides.state ?? "running",
    ...(releaseId === undefined ? {} : { releaseId }),
    ...(releaseDigest === undefined ? {} : { releaseDigest }),
  };
}

function providerObservation(
  overrides: {
    readonly observedAt?: number;
    readonly state?: RuntimeNeutralState;
    readonly writerEpoch?: number | null;
    readonly writerGeneration?: number | null;
    readonly writerReady?: boolean;
    readonly writerDeleting?: boolean;
    readonly writerCount?: number;
    readonly imageDigest?: string;
  } = {},
  timestamp = now,
): RuntimeObservation {
  const observedAt = overrides.observedAt ?? timestamp;
  return {
    identity: {
      instanceId: parseRuntimeInstanceId(instanceId),
      repositoryId: parseRuntimeRepositoryId(repositoryId),
      runtimeEpoch: 9,
      generation: 7,
      clusterId,
    },
    observationId: "provider-observation-1",
    observedAt,
    namespaceExists: true,
    managedGeneration: 7,
    state: overrides.state ?? "running",
    repositoryId: parseRuntimeRepositoryId(repositoryId),
    runtimeEpoch: 9,
    releaseId: parseRuntimeReleaseId("rev_01"),
    releaseDigest: imageDigest,
    health: { ready: true, checkedAt: new Date(observedAt).toISOString() },
    application: { ready: true, observedAt: new Date(observedAt).toISOString() },
    writerState: "running",
    writerCensus: {
      scope: "instance-repository-all-epochs",
      complete: true,
      queriedNamespace: "runtime-ins",
      namespaceUid: "namespace-uid",
      namespaceResourceVersion: "namespace-rv",
      listResourceVersion: "pods-rv",
      queriedPodCount: overrides.writerCount ?? 1,
      pods:
        (overrides.writerCount ?? 1) === 0
          ? []
          : [
              {
                namespace: "runtime-ins",
                name: "runtime-pod",
                uid: "pod-uid",
                runtimeEpoch: overrides.writerEpoch ?? 9,
                generation: overrides.writerGeneration ?? 7,
                phase: "Running",
                deleting: overrides.writerDeleting ?? false,
                ready: overrides.writerReady ?? true,
                imageIds: [],
              },
            ],
    },
    observedImageDigest: overrides.imageDigest ?? platformDigest,
    conditions: [],
  };
}

function harness(
  options: {
    readonly candidate?: ProvisionerIdleCandidate;
    readonly status?: ProducerStatus;
    readonly managed?: ReturnType<typeof managedRuntime>;
    readonly runtimeObservation?: RuntimeObservation;
    readonly runtimePages?: readonly RuntimePage<ManagedRuntimeSummary>[];
    readonly identityExpiry?: number | ((currentNow: number) => number);
    readonly journalConfigured?: boolean;
    readonly authProbe?: RuntimeAuthAcceptanceProbe;
    readonly recordHealth?: () => Promise<{ readonly recorded: true }>;
    readonly canaryHealthDue?: (currentNow: number) => Promise<{
      readonly active: boolean;
      readonly nextCheckAt: number | null;
      readonly sampleDueAt: number | null;
      readonly healthOperationId: string | null;
    }>;
    readonly activityOffsetMs?: number;
    readonly logger?: ProvisionerLogger;
    readonly candidates?: () => readonly ProvisionerIdleCandidate[];
    readonly readCandidate?: (instanceId: string) => ProvisionerIdleCandidate | null;
    readonly listCandidatePage?: (cursor: string | null) => Promise<{
      readonly items: readonly ProvisionerIdleCandidate[];
      readonly nextCursor: string | null;
    }>;
  } = {},
) {
  let currentNow = now;
  let activityAt = now - (options.activityOffsetMs ?? 16 * 60_000);
  const journalDirectory = join(tmpdir(), `praetorium-idle-${randomUUID()}`);
  journalDirectories.push(journalDirectory);
  const journalPath = join(journalDirectory, "state.json");
  let value = options.candidate ?? candidate();
  const createIdleStop = vi.fn(async () => "op_idle");
  const runtimeCursors: (string | undefined)[] = [];
  let runtimePageIndex = 0;
  const listIdleCandidates = vi.fn(
    async (input: { readonly limit: number; readonly cursor: string | null }) => {
      expect(input.limit).toBe(25);
      if (options.listCandidatePage !== undefined) return options.listCandidatePage(input.cursor);
      return { items: options.candidates?.() ?? [value], nextCursor: null };
    },
  );
  const readIdleCandidate = vi.fn(async (input: { readonly instanceId: string }) => {
    if (options.readCandidate !== undefined) return options.readCandidate(input.instanceId);
    const candidates = options.candidates?.();
    if (candidates !== undefined) {
      return candidates.find((item) => item.instanceId === input.instanceId) ?? null;
    }
    return input.instanceId === value.instanceId ? value : null;
  });
  const issueObservationCredential = vi.fn(async () => ({
    token: "signed-observation-token",
    expiresAt: new Date(currentNow + 30_000).toISOString(),
    operationId: "op_observation",
  }));
  const runtimeCanaryHealthDue = vi.fn(
    async () =>
      options.canaryHealthDue?.(currentNow) ?? {
        active: false,
        nextCheckAt: null,
        sampleDueAt: null,
        healthOperationId: null,
      },
  );
  const operations = {
    readIdleCandidate,
    listIdleCandidates,
    createIdleStop,
    issueObservationCredential,
    async recordRuntimeHealth() {
      return options.recordHealth?.() ?? { recorded: false };
    },
    runtimeCanaryHealthDue,
  } as unknown as ProvisionerOperationService;
  const endpointId = parseRuntimeInstanceId(instanceId);
  const endpoint =
    "http://" +
    runtimeResourceName(endpointId) +
    "." +
    runtimeNamespaceName("tenant", endpointId) +
    ".svc.cluster.local:3000";
  const refreshIdentity = vi.fn(async () => true);
  const inspectRuntime = vi.fn(
    async () => options.runtimeObservation ?? providerObservation({}, currentNow),
  );
  const runtimeIdentityExpiresAt = vi.fn(async () =>
    typeof options.identityExpiry === "function"
      ? options.identityExpiry(currentNow)
      : options.identityExpiry!,
  );
  const inspector: IdleRuntimeInspector = {
    async listManagedInstances(cursor) {
      runtimeCursors.push(cursor);
      if (options.runtimePages !== undefined) {
        return (
          options.runtimePages[runtimePageIndex++] ?? {
            items: [],
            nextCursor: null,
          }
        );
      }
      return { items: [options.managed ?? managedRuntime()], nextCursor: null };
    },
    async inspect() {
      return inspectRuntime();
    },
    async controlEndpoint() {
      return endpoint;
    },
    ...(options.identityExpiry === undefined
      ? {}
      : {
          runtimeIdentityExpiresAt,
          refreshRuntimeIdentity: refreshIdentity,
        }),
  };
  const controller = new ProvisionerIdleController({
    operations,
    workerId: "worker-a",
    clusterId,
    runtime: {
      namespacePrefix: "tenant",
      clusterId,
      ingressNamespace: "praetorium-system",
      instanceAccessNamespace: "praetorium-system",
      instanceAccessService: "instance-access",
      controlNamespace: "praetorium-system",
      controlService: "provisioner",
      maximumResources: { cpuMilli: 10_000, memoryMiB: 10_000, ephemeralStorageMiB: 10_000 },
      maxCapacityAgeMs: 60_000,
    },
    now: () => currentNow,
    idleTimeoutMs: 15 * 60_000,
    ...(options.authProbe === undefined ? {} : { authProbe: options.authProbe }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.journalConfigured === false ? {} : { idleJournalPath: journalPath }),
    createInspector: () => inspector,
    fetch: async (_input, init) => {
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer signed-observation-token",
      );
      const value =
        options.status ??
        status({
          activity: { lastMeaningfulActivityAt: new Date(activityAt).toISOString() },
        });
      return Response.json(
        options.status === undefined
          ? { ...value, observedAt: new Date(currentNow).toISOString() }
          : value,
      );
    },
  });
  return {
    controller,
    createIdleStop,
    issueObservationCredential,
    runtimeCanaryHealthDue,
    readIdleCandidate,
    listIdleCandidates,
    runtimeCursors,
    journalPath,
    inspector,
    refreshIdentity,
    runtimeIdentityExpiresAt,
    inspectRuntime,
    setCandidate(next: ProvisionerIdleCandidate) {
      value = next;
    },
    advance(ms: number) {
      currentNow += ms;
    },
    setActivityTimestamp(timestamp: number) {
      activityAt = timestamp;
    },
  };
}

async function persistDueDeadline(h: ReturnType<typeof harness>): Promise<void> {
  const journal = new IdleDeadlineJournal(h.journalPath);
  await journal.load();
  await journal.put({
    instanceId,
    repositoryId,
    generation: 7,
    runtimeEpoch: 9,
    clusterId,
    lastMeaningfulActivityAt: now - 16 * 60_000,
    deadlineAt: now - 1,
    updatedAt: now,
  });
}

describe("ProvisionerIdleController", () => {
  it("uses fresh runtime and producer evidence before requesting a fenced stop", async () => {
    const h = harness({
      status: status({
        enabledModuleIds: ["search", "core"],
      }),
    });
    await persistDueDeadline(h);

    await h.controller.scanOnce();

    expect(h.issueObservationCredential).toHaveBeenCalledWith({
      workerId: "worker-a",
      clusterId,
      instanceId,
      repositoryId,
      expectedGeneration: 7,
      runtimeEpoch: 9,
    });
    expect(h.createIdleStop).toHaveBeenCalledWith({
      workerId: "worker-a",
      clusterId,
      instanceId,
      repositoryId,
      expectedGeneration: 7,
      expectedRuntimeEpoch: 9,
    });
  });

  it("logs only the validated Operation Service code and bounded status on idle failure", async () => {
    const logger: ProvisionerLogger = { info: vi.fn(), warn: vi.fn() };
    const h = harness({ logger });
    await persistDueDeadline(h);
    h.createIdleStop.mockRejectedValue(
      new OperationServiceHttpError("idle_stop_fence_conflict", 409, false),
    );

    await h.controller.scanOnce();

    expect(h.createIdleStop).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith("idle_observation_unavailable", {
      code: "idle_stop_fence_conflict",
      status: 409,
    });
  });

  it("redacts unsafe Operation Service error codes and statuses from idle logs", async () => {
    const logger: ProvisionerLogger = { info: vi.fn(), warn: vi.fn() };
    const h = harness({ logger });
    await persistDueDeadline(h);
    h.createIdleStop.mockRejectedValue(
      new OperationServiceHttpError("bad code with secret", 600, false),
    );

    await h.controller.scanOnce();

    expect(logger.warn).toHaveBeenCalledWith("idle_observation_unavailable", {
      code: "OperationServiceHttpError",
    });
  });

  it("holds a bounded candidate page while advancing the live Kubernetes cursor", async () => {
    const h = harness({
      runtimePages: [
        { items: [], nextCursor: "kube-next" },
        { items: [managedRuntime()], nextCursor: null },
      ],
    });
    await persistDueDeadline(h);

    await h.controller.scanOnce();
    expect(h.createIdleStop).not.toHaveBeenCalled();
    await h.controller.scanOnce();

    expect(h.listIdleCandidates).toHaveBeenCalledTimes(1);
    expect(h.runtimeCursors).toEqual([undefined, "kube-next"]);
    expect(h.createIdleStop).toHaveBeenCalledTimes(1);
  });

  it("persists the producer-derived 15-minute deadline and inspects due state without a D1 rescan", async () => {
    const h = harness({ activityOffsetMs: 0 });

    await h.controller.scanOnce();
    expect(h.createIdleStop).not.toHaveBeenCalled();
    expect(h.listIdleCandidates).toHaveBeenCalledTimes(1);
    const journal = new IdleDeadlineJournal(h.journalPath);
    await journal.load();
    expect(
      journal.get({
        instanceId,
        repositoryId,
        generation: 7,
        runtimeEpoch: 9,
        clusterId,
      })?.deadlineAt,
    ).toBe(now + 15 * 60_000);

    h.advance(15 * 60_000);
    await h.controller.processDueOnce();

    expect(h.issueObservationCredential).toHaveBeenCalledTimes(2);
    expect(h.createIdleStop).toHaveBeenCalledOnce();
    expect(h.listIdleCandidates).toHaveBeenCalledTimes(1);
  });

  it("renews the current identity on its own expiry timer, independently of idle discovery", async () => {
    const h = harness({ identityExpiry: now + 200_000 });

    await h.controller.scanOnce();
    expect(h.refreshIdentity).not.toHaveBeenCalled();
    expect(h.listIdleCandidates).toHaveBeenCalledTimes(1);

    h.advance(110_000);
    await h.controller.processDueOnce();

    expect(h.refreshIdentity).toHaveBeenCalledOnce();
    expect(h.listIdleCandidates).toHaveBeenCalledTimes(1);
  });

  it("tracks a physical runtime ID with a legacy epoch and schedules identity renewal", async () => {
    const legacyRuntimeEpoch = 1;
    const runtime = resolvedRuntime();
    const currentRuntime = {
      ...runtime,
      legacyRuntimeEpoch,
      assignment: {
        ...runtime.assignment,
        instanceId: physicalInstanceId(instanceId, 9, legacyRuntimeEpoch),
      },
    };
    const h = harness({
      candidate: candidate({ currentRuntime }),
      activityOffsetMs: 0,
      identityExpiry: (currentNow) =>
        currentNow < now + 100_000 ? now + 200_000 : currentNow + 300_000,
    });

    h.controller.notifyWorkAvailable(instanceId);
    await h.controller.processDueOnce();

    expect(h.runtimeIdentityExpiresAt).toHaveBeenCalledOnce();
    expect(h.refreshIdentity).not.toHaveBeenCalled();

    h.advance(110_000);
    await h.controller.processDueOnce();

    expect(h.refreshIdentity).toHaveBeenCalledOnce();
    expect(h.runtimeIdentityExpiresAt).toHaveBeenCalledTimes(2);
    expect(h.createIdleStop).not.toHaveBeenCalled();
  });

  it("renews only the identity of a retained ready writer with stopped desired state", async () => {
    const h = harness({
      candidate: candidate({
        desiredState: "stopped",
        activeCanaryHealth: true,
        healthNextCheckAt: now,
      }),
      identityExpiry: (currentNow) => currentNow + 200_000,
    });

    await h.controller.scanOnce();
    expect(h.runtimeIdentityExpiresAt).toHaveBeenCalledOnce();
    expect(h.inspectRuntime).not.toHaveBeenCalled();
    expect(h.issueObservationCredential).not.toHaveBeenCalled();
    expect(h.runtimeCanaryHealthDue).not.toHaveBeenCalled();
    expect(h.createIdleStop).not.toHaveBeenCalled();

    h.advance(120_000);
    await h.controller.processDueOnce();

    expect(h.refreshIdentity).toHaveBeenCalledOnce();
    expect(h.runtimeIdentityExpiresAt).toHaveBeenCalledTimes(2);
    expect(h.inspectRuntime).not.toHaveBeenCalled();
    expect(h.issueObservationCredential).not.toHaveBeenCalled();
    expect(h.runtimeCanaryHealthDue).not.toHaveBeenCalled();
    expect(h.createIdleStop).not.toHaveBeenCalled();
  });

  it("clears cached idle and canary timers when the same writer becomes a retained stopped candidate", async () => {
    const h = harness({
      candidate: candidate({
        activeCanaryHealth: true,
        healthOperationId: "op_canary_before_stop",
        healthNextCheckAt: now + 15 * 60_000,
      }),
      activityOffsetMs: 0,
      identityExpiry: now + 2 * 60 * 60_000,
    });
    await h.controller.scanOnce();
    expect(h.issueObservationCredential).toHaveBeenCalledOnce();

    h.setCandidate(
      candidate({
        desiredState: "stopped",
        activeCanaryHealth: false,
        healthOperationId: null,
        healthNextCheckAt: null,
      }),
    );
    h.controller.notifyWorkAvailable(instanceId);
    await h.controller.processDueOnce();
    const journal = new IdleDeadlineJournal(h.journalPath);
    await journal.load();
    expect(
      journal.get({ instanceId, repositoryId, generation: 7, runtimeEpoch: 9, clusterId }),
    ).toBeUndefined();
    h.advance(16 * 60_000);
    await h.controller.processDueOnce();

    expect(h.issueObservationCredential).toHaveBeenCalledOnce();
    expect(h.runtimeCanaryHealthDue).not.toHaveBeenCalled();
    expect(h.createIdleStop).not.toHaveBeenCalled();
    expect(h.refreshIdentity).not.toHaveBeenCalled();
  });

  it("rechecks the assignment after a stale status-credential conflict instead of retrying status", async () => {
    const h = harness({ identityExpiry: now + 2 * 60 * 60_000, activityOffsetMs: 0 });
    h.issueObservationCredential.mockImplementationOnce(async () => {
      h.setCandidate(candidate({ desiredState: "stopped" }));
      throw new OperationServiceHttpError("OBSERVATION_CREDENTIAL_DENIED", 409, false);
    });

    await h.controller.scanOnce();
    expect(h.readIdleCandidate).toHaveBeenCalledOnce();
    expect(h.issueObservationCredential).toHaveBeenCalledOnce();
    expect(h.runtimeCanaryHealthDue).not.toHaveBeenCalled();
    expect(h.createIdleStop).not.toHaveBeenCalled();

    h.advance(10_000);
    await h.controller.processDueOnce();
    expect(h.issueObservationCredential).toHaveBeenCalledOnce();
    expect(h.runtimeIdentityExpiresAt).toHaveBeenCalledOnce();
  });

  it("does not track or renew a physical runtime whose epoch suffix mismatches", async () => {
    const legacyRuntimeEpoch = 1;
    const runtime = resolvedRuntime();
    const currentRuntime = {
      ...runtime,
      legacyRuntimeEpoch,
      assignment: {
        ...runtime.assignment,
        instanceId: physicalInstanceId(instanceId, 8, legacyRuntimeEpoch),
      },
    };
    const h = harness({
      candidate: candidate({ currentRuntime }),
      activityOffsetMs: 0,
      identityExpiry: now + 200_000,
    });

    h.controller.notifyWorkAvailable(instanceId);
    await h.controller.processDueOnce();

    expect(h.runtimeIdentityExpiresAt).not.toHaveBeenCalled();
    expect(h.refreshIdentity).not.toHaveBeenCalled();
    expect(h.createIdleStop).not.toHaveBeenCalled();
  });

  it("keeps idle retirement disabled when no durable journal is configured", async () => {
    const h = harness({ journalConfigured: false });

    await h.controller.scanOnce();
    h.advance(24 * 60 * 60_000);
    await h.controller.processDueOnce();

    expect(h.createIdleStop).not.toHaveBeenCalled();
  });

  it("does not repeat full inventory discovery for an active operation on the empty timeout", async () => {
    const h = harness({ candidate: candidate({ hasActiveOperation: true }) });

    await h.controller.scanOnce();
    h.advance(5 * 60_000);
    await h.controller.processDueOnce();

    expect(h.listIdleCandidates).toHaveBeenCalledOnce();
    expect(h.runtimeCanaryHealthDue).not.toHaveBeenCalled();
  });

  it("targets one instance in a larger inventory without repeating the full scan", async () => {
    const runtime = resolvedRuntime();
    const inventory = [
      candidate(),
      ...Array.from({ length: 9 }, (_, index) => {
        const otherInstanceId = `${instanceId.slice(0, -1)}${index}`;
        return candidate({
          instanceId: otherInstanceId,
          currentRuntime: {
            ...runtime,
            assignment: { ...runtime.assignment, instanceId: otherInstanceId },
          },
        });
      }),
    ];
    const h = harness({ candidates: () => inventory });
    const abort = new AbortController();
    const running = h.controller.run(abort.signal);

    await vi.waitFor(() => expect(h.runtimeCursors).toHaveLength(1));
    h.controller.notifyWorkAvailable(instanceId);
    h.controller.notifyWorkAvailable(instanceId);
    h.controller.notifyWorkAvailable(instanceId);
    await vi.waitFor(() => expect(h.readIdleCandidate).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.listIdleCandidates).toHaveBeenCalledTimes(1);
    expect(h.runtimeCursors).toHaveLength(1);

    abort.abort();
    await running;
  });

  it("does not refresh idle inventory for a generic work signal", async () => {
    const h = harness();
    const abort = new AbortController();
    const running = h.controller.run(abort.signal);

    await vi.waitFor(() => expect(h.runtimeCursors).toHaveLength(1));
    h.controller.notifyWorkAvailable();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.listIdleCandidates).toHaveBeenCalledTimes(1);
    expect(h.readIdleCandidate).not.toHaveBeenCalled();
    expect(h.runtimeCursors).toHaveLength(1);
    abort.abort();
    await running;
  });

  it("retries a failed point refresh for only that instance after bounded backoff", async () => {
    let attempts = 0;
    const h = harness({
      readCandidate: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("control_plane_unavailable");
        return candidate();
      },
    });

    h.controller.notifyWorkAvailable(instanceId);
    await h.controller.processDueOnce();
    expect(attempts).toBe(1);
    expect(h.listIdleCandidates).not.toHaveBeenCalled();

    h.advance(4_999);
    await h.controller.processDueOnce();
    expect(attempts).toBe(1);

    h.advance(1);
    await h.controller.processDueOnce();
    expect(attempts).toBe(2);
    expect(h.listIdleCandidates).not.toHaveBeenCalled();
  });

  it("drops a retired binding hint on a point refresh, then rediscovers a restart", async () => {
    let present = true;
    const h = harness({
      activityOffsetMs: 0,
      candidates: () => (present ? [candidate()] : []),
      identityExpiry: (currentNow) => currentNow + 200_000,
    });
    const abort = new AbortController();
    const running = h.controller.run(abort.signal);
    const binding = { instanceId, repositoryId, generation: 7, runtimeEpoch: 9, clusterId };

    await vi.waitFor(() => expect(h.runtimeCursors).toHaveLength(1));
    await vi.waitFor(async () => {
      const journal = new IdleDeadlineJournal(h.journalPath);
      await journal.load();
      expect(journal.get(binding)).toBeDefined();
    });

    present = false;
    h.controller.notifyWorkAvailable(instanceId);
    await vi.waitFor(() => expect(h.readIdleCandidate).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () => {
      const journal = new IdleDeadlineJournal(h.journalPath);
      await journal.load();
      expect(journal.get(binding)).toBeUndefined();
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    h.advance(120_000);
    await h.controller.processDueOnce();
    expect(h.refreshIdentity).not.toHaveBeenCalled();
    expect(h.createIdleStop).not.toHaveBeenCalled();

    present = true;
    h.setActivityTimestamp(now + 120_000);
    h.controller.notifyWorkAvailable(instanceId);
    await vi.waitFor(() => expect(h.readIdleCandidate).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () => {
      expect(h.runtimeCursors).toHaveLength(1);
      const journal = new IdleDeadlineJournal(h.journalPath);
      await journal.load();
      expect(journal.get(binding)).toMatchObject({
        lastMeaningfulActivityAt: now + 120_000,
        deadlineAt: now + 120_000 + 15 * 60_000,
      });
    });
    h.advance(120_000);
    await h.controller.processDueOnce();
    expect(h.refreshIdentity).toHaveBeenCalledOnce();
    expect(h.createIdleStop).not.toHaveBeenCalled();

    abort.abort();
    await running;
  });

  it("keeps tracked bindings and journal hints when a full inventory scan fails partway", async () => {
    let candidatePageCalls = 0;
    const h = harness({
      activityOffsetMs: 0,
      identityExpiry: (currentNow) => currentNow + 200_000,
      listCandidatePage: async (cursor) => {
        candidatePageCalls += 1;
        if (candidatePageCalls === 1 && cursor === null)
          return { items: [candidate()], nextCursor: "page-2" };
        throw new Error("control_plane_unavailable");
      },
    });
    const abort = new AbortController();
    const running = h.controller.run(abort.signal);

    await vi.waitFor(async () => {
      expect(h.runtimeCursors).toHaveLength(1);
      const journal = new IdleDeadlineJournal(h.journalPath);
      await journal.load();
      expect(
        journal.get({ instanceId, repositoryId, generation: 7, runtimeEpoch: 9, clusterId }),
      ).toBeDefined();
    });
    h.controller.notifyWorkAvailable();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.listIdleCandidates).toHaveBeenCalledTimes(2);
    h.advance(120_000);
    await h.controller.processDueOnce();
    expect(h.refreshIdentity).toHaveBeenCalledOnce();

    const journal = new IdleDeadlineJournal(h.journalPath);
    await journal.load();
    expect(
      journal.get({ instanceId, repositoryId, generation: 7, runtimeEpoch: 9, clusterId }),
    ).toBeDefined();
    abort.abort();
    await running;
  });

  it("runs a full health acceptance probe once per exact health operation trigger", async () => {
    const verifyObserved = vi.fn(async () => verifiedHealthEvidence());
    const authProbe = {
      available: true,
      withEndpointResolver: () => authProbe,
      verify: async () => verifiedHealthEvidence(),
      verifyObserved,
      forLease: () => ({}) as never,
    } as unknown as RuntimeAuthAcceptanceProbe;
    const h = harness({
      candidate: candidate({ healthOperationId: "op_health_01" }),
      runtimeObservation: providerObservation({ imageDigest: platformDigest }),
      status: verifiedProducerStatus(),
      recordHealth: async () => ({ recorded: true }),
      authProbe,
    });

    await h.controller.scanOnce();
    await h.controller.scanOnce();

    expect(verifyObserved).toHaveBeenCalledOnce();
    expect(verifyObserved).toHaveBeenCalledWith(expect.anything(), "op_health_01", undefined);
  });

  it("queries only an active canary and deduplicates its persisted sample due token", async () => {
    const verifyObserved = vi.fn(async () => verifiedHealthEvidence());
    const authProbe = {
      available: true,
      withEndpointResolver: () => authProbe,
      verify: async () => verifiedHealthEvidence(),
      verifyObserved,
      forLease: () => ({}) as never,
    } as unknown as RuntimeAuthAcceptanceProbe;
    const recordHealth = vi.fn(async () => ({ recorded: true as const }));
    const h = harness({
      candidate: candidate({ activeCanaryHealth: true, healthNextCheckAt: now - 1 }),
      status: verifiedProducerStatus(),
      runtimeObservation: providerObservation({ imageDigest: platformDigest }),
      canaryHealthDue: async (currentNow) => ({
        active: true,
        nextCheckAt: currentNow - 1,
        sampleDueAt: now - 1_000,
        healthOperationId: "op_canary_sample_01",
      }),
      recordHealth,
      authProbe,
    });

    await h.controller.scanOnce();
    expect(h.createIdleStop).not.toHaveBeenCalled();
    expect(h.runtimeCanaryHealthDue).not.toHaveBeenCalled();
    await h.controller.processDueOnce();
    expect(h.runtimeCanaryHealthDue).toHaveBeenCalledOnce();
    expect(verifyObserved).toHaveBeenCalledOnce();
    expect(recordHealth).toHaveBeenCalledOnce();
    expect(h.createIdleStop).not.toHaveBeenCalled();

    await h.controller.processDueOnce();
    expect(h.runtimeCanaryHealthDue).toHaveBeenCalledOnce();
    h.advance(5 * 60_000);
    await h.controller.processDueOnce();

    expect(h.runtimeCanaryHealthDue).toHaveBeenCalledTimes(2);
    expect(verifyObserved).toHaveBeenCalledOnce();
    expect(recordHealth).toHaveBeenCalledOnce();
    expect(h.createIdleStop).not.toHaveBeenCalled();
  });

  it("refreshes the overdue idle candidate after canary health ends without a notification", async () => {
    let canaryActive = true;
    const h = harness({
      candidate: candidate({
        activeCanaryHealth: true,
        healthNextCheckAt: now - 1,
        healthOperationId: "op_canary_idle_recheck_01",
      }),
      canaryHealthDue: async (currentNow) =>
        canaryActive
          ? {
              active: true,
              nextCheckAt: currentNow + 5 * 60_000,
              sampleDueAt: null,
              healthOperationId: "op_canary_idle_recheck_01",
            }
          : {
              active: false,
              nextCheckAt: null,
              sampleDueAt: null,
              healthOperationId: null,
            },
      readCandidate: () =>
        candidate({
          activeCanaryHealth: false,
          healthNextCheckAt: null,
          healthOperationId: null,
        }),
    });

    await h.controller.scanOnce();
    expect(h.createIdleStop).not.toHaveBeenCalled();
    const journal = new IdleDeadlineJournal(h.journalPath);
    await journal.load();
    expect(
      journal.get({ instanceId, repositoryId, generation: 7, runtimeEpoch: 9, clusterId }),
    ).toEqual(
      expect.objectContaining({
        lastMeaningfulActivityAt: now - 16 * 60_000,
        deadlineAt: now - 60_000,
      }),
    );
    await h.controller.processDueOnce();
    await h.controller.processDueOnce();
    expect(h.runtimeCanaryHealthDue).toHaveBeenCalledOnce();
    expect(h.createIdleStop).not.toHaveBeenCalled();
    expect(h.readIdleCandidate).not.toHaveBeenCalled();

    canaryActive = false;
    h.advance(5 * 60_000);
    await h.controller.processDueOnce();

    expect(h.runtimeCanaryHealthDue).toHaveBeenCalledTimes(2);
    expect(h.readIdleCandidate).toHaveBeenCalledOnce();
    expect(h.readIdleCandidate).toHaveBeenCalledWith({
      workerId: "worker-a",
      clusterId,
      instanceId,
      signal: expect.any(AbortSignal),
    });
    expect(h.createIdleStop).toHaveBeenCalledOnce();
    expect(h.listIdleCandidates).toHaveBeenCalledOnce();
  });

  it("retries a failed canary sample on a bounded timer and waits before querying again", async () => {
    let attempts = 0;
    const verifyObserved = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary_canary_probe_failure");
      return verifiedHealthEvidence();
    });
    const authProbe = {
      available: true,
      withEndpointResolver: () => authProbe,
      verify: async () => verifiedHealthEvidence(),
      verifyObserved,
      forLease: () => ({}) as never,
    } as unknown as RuntimeAuthAcceptanceProbe;
    const recordHealth = vi.fn(async () => ({ recorded: true as const }));
    const h = harness({
      candidate: candidate({ activeCanaryHealth: true, healthNextCheckAt: now - 1 }),
      activityOffsetMs: 0,
      status: verifiedProducerStatus(),
      runtimeObservation: providerObservation({ imageDigest: platformDigest }),
      canaryHealthDue: async (currentNow) => ({
        active: true,
        nextCheckAt: currentNow - 1,
        sampleDueAt: now - 1_000,
        healthOperationId: "op_canary_sample_retry_01",
      }),
      recordHealth,
      authProbe,
    });

    await h.controller.scanOnce();
    await h.controller.processDueOnce();
    expect(h.runtimeCanaryHealthDue).toHaveBeenCalledOnce();
    expect(verifyObserved).toHaveBeenCalledOnce();
    expect(recordHealth).not.toHaveBeenCalled();

    await h.controller.processDueOnce();
    expect(verifyObserved).toHaveBeenCalledOnce();
    h.advance(5_000);
    await h.controller.processDueOnce();
    expect(verifyObserved).toHaveBeenCalledTimes(2);
    expect(recordHealth).toHaveBeenCalledOnce();

    h.advance(5 * 60_000);
    await h.controller.processDueOnce();
    expect(h.runtimeCanaryHealthDue).toHaveBeenCalledTimes(2);
    expect(verifyObserved).toHaveBeenCalledTimes(2);
  });

  it("clears the local canary timer when the candidate leaves canary observation", async () => {
    let active = true;
    const h = harness({
      candidates: () => [
        candidate({
          activeCanaryHealth: active,
          healthNextCheckAt: active ? now + 10_000 : null,
        }),
      ],
    });

    await h.controller.scanOnce();
    active = false;
    await h.controller.scanOnce();
    h.advance(10 * 60_000);
    await h.controller.processDueOnce();

    expect(h.runtimeCanaryHealthDue).not.toHaveBeenCalled();
  });

  it("retries a failed health operation probe with bounded backoff", async () => {
    let attempts = 0;
    const verifyObserved = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary_health_probe_failure");
      return verifiedHealthEvidence();
    });
    const authProbe = {
      available: true,
      withEndpointResolver: () => authProbe,
      verify: async () => verifiedHealthEvidence(),
      verifyObserved,
      forLease: () => ({}) as never,
    } as unknown as RuntimeAuthAcceptanceProbe;
    const h = harness({
      candidate: candidate({ healthOperationId: "op_health_retry_01" }),
      activityOffsetMs: 0,
      runtimeObservation: providerObservation({ imageDigest: platformDigest }),
      status: verifiedProducerStatus(),
      recordHealth: async () => ({ recorded: true }),
      authProbe,
    });

    await h.controller.scanOnce();
    expect(verifyObserved).toHaveBeenCalledOnce();
    await h.controller.processDueOnce();
    expect(verifyObserved).toHaveBeenCalledOnce();

    h.advance(5_000);
    await h.controller.processDueOnce();
    expect(verifyObserved).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["suspended binding", { candidate: candidate({ bindingSuspended: true }) }],
    ["active operation", { candidate: candidate({ hasActiveOperation: true }) }],
    [
      "suspended retained writer",
      { candidate: candidate({ desiredState: "stopped", bindingSuspended: true }) },
    ],
    [
      "active retained writer",
      { candidate: candidate({ desiredState: "stopped", hasActiveOperation: true }) },
    ],
    [
      "retained writer with a stale runtime generation",
      {
        candidate: candidate({ desiredState: "stopped" }),
        managed: managedRuntime({ generation: 6 }),
      },
    ],
    [
      "retained writer with a stale runtime epoch",
      {
        candidate: candidate({ desiredState: "stopped" }),
        managed: managedRuntime({ runtimeEpoch: 8 }),
      },
    ],
    ["wrong runtime generation", { managed: managedRuntime({ generation: 6 }) }],
    ["wrong runtime epoch", { managed: managedRuntime({ runtimeEpoch: 8 }) }],
    ["runtime not running", { managed: managedRuntime({ state: "stopped" }) }],
    ["runtime release mismatch", { managed: managedRuntime({ releaseId: "rev_old" }) }],
    [
      "runtime image mismatch",
      { managed: managedRuntime({ releaseDigest: "sha256:" + "f".repeat(64) }) },
    ],
    [
      "runtime provider observation is stale",
      { runtimeObservation: providerObservation({ observedAt: now - 31_000 }) },
    ],
    [
      "runtime provider observation is not ready",
      { runtimeObservation: providerObservation({ state: "stopped" }) },
    ],
    [
      "runtime census has no writer",
      { runtimeObservation: providerObservation({ writerCount: 0 }) },
    ],
    [
      "runtime census has multiple writers",
      { runtimeObservation: providerObservation({ writerCount: 2 }) },
    ],
    [
      "runtime census has another epoch",
      { runtimeObservation: providerObservation({ writerEpoch: 8 }) },
    ],
    [
      "runtime census writer is deleting",
      { runtimeObservation: providerObservation({ writerDeleting: true }) },
    ],
    [
      "runtime census writer is not ready",
      { runtimeObservation: providerObservation({ writerReady: false }) },
    ],
    [
      "runtime actual image mismatch",
      { runtimeObservation: providerObservation({ imageDigest: "sha256:" + "f".repeat(64) }) },
    ],
    ["producer not ready", { status: status({ ready: false }) }],
    ["producer image mismatch", { status: status({ imageDigest: "sha256:" + "f".repeat(64) }) }],
    [
      "producer composition mismatch",
      { status: status({ compositionManifestDigest: "sha256:" + "f".repeat(64) }) },
    ],
    ["producer modules mismatch", { status: status({ enabledModuleIds: ["core"] }) }],
    [
      "stale producer status",
      { status: status({ observedAt: new Date(now - 31_000).toISOString() }) },
    ],
    ["active request", { status: status({ activity: { activeApiRequests: 1 } }) }],
    ["active job", { status: status({ activity: { activeJobs: 1 } }) }],
    ["active mutation", { status: status({ activity: { activeMutations: 1 } }) }],
    ["pending checkpoint", { status: status({ activity: { pendingCheckpoints: 1 } }) }],
    ["uncertain publication", { status: status({ activity: { uncertainPublication: true } }) }],
    [
      "recent activity",
      {
        status: status({
          activity: { lastMeaningfulActivityAt: new Date(now - 14 * 60_000).toISOString() },
        }),
      },
    ],
    [
      "unknown activity clock",
      { status: status({ activity: { lastMeaningfulActivityAt: null } }) },
    ],
  ] as const)("does not stop for %s", async (_reason, options) => {
    const h = harness(options);

    await h.controller.scanOnce();

    expect(h.createIdleStop).not.toHaveBeenCalled();
  });
});
