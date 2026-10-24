import type { RuntimeMetadata } from "@praetorium/contracts";
import { CanaryCleanupEvidenceSchema, CanaryHealthEvidenceSchema } from "./model.js";
import type { ReleaseCandidate } from "./model.js";
import type { CanaryCompositionProvider, CanaryRuntimeProvider } from "./promotion.js";

export type DisposableCanaryBinding = {
  readonly repositoryId: number;
  readonly instanceId: string;
  readonly bindingEpoch: number;
  readonly authorizationRevision: number;
  readonly requestedModules: readonly string[];
  readonly resourceProfileId: string;
};

type CanaryOperation = {
  readonly id: string;
  readonly kind: "start" | "stop" | "redeploy" | "update";
  readonly status: "pending" | "claimed" | "running" | "succeeded" | "failed" | "blocked";
  readonly generation: number;
  readonly runtimeEpoch: number;
  readonly deploymentRevisionId: string | null;
  readonly result: Readonly<Record<string, unknown>> | null;
};

type CanaryInstance = {
  readonly instanceId: string;
  readonly repositoryId: number;
  readonly generation: number;
  readonly runtimeEpoch: number;
  readonly desiredState: "running" | "stopped";
  readonly observedState:
    | "absent"
    | "starting"
    | "ready"
    | "stopping"
    | "stopped"
    | "failed"
    | "unknown";
  readonly desiredRevisionId: string | null;
  readonly observedRevisionId: string | null;
  readonly observedRuntimeEpoch: number | null;
};

export type CanaryPlanReceipt = {
  readonly instance: CanaryInstance;
  readonly revision: {
    readonly revisionId: string;
    readonly generation: number;
    readonly status: "building" | "admitted" | "failed" | "superseded";
    readonly artifactDigest: string | null;
    readonly selection: {
      readonly releaseId: string;
      readonly requestedModules: readonly string[];
      readonly resourceProfileId: string;
      readonly policy: "stable" | "pinned";
    };
    readonly resources: object;
    readonly runtimeMetadata: RuntimeMetadata;
  };
  readonly operation: CanaryOperation | null;
  readonly buildId: string;
  readonly buildKey: string;
  readonly replayed: boolean;
};

/** Structural service shapes intentionally match the shared application services. */
export interface CanaryInstanceService {
  getByRepositoryId(repositoryId: number): Promise<{
    readonly binding: {
      readonly repositoryId: number;
      readonly instanceId: string;
      readonly bindingEpoch: number;
      readonly authorizationRevision: number;
      readonly suspended: boolean;
    };
    readonly instance: CanaryInstance;
  } | null>;
  requestDesiredState(input: {
    readonly repositoryId: number;
    readonly bindingEpoch: number;
    readonly authorizationRevision: number;
    readonly desiredState: "running" | "stopped";
    readonly actorId: string;
    readonly idempotencyKey: string;
    readonly requestId: string;
    readonly now: number;
    readonly expectedGeneration?: number;
    readonly forceNewRuntime?: boolean;
  }): Promise<{
    readonly instance: CanaryInstance;
    readonly operation: CanaryOperation | null;
  }>;
}

export interface CanaryConfigurationService {
  plan(input: {
    readonly repositoryId: number;
    readonly bindingEpoch: number;
    readonly authorizationRevision: number;
    readonly instanceId: string;
    readonly expectedGeneration: number;
    readonly selection: {
      readonly releaseId: string;
      readonly requestedModules: string[];
      readonly resourceProfileId: string;
      readonly policy: "pinned";
    };
    readonly actorId: string;
    readonly idempotencyKey: string;
    readonly requestId: string;
    readonly now: number;
  }): Promise<CanaryPlanReceipt>;
  findByIdempotency(
    repositoryId: number,
    idempotencyKey: string,
  ): Promise<CanaryPlanReceipt | null>;
}

