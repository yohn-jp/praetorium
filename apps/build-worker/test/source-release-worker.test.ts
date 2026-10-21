import { describe, expect, it, vi } from "vitest";
import type { SourceProducerResult } from "@praetorium/contracts";
import type { BuildWorkerConfig } from "../src/config.js";
import { SourceBuildChangedError } from "../src/source-producer-builder.js";
import {
  SourceReleaseBuildWorker,
  type SourceBuildQueueClient,
} from "../src/source-release-worker.js";

const DIGEST = `sha256:${"1".repeat(64)}`;
const JOB = {
  job_id: "sr_00000000-0000-4000-8000-000000000001",
  source_id: "scriptorium" as const,
  source_repository: "yohn-jp/scriptorium" as const,
  github_release_id: 416422590,
  source_tag: "v0.2.1",
  source_revision: "a".repeat(40),
  release_version: "0.2.1",
  actor_id: "71",
  state: "building" as const,
  attempt: 1,
  revision: 0,
  admission_attempt: 0,
  next_attempt_at: null,
  lease_worker: "source-worker-1",
  lease_token: "00000000-0000-4000-8000-000000000002",
  lease_epoch: 1,
  lease_expires_at: Date.now() + 60_000,
  created_at: Date.now(),
  updated_at: Date.now(),
  failure_code: null,
  admitted_release_id: null,
};
const RESULT: SourceProducerResult = {
  statement: {
    schemaVersion: 1,
    jobId: JOB.job_id,
    githubReleaseId: JOB.github_release_id,
    sourceId: "scriptorium",
    sourceRepository: "yohn-jp/scriptorium",
    sourceTag: JOB.source_tag,
    sourceRevision: JOB.source_revision,
    releaseVersion: JOB.release_version,
    imageRepository: "ghcr.io/yohn-jp/praetorium/scriptorium-producer",
    runtimeBaseDigest: DIGEST,
    buildKitDigest: DIGEST,
    catalogDigest: DIGEST,
    runtimeMetadataDigest: DIGEST,
  },
  signature: { algorithm: "Ed25519", keyId: "worker-key-1", signature: "dGVzdA==" },
  catalog: {
    contractVersion: "scriptorium-build/v1",
    producerRevision: JOB.source_revision,
    runtimeBaseDigest: DIGEST,
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
    producerRevision: JOB.source_revision,
    listener: { port: 3000 },
    paths: {
      liveness: "/healthz",
      readiness: "/readyz",
      metadata: "/metadata",
      shutdown: "/shutdown",
      status: "/api/platform/v1/status",
      quiesce: "/api/platform/v1/quiesce",
      resume: "/api/platform/v1/resume",
    },
    shutdownTimeoutSeconds: 25,
  },
};
const CONFIG = {
  workerId: JOB.lease_worker,
  leaseSeconds: 30,
  heartbeatIntervalMs: 5,
} as unknown as BuildWorkerConfig;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("Source Release Worker lease lifecycle", () => {
  it("keeps renewing the lease while the Control Plane verifies the Produced proof", async () => {
    let heartbeatCount = 0;
    let producedStarted = false;
    let releaseProduced!: (accepted: boolean) => void;
    const producedGate = new Promise<boolean>((resolve) => { releaseProduced = resolve; });
    const client: SourceBuildQueueClient = {
      claimSource: vi.fn(async () => JOB),
      heartbeatSource: vi.fn(async () => { heartbeatCount += 1; return true; }),
      producedSource: vi.fn(async () => {
        producedStarted = true;
        return producedGate;
      }),
      failSource: vi.fn(async () => true),
    };
    const worker = new SourceReleaseBuildWorker(CONFIG, client, async () => RESULT);
    const running = worker.runOnce();
    const start = Date.now();
    while (!producedStarted && Date.now() - start < 1000) await wait(1);
    expect(producedStarted).toBe(true);
    await wait(40);
    expect(heartbeatCount).toBeGreaterThan(1);
    releaseProduced(true);
    await expect(running).resolves.toBe(true);
  });

  it("does not report Produced after a lease heartbeat is rejected during source execution", async () => {
    let producerSignal: AbortSignal | undefined;
    const client: SourceBuildQueueClient = {
      claimSource: vi.fn(async () => JOB),
      heartbeatSource: vi.fn(async () => false),
      producedSource: vi.fn(async () => true),
      failSource: vi.fn(async () => true),
    };
    const worker = new SourceReleaseBuildWorker(CONFIG, client, async (_job, _config, signal) => {
      producerSignal = signal;
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      throw new Error("lease lost");
    });

    await expect(worker.runOnce()).resolves.toBe(true);
    expect(producerSignal?.aborted).toBe(true);
    expect(client.producedSource).not.toHaveBeenCalled();
    expect(client.failSource).not.toHaveBeenCalled();
  });

  it("terminalizes a moved or unpublished Release instead of retrying it as a build outage", async () => {
    const client: SourceBuildQueueClient = {
      claimSource: vi.fn(async () => JOB),
      heartbeatSource: vi.fn(async () => true),
      producedSource: vi.fn(async () => true),
      failSource: vi.fn(async () => true),
    };
    const worker = new SourceReleaseBuildWorker(CONFIG, client, async () => {
      throw new SourceBuildChangedError();
    });

    await expect(worker.runOnce()).resolves.toBe(true);
    expect(client.failSource).toHaveBeenCalledWith(JOB, "SOURCE_CHANGED");
    expect(client.producedSource).not.toHaveBeenCalled();
  });
});
