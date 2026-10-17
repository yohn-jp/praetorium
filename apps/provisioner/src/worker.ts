import {
  type LifecycleExecutionContext,
  type LifecyclePhase,
  type LifecycleResult,
} from "@praetorium/application/lifecycle";
import { WorkAvailability } from "@praetorium/application";
import {
  OperationServiceHttpError,
  type ClaimedProvisionerOperation,
  type ProvisionerOperationService,
  type ProvisionerObservation,
  type ProvisionerTerminal,
} from "./operation-client.js";
import { ProvisionerMetrics } from "./metrics.js";

export interface ProvisionerLogger {
  info(event: string, fields?: Readonly<Record<string, string | number | boolean>>): void;
  warn(event: string, fields?: Readonly<Record<string, string | number | boolean>>): void;
}

export class JsonLogger implements ProvisionerLogger {
  info(event: string, fields: Readonly<Record<string, string | number | boolean>> = {}): void {
    this.write("info", event, fields);
  }

  warn(event: string, fields: Readonly<Record<string, string | number | boolean>> = {}): void {
    this.write("warn", event, fields);
  }

  private write(
    level: "info" | "warn",
    event: string,
    fields: Readonly<Record<string, string | number | boolean>>,
  ): void {
    const line = JSON.stringify({ level, event, ...fields, at: new Date().toISOString() });
    if (level === "warn") console.warn(line);
    else console.info(line);
  }
}

export interface ProvisionerOperationExecutor {
  execute(
    claim: ClaimedProvisionerOperation,
    context: LifecycleExecutionContext,
  ): Promise<LifecycleResult>;
}

export interface ProvisionerWorkerOptions {
  readonly operations: ProvisionerOperationService;
  readonly executor: ProvisionerOperationExecutor;
  readonly workerId: string;
  readonly clusterId: string;
  readonly leaseSeconds?: number;
  readonly maxConcurrency?: number;
  readonly workAvailability?: WorkAvailability;
  readonly recoveryIntervalMs?: number;
  readonly retryIntervalMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly now?: () => number;
  readonly logger?: ProvisionerLogger;
  readonly metrics?: ProvisionerMetrics;
  readonly onReadyChange?: (ready: boolean) => void;
}

const DEFAULT_LEASE_SECONDS = 30;
const DEFAULT_WORK_RECOVERY_INTERVAL_MS = 300_000;
const DEFAULT_RETRY_INTERVAL_MS = 5_000;
const DEFAULT_MAX_CONCURRENCY = 4;

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted)
    return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function linkAbort(parent: AbortSignal, child: AbortController): () => void {
  const abort = () => child.abort(parent.reason);
  if (parent.aborted) abort();
  else parent.addEventListener("abort", abort, { once: true });
  return () => parent.removeEventListener("abort", abort);
}

function record(error: unknown): string {
  if (error instanceof OperationServiceHttpError) return error.code;
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(error.name)) return error.name;
  return "provisioner_error";
}

function observationFor(
  claim: ClaimedProvisionerOperation,
  sequence: number,
  now: number,
  result?: LifecycleResult,
): ProvisionerObservation | null {
  if (result?.status !== "complete") return null;
  const operation = claim.operation;
  const reportedAt = new Date(now).toISOString();
  if (result.observed === null) {
    if (operation.kind !== "stop") return null;
    return {
      instanceId: operation.instanceId,
      repositoryId: operation.repositoryId,
      generation: operation.generation,
      runtimeEpoch: operation.runtimeEpoch,
      sequence,
      observedState: "stopped",
      observedArtifactDigest: null,
      observedRevisionId: null,
      reportedAt,
    };
  }
  const assignment = result.observed;
  const admittedTarget = claim.runtimeContext.target;
  if (
    operation.kind === "stop" ||
    admittedTarget === null ||
    assignment.instanceId !== operation.instanceId ||
    assignment.repositoryId !== operation.repositoryId ||
    assignment.generation !== operation.generation ||
    assignment.runtimeEpoch !== operation.runtimeEpoch ||
    assignment.deployment.revisionId !== admittedTarget.revisionId ||
    assignment.deployment.imageDigest !== admittedTarget.assignment.imageDigest
  )
    return null;
  return {
    instanceId: assignment.instanceId,
    repositoryId: assignment.repositoryId,
    generation: assignment.generation,
    runtimeEpoch: assignment.runtimeEpoch,
    sequence,
    observedState: "ready",
    observedArtifactDigest: assignment.deployment.imageDigest,
    observedRevisionId: assignment.deployment.revisionId,
    reportedAt,
  };
}

