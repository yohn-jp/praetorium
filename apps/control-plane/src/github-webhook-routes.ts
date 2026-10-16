import { constantTimeEqual } from "@praetorium/auth";
import type { D1Database } from "@praetorium/persistence/d1";
import { Hono } from "hono";
import { z } from "zod";

const DeliveryId = z.string().regex(/^[A-Za-z0-9-]{1,128}$/);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const EventName = z.string().regex(/^[a-z_]{1,64}$/);
const Action = z
  .string()
  .regex(/^[a-z_]{1,64}$/)
  .nullable();
const PositiveId = z.number().int().positive().safe();
const WebhookInput = z.strictObject({
  deliveryId: DeliveryId,
  bodyDigest: Digest,
  event: EventName,
  action: Action,
  installationId: PositiveId.nullable(),
  repositoryIds: z.array(PositiveId).max(100),
});

export type GitHubWebhookDelivery = z.infer<typeof WebhookInput>;

interface DeliveryReceiptRow {
  readonly metadata_json: string;
}

interface ReceiptMetadata {
  readonly bodyDigest: string;
}

export interface GitHubWebhookRoutesDependencies {
  readonly db: D1Database;
  readonly gatewaySecret: string;
  readonly now?: () => number;
}

type InvalidationScope =
  | { readonly installationId: number; readonly repositoryIds: null; readonly reason: string }
  | {
      readonly installationId: number;
      readonly repositoryIds: readonly number[];
      readonly reason: string;
    };

/** Private endpoint for the Gateway's HMAC-verified, bounded webhook summary. */
export function createGitHubWebhookRoutes(deps: GitHubWebhookRoutesDependencies) {
  if (deps.gatewaySecret.length < 32) throw new TypeError("Gateway service secret required");
  const app = new Hono();

  app.post("/internal/github/webhook", async (c) => {
    if (!constantTimeEqual(c.req.header("X-Control-Plane-Gateway-Auth") ?? "", deps.gatewaySecret))
      return c.json({ error: { code: "UNAUTHORIZED" } }, 401);

    const inputResult = WebhookInput.safeParse(await readBoundedJson(c.req.raw));
    if (!inputResult.success) return c.json({ error: { code: "INVALID_REQUEST" } }, 400);
    const input = inputResult.data;
    if (new Set(input.repositoryIds).size !== input.repositoryIds.length)
      return c.json({ error: { code: "INVALID_REQUEST" } }, 400);

    const now = (deps.now ?? Date.now)();
    if (!Number.isSafeInteger(now) || now < 0)
      throw new TypeError("invalid GitHub webhook route clock");

    try {
      await applyDelivery(deps.db, input, now);
      return c.json({ status: "accepted" }, 202);
    } catch {
      const receipt = await readReceipt(deps.db, input.deliveryId).catch(() => null);
      if (receipt) {
        const metadata = parseReceiptMetadata(receipt.metadata_json);
        if (!metadata) return c.json({ error: { code: "WEBHOOK_RECEIPT_UNAVAILABLE" } }, 503);
        if (metadata.bodyDigest !== input.bodyDigest)
          return c.json({ error: { code: "WEBHOOK_DELIVERY_CONFLICT" } }, 409);
        return c.json({ status: "duplicate" }, 200);
      }
      return c.json({ error: { code: "WEBHOOK_PROCESSING_UNAVAILABLE" } }, 503);
    }
  });

  return app;
}

