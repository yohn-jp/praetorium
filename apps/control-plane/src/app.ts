import { createBuildRoutes, type BuildRoutesOptions } from "./build-routes.js";
import { Hono } from "hono";
import { z } from "zod";
import {
  createProvisionerRoutes,
  type ProvisionerRoutesDependencies,
} from "./provisioner-routes.js";
import { createManagementRoutes, type ManagementDependencies } from "./management-routes.js";
import type { InstanceService, RepositoryRegistryService } from "@praetorium/application/instances";
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const revision = z.number().int().nonnegative();
const ResolveSchema = z.strictObject({
  repositoryId: id,
  installationId: id,
  owner: z.string().regex(/^[A-Za-z0-9_.-]{1,255}$/),
  name: z.string().regex(/^[A-Za-z0-9_.-]{1,255}$/),
  authorizationRevision: revision,
  bindingEpoch: revision.optional(),
  actorId: z.string().min(1).max(128),
  idempotencyKey: z.string().min(1).max(128),
});
const DesiredSchema = z
  .strictObject({
    actorId: z.string().min(1).max(128),
    expectedGeneration: revision.optional(),
    desiredState: z.enum(["running", "stopped"]),
    idempotencyKey: z.string().min(1).max(128),
    bindingEpoch: revision,
    authorizationRevision: revision,
    forceNewRuntime: z.boolean().optional(),
  })
  .refine((value) => !(value.desiredState === "stopped" && value.forceNewRuntime), {
    message: "Stopped intent cannot request a new runtime",
  });
