import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeAssignment } from "@praetorium/application/lifecycle";
import type { ProvisionerOperationService } from "./operation-client.js";
import {
  KubernetesApiError,
  KubernetesRuntimeProvider,
  createKubernetesResourceRenderer,
  managedLabels,
  parseRuntimeInstanceId,
  parseRuntimeReleaseId,
  parseRuntimeRepositoryId,
  runtimeNamespaceName,
  runtimeResourceName,
  type KubernetesApi,
  type RuntimeObservation,
} from "@praetorium/kubernetes";
import {
  LifecycleReservationAdapter,
  KubernetesLifecycleRuntimeAdapter,
} from "./kubernetes-lifecycle-adapter.js";
import { RuntimeIdentityAssignmentTransport } from "./runtime-identity.js";
import type { RuntimeIdentityProvisionerService } from "./operation-client.js";

const now = 1_800_000_000_000;
const request = { cpuMilli: 600, memoryMiB: 600, ephemeralStorageMiB: 600 };

function deployment(): RuntimeAssignment["deployment"] {
  const digest = `sha256:${"a".repeat(64)}`;
  return {
    revisionId: "rev_target",
    repositoryId: 123456,
    repositoryLocator: "https://github.com/owner/repository",
    defaultBranchPolicy: "repository-default",
    imageDigest: digest,
    artifactRef: `ghcr.io/praetorium/scriptorium@${digest}`,
    platformManifestDigest: `sha256:${"b".repeat(64)}`,
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
    resources: request,
  };
}

function runtimeCapacity() {
  const oneNode = { cpuMilli: 1_000, memoryMiB: 1_000, ephemeralStorageMiB: 1_000 };
  const reserved = { cpuMilli: 500, memoryMiB: 500, ephemeralStorageMiB: 500 };
  return {
    observedAt: now,
    authoritative: true as const,
    capacityEpoch: 12,
    nodeResourceVersion: "node-rv-12",
    podResourceVersion: "pod-rv-12",
    reservationObservedAt: now,
    cpuMilli: 1_500,
    memoryMiB: 1_500,
    ephemeralStorageMiB: 1_500,
    allocatable: { cpuMilli: 2_000, memoryMiB: 2_000, ephemeralStorageMiB: 2_000 },
    requested: { cpuMilli: 0, memoryMiB: 0, ephemeralStorageMiB: 0 },
    reserved,
    activeInstances: 1,
    nodes: [
      {
        nodeName: "node-a",
        allocatable: oneNode,
        requested: { cpuMilli: 0, memoryMiB: 0, ephemeralStorageMiB: 0 },
        available: oneNode,
      },
      {
        nodeName: "node-b",
        allocatable: oneNode,
        requested: { cpuMilli: 0, memoryMiB: 0, ephemeralStorageMiB: 0 },
        available: oneNode,
      },
    ],
  };
}