async function applyDelivery(
  db: D1Database,
  input: GitHubWebhookDelivery,
  now: number,
): Promise<void> {
  const receiptId = `github:delivery:${input.deliveryId}`;
  const receiptMetadata = JSON.stringify({
    bodyDigest: input.bodyDigest,
    event: input.event,
    action: input.action,
    installationId: input.installationId,
    repositoryIds: input.repositoryIds,
    repositoryCount: input.repositoryIds.length,
  });
  const statements = [
    db
      .prepare(
        `INSERT INTO audit_events (
         event_id, repository_id, instance_id, operation_id, actor_id, actor_kind,
         action, outcome, request_id, metadata_json, occurred_at
       ) VALUES (?, NULL, NULL, NULL, NULL, 'system', 'github.webhook.delivery', 'accepted', ?, ?, ?)`,
      )
      .bind(receiptId, input.deliveryId, receiptMetadata, now),
  ];

  const scope = invalidationScope(input);
  if (!scope) {
    await db.batch(statements);
    return;
  }

  const target = targetBindings(scope);
  const suspensionMetadata = JSON.stringify({
    deliveryId: input.deliveryId,
    bodyDigest: input.bodyDigest,
    event: input.event,
    action: input.action,
    installationId: scope.installationId,
    reason: scope.reason,
  });

  statements.push(
    db
      .prepare(
        `INSERT INTO audit_events (
         event_id, repository_id, instance_id, operation_id, actor_id, actor_kind,
         action, outcome, request_id, metadata_json, occurred_at
       ) SELECT 'github:binding:' || ? || ':' || repository_id,
                repository_id, instance_id, NULL, NULL, 'system',
                'repository.binding.suspended', 'accepted', ?, ?, ?
         FROM repository_bindings WHERE ${target.clause}`,
      )
      .bind(input.deliveryId, input.deliveryId, suspensionMetadata, now, ...target.values),
    db
      .prepare(
        `INSERT INTO audit_events (
         event_id, repository_id, instance_id, operation_id, actor_id, actor_kind,
         action, outcome, request_id, metadata_json, occurred_at
       ) SELECT 'github:operation:' || ? || ':' || o.operation_id,
                o.repository_id, o.instance_id, o.operation_id, NULL, 'system',
                'operation.invalidated', 'accepted', ?, ?, ?
         FROM operations o
         WHERE o.status IN ('pending', 'claimed', 'running') AND o.kind <> 'stop'
           AND EXISTS (
             SELECT 1 FROM repository_bindings b
             WHERE b.repository_id = o.repository_id AND b.instance_id = o.instance_id
               AND ${target.clause}
           )`,
      )
      .bind(input.deliveryId, input.deliveryId, suspensionMetadata, now, ...target.values),
    db
      .prepare(
        `UPDATE repository_bindings
       SET suspended = 1, binding_epoch = binding_epoch + 1, updated_at = ?
       WHERE suspended = 0 AND ${target.clause}`,
      )
      .bind(now, ...target.values),
    db
      .prepare(
        `UPDATE operations
       SET status = 'blocked', phase = 'binding-suspended', worker_id = NULL,
           lease_token = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE status IN ('pending', 'claimed', 'running') AND kind <> 'stop'
         AND EXISTS (
           SELECT 1 FROM audit_events binding_event
           WHERE binding_event.event_id = 'github:binding:' || ? || ':' || operations.repository_id
             AND binding_event.action = 'repository.binding.suspended'
             AND operations.instance_id = (
               SELECT b.instance_id FROM repository_bindings b
               WHERE b.repository_id = operations.repository_id
             )
         )`,
      )
      .bind(now, input.deliveryId),
  );

  await db.batch(statements);
}

function invalidationScope(input: GitHubWebhookDelivery): InvalidationScope | null {
  if (input.installationId === null) return null;
  if (input.event === "installation" && (input.action === "deleted" || input.action === "suspend"))
    return {
      installationId: input.installationId,
      repositoryIds: null,
      reason: `GitHub installation ${input.action}`,
    };
  if (input.event === "installation_repositories" && input.action === "removed") {
    if (input.repositoryIds.length === 0) return null;
    return {
      installationId: input.installationId,
      repositoryIds: input.repositoryIds,
      reason: "GitHub installation removed repository access",
    };
  }
  if (
    input.event === "repository" &&
    (input.action === "transferred" || input.action === "renamed")
  ) {
    if (input.repositoryIds.length !== 1) return null;
    return {
      installationId: input.installationId,
      repositoryIds: input.repositoryIds,
      reason: `GitHub repository ${input.action}`,
    };
  }
  return null;
}

function targetBindings(scope: InvalidationScope): { clause: string; values: readonly number[] } {
  if (scope.repositoryIds === null)
    return { clause: "installation_id = ? AND suspended = 0", values: [scope.installationId] };
  const placeholders = scope.repositoryIds.map(() => "?").join(", ");
  return {
    clause: `installation_id = ? AND repository_id IN (${placeholders}) AND suspended = 0`,
    values: [scope.installationId, ...scope.repositoryIds],
  };
}

async function readReceipt(db: D1Database, deliveryId: string): Promise<DeliveryReceiptRow | null> {
  return db
    .prepare(
      "SELECT metadata_json FROM audit_events WHERE event_id = ? AND action = 'github.webhook.delivery'",
    )
    .bind(`github:delivery:${deliveryId}`)
    .first<DeliveryReceiptRow>();
}

function parseReceiptMetadata(value: string): ReceiptMetadata | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "bodyDigest" in parsed &&
      typeof parsed.bodyDigest === "string" &&
      /^[a-f0-9]{64}$/.test(parsed.bodyDigest)
    )
      return { bodyDigest: parsed.bodyDigest };
    return null;
  } catch {
    return null;
  }
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const maxBytes = 16_384;
  const length = request.headers.get("Content-Length");
  if (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > maxBytes))
    return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return null;
  }
}
