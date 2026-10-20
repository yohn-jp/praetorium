import { afterEach, describe, expect, it, vi } from "vitest";
import { LifecycleService, type RuntimeAssignment } from "@praetorium/application/lifecycle";
import type * as Kubernetes from "@praetorium/kubernetes";
import { LifecycleProvisionerExecutor } from "./lifecycle-executor.js";
import { KubernetesLifecycleRuntimeAdapter } from "./kubernetes-lifecycle-adapter.js";
import type { ClaimedProvisionerOperation, ProvisionerOperationService } from "./operation-client.js";
import type { RuntimeAuthAcceptanceProbe } from "./scriptorium-control-client.js";
import type { RuntimeIdentityAssignmentTransport } from "./runtime-identity.js";
import { assignmentOf } from "./lifecycle-journal.js";

vi.mock("@praetorium/kubernetes", async (importOriginal) => ({
  ...await importOriginal<typeof Kubernetes>(),
  createInClusterKubernetesRuntimeProvider: () => ({}),
}));

afterEach(() => vi.restoreAllMocks());

describe("recovered completion auth transport", () => {
  async function resolver() {
    let resolveEndpoint: Parameters<RuntimeAuthAcceptanceProbe["withEndpointResolver"]>[0] | undefined;
    const probe = {
      available: true,
      withEndpointResolver: (resolve: typeof resolveEndpoint) => {
        resolveEndpoint = resolve;
        return probe;
      },
      forLease: () => probe,
    } as unknown as RuntimeAuthAcceptanceProbe;
    vi.spyOn(LifecycleService.prototype, "execute").mockResolvedValue({ status: "complete", observed: null });
    const claim = {
      operation: {
        id: "op-recovery", instanceId: "ins-recovery", repositoryId: 123456,
        clusterId: "cluster-a", generation: 2, runtimeEpoch: 5,
        kind: "redeploy", phase: "complete", checkpoint: null, checkpointSequence: 0,
      },
      runtimeContext: { current: null, target: null },
      reservation: null, currentReservation: null,
    } as ClaimedProvisionerOperation;
    const assertLease = vi.fn(async () => undefined);
    const executor = new LifecycleProvisionerExecutor({
      operations: {} as ProvisionerOperationService,
      workerId: "worker-a",
      runtime: {
        namespacePrefix: "praetorium-instances", clusterId: "cluster-a",
        ingressNamespace: "traefik", instanceAccessNamespace: "praetorium-system",
        instanceAccessService: "instance-access", controlNamespace: "praetorium-system",
        controlService: "provisioner", maxCapacityAgeMs: 60_000,
        maximumResources: { cpuMilli: 1000, memoryMiB: 1024, ephemeralStorageMiB: 1024 },
      },
      authProbe: probe,
      assignmentTransport: { available: true, forClaim: () => ({}) } as unknown as RuntimeIdentityAssignmentTransport,
    });
    expect(executor.canExecute).toBe(true);
    await executor.execute(claim, {
      signal: new AbortController().signal,
      assertLease,
      report: async () => undefined,
    });
    expect(resolveEndpoint).toBeDefined();
    return { resolveEndpoint: resolveEndpoint!, assertLease };
  }

  it("renews the fenced repository identity before resolving remote snapshot access", async () => {
    const calls: string[] = [];
    const renew = vi.spyOn(KubernetesLifecycleRuntimeAdapter.prototype, "refreshRuntimeIdentity")
      .mockImplementation(async (_assignment, guard) => {
        await guard(); calls.push("renew"); return true;
      });
    vi.spyOn(KubernetesLifecycleRuntimeAdapter.prototype, "controlEndpoint")
      .mockImplementation(async () => { calls.push("endpoint"); return "http://runtime-control:3000/"; });
    const { resolveEndpoint, assertLease } = await resolver();
    const assignment = {} as RuntimeAssignment;
    const signal = new AbortController().signal;
    expect(await resolveEndpoint(assignment, signal)).toBe("http://runtime-control:3000/");
    expect(renew).toHaveBeenCalledWith(assignment, assertLease, signal);
    expect(assertLease).toHaveBeenCalledOnce();
    expect(calls).toEqual(["renew", "endpoint"]);
  });

  it("does not continue the auth probe when current identity authority is denied", async () => {
    vi.spyOn(KubernetesLifecycleRuntimeAdapter.prototype, "refreshRuntimeIdentity")
      .mockRejectedValue(new Error("runtime_identity_binding_unavailable_or_mismatched"));
    const endpoint = vi.spyOn(KubernetesLifecycleRuntimeAdapter.prototype, "controlEndpoint");
    const { resolveEndpoint } = await resolver();
    await expect(resolveEndpoint({} as RuntimeAssignment)).rejects.toThrow("runtime_identity_binding_unavailable_or_mismatched");
    expect(endpoint).not.toHaveBeenCalled();
  });
});