function reservationSnapshot() {
  return {
    clusterId: "cluster-a",
    capacityEpoch: 12,
    observedAt: now,
    complete: true,
    capacity: {
      allocatable: { cpuMilli: 2_000, memoryMiB: 2_000, ephemeralStorageMiB: 2_000 },
      requested: { cpuMilli: 0, memoryMiB: 0, ephemeralStorageMiB: 0 },
      nodeResourceVersion: "node-rv-12",
      podResourceVersion: "pod-rv-12",
    },
    representedReservationIds: [],
    reservations: [
      {
        reservationId: "res_other",
        instanceId: "ins_other",
        repositoryId: 456789,
        runtimeEpoch: 3,
        generation: 2,
        clusterId: "cluster-a",
        status: "reserved" as const,
        resources: { cpuMilli: 500, memoryMiB: 500, ephemeralStorageMiB: 500 },
        capacitySnapshotEpoch: 12,
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
}

function adapter() {
  const capacity = runtimeCapacity();
  const reservations = reservationSnapshot();
  const reserveRuntime = vi.fn(async () => ({
    reservationId: "res_target",
    instanceId: "ins_target",
    repositoryId: 123456,
    runtimeEpoch: 5,
    generation: 2,
    clusterId: "cluster-a",
    status: "reserved" as const,
    resources: request,
    capacitySnapshotEpoch: 12,
    createdAt: now,
    updatedAt: now,
  }));
  const operations = {
    currentReservations: vi.fn(async () => reservations),
    reserveRuntime,
  } as unknown as ProvisionerOperationService;
  const runtime = {
    provider: { getCapacitySnapshot: vi.fn(async () => capacity) },
  } as unknown as KubernetesLifecycleRuntimeAdapter;
  return {
    adapter: new LifecycleReservationAdapter({
      runtime,
      operations,
      now: () => now,
      maxCapacityAgeMs: 30_000,
      claim: {
        operationId: "op_target",
        workerId: "worker-a",
        leaseToken: "a".repeat(48),
        leaseEpoch: 1,
        runtimeEpoch: 5,
        clusterId: "cluster-a",
        generation: 2,
        instanceId: "ins_target",
        repositoryId: 123456,
        reservationId: null,
        currentReservationId: null,
        currentReservationEpoch: null,
      },
    }),
    reserveRuntime,
  };
}

function hostedRuntimeAssignment(): RuntimeAssignment {
  const instanceId = parseRuntimeInstanceId("ins_00000000000000000000000001");
  const repositoryId = parseRuntimeRepositoryId(123456);
  const releaseId = parseRuntimeReleaseId("rel_00000000000000000000000001");
  const imageDigest = `sha256:${"a".repeat(64)}`;
  const platformManifestDigest = `sha256:${"b".repeat(64)}`;
  return {
    instanceId,
    repositoryId,
    runtimeEpoch: 1,
    generation: 1,
    clusterId: "clu_00000000000000000000000001",
    reservationId: "res_00000000000000000000000001",
    deployment: {
      ...deployment(),
      revisionId: releaseId,
      repositoryId,
      imageDigest,
      platformManifestDigest,
      artifactRef: `ghcr.io/praetorium/scriptorium@${imageDigest}`,
    },
  };
}

function legacyStopProviderFixture(assignment: RuntimeAssignment) {
  const instanceId = parseRuntimeInstanceId(assignment.instanceId);
  const namespace = runtimeNamespaceName("praetorium-instances", instanceId);
  const name = runtimeResourceName(instanceId);
  const releaseId = parseRuntimeReleaseId(assignment.deployment.revisionId);
  const ownershipLabels = {
    ...managedLabels({
      instanceId: parseRuntimeInstanceId(assignment.instanceId),
      repositoryId: parseRuntimeRepositoryId(assignment.repositoryId),
      runtimeEpoch: assignment.runtimeEpoch,
      generation: assignment.generation,
      releaseId,
    }),
    "arcadia.io/runtime-cluster-id": assignment.clusterId,
  };
  const namespaceObject = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: namespace,
      uid: "namespace-uid",
      resourceVersion: "10",
      labels: {
        ...ownershipLabels,
        "pod-security.kubernetes.io/enforce": "restricted",
        "pod-security.kubernetes.io/audit": "restricted",
        "pod-security.kubernetes.io/warn": "restricted",
      },
    },
  };
  const deploymentObject = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name,
      namespace,
      uid: "deployment-uid",
      resourceVersion: "11",
      labels: ownershipLabels,
      annotations: { "arcadia.io/release-digest": assignment.deployment.imageDigest },
    },
    spec: { replicas: 1 },
    status: { readyReplicas: 1 },
  };
  const podName = `${name}-legacy`;
  const podObject = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: podName,
      namespace,
      uid: "legacy-pod-uid",
      resourceVersion: "12",
      labels: { ...ownershipLabels, "app.kubernetes.io/name": "scriptorium" },
    },
    spec: {
      containers: [
        {
          name: "scriptorium",
          image: assignment.deployment.artifactRef,
          env: [{ name: "SCRIPTORIUM_USAGE_DIR", value: "/data/history" }],
          volumeMounts: [{ name: "workspace", mountPath: "/data" }],
        },
      ],
      volumes: [{ name: "workspace", emptyDir: {} }],
    },
    status: {
      phase: "Running",
      conditions: [{ type: "Ready", status: "True" }],
      containerStatuses: [
        {
          name: "scriptorium",
          ready: true,
          imageID: `containerd://${assignment.deployment.platformManifestDigest}`,
        },
      ],
    },
  };
  const objects = new Map<string, unknown>([
    [`Deployment/${namespace}/${name}`, deploymentObject],
    [`Pod/${namespace}/${podName}`, podObject],
  ]);
  const writes: string[] = [];
  let listRevision = 12;
  const api = {
    async get(reference: { readonly kind: string; readonly namespace: string; readonly name: string }) {
      const value = objects.get(`${reference.kind}/${reference.namespace}/${reference.name}`);
      if (value === undefined) throw new KubernetesApiError(404, "NotFound");
      return value;
    },
    async getNamespace() {
      return namespaceObject;
    },
    async list(kind: string, selectedNamespace: string) {
      return {
        items: [...objects.entries()]
          .filter(([key]) => key.startsWith(`${kind}/${selectedNamespace}/`))
          .map(([, value]) => value),
        resourceVersion: String(listRevision),
        nextCursor: null,
      };
    },
    async create(resource: { readonly kind: string; readonly metadata: { readonly namespace: string; readonly name: string } }) {
      writes.push(`create:${resource.kind}`);
      listRevision += 1;
      const created = {
        ...resource,
        metadata: {
          ...resource.metadata,
          uid: `created-${resource.kind.toLowerCase()}`,
          resourceVersion: String(listRevision),
        },
      };
      objects.set(`${resource.kind}/${resource.metadata.namespace}/${resource.metadata.name}`, created);
      return created;
    },
    async applyConditional(resource: { readonly kind: string; readonly metadata: { readonly namespace: string; readonly name: string }; readonly spec?: Readonly<Record<string, unknown>> }) {
      writes.push(`apply:${resource.kind}`);
      listRevision += 1;
      const previous = objects.get(`${resource.kind}/${resource.metadata.namespace}/${resource.metadata.name}`) as Record<string, unknown>;
      const applied = {
        ...previous,
        ...resource,
        metadata: { ...(previous.metadata as object), ...resource.metadata, resourceVersion: String(listRevision) },
        spec: resource.spec,
      };
      objects.set(`${resource.kind}/${resource.metadata.namespace}/${resource.metadata.name}`, applied);
      if (resource.kind === "Deployment" && resource.spec?.replicas === 0)
        objects.delete(`Pod/${namespace}/${podName}`);
      return applied;
    },
    async delete() { throw new Error("unexpected delete"); },
    async deleteConditional() { throw new Error("unexpected conditional delete"); },
    async apply() { throw new Error("unexpected apply"); },
    async createNamespace() { throw new Error("unexpected namespace create"); },
    async applyNamespaceConditional() { throw new Error("unexpected namespace update"); },
    async deleteNamespaceConditional() { throw new Error("unexpected namespace delete"); },
    async *watch() { yield* []; },
    async readHistorySnapshot(input: { readonly sourcePodUid: string }) {
      const manifest = { schemaVersion: 1, sourcePodUid: input.sourcePodUid, files: [] };
      const manifestSha256 = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
      return JSON.stringify({ ...manifest, manifestSha256 });
    },
  } as unknown as KubernetesApi;
  const renderer = createKubernetesResourceRenderer({
    namespacePrefix: "praetorium-instances",
    clusterId: assignment.clusterId,
    ingressNamespace: "traefik",
    instanceAccessNamespace: "praetorium-system",
    instanceAccessService: "instance-access",
    controlNamespace: "praetorium-system",
    controlService: "provisioner",
    maximumResources: { cpuMilli: 2_000, memoryMiB: 2_048, ephemeralStorageMiB: 4_096 },
  });
  const provider = new KubernetesRuntimeProvider({
    api,
    namespacePrefix: "praetorium-instances",
    clusterId: assignment.clusterId,
    renderer,
    reservations: {
      currentReservations: async () => { throw new Error("not used by stop"); },
      recordCapacitySnapshot: async () => { throw new Error("not used by stop"); },
    },
    maxCapacityAgeMs: 30_000,
    now: () => now,
  });
  return { provider, writes, objects, namespace, name, podName };
}

