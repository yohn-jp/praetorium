import { describe, expect, it, vi } from "vitest";
import { buildKey } from "@praetorium/contracts";
import { BuildWorkerService } from "./worker.js";
import type { BuildAttestor, BuildCandidate } from "./types.js";
import type {
  BuildClaim,
  BuildQueueHeartbeatInput,
  BuildQueuePort,
  BuildQueueReportInput,
} from "./queue-types.js";
import type { BuildInput } from "@praetorium/contracts";
import { WorkAvailability } from "../work-availability.js";

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
const imageDigest = `sha256:${"6".repeat(64)}`;
const statement = {
  schemaVersion: "praetorium.build-artifact/v1" as const,
  buildKey: `sha256:${"7".repeat(64)}`,
  artifact: {
    repository: "praetorium/candidates",
    digest: imageDigest,
    platformManifestDigest: `sha256:${"8".repeat(64)}`,
    platform: "linux/amd64" as const,
  },
  compositionManifest: {
    repository: "praetorium/compositions",
    digest: `sha256:${"9".repeat(64)}`,
  },
  producerRevision: input.producerRevision,
  resolvedModules: [],
  contractVersion: input.contractVersion,
  issuedAt: "2026-10-17T00:00:00.000Z",
};
const signature = {
  algorithm: "Ed25519" as const,
  keyId: "test-builder",
  signature: Buffer.from("sig").toString("base64"),
};

function buildClaim(buildKey: string): BuildClaim {
  return {
    buildId: "build-1",
    buildKey,
    input,
    attemptId: "attempt-1",
    attempt: 1,
    leaseEpoch: 1,
    leaseToken: "f".repeat(48),
    leaseExpiresAt: Date.now() + 60_000,
  };
}

async function harness(options: {
  cancelHeartbeat?: number;
  staleHeartbeat?: number;
  workAvailability?: Pick<WorkAvailability, "wait">;
} = {}) {
  const heartbeats: BuildQueueHeartbeatInput[] = [];
  const reports: BuildQueueReportInput[] = [];
  let heartbeatCount = 0;
  const claim = buildClaim(await buildKey(input));
  const queue: BuildQueuePort = {
    claimNext: vi.fn(async () => claim),
    heartbeat: vi.fn(async (heartbeat) => {
      heartbeats.push(heartbeat);
      heartbeatCount++;
      return {
        accepted: heartbeatCount !== options.staleHeartbeat,
        cancelRequested: heartbeatCount === options.cancelHeartbeat,
        leaseExpiresAt: heartbeatCount === options.staleHeartbeat ? null : Date.now() + 60_000,
      };
    }),
    report: vi.fn(async (report) => {
      reports.push(report);
      return { accepted: true, duplicate: false };
    }),
  };
  const receipt: BuildCandidate = {
    candidateRef: `registry.example/praetorium/candidates@${imageDigest}`,
    manifestDigest: imageDigest,
    compositionManifest: statement.compositionManifest,
  };
  const execute = vi.fn(async (_request, _signal, beforeEffect) => {
    await beforeEffect();
    return receipt;
  });
  const provider = { execute };
  const attest = vi.fn(async (attestationInput) => {
    await attestationInput.beforeEffect();
    return {
      ...attestationInput.candidate,
      statement: { ...statement, buildKey: attestationInput.buildKey },
      signature,
    };
  });
  const attestor: BuildAttestor = { attest };
  const worker = new BuildWorkerService(queue, provider, attestor, {
    workerId: "worker-1",
    leaseSeconds: 60,
    heartbeatIntervalMs: 30_000,
    ...(options.workAvailability ? { workAvailability: options.workAvailability } : {}),
    now: () => Date.now(),
  });
  return { worker, queue, execute, attest, heartbeats, reports, claim };
}

