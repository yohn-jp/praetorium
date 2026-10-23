import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildKey, sanitizeSourceDiagnostic } from "@praetorium/contracts";
import type { BuildInput, SourceBuildDiagnostic, SourceProducerResult } from "@praetorium/contracts";
import type { SourceBuildClaim } from "../src/source-producer-builder.js";
import {
  BuildQueueHttpClient,
  BuildQueueHttpError,
  readBuildServiceToken,
} from "../src/http-client.js";

const roots: string[] = [];
const input: BuildInput = {
  contractVersion: "scriptorium-build/v1",
  producerRevision: "a".repeat(40),
  runtimeBaseDigest: `sha256:${"1".repeat(64)}`,
  buildKitDigest: `sha256:${"2".repeat(64)}`,
  recipeDigest: `sha256:${"3".repeat(64)}`,
  sourceDigest: `sha256:${"4".repeat(64)}`,
  lockDigest: `sha256:${"5".repeat(64)}`,
  requestedModules: [],
  resolvedModules: [],
  platform: "linux/amd64",
  options: {},
};
const digest = `sha256:${"6".repeat(64)}`;
const composition = {
  repository: "registry.example/praetorium/composition",
  digest: `sha256:${"7".repeat(64)}`,
};
const statement = {
  schemaVersion: "praetorium.build-artifact/v1" as const,
  buildKey: `sha256:${"8".repeat(64)}`,
  artifact: {
    repository: "registry.example/praetorium/candidates",
    digest,
    platformManifestDigest: `sha256:${"9".repeat(64)}`,
    platform: "linux/amd64" as const,
  },
  compositionManifest: composition,
  producerRevision: input.producerRevision,
  resolvedModules: [],
  contractVersion: input.contractVersion,
  issuedAt: "2026-10-17T00:00:00.000Z",
};
const signature = {
  algorithm: "Ed25519" as const,
  keyId: "builder-1",
  signature: Buffer.from("test").toString("base64"),
};
const token = "service-token-" + "x".repeat(40);

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "praetorium-build-worker-test-"));
  roots.push(root);
  return root;
}

