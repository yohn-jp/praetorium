import {
  BuildInputSchema,
  RuntimeMetadataSchema,
  ResourceRequirementsSchema,
  buildKey,
  canonicalBuildInput,
} from "@praetorium/contracts";
import { z } from "zod";
import {
  ConfigurationAuthorizationError,
  ConfigurationConflictError,
  ConfigurationNotFoundError,
  type ConfigurationContext,
  type ConfigurationPlanOutput,
  type ConfigurationPlanReceipt,
  type ConfigurationPlanner,
  type ConfigurationSelection,
  type ConfigurationStore,
} from "./types.js";

const UniqueStrings = z
  .array(z.string().min(1).max(128))
  .max(256)
  .refine((values) => new Set(values).size === values.length, "module IDs must be unique");

export const ConfigurationSelectionSchema = z.strictObject({
  releaseId: z.string().min(1).max(128),
  requestedModules: UniqueStrings,
  resourceProfileId: z.string().min(1).max(128),
  policy: z.enum(["stable", "pinned"]),
});

const PlanRequestSchema = z.strictObject({
  repositoryId: z.number().int().positive().safe(),
  bindingEpoch: z.number().int().positive().safe(),
  authorizationRevision: z.number().int().nonnegative().safe(),
  instanceId: z.string().min(1).max(128),
  expectedGeneration: z.number().int().nonnegative().safe(),
  selection: ConfigurationSelectionSchema,
  actorId: z.string().min(1).max(255),
  idempotencyKey: z.string().min(1).max(128),
  requestId: z.string().min(1).max(128).nullable(),
  now: z.number().int().nonnegative().safe(),
});

const PreviewRequestSchema = z.strictObject({
  repositoryId: z.number().int().positive().safe(),
  bindingEpoch: z.number().int().positive().safe(),
  authorizationRevision: z.number().int().nonnegative().safe(),
  instanceId: z.string().min(1).max(128),
  expectedGeneration: z.number().int().nonnegative().safe(),
  selection: ConfigurationSelectionSchema,
});

export type ConfigurationPlanRequest = z.infer<typeof PlanRequestSchema>;
export type ConfigurationPreviewRequest = z.infer<typeof PreviewRequestSchema>;

export type ConfigurationPreview = ConfigurationPlanOutput & {
  readonly buildKey: string;
  readonly requestedModules: readonly string[];
  readonly resolvedModules: ConfigurationPlanOutput["buildInput"]["resolvedModules"];
};

export type ConfigurationServiceOptions = {
  readonly newId?: (kind: "build" | "revision" | "operation") => string;
};

/** Plans durable repository configuration using only a trusted producer planner. */
export class ConfigurationService {
  private readonly newId: NonNullable<ConfigurationServiceOptions["newId"]>;

  constructor(
    private readonly store: ConfigurationStore,
    private readonly planner: ConfigurationPlanner,
    options: ConfigurationServiceOptions = {},
  ) {
    this.newId = options.newId ?? ((kind) => `${kind}_${crypto.randomUUID()}`);
  }

  async preview(input: ConfigurationPreviewRequest): Promise<ConfigurationPreview> {
    const request = PreviewRequestSchema.parse(input);
    await this.requireCurrentContext(request);
    const plan = await this.resolve(request.selection);
    return {
      ...plan,
      buildKey: await buildKey(plan.buildInput),
      requestedModules: [...plan.buildInput.requestedModules],
      resolvedModules: plan.buildInput.resolvedModules,
    };
  }

  async plan(input: ConfigurationPlanRequest): Promise<ConfigurationPlanReceipt> {
    const request = PlanRequestSchema.parse(input);
    const requestHash = await digestJson({
      repositoryId: request.repositoryId,
      bindingEpoch: request.bindingEpoch,
      authorizationRevision: request.authorizationRevision,
      instanceId: request.instanceId,
      expectedGeneration: request.expectedGeneration,
      selection: canonicalSelection(request.selection),
      actorId: request.actorId,
    });
    const idempotencyRequest = {
      repositoryId: request.repositoryId,
      idempotencyKey: request.idempotencyKey,
      requestHash,
    };
    const prior = await this.store.findPlanByIdempotency(idempotencyRequest);
    if (prior) return { ...prior, replayed: true };

    const context = await this.requireCurrentContext(request);
    const plan = await this.resolve(request.selection);
    const key = await buildKey(plan.buildInput);
    const result = await this.store.commitPlan({
      repositoryId: request.repositoryId,
      instanceId: request.instanceId,
      bindingEpoch: request.bindingEpoch,
      authorizationRevision: request.authorizationRevision,
      expectedGeneration: request.expectedGeneration,
      expectedPolicy: context.instance.policy,
      expectedRuntimeEpoch: context.instance.runtimeEpoch,
      expectedDesiredState: context.instance.desiredState,
      selection: canonicalSelection(request.selection),
      buildInput: plan.buildInput,
      buildKey: key,
      resources: plan.resources,
      runtimeMetadata: plan.runtimeMetadata,
      actorId: request.actorId,
      idempotencyKey: request.idempotencyKey,
      requestHash,
      requestId: request.requestId,
      revisionId: this.newId("revision"),
      buildId: this.newId("build"),
      operationId: this.newId("operation"),
      now: request.now,
    });
    if (result) return result;

    // A concurrent identical request may have committed while the planner ran.
    const concurrent = await this.store.findPlanByIdempotency(idempotencyRequest);
    if (concurrent) return { ...concurrent, replayed: true };
    throw new ConfigurationConflictError();
  }

