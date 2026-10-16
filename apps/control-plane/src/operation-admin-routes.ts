import { PublicOperationSchema } from "@praetorium/contracts";
import type { InstanceService } from "@praetorium/application/instances";
import type { OperationRecord } from "@praetorium/application/instances";
import { OPERATION_PHASES } from "@praetorium/application/operations";
import type { OperationService } from "@praetorium/application/operations";
import type { D1Database } from "@praetorium/persistence/d1";
import { Hono } from "hono";
import { z } from "zod";

const MAX_BODY_BYTES = 16_384;
const MAX_CURSOR_LENGTH = 4_096;
const MAX_PAGE_SIZE = 50;
const PathId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u);
const RetryRequestSchema = z.strictObject({
  actorId: z.string().min(1).max(128).refine(noControlCharacters),
  bindingEpoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  authorizationRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  expectedGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  idempotencyKey: z.string().min(1).max(128).refine(noControlCharacters),
});
const CursorSchema = z.strictObject({
  occurredAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  eventId: z.string().min(1).max(512),
});

const AUDIT_METADATA_KEYS = new Map<string, readonly string[]>([
  ["repository.binding.created", ["bindingEpoch"]],
  ["repository.binding.revalidated", ["bindingEpoch"]],
  ["repository.binding.suspended", []],
  ["instance.start", ["generation", "runtimeEpoch", "authorizationRevision"]],
  ["instance.stop", ["generation", "runtimeEpoch", "authorizationRevision"]],
  ["operation.reported", ["phase", "observationSequence", "observedRuntimeEpoch"]],
  ["runtime.reservation.released", ["retiredRuntimeEpoch"]],
]);
const OPERATION_PHASE_SET = new Set<string>(OPERATION_PHASES);
const ActorKindSchema = z.enum(["user", "system", "provisioner", "build-worker", "operator"]);

type AuditRow = {
  event_id: string;
  instance_id: string;
  operation_id: string | null;
  actor_id: string | null;
  actor_kind: string;
  action: string;
  outcome: string;
  metadata_json: string;
  occurred_at: number;
};

export type OperationAdminDependencies = {
  readonly db: D1Database;
  readonly instances: InstanceService;
  readonly operations: OperationService;
  readonly now?: () => number;
};

/**
 * Gateway-private management routes. The root Control Plane composition must authenticate
 * Gateway service requests before mounting these routes; actor identity is forwarded in the
 * strict retry body only after that trusted Gateway authorization decision.
 */
