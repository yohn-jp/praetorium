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
  readonly instanceId: string;
  readonly repositoryId: number;
  readonly kind: "start" | "stop" | "redeploy" | "update";
  readonly status: "pending" | "claimed" | "running" | "succeeded" | "failed" | "blocked";
  readonly generation: number;
  readonly runtimeEpoch: number;
  readonly deploymentRevisionId: string | null;
  readonly idempotencyKey?: string;
  readonly checkpoint?: Readonly<Record<string, unknown>> | null;
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
  readonly desiredArtifactDigest?: string | null;
  readonly observedRevisionId: string | null;
  readonly observedRuntimeEpoch: number | null;
};

function ownsCurrentCanaryTarget(
  operation: CanaryOperation,
  instance: CanaryInstance,
  binding: DisposableCanaryBinding,
  revisionId: string,
): boolean {
  return (
    operation.instanceId === binding.instanceId &&
    operation.repositoryId === binding.repositoryId &&
    operation.kind !== "stop" &&
    operation.deploymentRevisionId === revisionId &&
    operation.generation === instance.generation &&
    operation.runtimeEpoch === instance.runtimeEpoch &&
    instance.instanceId === binding.instanceId &&
    instance.repositoryId === binding.repositoryId &&
    instance.desiredState === "running" &&
    instance.desiredRevisionId === revisionId
  );
}

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
  findByIdempotency?(input: {
    readonly repositoryId: number;
    readonly idempotencyKey: string;
  }): Promise<CanaryOperation | null>;
  /** Read-only canonical stop lookup; returns only the current stopped tuple without active work. */
  findCurrentSucceededStop?(input: {
    readonly instanceId: string;
    readonly repositoryId: number;
    readonly startedOperationId: string;
  }): Promise<CanaryOperation | null>;
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
    readonly retiredEpoch: number | null;
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
    let current = await this.currentBinding();
    let operation = receipt.operation
      ? await this.options.operations.getById(receipt.operation.id)
      : null;
    if (receipt.operation && operation && ownsCurrentCanaryTarget(
      operation,
      current.instance,
      this.options.binding,
      receipt.revision.revisionId,
    )) {
      return { runtimeId: this.options.binding.instanceId, operationId: operation.id };
    }
    if (current.instance.desiredRevisionId !== receipt.revision.revisionId) {
      throw new Error("canary revision no longer owns the current runtime assignment");
    }
    const recoveryGeneration = current.instance.desiredState === "running"
      ? current.instance.generation - 1
      : current.instance.generation;
    const recoveryIdempotencyKey = `${input.idempotencyKey}:recovery:${recoveryGeneration}`;
    if (current.instance.desiredState === "running") {
      const accepted = await this.options.operations.findByIdempotency?.({
        repositoryId: this.options.binding.repositoryId,
        idempotencyKey: recoveryIdempotencyKey,
      });
      if (
        accepted &&
        accepted.idempotencyKey === recoveryIdempotencyKey &&
        accepted.deploymentRevisionId === receipt.revision.revisionId &&
        accepted.instanceId === this.options.binding.instanceId &&
        accepted.repositoryId === this.options.binding.repositoryId &&
        ownsCurrentCanaryTarget(
          accepted,
          current.instance,
          this.options.binding,
          receipt.revision.revisionId,
        ) &&
        current.instance.desiredArtifactDigest === input.artifactDigest
      ) {
        return { runtimeId: this.options.binding.instanceId, operationId: accepted.id };
      }
      throw new Error("canary assignment is running without this recovery request's operation");
    }
    if (current.instance.desiredState !== "stopped" ||
        (current.instance.observedState !== "stopped" && current.instance.observedState !== "absent")) {
      // A stale operation cannot be reused just because it was once linked to
      // this plan. A same-revision retry may restart only after a canonical stop
      // has actually removed the observed writer.
      throw new Error("canary start operation no longer owns the current runtime assignment");
    }
    if (!operation || !ownsCurrentCanaryTarget(
      operation,
      current.instance,
      this.options.binding,
      receipt.revision.revisionId,
    )) {
      const result = await this.options.instances.requestDesiredState({
        repositoryId: this.options.binding.repositoryId,
        bindingEpoch: this.options.binding.bindingEpoch,
        authorizationRevision: this.options.binding.authorizationRevision,
        desiredState: "running",
        actorId: this.actorId,
        idempotencyKey: recoveryIdempotencyKey,
        requestId: `t11-canary-start:${input.release.id}`,
        now: this.options.now(),
        expectedGeneration: current.instance.generation,
        forceNewRuntime: true,
      });
      operation = result.operation;
      current = await this.currentBinding();
      if (!operation || !ownsCurrentCanaryTarget(
        operation,
        current.instance,
        this.options.binding,
        receipt.revision.revisionId,
      )) {
        throw new Error("normal canary start did not create the current pinned runtime assignment");
      }
    }
    return { runtimeId: this.options.binding.instanceId, operationId: operation.id };
  }

  async observe(input: { readonly runtimeId: string; readonly operationId: string }) {
    const operation = await this.options.operations.getById(input.operationId);
    if (!operation) return { kind: "unknown" as const };
    if (
      operation.instanceId !== input.runtimeId ||
      operation.repositoryId !== this.options.binding.repositoryId ||
      operation.kind === "stop" ||
      input.runtimeId !== this.options.binding.instanceId
    ) {
      return { kind: "unhealthy" as const, code: "canary_assignment_superseded" };
    }
    let current: Awaited<ReturnType<CanaryInstanceService["getByRepositoryId"]>>;
    try {
      current = await this.options.instances.getByRepositoryId(this.options.binding.repositoryId);
    } catch {
      return { kind: "unknown" as const };
    }
    if (
      !current ||
      current.binding.suspended ||
      current.binding.instanceId !== this.options.binding.instanceId ||
      current.binding.bindingEpoch !== this.options.binding.bindingEpoch ||
      current.binding.authorizationRevision !== this.options.binding.authorizationRevision ||
      current.instance.instanceId !== this.options.binding.instanceId ||
      current.instance.repositoryId !== this.options.binding.repositoryId ||
      !ownsCurrentCanaryTarget(
        operation,
        current.instance,
        this.options.binding,
        operation.deploymentRevisionId ?? "",
      )
    ) {
      // A stale operation cannot supply health for the currently selected
      // desired assignment. Reject it and let canonical cleanup verify stop.
      return { kind: "unhealthy" as const, code: "canary_assignment_superseded" };
    }
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
    readonly allowExistingStopRecovery?: boolean;
  }) {
    const startedOperation = await this.options.operations.getById(input.startedOperationId);
    if (!startedOperation || !startedOperation.deploymentRevisionId ||
        startedOperation.kind === "stop" ||
        startedOperation.instanceId !== input.runtimeId ||
        !Number.isSafeInteger(startedOperation.repositoryId) ||
        startedOperation.repositoryId <= 0) {
      return { kind: "blocked" as const };
    }
    if (input.allowExistingStopRecovery === true) {
      const readOnlyStop = await this.options.operations.findCurrentSucceededStop?.({
        instanceId: startedOperation.instanceId,
        repositoryId: startedOperation.repositoryId,
        startedOperationId: startedOperation.id,
      });
      if (
        readOnlyStop &&
        readOnlyStop.kind === "stop" &&
        readOnlyStop.status === "succeeded" &&
        readOnlyStop.instanceId === startedOperation.instanceId &&
        readOnlyStop.repositoryId === startedOperation.repositoryId &&
        readOnlyStop.generation > startedOperation.generation &&
        readOnlyStop.runtimeEpoch >= startedOperation.runtimeEpoch
      ) {
        const stopProof = persistedStopWriterAbsence(readOnlyStop);
        const retiredEpoch = stopProof?.retiredRuntimeEpoch;
        if (
          !(retiredEpoch === null ||
            (typeof retiredEpoch === "number" && Number.isSafeInteger(retiredEpoch) &&
              retiredEpoch >= 0 && retiredEpoch <= readOnlyStop.runtimeEpoch))
        ) {
          return { kind: "blocked" as const };
        }
        const proof = await this.options.observations.writerAbsence({
          instanceId: startedOperation.instanceId,
          repositoryId: startedOperation.repositoryId,
          retiredEpoch,
          afterOperationId: readOnlyStop.id,
        });
        const observedAt = this.options.now();
        const stopped = CanaryCleanupEvidenceSchema.safeParse({
          operationId: readOnlyStop.id,
          startedOperationId: startedOperation.id,
          observedAt,
          writerAbsence: proof,
        });
        const confirmed = await this.options.operations.findCurrentSucceededStop?.({
          instanceId: startedOperation.instanceId,
          repositoryId: startedOperation.repositoryId,
          startedOperationId: startedOperation.id,
        });
        const confirmedAt = this.options.now();
        if (
          stopped.success &&
          stopped.data.writerAbsence.instanceId === startedOperation.instanceId &&
          stopped.data.writerAbsence.repositoryId === startedOperation.repositoryId &&
          stopped.data.writerAbsence.retiredEpoch === retiredEpoch &&
          stopped.data.writerAbsence.remainingWriters === 0 &&
          stopped.data.writerAbsence.censusObservedAt <= observedAt &&
          observedAt - stopped.data.writerAbsence.censusObservedAt <= 10 * 60_000 &&
          confirmed?.id === readOnlyStop.id &&
          confirmed.generation === readOnlyStop.generation &&
          confirmed.runtimeEpoch === readOnlyStop.runtimeEpoch &&
          confirmed.status === "succeeded" &&
          persistedStopWriterAbsence(confirmed)?.retiredRuntimeEpoch === retiredEpoch &&
          confirmedAt >= stopped.data.writerAbsence.censusObservedAt &&
          confirmedAt - stopped.data.writerAbsence.censusObservedAt <= 10 * 60_000
        ) {
          return { kind: "stopped" as const, evidence: stopped.data };
        }
      }
      if (readOnlyStop) {
        // A succeeded stop with missing or changed proof is not permission to
        // stop a replacement assignment, even when this operation is stale.
        return { kind: "blocked" as const };
      }
      // Without an existing stop, continue through normal exact-current-tuple
      // ownership checks below so a failed current canary can be cleaned up.
    }
    if (
      input.runtimeId !== this.options.binding.instanceId ||
      startedOperation.instanceId !== this.options.binding.instanceId ||
      startedOperation.repositoryId !== this.options.binding.repositoryId
    ) return { kind: "blocked" as const };
    const current = await this.currentBinding();
    const alreadyStoppedGeneration = startedOperation.generation + 1;
    if (
      current.instance.observedState === "ready" &&
      current.instance.observedRuntimeEpoch !== startedOperation.runtimeEpoch
    ) {
      // A failed target may coexist with the retained healthy old writer. A
      // candidate cleanup cannot stop that writer without separate retirement
      // evidence for the target/old assignment.
      return { kind: "blocked" as const };
    }
    if (
      current.instance.generation !== startedOperation.generation ||
      current.instance.runtimeEpoch !== startedOperation.runtimeEpoch ||
      current.instance.desiredRevisionId !== startedOperation.deploymentRevisionId ||
      current.instance.desiredState !== "running"
    ) {
      // A delayed cleanup for an older release must never stop a newer canary.
      // Existing same-request stop replays are handled by requestDesiredState's
      // idempotency record and still have to match the exact stopped generation.
      if (
        current.instance.generation !== alreadyStoppedGeneration ||
        current.instance.runtimeEpoch !== startedOperation.runtimeEpoch ||
        current.instance.desiredRevisionId !== startedOperation.deploymentRevisionId ||
        current.instance.desiredState !== "stopped"
      ) return { kind: "blocked" as const };
    }
    const result = await this.options.instances.requestDesiredState({
      repositoryId: this.options.binding.repositoryId,
      bindingEpoch: this.options.binding.bindingEpoch,
      authorizationRevision: this.options.binding.authorizationRevision,
      desiredState: "stopped",
      actorId: this.actorId,
      idempotencyKey: input.idempotencyKey,
      requestId: `t11-canary-stop:${input.startedOperationId}`,
      now: this.options.now(),
      expectedGeneration: startedOperation.generation,
    });
    let stopOperation = result.operation;
    if (stopOperation) {
      if (stopOperation.kind !== "stop" ||
          stopOperation.instanceId !== this.options.binding.instanceId ||
          stopOperation.repositoryId !== this.options.binding.repositoryId ||
          stopOperation.generation !== alreadyStoppedGeneration ||
          stopOperation.runtimeEpoch !== startedOperation.runtimeEpoch ||
          stopOperation.deploymentRevisionId !== startedOperation.deploymentRevisionId) {
        return { kind: "pending" as const };
      }
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
    if (!stopOperation) return { kind: "pending" as const };
    const terminalStop = await this.options.operations.getById(stopOperation.id);
    if (!terminalStop || terminalStop.status !== "succeeded") return { kind: "pending" as const };
    stopOperation = terminalStop;
    const retiredEpoch = persistedStopWriterAbsence(stopOperation)?.retiredRuntimeEpoch;
    if (
      !(retiredEpoch === null ||
        (typeof retiredEpoch === "number" && Number.isSafeInteger(retiredEpoch) &&
          retiredEpoch >= 0 && retiredEpoch <= stopOperation.runtimeEpoch))
    ) return { kind: "pending" as const };
    const proof = await this.options.observations.writerAbsence({
      instanceId: this.options.binding.instanceId,
      repositoryId: this.options.binding.repositoryId,
      retiredEpoch,
      afterOperationId: stopOperation.id,
    });
    const stopped = CanaryCleanupEvidenceSchema.safeParse({
      operationId: stopOperation.id,
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
    const latest = await this.currentBinding();
    if (
      latest.instance.generation !== stopOperation.generation ||
      latest.instance.runtimeEpoch !== startedOperation.runtimeEpoch ||
      latest.instance.desiredRevisionId !== startedOperation.deploymentRevisionId ||
      latest.instance.desiredState !== "stopped"
    ) {
      return { kind: "pending" as const };
    }
    return { kind: "stopped" as const, evidence: stopped.data };
  }
}

function persistedStopWriterAbsence(
  operation: CanaryOperation,
): Readonly<Record<string, unknown>> | null {
  const checkpoint = operation.checkpoint;
  if (!checkpoint) return null;
  const direct = checkpoint.writerAbsenceProof;
  if (isRecord(direct)) return direct;
  const lifecycle = checkpoint.lifecycle;
  if (isRecord(lifecycle) && isRecord(lifecycle.writerAbsenceProof)) {
    return lifecycle.writerAbsenceProof;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
