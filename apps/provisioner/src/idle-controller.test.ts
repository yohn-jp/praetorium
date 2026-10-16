import { describe, expect, it, vi } from "vitest";
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
import { ProvisionerIdleController, type IdleRuntimeInspector } from "./idle-controller.js";

const now = Date.parse("2026-10-17T12:00:00.000Z");
const instanceId = "ins_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const repositoryId = 123456;
const clusterId = "clu_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const imageDigest = "sha256:" + "a".repeat(64);
const platformDigest = "sha256:" + "b".repeat(64);
const compositionDigest = "sha256:" + "c".repeat(64);

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
): RuntimeObservation {
  const observedAt = overrides.observedAt ?? now;
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
  } = {},
) {
  const value = options.candidate ?? candidate();
  const createIdleStop = vi.fn(async () => "op_idle");
  const runtimeCursors: (string | undefined)[] = [];
  let runtimePageIndex = 0;
  const listIdleCandidates = vi.fn(
    async (input: { readonly limit: number; readonly cursor: string | null }) => {
      expect(input.limit).toBe(25);
      expect(input.cursor).toBeNull();
      return { items: [value], nextCursor: null };
    },
  );
  const issueObservationCredential = vi.fn(async () => ({
    token: "signed-observation-token",
    expiresAt: new Date(now + 30_000).toISOString(),
    operationId: "op_observation",
  }));
  const operations = {
    listIdleCandidates,
    createIdleStop,
    issueObservationCredential,
  } as unknown as ProvisionerOperationService;
  const endpointId = parseRuntimeInstanceId(instanceId);
  const endpoint =
    "http://" +
    runtimeResourceName(endpointId) +
    "." +
    runtimeNamespaceName("tenant", endpointId) +
    ".svc.cluster.local:3000";
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
      return options.runtimeObservation ?? providerObservation();
    },
    async controlEndpoint() {
      return endpoint;
    },
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
    now: () => now,
    idleTimeoutMs: 15 * 60_000,
    createInspector: () => inspector,
    fetch: async (_input, init) => {
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer signed-observation-token",
      );
      return Response.json(options.status ?? status());
    },
  });
  return {
    controller,
    createIdleStop,
    issueObservationCredential,
    listIdleCandidates,
    runtimeCursors,
  };
}

describe("ProvisionerIdleController", () => {
  it("uses fresh runtime and producer evidence before requesting a fenced stop", async () => {
    const h = harness({
      status: status({
        enabledModuleIds: ["search", "core"],
      }),
    });

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

  it("holds a bounded candidate page while advancing the live Kubernetes cursor", async () => {
    const h = harness({
      runtimePages: [
        { items: [], nextCursor: "kube-next" },
        { items: [managedRuntime()], nextCursor: null },
      ],
    });

    await h.controller.scanOnce();
    expect(h.createIdleStop).not.toHaveBeenCalled();
    await h.controller.scanOnce();

    expect(h.listIdleCandidates).toHaveBeenCalledTimes(1);
    expect(h.runtimeCursors).toEqual([undefined, "kube-next"]);
    expect(h.createIdleStop).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["suspended binding", { candidate: candidate({ bindingSuspended: true }) }],
    ["active operation", { candidate: candidate({ hasActiveOperation: true }) }],
    ["desired stopped", { candidate: candidate({ desiredState: "stopped" }) }],
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