describe("observed runtime identity renewal", () => {
  function currentClaim(
    phase: string,
    checkpoint: Readonly<Record<string, unknown>> | null = null,
  ): ClaimedProvisionerOperation {
    const current = {
      revisionId: "rev-current",
      artifactRef: "artifact",
      platformManifestDigest: "platform-digest",
      resourceProfileId: "small",
      hostname: "tenant.example",
      resources: { cpuMilli: 100, memoryMiB: 128, ephemeralStorageMiB: 256 },
      assignment: {
        repositoryId: 123456,
        repositoryLocator: "example/project",
        defaultBranchPolicy: "default",
        runtimeEpoch: 1,
        imageDigest: "image-digest",
        compositionManifestDigest: "composition-digest",
        enabledModuleIds: [],
        credentialBrokerLocator: "broker",
        grantPolicy: {},
        controlServicePolicy: {},
      },
      metadata: {
        producerRevision: "producer",
        listener: { port: 3000 },
        paths: {
          liveness: "/live",
          readiness: "/ready",
          metadata: "/meta",
          shutdown: "/stop",
          status: "/api/platform/v1/status",
          quiesce: "/api/platform/v1/quiesce",
          resume: "/api/platform/v1/resume",
        },
        shutdownTimeoutSeconds: 5,
      },
    } as unknown as NonNullable<ClaimedProvisionerOperation["runtimeContext"]["current"]>;
    return {
      operation: {
        id: "op-current-refresh",
        instanceId: "ins-current",
        repositoryId: 123456,
        generation: 4,
        runtimeEpoch: 3,
        kind: "start",
        status: "claimed",
        leaseEpoch: 1,
        reportSequence: 0,
        phase,
        checkpoint,
        checkpointSequence: 0,
        clusterId: "cluster-a",
        reservationId: null,
        deploymentRevisionId: "rev-target",
      } as ClaimedProvisionerOperation["operation"],
      snapshot: {
        binding: { suspended: false } as ClaimedProvisionerOperation["snapshot"]["binding"],
        instance: {
          observedGeneration: 2,
          reservationId: "res-current",
          clusterId: "cluster-a",
        } as ClaimedProvisionerOperation["snapshot"]["instance"],
      },
      reservation: null,
      currentReservation: null,
      runtimeContext: { current, target: null },
    } as unknown as ClaimedProvisionerOperation;
  }

  it("renews only the exact observed assignment before retirement is checkpointed", async () => {
    const events: string[] = [];
    const probe = {
      available: true,
      withEndpointResolver: () => probe,
      forLease: () => probe,
    } as unknown as RuntimeAuthAcceptanceProbe;
    const assertLease = vi.fn(async () => { events.push("lease"); });
    const execute = vi.spyOn(LifecycleService.prototype, "execute").mockImplementation(async () => {
      events.push("lifecycle");
      return { status: "unknown", code: "test", reason: "test" };
    });
    const refresh = vi.spyOn(KubernetesLifecycleRuntimeAdapter.prototype, "refreshRuntimeIdentity")
      .mockImplementation(async (_assignment, beforeEffect) => {
        events.push("refresh");
        await beforeEffect();
        return true;
      });
    const executor = new LifecycleProvisionerExecutor({
      operations: {} as ProvisionerOperationService,
      workerId: "worker-a",
      runtime: {
        namespacePrefix: "praetorium-instances",
        clusterId: "cluster-a",
        ingressNamespace: "traefik",
        instanceAccessNamespace: "praetorium-system",
        instanceAccessService: "instance-access",
        controlNamespace: "praetorium-system",
        controlService: "provisioner",
        maxCapacityAgeMs: 60_000,
        maximumResources: { cpuMilli: 1000, memoryMiB: 1024, ephemeralStorageMiB: 1024 },
      },
      authProbe: probe,
      assignmentTransport: {
        available: true,
        forClaim: () => ({}),
      } as unknown as RuntimeIdentityAssignmentTransport,
    });
    const claim = currentClaim("accepted");
    const assignment = assignmentOf(claim, claim.runtimeContext.current!, true);
    expect(assignment).toMatchObject({
      instanceId: "ins-current",
      repositoryId: 123456,
      generation: 2,
      runtimeEpoch: 1,
    });
    expect(claim.operation).toMatchObject({ generation: 4, runtimeEpoch: 3 });
    const signal = new AbortController().signal;

    await executor.execute(claim, { signal, assertLease, report: async () => undefined });

    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledWith(assignment, assertLease, signal);
    expect(events).toEqual(["refresh", "lease", "lifecycle"]);
    expect(execute).toHaveBeenCalledOnce();

    events.length = 0;
    const retiring = currentClaim("old-quiesced");
    await executor.execute(retiring, { signal, assertLease, report: async () => undefined });
    expect(refresh).toHaveBeenCalledOnce();
    expect(events).toEqual(["lifecycle"]);
  });
});
