import type {
  BuildInput,
  Operation,
  ResourceRequirements,
  RuntimeMetadata,
} from "@praetorium/contracts";

export type ConfigurationPolicy = "stable" | "pinned";

export type ConfigurationSelection = {
  readonly releaseId: string;
  readonly requestedModules: readonly string[];
  readonly resourceProfileId: string;
  readonly policy: ConfigurationPolicy;
};

export type ConfigurationInstance = {
  readonly legacyRuntimeEpoch?: number | null;
  readonly instanceId: string;
  readonly repositoryId: number;
  readonly generation: number;
  readonly runtimeEpoch: number;
  readonly desiredState: "running" | "stopped";
  readonly policy: ConfigurationPolicy;
  readonly observedGeneration: number | null;
  readonly observedRuntimeEpoch: number | null;
  readonly observedSequence: number;
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
  readonly desiredArtifactDigest: string | null;
  readonly currentArtifactDigest: string | null;
  readonly reservationState: "none" | "pending" | "reserved" | "allocated" | "blocked" | "released";
  readonly reservationId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type ConfigurationBinding = {
  readonly repositoryId: number;
  readonly instanceId: string;
  readonly bindingEpoch: number;
  readonly authorizationRevision: number;
  readonly suspended: boolean;
};

export type ConfigurationContext = {
  readonly binding: ConfigurationBinding;
  readonly instance: ConfigurationInstance;
};

export type ConfigurationRevision = {
  readonly revisionId: string;
  readonly instanceId: string;
  readonly repositoryId: number;
  readonly generation: number;
  readonly buildKey: string;
  readonly buildId: string;
  readonly resolvedModules: BuildInput["resolvedModules"];
  readonly selection: ConfigurationSelection;
  readonly resources: ResourceRequirements;
  readonly runtimeMetadata: RuntimeMetadata;
  readonly artifactDigest: string | null;
  readonly status: "building" | "admitted" | "failed" | "superseded";
  readonly actorId: string;
  readonly createdAt: number;
};

export type ConfigurationOperation = Operation & {
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

export type ConfigurationPlanOutput = {
  readonly buildInput: BuildInput;
  readonly resources: ResourceRequirements;
  readonly runtimeMetadata: RuntimeMetadata;
};

export type ConfigurationPlanReceipt = {
  readonly instance: ConfigurationInstance;
  readonly revision: ConfigurationRevision;
  readonly operation: ConfigurationOperation | null;
  readonly buildId: string;
  readonly buildKey: string;
  readonly replayed: boolean;
};

export type ConfigurationPlanMutation = {
  readonly repositoryId: number;
  readonly instanceId: string;
  readonly bindingEpoch: number;
  readonly authorizationRevision: number;
  readonly expectedGeneration: number;
  readonly expectedPolicy: ConfigurationPolicy;
  readonly expectedRuntimeEpoch: number;
  readonly expectedDesiredState: "running" | "stopped";
  readonly selection: ConfigurationSelection;
  readonly buildInput: BuildInput;
  readonly buildKey: string;
  readonly resources: ResourceRequirements;
  readonly runtimeMetadata: RuntimeMetadata;
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly requestId: string | null;
  readonly revisionId: string;
  readonly buildId: string;
  readonly operationId: string;
  readonly now: number;
};

export type ConfigurationBuildStatus =
  | "reserved"
  | "pending"
  | "claimed"
  | "running"
  | "verifying"
  | "succeeded"
  | "failed"
  | "cancelled";

export type ConfigurationStage = {
  readonly stageId: string;
  readonly repositoryId: number;
  readonly instanceId: string;
  readonly bindingEpoch: number;
  readonly authorizationRevision: number;
  readonly expectedGeneration: number;
  readonly expectedRuntimeEpoch: number;
  readonly expectedPolicy: ConfigurationPolicy;
  readonly expectedDesiredState: "running" | "stopped";
  readonly selection: ConfigurationSelection;
  readonly buildInput: BuildInput;
  readonly buildKey: string;
  readonly buildId: string;
  readonly resources: ResourceRequirements;
  readonly runtimeMetadata: RuntimeMetadata;
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly requestId: string | null;
  readonly createdAt: number;
  readonly status: "staged" | "activated" | "superseded";
  readonly activationGeneration: number | null;
  readonly deploymentRevisionId: string | null;
  readonly operationId: string | null;
  readonly updatedAt: number;
};

export type ConfigurationStageBuild = {
  readonly buildId: string;
  readonly buildKey: string;
  readonly status: ConfigurationBuildStatus;
  readonly artifactDigest: string | null;
  readonly progress: Readonly<{
    stage: "preparing" | "building" | "publishing";
    percent: number | null;
  }> | null;
  readonly errorCode: string | null;
  readonly updatedAt: number;
};

export type ConfigurationStageReceipt = {
  readonly stage: ConfigurationStage;
  readonly build: ConfigurationStageBuild;
  readonly replayed: boolean;
};

/** Minimal stage identity needed by a stable-rollout dispatcher before activation. */
export type ConfigurationStageReference = {
  readonly stageId: string;
  readonly buildKey: string;
  readonly buildId: string;
  readonly artifactDigest: string | null;
  readonly status: ConfigurationStage["status"];
};

export type ConfigurationStageMutation = {
  readonly repositoryId: number;
  readonly instanceId: string;
  readonly bindingEpoch: number;
  readonly authorizationRevision: number;
  readonly expectedGeneration: number;
  readonly expectedPolicy: ConfigurationPolicy;
  readonly expectedRuntimeEpoch: number;
  readonly expectedDesiredState: "running" | "stopped";
  readonly selection: ConfigurationSelection;
  readonly buildInput: BuildInput;
  readonly buildKey: string;
  readonly resources: ResourceRequirements;
  readonly runtimeMetadata: RuntimeMetadata;
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly requestId: string | null;
  readonly stageId: string;
  readonly buildId: string;
  readonly now: number;
};

/** T11's persisted cluster lease is spent in the same batch as activation. */
export type ConfigurationStageActivationMutation = {
  readonly stageId: string;
  readonly clusterId: string;
  readonly rolloutId: string;
  readonly releaseId: string;
  readonly owner: string;
  readonly leaseEpoch: number;
  readonly expectedRolloutRevision: number;
  readonly expectedBuildKey: string;
  readonly expectedBuildId: string;
  readonly expectedArtifactDigest: string;
  readonly actorId: string;
  readonly actorKind: "user" | "system" | "operator";
  readonly operationId: string;
  readonly operationIdempotencyKey: string;
  readonly requestId: string | null;
  readonly now: number;
};

export type ConfigurationStageActivationReceipt = {
  readonly stage: ConfigurationStage;
  readonly instance: ConfigurationInstance;
  readonly revision: ConfigurationRevision;
  readonly operation: ConfigurationOperation | null;
  readonly operationId: string;
  readonly generation: number;
  readonly replayed: boolean;
};

export interface ConfigurationStore {
  getPlanContext(repositoryId: number): Promise<ConfigurationContext | null>;
  findPlanByIdempotency(input: {
    readonly repositoryId: number;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  }): Promise<ConfigurationPlanReceipt | null>;
  getPlanByIdempotency(input: {
    readonly repositoryId: number;
    readonly idempotencyKey: string;
  }): Promise<ConfigurationPlanReceipt | null>;
  commitPlan(input: ConfigurationPlanMutation): Promise<ConfigurationPlanReceipt | null>;
  getByInstance(instanceId: string): Promise<ConfigurationContext | null>;
  getCurrentRevision(instanceId: string): Promise<ConfigurationRevision | null>;
  getRevision(revisionId: string): Promise<ConfigurationRevision | null>;
  stageConfiguration(input: ConfigurationStageMutation): Promise<ConfigurationStageReceipt | null>;
  findStageByIdempotency(input: {
    readonly repositoryId: number;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  }): Promise<ConfigurationStageReceipt | null>;
  getStageByIdempotency(input: {
    readonly repositoryId: number;
    readonly idempotencyKey: string;
  }): Promise<ConfigurationStageReceipt | null>;
  getLatestStage(instanceId: string): Promise<ConfigurationStageReceipt | null>;
  activateStageUnderClusterFence(
    input: ConfigurationStageActivationMutation,
  ): Promise<ConfigurationStageActivationReceipt | null>;
}

export interface ConfigurationPlanner {
  plan(selection: ConfigurationSelection): Promise<ConfigurationPlanOutput>;
}

export class ConfigurationAuthorizationError extends Error {
  readonly code = "CONFIGURATION_AUTHORIZATION_CHANGED";
  constructor(message = "repository authorization must be refreshed") {
    super(message);
    this.name = "ConfigurationAuthorizationError";
  }
}

export class ConfigurationConflictError extends Error {
  readonly code = "CONFIGURATION_CONFLICT";
  constructor(message = "configuration generation or lifecycle state changed") {
    super(message);
    this.name = "ConfigurationConflictError";
  }
}

export class ConfigurationIdempotencyConflictError extends Error {
  readonly code = "CONFIGURATION_IDEMPOTENCY_CONFLICT";
  constructor(message = "idempotency key was already used for another configuration request") {
    super(message);
    this.name = "ConfigurationIdempotencyConflictError";
  }
}

export class ConfigurationNotFoundError extends Error {
  readonly code = "CONFIGURATION_NOT_FOUND";
  constructor(message = "repository configuration was not found") {
    super(message);
    this.name = "ConfigurationNotFoundError";
  }
}