class SequencedLease {
  private sequence: number;
  private expiresAt: number;
  private lost = false;
  private stopped = false;
  private renewal: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sequenceQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly claim: ClaimedProvisionerOperation,
    private readonly operations: ProvisionerOperationService,
    private readonly workerId: string,
    private readonly operationController: AbortController,
    private readonly leaseSeconds: number,
    private readonly heartbeatIntervalMs: number,
    private readonly now: () => number,
    private readonly logger: ProvisionerLogger,
    private readonly metrics: ProvisionerMetrics,
  ) {
    this.sequence = claim.operation.reportSequence;
    this.expiresAt = claim.operation.leaseExpiresAt;
  }

  start(): void {
    this.schedule(this.heartbeatIntervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
  }

  assertOwned(): void {
    if (this.lost || this.operationController.signal.aborted || this.now() >= this.expiresAt) {
      this.markLost();
      throw new OperationServiceHttpError("operation_lease_lost", 409, false);
    }
  }

  async confirmOwned(): Promise<void> {
    this.assertOwned();
    if (this.renewal !== undefined) {
      await this.renewal;
    } else {
      const renewal = this.renewOwned();
      this.renewal = renewal;
      try {
        await renewal;
      } finally {
        if (this.renewal === renewal) this.renewal = undefined;
      }
    }
    this.assertOwned();
  }

  async report(
    claim: ClaimedProvisionerOperation,
    phase: LifecyclePhase,
    details?: Readonly<Record<string, string>>,
    result?: LifecycleResult,
    terminal?: ProvisionerTerminal,
  ): Promise<ProvisionerTerminal | undefined> {
    void details;
    await this.confirmOwned();
    return this.withSequence(async (sequence) => {
      const observation = observationFor(claim, sequence, this.now(), result);
      let effectiveTerminal = terminal;
      if (terminal === "succeeded" && observation === null) {
        effectiveTerminal = "blocked";
        this.logger.warn("operation_success_observation_mismatch", {
          operationId: claim.operation.id,
          phase,
        });
      }
      await this.operations.report({
        operationId: claim.operation.id,
        workerId: this.workerId,
        leaseToken: claim.operation.leaseToken,
        leaseEpoch: claim.operation.leaseEpoch,
        sequence,
        observation,
        ...(effectiveTerminal === undefined ? {} : { terminal: effectiveTerminal }),
        signal: this.operationController.signal,
      });
      return effectiveTerminal;
    });
  }

  private schedule(delayMs: number): void {
    if (this.stopped || this.operationController.signal.aborted) return;
    this.timer = setTimeout(() => {
      void this.confirmOwned().then(
        () => this.schedule(this.heartbeatIntervalMs),
        (error: unknown) => {
          if (this.stopped || this.operationController.signal.aborted) return;
          if (this.now() >= this.expiresAt || isLeaseConflict(error)) {
            this.markLost();
            return;
          }
          this.metrics.increment("lease_heartbeat_retry");
          this.logger.warn("operation_lease_renew_retry", {
            operationId: this.claim.operation.id,
            code: record(error),
          });
          this.schedule(Math.min(2_000, this.heartbeatIntervalMs));
        },
      );
    }, delayMs);
  }

  private async renewOwned(): Promise<void> {
    this.assertOwned();
    await this.withSequence(async (sequence) => {
      try {
        const renewed = await this.operations.heartbeat({
          operationId: this.claim.operation.id,
          workerId: this.workerId,
          leaseToken: this.claim.operation.leaseToken,
          leaseEpoch: this.claim.operation.leaseEpoch,
          sequence,
          leaseSeconds: this.leaseSeconds,
          signal: this.operationController.signal,
        });
        if (
          renewed.operation.id !== this.claim.operation.id ||
          renewed.operation.leaseEpoch !== this.claim.operation.leaseEpoch ||
          renewed.operation.leaseToken !== this.claim.operation.leaseToken ||
          !Number.isSafeInteger(renewed.leaseExpiresAt) ||
          renewed.leaseExpiresAt <= this.now()
        ) {
          this.markLost();
          throw new OperationServiceHttpError("operation_lease_lost", 409, false);
        }
        this.expiresAt = renewed.leaseExpiresAt;
      } catch (error) {
        if (isLeaseConflict(error)) this.markLost();
        throw error;
      }
    });
  }

  private async withSequence<T>(action: (sequence: number) => Promise<T>): Promise<T> {
    const previous = this.sequenceQueue;
    let release!: () => void;
    this.sequenceQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const sequence = ++this.sequence;
    try {
      return await action(sequence);
    } finally {
      release();
    }
  }

  private markLost(): void {
    if (this.lost) return;
    this.lost = true;
    this.metrics.increment("operation_lease_lost");
    this.logger.warn("operation_lease_lost", { operationId: this.claim.operation.id });
    this.operationController.abort(
      new OperationServiceHttpError("operation_lease_lost", 409, false),
    );
  }
}