describe("LifecycleReservationAdapter", () => {
  it("waits before retiring the old runtime when other reservations fragment node capacity", async () => {
    const { adapter: capacity, reserveRuntime } = adapter();

    await expect(
      capacity.reserve("op_target", "ins_target", deployment(), async () => undefined),
    ).resolves.toEqual({ status: "pending" });
    expect(reserveRuntime).not.toHaveBeenCalled();
  });
});

describe("hosted stop private-history boundary", () => {
  function lifecycleAdapter(
    assignment: RuntimeAssignment,
    provider: KubernetesRuntimeProvider,
    drain: Parameters<KubernetesLifecycleRuntimeAdapter["setLegacyHistoryDrain"]>[0],
  ) {
    const identityTransport = new RuntimeIdentityAssignmentTransport({
      operations: {} as RuntimeIdentityProvisionerService,
      workerId: "worker-a",
      clusterId: assignment.clusterId,
    });
    const project = vi.spyOn(identityTransport, "project");
    const runtime = Object.assign(Object.create(KubernetesLifecycleRuntimeAdapter.prototype), {
      provider,
      identityTransport,
      now: () => now,
      convergenceTimeoutMs: 1_000,
      pollIntervalMs: 1,
    }) as KubernetesLifecycleRuntimeAdapter;
    runtime.setLegacyHistoryDrain(drain);
    return { runtime, project };
  }

  const noOpBeforeEffect = async () => undefined;

  it("does not scale down a legacy Hosted writer when fenced history drain fails", async () => {
    const assignment = hostedRuntimeAssignment();
    const fixture = legacyStopProviderFixture(assignment);
    const drain = vi.fn(async () => { throw new Error("history_grant_rejected"); });
    const { runtime, project } = lifecycleAdapter(assignment, fixture.provider, drain);

    await expect(runtime.stop(assignment, "op_stop", noOpBeforeEffect)).rejects.toThrow(
      "history_grant_rejected",
    );

    expect(drain).toHaveBeenCalledOnce();
    expect(fixture.writes).toEqual([]);
    expect(fixture.objects.has(`Pod/${fixture.namespace}/${fixture.podName}`)).toBe(true);
    expect((fixture.objects.get(`Deployment/${fixture.namespace}/${fixture.name}`) as { spec: { replicas: number } }).spec.replicas).toBe(1);
    expect(project).not.toHaveBeenCalled();
  });

  it("stores the bounded legacy seed before scaling down after a successful drain", async () => {
    const assignment = hostedRuntimeAssignment();
    const fixture = legacyStopProviderFixture(assignment);
    const drain = vi.fn(async () => undefined);
    const { runtime, project } = lifecycleAdapter(assignment, fixture.provider, drain);

    await runtime.stop(assignment, "op_stop", noOpBeforeEffect);

    expect(drain).toHaveBeenCalledOnce();
    expect(fixture.writes).toEqual(["create:Secret", "apply:Deployment"]);
    expect(fixture.objects.has(`Pod/${fixture.namespace}/${fixture.podName}`)).toBe(false);
    expect(fixture.objects.has(`Secret/${fixture.namespace}/${fixture.name}-history-seed`)).toBe(true);
    expect((fixture.objects.get(`Deployment/${fixture.namespace}/${fixture.name}`) as { spec: { replicas: number } }).spec.replicas).toBe(0);
    expect(project).not.toHaveBeenCalled();
  });
});

