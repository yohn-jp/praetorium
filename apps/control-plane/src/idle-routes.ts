import { z } from "zod";
import type { OperationRecord, RepositorySnapshot } from "@praetorium/application/instances";
import type { D1DesiredStateInput, D1PlatformStore, D1Database } from "@praetorium/persistence/d1";
import type { ClaimedOperation } from "@praetorium/application/operations";
import { Hono } from "hono";
import type { ControlCredentialIssuer } from "./control-credentials.js";
import {
  scheduleWorkNotification,
  type WorkNotificationDispatcher,
} from "./work-notification-scheduler.js";

const Id = z.string().min(1).max(128);
const Counter = z.number().int().nonnegative();
const PositiveCounter = z.number().int().positive();
const RepositoryId = z.number().int().positive().safe();

const IdleCandidatesInputSchema = z.strictObject({
  workerId: Id,
  clusterId: Id,
  limit: z.number().int().min(1).max(25),
  cursor: z.string().min(1).max(128).nullable(),
});

const IdleStopInputSchema = z.strictObject({
  workerId: Id,
  clusterId: Id,
  instanceId: Id,
  repositoryId: RepositoryId,
  expectedGeneration: Counter,
  expectedRuntimeEpoch: PositiveCounter,
});

const ObservationCredentialInputSchema = z.strictObject({
  workerId: Id,
  clusterId: Id,
  instanceId: Id,
  repositoryId: RepositoryId,
  expectedGeneration: Counter,
  runtimeEpoch: PositiveCounter,
});

interface IdleCandidateRow {
  readonly instance_id: string;
  readonly repository_id: number;
  readonly generation: number;
  readonly runtime_epoch: number;
  readonly cluster_id: string;
  readonly has_active_operation: number;
}

export interface ProvisionerIdleRoutesDependencies {
  readonly db: D1Database;
  readonly store: Pick<
    D1PlatformStore,
    "getByInstanceId" | "getDeploymentRevision" | "requestDesiredStateWithFence"
  >;
  readonly credentialIssuer: Pick<ControlCredentialIssuer, "issueObservation">;
  readonly workerId: string;
  readonly clusterId: string;
  readonly now: () => number;
  readonly newOperationId: () => string;
  readonly notifyWorkAvailable?: WorkNotificationDispatcher;
  readonly resolveCurrentRuntime: (
    snapshot: RepositorySnapshot,
    revision: NonNullable<ClaimedOperation["currentDeploymentRevision"]>,
  ) => Promise<unknown>;
}