export interface CanaryOperationService {
  getById(operationId: string): Promise<CanaryOperation | null>;
  findSucceededStop?(input: {
    readonly instanceId: string;
    readonly repositoryId: number;
    readonly generation: number;
    readonly runtimeEpoch: number;
  }): Promise<CanaryOperation | null>;
}

/** Reads observations already persisted by the provisioner; this is not a cluster client. */
export interface CanaryProvisionerObservationReader {
  latestHealth(input: {
    readonly instanceId: string;
    readonly repositoryId: number;
    readonly operationId: string;
  }): Promise<unknown | null>;
  writerAbsence(input: {
    readonly instanceId: string;
    readonly repositoryId: number;
    readonly retiredEpoch: number;
    readonly afterOperationId: string;
  }): Promise<unknown | null>;
}

export interface CanaryServiceAdapterOptions {
  readonly binding: DisposableCanaryBinding;
  readonly instances: CanaryInstanceService;
  readonly configurations: CanaryConfigurationService;
  readonly operations: CanaryOperationService;
  readonly observations: CanaryProvisionerObservationReader;
  readonly now: () => number;
  readonly newRequestId?: () => string;
}

/**
 * Production canary orchestration through normal application services. It only
 * reads provisioner evidence persisted in the control-plane store; provider
 * credentials and cluster side effects stay with the provisioner.
 */
