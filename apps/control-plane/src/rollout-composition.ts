import { readOperatorAudit } from "./releases/operator-audit.js";
import type {
  ConfigurationService,
  ConfigurationStageReceipt,
} from "@praetorium/application/configurations";
import type { InstanceService } from "@praetorium/application/instances";
import type { OperationService } from "@praetorium/application/operations";
import {
  advanceStablePromotions,
  ServiceBackedDisposableCanary,
  createRegistryBackedReleaseVerifier,
  type CanaryConfigurationService,
  type CanaryInstanceService,
  type CanaryProvisionerObservationReader,
  type DisposableCanaryBinding,
  type ReleaseCandidate,
  type ReleaseCandidateManifest,
  type ReleaseClock,
  type ReleaseIdSource,
  type ReleasePromotionDeps,
  type RegistryBackedReleaseVerifierDeps,
} from "@praetorium/application/releases";
import {
  createStableRolloutPlanner,
  type CompositionProvider,
  type OperationObservation,
  type StableFollower,
  type StableRolloutDeps,
} from "@praetorium/application/rollouts";
import { D1StableFollowerRepository } from "./adapters/d1/stable-followers.js";
import {
  D1T11ReleaseRolloutStore,
  type CanaryHealthProgressState,
  type StagedRolloutActivator,
  type T11D1Database,
} from "./adapters/d1/t11-release-rollouts.js";
import { createOperatorReleaseAdmissionRoutes } from "./releases/operator-admission.js";
import { runStableReleaseWork } from "./scheduled.js";
import type { WorkNotificationDispatcher } from "./work-notification-scheduler.js";

export type T11RolloutCompositionDependencies = RegistryBackedReleaseVerifierDeps & {
  readonly db: T11D1Database;
  /** Stable follower plans use the currently promoted release only. */
  readonly configurations: Pick<
    ConfigurationService,
    "stage" | "findStageByIdempotency" | "activateStageUnderClusterFence"
  >;
  /** Canary plans may use the immutable candidate before it becomes stable. */
  readonly canaryConfigurations: Pick<ConfigurationService, "plan" | "findByIdempotency">;
  readonly instances: InstanceService;
  readonly operations: OperationService;
  readonly canaryBinding: DisposableCanaryBinding;
  /** Reads persisted provider observations; absence must remain unknown. */
  readonly canaryObservations: CanaryProvisionerObservationReader;
  readonly defaultClusterId: string;
  readonly clock: ReleaseClock;
  readonly ids: ReleaseIdSource;
  readonly workerId: string;
  readonly healthWindowMs?: number;
  readonly authorizeOperator: (headers: Headers) => Promise<{ readonly actorId: string } | null>;
  readonly requestId?: () => string;
  readonly notifyWorkAvailable?: WorkNotificationDispatcher;
};

/**
 * Composes T11 on the production D1 and application-service paths. Registry,
 * provenance, producer metadata and persisted canary observations are required
 * inputs so missing external evidence keeps admission or promotion closed.
 */