/** Internal idle lifecycle entry points. Mount under the authenticated provisioner prefix. */
export function createProvisionerIdleRoutes(deps: ProvisionerIdleRoutesDependencies) {
  const app = new Hono();
  const scopeMatches = (input: { readonly workerId: string; readonly clusterId: string }) =>
    input.workerId === deps.workerId && input.clusterId === deps.clusterId;

  app.post("/idle-candidates", async (c) => {
    const input = IdleCandidatesInputSchema.parse(await readBoundedJson(c.req.raw));
    if (!scopeMatches(input)) return scopeMismatch(c);

    const rows = await deps.db
      .prepare(
        `SELECT i.instance_id, i.repository_id, i.generation, i.runtime_epoch,
                r.cluster_id,
                EXISTS (
                  SELECT 1 FROM operations o
                  WHERE o.instance_id = i.instance_id AND o.status IN ('pending', 'claimed', 'running')
                ) AS has_active_operation
         FROM logical_instances i
         JOIN repository_bindings b
           ON b.repository_id = i.repository_id AND b.instance_id = i.instance_id
         JOIN runtime_reservations r
           ON r.instance_id = i.instance_id
          AND r.runtime_epoch = i.observed_runtime_epoch
          AND r.status IN ('reserved', 'allocated')
         WHERE r.cluster_id = ?
           AND i.observed_state = 'ready'
           AND i.observed_generation = i.generation
           AND i.observed_runtime_epoch = i.runtime_epoch
           AND (? IS NULL OR i.instance_id > ?)
         ORDER BY i.instance_id
         LIMIT ?`,
      )
      .bind(input.clusterId, input.cursor, input.cursor, input.limit + 1)
      .all<IdleCandidateRow>();
    const hasMore = rows.results.length > input.limit;
    const candidates = rows.results.slice(0, input.limit);
    const items = [];
    for (const row of candidates) {
      const snapshot = await deps.store.getByInstanceId(row.instance_id);
      if (!isCurrentCandidate(snapshot, row, input.clusterId)) continue;
      const revisionId = snapshot.instance.observedRevisionId;
      if (!revisionId) return unavailable(c, "RUNTIME_CONTEXT_UNAVAILABLE");
      const revision = await deps.store.getDeploymentRevision(revisionId);
      if (!revision) return unavailable(c, "RUNTIME_CONTEXT_UNAVAILABLE");
      let currentRuntime: unknown;
      try {
        currentRuntime = await deps.resolveCurrentRuntime(snapshot, revision);
      } catch {
        return unavailable(c, "RUNTIME_CONTEXT_UNAVAILABLE");
      }
      if (currentRuntime === null || currentRuntime === undefined)
        return unavailable(c, "RUNTIME_CONTEXT_UNAVAILABLE");
      const healthOperation = await deps.db
        .prepare(
          `SELECT operation_id FROM operations WHERE instance_id=? AND repository_id=?
         AND runtime_epoch=? AND deployment_revision_id=? AND status='succeeded'
         AND kind IN ('start','update','redeploy') ORDER BY updated_at DESC LIMIT 1`,
        )
        .bind(
          snapshot.instance.instanceId,
          snapshot.binding.repositoryId,
          snapshot.instance.observedRuntimeEpoch,
          revisionId,
        )
        .first<{ operation_id: string }>();
      items.push({
        instanceId: snapshot.instance.instanceId,
        repositoryId: snapshot.binding.repositoryId,
        generation: snapshot.instance.generation,
        runtimeEpoch: snapshot.instance.runtimeEpoch,
        clusterId: input.clusterId,
        desiredState: snapshot.instance.desiredState,
        bindingSuspended: snapshot.binding.suspended,
        hasActiveOperation: row.has_active_operation === 1,
        currentRuntime,
        healthOperationId: healthOperation?.operation_id ?? null,
      });
    }
    return c.json({
      items,
      nextCursor: hasMore ? (candidates.at(-1)?.instance_id ?? null) : null,
    });
  });

  app.post("/idle-stop", async (c) => {
    const input = IdleStopInputSchema.parse(await readBoundedJson(c.req.raw));
    if (!scopeMatches(input)) return scopeMismatch(c);
    const snapshot = await deps.store.getByInstanceId(input.instanceId);
    if (
      !snapshot ||
      snapshot.binding.repositoryId !== input.repositoryId ||
      !isStopCandidate(snapshot, input)
    )
      return conflict(c);

    const now = deps.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("invalid idle route clock");
    const operationId = deps.newOperationId();
    if (!Id.safeParse(operationId).success)
      throw new TypeError("invalid operation ID factory result");
    const request = {
      purpose: "provisioner-idle-stop",
      workerId: input.workerId,
      clusterId: input.clusterId,
      instanceId: input.instanceId,
      repositoryId: input.repositoryId,
      expectedGeneration: input.expectedGeneration,
      expectedRuntimeEpoch: input.expectedRuntimeEpoch,
    };
    const inputHash = await sha256(JSON.stringify(request));
    const operation = stopOperation(snapshot, operationId, input.clusterId, now, inputHash);
    const desiredState: D1DesiredStateInput = {
      snapshot,
      expectedGeneration: input.expectedGeneration,
      desiredState: "stopped",
      nextRuntimeEpoch: snapshot.instance.runtimeEpoch,
      operation,
      requestHash: inputHash,
      actorId: input.workerId,
      actorKind: "provisioner",
      authorizationRevision: snapshot.binding.authorizationRevision,
      requestId: null,
      now,
      expectedPolicy: snapshot.instance.policy,
      expectedDesiredState: "running",
      expectedDesiredRevisionId: snapshot.instance.desiredRevisionId,
      expectedReservationId: snapshot.instance.reservationId,
      expectedClusterId: input.clusterId,
      expectedObservedRuntimeEpoch: input.expectedRuntimeEpoch,
    };
    const fence = deps.db
      .prepare(
        `UPDATE logical_instances
         SET updated_at = updated_at
         WHERE instance_id = ? AND repository_id = ?
           AND generation = ? AND observed_generation = ?
           AND runtime_epoch = ? AND observed_runtime_epoch = ?
           AND desired_state = 'running' AND observed_state = 'ready'
           AND EXISTS (
             SELECT 1 FROM repository_bindings b
             WHERE b.instance_id = logical_instances.instance_id
               AND b.repository_id = logical_instances.repository_id AND b.suspended = 0
           )
           AND EXISTS (
             SELECT 1 FROM runtime_reservations r
             WHERE r.instance_id = logical_instances.instance_id
               AND r.runtime_epoch = logical_instances.observed_runtime_epoch
               AND r.cluster_id = ? AND r.status IN ('reserved', 'allocated')
           )
           AND NOT EXISTS (
             SELECT 1 FROM operations o
             WHERE o.instance_id = logical_instances.instance_id
               AND o.status IN ('pending', 'claimed', 'running')
           )`,
      )
      .bind(
        input.instanceId,
        input.repositoryId,
        input.expectedGeneration,
        input.expectedGeneration,
        input.expectedRuntimeEpoch,
        input.expectedRuntimeEpoch,
        input.clusterId,
      );
    const result = await deps.store.requestDesiredStateWithFence(desiredState, [fence]);
    if (!result?.operation) return conflict(c);
    try {
      scheduleWorkNotification(c.executionCtx, deps.notifyWorkAvailable, "operation");
    } catch {
      // The fenced idle-stop operation was durably accepted already.
    }
    return c.json({ operationId: result.operation.id });
  });

  app.post("/observation-credential", async (c) => {
    const input = ObservationCredentialInputSchema.parse(await readBoundedJson(c.req.raw));
    if (!scopeMatches(input)) return scopeMismatch(c);
    const operationId = deps.newOperationId();
    if (!Id.safeParse(operationId).success)
      throw new TypeError("invalid operation ID factory result");
    try {
      const credential = await deps.credentialIssuer.issueObservation({
        operationId,
        workerId: input.workerId,
        clusterId: input.clusterId,
        instanceId: input.instanceId,
        repositoryId: input.repositoryId,
        expectedGeneration: input.expectedGeneration,
        runtimeEpoch: input.runtimeEpoch,
      });
      return c.json({ ...credential, operationId });
    } catch (error) {
      if ((error as { readonly code?: string }).code === "CONTROL_CREDENTIAL_FENCED")
        return conflict(c, "CONTROL_CREDENTIAL_FENCED");
      return unavailable(c, "CONTROL_CREDENTIAL_UNAVAILABLE");
    }
  });

  return app;
}

