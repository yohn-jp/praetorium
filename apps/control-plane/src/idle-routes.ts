import { z } from "zod";
import type { OperationRecord, RepositorySnapshot } from "@praetorium/application/instances";
import type { D1DesiredStateInput, D1PlatformStore, D1Database } from "@praetorium/persistence/d1";
import type { ClaimedOperation } from "@praetorium/application/operations";
import { Hono } from "hono";
import {
  RuntimeIdleCandidateRequestSchema,
  RuntimeCanaryHealthDueRequestSchema,
  RuntimeCanaryHealthDueResponseSchema,
} from "@praetorium/contracts";
import type { ControlCredentialIssuer } from "./control-credentials.js";
import {
  scheduleWorkNotification,
  type WorkNotificationDispatcher,
} from "./work-notification-scheduler.js";

const Id = z.string().min(1).max(128);
const Counter = z.number().int().nonnegative();
const PositiveCounter = z.number().int().positive();
const RepositoryId = z.number().int().positive().safe();
const INACTIVE_CANARY_HEALTH_DUE = {
  active: false,
  nextCheckAt: null,
  sampleDueAt: null,
  healthOperationId: null,
} as const;

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

interface IdleCandidate {
  readonly instanceId: string;
  readonly repositoryId: number;
  readonly generation: number;
  readonly runtimeEpoch: number;
  readonly clusterId: string;
  readonly desiredState: string;
  readonly bindingSuspended: boolean;
  readonly hasActiveOperation: boolean;
  readonly currentRuntime: unknown;
  readonly healthOperationId: string | null;
  readonly activeCanaryHealth: boolean;
  readonly healthNextCheckAt: number | null;
}