export function createT11RolloutComposition(deps: T11RolloutCompositionDependencies) {
  const verifier = createRegistryBackedReleaseVerifier(deps);
  const notifyWork = async (kind: "build" | "operation", instanceId?: string) => {
    try {
      await deps.notifyWorkAvailable?.(kind, instanceId);
    } catch {
      // A hint never changes the durable release or rollout result.
    }
  };
  const stagedActivator: StagedRolloutActivator = {
    findStageByIdempotency(repositoryId, idempotencyKey) {
      return deps.configurations.findStageByIdempotency(repositoryId, idempotencyKey);
    },
    async activateStageUnderClusterFence(input) {
      const receipt = await deps.configurations.activateStageUnderClusterFence(input);
      if (!receipt) return null;
      await notifyWork("operation");
      return {
        operationId: receipt.operationId,
        generation: receipt.generation,
      };
    },
  };
  const releases = new D1T11ReleaseRolloutStore(deps.db, stagedActivator);
  const followers = new D1StableFollowerRepository(deps.db, deps.defaultClusterId);
  const canaryConfigurations: CanaryConfigurationService = {
    async plan(input) {
      const receipt = await deps.canaryConfigurations.plan(input);
      if (receipt.revision.status === "building") await notifyWork("build");
      if (receipt.operation?.status === "pending") {
        await notifyWork("operation", receipt.operation.instanceId);
      }
      return receipt;
    },
    findByIdempotency(repositoryId, idempotencyKey) {
      return deps.canaryConfigurations.findByIdempotency(repositoryId, idempotencyKey);
    },
  };
  const canaryInstances: CanaryInstanceService = {
    getByRepositoryId(repositoryId) {
      return deps.instances.getByRepositoryId(repositoryId);
    },
    async requestDesiredState(input) {
      const receipt = await deps.instances.requestDesiredState(input);
      if (receipt.operation?.status === "pending") {
        await notifyWork("operation", receipt.operation.instanceId);
      }
      return receipt;
    },
  };
  const canary = new ServiceBackedDisposableCanary({
    binding: deps.canaryBinding,
    instances: canaryInstances,
    configurations: canaryConfigurations,
    operations: {
      getById: (id) => deps.operations.getById(id),
      async findByIdempotency(input) {
        const row = await deps.db.prepare(
          `SELECT operation_id FROM operations
            WHERE idempotency_scope = ? AND idempotency_key = ? LIMIT 1`,
        ).bind(`repository:${input.repositoryId}`, input.idempotencyKey)
          .first<{ operation_id: string }>();
        return row ? deps.operations.getById(row.operation_id) : null;
      },
      async findCurrentSucceededStop(input) {
        const row = await deps.db.prepare(
          `SELECT stop.operation_id
             FROM logical_instances i
             JOIN repository_bindings b ON b.repository_id = i.repository_id
             JOIN operations stop ON stop.instance_id = i.instance_id
               AND stop.repository_id = i.repository_id
               AND stop.generation = i.generation
               AND stop.runtime_epoch = i.runtime_epoch
               AND stop.kind = 'stop' AND stop.status = 'succeeded'
           WHERE i.instance_id = ? AND i.repository_id = ?
             AND i.desired_state = 'stopped'
             AND i.observed_state IN ('stopped', 'absent')
             AND i.observed_generation = i.generation
             AND i.observed_runtime_epoch = i.runtime_epoch
             AND b.suspended = 0
             AND b.authorization_revision = (
               SELECT started.authorization_revision FROM operations started
                WHERE started.operation_id = ? AND started.instance_id = i.instance_id
                  AND started.repository_id = i.repository_id
             )
             AND NOT EXISTS (
               SELECT 1 FROM operations active
                WHERE active.instance_id = i.instance_id
                  AND active.generation = i.generation
                  AND active.status IN ('pending', 'claimed', 'running')
             )
           ORDER BY stop.updated_at DESC, stop.operation_id DESC LIMIT 1`,
        ).bind(input.instanceId, input.repositoryId, input.startedOperationId)
          .first<{ operation_id: string }>();
        if (!row) return null;
        const operation = await deps.operations.getById(row.operation_id);
        return operation?.instanceId === input.instanceId &&
          operation.repositoryId === input.repositoryId
          ? operation
          : null;
      },
      async findSucceededStop(input) {
        const row = await deps.db.prepare(
          `SELECT operation_id FROM operations WHERE instance_id = ? AND repository_id = ?
             AND generation = ? AND runtime_epoch = ? AND kind = 'stop' AND status = 'succeeded'
           ORDER BY updated_at DESC, operation_id DESC LIMIT 1`,
        ).bind(input.instanceId, input.repositoryId, input.generation, input.runtimeEpoch)
          .first<{ operation_id: string }>();
        if (!row) return null;
        const operation = await deps.operations.getById(row.operation_id);
        return operation?.instanceId === input.instanceId && operation.repositoryId === input.repositoryId
          ? operation : null;
      },
    },
    observations: deps.canaryObservations,
    now: () => deps.clock.nowMs(),
    ...(deps.requestId ? { newRequestId: deps.requestId } : {}),
  });

  const stableComposition = createStableFollowerComposition(
    deps.configurations,
    deps.clock,
    notifyWork,
  );
  const rolloutDependencies: StableRolloutDeps = {
    releases,
    followers,
    rollouts: releases,
    composition: stableComposition,
    operations: { observe: (operationId) => observeOperation(deps.operations, operationId) },
    clock: deps.clock,
    workerId: deps.workerId,
  };
  const promotions = {
    releases,
    admission: {
      async verify(candidate: ReleaseCandidate) {
        return verifier.verify(toManifest(candidate));
      },
    },
    canaryComposition: canary,
    canaryRuntime: canary,
    rolloutPlanner: createStableRolloutPlanner(rolloutDependencies),
    clock: deps.clock,
    workerId: deps.workerId,
    ...(deps.healthWindowMs === undefined ? {} : { healthWindowMs: deps.healthWindowMs }),
    notifyCanaryHealthScheduleAvailable: (instanceId: string) =>
      notifyWork("operation", instanceId),
  };
  const scheduled = { promotions, rollouts: rolloutDependencies };
  const progressCanaryHealth = (operationId: string) => {
    const healthProgressWorkerId = `${deps.workerId}:canary-health:${crypto.randomUUID()}`;
    return progressCanaryHealthAfterEvidence({
      findReleaseId: () => releases.findCanaryReleaseId(operationId),
      prepare: () => releases.prepareCanaryHealthProgress({ operationId, now: deps.clock.nowMs() }),
      advance: (releaseId) =>
        advanceCanaryStages(
          { ...promotions, workerId: healthProgressWorkerId },
          releaseId,
          3,
        ),
    });
  };
  const progressCanaryStop = async (operationId: string) => {
    const releaseId = await releases.wakeCanaryCleanupAfterStop(
      operationId,
      deps.clock.nowMs(),
    );
    if (!releaseId) return;
    const stopProgressWorkerId = `${deps.workerId}:canary-stop:${crypto.randomUUID()}`;
    await advanceCanaryStages(
      { ...promotions, workerId: stopProgressWorkerId },
      releaseId,
      2,
    );
  };
  const operatorReleaseAdmission = createOperatorReleaseAdmissionRoutes({
    releases,
    registry: deps.registry,
    provenance: deps.provenance,
    producerMetadata: deps.producerMetadata,
    clock: deps.clock,
    ids: deps.ids,
    authorize: deps.authorizeOperator,
    stableChannel: () => releases.getStableChannel(),
    listAuditPage: (query) => readOperatorAudit(deps.db, query),
    skipCanaryWait: {
      replay: command => releases.findCanaryWaitSkip(command),
      execute: command => releases.skipCanaryWait(command),
    },
    retry: {
      status: (releaseId) => releases.getReleaseRetryStatus(releaseId),
      replay: (command) => releases.findPreRuntimeCanaryRetry(command),
      execute: async (command) => {
        const retryStatus = await releases.getReleaseRetryStatus(command.releaseId);
        const result = retryStatus?.workflow.state === "rejected"
          ? await releases.retryFailedCanaryRuntime({ ...command, canary: deps.canaryBinding })
          : await releases.retryPreRuntimeCanaryBuild({ ...command, canary: deps.canaryBinding });
        if (result.kind === "accepted" && !result.duplicate) await notifyWork("build");
        return result;
      },
    },
    ...(deps.requestId ? { requestId: deps.requestId } : {}),
    afterAdmitted: (candidate, context) => {
      context.waitUntil((async () => {
        const status = await releases.getReleaseRetryStatus(candidate.id);
        if (status?.build?.status === "succeeded") {
          await releases.wakeSuccessfulCanaryBuild({
            buildId: status.build.id, binding: deps.canaryBinding, now: deps.clock.nowMs(),
          });
        }
        await runStableReleaseWork(scheduled, { promotionPasses: 2 });
      })());
    },
  });

  return {
    releases,
    followers,
    scheduled,
    getCanaryHealthSchedule: (input: Parameters<typeof releases.getCanaryHealthSchedule>[0]) =>
      releases.getCanaryHealthSchedule(input),
    progressCanaryHealth,
    progressCanaryStop,
    afterAcceptedCanaryBuild: async (buildId: string) => {
      const releaseId = await releases.wakeSuccessfulCanaryBuild({
        buildId,
        binding: deps.canaryBinding,
        now: deps.clock.nowMs(),
      });
      if (!releaseId) return;
      const completionWorkerId = `${deps.workerId}:build-completion:${crypto.randomUUID()}`;
      const completionPromotions = { ...promotions, workerId: completionWorkerId };
      for (let pass = 0; pass < 2; pass += 1) {
        const result = await advanceStablePromotions(completionPromotions, {
          limit: 1,
          releaseId,
        });
        if (result.claimed === 0) return;
      }
    },
    operatorReleaseAdmission,
  };
}

