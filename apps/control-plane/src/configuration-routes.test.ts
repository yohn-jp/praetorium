import { describe, expect, it, vi } from "vitest";
import type { BuildInput } from "@praetorium/contracts";
import {
  ConfigurationIdempotencyConflictError,
  type ConfigurationBinding,
  type ConfigurationContext,
  type ConfigurationInstance,
  type ConfigurationOperation,
  type ConfigurationPlanReceipt,
  type ConfigurationService,
} from "@praetorium/application/configurations";
import { createConfigurationRoutes } from "./configuration-routes.js";

const KEY = `sha256:${"a".repeat(64)}`;
const SELECTION = {
  releaseId: "release-1",
  requestedModules: ["web"],
  resourceProfileId: "small",
  policy: "stable",
} as const;
const BUILD_INPUT: BuildInput = {
  contractVersion: "scriptorium-build/v1",
  producerRevision: "b".repeat(40),
  runtimeBaseDigest: KEY,
  buildKitDigest: KEY,
  recipeDigest: KEY,
  sourceDigest: KEY,
  lockDigest: KEY,
  requestedModules: ["web"],
  resolvedModules: [{ id: "web", version: "1.2.3", artifactDigest: KEY }],
  platform: "linux/amd64",
  options: {},
};
const RESOURCES = { cpuMilli: 500, memoryMiB: 512, ephemeralStorageMiB: 1024 };
const RUNTIME_METADATA = {
  contractVersion: "scriptorium-platform/v1",
  producerRevision: "b".repeat(40),
  listener: { port: 8080 },
  paths: {
    liveness: "/health/live",
    readiness: "/health/ready",
    metadata: "/api/platform/v1/metadata",
    shutdown: "/api/platform/v1/shutdown",
    status: "/api/platform/v1/status",
    quiesce: "/api/platform/v1/quiesce",
    resume: "/api/platform/v1/resume",
  },
  shutdownTimeoutSeconds: 30,
} as const;

const INSTANCE: ConfigurationInstance = {
  instanceId: "instance-1",
  repositoryId: 42,
  generation: 0,
  runtimeEpoch: 0,
  desiredState: "running",
  policy: "stable",
  observedGeneration: null,
  observedRuntimeEpoch: null,
  observedSequence: 0,
  observedState: "absent",
  desiredRevisionId: null,
  observedRevisionId: null,
  desiredArtifactDigest: null,
  currentArtifactDigest: null,
  reservationState: "none",
  reservationId: null,
  createdAt: 1,
  updatedAt: 1,
};
const BINDING: ConfigurationBinding = {
  repositoryId: 42,
  instanceId: "instance-1",
  bindingEpoch: 2,
  authorizationRevision: 3,
  suspended: false,
};
const CONTEXT: ConfigurationContext = { binding: BINDING, instance: INSTANCE };
const REVISION = {
  revisionId: "revision-1",
  instanceId: INSTANCE.instanceId,
  repositoryId: INSTANCE.repositoryId,
  generation: 1,
  buildKey: KEY,
  buildId: "build-1",
  resolvedModules: BUILD_INPUT.resolvedModules,
  selection: SELECTION,
  resources: RESOURCES,
  runtimeMetadata: RUNTIME_METADATA,
  artifactDigest: null,
  status: "building",
  actorId: "octocat",
  createdAt: 42,
} as const;
const PLANNED_INSTANCE: ConfigurationInstance = {
  ...INSTANCE,
  generation: 1,
  desiredRevisionId: REVISION.revisionId,
  updatedAt: 42,
};
const OPERATION: ConfigurationOperation = {
  id: "operation-1",
  instanceId: INSTANCE.instanceId,
  generation: 1,
  runtimeEpoch: 0,
  kind: "update",
  status: "pending",
  attempt: 0,
  leaseEpoch: 0,
  reportSequence: 0,
  leaseExpiresAt: null,
  repositoryId: INSTANCE.repositoryId,
  clusterId: null,
  reservationId: null,
  deploymentRevisionId: REVISION.revisionId,
  buildId: "build-1",
  prerequisiteBuildId: null,
  idempotencyKey: "config-apply-1",
  phase: "waiting_build",
  workerId: null,
  leaseToken: null,
  requestHash: KEY,
  checkpointSequence: 0,
  checkpoint: null,
  result: null,
  createdAt: 42,
  updatedAt: 42,
};
const RECEIPT: ConfigurationPlanReceipt = {
  instance: PLANNED_INSTANCE,
  revision: REVISION,
  operation: OPERATION,
  buildId: "build-1",
  buildKey: KEY,
  replayed: false,
};