type IdleCandidateResolution =
  | { readonly kind: "candidate"; readonly candidate: IdleCandidate }
  | { readonly kind: "unavailable" };

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
  readonly canaryHealthSchedule?: (input: {
    readonly instanceId: string;
    readonly repositoryId: number;
    readonly generation: number;
    readonly runtimeEpoch: number;
    readonly clusterId: string;
    readonly now: number;
  }) => Promise<{
    readonly healthOperationId: string;
    readonly nextCheckAt: number;
    readonly sampleDueAt: number | null;
  } | null>;
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

  const resolveCandidate = async (
    row: IdleCandidateRow,
    clusterId: string,
  ): Promise<IdleCandidateResolution | null> => {
    const snapshot = await deps.store.getByInstanceId(row.instance_id);
    if (!isCurrentCandidate(snapshot, row, clusterId)) return null;
    const revisionId = snapshot.instance.observedRevisionId;
    if (!revisionId) return { kind: "unavailable" };
    const revision = await deps.store.getDeploymentRevision(revisionId);
    if (!revision) return { kind: "unavailable" };
    let currentRuntime: unknown;
    try {
      currentRuntime = await deps.resolveCurrentRuntime(snapshot, revision);
    } catch {
      return { kind: "unavailable" };
    }
    if (currentRuntime === null || currentRuntime === undefined)
      return { kind: "unavailable" };
    const [healthOperation, canaryHealth] = await Promise.all([
      deps.db
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
        .first<{ operation_id: string }>(),
      deps.canaryHealthSchedule?.({
        instanceId: snapshot.instance.instanceId,
        repositoryId: snapshot.binding.repositoryId,
        generation: snapshot.instance.generation,
        runtimeEpoch: snapshot.instance.runtimeEpoch,
        clusterId,
        now: deps.now(),
      }) ?? Promise.resolve(null),
    ]);
    return {
      kind: "candidate",
      candidate: {
        instanceId: snapshot.instance.instanceId,
        repositoryId: snapshot.binding.repositoryId,
        generation: snapshot.instance.generation,
        runtimeEpoch: snapshot.instance.runtimeEpoch,
        clusterId,
        desiredState: snapshot.instance.desiredState,
        bindingSuspended: snapshot.binding.suspended,
        hasActiveOperation: row.has_active_operation === 1,
        currentRuntime,
        healthOperationId: canaryHealth?.healthOperationId ?? healthOperation?.operation_id ?? null,
        activeCanaryHealth: canaryHealth !== null,
        healthNextCheckAt: canaryHealth?.sampleDueAt ?? canaryHealth?.nextCheckAt ?? null,
      },
    };
  };

  app.post("/idle-candidates", async (c) => {
    const input = IdleCandidatesInputSchema.parse(await readBoundedJson(c.req.raw));
    if (!scopeMatches(input)) return scopeMismatch(c);

    const candidateRows = await readIdleCandidateRows(deps.db, {
      clusterId: input.clusterId,
      cursor: input.cursor,
      limit: input.limit + 1,
    });
    const hasMore = candidateRows.length > input.limit;
    const candidates = candidateRows.slice(0, input.limit);
    const items: IdleCandidate[] = [];
    for (const row of candidates) {
      const resolution = await resolveCandidate(row, input.clusterId);
      if (resolution === null) continue;
      if (resolution.kind === "unavailable") return unavailable(c, "RUNTIME_CONTEXT_UNAVAILABLE");
      items.push(resolution.candidate);
    }
    return c.json({
      items,
      nextCursor: hasMore ? (candidates.at(-1)?.instance_id ?? null) : null,
    });
  });

  app.post("/idle-candidate", async (c) => {
    const input = RuntimeIdleCandidateRequestSchema.parse(await readBoundedJson(c.req.raw));
    if (!scopeMatches(input)) return scopeMismatch(c);
    const [row] = await readIdleCandidateRows(deps.db, {
      clusterId: input.clusterId,
      instanceId: input.instanceId,
    });
    if (!row) return c.json(null);
    const resolution = await resolveCandidate(row, input.clusterId);
    if (!resolution) return c.json(null);
    if (resolution.kind === "unavailable") return unavailable(c, "RUNTIME_CONTEXT_UNAVAILABLE");
    return c.json(resolution.candidate);
  });

  app.post("/runtime-health-due", async (c) => {
    const input = RuntimeCanaryHealthDueRequestSchema.parse(await readBoundedJson(c.req.raw));
    if (!scopeMatches(input)) return scopeMismatch(c);
    const snapshot = await deps.store.getByInstanceId(input.instanceId);
    if (!isCurrentHealthScheduleAssignment(snapshot, input))
      return c.json(INACTIVE_CANARY_HEALTH_DUE);
    if (!deps.canaryHealthSchedule) return c.json(INACTIVE_CANARY_HEALTH_DUE);
    const now = deps.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("invalid idle route clock");
    const schedule = await deps.canaryHealthSchedule({
      instanceId: input.instanceId,
      repositoryId: input.repositoryId,
      generation: input.expectedGeneration,
      runtimeEpoch: input.expectedRuntimeEpoch,
      clusterId: input.clusterId,
      now,
    });
    if (!schedule) return c.json(INACTIVE_CANARY_HEALTH_DUE);
    const response = RuntimeCanaryHealthDueResponseSchema.parse({
      active: true,
      nextCheckAt: schedule.nextCheckAt,
      sampleDueAt: schedule.sampleDueAt,
      healthOperationId: schedule.healthOperationId,
    });
    return c.json(response);
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
           )
           AND NOT EXISTS (
             SELECT 1 FROM release_candidate_workflows w
             WHERE (
               w.state = 'canary_starting'
               AND EXISTS (
                 SELECT 1 FROM idempotency_records plan
                 JOIN deployment_revisions canary_revision
                   ON canary_revision.revision_id = plan.response_id
                 WHERE plan.scope = 'repository:' || CAST(logical_instances.repository_id AS TEXT)
                   AND plan.idempotency_key = 'stable-canary-plan:' || w.release_id
                   AND plan.response_kind = 'configuration-plan'
                   AND canary_revision.instance_id = logical_instances.instance_id
                   AND canary_revision.repository_id = logical_instances.repository_id
                   AND canary_revision.actor_id = 'system:stable-release-canary'
                   AND json_extract(canary_revision.selection_json, '$.releaseId') = w.release_id
               )
             ) OR (
               w.state IN ('canary_observing', 'canary_cleanup')
               AND w.canary_runtime_id = logical_instances.instance_id
             )
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
      scheduleWorkNotification(c.executionCtx, deps.notifyWorkAvailable, "operation", input.instanceId);
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

async function readIdleCandidateRows(
  db: D1Database,
  input: {
    readonly clusterId: string;
    readonly cursor?: string | null;
    readonly limit?: number;
    readonly instanceId?: string;
  },
): Promise<readonly IdleCandidateRow[]> {
  const instanceFilter = input.instanceId === undefined
    ? "AND (? IS NULL OR i.instance_id > ?)"
    : "AND i.instance_id = ?";
  const statement = db.prepare(
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
         ${instanceFilter}
       ORDER BY i.instance_id
       LIMIT ?`,
  );
  const rows =
    input.instanceId === undefined
      ? await statement
          .bind(input.clusterId, input.cursor ?? null, input.cursor ?? null, input.limit ?? 26)
          .all<IdleCandidateRow>()
      : await statement
          .bind(input.clusterId, input.instanceId, 1)
          .all<IdleCandidateRow>();
  return rows.results;
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

function isCurrentHealthScheduleAssignment(
  snapshot: RepositorySnapshot | null,
  input: z.infer<typeof RuntimeCanaryHealthDueRequestSchema>,
): snapshot is RepositorySnapshot {
  return Boolean(
    snapshot &&
      !snapshot.binding.suspended &&
      snapshot.binding.instanceId === input.instanceId &&
      snapshot.binding.repositoryId === input.repositoryId &&
      snapshot.instance.instanceId === input.instanceId &&
      snapshot.instance.repositoryId === input.repositoryId &&
      snapshot.instance.generation === input.expectedGeneration &&
      snapshot.instance.observedGeneration === input.expectedGeneration &&
      snapshot.instance.runtimeEpoch === input.expectedRuntimeEpoch &&
      snapshot.instance.observedRuntimeEpoch === input.expectedRuntimeEpoch &&
      snapshot.instance.desiredState === "running" &&
      snapshot.instance.observedState === "ready" &&
      snapshot.instance.clusterId === input.clusterId,
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
