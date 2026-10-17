import { describe, expect, it } from "vitest";
import { compareReleaseVersions } from "./semver.js";
import { discoverStableCandidates } from "./discovery.js";
import { ingestReleaseCandidate } from "./ingest.js";
import {
  advanceStablePromotions,
  STABLE_CANARY_HEALTH_WINDOW_MS,
  type ReleasePromotionDeps,
} from "./promotion.js";
import {
  ReleaseCandidateSchema,
  ReleaseCandidateManifestSchema,
  type CandidateWorkLease,
  type CandidateWorkflow,
  type CursorPage,
  type DiscoveryCheckpoint,
  type ReleaseAdmissionRepository,
  type ReleaseCandidate,
  type ReleasePromotionRepository,
  type StableReleaseChannel,
} from "./model.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const OTHER_DIGEST = `sha256:${"b".repeat(64)}`;
const PRODUCER_REVISION = "a".repeat(40);
const TIME = "2026-01-01T00:00:00.000Z";

function manifest(version = "1.0.0", digest = DIGEST) {
  return ReleaseCandidateManifestSchema.parse({
    schemaVersion: 1,
    version,
    imageRepository: "example/runtime",
    catalog: {
      contractVersion: "scriptorium-build/v1",
      producerRevision: PRODUCER_REVISION,
      runtimeBaseDigest: digest,
      buildKitDigest: DIGEST,
      recipeDigest: DIGEST,
      lockDigest: DIGEST,
      sourceDigest: DIGEST,
      supportedPlatforms: ["linux/amd64"],
      modules: [],
      baseResources: { cpuMilli: 0, memoryMiB: 0, ephemeralStorageMiB: 0 },
      sharedResourceGroups: [],
      resourceProfiles: [],
    },
    runtimeMetadata: {
      contractVersion: "scriptorium-platform/v1",
      producerRevision: PRODUCER_REVISION,
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
  });
}

function candidate(version = "1.0.0", id = "release-1", digest = DIGEST): ReleaseCandidate {
  const candidateManifest = manifest(version, digest);
  return ReleaseCandidateSchema.parse({
    schemaVersion: 1,
    id,
    version: candidateManifest.version,
    imageRepository: candidateManifest.imageRepository,
    imageDigest: candidateManifest.catalog.runtimeBaseDigest,
    catalog: candidateManifest.catalog,
    runtimeMetadata: candidateManifest.runtimeMetadata,
    signatureRef: candidateManifest.signatureRef,
    provenanceRef: candidateManifest.provenanceRef,
    admission: {
      registryConfirmed: true,
      provenanceVerified: true,
      runtimeMetadataVerified: true,
      evidence: ["immutable test evidence"],
      verifiedAt: TIME,
    },
    status: "candidate",
    createdAt: TIME,
  });
}

class MutableClock {
  value = Date.parse(TIME);

  nowMs(): number {
    return this.value;
  }

  now(): string {
    return new Date(this.value).toISOString();
  }
}

function queuedWorkflow(releaseId: string): CandidateWorkflow {
  return {
    releaseId,
    state: "queued",
    revision: 0,
    attempts: 0,
    nextAttemptAt: null,
    leaseOwner: null,
    leaseEpoch: 0,
    leaseExpiresAt: null,
    canaryArtifactDigest: null,
    canaryBuildKey: null,
    canaryRuntimeId: null,
    canaryOperationId: null,
    healthySince: null,
    lastHealthyAt: null,
    lastHealthEvidence: null,
    cleanupEvidence: null,
    followerCursor: null,
    followerPlanningComplete: false,
    canaryCleanupComplete: false,
    cleanupDisposition: null,
    failureCode: null,
    updatedAt: TIME,
  };
}

class MemoryReleaseStore implements ReleaseAdmissionRepository, ReleasePromotionRepository {
  readonly candidates = new Map<string, ReleaseCandidate>();
  readonly workflows = new Map<string, CandidateWorkflow>();
  readonly audits: Array<{
    outcome: string;
    metadata: Readonly<Record<string, string | number | boolean | null>>;
  }> = [];
  checkpoint: DiscoveryCheckpoint = { cursor: null, revision: 0 };
  channel: StableReleaseChannel = {
    key: "stable",
    currentReleaseId: null,
    revision: 0,
    updatedAt: TIME,
  };
  unsettledRollouts = false;

  async findById(id: string): Promise<ReleaseCandidate | null> {
    return this.candidates.get(id) ?? null;
  }

  async findByDigest(digest: string): Promise<ReleaseCandidate | null> {
    return [...this.candidates.values()].find((item) => item.imageDigest === digest) ?? null;
  }

  async listCandidates(
    cursor: string | null,
    limit: number,
  ): Promise<CursorPage<ReleaseCandidate>> {
    const items = [...this.candidates.values()].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
    const start = cursor === null ? 0 : items.findIndex((item) => item.id === cursor) + 1;
    const slice = items.slice(start, start + limit);
    return {
      items: slice,
      nextCursor: start + slice.length < items.length ? (slice.at(-1)?.id ?? null) : null,
    };
  }

  async createCandidate(candidateValue: ReleaseCandidate): Promise<"created" | "duplicate"> {
    if (await this.findByDigest(candidateValue.imageDigest)) return "duplicate";
    this.candidates.set(candidateValue.id, candidateValue);
    this.workflows.set(candidateValue.id, queuedWorkflow(candidateValue.id));
    return "created";
  }

  async createCandidateWithAudit(
    input: Parameters<ReleaseAdmissionRepository["createCandidateWithAudit"]>[0],
  ): Promise<"created" | "duplicate"> {
    const result = await this.createCandidate(input.candidate);
    if (result === "created")
      this.audits.push({ outcome: input.audit.outcome, metadata: input.audit.metadata });
    return result;
  }

  async appendAudit(
    input: Parameters<ReleaseAdmissionRepository["appendAudit"]>[0],
  ): Promise<void> {
    this.audits.push({ outcome: input.outcome, metadata: input.metadata });
  }

  async getStableChannel(): Promise<StableReleaseChannel> {
    return this.channel;
  }

  async promoteStable(input: {
    releaseId: string;
    expectedRevision: number;
    promotedAt: string;
  }): Promise<"promoted" | "conflict" | "ineligible"> {
    const item = this.candidates.get(input.releaseId);
    if (!item || item.status !== "candidate") return "ineligible";
    if (this.channel.revision !== input.expectedRevision) return "conflict";
    this.channel = {
      key: "stable",
      currentReleaseId: input.releaseId,
      revision: input.expectedRevision + 1,
      updatedAt: input.promotedAt,
    };
    this.candidates.set(input.releaseId, { ...item, status: "available" });
    return "promoted";
  }

  async getDiscoveryCheckpoint(): Promise<DiscoveryCheckpoint> {
    return this.checkpoint;
  }

  async commitDiscoveryPage(input: {
    expectedRevision: number;
    expectedCursor: string | null;
    page: CursorPage<ReleaseCandidate>;
    at: string;
  }): Promise<"advanced" | "conflict"> {
    if (
      this.checkpoint.revision !== input.expectedRevision ||
      this.checkpoint.cursor !== input.expectedCursor
    )
      return "conflict";
    const lastCandidate = input.page.items.at(-1);
    this.checkpoint = {
      cursor: input.page.nextCursor ?? lastCandidate?.id ?? input.expectedCursor,
      revision: input.expectedRevision + 1,
    };
    for (const item of input.page.items) {
      if (!this.workflows.has(item.id)) this.workflows.set(item.id, queuedWorkflow(item.id));
    }
    return "advanced";
  }

  async claimCandidateWork(input: {
    owner: string;
    now: number;
    leaseMs: number;
    limit: number;
  }): Promise<readonly CandidateWorkLease[]> {
    const due = [...this.workflows.values()]
      .filter(
        (workflow) => !["complete", "blocked", "rejected", "superseded"].includes(workflow.state),
      )
      .filter((workflow) => workflow.nextAttemptAt === null || workflow.nextAttemptAt <= input.now)
      .filter(
        (workflow) => workflow.leaseExpiresAt === null || workflow.leaseExpiresAt <= input.now,
      )
      .slice(0, input.limit);
    return due.flatMap((workflow) => {
      const item = this.candidates.get(workflow.releaseId);
      if (!item) return [];
      const leased = {
        ...workflow,
        leaseOwner: input.owner,
        leaseEpoch: workflow.leaseEpoch + 1,
        leaseExpiresAt: input.now + input.leaseMs,
        updatedAt: new Date(input.now).toISOString(),
      };
      this.workflows.set(workflow.releaseId, leased);
      return [{ candidate: item, workflow: leased, owner: input.owner, epoch: leased.leaseEpoch }];
    });
  }

  async saveCandidateWorkflow(
    input: Parameters<ReleasePromotionRepository["saveCandidateWorkflow"]>[0],
  ): Promise<"saved" | "stale"> {
    const current = this.workflows.get(input.lease.workflow.releaseId);
    if (
      !current ||
      current.revision !== input.lease.workflow.revision ||
      current.leaseOwner !== input.lease.owner ||
      current.leaseEpoch !== input.lease.epoch ||
      current.leaseExpiresAt === null ||
      current.leaseExpiresAt <= Date.parse(input.next.updatedAt)
    )
      return "stale";
    this.workflows.set(input.lease.workflow.releaseId, {
      ...input.next,
      revision: current.revision + 1,
      leaseOwner: input.releaseLease ? null : current.leaseOwner,
      leaseEpoch: current.leaseEpoch,
      leaseExpiresAt: input.releaseLease ? null : current.leaseExpiresAt,
    });
    return "saved";
  }

  async hasUnsettledRollouts(): Promise<boolean> {
    return this.unsettledRollouts;
  }
}

function promotionDeps(
  store: MemoryReleaseStore,
  clock: MutableClock,
  overrides: Partial<ReleasePromotionDeps> = {},
): ReleasePromotionDeps {
  const healthyDigest = OTHER_DIGEST;
  return {
    releases: store,
    admission: { verify: async () => ({ kind: "verified", evidence: ["rechecked"] }) },
    canaryComposition: {
      compose: async () => ({
        kind: "ready",
        buildKey: "build-key",
        buildId: "build-1",
        artifactDigest: healthyDigest,
        deploymentRevisionId: "revision-1",
      }),
    },
    canaryRuntime: {
      ensureRunning: async () => ({ runtimeId: "canary-1", operationId: "canary-op-1" }),
      observe: async ({ runtimeId, operationId }) => ({
        kind: "healthy",
        evidence: {
          artifactDigest: healthyDigest,
          runtimeId,
          operationId,
          runtimeEpoch: 3,
          providerObservationId: `observation-${clock.nowMs()}`,
          source: "runtime-provisioner-observation",
          imageIdentityVerified: true,
          observedAt: clock.nowMs(),
          checks: { startup: true, auth: true, uiApiMcp: true, persistence: true },
          checkEvidence: {
            startup: "startup-probe-1",
            auth: "auth-probe-1",
            uiApiMcp: "ui-api-mcp-probe-1",
            persistence: "persistence-probe-1",
          },
        },
      }),
      stop: async ({ runtimeId }) => ({
        kind: "stopped",
        evidence: {
          operationId: "stop-canary-1",
          startedOperationId: "canary-op-1",
          observedAt: clock.nowMs(),
          writerAbsence: {
            instanceId: runtimeId,
            repositoryId: 101,
            retiredEpoch: 3,
            providerObservationId: "census-1",
            censusObservedAt: clock.nowMs(),
            remainingWriters: 0,
            evidenceIdentities: [],
            source: "runtime-provider-census",
          },
        },
      }),
    },
    rolloutPlanner: {
      planNextPage: async () => ({ kind: "planned", nextCursor: null, complete: true, planned: 0 }),
      hasUnsettledRollouts: async () => false,
    },
    clock,
    workerId: "test-worker",
    ...overrides,
  };
}

async function advanceOnce(store: MemoryReleaseStore, deps: ReleasePromotionDeps): Promise<void> {
  await advanceStablePromotions(deps);
}

describe("stable release candidate application", () => {
  it("orders strict SemVer including prereleases and ignores build metadata", () => {
    expect(compareReleaseVersions("1.0.0-alpha.10", "1.0.0-alpha.2")).toBe(1);
    expect(compareReleaseVersions("1.0.0", "1.0.0-rc.9")).toBe(1);
    expect(compareReleaseVersions("2.0.0+build.1", "2.0.0+build.2")).toBe(0);
  });

  it("returns evidence outages as retryable and audits them as failed", async () => {
    const store = new MemoryReleaseStore();
    const clock = new MutableClock();
    const result = await ingestReleaseCandidate(
      {
        releases: store,
        verifier: { verify: async () => ({ kind: "retry", reason: "registry unavailable" }) },
        clock,
        ids: { newReleaseId: () => "release-1" },
      },
      manifest(),
      "operator-1",
      "request-1",
    );
    expect(result).toEqual({ kind: "retry", reason: "registry unavailable" });
    expect(store.audits.at(-1)?.outcome).toBe("failed");
    expect(store.candidates.size).toBe(0);
  });

  it("rejects a runtime contract revision detached from its catalog", () => {
    const input = manifest();
    const parsed = ReleaseCandidateManifestSchema.safeParse({
      ...input,
      runtimeMetadata: { ...input.runtimeMetadata, producerRevision: "b".repeat(40) },
    });
    expect(parsed.success).toBe(false);
  });

  it("keeps legacy reconciliation forward-only after the catalog is exhausted", async () => {
    const store = new MemoryReleaseStore();
    const clock = new MutableClock();
    const first = candidate("1.0.0", "release-1", DIGEST);
    store.candidates.set(first.id, first);

    await expect(discoverStableCandidates(store, { at: clock.now() })).resolves.toMatchObject({
      kind: "advanced",
      discovered: 1,
      nextCursor: null,
    });
    const checkpointAfterFirst = store.checkpoint;

    await expect(discoverStableCandidates(store, { at: clock.now() })).resolves.toMatchObject({
      kind: "advanced",
      discovered: 0,
      nextCursor: null,
    });
    expect(store.checkpoint).toEqual(checkpointAfterFirst);

    const next = candidate("2.0.0", "release-2", OTHER_DIGEST);
    await store.createCandidate(next);
    await expect(discoverStableCandidates(store, { at: clock.now() })).resolves.toMatchObject({
      kind: "advanced",
      discovered: 1,
      nextCursor: null,
    });
    expect(store.workflows.get(first.id)?.state).toBe("queued");
    expect(store.workflows.get(next.id)?.state).toBe("queued");
    expect(store.checkpoint.cursor).toBe(next.id);
  });

  it("persists discovery, runs ten minutes of matching canary evidence, then promotes", async () => {
    const store = new MemoryReleaseStore();
    const clock = new MutableClock();
    const item = candidate();
    store.candidates.set(item.id, item);
    const discovery = await discoverStableCandidates(store, { at: clock.now() });
    expect(discovery.kind).toBe("advanced");

    const deps = promotionDeps(store, clock);
    for (let tick = 0; tick < 20; tick += 1) {
      await advanceOnce(store, deps);
      const workflow = store.workflows.get(item.id)!;
      if (workflow.nextAttemptAt !== null)
        clock.value = Math.max(clock.value, workflow.nextAttemptAt);
      if (workflow.state === "complete") break;
    }

    const final = store.workflows.get(item.id)!;
    expect(store.channel.currentReleaseId).toBe(item.id);
    expect(store.channel.revision).toBe(1);
    expect(store.candidates.get(item.id)?.status).toBe("available");
    expect(final.state).toBe("complete");
    expect(final.canaryCleanupComplete).toBe(true);
    expect(final.lastHealthyAt! - final.healthySince!).toBeGreaterThanOrEqual(
      STABLE_CANARY_HEALTH_WINDOW_MS,
    );
    expect(final.lastHealthEvidence?.artifactDigest).toBe(OTHER_DIGEST);
    expect(final.followerPlanningComplete).toBe(true);
  });

  it("does not count the same provider observation twice toward the canary window", async () => {
    const store = new MemoryReleaseStore();
    const clock = new MutableClock();
    const item = candidate();
    store.candidates.set(item.id, item);
    await store.commitDiscoveryPage({
      expectedRevision: 0,
      expectedCursor: null,
      page: { items: [item], nextCursor: null },
      at: clock.now(),
    });
    const deps = promotionDeps(store, clock, {
      canaryRuntime: {
        ensureRunning: async () => ({ runtimeId: "canary-1", operationId: "canary-op-1" }),
        observe: async ({ runtimeId, operationId }) => ({
          kind: "healthy",
          evidence: {
            artifactDigest: OTHER_DIGEST,
            runtimeId,
            operationId,
            runtimeEpoch: 3,
            providerObservationId: "same-provider-observation",
            source: "runtime-provisioner-observation",
            imageIdentityVerified: true,
            observedAt: clock.nowMs(),
            checks: { startup: true, auth: true, uiApiMcp: true, persistence: true },
            checkEvidence: {
              startup: "startup-probe-1",
              auth: "auth-probe-1",
              uiApiMcp: "ui-api-mcp-probe-1",
              persistence: "persistence-probe-1",
            },
          },
        }),
        stop: async () => ({ kind: "pending" }),
      },
    });
    for (let tick = 0; tick < 20; tick += 1) {
      await advanceOnce(store, deps);
      const workflow = store.workflows.get(item.id)!;
      if (workflow.nextAttemptAt !== null)
        clock.value = Math.max(clock.value, workflow.nextAttemptAt);
    }
    expect(store.workflows.get(item.id)?.state).toBe("canary_observing");
    expect(store.channel.currentReleaseId).toBeNull();
  });

  it("never promotes an unhealthy canary and rejects an older candidate after a newer CAS", async () => {
    const store = new MemoryReleaseStore();
    const clock = new MutableClock();
    const older = candidate("1.0.0", "older", DIGEST);
    const newer = candidate("2.0.0", "newer", OTHER_DIGEST);
    store.candidates.set(older.id, older);
    store.candidates.set(newer.id, newer);
    await store.commitDiscoveryPage({
      expectedRevision: 0,
      expectedCursor: null,
      page: { items: [older, newer], nextCursor: null },
      at: clock.now(),
    });

    const unhealthyDeps = promotionDeps(store, clock, {
      canaryRuntime: {
        ensureRunning: async () => ({ runtimeId: "canary-older", operationId: "op-canary-older" }),
        observe: async () => ({ kind: "unhealthy", code: "readiness_failed" }),
        stop: async ({ runtimeId }) => ({
          kind: "stopped",
          evidence: {
            operationId: "stop-canary-older",
            startedOperationId: "op-canary-older",
            observedAt: clock.nowMs(),
            writerAbsence: {
              instanceId: runtimeId,
              repositoryId: 101,
              retiredEpoch: 2,
              providerObservationId: "census-1",
              censusObservedAt: clock.nowMs(),
              remainingWriters: 0,
              evidenceIdentities: [],
              source: "runtime-provider-census",
            },
          },
        }),
      },
    });
    for (let tick = 0; tick < 8; tick += 1) {
      await advanceOnce(store, unhealthyDeps);
      const workflow = store.workflows.get(older.id)!;
      if (workflow.nextAttemptAt !== null)
        clock.value = Math.max(clock.value, workflow.nextAttemptAt);
    }
    expect(store.workflows.get(older.id)?.state).toBe("rejected");
    expect(store.channel.currentReleaseId).toBeNull();

    store.workflows.set(older.id, { ...queuedWorkflow(older.id), state: "rolling_out" });
    store.workflows.set(newer.id, { ...queuedWorkflow(newer.id), state: "rolling_out" });
    store.candidates.set(newer.id, { ...newer, status: "available" });
    store.channel = {
      key: "stable",
      currentReleaseId: newer.id,
      revision: 1,
      updatedAt: clock.now(),
    };
    const currentAdmission = promotionDeps(store, clock);
    await advanceOnce(store, currentAdmission);
    expect(store.workflows.get(older.id)?.state).toBe("superseded");
    expect(store.channel.currentReleaseId).toBe(newer.id);
  });

  it("waits for a normal canary stop and fresh writer-absence evidence before promotion", async () => {
    const store = new MemoryReleaseStore();
    const clock = new MutableClock();
    const item = candidate();
    store.candidates.set(item.id, item);
    await store.commitDiscoveryPage({
      expectedRevision: 0,
      expectedCursor: null,
      page: { items: [item], nextCursor: null },
      at: clock.now(),
    });
    const deps = promotionDeps(store, clock, {
      canaryRuntime: {
        ensureRunning: async () => ({ runtimeId: "canary-1", operationId: "canary-op-1" }),
        observe: async () => ({
          kind: "healthy",
          evidence: {
            artifactDigest: OTHER_DIGEST,
            runtimeId: "canary-1",
            operationId: "canary-op-1",
            runtimeEpoch: 3,
            providerObservationId: `observation-${clock.nowMs()}`,
            source: "runtime-provisioner-observation",
            imageIdentityVerified: true,
            observedAt: clock.nowMs(),
            checks: { startup: true, auth: true, uiApiMcp: true, persistence: true },
            checkEvidence: {
              startup: "startup-probe-1",
              auth: "auth-probe-1",
              uiApiMcp: "ui-api-mcp-probe-1",
              persistence: "persistence-probe-1",
            },
          },
        }),
        stop: async () => ({ kind: "pending" }),
      },
    });
    for (let tick = 0; tick < 20; tick += 1) {
      await advanceOnce(store, deps);
      const workflow = store.workflows.get(item.id)!;
      if (workflow.nextAttemptAt !== null)
        clock.value = Math.max(clock.value, workflow.nextAttemptAt);
    }
    expect(store.workflows.get(item.id)?.state).toBe("canary_cleanup");
    expect(store.workflows.get(item.id)?.canaryCleanupComplete).toBe(false);
    expect(store.workflows.get(item.id)?.cleanupEvidence).toBeNull();
    expect(store.channel.currentReleaseId).toBeNull();
  });
});
