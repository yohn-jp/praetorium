import {
  advanceStablePromotions,
  discoverStableCandidates,
  RELEASE_DISCOVERY_INTERVAL_MS,
  type ReleasePromotionDeps,
} from "@praetorium/application/releases";
import { runStableRolloutBatch, type StableRolloutDeps } from "@praetorium/application/rollouts";

export const T11_SCHEDULED_INTERVAL_MS = RELEASE_DISCOVERY_INTERVAL_MS;

export interface ScheduledT11Dependencies {
  readonly promotions: ReleasePromotionDeps;
  readonly rollouts: StableRolloutDeps;
}

export type ScheduledT11Result = {
  readonly discovery: Awaited<ReturnType<typeof discoverStableCandidates>>;
  readonly promotions: Awaited<ReturnType<typeof advanceStablePromotions>>;
  readonly rollouts: Awaited<ReturnType<typeof runStableRolloutBatch>>;
};

export type ScheduledT11DisabledResult = { readonly releaseWork: "disabled" };

export async function runStableReleaseWork(deps: ScheduledT11Dependencies) {
  const runId = crypto.randomUUID();
  const promotions: ReleasePromotionDeps = {
    ...deps.promotions,
    workerId: `${deps.promotions.workerId}:${runId}`,
  };
  const rollouts: StableRolloutDeps = {
    ...deps.rollouts,
    workerId: `${deps.rollouts.workerId}:${runId}`,
  };

  const promotionsBatch = await advanceStablePromotions(promotions);
  const rolloutBatch = await runStableRolloutBatch(rollouts);
  return { promotions: promotionsBatch, rollouts: rolloutBatch };
}

/** Callable by Worker tests and the Control Plane composition root. */
export async function runScheduledT11(deps: ScheduledT11Dependencies): Promise<ScheduledT11Result> {
  const at = deps.promotions.clock.now();
  const discovery = await discoverStableCandidates(deps.promotions.releases, { at });
  return { discovery, ...(await runStableReleaseWork(deps)) };
}

export interface ScheduledController {
  readonly cron: string;
  readonly scheduledTime: number;
}

export interface ScheduledExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export function createScheduledHandler<Environment>(
  resolveDependencies: (
    environment: Environment,
  ) => Promise<ScheduledT11Dependencies> | ScheduledT11Dependencies,
): (
  controller: ScheduledController,
  environment: Environment,
  context: ScheduledExecutionContext,
) => Promise<ScheduledT11Result>;
export function createScheduledHandler<Environment>(
  resolveDependencies: (
    environment: Environment,
  ) => Promise<ScheduledT11Dependencies | null> | ScheduledT11Dependencies | null,
): (
  controller: ScheduledController,
  environment: Environment,
  context: ScheduledExecutionContext,
) => Promise<ScheduledT11Result | ScheduledT11DisabledResult>;
/** Cloudflare-compatible scheduled adapter, wired by the Worker composition root. */
export function createScheduledHandler<Environment>(
  resolveDependencies: (
    environment: Environment,
  ) =>
    | Promise<ScheduledT11Dependencies | null>
    | ScheduledT11Dependencies
    | null,
): (
  controller: ScheduledController,
  environment: Environment,
  context: ScheduledExecutionContext,
) => Promise<ScheduledT11Result | ScheduledT11DisabledResult> {
  return async (_controller, environment, context): Promise<
    ScheduledT11Result | ScheduledT11DisabledResult
  > => {
    const execution: Promise<ScheduledT11Result | ScheduledT11DisabledResult> = (async () => {
      const deps = await resolveDependencies(environment);
      return deps ? runScheduledT11(deps) : { releaseWork: "disabled" as const };
    })();
    context.waitUntil(execution);
    return execution;
  };
}
