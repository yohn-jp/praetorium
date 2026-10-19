import { afterEach, describe, expect, it, vi } from "vitest";
import { LifecycleService, type RuntimeAssignment } from "@praetorium/application/lifecycle";
import type * as Kubernetes from "@praetorium/kubernetes";
import { LifecycleProvisionerExecutor } from "./lifecycle-executor.js";
import { KubernetesLifecycleRuntimeAdapter } from "./kubernetes-lifecycle-adapter.js";
import type { ClaimedProvisionerOperation, ProvisionerOperationService } from "./operation-client.js";
import type { RuntimeAuthAcceptanceProbe } from "./scriptorium-control-client.js";
import type { RuntimeIdentityAssignmentTransport } from "./runtime-identity.js";

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
      applicationDns: { publish: async () => undefined },
      assignmentTransport: { available: true, forClaim: () => ({}) } as unknown as RuntimeIdentityAssignmentTransport,
    });
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
