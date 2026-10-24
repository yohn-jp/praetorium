import { afterEach, describe, expect, it, vi } from "vitest";
import { LifecycleService, type RuntimeAssignment } from "@praetorium/application/lifecycle";
import {
  parseRuntimeInstanceId,
  runtimeNamespaceName,
  runtimeResourceName,
} from "@praetorium/kubernetes";
import type * as Kubernetes from "@praetorium/kubernetes";
import { LifecycleProvisionerExecutor } from "./lifecycle-executor.js";
import {
  KubernetesLifecycleRuntimeAdapter,
  LifecycleReservationAdapter,
} from "./kubernetes-lifecycle-adapter.js";
import type {
  ClaimedProvisionerOperation,
  ProvisionerOperationService,
} from "./operation-client.js";
import type { RuntimeAuthAcceptanceProbe } from "./scriptorium-control-client.js";
import type { RuntimeIdentityAssignmentTransport } from "./runtime-identity.js";
import { assignmentOf } from "./lifecycle-journal.js";

vi.mock("@praetorium/kubernetes", async (importOriginal) => ({
  ...(await importOriginal<typeof Kubernetes>()),
  createInClusterKubernetesRuntimeProvider: () => ({}),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("recovered completion auth transport", () => {
  async function resolver() {
    let resolveEndpoint:
      | Parameters<RuntimeAuthAcceptanceProbe["withEndpointResolver"]>[0]
      | undefined;
    const probe = {
      available: true,
      withEndpointResolver: (resolve: typeof resolveEndpoint) => {
        if (resolveEndpoint === undefined) resolveEndpoint = resolve;
        return probe;
      },
      forLease: () => probe,
    } as unknown as RuntimeAuthAcceptanceProbe;
    vi.spyOn(LifecycleService.prototype, "execute").mockResolvedValue({
      status: "complete",
      observed: null,
    });
    const claim = {
      operation: {
        id: "op-recovery",
        instanceId: "ins-recovery",
        repositoryId: 123456,
        clusterId: "cluster-a",
        generation: 2,
        runtimeEpoch: 5,
        kind: "redeploy",
        phase: "complete",
        checkpoint: null,
        checkpointSequence: 0,
      },
      runtimeContext: { current: null, target: null },
      reservation: null,
      currentReservation: null,
    } as ClaimedProvisionerOperation;
    const assertLease = vi.fn(async () => undefined);
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
    const renew = vi
      .spyOn(KubernetesLifecycleRuntimeAdapter.prototype, "refreshRuntimeIdentity")
      .mockImplementation(async (_assignment, guard) => {
        await guard();
        calls.push("renew");
        return true;
      });
    vi.spyOn(KubernetesLifecycleRuntimeAdapter.prototype, "controlEndpoint").mockImplementation(
      async () => {
        calls.push("endpoint");
        return "http://runtime-control:3000/";
      },
    );
    const { resolveEndpoint, assertLease } = await resolver();
    const assignment = {} as RuntimeAssignment;
    const signal = new AbortController().signal;
    expect(await resolveEndpoint(assignment, signal)).toBe("http://runtime-control:3000/");
    expect(renew).toHaveBeenCalledWith(assignment, assertLease, signal);
    expect(assertLease).toHaveBeenCalledOnce();
    expect(calls).toEqual(["renew", "endpoint"]);
  });

  it("does not continue the auth probe when current identity authority is denied", async () => {
    vi.spyOn(
      KubernetesLifecycleRuntimeAdapter.prototype,
      "refreshRuntimeIdentity",
    ).mockRejectedValue(new Error("runtime_identity_binding_unavailable_or_mismatched"));
    const endpoint = vi.spyOn(KubernetesLifecycleRuntimeAdapter.prototype, "controlEndpoint");
    const { resolveEndpoint } = await resolver();
    await expect(resolveEndpoint({} as RuntimeAssignment)).rejects.toThrow(
      "runtime_identity_binding_unavailable_or_mismatched",
    );
    expect(endpoint).not.toHaveBeenCalled();
  });
});

describe("reclaimed route-activated reservation release", () => {
  it("uses the validated checkpointed old reservation instead of the newly observed target", async () => {
    const releaseRuntime = vi.fn(async () => undefined);
    const operations = { releaseRuntime } as unknown as ProvisionerOperationService;
    const claim = {
      operation: {
        id: "op-recovery",
        instanceId: "ins-recovery",
        repositoryId: 123456,
        clusterId: "cluster-a",
        generation: 2,
        runtimeEpoch: 5,
        kind: "redeploy",
        status: "claimed",
        workerId: "worker-a",
        leaseToken: "lease-recovery",
        leaseEpoch: 2,
        leaseExpiresAt: 1_797_000_030_000,
        reportSequence: 0,
        phase: "route-activated",
        checkpointSequence: 8,
        deploymentRevisionId: "rev-target",
        reservationId: "res-target",
        checkpoint: {
          schemaVersion: 1,
          lifecycle: {
            id: "op-recovery",
            version: 7,
            instanceId: "ins-recovery",
            repositoryId: 123456,
            clusterId: "cluster-a",
            generation: 2,
            kind: "redeploy",
            reason: "redeploy",
            phase: "route-activated",
            runtimeEpoch: 5,
            current: {
              instanceId: "ins-recovery",
              repositoryId: 123456,
              runtimeEpoch: 4,
              reservationId: "res-retired",
            },
            target: null,
            targetEpoch: 5,
            targetReservationId: "res-target",
            rollbackEpoch: null,
            writerAbsenceProof: null,
          },
        },
      },
      snapshot: {
        binding: { suspended: false },
        instance: { observedGeneration: 2, reservationId: "res-target", clusterId: "cluster-a" },
      },
      reservation: { reservationId: "res-target", runtimeEpoch: 5 },
      currentReservation: { reservationId: "res-target", runtimeEpoch: 5 },
      runtimeContext: { current: null, target: null },
    } as unknown as ClaimedProvisionerOperation;
    const probe = {
      available: true,
      withEndpointResolver: () => probe,
      forLease: () => probe,
    } as unknown as RuntimeAuthAcceptanceProbe;
    const executor = new LifecycleProvisionerExecutor({
      operations,
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
    const releaseAdapter = vi.spyOn(LifecycleReservationAdapter.prototype, "release");
    vi.spyOn(LifecycleService.prototype, "execute").mockImplementation(async function (
      this: LifecycleService,
      operationId,
    ) {
      const capacity = (
        this as unknown as {
          dependencies: { capacity: LifecycleReservationAdapter };
        }
      ).dependencies.capacity;
      await capacity.release("res-retired", operationId, async () => undefined);
      return { status: "complete", observed: null };
    });

    await executor.execute(claim, {
      signal: new AbortController().signal,
      assertLease: async () => undefined,
      report: async () => undefined,
    });

    expect(releaseAdapter).toHaveBeenCalledOnce();
    expect(releaseRuntime).toHaveBeenCalledWith({
      reservationId: "res-retired",
      operationId: "op-recovery",
      workerId: "worker-a",
      leaseToken: "lease-recovery",
      leaseEpoch: 2,
      expectedReservationRuntimeEpoch: 4,
    });
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
    const assertLease = vi.fn(async () => {
      events.push("lease");
    });
    const execute = vi.spyOn(LifecycleService.prototype, "execute").mockImplementation(async () => {
      events.push("lifecycle");
      return { status: "unknown", code: "test", reason: "test" };
    });
    const refresh = vi
      .spyOn(KubernetesLifecycleRuntimeAdapter.prototype, "refreshRuntimeIdentity")
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

  it("recovers a retained unknown preflight checkpoint through signed resume before refreshing identity", async () => {
    const validInstanceId = "ins_01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const base = currentClaim("unknown");
    const resolvedCurrent = base.runtimeContext.current!;
    const checkpointedRequest = {
      contractVersion: "scriptorium-platform/v1",
      operationId: base.operation.id,
      instanceId: validInstanceId,
      runtimeEpoch: 1,
      reason: "redeploy",
      deadline: "2026-10-20T00:00:00.000Z",
    };
    const claim = {
      ...base,
      operation: {
        ...base.operation,
        instanceId: validInstanceId,
        phase: "unknown",
        status: "running",
        workerId: "worker-a",
        leaseToken: "l".repeat(40),
        leaseExpiresAt: Date.now() + 120_000,
        checkpointSequence: 4,
        checkpoint: {
          schemaVersion: 1,
          lifecycle: {
            id: base.operation.id,
            version: 4,
            instanceId: validInstanceId,
            repositoryId: 123456,
            clusterId: "cluster-a",
            generation: 4,
            kind: "start",
            reason: "user",
            phase: "unknown",
            runtimeEpoch: 3,
            current: {
              instanceId: validInstanceId,
              repositoryId: 123456,
              runtimeEpoch: resolvedCurrent.assignment.runtimeEpoch,
              generation: 2,
              clusterId: "cluster-a",
              reservationId: "res-current",
              deployment: {
                revisionId: resolvedCurrent.revisionId,
                imageDigest: resolvedCurrent.assignment.imageDigest,
                compositionManifestDigest: resolvedCurrent.assignment.compositionManifestDigest,
                artifactRef: resolvedCurrent.artifactRef,
                platformManifestDigest: resolvedCurrent.platformManifestDigest,
                enabledModuleIds: resolvedCurrent.assignment.enabledModuleIds,
              },
            },
            target: null,
            targetEpoch: 3,
            targetReservationId: null,
            rollbackEpoch: null,
            quiesceRequest: checkpointedRequest,
            quiesceReceipt: null,
            writerAbsenceProof: null,
            readinessEvidence: null,
            rollbackCompatibilityEvidence: null,
            rollbackCompatible: null,
            buildId: null,
            failureCode: "producer_remote_preflight_unverified",
            failureReason: "remote confirmation unavailable",
            lastAuthenticatedActivityAt: null,
          },
        },
      },
      snapshot: {
        ...base.snapshot,
        instance: { ...base.snapshot.instance, instanceId: validInstanceId },
      },
    } as unknown as ClaimedProvisionerOperation;
    const current = assignmentOf(claim, claim.runtimeContext.current!, true);
    const namespace = runtimeNamespaceName(
      "praetorium-instances",
      parseRuntimeInstanceId(validInstanceId),
    );
    const service = runtimeResourceName(parseRuntimeInstanceId(validInstanceId));
    const events: string[] = [];
    const phases: string[] = [];
    const quiesceDeadlines: string[] = [];
    let clock = Date.now();
    let resumeCount = 0;
    const operations = {
      issueControlCredential: async () => ({
        token: "scoped-runtime-control-token",
        expiresAt: new Date(clock + 60_000).toISOString(),
      }),
      checkpoint: async (input: {
        phase: string;
        expectedCheckpointSequence: number;
        checkpoint: unknown;
      }) => {
        phases.push(input.phase);
        events.push(`checkpoint:${input.phase}`);
        if (input.phase === "quiescing-old") {
          const lifecycle = (
            input.checkpoint as { lifecycle?: { quiesceRequest?: { deadline?: unknown } } }
          ).lifecycle;
          const deadline = lifecycle?.quiesceRequest?.deadline;
          if (typeof deadline === "string") quiesceDeadlines.push(deadline);
          if (quiesceDeadlines.length === 1) clock += 31_000;
        }
        return {
          operation: {
            ...claim.operation,
            phase: input.phase,
            checkpointSequence: input.expectedCheckpointSequence + 1,
            checkpoint: input.checkpoint,
          },
        };
      },
    } as unknown as ProvisionerOperationService;
    vi.spyOn(KubernetesLifecycleRuntimeAdapter.prototype, "controlEndpoint").mockResolvedValue(
      `http://${service}.${namespace}.svc.cluster.local:3000/`,
    );
    const census = vi
      .spyOn(KubernetesLifecycleRuntimeAdapter.prototype, "censusWriters")
      .mockResolvedValueOnce({
        complete: true,
        providerObservationId: "provider-empty-census",
        observedAt: new Date(clock - 1).toISOString(),
        matchedWriterCount: 0,
        writers: [],
      })
      .mockResolvedValueOnce({
        complete: true,
        providerObservationId: "provider-target-census",
        observedAt: new Date(clock - 1).toISOString(),
        matchedWriterCount: 1,
        writers: [{ runtimeEpoch: 3, phase: "running", identities: ["pod-target"] }],
      })
      .mockResolvedValueOnce({
        complete: true,
        providerObservationId: "provider-census-1",
        observedAt: new Date(clock - 1).toISOString(),
        matchedWriterCount: 1,
        writers: [{ runtimeEpoch: 1, phase: "running", identities: ["pod-current"] }],
      });
    const refresh = vi
      .spyOn(KubernetesLifecycleRuntimeAdapter.prototype, "refreshRuntimeIdentity")
      .mockImplementation(async () => {
        events.push("identity-refresh");
        return true;
      });
    vi.spyOn(LifecycleService.prototype, "execute").mockImplementation(async () => {
      events.push("lifecycle");
      return { status: "unknown", code: "test", reason: "test" };
    });
    const fetchControl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/resume")) {
        resumeCount += 1;
        events.push(`resume:${resumeCount}`);
        return resumeCount === 1
          ? Response.json({ error: { code: "RESUME_BINDING_MISMATCH" } }, { status: 409 })
          : new Response(null, { status: 204 });
      }
      if (url.pathname.endsWith("/quiesce")) {
        events.push("quiesce");
        return Response.json({
          contractVersion: "scriptorium-platform/v1",
          operationId: base.operation.id,
          instanceId: validInstanceId,
          runtimeEpoch: 1,
          quiesceRevision: "recovery-q-1",
          disposition: "unknown",
          activeMutations: 0,
          activeJobs: 0,
          restartableJobs: 0,
          pendingCheckpoints: 1,
          uncertainPublication: true,
          lastConfirmedRemoteRevision: null,
          reasonCodes: ["REMOTE_CONFIRMATION_UNAVAILABLE"],
          observedAt: new Date().toISOString(),
        });
      }
      throw new Error("unexpected runtime control endpoint");
    });
    vi.stubGlobal("fetch", fetchControl);
    const assertLease = vi.fn(async () => undefined);
    const probe = {
      available: true,
      withEndpointResolver: () => probe,
      forLease: () => probe,
    } as unknown as RuntimeAuthAcceptanceProbe;
    const executor = new LifecycleProvisionerExecutor({
      operations,
      workerId: "worker-a",
      now: () => clock,
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

    const context = {
      signal: new AbortController().signal,
      assertLease,
      report: async (phase: string) => {
        events.push(`report:${phase}`);
      },
    };

    const mismatchedCheckpoint = structuredClone(claim.operation.checkpoint!);
    const mismatchedLifecycle = mismatchedCheckpoint.lifecycle as Record<string, unknown>;
    const mismatchedCurrent = mismatchedLifecycle.current as Record<string, unknown>;
    const mismatchedDeployment = mismatchedCurrent.deployment as Record<string, unknown>;
    mismatchedDeployment.legacyRuntimeEpoch = 1;
    const mismatchedClaim = {
      ...claim,
      operation: { ...claim.operation, checkpoint: mismatchedCheckpoint },
    } as ClaimedProvisionerOperation;
    census.mockReset().mockResolvedValue({
      complete: true,
      providerObservationId: "provider-census-1",
      observedAt: new Date(clock - 1).toISOString(),
      matchedWriterCount: 1,
      writers: [{ runtimeEpoch: 1, phase: "running", identities: ["pod-current"] }],
    });
    await expect(executor.execute(mismatchedClaim, context)).rejects.toThrow(
      "persisted quiesce request does not match the admitted runtime assignment",
    );
    expect(census).not.toHaveBeenCalled();
    expect(fetchControl).not.toHaveBeenCalled();

    census
      .mockReset()
      .mockResolvedValueOnce({
        complete: true,
        providerObservationId: "provider-empty-census",
        observedAt: new Date(clock - 1).toISOString(),
        matchedWriterCount: 0,
        writers: [],
      })
      .mockResolvedValueOnce({
        complete: true,
        providerObservationId: "provider-target-census",
        observedAt: new Date(clock - 1).toISOString(),
        matchedWriterCount: 1,
        writers: [{ runtimeEpoch: 3, phase: "running", identities: ["pod-target"] }],
      })
      .mockResolvedValueOnce({
        complete: true,
        providerObservationId: "provider-census-1",
        observedAt: new Date(clock - 1).toISOString(),
        matchedWriterCount: 1,
        writers: [{ runtimeEpoch: 1, phase: "running", identities: ["pod-current"] }],
      });

    await expect(executor.execute(claim, context)).rejects.toThrow(
      "persisted quiesce recovery requires the exact sole running writer",
    );
    await expect(executor.execute(claim, context)).rejects.toThrow(
      "persisted quiesce recovery requires the exact sole running writer",
    );
    expect(fetchControl).not.toHaveBeenCalled();
    expect(phases).toEqual([]);
    expect(census).toHaveBeenCalledTimes(2);

    await executor.execute(claim, context);

    expect(current).toMatchObject({ instanceId: validInstanceId, runtimeEpoch: 1 });
    expect(phases).toEqual(["quiescing-old", "quiescing-old", "old-quiesced", "accepted"]);
    expect(quiesceDeadlines).toHaveLength(2);
    expect(Date.parse(quiesceDeadlines[0] ?? "")).toBeLessThanOrEqual(clock);
    expect(Date.parse(quiesceDeadlines[1] ?? "")).toBeGreaterThan(clock);
    expect(resumeCount).toBe(2);
    expect(refresh).toHaveBeenCalledWith(current, assertLease, expect.any(AbortSignal));
    expect(events.indexOf("resume:2")).toBeLessThan(events.indexOf("checkpoint:accepted"));
    expect(events.indexOf("checkpoint:accepted")).toBeLessThan(events.indexOf("identity-refresh"));
    expect(events.indexOf("identity-refresh")).toBeLessThan(events.indexOf("lifecycle"));
  });
});