function isLeaseConflict(error: unknown): boolean {
  return (
    error instanceof OperationServiceHttpError &&
    (error.status === 401 || error.status === 403 || error.status === 409)
  );
}

class InstanceLocks {
  private readonly locks = new Map<string, Promise<void>>();

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(key, current);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }
}

export class ProvisionerWorker {
  private readonly now: () => number;
  private readonly logger: ProvisionerLogger;
  private readonly metrics: ProvisionerMetrics;
  private readonly leaseSeconds: number;
  private readonly maxConcurrency: number;
  private readonly workAvailability: WorkAvailability;
  private readonly recoveryIntervalMs: number;
  private readonly retryIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly locks = new InstanceLocks();
  private readonly inFlight = new Map<string, Promise<void>>();
  private ready = false;

  constructor(private readonly options: ProvisionerWorkerOptions) {
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? new JsonLogger();
    this.metrics = options.metrics ?? new ProvisionerMetrics();
    this.leaseSeconds = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
    this.maxConcurrency = Math.max(
      1,
      Math.min(50, options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY),
    );
    this.workAvailability = options.workAvailability ?? new WorkAvailability();
    this.recoveryIntervalMs = options.recoveryIntervalMs ?? DEFAULT_WORK_RECOVERY_INTERVAL_MS;
    if (
      !Number.isSafeInteger(this.recoveryIntervalMs) ||
      this.recoveryIntervalMs < 1 ||
      this.recoveryIntervalMs > 3_600_000
    ) {
      throw new RangeError("work recovery interval must be between 1ms and one hour");
    }
    this.retryIntervalMs = Math.max(250, options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS);
    this.heartbeatIntervalMs = Math.max(
      1_000,
      Math.min(
        options.heartbeatIntervalMs ?? (this.leaseSeconds * 1_000) / 3,
        (this.leaseSeconds * 1_000) / 2,
      ),
    );
    if (!/^[A-Za-z0-9_.:-]{1,128}$/u.test(options.workerId))
      throw new TypeError("invalid provisioner worker ID");
    if (!/^[A-Za-z0-9_.:-]{1,128}$/u.test(options.clusterId))
      throw new TypeError("invalid runtime cluster ID");
    if (
      !Number.isSafeInteger(this.leaseSeconds) ||
      this.leaseSeconds < 5 ||
      this.leaseSeconds > 300
    ) {
      throw new RangeError("lease duration must be between 5 and 300 seconds");
    }
  }

  get isReady(): boolean {
    return this.ready;
  }