async function advanceCanaryStages(
  promotions: ReleasePromotionDeps,
  releaseId: string,
  maximumStages: number,
): Promise<number> {
  let claimed = 0;
  for (let stage = 0; stage < maximumStages; stage += 1) {
    const batch = await advanceStablePromotions(promotions, { limit: 1, releaseId });
    claimed += batch.claimed;
    if (batch.claimed === 0 || batch.advanced === 0) break;
  }
  return claimed;
}

const CANARY_HEALTH_PROGRESS_TIMEOUT_MS = 15_000;
const CANARY_HEALTH_PROGRESS_MAX_ATTEMPTS = 8;
const CANARY_HEALTH_PROGRESS_RETRY_DELAYS_MS = [200, 400, 800, 1_600, 3_200] as const;

/** Retries fresh canary evidence while a concurrent rollout lease is settling. */
export async function progressCanaryHealthAfterEvidence(input: {
  readonly findReleaseId: () => Promise<string | null>;
  readonly prepare: () => Promise<CanaryHealthProgressState>;
  readonly advance: (releaseId: string) => Promise<number>;
  readonly monotonicNow?: () => number;
  readonly wait?: (milliseconds: number) => Promise<void>;
}): Promise<void> {
  const releaseId = await input.findReleaseId();
  if (!releaseId) return;

  const monotonicNow = input.monotonicNow ?? Date.now;
  const wait =
    input.wait ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const startedAt = monotonicNow();
  for (let attempt = 0; attempt < CANARY_HEALTH_PROGRESS_MAX_ATTEMPTS; attempt += 1) {
    if (monotonicNow() - startedAt >= CANARY_HEALTH_PROGRESS_TIMEOUT_MS) return;
    const state = await input.prepare();
    if (state.kind === "inactive" || state.kind === "consumed") return;
    if (state.kind === "due" && (await input.advance(releaseId)) > 0) return;

    const elapsed = monotonicNow() - startedAt;
    const remaining = CANARY_HEALTH_PROGRESS_TIMEOUT_MS - elapsed;
    if (attempt + 1 >= CANARY_HEALTH_PROGRESS_MAX_ATTEMPTS || remaining <= 0) return;
    const delay =
      CANARY_HEALTH_PROGRESS_RETRY_DELAYS_MS[
        Math.min(attempt, CANARY_HEALTH_PROGRESS_RETRY_DELAYS_MS.length - 1)
      ] ?? 3_200;
    await wait(Math.min(delay, remaining));
  }
}

