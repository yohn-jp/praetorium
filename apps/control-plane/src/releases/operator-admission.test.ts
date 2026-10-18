import { describe, expect, it, vi } from "vitest";
import { ReleaseCandidateSchema } from "@praetorium/application/releases";
import type { ReleaseRetryStatus } from "./retry-contract.js";
import { createControlPlaneApp, type ControlPlaneDependencies } from "../app.js";
import type { OperatorReleaseAdmissionDependencies } from "./operator-admission.js";
import { createOperatorReleaseAdmissionRoutes } from "./operator-admission.js";

const digest = `sha256:${"a".repeat(64)}`;
const producerRevision = "a".repeat(40);

function manifest() {
  return {
    schemaVersion: 1,
    version: "1.2.3",
    imageRepository: "ghcr.io/example/runtime",
    catalog: {
      contractVersion: "scriptorium-build/v1",
      producerRevision,
      runtimeBaseDigest: digest,
      buildKitDigest: digest,
      recipeDigest: digest,
      lockDigest: digest,
      sourceDigest: digest,
      supportedPlatforms: ["linux/amd64"],
      modules: [],
      baseResources: { cpuMilli: 0, memoryMiB: 0, ephemeralStorageMiB: 0 },
      sharedResourceGroups: [],
      resourceProfiles: [],
    },
    runtimeMetadata: {
      contractVersion: "scriptorium-platform/v1",
      producerRevision,
      listener: { port: 3000 },
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
    },
    signatureRef: "https://evidence.example/signature",
    provenanceRef: "https://evidence.example/provenance",
  } as const;
}

function deps(
  overrides: Partial<OperatorReleaseAdmissionDependencies> = {},
): OperatorReleaseAdmissionDependencies {
  const releases: OperatorReleaseAdmissionDependencies["releases"] = {
    async findById() {
      return null;
    },
    async findByDigest() {
      return null;
    },
    async listCandidates() {
      return { items: [], nextCursor: null };
    },
    async createCandidate() {
      return "created";
    },
    async createCandidateWithAudit() {
      return "created";
    },
    async appendAudit() {},
  };
  return {
    releases,
    registry: {
      async verifyImage(repository, manifestDigest, platform) {
        return { repository, manifestDigest, platform };
      },
    },
    provenance: {
      async verify() {
        return { verified: true, evidence: ["test provenance"] };
      },
    },
    producerMetadata: {
      verify: vi.fn(async () => ({
        kind: "verified" as const,
        evidence: ["test producer metadata"],
      })),
    },
    clock: {
      now: () => "2026-01-01T00:00:00.000Z",
      nowMs: () => Date.parse("2026-01-01T00:00:00.000Z"),
    },
    ids: { newReleaseId: () => "release-test" },
    authorize: async () => ({ actorId: "operator-test" }),
    requestId: () => "request-test",
    ...overrides,
  };
}

describe("operator release admission route", () => {
  it("requires the separately configured operator authority before reading a candidate", async () => {
    const routeDeps = deps({
      authorize: async () => null,
    });
    const app = createOperatorReleaseAdmissionRoutes(routeDeps);
    const response = await app.request("/", {
      method: "POST",
      body: JSON.stringify(manifest()),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code: "OPERATOR_AUTH_REQUIRED" } });
    expect(routeDeps.producerMetadata.verify).not.toHaveBeenCalled();
  });

  it("passes the complete immutable catalog and runtime metadata to admission", async () => {
    const routeDeps = deps();
    const app = createOperatorReleaseAdmissionRoutes(routeDeps);
    const input = manifest();
    const response = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Request-Id": "request-1" },
      body: JSON.stringify(input),
    });

    expect(response.status).toBe(201);
    expect(routeDeps.producerMetadata.verify).toHaveBeenCalledWith({
      imageRepository: input.imageRepository,
      imageDigest: digest,
      producerRevision,
      catalog: input.catalog,
      runtimeMetadata: input.runtimeMetadata,
      signatureRef: input.signatureRef,
      provenanceRef: input.provenanceRef,
    });
    expect(await response.json()).toEqual({
      release: {
        id: "release-test",
        version: "1.2.3",
        imageDigest: digest,
        status: "candidate",
      },
      duplicate: false,
    });
  });

  it("schedules release progression after durable admission without delaying the response", async () => {
    const work = Promise.resolve();
    const waitUntil = vi.fn();
    const afterAdmitted: NonNullable<OperatorReleaseAdmissionDependencies["afterAdmitted"]> =
      (_candidate, context) => context.waitUntil(work);
    const afterAdmittedSpy = vi.fn(afterAdmitted);
    const app = createOperatorReleaseAdmissionRoutes(deps({ afterAdmitted: afterAdmittedSpy }));
    const response = await app.fetch(
      new Request("https://control.example/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(manifest()),
      }),
      {},
      { waitUntil, passThroughOnException() {}, props: {} },
    );

    expect(response.status).toBe(201);
    expect(afterAdmittedSpy).toHaveBeenCalledOnce();
    expect(waitUntil).toHaveBeenCalledWith(work);
  });

  it("keeps verification outages retryable", async () => {
    const routeDeps = deps({
      producerMetadata: {
        verify: async () => ({ kind: "retry", reason: "evidence unavailable" }),
      },
    });
    const app = createOperatorReleaseAdmissionRoutes(routeDeps);
    const response = await app.request("/", {
      method: "POST",
      body: JSON.stringify(manifest()),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: "RELEASE_EVIDENCE_UNAVAILABLE", retryable: true },
    });
  });
});


