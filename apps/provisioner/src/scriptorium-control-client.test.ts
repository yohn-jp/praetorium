import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { assignmentInstanceId } from "@praetorium/contracts";
import {
  hasFreshRemoteObservation,
  type ProducerStatus,
  type RuntimeAssignment,
} from "@praetorium/application/lifecycle";
import {
  IdleObservationRuntimeControlCredentialProvider,
  ScriptoriumControlHttpClient,
  type RuntimeControlCredentialRequest,
} from "./scriptorium-control-client.js";
import type { ProvisionerOperationService } from "./operation-client.js";

const instanceId = "ins_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const imageDigest = `sha256:${"a".repeat(64)}`;
const compositionDigest = `sha256:${"b".repeat(64)}`;

function assignment(): RuntimeAssignment {
  return {
    instanceId,
    repositoryId: 123456,
    runtimeEpoch: 9,
    generation: 4,
    clusterId: "clu_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    reservationId: "res_01",
    deployment: {
      revisionId: "rev_01",
      repositoryId: 123456,
      repositoryLocator: "https://github.com/example/repo",
      defaultBranchPolicy: "repository-default",
      imageDigest,
      artifactRef: `registry.example.test/scriptorium@${imageDigest}`,
      platformManifestDigest: `sha256:${"c".repeat(64)}`,
      compositionManifestDigest: compositionDigest,
      enabledModuleIds: ["core"],
      credentialBrokerLocator: "https://credentials.example.test",
      grantPolicy: {
        issuer: "https://platform.example.test",
        jwksUrl: "https://platform.example.test/.well-known/grant-jwks.json",
        audience: "https://app.example.test",
      },
      controlServicePolicy: {
        issuer: "https://platform.example.test",
        jwksUrl: "https://platform.example.test/.well-known/control-jwks.json",
        audience: "praetorium-runtime-control",
      },
      runtimeMetadata: {
        producerRevision: "d".repeat(40),
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
      hostname: "app.example.test",
      resourceProfileId: "small",
      resources: { cpuMilli: 500, memoryMiB: 512, ephemeralStorageMiB: 256 },
    },
  };
}

function responseStatus(): unknown {
  return {
    contractVersion: "scriptorium-platform/v1",
    instanceId,
    repositoryId: 123456,
    runtimeEpoch: 9,
    imageDigest,
    compositionManifestDigest: compositionDigest,
    enabledModuleIds: ["core"],
    ready: true,
    activity: {
      lastMeaningfulActivityAt: "2026-10-17T10:00:00.000Z",
      activeApiRequests: 0,
      activeMcpRequests: 0,
      activeMutations: 0,
      activeJobs: 0,
      restartableJobs: 0,
      pendingCheckpoints: 0,
      uncertainPublication: false,
    },
    lastConfirmedRemoteRevision: "a".repeat(40),
    observedAt: "2026-10-17T10:01:00.000Z",
  };
}

function unknownPersistenceStatus(): unknown {
  return {
    ...(responseStatus() as object),
    lastConfirmedRemoteRevision: null,
    persistence: {
      state: "unknown",
      observedRemoteCommit: null,
      formats: [],
    },
  };
}

function verifiedPersistenceStatus(): unknown {
  return {
    ...(responseStatus() as object),
    persistence: {
      state: "verified",
      remoteObservedAt: "2026-10-17T10:00:30.000Z",
      observedRemoteCommit: "a".repeat(40),
      formats: [{ formatId: "scriptorium.core", version: 1 }],
    },
  };
}

function quiesceResponse(request: Record<string, unknown>, observedAt: string): unknown {
  return {
    contractVersion: "scriptorium-platform/v1",
    operationId: request.operationId,
    instanceId,
    runtimeEpoch: 9,
    quiesceRevision: "q_01",
    disposition: "safe",
    activeMutations: 0,
    activeJobs: 0,
    restartableJobs: 0,
    pendingCheckpoints: 0,
    uncertainPublication: false,
    lastConfirmedRemoteRevision: "a".repeat(40),
    reasonCodes: [],
    observedAt,
  };
}

function client(options: {
  now?: () => number;
  fetch?: typeof globalThis.fetch;
  onCredential?: (value: RuntimeControlCredentialRequest) => void;
  unknownPersistenceRetries?: number;
  unknownPersistenceDelayedRetries?: number;
  unknownPersistenceRetryDelayMs?: number;
  beforeStatusRetry?: () => Promise<void>;
}) {
  const current = assignment();
  const control = new ScriptoriumControlHttpClient(
    {
      namespacePrefix: "tenant",
      resolveEndpoint: async () => {
        const { runtimeNamespaceName, runtimeResourceName, parseRuntimeInstanceId } = await import(
          "@praetorium/kubernetes"
        );
        const id = parseRuntimeInstanceId(instanceId);
        return `http://${runtimeResourceName(id)}.${runtimeNamespaceName("tenant", id)}.svc.cluster.local:3000`;
      },
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.unknownPersistenceRetries === undefined
        ? {}
        : { unknownPersistenceRetries: options.unknownPersistenceRetries }),
      ...(options.unknownPersistenceDelayedRetries === undefined
        ? {}
        : { unknownPersistenceDelayedRetries: options.unknownPersistenceDelayedRetries }),
      ...(options.unknownPersistenceRetryDelayMs === undefined
        ? {}
        : { unknownPersistenceRetryDelayMs: options.unknownPersistenceRetryDelayMs }),
      ...(options.beforeStatusRetry === undefined
        ? {}
        : { beforeStatusRetry: options.beforeStatusRetry }),
    },
    {
      available: true,
      async issue(value) {
        options.onCredential?.(value);
        return "signed-control-jwt";
      },
    },
  );
  control.bindCurrent(current);
  return control;
}