function createStableFollowerComposition(
  configurations: T11RolloutCompositionDependencies["configurations"],
  clock: ReleaseClock,
  notifyWork: (kind: "build" | "operation", instanceId?: string) => Promise<void>,
): CompositionProvider {
  return {
    async compose({ release, follower, idempotencyKey }) {
      const receipt = await configurations.stage({
        repositoryId: follower.repositoryId,
        bindingEpoch: follower.bindingEpoch,
        authorizationRevision: follower.authorizationRevision,
        instanceId: follower.instanceId,
        expectedGeneration: follower.generation,
        selection: {
          releaseId: release.id,
          requestedModules: [...follower.selectedModuleIds],
          resourceProfileId: follower.resourceProfileId,
          policy: "stable",
        },
        actorId: "system:stable-release",
        idempotencyKey,
        requestId: idempotencyKey,
        now: clock.nowMs(),
      });
      if (!stageMatches(receipt, release, follower)) {
        return { kind: "failed", code: "staged_configuration_snapshot_mismatch", retryable: false };
      }

      if (receipt.stage.status !== "staged") {
        return { kind: "failed", code: "staged_configuration_not_active", retryable: false };
      }
      if (receipt.build.status === "pending") await notifyWork("build");
      if (receipt.build.status === "failed" || receipt.build.status === "cancelled") {
        return {
          kind: "failed",
          code: receipt.build.errorCode ?? "stable_rollout_build_failed",
          retryable: false,
        };
      }
      if (receipt.build.status !== "succeeded") {
        return {
          kind: "pending",
          buildKey: receipt.stage.buildKey,
          buildId: receipt.stage.buildId,
          retryAt: clock.nowMs() + 5 * 60 * 1_000,
        };
      }
      if (
        !receipt.build.artifactDigest ||
        !/^sha256:[a-f0-9]{64}$/u.test(receipt.build.artifactDigest)
      ) {
        return { kind: "failed", code: "stable_rollout_artifact_missing", retryable: false };
      }
      return {
        kind: "ready",
        buildKey: receipt.stage.buildKey,
        buildId: receipt.stage.buildId,
        artifactDigest: receipt.build.artifactDigest,
      };
    },
  };
}

