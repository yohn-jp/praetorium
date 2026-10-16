import { buildKey } from "@praetorium/contracts";
import type {
  BuildCandidate,
  BuildExecutionRequest,
  BuildFailure,
  BuildProgress,
  BuildProvider,
  BuildAttestor,
  SignedBuildCandidate,
} from "./types.js";
import type {
  BuildClaim,
  BuildQueueHeartbeatInput,
  BuildQueueHeartbeatResult,
  BuildQueueReportInput,
  BuildQueuePort,
} from "./queue-types.js";

export class BuildLeaseLostError extends Error {
  constructor() {
    super("Build attempt lease is no longer current");
    this.name = "BuildLeaseLostError";
  }
}

export class BuildCancellationError extends Error {
  constructor() {
    super("Build cancellation was requested");
    this.name = "BuildCancellationError";
  }
}

type WorkerOptions = {
  workerId: string;
  leaseSeconds: number;
  heartbeatIntervalMs: number;
  now?: () => number;
};

function failureFor(error: unknown): BuildFailure {
  const retryable =
    error && typeof error === "object" && "retryable" in error
      ? (error as { retryable?: unknown }).retryable === true
      : true;
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (code === "BUILD_TIMEOUT")
      return { kind: "failed", code, message: "Build exceeded its configured deadline", retryable };
    if (code === "BUILD_CANCELED")
      return { kind: "canceled", code, message: "Build was canceled", retryable: false };
  }
  if (error instanceof BuildCancellationError) {
    return {
      kind: "canceled",
      code: "BUILD_CANCELED",
      message: "Build was canceled",
      retryable: false,
    };
  }
  return { kind: "failed", code: "BUILD_FAILED", message: "BuildKit solve failed", retryable };
}

function validProgress(value: BuildProgress): boolean {
  return (
    (value.stage === "preparing" || value.stage === "building" || value.stage === "publishing") &&
    (value.percent === null ||
      (Number.isInteger(value.percent) && value.percent >= 0 && value.percent <= 100))
  );
}

export class BuildWorkerService {
  private currentAbort: AbortController | null = null;
  private readonly now: () => number;

  constructor(
    private readonly queue: BuildQueuePort,
    private readonly provider: BuildProvider,
    private readonly attestor: BuildAttestor,
    private readonly options: WorkerOptions,
  ) {
    if (
      !options.workerId ||
      options.workerId.length > 128 ||
      !Number.isSafeInteger(options.leaseSeconds) ||
      options.leaseSeconds < 15 ||
      options.leaseSeconds > 3600 ||
      !Number.isSafeInteger(options.heartbeatIntervalMs) ||
      options.heartbeatIntervalMs < 250 ||
      options.heartbeatIntervalMs >= options.leaseSeconds * 1000
    ) {
      throw new TypeError("Build worker limits are invalid");
    }
    this.now = options.now ?? Date.now;
  }

  async runOnce(shutdownSignal?: AbortSignal): Promise<boolean> {
    const claim = await this.queue.claimNext({
      workerId: this.options.workerId,
      now: this.now(),
      leaseSeconds: this.options.leaseSeconds,
    });
    if (!claim) return false;
    await this.runClaim(claim, shutdownSignal);
    return true;
  }

  async runUntilStopped(signal: AbortSignal, idleDelayMs: number): Promise<void> {
    if (!Number.isSafeInteger(idleDelayMs) || idleDelayMs < 1 || idleDelayMs > 60_000) {
      throw new TypeError("Idle delay is invalid");
    }
    while (!signal.aborted) {
      let didWork = false;
      try {
        didWork = await this.runOnce(signal);
      } catch {
        // Retry after a bounded delay; response bodies, credentials and raw logs are not emitted.
      }
      if (!didWork && !signal.aborted) await delay(idleDelayMs, signal);
    }
  }

  stopCurrentBuild(reason?: unknown): void {
    this.currentAbort?.abort(reason ?? new BuildCancellationError());
  }