function client(fetch: typeof globalThis.fetch, maxResponseBytes = 262_144): BuildQueueHttpClient {
  return new BuildQueueHttpClient({
    baseUrl: "https://control.example",
    serviceToken: token,
    requestTimeoutMs: 1000,
    maxResponseBytes,
    leaseSeconds: 60,
    fetch,
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Build Control Plane HTTP adapter", () => {
  it("sends the worker-supported 15-second Source claim and heartbeat lease", async () => {
    const sourceJob = {
      job_id: "sr_00000000-0000-4000-8000-000000000001",
      lease_worker: "worker-1",
      lease_token: "00000000-0000-4000-8000-000000000002",
      lease_epoch: 1,
    } as SourceBuildClaim;
    const responses = [
      new Response(JSON.stringify({ job: sourceJob })),
      new Response(JSON.stringify({ accepted: true })),
    ];
    const fetchMock = vi.fn(async () => responses.shift()!);
    const queue = new BuildQueueHttpClient({
      baseUrl: "https://control.example",
      serviceToken: token,
      requestTimeoutMs: 1000,
      maxResponseBytes: 262_144,
      leaseSeconds: 15,
      fetch: fetchMock as typeof fetch,
    });

    await expect(queue.claimSource("worker-1", 15)).resolves.toEqual(sourceJob);
    await expect(queue.heartbeatSource(sourceJob, 15)).resolves.toBe(true);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      workerId: "worker-1", leaseSeconds: 15,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      workerId: "worker-1", leaseToken: sourceJob.lease_token,
      leaseEpoch: sourceJob.lease_epoch, leaseSeconds: 15,
    });
  });

  it("reports a sanitized Source stage under the active lease fence", async () => {
    const job={job_id:"sr_00000000-0000-4000-8000-000000000001",lease_worker:"worker-1",
      lease_token:"00000000-0000-4000-8000-000000000002",lease_epoch:3} as SourceBuildClaim;
    const diagnostic:SourceBuildDiagnostic=sanitizeSourceDiagnostic({
      stage:"buildkit",reason:"build_failed",summary:"ignored summary",
      excerpt:"src/app.ts:12:7 - error TS2307: Cannot find module '@praetorium/contracts'",
      truncated:false,
    });
    const fetchMock=vi.fn(async()=>new Response(JSON.stringify({accepted:true})));
    const queue=client(fetchMock as typeof fetch);

    await expect(queue.reportDiagnostic(job,diagnostic)).resolves.toBe(true);
    const [url,init]=fetchMock.mock.calls[0]!;
    expect((url as URL).pathname).toBe("/internal/builds/source/"+job.job_id+"/diagnostics");
    expect(JSON.parse(String(init?.body))).toEqual({
      workerId:job.lease_worker,leaseToken:job.lease_token,leaseEpoch:job.lease_epoch,
      diagnostic,
    });
  });

  it("removes the configured worker credential before diagnostic transport", async () => {
    const job={job_id:"sr_00000000-0000-4000-8000-000000000001",lease_worker:"worker-1",
      lease_token:"00000000-0000-4000-8000-000000000002",lease_epoch:3} as SourceBuildClaim;
    const diagnostic:SourceBuildDiagnostic={
      stage:"buildkit",reason:"build_failed",summary:"ignored summary",
      excerpt:"src/app.ts:12 - error TS2307: "+token,
      truncated:false,
    };
    const fetchMock=vi.fn(async()=>new Response(JSON.stringify({accepted:true})));
    const queue=client(fetchMock as typeof fetch);

    await expect(queue.reportDiagnostic(job,diagnostic)).resolves.toBe(true);
    const body=String(fetchMock.mock.calls[0]?.[1]?.body);
    expect(body).not.toContain(token);
    expect(JSON.parse(body).diagnostic).not.toHaveProperty("excerpt");
  });

  it("retries a diagnostic failure report once without evidence when an older CP rejects its field", async () => {
    const job={job_id:"sr_00000000-0000-4000-8000-000000000001",lease_worker:"worker-1",
      lease_token:"00000000-0000-4000-8000-000000000002",lease_epoch:3} as SourceBuildClaim;
    const diagnostic:SourceBuildDiagnostic=sanitizeSourceDiagnostic({
      stage:"buildkit",reason:"build_failed",summary:"ignored summary",
      excerpt:"src/app.ts:12 - error TS2307: Cannot find module 'x'",
      truncated:false,
    });
    const responses=[new Response("invalid request",{status:400}),new Response(JSON.stringify({accepted:true}))];
    const fetchMock=vi.fn(async()=>responses.shift()!);
    const queue=client(fetchMock as typeof fetch);

    await expect(queue.failSource(job,"SOURCE_BUILD_FAILED",diagnostic)).resolves.toEqual({
      accepted:true,diagnosticRecorded:false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first=JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string,unknown>;
    const second=JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string,unknown>;
    expect(first).toMatchObject({workerId:job.lease_worker,leaseToken:job.lease_token,leaseEpoch:job.lease_epoch,code:"SOURCE_BUILD_FAILED",diagnostic});
    expect(second).toEqual({workerId:job.lease_worker,leaseToken:job.lease_token,leaseEpoch:job.lease_epoch,code:"SOURCE_BUILD_FAILED"});
    expect(fetchMock.mock.calls[0]?.[0]).toEqual(fetchMock.mock.calls[1]?.[0]);
  });

  it.each([401,409])("does not retry diagnostic failure reports after HTTP %i", async (status) => {
    const job={job_id:"sr_00000000-0000-4000-8000-000000000001",lease_worker:"worker-1",
      lease_token:"00000000-0000-4000-8000-000000000002",lease_epoch:3} as SourceBuildClaim;
    const diagnostic=sanitizeSourceDiagnostic({stage:"buildkit",reason:"build_failed",summary:"",truncated:false});
    const fetchMock=vi.fn(async()=>new Response("opaque",{status}));
    const queue=client(fetchMock as typeof fetch);

    await expect(queue.failSource(job,"SOURCE_BUILD_FAILED",diagnostic)).rejects.toMatchObject({status});
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps the Produced proof request bounded by its longer verification budget", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const fetchMock = vi.fn(async (_url: URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        signal = init?.signal as AbortSignal | undefined;
        signal?.addEventListener("abort", () => reject(new Error("request timed out")), { once: true });
      }));
      const queue = new BuildQueueHttpClient({
        baseUrl: "https://control.example",
        serviceToken: token,
        requestTimeoutMs: 100,
        sourceReportTimeoutMs: 500,
        maxResponseBytes: 262_144,
        leaseSeconds: 60,
        fetch: fetchMock as typeof fetch,
      });
      const job = {
        job_id: "sr_00000000-0000-4000-8000-000000000001",
        lease_worker: "worker-1",
        lease_token: "00000000-0000-4000-8000-000000000002",
        lease_epoch: 1,
      } as SourceBuildClaim;
      const report = queue.producedSource(job, {} as SourceProducerResult);
      const expectedTimeout = expect(report).rejects.toBeInstanceOf(BuildQueueHttpError);
      await vi.advanceTimersByTimeAsync(499);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expectedTimeout;
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("claims a validated immutable input and sends the separate service bearer", async () => {
    const claim = {
      buildId: "build-1",
      buildKey: await buildKey(input),
      input,
      attemptId: "attempt-1",
      attempt: 1,
      leaseEpoch: 1,
      leaseToken: "z".repeat(48),
      leaseExpiresAt: Date.now() + 60_000,
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(claim)));
    const result = await client(fetchMock as typeof fetch).claimNext({
      workerId: "worker-1",
      now: 123,
      leaseSeconds: 60,
    });
    expect(result).toEqual(claim);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBeInstanceOf(URL);
    expect((url as URL).pathname).toBe("/internal/builds/claim");
    expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${token}`);
    expect(JSON.parse(String(init?.body))).toEqual({ workerId: "worker-1", leaseSeconds: 60 });
    expect(init?.redirect).toBe("error");
  });

  it("fences heartbeats and reports with attempt token, epoch, and monotonic sequence while omitting local time", async () => {
    const responses = [
      new Response(
        JSON.stringify({
          accepted: true,
          cancelRequested: false,
          leaseExpiresAt: Date.now() + 60_000,
        }),
      ),
      new Response(JSON.stringify({ accepted: true, duplicate: false })),
    ];
    const fetchMock = vi.fn(async () => responses.shift()!);
    const queue = client(fetchMock as typeof fetch);
    const common = {
      buildId: "build-1",
      attemptId: "attempt-1",
      workerId: "worker-1",
      leaseToken: "z".repeat(48),
      leaseEpoch: 2,
      sequence: 4,
      now: 123456,
    };
    await expect(
      queue.heartbeat({ ...common, progress: { stage: "building", percent: 42 } }),
    ).resolves.toMatchObject({ accepted: true, cancelRequested: false });
    const buildKeyValue = await buildKey(input);
    const boundStatement = { ...statement, buildKey: buildKeyValue };
    await expect(
      queue.report({
        ...common,
        buildKey: buildKeyValue,
        result: {
          kind: "succeeded",
          candidateRef: `registry.example/praetorium/candidates@${digest}`,
          manifestDigest: digest,
          compositionManifest: composition,
          statement: boundStatement,
          signature,
        },
      }),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    const heartbeatBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<
      string,
      unknown
    >;
    const reportBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<
      string,
      unknown
    >;
    expect(heartbeatBody).not.toHaveProperty("now");
    expect(reportBody).not.toHaveProperty("now");
    expect(reportBody).toMatchObject({
      buildKey: buildKeyValue,
      result: { kind: "succeeded", statement: boundStatement, signature },
    });
  });

  it("treats oversized responses and HTTP error bodies as opaque failures", async () => {
    const oversized = client(async () => new Response("x".repeat(2048)), 1024);
    await expect(
      oversized.claimNext({ workerId: "worker-1", now: Date.now(), leaseSeconds: 60 }),
    ).rejects.toBeInstanceOf(BuildQueueHttpError);

    const rejected = client(
      async () => new Response("credential must not be parsed", { status: 403 }),
    );
    await expect(
      rejected.claimNext({ workerId: "worker-1", now: Date.now(), leaseSeconds: 60 }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("accepts only a private owned worker-token file", async () => {
    const root = await makeRoot();
    const file = path.join(root, "token");
    await writeFile(file, token, { mode: 0o600 });
    await expect(readBuildServiceToken(file)).resolves.toBe(token);
    await chmod(file, 0o644);
    await expect(readBuildServiceToken(file)).rejects.toThrow("credential is invalid");
  });
});