describe("runtime identity renewal after a controller outage", () => {
  it("replaces an expired projection only after rereading current authority", async () => {
    const assignment: RuntimeAssignment = {
      instanceId: "ins_00000000000000000000000001",
      repositoryId: 123456,
      runtimeEpoch: 5,
      generation: 2,
      clusterId: "cluster-a",
      reservationId: "res_target",
      deployment: deployment(),
    };
    const readRuntimeBinding = vi.fn(async () => ({
      active: true as const,
      authority: "observed-writer" as const,
      repositoryId: assignment.repositoryId,
      installationId: 789,
      instanceId: assignment.instanceId,
      runtimeId: "res_target",
      runtimeEpoch: assignment.runtimeEpoch,
      leaseId: "res_target",
      clusterId: assignment.clusterId,
    }));
    const issueRuntimeIdentity = vi.fn(async () => ({
      token: "renewed.header.signature",
      expiresAt: new Date(now + 300_000).toISOString(),
    }));
    const transport = new RuntimeIdentityAssignmentTransport({
      operations: {
        readRuntimeBinding,
        issueRuntimeIdentity,
      } as unknown as RuntimeIdentityProvisionerService,
      workerId: "worker-a",
      clusterId: assignment.clusterId,
      now: () => now,
    });
    const projected = transport.canonicalAssignment(assignment);
    const refreshRuntimeIdentity = vi.fn(async () => undefined);
    const runtime = Object.assign(Object.create(KubernetesLifecycleRuntimeAdapter.prototype), {
      provider: {
        readRuntimeIdentityProjection: vi.fn(async () => ({
          assignment: projected,
          expiresAt: new Date(now - 600_000).toISOString(),
        })),
        refreshRuntimeIdentity,
      },
      identityTransport: transport,
      now: () => now,
    }) as KubernetesLifecycleRuntimeAdapter;
    const beforeEffect = vi.fn(async () => undefined);
    expect(await runtime.refreshRuntimeIdentity(assignment, beforeEffect)).toBe(true);
    expect(readRuntimeBinding).toHaveBeenCalledOnce();
    expect(issueRuntimeIdentity).toHaveBeenCalledOnce();
    expect(refreshRuntimeIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ scriptoriumAssignment: projected }),
      "renewed.header.signature",
      expect.any(AbortSignal),
      beforeEffect,
    );
    readRuntimeBinding.mockResolvedValueOnce(null as never);
    await expect(runtime.refreshRuntimeIdentity(assignment, beforeEffect)).rejects.toThrow(
      "binding_unavailable_or_mismatched",
    );
    expect(issueRuntimeIdentity).toHaveBeenCalledOnce();
    expect(refreshRuntimeIdentity).toHaveBeenCalledOnce();
  });

  it("renews the exact startup writer before its projected proof expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const assignment: RuntimeAssignment = {
      instanceId: "ins_00000000000000000000000001",
      repositoryId: 123456,
      runtimeEpoch: 5,
      generation: 2,
      clusterId: "cluster-a",
      reservationId: "res_target",
      deployment: deployment(),
    };
    const initialExpiry = now + 300_000;
    let projectionExpiry = new Date(initialExpiry).toISOString();
    let issuedExpiry = projectionExpiry;
    let proofRefreshed = false;
    let startupObservedBeyondInitialExpiry = false;
    let renewalBeforeInitialExpiry = false;
    let inspectionCount = 0;
    const readRuntimeBinding = vi.fn(async () => ({
      active: true as const,
      authority: "observed-writer" as const,
      repositoryId: assignment.repositoryId,
      installationId: 789,
      instanceId: assignment.instanceId,
      runtimeId: "res_target",
      runtimeEpoch: assignment.runtimeEpoch,
      leaseId: "res_target",
      clusterId: assignment.clusterId,
    }));
    const issueRuntimeIdentity = vi.fn(async () => {
      issuedExpiry = new Date(Date.now() + 300_000).toISOString();
      return { token: "renewed.header.signature", expiresAt: issuedExpiry };
    });
    const transport = new RuntimeIdentityAssignmentTransport({
      operations: {
        readRuntimeBinding,
        issueRuntimeIdentity,
      } as unknown as RuntimeIdentityProvisionerService,
      workerId: "worker-a",
      clusterId: assignment.clusterId,
      now: () => Date.now(),
    });
    const projected = transport.canonicalAssignment(assignment);
    const observation = (generation: number) => ({
      identity: {
        instanceId: assignment.instanceId,
        repositoryId: assignment.repositoryId,
        runtimeEpoch: assignment.runtimeEpoch,
        generation: assignment.generation,
        clusterId: assignment.clusterId,
      },
      observationId: `observation-${generation}`,
      observedAt: Date.now(),
      namespaceExists: true,
      state: "applying",
      writerState: "running",
      writerCensus: {
        scope: "instance-repository-all-epochs",
        complete: true,
        queriedNamespace: "praetorium-instances-target",
        namespaceUid: "namespace-uid",
        namespaceResourceVersion: "namespace-rv",
        listResourceVersion: "pod-list-rv",
        queriedPodCount: 1,
        pods: [
          {
            namespace: "praetorium-instances-target",
            name: "arcadia-target",
            uid: `pod-${generation}`,
            runtimeEpoch: assignment.runtimeEpoch,
            generation,
            phase: "Running",
            deleting: false,
            ready: false,
            imageIds: [`containerd://${assignment.deployment.platformManifestDigest}`],
          },
        ],
      },
      observedImageDigest: assignment.deployment.platformManifestDigest,
      conditions: [],
    });
    const refreshRuntimeIdentity = vi.fn(async () => {
      renewalBeforeInitialExpiry = Date.now() < initialExpiry;
      projectionExpiry = issuedExpiry;
      proofRefreshed = true;
    });
    const provider = {
      ensureRunning: vi.fn(async () => {
        inspectionCount += 1;
        if (Date.now() > initialExpiry && !proofRefreshed)
          startupObservedBeyondInitialExpiry = true;
        return {
          status:
            proofRefreshed && Date.now() >= initialExpiry + 10_000
              ? ("unchanged" as const)
              : ("pending" as const),
          // A prior generation may still be shutting down. It must not arm
          // renewal, even though its container happens to share the image.
          observation: observation(
            inspectionCount === 1 ? assignment.generation - 1 : assignment.generation,
          ),
          progress: [],
        };
      }),
      readRuntimeIdentityProjection: vi.fn(async () => ({
        assignment: projected,
        expiresAt: projectionExpiry,
      })),
      refreshRuntimeIdentity,
    };
    const runtime = Object.assign(Object.create(KubernetesLifecycleRuntimeAdapter.prototype), {
      provider,
      now: () => Date.now(),
      convergenceTimeoutMs: 400_000,
      pollIntervalMs: 1_000,
      identityTransport: transport,
      identityRenewalController: undefined,
      identityRenewalTask: undefined,
    }) as KubernetesLifecycleRuntimeAdapter;
    try {
      const starting = runtime.start(assignment, "op_target", async () => undefined);
      await vi.advanceTimersByTimeAsync(310_000);
      await expect(starting).resolves.toBeUndefined();
      expect(Date.now()).toBeGreaterThan(initialExpiry);
      expect(startupObservedBeyondInitialExpiry).toBe(false);
      expect(renewalBeforeInitialExpiry).toBe(true);
      expect(refreshRuntimeIdentity).toHaveBeenCalledOnce();
      expect(provider.ensureRunning).toHaveBeenCalled();
      expect(inspectionCount).toBeGreaterThan(1);
      expect(Date.parse(projectionExpiry)).toBeGreaterThan(Date.now());
    } finally {
      await runtime.close();
      vi.useRealTimers();
    }
  });
});