export type ControlPlaneDependencies = {
  registry: RepositoryRegistryService;
  instances: InstanceService;
  gatewaySecret: string;
  provisioner?: ProvisionerRoutesDependencies & { secret: string };
  controlJwks?: () => Promise<unknown>;
  management?: ManagementDependencies;
  builds?: BuildRoutesOptions;
  now?: () => number;
};
/** Only authenticated control metadata enters this Worker. Actor identity comes from Gateway session authority. */
export function createControlPlaneApp(deps: ControlPlaneDependencies) {
  if (deps.gatewaySecret.length < 32) throw new Error("Gateway service secret required");
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (c.req.path === "/.well-known/control-jwks.json" && c.req.method === "GET") {
      if (!deps.controlJwks)
        return c.json({ error: { code: "CONTROL_CREDENTIAL_UNAVAILABLE" } }, 503);
      return c.json(await deps.controlJwks());
    }
    if (c.req.path.startsWith("/internal/builds/")) {
      if (!deps.builds) return c.json({ error: { code: "BUILD_SERVICE_UNAVAILABLE" } }, 503);
      await next();
      return;
    }
    const provisioner = c.req.path.startsWith("/internal/provisioner/");
    const candidate = provisioner
      ? (c.req.header("Authorization") ?? "").replace(/^Bearer /, "")
      : (c.req.header("X-Control-Plane-Gateway-Auth") ?? "");
    const secret = provisioner ? (deps.provisioner?.secret ?? "") : deps.gatewaySecret;
    if (!secret || !(await equalSecret(candidate, secret)))
      return c.json({ error: { code: "UNAUTHORIZED" } }, 401);
    if (Number(c.req.header("Content-Length") ?? 0) > 65536)
      return c.json({ error: { code: "REQUEST_TOO_LARGE" } }, 413);
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof TypeError)
      return c.json({ error: { code: "INVALID_REQUEST" } }, 400);
    const code = (error as { code?: string }).code;
    if (code === "REPOSITORY_NOT_FOUND") return c.json({ error: { code } }, 404);
    if (
      code === "OPERATION_FENCE_CONFLICT" ||
      code === "REPOSITORY_STATE_CONFLICT" ||
      code === "REPOSITORY_BINDING_SUSPENDED"
    )
      return c.json({ error: { code } }, 409);
    return c.json({ error: { code: "UPSTREAM_UNAVAILABLE" } }, 503);
  });
  app.get("/internal/health", (c) => c.json({ service: "praetorium-control-plane", status: "ok" }));
  app.post("/v1/repositories/resolve", async (c) => {
    const input = ResolveSchema.parse(await boundedJson(c.req.raw));
    const { actorId, idempotencyKey, bindingEpoch, ...repository } = input;
    const result = await deps.registry.resolveOrCreate({
      repository,
      actor: { id: actorId, kind: "user" },
      requestId: c.req.header("X-Request-Id") ?? crypto.randomUUID(),
      idempotencyKey,
      now: (deps.now ?? Date.now)(),
    });
    if (bindingEpoch !== undefined && result.binding.bindingEpoch !== bindingEpoch)
      return c.json({ error: { code: "REPOSITORY_STATE_CONFLICT" } }, 409);
    return c.json(result, result.created ? 201 : 200);
  });
  app.get("/v1/repositories/:repositoryId", async (c) => {
    const repositoryId = id.parse(Number(c.req.param("repositoryId")));
    const snapshot = await deps.instances.getByRepositoryId(repositoryId);
    return snapshot ? c.json(snapshot) : c.json({ error: { code: "REPOSITORY_NOT_FOUND" } }, 404);
  });
  app.get("/v1/instances/:instanceId", async (c) => {
    const snapshot = await deps.instances.getByInstanceId(c.req.param("instanceId"));
    return snapshot ? c.json(snapshot) : c.json({ error: { code: "REPOSITORY_NOT_FOUND" } }, 404);
  });
  app.post("/v1/instances/:instanceId/desired", async (c) => {
    const input = DesiredSchema.parse(await boundedJson(c.req.raw));
    const snapshot = await deps.instances.getByInstanceId(c.req.param("instanceId"));
    if (!snapshot) return c.json({ error: { code: "REPOSITORY_NOT_FOUND" } }, 404);
    const { expectedGeneration, forceNewRuntime, ...requiredInput } = input;
    const result = await deps.instances.requestDesiredState({
      ...requiredInput,
      ...(expectedGeneration === undefined ? {} : { expectedGeneration }),
      ...(forceNewRuntime === undefined ? {} : { forceNewRuntime }),
      repositoryId: snapshot.binding.repositoryId,
      requestId: c.req.header("X-Request-Id") ?? crypto.randomUUID(),
      now: (deps.now ?? Date.now)(),
    });
    return c.json({
      ...result,
      operation: result.operation ? publicOperation(result.operation) : null,
    });
  });
  if (deps.builds) app.route("/", createBuildRoutes(deps.builds));
  if (deps.management) app.route("/", createManagementRoutes(deps.management));
  if (deps.provisioner)
    app.route("/internal/provisioner", createProvisionerRoutes(deps.provisioner));
  return app;
}
export async function equalSecret(candidate: string, expected: string): Promise<boolean> {
  const encode = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encode.encode(candidate)),
    crypto.subtle.digest("SHA-256", encode.encode(expected)),
  ]);
  let mismatch = 0;
  const x = new Uint8Array(a),
    y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) mismatch |= x[i]! ^ y[i]!;
  return candidate.length > 0 && mismatch === 0;
}
export async function boundedJson(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new TypeError("Request body required");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 65536) {
        await reader.cancel();
        throw new TypeError("Control metadata too large");
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
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export function publicOperation(op: {
  id: string;
  instanceId: string;
  generation: number;
  runtimeEpoch: number;
  kind: string;
  status: string;
  phase: string;
  attempt: number;
  result: Readonly<Record<string, unknown>> | null;
  createdAt: number;
  updatedAt: number;
}) {
  return {
    id: op.id,
    instanceId: op.instanceId,
    generation: op.generation,
    runtimeEpoch: op.runtimeEpoch,
    kind: op.kind,
    status: op.status,
    phase: op.phase,
    attempt: op.attempt,
    createdAt: op.createdAt,
    updatedAt: op.updatedAt,
  };
}