  private async runClaim(claim: BuildClaim, shutdownSignal?: AbortSignal): Promise<void> {
    if ((await buildKey(claim.input)) !== claim.buildKey)
      throw new TypeError("Build claim input binding is invalid");
    const controller = new AbortController();
    this.currentAbort = controller;
    const detachShutdown = linkAbort(shutdownSignal, controller);
    let leaseLost = false;
    let cancelRequested = false;
    let heartbeatError: unknown;
    let sequence = 1;
    let latestProgress: BuildProgress | undefined;
    let heartbeatChain: Promise<void> = Promise.resolve();
    let heartbeatInFlight = false;

    const sendHeartbeat = (progress = latestProgress): Promise<BuildQueueHeartbeatResult> => {
      let resolveResult!: (result: BuildQueueHeartbeatResult) => void;
      let rejectResult!: (error: unknown) => void;
      const result = new Promise<BuildQueueHeartbeatResult>((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
      });
      const operation = async (): Promise<void> => {
        const input: BuildQueueHeartbeatInput = {
          buildId: claim.buildId,
          attemptId: claim.attemptId,
          workerId: this.options.workerId,
          leaseToken: claim.leaseToken,
          leaseEpoch: claim.leaseEpoch,
          sequence: sequence++,
          now: this.now(),
          leaseSeconds: this.options.leaseSeconds,
          ...(progress ? { progress } : {}),
        };
        try {
          const response = await this.queue.heartbeat(input);
          if (
            !response.accepted ||
            response.leaseExpiresAt === null ||
            !Number.isFinite(response.leaseExpiresAt)
          ) {
            leaseLost = true;
            controller.abort(new BuildLeaseLostError());
            resolveResult(response);
            return;
          }
          if (response.cancelRequested) {
            cancelRequested = true;
            controller.abort(new BuildCancellationError());
          }
          resolveResult(response);
        } catch (error) {
          heartbeatError = error;
          leaseLost = true;
          controller.abort(new BuildLeaseLostError());
          rejectResult(error);
        }
      };
      heartbeatChain = heartbeatChain.then(operation, operation);
      return result;
    };

    const updateProgress = (progress: BuildProgress): void => {
      if (validProgress(progress)) latestProgress = progress;
    };

    const heartbeatTimer = setInterval(() => {
      if (heartbeatInFlight || controller.signal.aborted) return;
      heartbeatInFlight = true;
      void sendHeartbeat()
        .catch(() => undefined)
        .finally(() => {
          heartbeatInFlight = false;
        });
    }, this.options.heartbeatIntervalMs);
    heartbeatTimer.unref();

    const beforeEffect = async (): Promise<void> => {
      if (controller.signal.aborted) throw controller.signal.reason;
      const heartbeat = await sendHeartbeat({ stage: "preparing", percent: 0 });
      if (!heartbeat.accepted || heartbeat.leaseExpiresAt === null) {
        throw new BuildLeaseLostError();
      }
      if (heartbeat.cancelRequested || controller.signal.aborted)
        throw controller.signal.reason ?? new BuildCancellationError();
    };

    let candidate: BuildCandidate | undefined;
    let signedCandidate: SignedBuildCandidate | undefined;
    let executionError: unknown;
    try {
      await beforeEffect();
      const request: BuildExecutionRequest = {
        buildId: claim.buildId,
        buildKey: claim.buildKey,
        attemptId: claim.attemptId,
        attempt: claim.attempt,
        leaseEpoch: claim.leaseEpoch,
        input: claim.input,
        onProgress: updateProgress,
      };
      candidate = await this.provider.execute(request, controller.signal, beforeEffect);
      signedCandidate = await this.attestor.attest({
        buildKey: claim.buildKey,
        expected: claim.input,
        candidate,
        signal: controller.signal,
        beforeEffect,
      });
    } catch (error) {
      executionError = error;
    } finally {
      clearInterval(heartbeatTimer);
    }

    try {
      await heartbeatChain;
      if (heartbeatError || leaseLost) return;

      if (
        executionError !== undefined ||
        !candidate ||
        !signedCandidate ||
        controller.signal.aborted
      ) {
        if (controller.signal.reason instanceof BuildLeaseLostError) return;
        const failure =
          cancelRequested || controller.signal.aborted
            ? failureFor(new BuildCancellationError())
            : failureFor(executionError);
        await this.report(claim, sequence++, failure);
        return;
      }

      try {
        await beforeEffect();
      } catch (error) {
        if (leaseLost || controller.signal.reason instanceof BuildLeaseLostError) return;
        if (
          cancelRequested ||
          controller.signal.aborted ||
          error instanceof BuildCancellationError
        ) {
          await this.report(claim, sequence++, failureFor(new BuildCancellationError()));
          return;
        }
        throw error;
      }
      if (controller.signal.aborted) {
        if (controller.signal.reason instanceof BuildLeaseLostError) return;
        await this.report(claim, sequence++, failureFor(new BuildCancellationError()));
        return;
      }
      await this.report(claim, sequence++, { kind: "succeeded", ...signedCandidate });
    } finally {
      detachShutdown();
      if (this.currentAbort === controller) this.currentAbort = null;
    }
  }

  private async report(
    claim: BuildClaim,
    sequence: number,
    result: BuildQueueReportInput["result"],
  ): Promise<void> {
    await this.queue.report({
      buildId: claim.buildId,
      buildKey: claim.buildKey,
      attemptId: claim.attemptId,
      workerId: this.options.workerId,
      leaseToken: claim.leaseToken,
      leaseEpoch: claim.leaseEpoch,
      sequence,
      now: this.now(),
      result,
    });
  }
}

function linkAbort(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) return () => undefined;
  const abort = (): void => target.abort(source.reason ?? new BuildCancellationError());
  if (source.aborted) abort();
  else source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}