describe("ScriptoriumControlHttpClient", () => {
  it("retries an in-flight unknown persistence census and accepts only the bound verified result", async () => {
    let fetches = 0;
    let credentials = 0;
    const control = client({
      unknownPersistenceRetries: 2,
      onCredential: () => {
        credentials += 1;
      },
      fetch: async () => {
        fetches += 1;
        return Response.json(
          fetches < 3 ? unknownPersistenceStatus() : verifiedPersistenceStatus(),
        );
      },
    });

    await expect(control.status(assignment())).resolves.toMatchObject({
      instanceId,
      repositoryId: 123456,
      runtimeEpoch: 9,
      lastConfirmedRemoteRevision: "a".repeat(40),
      persistence: {
        state: "verified",
        observedRemoteCommit: "a".repeat(40),
        formats: [{ formatId: "scriptorium.core", version: 1 }],
      },
    });
    expect(fetches).toBe(3);
    expect(credentials).toBe(3);
  });

  it("returns unknown after the bounded retry window without inventing confirmation", async () => {
    let fetches = 0;
    const control = client({
      unknownPersistenceRetries: 2,
      fetch: async () => {
        fetches += 1;
        return Response.json(unknownPersistenceStatus());
      },
    });

    await expect(control.status(assignment())).resolves.toMatchObject({
      lastConfirmedRemoteRevision: null,
      persistence: {
        state: "unknown",
        observedRemoteCommit: null,
      },
    });
    expect(fetches).toBe(3);
  });

  it("waits for newly projected identity under an active lease before accepting remote evidence", async () => {
    let fetches = 0;
    let leaseChecks = 0;
    const control = client({
      now: () => Date.parse("2026-10-17T10:01:00.000Z"),
      unknownPersistenceDelayedRetries: 3,
      unknownPersistenceRetryDelayMs: 1,
      beforeStatusRetry: async () => {
        leaseChecks += 1;
      },
      fetch: async () => {
        fetches += 1;
        return Response.json(
          fetches < 4 ? unknownPersistenceStatus() : verifiedPersistenceStatus(),
        );
      },
    });

    await expect(control.status(assignment())).resolves.toMatchObject({
      persistence: { state: "verified", observedRemoteCommit: "a".repeat(40) },
      lastConfirmedRemoteRevision: "a".repeat(40),
    });
    expect(fetches).toBe(4);
    expect(leaseChecks).toBe(6);
  });

  it("retries adjacent census reads after each delayed status read", async () => {
    vi.useFakeTimers();
    try {
      let fetches = 0;
      const control = client({
        now: () => Date.parse("2026-10-17T10:01:00.000Z"),
        unknownPersistenceRetries: 2,
        unknownPersistenceDelayedRetries: 1,
        unknownPersistenceRetryDelayMs: 5_000,
        fetch: async () => {
          fetches += 1;
          // The first three reads miss the in-flight scan. A scan finishes
          // during the delayed gap, so the first immediate read still races
          // the next census and the adjacent second read observes its result.
          return Response.json(
            fetches === 5 ? verifiedPersistenceStatus() : unknownPersistenceStatus(),
          );
        },
      });

      const status = control.status(assignment());
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(status).resolves.toMatchObject({
        persistence: { state: "verified", observedRemoteCommit: "a".repeat(40) },
        lastConfirmedRemoteRevision: "a".repeat(40),
      });
      expect(fetches).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts fresh status for a legacy physical identity without delayed retries", async () => {
    const current = assignment();
    const legacyAssignment: RuntimeAssignment = {
      ...current,
      deployment: { ...current.deployment, legacyRuntimeEpoch: 1 },
    };
    const now = Date.parse("2026-10-17T10:01:00.000Z");
    const verifiedStatus = verifiedPersistenceStatus() as Record<string, unknown>;
    const persistence = verifiedStatus.persistence as Record<string, unknown>;
    const rawStatus = {
      ...verifiedStatus,
      instanceId: assignmentInstanceId(legacyAssignment),
      persistence: { ...persistence, remoteObservedAt: "2026-10-17T10:00:59.500Z" },
    };
    expect(
      hasFreshRemoteObservation(
        legacyAssignment,
        {
          ...(rawStatus as unknown as ProducerStatus),
          instanceId,
        },
        now,
      ),
    ).toBe(true);
    let fetches = 0;
    const control = client({
      now: () => now,
      unknownPersistenceDelayedRetries: 15,
      unknownPersistenceRetryDelayMs: 1,
      fetch: async () => {
        fetches += 1;
        return Response.json(rawStatus);
      },
    });
    control.bindCurrent(legacyAssignment);

    await expect(control.status(legacyAssignment)).resolves.toMatchObject({
      instanceId,
      persistence: { state: "verified", observedRemoteCommit: "a".repeat(40) },
    });
    expect(fetches).toBe(1);
  });

  it("retries a nonfresh unknown observation even when it retains an older confirmed revision", async () => {
    let fetches = 0;
    const control = client({
      now: () => Date.parse("2026-10-17T10:01:00.000Z"),
      unknownPersistenceDelayedRetries: 1,
      unknownPersistenceRetryDelayMs: 1,
      fetch: async () => {
        fetches += 1;
        if (fetches === 1) {
          return Response.json({
            ...(unknownPersistenceStatus() as object),
            lastConfirmedRemoteRevision: "a".repeat(40),
          });
        }
        return Response.json(verifiedPersistenceStatus());
      },
    });

    await expect(control.status(assignment())).resolves.toMatchObject({
      persistence: { state: "verified", observedRemoteCommit: "a".repeat(40) },
    });
    expect(fetches).toBe(2);
  });

  it("stops delayed projection retries when the operation lease check fails", async () => {
    let fetches = 0;
    const control = client({
      unknownPersistenceRetries: 0,
      unknownPersistenceDelayedRetries: 3,
      unknownPersistenceRetryDelayMs: 1,
      beforeStatusRetry: async () => {
        throw new Error("operation lease lost");
      },
      fetch: async () => {
        fetches += 1;
        return Response.json(unknownPersistenceStatus());
      },
    });

    await expect(control.status(assignment())).rejects.toThrow("operation lease lost");
    expect(fetches).toBe(1);
  });

  it("rejects a mismatched assignment response instead of retrying it", async () => {
    let fetches = 0;
    const control = client({
      unknownPersistenceRetries: 2,
      fetch: async () => {
        fetches += 1;
        return Response.json({ ...(unknownPersistenceStatus() as object), runtimeEpoch: 8 });
      },
    });

    await expect(control.status(assignment())).rejects.toThrow(
      "producer status is bound to another runtime assignment",
    );
    expect(fetches).toBe(1);
  });

  it("limits idle observation credentials to a generation-fenced status-only call", async () => {
    const issueObservationCredential = vi.fn(async () => ({
      token: "signed-observation-token",
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      operationId: "op_observation",
    }));
    const operations = { issueObservationCredential } as unknown as ProvisionerOperationService;
    const credentials = new IdleObservationRuntimeControlCredentialProvider(
      operations,
      "worker-idle",
    );
    const current = assignment();
    const request: RuntimeControlCredentialRequest = {
      assignment: current,
      policy: current.deployment.controlServicePolicy,
      endpoint: "status",
      payloadDigest: "sha256:" + createHash("sha256").update("").digest("hex"),
    };

    await expect(credentials.issue(request)).resolves.toBe("signed-observation-token");
    await expect(credentials.issue({ ...request, endpoint: "quiesce" })).rejects.toThrow(
      "restricted to empty-body status reads",
    );

    expect(issueObservationCredential).toHaveBeenCalledTimes(1);
    expect(issueObservationCredential).toHaveBeenCalledWith({
      workerId: "worker-idle",
      clusterId: current.clusterId,
      instanceId,
      repositoryId: 123456,
      expectedGeneration: 4,
      runtimeEpoch: 9,
    });
  });

  it("preserves the producer remote observation time and rejects invalid persistence timestamps", async () => {
    const persistence = {
      state: "verified",
      remoteObservedAt: "2026-10-17T10:00:59.000Z",
      observedRemoteCommit: "a".repeat(40),
      formats: [],
    };
    const control = client({
      fetch: async () => Response.json({ ...(responseStatus() as object), persistence }),
    });
    await expect(control.status(assignment())).resolves.toMatchObject({ persistence });
    persistence.remoteObservedAt = "invalid";
    await expect(control.status(assignment())).rejects.toThrow(
      "runtime persistence observation is invalid",
    );
  });

  it("uses a live provider-resolved endpoint and hashes the empty status body", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    let issued: RuntimeControlCredentialRequest | undefined;
    const control = client({
      onCredential: (value) => {
        issued = value;
      },
      fetch: async (input, init) => {
        requestUrl = String(input);
        requestInit = init;
        return Response.json(responseStatus());
      },
    });

    const status = await control.status(assignment());

    expect(requestUrl).toContain(".svc.cluster.local:3000/api/platform/v1/status");
    expect(new Headers(requestInit?.headers).get("authorization")).toBe(
      "Bearer signed-control-jwt",
    );
    expect(issued).toMatchObject({
      endpoint: "status",
      payloadDigest: `sha256:${createHash("sha256").update("").digest("hex")}`,
    });
    expect(status).toMatchObject({
      instanceId,
      repositoryId: 123456,
      runtimeEpoch: 9,
      ready: true,
    });
  });

  it("rejects a safe quiesce receipt received after its deadline", async () => {
    const deadline = Date.parse("2026-10-17T10:05:00.000Z");
    let now = deadline - 1;
    let body: Record<string, unknown> | null = null;
    let issued: RuntimeControlCredentialRequest | undefined;
    const control = client({
      now: () => now,
      onCredential: (value) => {
        issued = value;
      },
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        now = deadline + 1;
        return Response.json(quiesceResponse(body, "2026-10-17T10:04:59.000Z"));
      },
    });
    const request = {
      contractVersion: "scriptorium-platform/v1" as const,
      operationId: "op_01",
      instanceId,
      runtimeEpoch: 9,
      reason: "redeploy" as const,
      deadline: new Date(deadline).toISOString(),
    };

    await expect(control.quiesce(request, async () => undefined)).rejects.toThrow(
      "late quiesce response",
    );
    expect(body).toEqual(request);
    expect(issued?.payloadDigest).toBe(
      `sha256:${createHash("sha256").update(JSON.stringify(request)).digest("hex")}`,
    );
  });

  it("requires a 204 acknowledgement for matching resume", async () => {
    const control = client({ fetch: async () => new Response(null, { status: 200 }) });
    const request = {
      contractVersion: "scriptorium-platform/v1" as const,
      operationId: "op_01",
      instanceId,
      runtimeEpoch: 9,
      reason: "stop" as const,
      deadline: "2026-10-17T10:05:00.000Z",
    };

    await expect(control.resume(request, async () => undefined)).rejects.toThrow(
      "runtime_resume_not_acknowledged",
    );
  });

  it("retains the producer's safe resume conflict code for fenced recovery", async () => {
    const control = client({
      fetch: async () =>
        Response.json({ error: { code: "RESUME_BINDING_MISMATCH" } }, { status: 409 }),
    });
    const request = {
      contractVersion: "scriptorium-platform/v1" as const,
      operationId: "op_01",
      instanceId,
      runtimeEpoch: 9,
      reason: "stop" as const,
      deadline: "2026-10-17T10:05:00.000Z",
    };

    await expect(control.resume(request, async () => undefined)).rejects.toMatchObject({
      name: "ScriptoriumControlHttpError",
      code: "RESUME_BINDING_MISMATCH",
      status: 409,
    });
  });
});
