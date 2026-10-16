import {
  BuildInputSchema,
  DigestSchema,
  InstanceSnapshotSchema,
  PublicConfigurationRevisionSchema,
  PublicOperationSchema,
  ResourceRequirementsSchema,
  RuntimeMetadataSchema,
} from "@praetorium/contracts";
import {
  ConfigurationAuthorizationError,
  ConfigurationConflictError,
  ConfigurationIdempotencyConflictError,
  ConfigurationNotFoundError,
  ConfigurationSelectionSchema,
  type ConfigurationService,
  type ConfigurationPlanReceipt,
  type ConfigurationRevision,
} from "@praetorium/application/configurations";
import { Hono, type Context, type Next } from "hono";
import { z } from "zod";

const MAX_CONFIGURATION_REQUEST_BYTES = 65_536;
const InstanceId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const Identity = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[\x21-\x7e]+$/u);
const ConfigurationBodySchema = z.strictObject({
  actorId: Identity,
  bindingEpoch: z.number().int().positive().safe(),
  authorizationRevision: z.number().int().nonnegative().safe(),
  expectedGeneration: z.number().int().nonnegative().safe(),
  selection: ConfigurationSelectionSchema,
});
const PreviewBodySchema = ConfigurationBodySchema.omit({ actorId: true });
const ConfigurationBindingSchema = z.strictObject({
  repositoryId: z.number().int().positive().safe(),
  instanceId: InstanceId,
  bindingEpoch: z.number().int().positive().safe(),
  authorizationRevision: z.number().int().nonnegative().safe(),
  suspended: z.boolean(),
});
const PublicRevisionSchema = PublicConfigurationRevisionSchema;
const ConfigurationSnapshotSchema = z.strictObject({
  binding: ConfigurationBindingSchema,
  instance: InstanceSnapshotSchema,
  revision: PublicRevisionSchema.nullable(),
});
const PreviewResponseSchema = z.strictObject({
  buildInput: BuildInputSchema,
  resources: ResourceRequirementsSchema,
  runtimeMetadata: RuntimeMetadataSchema,
  buildKey: DigestSchema,
  requestedModules: z.array(z.string().min(1).max(128)).max(256),
  resolvedModules: BuildInputSchema.shape.resolvedModules,
});
const ConfigurationPlanResponseSchema = z.strictObject({
  instance: InstanceSnapshotSchema,
  revision: PublicRevisionSchema,
  operation: PublicOperationSchema.nullable(),
  buildId: z.string().min(1).max(128),
  buildKey: DigestSchema,
  replayed: z.boolean(),
});

export type ConfigurationRoutesOptions = {
  /** The parent Control Plane app authenticates the Gateway before mounting these routes. */
  readonly configuration: Pick<
    ConfigurationService,
    "getByInstance" | "getCurrentRevision" | "preview" | "plan"
  >;
  readonly now?: () => number;
  readonly requestId?: () => string;
};