describe("BuildWorkerService", () => {
  it("keeps the lease fence out of BuildKit and reports only a signed candidate with monotonic sequence", async () => {
    const h = await harness();
    await expect(h.worker.runOnce()).resolves.toBe(true);

    expect(h.execute).toHaveBeenCalledOnce();
    const providerRequest = h.execute.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(providerRequest).not.toHaveProperty("leaseToken");
    expect(providerRequest).toMatchObject({
      buildKey: h.claim.buildKey,
      attemptId: h.claim.attemptId,
      attempt: 1,
    });
    expect(h.attest).toHaveBeenCalledOnce();
    expect(h.heartbeats.every((heartbeat) => heartbeat.leaseToken === h.claim.leaseToken)).toBe(
      true,
    );
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]).toMatchObject({
      buildKey: h.claim.buildKey,
      attemptId: h.claim.attemptId,
      leaseEpoch: h.claim.leaseEpoch,
      leaseToken: h.claim.leaseToken,
      result: {
        kind: "succeeded",
        candidateRef: `registry.example/praetorium/candidates@${imageDigest}`,
        compositionManifest: statement.compositionManifest,
        statement: { ...statement, buildKey: h.claim.buildKey },
        signature,
      },
    });
    const sequences = [
      ...h.heartbeats.map((heartbeat) => heartbeat.sequence),
      h.reports[0]!.sequence,
    ];
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
  });

  it("reports cancellation and never starts the provider when cancellation is returned by the fence", async () => {
    const h = await harness({ cancelHeartbeat: 1 });
    await h.worker.runOnce();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.attest).not.toHaveBeenCalled();
    expect(h.reports[0]?.result).toMatchObject({
      kind: "canceled",
      code: "BUILD_CANCELED",
      retryable: false,
    });
  });

  it("drops a stale attempt without reporting any result", async () => {
    const h = await harness({ staleHeartbeat: 1 });
    await h.worker.runOnce();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.reports).toHaveLength(0);
  });

  it("reports provider failures without letting report errors become a second build failure", async () => {
    const h = await harness();
    h.execute.mockRejectedValueOnce(
      Object.assign(new Error("private raw output"), { code: "BUILD_TIMEOUT", retryable: true }),
    );
    await h.worker.runOnce();
    expect(h.reports[0]?.result).toEqual({
      kind: "failed",
      code: "BUILD_TIMEOUT",
      message: "Build exceeded its configured deadline",
      retryable: true,
    });
  });

  it("does not convert a failed success report into a failed-build report", async () => {
    const h = await harness();
    vi.mocked(h.queue.report).mockRejectedValueOnce(new Error("network unavailable"));
    await expect(h.worker.runOnce()).rejects.toThrow();
    expect(h.queue.report).toHaveBeenCalledOnce();
  });

  it("uses bounded reconciliation when no notification listener is configured", async () => {
    const h = await harness();
    vi.mocked(h.queue.claimNext).mockResolvedValue(null);
    const shutdown = new AbortController();
    const timer = setTimeout(() => shutdown.abort(), 20);

    await h.worker.runUntilStopped(shutdown.signal, 2);
    clearTimeout(timer);

    expect(vi.mocked(h.queue.claimNext).mock.calls.length).toBeGreaterThan(1);
  });

  it("claims at startup and reconciles after a lost notification only at the bounded deadline", async () => {
    vi.useFakeTimers();
    try {
      const workAvailability = new WorkAvailability();
      const h = await harness({ workAvailability });
      const shutdown = new AbortController();
      let claims = 0;
      vi.mocked(h.queue.claimNext).mockImplementation(async () => {
        claims++;
        if (claims === 2) shutdown.abort();
        return null;
      });

      const running = h.worker.runUntilStopped(shutdown.signal, 300_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(claims).toBe(1);

      await vi.advanceTimersByTimeAsync(299_999);
      expect(claims).toBe(1);

      await vi.advanceTimersByTimeAsync(1);
      await running;
      expect(claims).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("claims from D1 after a work notification wakes the idle worker", async () => {
    let wake!: () => void;
    const workAvailability: Pick<WorkAvailability, "wait"> = {
      wait: vi.fn(async (signal) => {
        await new Promise<void>((resolve) => {
          wake = resolve;
          signal.addEventListener("abort", resolve, { once: true });
        });
      }),
    };
    const h = await harness({ workAvailability });
    const shutdown = new AbortController();
    let claims = 0;
    vi.mocked(h.queue.claimNext).mockImplementation(async () => {
      claims++;
      if (claims === 1) return null;
      if (claims === 2) return h.claim;
      shutdown.abort();
      return null;
    });

    const running = h.worker.runUntilStopped(shutdown.signal, 300_000);
    await vi.waitFor(() => expect(workAvailability.wait).toHaveBeenCalledOnce());
    wake();
    await running;

    expect(claims).toBe(3);
    expect(workAvailability.wait).toHaveBeenCalledWith(shutdown.signal, 300_000);
    expect(h.queue.claimNext).toHaveBeenCalledTimes(3);
  });
});