export class ServiceBackedDisposableCanary
  implements CanaryCompositionProvider, CanaryRuntimeProvider
{
  private readonly actorId = "system:stable-release-canary";
  private readonly newRequestId: () => string;

  constructor(private readonly options: CanaryServiceAdapterOptions) {
    this.newRequestId = options.newRequestId ?? (() => crypto.randomUUID());
    const binding = options.binding;
    if (
      !Number.isSafeInteger(binding.repositoryId) ||
      binding.repositoryId <= 0 ||
      !Number.isSafeInteger(binding.bindingEpoch) ||
      binding.bindingEpoch < 0 ||
      !Number.isSafeInteger(binding.authorizationRevision) ||
      binding.authorizationRevision < 0 ||
      !binding.instanceId ||
      !binding.resourceProfileId ||
      new Set(binding.requestedModules).size !== binding.requestedModules.length
    ) {
      throw new TypeError("invalid disposable canary binding configuration");
    }
  }

  private async currentBinding() {
    const current = await this.options.instances.getByRepositoryId(
      this.options.binding.repositoryId,
    );
    if (
      !current ||
      current.binding.suspended ||
      current.binding.instanceId !== this.options.binding.instanceId ||
      current.binding.bindingEpoch !== this.options.binding.bindingEpoch ||
      current.binding.authorizationRevision !== this.options.binding.authorizationRevision ||
      current.instance.instanceId !== this.options.binding.instanceId ||
      current.instance.repositoryId !== this.options.binding.repositoryId
    ) {
      throw new Error("disposable canary repository binding changed or is unavailable");
    }
    return current;
  }

  private planKey(release: ReleaseCandidate): string {
    return `stable-canary-plan:${release.id}`;
  }

  private matchesPinnedSelection(receipt: CanaryPlanReceipt, releaseId: string): boolean {
    const selection = receipt.revision.selection;
    const requestedModules = selection.requestedModules;
    return (
      receipt.instance.instanceId === this.options.binding.instanceId &&
      selection.releaseId === releaseId &&
      selection.policy === "pinned" &&
      selection.resourceProfileId === this.options.binding.resourceProfileId &&
      Array.isArray(requestedModules) &&
      requestedModules.every((module): module is string => typeof module === "string") &&
      [...requestedModules].sort().join("\u0000") ===
        [...this.options.binding.requestedModules].sort().join("\u0000")
    );
  }

  private async findOrPlan(release: ReleaseCandidate): Promise<CanaryPlanReceipt> {
    const config = this.options.binding;
    await this.currentBinding();
    const key = this.planKey(release);
    const replay = await this.options.configurations.findByIdempotency(config.repositoryId, key);
    if (replay) {
      if (!this.matchesPinnedSelection(replay, release.id)) {
        throw new Error("canary plan idempotency receipt does not match its immutable candidate");
      }
      return replay;
    }
    const current = await this.currentBinding();
    const receipt = await this.options.configurations.plan({
      repositoryId: config.repositoryId,
      bindingEpoch: config.bindingEpoch,
      authorizationRevision: config.authorizationRevision,
      instanceId: config.instanceId,
      expectedGeneration: current.instance.generation,
      selection: {
        releaseId: release.id,
        requestedModules: [...config.requestedModules],
        resourceProfileId: config.resourceProfileId,
        policy: "pinned",
      },
      actorId: this.actorId,
      idempotencyKey: key,
      requestId: `t11-canary-plan:${release.id}`,
      now: this.options.now(),
    });
    if (!this.matchesPinnedSelection(receipt, release.id)) {
      throw new Error("configuration planner returned a canary revision for a different base");
    }
    return receipt;
  }

  async compose(input: { readonly release: ReleaseCandidate; readonly idempotencyKey: string }) {
    const receipt = await this.findOrPlan(input.release);
    if (receipt.revision.status === "failed" || receipt.revision.status === "superseded") {
      return {
        kind: "failed" as const,
        code:
          receipt.revision.status === "failed"
            ? "canary_build_failed"
            : "canary_revision_superseded",
        retryable: false,
      };
    }
    if (receipt.revision.status !== "admitted" || !receipt.revision.artifactDigest) {
      return {
        kind: "pending" as const,
        buildKey: receipt.buildKey,
        buildId: receipt.buildId,
        retryAt: this.options.now() + 5 * 60 * 1_000,
      };
    }
    return {
      kind: "ready" as const,
      buildKey: receipt.buildKey,
      buildId: receipt.buildId,
      artifactDigest: receipt.revision.artifactDigest,
      deploymentRevisionId: receipt.revision.revisionId,
    };
  }

  async ensureRunning(input: {
    readonly release: ReleaseCandidate;
    readonly artifactDigest: string;
    readonly idempotencyKey: string;
  }): Promise<{ readonly runtimeId: string; readonly operationId: string }> {
    const receipt = await this.findOrPlan(input.release);
    if (
      receipt.revision.status !== "admitted" ||
      receipt.revision.artifactDigest !== input.artifactDigest
    ) {
      throw new Error("canary revision is not admitted at the expected immutable digest");
    }
    const current = await this.currentBinding();
    let operation = receipt.operation;
    if (!operation || operation.deploymentRevisionId !== receipt.revision.revisionId) {
      const result = await this.options.instances.requestDesiredState({
        repositoryId: this.options.binding.repositoryId,
        bindingEpoch: this.options.binding.bindingEpoch,
        authorizationRevision: this.options.binding.authorizationRevision,
        desiredState: "running",
        actorId: this.actorId,
        idempotencyKey: input.idempotencyKey,
        requestId: `t11-canary-start:${input.release.id}`,
        now: this.options.now(),
        expectedGeneration: current.instance.generation,
        forceNewRuntime: true,
      });
      operation = result.operation;
    }
    if (
      !operation ||
      operation.deploymentRevisionId !== receipt.revision.revisionId ||
      operation.kind === "stop"
    ) {
      throw new Error("normal canary start did not create an operation for the pinned revision");
    }
    return { runtimeId: this.options.binding.instanceId, operationId: operation.id };
  }

  async observe(input: { readonly runtimeId: string; readonly operationId: string }) {
    if (input.runtimeId !== this.options.binding.instanceId) return { kind: "unknown" as const };
    const operation = await this.options.operations.getById(input.operationId);
    if (!operation) return { kind: "unknown" as const };
    if (operation.status === "failed" || operation.status === "blocked") {
      return { kind: "unhealthy" as const, code: "canary_operation_failed" };
    }
    if (operation.status !== "succeeded") return { kind: "unknown" as const };
    const evidence = await this.options.observations.latestHealth({
      instanceId: this.options.binding.instanceId,
      repositoryId: this.options.binding.repositoryId,
      operationId: input.operationId,
    });
    const parsed = CanaryHealthEvidenceSchema.safeParse(evidence);
    if (
      !parsed.success ||
      parsed.data.runtimeId !== input.runtimeId ||
      parsed.data.operationId !== input.operationId ||
      parsed.data.runtimeEpoch !== operation.runtimeEpoch ||
      parsed.data.source !== "runtime-provisioner-observation"
    ) {
      return { kind: "unknown" as const };
    }
    return { kind: "healthy" as const, evidence: parsed.data };
  }

  async stop(input: {
    readonly runtimeId: string;
    readonly startedOperationId: string;
    readonly idempotencyKey: string;
  }) {
    if (input.runtimeId !== this.options.binding.instanceId) return { kind: "pending" as const };
    await this.currentBinding();
    const result = await this.options.instances.requestDesiredState({
      repositoryId: this.options.binding.repositoryId,
      bindingEpoch: this.options.binding.bindingEpoch,
      authorizationRevision: this.options.binding.authorizationRevision,
      desiredState: "stopped",
      actorId: this.actorId,
      idempotencyKey: input.idempotencyKey,
      requestId: `t11-canary-stop:${input.startedOperationId}`,
      now: this.options.now(),
    });
    let stopOperation = result.operation;
    if (stopOperation) {
      if (stopOperation.kind !== "stop") return { kind: "pending" as const };
      const fresh = await this.options.operations.getById(stopOperation.id);
      if (fresh?.status === "blocked") {
        // A separately authorized retry keeps the original idempotency receipt.
        // Accept only its current-generation stop and independently verified census.
        if (result.instance.desiredState !== "stopped" || result.instance.observedState !== "stopped" ||
            result.instance.generation <= fresh.generation || result.instance.runtimeEpoch !== fresh.runtimeEpoch)
          return { kind: "blocked" as const };
        const recovered = await this.options.operations.findSucceededStop?.({
          instanceId: this.options.binding.instanceId,
          repositoryId: this.options.binding.repositoryId,
          generation: result.instance.generation,
          runtimeEpoch: result.instance.runtimeEpoch,
        });
        if (!recovered || recovered.kind !== "stop" || recovered.status !== "succeeded" ||
            recovered.generation !== result.instance.generation || recovered.runtimeEpoch !== fresh.runtimeEpoch ||
            recovered.deploymentRevisionId !== fresh.deploymentRevisionId)
          return { kind: "blocked" as const };
        stopOperation = recovered;
      } else if (!fresh || fresh.status !== "succeeded") return { kind: "pending" as const };
    } else if (
      result.instance.desiredState !== "stopped" ||
      result.instance.observedState !== "stopped"
    ) {
      return { kind: "pending" as const };
    }
    const retiredEpoch = result.instance.observedRuntimeEpoch;
    if (retiredEpoch === null || retiredEpoch <= 0) return { kind: "pending" as const };
    const proof = await this.options.observations.writerAbsence({
      instanceId: this.options.binding.instanceId,
      repositoryId: this.options.binding.repositoryId,
      retiredEpoch,
      afterOperationId: stopOperation?.id ?? input.startedOperationId,
    });
    const stopped = CanaryCleanupEvidenceSchema.safeParse({
      operationId: stopOperation?.id ?? input.startedOperationId,
      startedOperationId: input.startedOperationId,
      observedAt: this.options.now(),
      writerAbsence: proof,
    });
    if (
      !stopped.success ||
      stopped.data.writerAbsence.instanceId !== this.options.binding.instanceId ||
      stopped.data.writerAbsence.repositoryId !== this.options.binding.repositoryId ||
      stopped.data.writerAbsence.retiredEpoch !== retiredEpoch
    ) {
      return { kind: "pending" as const };
    }
    return { kind: "stopped" as const, evidence: stopped.data };
  }
}