/** Public configuration preview and desired-revision planning routes. */
export function createConfigurationRoutes(options: ConfigurationRoutesOptions) {
  const now = options.now ?? Date.now;
  const requestId = options.requestId ?? (() => crypto.randomUUID());
  const app = new Hono();

  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    await next();
  });
  const rejectQuery = async (c: Context, next: Next) => {
    if (new URL(c.req.url).search !== "") {
      return c.json({ error: { code: "INVALID_REQUEST" } }, 400);
    }
    await next();
  };
  app.use("/v1/instances/:instanceId/configuration", rejectQuery);
  app.use("/v1/instances/:instanceId/configuration/*", rejectQuery);

  app.get("/v1/instances/:instanceId/configuration", async (c) => {
    const instanceId = InstanceId.parse(c.req.param("instanceId"));
    const context = await options.configuration.getByInstance(instanceId);
    if (!context) return c.json({ error: { code: "REPOSITORY_NOT_FOUND" } }, 404);
    const revision = await options.configuration.getCurrentRevision(instanceId);
    return c.json(
      ConfigurationSnapshotSchema.parse({
        binding: context.binding,
        instance: context.instance,
        revision: revision ? publicRevision(revision) : null,
      }),
    );
  });

  app.post("/v1/instances/:instanceId/configuration/preview", async (c) => {
    const instanceId = InstanceId.parse(c.req.param("instanceId"));
    const body = PreviewBodySchema.parse(await boundedJson(c.req.raw));
    const context = await options.configuration.getByInstance(instanceId);
    if (!context) return c.json({ error: { code: "REPOSITORY_NOT_FOUND" } }, 404);
    const result = await options.configuration.preview({
      repositoryId: context.binding.repositoryId,
      instanceId,
      ...body,
    });
    return c.json(PreviewResponseSchema.parse(result));
  });

  app.post("/v1/instances/:instanceId/configuration", async (c) => {
    const instanceId = InstanceId.parse(c.req.param("instanceId"));
    const body = ConfigurationBodySchema.parse(await boundedJson(c.req.raw));
    const idempotencyKey = Identity.max(128).parse(c.req.header("Idempotency-Key"));
    const requestHeader = c.req.header("X-Request-Id");
    const requestIdValue =
      requestHeader === undefined ? requestId() : Identity.max(128).parse(requestHeader);
    const context = await options.configuration.getByInstance(instanceId);
    if (!context) return c.json({ error: { code: "REPOSITORY_NOT_FOUND" } }, 404);
    const result = await options.configuration.plan({
      repositoryId: context.binding.repositoryId,
      instanceId,
      ...body,
      idempotencyKey,
      requestId: requestIdValue,
      now: now(),
    });
    return c.json(ConfigurationPlanResponseSchema.parse(projectPlan(result)));
  });

  app.all("/v1/instances/:instanceId/configuration", (c) =>
    c.json({ error: { code: "METHOD_NOT_ALLOWED" } }, 405, { Allow: "GET, POST" }),
  );
  app.all("/v1/instances/:instanceId/configuration/*", (c) =>
    c.json({ error: { code: "METHOD_NOT_ALLOWED" } }, 405, { Allow: "POST" }),
  );
  app.onError((error, c) => {
    if (error instanceof ConfigurationNotFoundError) {
      return c.json({ error: { code: "REPOSITORY_NOT_FOUND" } }, 404);
    }
    if (error instanceof ConfigurationAuthorizationError) {
      return c.json({ error: { code: error.code } }, 409);
    }
    if (
      error instanceof ConfigurationConflictError ||
      error instanceof ConfigurationIdempotencyConflictError
    ) {
      return c.json({ error: { code: error.code } }, 409);
    }
    if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof TypeError) {
      return c.json({ error: { code: "INVALID_REQUEST" } }, 400);
    }
    if (error instanceof RangeError) return c.json({ error: { code: "REQUEST_TOO_LARGE" } }, 413);
    return c.json({ error: { code: "CONFIGURATION_UNAVAILABLE" } }, 503);
  });
  return app;
}

function publicRevision(revision: ConfigurationRevision) {
  return PublicRevisionSchema.parse(revision);
}

function projectPlan(receipt: ConfigurationPlanReceipt) {
  return {
    instance: receipt.instance,
    revision: publicRevision(receipt.revision),
    operation: receipt.operation ? publicOperation(receipt.operation) : null,
    buildId: receipt.buildId,
    buildKey: receipt.buildKey,
    replayed: receipt.replayed,
  };
}

function publicOperation(operation: NonNullable<ConfigurationPlanReceipt["operation"]>) {
  return PublicOperationSchema.parse({
    id: operation.id,
    instanceId: operation.instanceId,
    generation: operation.generation,
    runtimeEpoch: operation.runtimeEpoch,
    kind: operation.kind,
    status: operation.status,
    phase: operation.phase,
    attempt: operation.attempt,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
  });
}

async function boundedJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type");
  if (
    contentType === null ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType.trim())
  ) {
    throw new TypeError("JSON content type required");
  }
  const contentLength = request.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^\d+$/u.test(contentLength) || Number(contentLength) > MAX_CONFIGURATION_REQUEST_BYTES)
  ) {
    throw new RangeError("configuration request exceeded its bound");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new TypeError("JSON body required");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_CONFIGURATION_REQUEST_BYTES) {
        await reader.cancel();
        throw new RangeError("configuration request exceeded its bound");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}