export function createOperationAdminRoutes(deps: OperationAdminDependencies) {
  const app = new Hono();

  app.get("/v1/instances/:instanceId/audit", async (c) => {
    const instanceId = PathId.parse(c.req.param("instanceId"));
    const { cursor, pageSize } = parseAuditQuery(c.req.url);
    const snapshot = await deps.instances.getByInstanceId(instanceId);
    if (!snapshot) return c.json({ error: { code: "REPOSITORY_NOT_FOUND" } }, 404);

    const base = `SELECT event_id, instance_id, operation_id, actor_id, actor_kind,
                         action, outcome, metadata_json, occurred_at
                    FROM audit_events WHERE instance_id = ?`;
    const statement = cursor
      ? deps.db
          .prepare(
            `${base} AND (occurred_at < ? OR (occurred_at = ? AND event_id < ?))
             ORDER BY occurred_at DESC, event_id DESC LIMIT ?`,
          )
          .bind(instanceId, cursor.occurredAt, cursor.occurredAt, cursor.eventId, pageSize + 1)
      : deps.db
          .prepare(`${base} ORDER BY occurred_at DESC, event_id DESC LIMIT ?`)
          .bind(instanceId, pageSize + 1);
    const rows = (await statement.all<AuditRow>()).results ?? [];
    const hasMore = rows.length > pageSize;
    const page = rows.slice(0, pageSize);
    const last = page.at(-1);
    return c.json({
      events: page.map(projectAuditEvent),
      nextCursor:
        hasMore && last
          ? encodeCursor({ occurredAt: last.occurred_at, eventId: last.event_id })
          : null,
    });
  });

  app.post("/v1/operations/:operationId/retry", async (c) => {
    const operationId = PathId.parse(c.req.param("operationId"));
    const input = RetryRequestSchema.parse(await boundedJson(c.req.raw));
    const oldOperation = await deps.operations.getById(operationId);
    if (!oldOperation) return c.json({ error: { code: "OPERATION_NOT_FOUND" } }, 404);
    const instanceId = oldOperation.instanceId;
    const snapshot = await deps.instances.getByInstanceId(instanceId);
    if (!snapshot) return c.json({ error: { code: "REPOSITORY_NOT_FOUND" } }, 404);
    if (
      snapshot.binding.instanceId !== instanceId ||
      snapshot.instance.instanceId !== instanceId ||
      oldOperation.repositoryId !== snapshot.binding.repositoryId ||
      oldOperation.repositoryId !== snapshot.instance.repositoryId
    ) {
      return c.json({ error: { code: "OPERATION_NOT_FOUND" } }, 404);
    }
    if (
      oldOperation.generation !== input.expectedGeneration ||
      (oldOperation.status !== "failed" && oldOperation.status !== "blocked")
    ) {
      return c.json({ error: { code: "OPERATION_RETRY_CONFLICT" } }, 409);
    }

    const requestId = trustedRequestId(c.req.header("X-Request-Id"));
    const desiredState = snapshot.instance.desiredState;
    const mutation = {
      repositoryId: snapshot.binding.repositoryId,
      bindingEpoch: input.bindingEpoch,
      authorizationRevision: input.authorizationRevision,
      desiredState,
      actorId: input.actorId,
      idempotencyKey: input.idempotencyKey,
      requestId,
      now: (deps.now ?? Date.now)(),
      expectedGeneration: input.expectedGeneration,
      ...(desiredState === "running" ? { forceNewRuntime: true } : {}),
    } as const;

    // Check the service's durable idempotency record first. After an accepted retry, the
    // instance generation has advanced, so the failed operation is no longer current.
    const prior = await deps.db
      .prepare(
        "SELECT operation_id FROM operations WHERE idempotency_scope = ? AND idempotency_key = ?",
      )
      .bind(`repository:${snapshot.binding.repositoryId}`, input.idempotencyKey)
      .first<{ operation_id: string }>();
    if (prior || snapshot.instance.generation !== input.expectedGeneration) {
      const replay = await deps.instances.requestDesiredState(mutation);
      if (
        !replay.operation ||
        !isRetryReceipt(replay.operation, oldOperation, input.expectedGeneration)
      ) {
        return c.json({ error: { code: "OPERATION_RETRY_CONFLICT" } }, 409);
      }
      return c.json(publicOperation(replay.operation));
    }

    if (snapshot.instance.generation !== input.expectedGeneration) {
      return c.json({ error: { code: "OPERATION_RETRY_CONFLICT" } }, 409);
    }
    const active = await deps.db
      .prepare(
        `SELECT operation_id FROM operations
          WHERE instance_id = ? AND generation = ?
            AND status IN ('pending', 'claimed', 'running') LIMIT 1`,
      )
      .bind(instanceId, input.expectedGeneration)
      .first<{ operation_id: string }>();
    if (active) return c.json({ error: { code: "OPERATION_RETRY_CONFLICT" } }, 409);

    const result = await deps.instances.requestDesiredState(mutation);
    if (
      !result.operation ||
      !isRetryReceipt(result.operation, oldOperation, input.expectedGeneration)
    ) {
      return c.json({ error: { code: "OPERATION_RETRY_CONFLICT" } }, 409);
    }
    return c.json(publicOperation(result.operation));
  });

  app.onError((error, c) => {
    if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof TypeError) {
      return c.json({ error: { code: "INVALID_REQUEST" } }, 400);
    }
    if (error instanceof RangeError) return c.json({ error: { code: "REQUEST_TOO_LARGE" } }, 413);
    const code = (error as { code?: string }).code;
    if (code === "REPOSITORY_NOT_FOUND") return c.json({ error: { code } }, 404);
    if (
      code === "REPOSITORY_STATE_CONFLICT" ||
      code === "REPOSITORY_BINDING_SUSPENDED" ||
      code === "OPERATION_RETRY_CONFLICT"
    ) {
      return c.json({ error: { code } }, 409);
    }
    return c.json({ error: { code: "OPERATION_ADMIN_UNAVAILABLE" } }, 503);
  });

  return app;
}