function retryFixture() {
  const candidate = ReleaseCandidateSchema.parse({
    ...manifest(), id: "release-test", imageDigest: digest, status: "candidate",
    admission: { registryConfirmed: true, provenanceVerified: true,
      runtimeMetadataVerified: true, evidence: ["verified"], verifiedAt: "2026-01-01T00:00:00.000Z" },
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const status: ReleaseRetryStatus = {
    release: { id: candidate.id, version: candidate.version, imageDigest: digest, status: "candidate" },
    workflow: { state: "blocked", revision: 3, failureCode: "canary_build_failed", attempts: 1,
      nextAttemptAt: null, canaryBuildKey: digest, canaryOperationId: null },
    build: { id: "build-test", status: "failed", attemptCount: 1,
      progress: { stage: "preparing", percent: 0 }, failure: { code: "BUILD_FAILED", retryable: false } },
  };
  const retry = {
    replay: vi.fn<NonNullable<OperatorReleaseAdmissionDependencies["retry"]>["replay"]>(async () => null),
    status: vi.fn(async (): Promise<ReleaseRetryStatus | null> => status),
    execute: vi.fn<NonNullable<OperatorReleaseAdmissionDependencies["retry"]>["execute"]>(
      async () => ({ kind: "accepted", duplicate: false, status }),
    ),
  };
  const routeDeps = deps({ retry });
  routeDeps.releases.findById = vi.fn(async () => candidate);
  return { routeDeps, retry, status };
}

const retryBody = { expectedRevision: 3, idempotencyKey: "retry-ca-bundle" };
function retryRequest(body: unknown = retryBody) {
  return { method: "POST", headers: { "Content-Type": "application/json", "X-Request-Id": "retry-request" },
    body: JSON.stringify(body) };
}

describe("operator pre-runtime Canary recovery", () => {
  it.each(["GET", "POST"])("requires operator authority before %s reads or mutations", async (method) => {
    const { routeDeps, retry } = retryFixture();
    const app = createOperatorReleaseAdmissionRoutes({ ...routeDeps, authorize: async () => null });
    const response = await app.request(method === "GET" ? "/release-test" : "/release-test/retry",
      method === "GET" ? {} : retryRequest());
    expect(response.status).toBe(403);
    expect(retry.status).not.toHaveBeenCalled();
    expect(retry.execute).not.toHaveBeenCalled();
    expect(routeDeps.releases.findById).not.toHaveBeenCalled();
    expect(routeDeps.producerMetadata.verify).not.toHaveBeenCalled();
  });

  it("returns bounded status without caching and distinguishes missing releases", async () => {
    const { routeDeps, retry, status } = retryFixture();
    const app = createOperatorReleaseAdmissionRoutes(routeDeps);
    const response = await app.request("/release-test");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual(status);
    retry.status.mockResolvedValueOnce(null);
    expect((await app.request("/missing")).status).toBe(404);
  });

  it.each([
    { expectedRevision: -1, idempotencyKey: "retry" },
    { expectedRevision: 3, idempotencyKey: "retry", actorId: "forged" },
    { expectedRevision: 3, idempotencyKey: "" },
    { expectedRevision: 1.5, idempotencyKey: "retry" },
  ])("rejects invalid retry commands before verification or mutation", async (body) => {
    const { routeDeps, retry } = retryFixture();
    const response = await createOperatorReleaseAdmissionRoutes(routeDeps)
      .request("/release-test/retry", retryRequest(body));
    expect(response.status).toBe(400);
    expect(retry.execute).not.toHaveBeenCalled();
    expect(routeDeps.producerMetadata.verify).not.toHaveBeenCalled();
  });

  it("bounds retry bodies", async () => {
    const { routeDeps, retry } = retryFixture();
    const response = await createOperatorReleaseAdmissionRoutes(routeDeps)
      .request("/release-test/retry", retryRequest({ ...retryBody, padding: "x".repeat(1024) }));
    expect(response.status).toBe(413);
    expect(retry.execute).not.toHaveBeenCalled();
  });

  it("revalidates immutable evidence and binds the durable command to the authenticated actor", async () => {
    const { routeDeps, retry, status } = retryFixture();
    const afterAdmitted = vi.fn<NonNullable<OperatorReleaseAdmissionDependencies["afterAdmitted"]>>(
      (_candidate, context) => context.waitUntil(Promise.resolve()),
    );
    const waitUntil = vi.fn();
    const app = createOperatorReleaseAdmissionRoutes({ ...routeDeps, afterAdmitted });
    const response = await app.fetch(new Request("https://control.example/release-test/retry", retryRequest()),
      {}, { waitUntil, passThroughOnException() {}, props: {} });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ...status, duplicate: false });
    expect(routeDeps.producerMetadata.verify).toHaveBeenCalledOnce();
    expect(retry.execute).toHaveBeenCalledWith({ ...retryBody, releaseId: "release-test",
      actorId: "operator-test", requestId: "retry-request", now: Date.parse("2026-01-01T00:00:00.000Z"),
      requestHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u) });
    expect(afterAdmitted).toHaveBeenCalledOnce();
    expect(waitUntil).toHaveBeenCalledOnce();
  });

  it.each(["rejected", "retry"] as const)("does not mutate when evidence is %s", async (kind) => {
    const { routeDeps, retry } = retryFixture();
    const app = createOperatorReleaseAdmissionRoutes({ ...routeDeps,
      producerMetadata: { verify: async () => ({ kind, reason: "unavailable or invalid" }) } });
    const response = await app.request("/release-test/retry", retryRequest());
    expect(response.status).toBe(kind === "retry" ? 503 : 422);
    expect(retry.execute).not.toHaveBeenCalled();
  });

  it("distinguishes exact replay from stale revision conflicts", async () => {
    const { routeDeps, retry, status } = retryFixture();
    retry.execute.mockResolvedValueOnce({ kind: "accepted", duplicate: true, status });
    retry.execute.mockResolvedValueOnce({ kind: "conflict", reason: "stale_revision" });
    const app = createOperatorReleaseAdmissionRoutes(routeDeps);
    expect((await app.request("/release-test/retry", retryRequest())).status).toBe(200);
    const conflict = await app.request("/release-test/retry", retryRequest());
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: { code: "RELEASE_RETRY_CONFLICT", reason: "stale_revision" } });
  });
});


