import type { LogicalInstance, Operation, RepositoryBinding } from "@praetorium/contracts";

export type RepositoryLocator = {
  readonly repositoryId: number;
  readonly installationId: number;
  readonly owner: string;
  readonly name: string;
  readonly authorizationRevision: number;
};

export type InstanceSnapshot = LogicalInstance & {
  readonly observedState:
    | "absent"
    | "starting"
    | "ready"
    | "stopping"
    | "stopped"
    | "failed"
    | "unknown";
  readonly observedRuntimeEpoch: number | null;
  readonly observedSequence: number;
  readonly legacyRuntimeEpoch?: number | null;
  readonly desiredRevisionId: string | null;
  readonly observedRevisionId: string | null;
  readonly reservationState: "none" | "pending" | "reserved" | "allocated" | "blocked" | "released";
  readonly reservationId: string | null;
  /** Cluster observed for the current runtime assignment, if one exists. */
  readonly clusterId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type OperationRecord = Operation & {
  readonly repositoryId: number;
  readonly clusterId: string | null;
  readonly reservationId: string | null;
  readonly deploymentRevisionId: string | null;
  readonly buildId: string | null;
  readonly prerequisiteBuildId: string | null;
  readonly idempotencyKey: string;
  readonly phase: string;
  readonly workerId: string | null;
  readonly leaseToken: string | null;
  readonly requestHash: string;
  readonly checkpointSequence: number;
  readonly checkpoint: Readonly<Record<string, unknown>> | null;
  readonly result: Readonly<Record<string, unknown>> | null;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type RepositorySnapshot = {
  readonly binding: RepositoryBinding;
  readonly instance: InstanceSnapshot;
};

export type RepositoryActor = {
  readonly id: string;
  readonly kind: "user" | "system" | "operator";
};

export type RepositoryRegistryInput = {
  readonly repository: RepositoryLocator;
  readonly actor: RepositoryActor;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly now: number;
};

export type BindingMutationInput = {
  readonly repositoryId: number;
  readonly expectedBindingEpoch: number;
  readonly requestId: string | null;
  readonly now: number;
};

export type SuspendBindingInput = BindingMutationInput & {
  readonly eventId: string;
  readonly eventKind: string;
  readonly reason: string;
};

export type RevalidateBindingInput = BindingMutationInput & {
  readonly installationId: number;
  readonly owner: string;
  readonly name: string;
  readonly authorizationRevision: number;
  readonly actorId: string;
};

export type DesiredStateMutationInput = {
  readonly repositoryId: number;
  readonly bindingEpoch: number;
  readonly authorizationRevision: number;
  readonly desiredState: "running" | "stopped";
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly requestId: string | null;
  readonly now: number;
  readonly expectedGeneration?: number;
  readonly forceNewRuntime?: boolean;
  /** Explicitly obtain a fresh stop census for an already stopped current epoch. */
  readonly verifyStopped?: true;
};

export type DesiredStateMutationResult = {
  readonly binding: RepositoryBinding;
  readonly instance: InstanceSnapshot;
  readonly operation: OperationRecord | null;
  readonly replayed: boolean;
};

export type RepositoryRegistryStore = {
  resolveOrCreate(input: RepositoryRegistryInput & { readonly instanceId: string }): Promise<{
    readonly snapshot: RepositorySnapshot;
    readonly created: boolean;
  }>;
  getByRepositoryId(repositoryId: number): Promise<RepositorySnapshot | null>;
  getByInstanceId(instanceId: string): Promise<RepositorySnapshot | null>;
  suspendBinding(input: SuspendBindingInput): Promise<RepositoryBinding | null>;
  revalidateBinding(input: RevalidateBindingInput): Promise<RepositoryBinding | null>;
  findOperationByIdempotency(scope: string, key: string): Promise<OperationRecord | null>;
  findActiveOperation(instanceId: string, generation: number): Promise<OperationRecord | null>;
  requestDesiredState(input: {
    readonly snapshot: RepositorySnapshot;
    readonly expectedGeneration: number;
    readonly desiredState: "running" | "stopped";
    readonly nextRuntimeEpoch: number;
    readonly operation: OperationRecord;
    readonly requestHash: string;
    readonly actorId: string;
    readonly authorizationRevision: number;
    readonly requestId: string | null;
    readonly now: number;
    readonly actorKind?: RepositoryActor["kind"];
  }): Promise<DesiredStateMutationResult | null>;
};

export class RepositoryStateConflict extends Error {
  readonly code = "REPOSITORY_STATE_CONFLICT";
  constructor(message: string) {
    super(message);
    this.name = "RepositoryStateConflict";
  }
}

export class RepositoryBindingSuspended extends Error {
  readonly code = "REPOSITORY_BINDING_SUSPENDED";
  constructor(message = "repository binding requires revalidation") {
    super(message);
    this.name = "RepositoryBindingSuspended";
  }
}

export class RepositoryNotFound extends Error {
  readonly code = "REPOSITORY_NOT_FOUND";
  constructor(message = "repository instance not found") {
    super(message);
    this.name = "RepositoryNotFound";
  }
}