async function readBoundedJson(request: Request): Promise<unknown> {
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

function isCurrentCandidate(
  snapshot: RepositorySnapshot | null,
  row: IdleCandidateRow,
  clusterId: string,
): snapshot is RepositorySnapshot {
  return Boolean(
    snapshot &&
      snapshot.binding.repositoryId === row.repository_id &&
      snapshot.binding.instanceId === row.instance_id &&
      snapshot.instance.instanceId === row.instance_id &&
      snapshot.instance.generation === row.generation &&
      snapshot.instance.runtimeEpoch === row.runtime_epoch &&
      snapshot.instance.observedGeneration === row.generation &&
      snapshot.instance.observedRuntimeEpoch === row.runtime_epoch &&
      snapshot.instance.observedState === "ready" &&
      snapshot.instance.clusterId === clusterId &&
      row.cluster_id === clusterId,
  );
}

function isStopCandidate(
  snapshot: RepositorySnapshot,
  input: z.infer<typeof IdleStopInputSchema>,
): boolean {
  return (
    snapshot.binding.instanceId === input.instanceId &&
    snapshot.instance.instanceId === input.instanceId &&
    snapshot.instance.repositoryId === input.repositoryId &&
    snapshot.instance.generation === input.expectedGeneration &&
    snapshot.instance.observedGeneration === input.expectedGeneration &&
    snapshot.instance.runtimeEpoch === input.expectedRuntimeEpoch &&
    snapshot.instance.observedRuntimeEpoch === input.expectedRuntimeEpoch &&
    snapshot.instance.clusterId === input.clusterId &&
    snapshot.instance.desiredState === "running" &&
    snapshot.instance.observedState === "ready" &&
    !snapshot.binding.suspended
  );
}

function stopOperation(
  snapshot: RepositorySnapshot,
  operationId: string,
  clusterId: string,
  now: number,
  requestHash: string,
): OperationRecord {
  const generation = snapshot.instance.generation + 1;
  return {
    id: operationId,
    instanceId: snapshot.instance.instanceId,
    repositoryId: snapshot.binding.repositoryId,
    generation,
    runtimeEpoch: snapshot.instance.runtimeEpoch,
    kind: "stop",
    status: "pending",
    attempt: 0,
    leaseEpoch: 0,
    reportSequence: 0,
    leaseExpiresAt: null,
    clusterId,
    reservationId: null,
    deploymentRevisionId: snapshot.instance.desiredRevisionId,
    buildId: null,
    prerequisiteBuildId: null,
    idempotencyKey: operationId,
    phase: "accepted",
    workerId: null,
    leaseToken: null,
    requestHash,
    checkpointSequence: 0,
    checkpoint: null,
    result: null,
    createdAt: now,
    updatedAt: now,
  };
}

async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function scopeMismatch(c: { json(value: unknown, status?: number): Response }) {
  return c.json({ error: { code: "WORKER_SCOPE_MISMATCH" } }, 403);
}

function conflict(
  c: { json(value: unknown, status?: number): Response },
  code = "IDLE_STOP_FENCE_CONFLICT",
) {
  return c.json({ error: { code } }, 409);
}

function unavailable(c: { json(value: unknown, status?: number): Response }, code: string) {
  return c.json({ error: { code } }, 503);
}
