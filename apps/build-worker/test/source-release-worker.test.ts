import { describe, expect, it, vi } from "vitest";
import {
  sanitizeSourceDiagnostic,
  SourceProducerResultSchema,
  type SourceBuildDiagnostic,
  type SourceProducerResult,
} from "@praetorium/contracts";
import type { BuildWorkerConfig } from "../src/config.js";
import { BuildQueueHttpError } from "../src/http-client.js";
import {
  SourceBuildChangedError,
  SourceBuildFailureError,
  SourceBuildVerificationError,
} from "../src/source-producer-builder.js";
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
const RESULT: SourceProducerResult = SourceProducerResultSchema.parse({
  statement: {
    schemaVersion: 3,
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
    nodeImage:"docker.io/library/node@"+DIGEST,buildEnvironmentDigest:DIGEST,
    resolverDigest:DIGEST,resolverProvenanceDigest:DIGEST,
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
  resolver:{producerRevision:JOB.source_revision,resolverRevision:DIGEST,contractVersion:"scriptorium-build/v1",provenanceDigest:DIGEST},
});
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
      reportDiagnostic: vi.fn(async () => true),
      failSource: vi.fn(async () => ({accepted:true,diagnosticRecorded:true})),
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
      reportDiagnostic: vi.fn(async () => true),
      failSource: vi.fn(async () => ({accepted:true,diagnosticRecorded:true})),
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
      reportDiagnostic: vi.fn(async () => true),
      failSource: vi.fn(async () => ({accepted:true,diagnosticRecorded:true})),
    };
    const worker = new SourceReleaseBuildWorker(CONFIG, client, async () => {
      throw new SourceBuildChangedError();
    });

    await expect(worker.runOnce()).resolves.toBe(true);
    expect(client.failSource).toHaveBeenCalledWith(JOB, "SOURCE_CHANGED", expect.objectContaining({
      stage:"unknown",reason:"source_changed",
    }));
    expect(client.producedSource).not.toHaveBeenCalled();
  });

  it("terminalizes malformed or oversized builder evidence as verification failure", async () => {
    const client: SourceBuildQueueClient = {
      claimSource: vi.fn(async () => JOB),
      heartbeatSource: vi.fn(async () => true),
      producedSource: vi.fn(async () => true),
      reportDiagnostic: vi.fn(async () => true),
      failSource: vi.fn(async () => ({accepted:true,diagnosticRecorded:true})),
    };
    const worker = new SourceReleaseBuildWorker(CONFIG, client, async () => {
      throw new SourceBuildVerificationError();
    });

    await expect(worker.runOnce()).resolves.toBe(true);
    expect(client.failSource).toHaveBeenCalledWith(JOB, "SOURCE_VERIFICATION_FAILED", expect.objectContaining({
      stage:"verification",reason:"verification_failed",
    }));
    expect(client.producedSource).not.toHaveBeenCalled();
  });

  it("awaits stage telemetry and continues on an unavailable diagnostics endpoint", async () => {
    const stage=sanitizeSourceDiagnostic({stage:"buildkit",reason:"stage_started",summary:"",truncated:false});
    const client: SourceBuildQueueClient = {
      claimSource: vi.fn(async () => JOB),
      heartbeatSource: vi.fn(async () => true),
      producedSource: vi.fn(async () => true),
      reportDiagnostic: vi.fn(async () => { throw new BuildQueueHttpError(404); }),
      failSource: vi.fn(async () => ({accepted:true,diagnosticRecorded:true})),
    };
    const order:string[]=[];
    const worker = new SourceReleaseBuildWorker(CONFIG, client, async (_job,_config,_signal,onStage) => {
      order.push("start");
      await onStage(stage);
      order.push("build");
      return RESULT;
    });

    await expect(worker.runOnce()).resolves.toBe(true);
    expect(order).toEqual(["start","build"]);
    expect(client.reportDiagnostic).toHaveBeenCalledWith(JOB,stage);
    expect(client.producedSource).toHaveBeenCalledOnce();
  });

  it("records safe delivery failures even when terminal Source failure is accepted without evidence", async () => {
    const diagnostics:string[]=[];
    const stderr=vi.spyOn(process.stderr,"write").mockImplementation((chunk)=>{
      diagnostics.push(String(chunk)); return true;
    });
    try {
      const diagnostic=sanitizeSourceDiagnostic({stage:"buildkit",reason:"build_failed",summary:"",truncated:false});
      const client:SourceBuildQueueClient={
        claimSource:vi.fn(async()=>JOB), heartbeatSource:vi.fn(async()=>true),
        producedSource:vi.fn(async()=>true),
        reportDiagnostic:vi.fn(async()=>{throw new BuildQueueHttpError(503);}),
        failSource:vi.fn(async()=>({accepted:true,diagnosticRecorded:false})),
      };
      const worker=new SourceReleaseBuildWorker(CONFIG,client,async(_job,_config,_signal,onStage)=>{
        await onStage(diagnostic);
        throw new SourceBuildFailureError("SOURCE_BUILD_FAILED",diagnostic);
      });
      expect(await worker.runOnce()).toBe(true);
      expect(client.failSource).toHaveBeenCalledOnce();
      expect(diagnostics.some(line=>line.includes("stage_report_unavailable"))).toBe(true);
      expect(diagnostics.some(line=>line.includes("stage_and_final_evidence_missing"))).toBe(true);
      expect(diagnostics.join("")).toContain(JOB.job_id);
      expect(diagnostics.join("")).not.toContain(JOB.lease_token);
    } finally {stderr.mockRestore();}
  });
  it("stops and never reports a result when diagnostic reporting rejects the lease fence", async () => {
    const stage:SourceBuildDiagnostic=sanitizeSourceDiagnostic({
      stage:"runtime_base",reason:"stage_started",summary:"",truncated:false,
    });
    let producerSignal:AbortSignal|undefined;
    const client: SourceBuildQueueClient = {
      claimSource: vi.fn(async () => JOB),
      heartbeatSource: vi.fn(async () => true),
      producedSource: vi.fn(async () => true),
      reportDiagnostic: vi.fn(async () => false),
      failSource: vi.fn(async () => ({accepted:true,diagnosticRecorded:true})),
    };
    const worker = new SourceReleaseBuildWorker(CONFIG, client, async (_job,_config,signal,onStage) => {
      producerSignal=signal;
      await onStage(stage);
      return RESULT;
    });

    await expect(worker.runOnce()).resolves.toBe(true);
    expect(producerSignal?.aborted).toBe(true);
    expect(client.failSource).not.toHaveBeenCalled();
    expect(client.producedSource).not.toHaveBeenCalled();
  });

  it("fails with the builder's actual stage and sanitized cause", async () => {
    const diagnostic=sanitizeSourceDiagnostic({
      stage:"buildkit",reason:"build_failed",summary:"",
      excerpt:"src/app.ts:12 - error TS2307: Cannot find module '@praetorium/contracts'",
      truncated:false,
    });
    const client:SourceBuildQueueClient={
      claimSource:vi.fn(async()=>JOB),
      heartbeatSource:vi.fn(async()=>true),
      producedSource:vi.fn(async()=>true),
      reportDiagnostic:vi.fn(async()=>true),
      failSource:vi.fn(async()=>({accepted:true,diagnosticRecorded:true})),
    };
    const worker=new SourceReleaseBuildWorker(CONFIG,client,async()=>{
      throw new SourceBuildFailureError("SOURCE_BUILD_FAILED",diagnostic);
    });

    await expect(worker.runOnce()).resolves.toBe(true);
    expect(client.failSource).toHaveBeenCalledWith(JOB,"SOURCE_BUILD_FAILED",diagnostic);
    expect(client.producedSource).not.toHaveBeenCalled();
  });
});