  getByInstance(instanceId: string): Promise<ConfigurationContext | null> {
    if (typeof instanceId !== "string" || instanceId.length === 0 || instanceId.length > 128) {
      throw new TypeError("instance ID is invalid");
    }
    return this.store.getByInstance(instanceId);
  }

  getCurrentRevision(instanceId: string) {
    if (typeof instanceId !== "string" || instanceId.length === 0 || instanceId.length > 128) {
      throw new TypeError("instance ID is invalid");
    }
    return this.store.getCurrentRevision(instanceId);
  }

  async findByIdempotency(repositoryId: number, idempotencyKey: string): Promise<ConfigurationPlanReceipt | null> {
    if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) throw new TypeError("repository ID is invalid");
    if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0 || idempotencyKey.length > 128) {
      throw new TypeError("idempotency key is invalid");
    }
    const result = await this.store.getPlanByIdempotency({ repositoryId, idempotencyKey });
    return result ? { ...result, replayed: true } : null;
  }

  getRevision(revisionId: string) {
    if (typeof revisionId !== "string" || revisionId.length === 0 || revisionId.length > 128) {
      throw new TypeError("revision ID is invalid");
    }
    return this.store.getRevision(revisionId);
  }

  private async requireCurrentContext(
    request: Pick<ConfigurationPlanRequest, "repositoryId" | "bindingEpoch" | "authorizationRevision" | "instanceId" | "expectedGeneration">,
  ): Promise<ConfigurationContext> {
    const context = await this.store.getPlanContext(request.repositoryId);
    if (!context) throw new ConfigurationNotFoundError();
    if (
      context.instance.instanceId !== request.instanceId ||
      context.binding.bindingEpoch !== request.bindingEpoch ||
      context.binding.authorizationRevision !== request.authorizationRevision ||
      context.binding.suspended
    ) {
      throw new ConfigurationAuthorizationError();
    }
    if (context.instance.generation !== request.expectedGeneration) {
      throw new ConfigurationConflictError("configuration generation changed");
    }
    return context;
  }

  private async resolve(selection: ConfigurationSelection): Promise<ConfigurationPlanOutput> {
    const normalizedSelection = canonicalSelection(selection);
    const result = await this.planner.plan(normalizedSelection);
    const buildInput = BuildInputSchema.parse(JSON.parse(canonicalBuildInput(result.buildInput)));
    const resources = ResourceRequirementsSchema.parse(result.resources);
    if (Object.values(resources).some((value) => !Number.isSafeInteger(value))) {
      throw new TypeError("producer resource requirements exceed the safe integer range");
    }
    const runtimeMetadata = RuntimeMetadataSchema.parse(result.runtimeMetadata);
    if (runtimeMetadata.producerRevision !== buildInput.producerRevision) {
      throw new TypeError("producer runtime metadata is not bound to the selected build producer revision");
    }
    if (JSON.stringify(buildInput.requestedModules) !== JSON.stringify(normalizedSelection.requestedModules)) {
      throw new TypeError("producer plan is not bound to the requested module selection");
    }
    const resolved = new Set(buildInput.resolvedModules.map(({ id }) => id));
    if (buildInput.requestedModules.some((id) => !resolved.has(id))) {
      throw new TypeError("producer plan omitted a requested module from the resolved closure");
    }
    return { buildInput, resources, runtimeMetadata };
  }
}

function canonicalSelection(selection: ConfigurationSelection): ConfigurationSelection {
  const parsed = ConfigurationSelectionSchema.parse(selection);
  return { ...parsed, requestedModules: [...parsed.requestedModules].sort() };
}

async function digestJson(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
