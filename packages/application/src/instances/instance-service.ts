import type { Operation } from "@praetorium/contracts";
import type {
  DesiredStateMutationInput,
  DesiredStateMutationResult,
  OperationRecord,
  RepositoryRegistryStore,
  RepositorySnapshot,
} from "./types.js";
import {
  RepositoryBindingSuspended,
  RepositoryNotFound,
  RepositoryStateConflict,
} from "./types.js";

export type OperationIdFactory = () => string;

export class InstanceService {
  constructor(
    private readonly store: RepositoryRegistryStore,
    private readonly newOperationId: OperationIdFactory,
  ) {}

  getByRepositoryId(repositoryId: number) {
    return this.store.getByRepositoryId(repositoryId);
  }

  getByInstanceId(instanceId: string) {
    return this.store.getByInstanceId(instanceId);
  }

  async requestDesiredState(input: DesiredStateMutationInput): Promise<DesiredStateMutationResult> {
    if (input.verifyStopped && (input.desiredState !== "stopped" || input.expectedGeneration === undefined)) {
      throw new TypeError("stop verification requires stopped intent and an expected generation");
    }
    if (input.desiredState === "stopped" && input.forceNewRuntime === true) {
      throw new TypeError("forceNewRuntime is only valid for a running desired state");
    }
    const scope = `repository:${input.repositoryId}`;
    const requestHash = await hashRequest({
      repositoryId: input.repositoryId,
      bindingEpoch: input.bindingEpoch,
      authorizationRevision: input.authorizationRevision,
      desiredState: input.desiredState,
      expectedGeneration: input.expectedGeneration ?? null,
      forceNewRuntime: input.forceNewRuntime === true,
      ...(input.verifyStopped ? { verifyStopped: true } : {}),
    });
    const replay = await readReplay(this.store, input, scope, requestHash);
    if (replay) {
      return replay;
    }

    const snapshot = await this.store.getByRepositoryId(input.repositoryId);
    if (!snapshot) throw new RepositoryNotFound();
    assertBinding(snapshot, input.bindingEpoch);
    if (snapshot.binding.authorizationRevision !== input.authorizationRevision) {
      throw new RepositoryStateConflict(
        "repository authorization revision changed; refresh access before retrying",
      );
    }
    const current = snapshot.instance;
    if (input.expectedGeneration !== undefined && current.generation !== input.expectedGeneration) {
      throw new RepositoryStateConflict(
        `expected generation ${input.expectedGeneration}, current generation is ${current.generation}`,
      );
    }

    const forceNewRuntime = input.forceNewRuntime === true;
    if (input.verifyStopped && (current.desiredState !== "stopped" ||
        !isDesiredStateObserved(current, "stopped") || current.observedRuntimeEpoch !== current.runtimeEpoch ||
        current.runtimeEpoch < 1 || await this.store.findActiveOperation(current.instanceId, current.generation))) {
      throw new RepositoryStateConflict("stop verification requires a stopped current epoch without active work");
    }
    if (current.desiredState === input.desiredState && !forceNewRuntime && !input.verifyStopped) {
      const active = await this.store.findActiveOperation(current.instanceId, current.generation);
      if (active || isDesiredStateObserved(current, input.desiredState)) {
        return { binding: snapshot.binding, instance: current, operation: active, replayed: false };
      }
    }

    const operationId = this.newOperationId();
    const generation = current.generation + 1;
    const startsRuntime =
      input.desiredState === "running" &&
      (current.desiredState !== "running" ||
        forceNewRuntime ||
        !isDesiredStateObserved(current, "running"));
    const runtimeEpoch = current.runtimeEpoch + (startsRuntime ? 1 : 0);
    const kind: Operation["kind"] = forceNewRuntime
      ? "redeploy"
      : input.desiredState === "running"
        ? "start"
        : "stop";
    const operation = {
      id: operationId,
      instanceId: current.instanceId,
      generation,
      runtimeEpoch,
      kind,
      status: "pending",
      attempt: 0,
      leaseEpoch: 0,
      reportSequence: 0,
      leaseExpiresAt: null,
      repositoryId: input.repositoryId,
      clusterId: null,
      reservationId: null,
      deploymentRevisionId: current.desiredRevisionId,
      buildId: null,
      prerequisiteBuildId: null,
      phase:
        input.desiredState === "running" && current.desiredRevisionId === null
          ? "waiting-for-artifact"
          : "accepted",
      workerId: null,
      leaseToken: null,
      idempotencyKey: input.idempotencyKey,
      checkpointSequence: 0,
      checkpoint: null,
      result: null,
      createdAt: input.now,
      updatedAt: input.now,
      requestHash,
    } satisfies OperationRecord;

    const result = await this.store.requestDesiredState({
      snapshot,
      expectedGeneration: current.generation,
      desiredState: input.desiredState,
      nextRuntimeEpoch: runtimeEpoch,
      operation,
      requestHash,
      actorId: input.actorId,
      authorizationRevision: input.authorizationRevision,
      requestId: input.requestId,
      now: input.now,
      actorKind: "user",
    });
    if (!result) {
      const concurrentReplay = await readReplay(this.store, input, scope, requestHash);
      if (concurrentReplay) return concurrentReplay;
      throw new RepositoryStateConflict(
        "desired state changed or an operation is still active; wait for completion or reconciliation, then retry",
      );
    }
    return result;
  }
}

function isDesiredStateObserved(
  instance: RepositorySnapshot["instance"],
  desiredState: DesiredStateMutationInput["desiredState"],
): boolean {
  if (desiredState === "stopped") {
    return instance.observedState === "absent" || instance.observedState === "stopped";
  }
  return (
    instance.desiredRevisionId !== null &&
    instance.desiredArtifactDigest !== null &&
    instance.observedState === "ready" &&
    instance.observedRuntimeEpoch === instance.runtimeEpoch &&
    instance.observedRevisionId === instance.desiredRevisionId &&
    instance.currentArtifactDigest === instance.desiredArtifactDigest
  );
}

async function readReplay(
  store: RepositoryRegistryStore,
  input: DesiredStateMutationInput,
  scope: string,
  requestHash: string,
): Promise<DesiredStateMutationResult | null> {
  const operation = await store.findOperationByIdempotency(scope, input.idempotencyKey);
  if (!operation) return null;
  if (operation.requestHash !== requestHash) {
    throw new RepositoryStateConflict("idempotency key was already used for a different request");
  }
  const snapshot = await store.getByRepositoryId(input.repositoryId);
  if (!snapshot) throw new RepositoryNotFound();
  assertBinding(snapshot, input.bindingEpoch);
  if (snapshot.binding.authorizationRevision !== input.authorizationRevision) {
    throw new RepositoryStateConflict(
      "repository authorization revision changed; refresh access before retrying",
    );
  }
  return { binding: snapshot.binding, instance: snapshot.instance, operation, replayed: true };
}

function assertBinding(
  snapshot: RepositorySnapshot | null,
  bindingEpoch: number,
): asserts snapshot is RepositorySnapshot {
  if (!snapshot) throw new RepositoryNotFound();
  if (snapshot.binding.suspended) throw new RepositoryBindingSuspended();
  if (snapshot.binding.bindingEpoch !== bindingEpoch) {
    throw new RepositoryStateConflict(
      "repository binding epoch changed; revalidate before retrying",
    );
  }
}

async function hashRequest(input: Record<string, unknown>): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(input));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("")}`;
}