  async run(signal: AbortSignal): Promise<void> {
    let retryMs = DEFAULT_RETRY_INTERVAL_MS;
    while (!signal.aborted) {
      if (this.inFlight.size >= this.maxConcurrency) {
        await this.workAvailability.wait(signal, this.recoveryIntervalMs);
        continue;
      }
      try {
        const claim = await this.options.operations.claimNext({
          workerId: this.options.workerId,
          clusterId: this.options.clusterId,
          leaseSeconds: this.leaseSeconds,
          signal,
        });
        retryMs = DEFAULT_RETRY_INTERVAL_MS;
        this.setReady(true);
        if (claim === null) {
          await this.workAvailability.wait(signal, this.recoveryIntervalMs);
          continue;
        }
        this.metrics.increment("operation_claimed");
        const task = this.runClaim(claim, signal)
          .catch((error: unknown) => {
            this.metrics.increment("operation_executor_error");
            this.logger.warn("operation_worker_error", {
              operationId: claim.operation.id,
              code: record(error),
            });
          })
          .finally(() => {
            this.inFlight.delete(claim.operation.id);
            this.metrics.changeInFlight(-1);
            this.workAvailability.notify();
          });
        this.inFlight.set(claim.operation.id, task);
        this.metrics.changeInFlight(1);
      } catch (error) {
        if (signal.aborted) break;
        this.setReady(false);
        this.metrics.increment("operation_service_error");
        this.logger.warn("operation_claim_failed", { code: record(error) });
        await this.workAvailability.wait(signal, retryMs);
        retryMs = Math.min(30_000, Math.ceil(retryMs * 1.8));
      }
    }
    this.setReady(false);
    await Promise.allSettled(this.inFlight.values());
  }

  private setReady(ready: boolean): void {
    if (this.ready === ready) return;
    this.ready = ready;
    this.metrics.setReady(ready);
    this.options.onReadyChange?.(ready);
  }

  private async runClaim(
    claim: ClaimedProvisionerOperation,
    parentSignal: AbortSignal,
  ): Promise<void> {
    const operationController = new AbortController();
    const unlink = linkAbort(parentSignal, operationController);
    const lease = new SequencedLease(
      claim,
      this.options.operations,
      this.options.workerId,
      operationController,
      this.leaseSeconds,
      this.heartbeatIntervalMs,
      this.now,
      this.logger,
      this.metrics,
    );
    lease.start();
    const context: LifecycleExecutionContext = {
      signal: operationController.signal,
      assertLease: () => lease.confirmOwned(),
      report: async (phase, details) => {
        await lease.report(claim, phase, details);
      },
    };
    try {
      await this.locks.run(claim.operation.instanceId, async () => {
        while (!operationController.signal.aborted) {
          await lease.confirmOwned();
          const result = await this.options.executor.execute(claim, context);
          if (result.status === "waiting") {
            this.metrics.increment("operation_waiting");
            await delay(this.retryIntervalMs, operationController.signal);
            continue;
          }
          if (result.status === "complete") {
            const terminal = await lease.report(claim, "complete", undefined, result, "succeeded");
            this.metrics.increment(
              terminal === "succeeded" ? "operation_succeeded" : "operation_blocked",
            );
          } else if (result.status === "failed") {
            await lease.report(claim, "failed", undefined, result, "failed");
            this.metrics.increment("operation_failed");
          } else if (result.status === "blocked") {
            await lease.report(claim, "blocked", undefined, result, "blocked");
            this.metrics.increment("operation_blocked");
          } else {
            await lease.report(claim, "unknown", undefined, result);
            this.metrics.increment("operation_unknown");
          }
          return;
        }
      });
    } catch (error) {
      if (!parentSignal.aborted && !operationController.signal.aborted && !isLeaseConflict(error)) {
        this.metrics.increment("operation_recovery_required");
        this.logger.warn("operation_interrupted_for_recovery", {
          operationId: claim.operation.id,
          code: record(error),
        });
      }
    } finally {
      lease.stop();
      operationController.abort();
      unlink();
    }
  }
}