function stageMatches(
  receipt: ConfigurationStageReceipt,
  release: ReleaseCandidate,
  follower: StableFollower,
): boolean {
  const { stage, build } = receipt;
  const requested = [...stage.selection.requestedModules].sort();
  const expectedModules = [...follower.selectedModuleIds].sort();
  const modules = new Map(release.catalog.modules.map((module) => [module.id, module]));
  const profile = release.catalog.resourceProfiles.find(
    ({ id }) => id === follower.resourceProfileId,
  );
  const resolvedMatchesCatalog = stage.buildInput.resolvedModules.every((resolved) => {
    const module = modules.get(resolved.id);
    return (
      module !== undefined &&
      module.version === resolved.version &&
      module.artifactDigest === resolved.artifactDigest
    );
  });
  const resolvedModuleIds = new Set(stage.buildInput.resolvedModules.map(({ id }) => id));
  const resolvedClosureMatchesCatalog = matchesResolvedModuleClosure(
    expectedModules,
    release.catalog.modules,
    stage.buildInput.resolvedModules,
  );
  return (
    stage.repositoryId === follower.repositoryId &&
    stage.instanceId === follower.instanceId &&
    stage.bindingEpoch === follower.bindingEpoch &&
    stage.authorizationRevision === follower.authorizationRevision &&
    stage.expectedGeneration === follower.generation &&
    stage.expectedRuntimeEpoch === follower.runtimeEpoch &&
    stage.expectedPolicy === "stable" &&
    stage.expectedDesiredState === "running" &&
    stage.selection.releaseId === release.id &&
    stage.selection.policy === "stable" &&
    stage.selection.resourceProfileId === follower.resourceProfileId &&
    requested.length === expectedModules.length &&
    requested.every((module, index) => module === expectedModules[index]) &&
    canonicalJson(stage.buildInput.requestedModules) === canonicalJson(expectedModules) &&
    stage.buildKey === build.buildKey &&
    stage.buildId === build.buildId &&
    stage.buildInput.contractVersion === release.catalog.contractVersion &&
    stage.buildInput.producerRevision === release.catalog.producerRevision &&
    stage.buildInput.runtimeBaseDigest === release.imageDigest &&
    stage.buildInput.buildKitDigest === release.catalog.buildKitDigest &&
    stage.buildInput.recipeDigest === release.catalog.recipeDigest &&
    stage.buildInput.sourceDigest === release.catalog.sourceDigest &&
    stage.buildInput.lockDigest === release.catalog.lockDigest &&
    release.catalog.supportedPlatforms.includes(stage.buildInput.platform) &&
    expectedModules.every((module) => modules.has(module)) &&
    expectedModules.every((module) => resolvedModuleIds.has(module)) &&
    resolvedClosureMatchesCatalog &&
    resolvedMatchesCatalog &&
    profile !== undefined &&
    stage.resources.cpuMilli === profile.cpuMilli &&
    stage.resources.memoryMiB === profile.memoryMiB &&
    stage.resources.ephemeralStorageMiB === profile.ephemeralStorageMiB &&
    canonicalJson(stage.runtimeMetadata) === canonicalJson(release.runtimeMetadata) &&
    stage.buildInput.platform === follower.platform
  );
}

function matchesResolvedModuleClosure(
  selectedModuleIds: readonly string[],
  catalogModules: ReleaseCandidate["catalog"]["modules"],
  resolvedModules: ConfigurationStageReceipt["stage"]["buildInput"]["resolvedModules"],
): boolean {
  const byId = new Map(catalogModules.map((module) => [module.id, module]));
  const resolvedIds = new Set(resolvedModules.map(({ id }) => id));
  const closure = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string): boolean => {
    if (closure.has(id)) return true;
    const module = byId.get(id);
    if (!module || visiting.has(id)) return false;
    visiting.add(id);
    for (const dependency of module.requires) {
      if (!visit(dependency)) return false;
    }
    visiting.delete(id);
    closure.add(id);
    return true;
  };

  if (!selectedModuleIds.every(visit) || closure.size !== resolvedIds.size) return false;
  if ([...closure].some((id) => !resolvedIds.has(id))) return false;
  return [...closure].every((id) =>
    byId.get(id)!.conflicts.every((conflict) => !closure.has(conflict)),
  );
}

function toManifest(candidate: ReleaseCandidate): ReleaseCandidateManifest {
  return {
    schemaVersion: candidate.schemaVersion,
    version: candidate.version,
    imageRepository: candidate.imageRepository,
    catalog: candidate.catalog,
    runtimeMetadata: candidate.runtimeMetadata,
    signatureRef: candidate.signatureRef,
    provenanceRef: candidate.provenanceRef,
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value) ?? "null";
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

async function observeOperation(
  operations: OperationService,
  operationId: string,
): Promise<OperationObservation> {
  const operation = await operations.getById(operationId);
  if (!operation) return { operationId, status: "missing" };
  if (operation.status === "failed" || operation.status === "blocked") {
    const code =
      typeof operation.result?.code === "string"
        ? operation.result.code
        : "runtime_operation_failed";
    return { operationId, status: operation.status, code };
  }
  return { operationId, status: operation.status };
}
