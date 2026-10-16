import { describe, expect, it, vi } from "vitest";
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