describe("target runtime authority recovery evidence", () => {
  const assignment: RuntimeAssignment = {
    instanceId: "ins_00000000000000000000000001",
    repositoryId: 123456,
    runtimeEpoch: 5,
    generation: 2,
    clusterId: "cluster-a",
    reservationId: "res_target",
    deployment: deployment(),
  };

  function providerObservation(runtimeEpoch = assignment.runtimeEpoch): RuntimeObservation {
    return {
      identity: {
        instanceId: assignment.instanceId,
        repositoryId: assignment.repositoryId,
        runtimeEpoch: assignment.runtimeEpoch,
        generation: assignment.generation,
        clusterId: assignment.clusterId,
      },
      observationId: "ns-uid/pods-rv-10",
      observedAt: now,
      writerState: "running",
      writerCensus: {
        scope: "instance-repository-all-epochs",
        complete: true,
        queriedNamespace: "praetorium-instances-target",
        namespaceUid: "ns-uid",
        namespaceResourceVersion: "ns-rv-8",
        listResourceVersion: "pods-rv-10",
        queriedPodCount: 1,
        pods: [
          {
            namespace: "praetorium-instances-target",
            name: "arcadia-ins-target-abcde",
            uid: "pod-uid-1",
            runtimeEpoch,
            generation: assignment.generation,
            deleting: false,
            imageIds: [`containerd://${assignment.deployment.platformManifestDigest}`],
          },
        ],
      },
      observedImageDigest: assignment.deployment.platformManifestDigest,
      application: null,
      conditions: [],
    } as unknown as RuntimeObservation;
  }

  it("rechecks provider census and actual image before asking CP to restore authority", async () => {
    const recovery = vi.fn(async () => undefined);
    const provider = { inspect: vi.fn(async () => providerObservation()) };
    const runtime = Object.assign(Object.create(KubernetesLifecycleRuntimeAdapter.prototype), {
      provider,
      fence: {
        clusterId: assignment.clusterId,
        repositoryId: assignment.repositoryId,
        generation: assignment.generation,
        runtimeEpoch: assignment.runtimeEpoch,
      },
      now: () => now,
      authorityRecoveryOperations: { recoverRuntimeAuthority: recovery },
    }) as KubernetesLifecycleRuntimeAdapter;
    const beforeEffect = vi.fn(async () => undefined);

    await runtime.recoverTargetAuthority(
      {
        operationId: "op_01",
        workerId: "worker-a",
        leaseToken: "l".repeat(48),
        leaseEpoch: 4,
        expectedCheckpointSequence: 5,
        assignment,
        census: {
          complete: true,
          providerObservationId: "pods-before-start",
          observedAt: new Date(now - 100).toISOString(),
          matchedWriterCount: 1,
          writers: [{ runtimeEpoch: 5, phase: "running", identities: ["pod-uid-1"] }],
        },
      },
      beforeEffect,
    );

    expect(provider.inspect).toHaveBeenCalledOnce();
    expect(beforeEffect).toHaveBeenCalledOnce();
    expect(recovery).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "op_01",
        expectedCheckpointSequence: 5,
        evidence: expect.objectContaining({
          reservationId: "res_target",
          actualImageDigest: assignment.deployment.platformManifestDigest,
          imageIdentityVerified: true,
          census: expect.objectContaining({
            providerObservationId: "ns-uid/pods-rv-10",
            matchedWriterCount: 1,
          }),
        }),
      }),
    );
  });

  it("rejects an extra or stale writer before the recovery endpoint", async () => {
    const recovery = vi.fn(async () => undefined);
    const provider = { inspect: vi.fn(async () => providerObservation(4)) };
    const runtime = Object.assign(Object.create(KubernetesLifecycleRuntimeAdapter.prototype), {
      provider,
      fence: {
        clusterId: assignment.clusterId,
        repositoryId: assignment.repositoryId,
        generation: assignment.generation,
        runtimeEpoch: assignment.runtimeEpoch,
      },
      now: () => now,
      authorityRecoveryOperations: { recoverRuntimeAuthority: recovery },
    }) as KubernetesLifecycleRuntimeAdapter;

    await expect(
      runtime.recoverTargetAuthority(
        {
          operationId: "op_01",
          workerId: "worker-a",
          leaseToken: "l".repeat(48),
          leaseEpoch: 4,
          expectedCheckpointSequence: 5,
          assignment,
          census: {
            complete: true,
            providerObservationId: "pods-before-start",
            observedAt: new Date(now - 100).toISOString(),
            matchedWriterCount: 1,
            writers: [{ runtimeEpoch: 5, phase: "running", identities: ["pod-uid-1"] }],
          },
        },
        async () => undefined,
      ),
    ).rejects.toThrow("not the exact target");
    expect(recovery).not.toHaveBeenCalled();
  });
});
