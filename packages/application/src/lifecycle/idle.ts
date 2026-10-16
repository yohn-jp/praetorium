import type { IdleObservation, IdleObservationProvider, IdleOperationFactory } from "./ports.js";

export const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60_000;

export type IdleDecision =
  | { readonly status: "not-idle"; readonly reason: string }
  | { readonly status: "scheduled"; readonly operationId: string; readonly observation: IdleObservation };

export interface IdleLifecycleOptions {
  readonly observations: IdleObservationProvider;
  readonly operations: IdleOperationFactory;
  readonly idleTimeoutMs?: number;
  readonly now?: () => number;
}

export function validateIdleTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_IDLE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1) {
    throw new RangeError("idle timeout must be a positive integer number of milliseconds");
  }
  return timeout;
}

/**
 * The producer's meaningful-activity clock is authoritative. Health checks,
 * status polling and provisioner heartbeats do not update it.
 */
export class IdleLifecycle {
  private readonly idleTimeoutMs: number;
  private readonly now: () => number;

  constructor(private readonly options: IdleLifecycleOptions) {
    this.idleTimeoutMs = validateIdleTimeout(options.idleTimeoutMs);
    this.now = options.now ?? Date.now;
  }

  async evaluate(instanceId: string, signal?: AbortSignal): Promise<IdleDecision> {
    const observation = await this.options.observations.observe(instanceId, signal);
    if (observation.intendedStopped) return { status: "not-idle", reason: "already_stopped_by_request" };
    if (observation.current === null) return { status: "not-idle", reason: "no_current_runtime" };
    if (
      observation.current.instanceId !== observation.instanceId ||
      observation.current.repositoryId !== observation.repositoryId
    ) return { status: "not-idle", reason: "runtime_identity_mismatch" };
    if (observation.runtimeState !== "running") {
      return { status: "not-idle", reason: "runtime_not_confirmed_running" };
    }
    if (!validCount(observation.activeRequests) || !validCount(observation.activeJobs)) {
      return { status: "not-idle", reason: "activity_counts_invalid" };
    }
    if (observation.activeRequests > 0 || observation.activeJobs > 0 || observation.activeMutation) {
      return { status: "not-idle", reason: "authenticated_work_active" };
    }
    if (observation.lastMeaningfulActivityAt === null) {
      return { status: "not-idle", reason: "activity_time_unknown" };
    }

    const lastActivity = Date.parse(observation.lastMeaningfulActivityAt);
    const currentTime = this.now();
    if (!Number.isFinite(lastActivity) || lastActivity > currentTime) {
      return { status: "not-idle", reason: "activity_time_invalid" };
    }
    if (currentTime - lastActivity < this.idleTimeoutMs) {
      return { status: "not-idle", reason: "idle_timeout_not_reached" };
    }

    const operationId = await this.options.operations.createIdleStop(observation);
    return { status: "scheduled", operationId, observation };
  }
}

function validCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