it("mounts status and retry under operator authority without accepting the Gateway credential", async () => {
  const { routeDeps, retry } = retryFixture();
  const operatorToken = "o".repeat(40);
  const gatewaySecret = "g".repeat(40);
  const operatorAdmission = createOperatorReleaseAdmissionRoutes({ ...routeDeps,
    authorize: async (headers) => headers.get("Authorization") === `Bearer ${operatorToken}`
      ? { actorId: "operator-test" } : null });
  const app = createControlPlaneApp({
    registry: {} as ControlPlaneDependencies["registry"],
    instances: {} as ControlPlaneDependencies["instances"],
    gatewaySecret, operatorToken, operatorAdmission,
  });
  for (const path of ["/v1/operator/releases/release-test", "/v1/operator/releases/release-test/retry"]) {
    const init = path.endsWith("/retry") ? retryRequest() : {};
    const denied = await app.request(path, { ...init, headers: { "X-Control-Plane-Gateway-Auth": gatewaySecret } });
    expect(denied.status).toBe(403);
    const accepted = await app.request(path, { ...init, headers: { Authorization: `Bearer ${operatorToken}` } });
    expect(accepted.status).toBe(path.endsWith("/retry") ? 202 : 200);
  }
  expect(retry.status).toHaveBeenCalledOnce();
  expect(retry.execute).toHaveBeenCalledOnce();
});


it("returns durable exact replay during an external evidence outage without verification or mutation", async () => {
  const { routeDeps, retry, status } = retryFixture();
  retry.replay.mockResolvedValueOnce({ kind: "accepted", duplicate: true, status });
  const app = createOperatorReleaseAdmissionRoutes({ ...routeDeps,
    producerMetadata: { verify: vi.fn(async () => ({ kind: "retry" as const, reason: "outage" })) } });
  const response = await app.request("/release-test/retry", retryRequest());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ...status, duplicate: true });
  expect(retry.execute).not.toHaveBeenCalled();
  expect(routeDeps.releases.findById).not.toHaveBeenCalled();
});


it("reports a bounded retry failure stage without exposing provider errors", async () => {
  const { routeDeps, retry } = retryFixture();
  retry.execute.mockRejectedValueOnce(new Error("private provider payload"));
  const response = await createOperatorReleaseAdmissionRoutes(routeDeps)
    .request("/release-test/retry", retryRequest());
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: { code: "RELEASE_RETRY_UNAVAILABLE", stage: "commit" } });
});
