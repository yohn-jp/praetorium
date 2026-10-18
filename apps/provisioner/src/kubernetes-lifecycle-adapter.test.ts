import { describe, expect, it, vi } from "vitest";
import type { RuntimeAssignment } from "@praetorium/application/lifecycle";
import type { ProvisionerOperationService } from "./operation-client.js";
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

describe("LifecycleReservationAdapter", () => {
  it("waits before retiring the old runtime when other reservations fragment node capacity", async () => {
    const { adapter: capacity, reserveRuntime } = adapter();

    await expect(
      capacity.reserve("op_target", "ins_target", deployment(), async () => undefined),
    ).resolves.toEqual({ status: "pending" });
    expect(reserveRuntime).not.toHaveBeenCalled();
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