function parseAuditQuery(url: string): {
  readonly cursor: Cursor | null;
  readonly pageSize: number;
} {
  const params = new URL(url).searchParams;
  for (const key of params.keys()) {
    if (key !== "cursor" && key !== "limit") {
      throw new TypeError("unsupported audit query parameter");
    }
  }
  const cursorValues = params.getAll("cursor");
  const limitValues = params.getAll("limit");
  if (cursorValues.length > 1 || limitValues.length > 1) {
    throw new TypeError("duplicate query parameter");
  }
  const limitValue = limitValues[0];
  if (limitValue !== undefined && !/^[1-9][0-9]*$/u.test(limitValue)) {
    throw new TypeError("audit page size must be a decimal integer");
  }
  const pageSize = limitValue === undefined ? MAX_PAGE_SIZE : Number(limitValue);
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new TypeError("audit page size must be between 1 and 50");
  }
  const cursorValue = cursorValues[0];
  return {
    cursor: cursorValue === undefined ? null : decodeCursor(cursorValue),
    pageSize,
  };
}

type Cursor = z.infer<typeof CursorSchema>;

function decodeCursor(value: string): Cursor {
  if (value.length < 1 || value.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new TypeError("audit cursor is invalid");
  }
  const standard = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const binary = atob(standard + "=".repeat((4 - (standard.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const parsed = CursorSchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
  if (encodeCursor(parsed) !== value) throw new TypeError("audit cursor is not canonical");
  return parsed;
}

function encodeCursor(cursor: Cursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function projectAuditEvent(row: AuditRow) {
  const actorKind = ActorKindSchema.parse(row.actor_kind);
  const action = safeIdentifier(row.action, 128) ?? "invalid";
  const outcome = safeIdentifier(row.outcome, 32) ?? "invalid";
  return {
    eventId: boundedString(row.event_id, 512),
    instanceId: boundedString(row.instance_id, 128),
    operationId: row.operation_id === null ? null : boundedString(row.operation_id, 128),
    actorId: row.actor_id === null ? null : boundedString(row.actor_id, 128),
    actorKind,
    action,
    outcome,
    occurredAt: Number.isSafeInteger(row.occurred_at) && row.occurred_at >= 0 ? row.occurred_at : 0,
    metadata: projectAuditMetadata(action, row.metadata_json),
  };
}

function projectAuditMetadata(
  action: string,
  raw: string,
): Readonly<Record<string, number | string>> {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const projected: Record<string, number | string> = {};
  for (const key of AUDIT_METADATA_KEYS.get(action) ?? []) {
    const field = source[key];
    if (key === "phase") {
      if (typeof field === "string" && OPERATION_PHASE_SET.has(field)) projected[key] = field;
    } else if (typeof field === "number" && Number.isSafeInteger(field) && field >= 0) {
      projected[key] = field;
    }
  }
  return projected;
}

function publicOperation(operation: OperationRecord) {
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

function isRetryReceipt(
  operation: OperationRecord,
  oldOperation: OperationRecord,
  expectedGeneration: number,
): boolean {
  return (
    operation.instanceId === oldOperation.instanceId &&
    operation.repositoryId === oldOperation.repositoryId &&
    operation.id !== oldOperation.id &&
    operation.generation === expectedGeneration + 1
  );
}

function trustedRequestId(value: string | undefined): string {
  return value && value.length <= 128 && /^[A-Za-z0-9_.:-]+$/u.test(value)
    ? value
    : crypto.randomUUID();
}

function noControlCharacters(value: string): boolean {
  return ![...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function safeIdentifier(value: string, maxLength: number): string | null {
  return value.length <= maxLength && /^[a-z][a-z0-9._-]*$/u.test(value) ? value : null;
}

function boundedString(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

async function boundedJson(request: Request): Promise<unknown> {
  if (!isJsonContentType(request.headers.get("content-type"))) {
    throw new TypeError("JSON content type required");
  }
  const contentLength = request.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^\d+$/u.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)
  ) {
    throw new RangeError("request body exceeded its bound");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new TypeError("JSON body required");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new RangeError("request body exceeded its bound");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

function isJsonContentType(value: string | null): boolean {
  return value !== null && /^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(value.trim());
}
