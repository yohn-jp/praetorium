import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { RuntimeAssignment } from "@praetorium/application/lifecycle";
import {
  ScriptoriumControlHttpClient,
  type RuntimeControlCredentialRequest,
} from "./scriptorium-control-client.js";

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
});