function configuration() {
  return {
    getByInstance: vi.fn(async () => CONTEXT),
    getCurrentRevision: vi.fn(async () => REVISION),
    preview: vi.fn(async () => ({
      buildInput: BUILD_INPUT,
      resources: RESOURCES,
      runtimeMetadata: RUNTIME_METADATA,
      buildKey: KEY,
      requestedModules: ["web"],
      resolvedModules: BUILD_INPUT.resolvedModules,
    })),
    plan: vi.fn(async () => RECEIPT),
  } satisfies Pick<
    ConfigurationService,
    "getByInstance" | "getCurrentRevision" | "preview" | "plan"
  >;
}

function jsonRequest(path: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://control-plane.internal${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("Control Plane configuration routes", () => {
  it("returns the current snapshot and a producer-bound preview", async () => {
    const service = configuration();
    const routes = createConfigurationRoutes({ configuration: service });

    const snapshot = await routes.request("/v1/instances/instance-1/configuration");
    expect(snapshot.status).toBe(200);
    expect(snapshot.headers.get("cache-control")).toBe("no-store");
    expect(await snapshot.json()).toEqual({
      binding: BINDING,
      instance: INSTANCE,
      revision: REVISION,
    });

    const body = {
      bindingEpoch: BINDING.bindingEpoch,
      authorizationRevision: BINDING.authorizationRevision,
      expectedGeneration: INSTANCE.generation,
      selection: SELECTION,
    };
    const preview = await routes.fetch(
      jsonRequest("/v1/instances/instance-1/configuration/preview", body),
    );
    expect(preview.status).toBe(200);
    expect(await preview.json()).toEqual({
      buildInput: BUILD_INPUT,
      resources: RESOURCES,
      runtimeMetadata: RUNTIME_METADATA,
      buildKey: KEY,
      requestedModules: ["web"],
      resolvedModules: BUILD_INPUT.resolvedModules,
    });
    expect(service.preview).toHaveBeenCalledWith({
      repositoryId: BINDING.repositoryId,
      instanceId: INSTANCE.instanceId,
      ...body,
    });
  });

  it("plans a desired revision with the Gateway actor and idempotency headers", async () => {
    const service = configuration();
    const routes = createConfigurationRoutes({
      configuration: service,
      now: () => 100,
      requestId: () => "generated-request",
    });
    const body = {
      actorId: "octocat",
      bindingEpoch: BINDING.bindingEpoch,
      authorizationRevision: BINDING.authorizationRevision,
      expectedGeneration: INSTANCE.generation,
      selection: SELECTION,
    };
    const response = await routes.fetch(
      jsonRequest("/v1/instances/instance-1/configuration", body, {
        "Idempotency-Key": "config-apply-1",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      instance: PLANNED_INSTANCE,
      revision: REVISION,
      operation: {
        id: OPERATION.id,
        instanceId: OPERATION.instanceId,
        generation: OPERATION.generation,
        runtimeEpoch: OPERATION.runtimeEpoch,
        kind: OPERATION.kind,
        status: OPERATION.status,
        phase: OPERATION.phase,
        attempt: OPERATION.attempt,
        createdAt: OPERATION.createdAt,
        updatedAt: OPERATION.updatedAt,
      },
      buildId: "build-1",
      buildKey: KEY,
      replayed: false,
    });
    expect(service.plan).toHaveBeenCalledWith({
      repositoryId: BINDING.repositoryId,
      instanceId: INSTANCE.instanceId,
      ...body,
      idempotencyKey: "config-apply-1",
      requestId: "generated-request",
      now: 100,
    });
  });

  it("schedules build and pending operation hints only after a successful plan", async () => {
    const service = configuration();
    const notifications: string[] = [];
    const notifyWorkAvailable = vi.fn(async (kind: "build" | "operation") => {
      notifications.push(kind);
    });
    const routes = createConfigurationRoutes({ configuration: service, notifyWorkAvailable });
    const pending: Promise<unknown>[] = [];
    const context = {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
      passThroughOnException() {},
      props: {},
    };
    const response = await routes.fetch(
      jsonRequest(
        "/v1/instances/instance-1/configuration",
        {
          actorId: "octocat",
          bindingEpoch: BINDING.bindingEpoch,
          authorizationRevision: BINDING.authorizationRevision,
          expectedGeneration: INSTANCE.generation,
          selection: SELECTION,
        },
        { "Idempotency-Key": "config-apply-1" },
      ),
      {},
      context,
    );

    expect(response.status).toBe(200);
    expect(pending).toHaveLength(2);
    await Promise.all(pending);
    expect(notifications).toEqual(["build", "operation"]);
  });

  it("does not hint on a successful replay with no runnable work", async () => {
    const service = configuration();
    vi.mocked(service.plan).mockResolvedValueOnce({
      ...RECEIPT,
      revision: { ...REVISION, artifactDigest: KEY, status: "admitted" },
      operation: null,
      replayed: true,
    });
    const notifyWorkAvailable = vi.fn(async () => undefined);
    const routes = createConfigurationRoutes({ configuration: service, notifyWorkAvailable });
    const pending: Promise<unknown>[] = [];
    const response = await routes.fetch(
      jsonRequest(
        "/v1/instances/instance-1/configuration",
        {
          actorId: "octocat",
          bindingEpoch: BINDING.bindingEpoch,
          authorizationRevision: BINDING.authorizationRevision,
          expectedGeneration: INSTANCE.generation,
          selection: SELECTION,
        },
        { "Idempotency-Key": "config-apply-1" },
      ),
      {},
      {
        waitUntil(promise: Promise<unknown>) {
          pending.push(promise);
        },
        passThroughOnException() {},
        props: {},
      },
    );

    expect(response.status).toBe(200);
    expect(pending).toHaveLength(0);
    expect(notifyWorkAvailable).not.toHaveBeenCalled();
  });

  it("rejects malformed, oversized, queried, and unsupported requests", async () => {
    const service = configuration();
    const routes = createConfigurationRoutes({ configuration: service });
    const body = {
      actorId: "octocat",
      bindingEpoch: BINDING.bindingEpoch,
      authorizationRevision: BINDING.authorizationRevision,
      expectedGeneration: INSTANCE.generation,
      selection: SELECTION,
    };

    const missingKey = await routes.fetch(
      jsonRequest("/v1/instances/instance-1/configuration", body),
    );
    expect(missingKey.status).toBe(400);

    const extra = await routes.fetch(
      jsonRequest(
        "/v1/instances/instance-1/configuration",
        { ...body, unexpected: true },
        { "Idempotency-Key": "config-apply-1" },
      ),
    );
    expect(extra.status).toBe(400);
    expect(service.plan).not.toHaveBeenCalled();

    const query = await routes.fetch(jsonRequest("/v1/instances/instance-1/configuration?debug=1"));
    expect(query.status).toBe(400);

    const oversized = await routes.fetch(
      new Request("https://control-plane.internal/v1/instances/instance-1/configuration/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: `{"padding":"${"x".repeat(65_537)}"}`,
      }),
    );
    expect(oversized.status).toBe(413);

    const method = await routes.request("/v1/instances/instance-1/configuration/preview", {
      method: "GET",
    });
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("POST");
  });

  it("maps configuration idempotency conflicts to a bounded conflict response", async () => {
    const service = configuration();
    vi.mocked(service.plan).mockRejectedValueOnce(new ConfigurationIdempotencyConflictError());
    const routes = createConfigurationRoutes({ configuration: service });
    const response = await routes.fetch(
      jsonRequest(
        "/v1/instances/instance-1/configuration",
        {
          actorId: "octocat",
          bindingEpoch: BINDING.bindingEpoch,
          authorizationRevision: BINDING.authorizationRevision,
          expectedGeneration: INSTANCE.generation,
          selection: SELECTION,
        },
        { "Idempotency-Key": "config-apply-1" },
      ),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: { code: "CONFIGURATION_IDEMPOTENCY_CONFLICT" },
    });
  });
});
