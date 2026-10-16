import { describe, expect, it, vi } from "vitest";
import type { RuntimeAssignment } from "@praetorium/application/lifecycle";
import type { ProvisionerOperationService } from "./operation-client.js";
import { LifecycleReservationAdapter } from "./kubernetes-lifecycle-adapter.js";
import type { KubernetesLifecycleRuntimeAdapter } from "./kubernetes-lifecycle-adapter.js";

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
