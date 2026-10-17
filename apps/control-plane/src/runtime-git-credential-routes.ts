import { Hono } from "hono";
import { z } from "zod";
import {
  RuntimeGitCredentialRegistrationSchema,
  type RuntimeGitCredentialRecord,
  type RuntimeGitCredentialRegistration,
} from "@praetorium/contracts";
import type { D1Database } from "@praetorium/persistence/d1";
import type { RuntimeBindingMetadata, RuntimeBindingMetadataReader } from "./runtime-binding.js";

const MAX_BODY_BYTES = 65_536;
const POSITIVE_ID = z.number().int().positive().safe();
const RuntimeCredentialPendingRequestSchema = z.strictObject({
  repositoryId: POSITIVE_ID,
  runtimeEpoch: POSITIVE_ID,
});
const TokenIdSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const EmptyBodySchema = z.strictObject({});

export interface RuntimeGitCredentialStore {
  purgeExpired(now: number, limit: number): Promise<number>;
  register(
    registration: RuntimeGitCredentialRegistration,
    now: number,
  ): Promise<RuntimeGitCredentialRecord>;
  markPending(tokenId: string, now: number): Promise<RuntimeGitCredentialRecord | null>;
  listPending(
    repositoryId: number,
    runtimeEpoch: number,
    now: number,
    limit: number,
  ): Promise<RuntimeGitCredentialRecord[]>;
  pendingCount(repositoryId: number, runtimeEpoch: number, now: number): Promise<number>;
  markRevoked(tokenId: string, now: number): Promise<RuntimeGitCredentialRecord | null>;
}

export interface RuntimeGitCredentialRoutesDependencies {
  readonly db: D1Database;
  readonly runtimeBindings: RuntimeBindingMetadataReader;
  readonly credentials: RuntimeGitCredentialStore;
  readonly now?: () => number;
}

interface HistoricalReservationRow {
  readonly repository_id: number;
}

/** Mount behind the Control Plane's Gateway service-auth middleware. */
export function createRuntimeGitCredentialRoutes(deps: RuntimeGitCredentialRoutesDependencies) {
  const now = deps.now ?? Date.now;
  const app = new Hono();

  app.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    await next();
  });

  app.post("/internal/runtime-credentials", async (context) => {
    const parsed = await parseBody(context.req.raw, RuntimeGitCredentialRegistrationSchema);
    if (!parsed.ok) return context.json({ error: { code: parsed.code } }, parsed.status);
    const input = parsed.value;
    const nowMs = readNow(now);
    const expiresAt = Date.parse(input.expiresAt);
    if (
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= nowMs ||
      expiresAt > nowMs + 3_605_000
    )
      return context.json({ error: { code: "RUNTIME_GIT_CREDENTIAL_EXPIRY_INVALID" } }, 400);

    let record: RuntimeGitCredentialRecord;
    try {
      await deps.credentials.purgeExpired(nowMs, 64);
      record = await deps.credentials.register(input, nowMs);
    } catch (error) {
      if (errorCode(error) === "RUNTIME_GIT_CREDENTIAL_CONFLICT")
        return context.json({ error: { code: "RUNTIME_GIT_CREDENTIAL_CONFLICT" } }, 409);
      throw error;
    }

    let binding: RuntimeBindingMetadata | null;
    try {
      binding = await deps.runtimeBindings.getCurrent(input.repositoryId);
    } catch {
      const pending = await deps.credentials.markPending(input.tokenId, nowMs);
      return context.json(
        {
          error: { code: "RUNTIME_BINDING_UNAVAILABLE" },
          status: pending?.status ?? record.status,
        },
        503,
      );
    }
    if (!matchesCurrentBinding(input, binding)) {
      const pending = await deps.credentials.markPending(input.tokenId, nowMs);
      return context.json({ status: pending?.status ?? record.status });
    }
    return context.json({ status: record.status });
  });

  app.post("/internal/runtime-credentials/pending", async (context) => {
    const parsed = await parseBody(context.req.raw, RuntimeCredentialPendingRequestSchema);
    if (!parsed.ok) return context.json({ error: { code: parsed.code } }, parsed.status);
    const { repositoryId, runtimeEpoch } = parsed.value;
    const nowMs = readNow(now);
    const historicalReservation = await deps.db
      .prepare(
        `SELECT b.repository_id FROM repository_bindings b
         WHERE b.repository_id = ? AND EXISTS (
           SELECT 1 FROM runtime_reservations r
           WHERE r.repository_id = b.repository_id AND r.runtime_epoch = ?
         ) LIMIT 1`,
      )
      .bind(repositoryId, runtimeEpoch)
      .first<HistoricalReservationRow>();
    if (!historicalReservation)
      return context.json({ error: { code: "RUNTIME_CREDENTIAL_EPOCH_UNKNOWN" } }, 404);

    const credentials = await deps.credentials.listPending(repositoryId, runtimeEpoch, nowMs, 8);
    const remaining = await deps.credentials.pendingCount(repositoryId, runtimeEpoch, nowMs);
    return context.json({ credentials, remaining });
  });

  app.post("/internal/runtime-credentials/:tokenId/revoked", async (context) => {
    const tokenId = TokenIdSchema.safeParse(context.req.param("tokenId"));
    if (!tokenId.success)
      return context.json({ error: { code: "RUNTIME_GIT_CREDENTIAL_ID_INVALID" } }, 400);
    const parsed = await parseBody(context.req.raw, EmptyBodySchema);
    if (!parsed.ok) return context.json({ error: { code: parsed.code } }, parsed.status);
    const record = await deps.credentials.markRevoked(tokenId.data, readNow(now));
    if (!record) return context.json({ error: { code: "RUNTIME_GIT_CREDENTIAL_UNKNOWN" } }, 404);
    return context.json({ revoked: record.status === "revoked" });
  });

  return app;
}

function matchesCurrentBinding(
  registration: RuntimeGitCredentialRegistration,
  binding: Awaited<ReturnType<RuntimeBindingMetadataReader["getCurrent"]>>,
): boolean {
  return (
    binding !== null &&
    binding.active === true &&
    binding.repositoryId === registration.repositoryId &&
    binding.installationId === registration.installationId &&
    binding.instanceId === registration.instanceId &&
    binding.runtimeId === registration.runtimeId &&
    binding.runtimeEpoch === registration.runtimeEpoch &&
    binding.leaseId === registration.leaseId
  );
}

function readNow(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError("runtime Git credential route clock is invalid");
  return value;
}

async function parseBody<T extends z.ZodType>(
  request: Request,
  schema: T,
): Promise<
  | { readonly ok: true; readonly value: z.infer<T> }
  | { readonly ok: false; readonly status: 400 | 413; readonly code: string }
> {
  let body: unknown;
  try {
    body = await boundedJson(request);
  } catch (error) {
    if (error instanceof RequestTooLargeError)
      return { ok: false, status: 413, code: "REQUEST_TOO_LARGE" };
    return { ok: false, status: 400, code: "INVALID_JSON" };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return { ok: false, status: 400, code: "INVALID_REQUEST" };
  return { ok: true, value: parsed.data };
}

async function boundedJson(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES)
    throw new RequestTooLargeError();
  if (request.body === null) throw new TypeError("request body is required");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new RequestTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body)) as unknown;
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

class RequestTooLargeError extends Error {}
