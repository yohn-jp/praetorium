import {
  CanaryCleanupEvidenceSchema,
  CanaryHealthEvidenceSchema,
  ReleaseCandidateSchema,
  type CandidateWorkLease,
  type CandidateWorkflow,
  type CursorPage,
  type DiscoveryCheckpoint,
  type ReleaseAdmissionRepository,
  type ReleaseCandidate,
  type ReleasePromotionRepository,
  type StableReleaseChannel,
  type DisposableCanaryBinding,
} from "@praetorium/application/releases";
import {
  stableRolloutStageIdempotencyKey,
  type ClusterRolloutLease,
  type OperationObservation,
  type StableFollower,
  type StableRollout,
  type StableRolloutRepository,
} from "@praetorium/application/rollouts";
import type { D1Database, D1PreparedStatement, D1Result } from "@praetorium/persistence/d1";
import type {
  CanaryWaitSkipCommand,
  ReleaseRetryCommand,
  ReleaseRetryResult,
  ReleaseRetryStatus,
} from "../../releases/retry-contract.js";

/** D1 bind values accepted by the persisted T11 statements. */
export type D1BindValue = string | number | null | ArrayBuffer | Uint8Array;
export type { D1PreparedStatement, D1Result };
export type T11D1Database = D1Database;

type OperatorRetryStatusRow = {
  readonly release_id: string;
  readonly version: string;
  readonly image_digest: string;
  readonly candidate_status: "candidate" | "available";
  readonly workflow_state: CandidateWorkflow["state"];
  readonly workflow_revision: number;
  readonly workflow_failure_code: string | null;
  readonly workflow_attempts: number;
  readonly workflow_next_attempt_at: number | null;
  readonly canary_build_key: string | null;
  readonly canary_operation_id: string | null;
  readonly build_id: string | null;
  readonly build_status: string | null;
  readonly build_attempt_count: number | null;
  readonly build_progress_json: string | null;
  readonly build_failure_json: string | null;
};

type OperatorRetryContextRow = {
  readonly candidate_json: string;
  readonly candidate_status: "candidate" | "available";
  readonly workflow_state: CandidateWorkflow["state"];
  readonly workflow_revision: number;
  readonly workflow_failure_code: string | null;
  readonly workflow_lease_owner: string | null;
  readonly workflow_lease_expires_at: number | null;
  readonly workflow_canary_artifact_digest: string | null;
  readonly workflow_canary_runtime_id: string | null;
  readonly workflow_canary_operation_id: string | null;
  readonly workflow_healthy_since: number | null;
  readonly workflow_last_healthy_at: number | null;
  readonly workflow_last_health_evidence_json: string | null;
  readonly workflow_cleanup_evidence_json: string | null;
  readonly workflow_follower_cursor: string | null;
  readonly workflow_follower_planning_complete: number;
  readonly workflow_canary_cleanup_complete: number;
  readonly workflow_cleanup_disposition: string | null;
  readonly canary_build_key: string;
  readonly revision_id: string;
  readonly revision_status: string;
  readonly revision_artifact_digest: string | null;
  readonly revision_actor_id: string;
  readonly revision_selection_json: string;
  readonly revision_generation: number;
  readonly build_id: string;
  readonly build_status: string;
  readonly build_failure_json: string | null;
  readonly build_active_attempt_id: string | null;
  readonly build_lease_epoch: number;
  readonly build_key: string;
  readonly build_attempt_count: number;
  readonly instance_generation: number;
  readonly instance_runtime_epoch: number;
  readonly instance_desired_state: string;
  readonly instance_observed_state: string;
  readonly instance_observed_generation: number | null;
  readonly instance_observed_runtime_epoch: number | null;
  readonly instance_desired_revision_id: string | null;
  readonly instance_desired_artifact_digest: string | null;
  readonly instance_reservation_state: string;
  readonly instance_reservation_id: string | null;
  readonly binding_suspended: number;
  readonly binding_epoch: number;
  readonly authorization_revision: number;
  readonly active_attempt_status: string | null;
  readonly active_attempt_epoch: number | null;
  readonly has_instance_operations: number;
  readonly has_instance_reservations: number;
  readonly has_runtime_health_observations: number;
  readonly has_build_artifacts: number;
};

type RetryIdempotencyRow = {
  readonly request_hash: string;
  readonly response_kind: string;
  readonly response_id: string;
};

export type FencedUpdateResult =
  | { readonly kind: "dispatched"; readonly operationId: string; readonly generation: number }
  | { readonly kind: "stale" | "pinned" | "stopped" | "lease_lost" };

/** Stage lookup and activation are supplied by the persisted configuration service. */
export interface StagedRolloutActivator {
  findStageByIdempotency(
    repositoryId: number,
    idempotencyKey: string,
  ): Promise<{
    readonly stageId: string;
    readonly buildKey: string;
    readonly buildId: string;
    readonly artifactDigest: string | null;
    readonly status: "staged" | "activated" | "superseded";
  } | null>;
  activateStageUnderClusterFence(input: {
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
    readonly actorKind: "system";
    readonly requestId: string;
    readonly operationId: string;
    readonly operationIdempotencyKey: string;
    readonly now: number;
  }): Promise<{ readonly operationId: string; readonly generation: number } | null>;
}

type CandidateRow = {
  readonly release_id: string;
  readonly image_digest: string;
  readonly status: "candidate" | "available";
  readonly candidate_json: string;
};

type WorkflowRow = {
  readonly release_id: string;
  readonly state: CandidateWorkflow["state"];
  readonly revision: number;
  readonly attempts: number;
  readonly next_attempt_at: number | null;
  readonly lease_owner: string | null;
  readonly lease_epoch: number;
  readonly lease_expires_at: number | null;
  readonly canary_artifact_digest: string | null;
  readonly canary_build_key: string | null;
  readonly canary_runtime_id: string | null;
  readonly canary_operation_id: string | null;
  readonly healthy_since: number | null;
  readonly last_healthy_at: number | null;
  readonly last_health_evidence_json: string | null;
  readonly cleanup_evidence_json: string | null;
  readonly follower_cursor: string | null;
  readonly follower_planning_complete: number;
  readonly canary_cleanup_complete: number;
  readonly cleanup_disposition: "promote" | "reject" | null;
  readonly failure_code: string | null;
  readonly updated_at: number;
};

type FanoutRow = {
  readonly cursor: string | null;
  readonly revision: number;
  readonly last_input_cursor: string | null;
  readonly last_next_cursor: string | null;
  readonly last_page_hash: string | null;
};

type RolloutRow = {
  readonly rollout_id: string;
  readonly release_id: string;
  readonly instance_id: string;
  readonly cluster_id: string;
  readonly snapshot_json: string;
  readonly state: StableRollout["state"];
  readonly revision: number;
  readonly build_key: string | null;
  readonly build_id: string | null;
  readonly artifact_digest: string | null;
  readonly deployment_revision_id: string | null;
  readonly operation_id: string | null;
  readonly failure_code: string | null;
  readonly next_attempt_at: number | null;
  readonly updated_at: number;
};

type ClusterLeaseRow = {
  readonly cluster_id: string;
  readonly rollout_id: string;
  readonly owner: string;
  readonly lease_epoch: number;
  readonly lease_expires_at: number;
  readonly active_operation_id: string | null;
};

export type CanaryHealthScheduleInput = {
  readonly instanceId: string;
  readonly repositoryId: number;
  readonly generation: number;
  readonly runtimeEpoch: number;
  readonly clusterId: string;
  readonly now: number;
};

export type CanaryHealthSchedule = {
  readonly healthOperationId: string;
  readonly nextCheckAt: number;
  readonly sampleDueAt: number | null;
};

export type CanaryHealthProgressState =
  | { readonly kind: "due"; readonly releaseId: string }
  | { readonly kind: "leased"; readonly releaseId: string; readonly leaseExpiresAt: number }
  | { readonly kind: "consumed" | "inactive" };

type CanaryHealthScheduleRow = {
  readonly release_id: string;
  readonly canary_operation_id: string;
  readonly operation_status: string;
  readonly operation_created_at: number;
  readonly health_observed_at: number | null;
  readonly has_active_operation: number;
};

type CanaryHealthProgressRow = {
  readonly release_id: string;
  readonly state: CandidateWorkflow["state"];
  readonly revision: number;
  readonly canary_operation_id: string | null;
  readonly next_attempt_at: number | null;
  readonly lease_owner: string | null;
  readonly lease_expires_at: number | null;
  readonly last_healthy_at: number | null;
  readonly health_observed_at: number | null;
};

const ACTIVE_ROLLOUT_STATES = [
  "pending",
  "building",
  "waiting_build",
  "dispatch_pending",
  "operation_pending",
] as const;
// Runtime Provisioner observes this deadline locally, outside Cloudflare. A
// minute between admitted real samples supports the bounded stable canary
// window without adding a paid Worker polling schedule.
const CANARY_HEALTH_SAMPLE_INTERVAL_MS = 60 * 1_000;

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function readCandidate(row: CandidateRow): ReleaseCandidate {
  const parsed = parseJson(row.candidate_json);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("stored release candidate is not an object");
  }
  const candidate = ReleaseCandidateSchema.parse({ ...parsed, status: row.status });
  if (candidate.id !== row.release_id || candidate.imageDigest !== row.image_digest) {
    throw new TypeError("stored release candidate identity does not match its indexed row");
  }
  return candidate;
}

function readWorkflow(row: WorkflowRow): CandidateWorkflow {
  return {
    releaseId: row.release_id,
    state: row.state,
    revision: row.revision,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    leaseOwner: row.lease_owner,
    leaseEpoch: row.lease_epoch,
    leaseExpiresAt: row.lease_expires_at,
    canaryArtifactDigest: row.canary_artifact_digest,
    canaryBuildKey: row.canary_build_key,
    canaryRuntimeId: row.canary_runtime_id,
    canaryOperationId: row.canary_operation_id,
    healthySince: row.healthy_since,
    lastHealthyAt: row.last_healthy_at,
    lastHealthEvidence:
      row.last_health_evidence_json === null
        ? null
        : CanaryHealthEvidenceSchema.parse(parseJson(row.last_health_evidence_json)),
    cleanupEvidence:
      row.cleanup_evidence_json === null
        ? null
        : CanaryCleanupEvidenceSchema.parse(parseJson(row.cleanup_evidence_json)),
    followerCursor: row.follower_cursor,
    followerPlanningComplete: row.follower_planning_complete === 1,
    canaryCleanupComplete: row.canary_cleanup_complete === 1,
    cleanupDisposition: row.cleanup_disposition,
    failureCode: row.failure_code,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function readRollout(row: RolloutRow): StableRollout {
  return {
    id: row.rollout_id,
    releaseId: row.release_id,
    instanceId: row.instance_id,
    clusterId: row.cluster_id,
    snapshot: JSON.parse(row.snapshot_json) as StableFollower,
    state: row.state,
    revision: row.revision,
    buildKey: row.build_key,
    buildId: row.build_id,
    artifactDigest: row.artifact_digest,
    deploymentRevisionId: row.deployment_revision_id,
    operationId: row.operation_id,
    failureCode: row.failure_code,
    nextAttemptAt: row.next_attempt_at,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function readClusterLease(row: ClusterLeaseRow): ClusterRolloutLease {
  return {
    clusterId: row.cluster_id,
    rolloutId: row.rollout_id,
    owner: row.owner,
    epoch: row.lease_epoch,
    expiresAt: row.lease_expires_at,
    activeOperationId: row.active_operation_id,
  };
}

function cursorEncode(createdAt: string, releaseId: string): string {
  return encodeURIComponent(JSON.stringify([createdAt, releaseId]));
}

function cursorDecode(cursor: string): readonly [string, string] {
  try {
    const decoded: unknown = JSON.parse(decodeURIComponent(cursor));
    if (
      Array.isArray(decoded) &&
      decoded.length === 2 &&
      typeof decoded[0] === "string" &&
      typeof decoded[1] === "string"
    ) {
      return [decoded[0], decoded[1]];
    }
  } catch {
    // Fall through to the single explicit invalid-cursor error.
  }
  throw new TypeError("invalid T11 release cursor");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).sort().join(",")}]`;
  }
  if (typeof value !== "object" || value === null) return JSON.stringify(value) ?? "null";
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableJson(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function rolloutId(releaseId: string, instanceId: string): Promise<string> {
  return `sr_${await digest([releaseId, instanceId])}`;
}

function workflowValues(workflow: CandidateWorkflow): readonly D1BindValue[] {
  return [
    workflow.state,
    workflow.attempts,
    workflow.nextAttemptAt,
    workflow.canaryArtifactDigest,
    workflow.canaryBuildKey,
    workflow.canaryRuntimeId,
    workflow.canaryOperationId,
    workflow.healthySince,
    workflow.lastHealthyAt,
    workflow.lastHealthEvidence === null ? null : JSON.stringify(workflow.lastHealthEvidence),
    workflow.cleanupEvidence === null ? null : JSON.stringify(workflow.cleanupEvidence),
    workflow.followerCursor,
    Number(workflow.followerPlanningComplete),
    Number(workflow.canaryCleanupComplete),
    workflow.cleanupDisposition,
    workflow.failureCode,
    Date.parse(workflow.updatedAt),
  ];
}

function rolloutValues(rollout: StableRollout): readonly D1BindValue[] {
  return [
    rollout.snapshot.instanceId,
    rollout.clusterId,
    JSON.stringify(rollout.snapshot),
    rollout.state,
    rollout.buildKey,
    rollout.buildId,
    rollout.artifactDigest,
    rollout.deploymentRevisionId,
    rollout.operationId,
    rollout.failureCode,
    rollout.nextAttemptAt,
    Date.parse(rollout.updatedAt),
  ];
}

/** Durable T11 catalog, promotion, fanout, rollout and cluster-fence adapter. */
export class D1T11ReleaseRolloutStore
  implements ReleaseAdmissionRepository, ReleasePromotionRepository, StableRolloutRepository
{
  constructor(
    private readonly db: T11D1Database,
    private readonly stagedActivator: StagedRolloutActivator,
    private readonly createOperationId: () => string = () => crypto.randomUUID(),
  ) {}

  private assertOneChange(): D1PreparedStatement {
    return this.db.prepare(
      "INSERT INTO platform_transaction_sentinel(id) SELECT 1 WHERE changes() <> 1",
    );
  }

  /**
   * Makes a delayed canary workflow due after its own admitted build finishes.
   * The single conditional update matches the configured canary plan and only
   * fences an expired workflow lease; an active promoter keeps ownership.
   */
  async wakeSuccessfulCanaryBuild(input: {
    readonly buildId: string;
    readonly binding: DisposableCanaryBinding;
    readonly now: number;
  }): Promise<string | null> {
    if (!Number.isSafeInteger(input.now) || input.now < 0)
      throw new TypeError("canary build wake time is invalid");
    const requestedModulesJson = JSON.stringify([...input.binding.requestedModules].sort());
    const rows = await this.db
      .prepare(
        `UPDATE release_candidate_workflows
            SET next_attempt_at = ?, revision = revision + 1, updated_at = ?,
                lease_owner = NULL,
                lease_epoch = lease_epoch + CASE WHEN lease_owner IS NULL THEN 0 ELSE 1 END,
                lease_expires_at = NULL
          WHERE release_id = (
            SELECT w.release_id
              FROM release_candidate_workflows w
              JOIN release_candidates c ON c.release_id = w.release_id
              JOIN builds b ON b.build_key = w.canary_build_key
              JOIN deployment_revisions d ON d.build_id = b.build_id AND d.build_key = b.build_key
              JOIN artifacts a ON a.build_id = b.build_id AND a.build_key = b.build_key
                               AND a.artifact_digest = d.artifact_digest AND a.status = 'admitted'
              JOIN idempotency_records p
                ON p.scope = 'repository:' || d.repository_id
               AND p.idempotency_key = 'stable-canary-plan:' || c.release_id
               AND p.response_kind = 'configuration-plan'
               AND p.response_id = d.revision_id
              JOIN logical_instances i ON i.instance_id = d.instance_id
              JOIN repository_bindings rb ON rb.repository_id = d.repository_id
                                          AND rb.instance_id = i.instance_id
             WHERE b.build_id = ? AND b.status = 'succeeded'
               AND EXISTS (
                 SELECT 1 FROM build_attempts completed
                 WHERE completed.attempt_id = b.active_attempt_id
                   AND completed.build_id = b.build_id
                   AND completed.status = 'succeeded'
                   AND completed.lease_epoch = b.lease_epoch
                   AND completed.report_sequence = b.report_sequence
                   AND completed.last_report_digest = b.last_report_digest
               )
               AND c.status = 'candidate'
               AND w.state = 'canary_building' AND w.failure_code IS NULL
               AND w.next_attempt_at > ?
               AND ((w.lease_owner IS NULL AND w.lease_expires_at IS NULL)
                    OR (w.lease_owner IS NOT NULL AND w.lease_expires_at <= ?))
               AND w.canary_artifact_digest IS NULL
               AND w.canary_runtime_id IS NULL AND w.canary_operation_id IS NULL
               AND d.status = 'admitted' AND d.artifact_digest IS NOT NULL
               AND d.actor_id = 'system:stable-release-canary'
               AND d.repository_id = ? AND d.instance_id = ?
               AND json_extract(d.selection_json, '$.releaseId') = c.release_id
               AND json_extract(d.selection_json, '$.policy') = 'pinned'
               AND json_extract(d.selection_json, '$.resourceProfileId') = ?
               AND json_extract(d.selection_json, '$.requestedModules') = ?
               AND rb.binding_epoch = ? AND rb.authorization_revision = ? AND rb.suspended = 0
               AND i.repository_id = d.repository_id AND i.generation = d.generation
               AND i.desired_revision_id = d.revision_id
               AND i.desired_state = 'stopped' AND i.observed_state = 'absent'
               AND i.observed_generation IS NULL AND i.observed_runtime_epoch IS NULL
               AND i.runtime_epoch = 0 AND i.reservation_state IN ('none', 'released')
               AND i.reservation_id IS NULL AND i.desired_artifact_digest = d.artifact_digest
               AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.instance_id = i.instance_id)
               AND NOT EXISTS (SELECT 1 FROM runtime_reservations r WHERE r.instance_id = i.instance_id)
             ORDER BY w.next_attempt_at, w.release_id LIMIT 1
          )
          RETURNING release_id`,
      )
      .bind(
        input.now,
        input.now,
        input.buildId,
        input.now,
        input.now,
        input.binding.repositoryId,
        input.binding.instanceId,
        input.binding.resourceProfileId,
        requestedModulesJson,
        input.binding.bindingEpoch,
        input.binding.authorizationRevision,
      )
      .all<{ readonly release_id: string }>();
    return rows.results[0]?.release_id ?? null;
  }

  /** Returns only bounded status fields suitable for an authenticated operator client. */
  async getReleaseRetryStatus(releaseId: string): Promise<ReleaseRetryStatus | null> {
    const row = await this.db
      .prepare(
        `SELECT c.release_id, c.version, c.image_digest, c.status AS candidate_status,
                w.state AS workflow_state, w.revision AS workflow_revision,
                w.failure_code AS workflow_failure_code, w.attempts AS workflow_attempts,
                w.next_attempt_at AS workflow_next_attempt_at,
                w.canary_build_key, w.canary_operation_id,
                b.build_id, b.status AS build_status, b.attempt_count AS build_attempt_count,
                b.progress_json AS build_progress_json, b.failure_json AS build_failure_json
           FROM release_candidates c
           JOIN release_candidate_workflows w ON w.release_id = c.release_id
           LEFT JOIN builds b ON b.build_key = w.canary_build_key
          WHERE c.release_id = ? LIMIT 1`,
      )
      .bind(releaseId)
      .first<OperatorRetryStatusRow>();
    return row ? operatorRetryStatus(row) : null;
  }

  async findCanaryWaitSkip(
    input: Pick<CanaryWaitSkipCommand, "releaseId" | "idempotencyKey" | "requestHash">,
  ): Promise<ReleaseRetryResult | null> {
    const prior = await this.readRetryIdempotency(`release-wait:${input.releaseId}`, input.idempotencyKey);
    if (!prior) return null;
    if (prior.request_hash !== input.requestHash || prior.response_kind !== "release-canary-wait-skip" ||
        prior.response_id !== input.releaseId) return { kind: "conflict", reason: "idempotency_key_reused" };
    const status = await this.getReleaseRetryStatus(input.releaseId);
    return status ? { kind: "accepted", duplicate: true, status } : { kind: "not_found" };
  }

  /** Atomically records an operator exception, then uses normal stop/absence/promotion. */
  async skipCanaryWait(input: CanaryWaitSkipCommand): Promise<ReleaseRetryResult> {
    const prior = await this.findCanaryWaitSkip(input);
    if (prior) return prior;
    const status = await this.getReleaseRetryStatus(input.releaseId);
    if (!status) return { kind: "not_found" };
    const row = await this.db.prepare(
      "SELECT last_health_evidence_json FROM release_candidate_workflows WHERE release_id = ?",
    ).bind(input.releaseId).first<{ last_health_evidence_json: string | null }>();
    const parsed = CanaryHealthEvidenceSchema.safeParse(
      row?.last_health_evidence_json ? parseJson(row.last_health_evidence_json) : null,
    );
    if (!parsed.success || parsed.data.observedAt > input.now ||
        input.now - parsed.data.observedAt > 10 * 60_000)
      return { kind: "conflict", reason: "fresh_healthy_canary_required" };
    const evidence = parsed.data;
    const statements = [
      this.db.prepare(`UPDATE release_candidate_workflows
        SET state = 'canary_cleanup', cleanup_disposition = 'promote', next_attempt_at = ?,
            revision = revision + 1, updated_at = ?, lease_owner = NULL,
            lease_epoch = lease_epoch + CASE WHEN lease_owner IS NULL THEN 0 ELSE 1 END,
            lease_expires_at = NULL
        WHERE release_id = ? AND state = 'canary_observing' AND revision = ?
          AND failure_code IS NULL AND canary_cleanup_complete = 0
          AND (lease_owner IS NULL OR lease_expires_at <= ?)
          AND last_health_evidence_json = ? AND last_healthy_at = ?
          AND canary_artifact_digest = ? AND canary_runtime_id = ? AND canary_operation_id = ?
          AND EXISTS (SELECT 1 FROM release_candidates c
                      WHERE c.release_id = release_candidate_workflows.release_id AND c.status = 'candidate')
          AND EXISTS (
            SELECT 1 FROM runtime_health_observations h
            JOIN logical_instances i ON i.instance_id = h.instance_id AND i.repository_id = h.repository_id
            JOIN repository_bindings b ON b.instance_id = i.instance_id AND b.repository_id = i.repository_id
            JOIN operations o ON o.operation_id = h.operation_id AND o.instance_id = i.instance_id
            JOIN runtime_reservations r ON r.reservation_id = i.reservation_id
            WHERE h.instance_id = canary_runtime_id AND h.operation_id = canary_operation_id
              AND h.provider_observation_id = ? AND h.observed_at = ?
              AND i.desired_state = 'running' AND i.observed_state = 'ready' AND b.suspended = 0
              AND i.generation = h.generation AND i.observed_generation = h.generation
              AND i.runtime_epoch = h.runtime_epoch AND i.observed_runtime_epoch = h.runtime_epoch
              AND h.runtime_epoch = ? AND o.runtime_epoch = h.runtime_epoch AND o.generation = h.generation
              AND o.repository_id = i.repository_id AND o.cluster_id = h.cluster_id
              AND o.status = 'succeeded' AND o.kind IN ('start', 'update', 'redeploy')
              AND o.deployment_revision_id = i.observed_revision_id
              AND r.instance_id = i.instance_id AND r.repository_id = i.repository_id
              AND r.generation = h.generation AND r.runtime_epoch = h.runtime_epoch
              AND r.cluster_id = h.cluster_id AND r.status IN ('reserved', 'allocated')
              AND NOT EXISTS (SELECT 1 FROM operations active WHERE active.instance_id = i.instance_id
                              AND active.status IN ('pending', 'claimed', 'running'))
          )`).bind(input.now, input.now, input.releaseId, input.expectedRevision, input.now,
            row!.last_health_evidence_json, evidence.observedAt, evidence.artifactDigest,
            evidence.runtimeId, evidence.operationId, evidence.providerObservationId,
            evidence.observedAt, evidence.runtimeEpoch),
      this.assertOneChange(),
      this.db.prepare(`INSERT INTO idempotency_records
        (scope, idempotency_key, request_hash, response_kind, response_id, created_at)
        VALUES (?, ?, ?, 'release-canary-wait-skip', ?, ?)`)
        .bind(`release-wait:${input.releaseId}`, input.idempotencyKey, input.requestHash, input.releaseId, input.now),
      this.assertOneChange(),
      this.db.prepare(`INSERT INTO audit_events
        (event_id, repository_id, instance_id, operation_id, actor_id, actor_kind,
         action, outcome, request_id, metadata_json, occurred_at)
        VALUES (?, NULL, ?, ?, ?, 'operator', 'release.canary-wait.skipped', 'accepted', ?, ?, ?)`)
        .bind(`aud_canary_wait_${crypto.randomUUID()}`, evidence.runtimeId, evidence.operationId,
          input.actorId, input.requestId, JSON.stringify({releaseId: input.releaseId, reason: input.reason,
            previousWorkflowRevision: input.expectedRevision, healthObservedAt: evidence.observedAt,
            elapsedWindowSkipped: true}), input.now),
      this.assertOneChange(),
    ];
    try { await this.db.batch(statements); }
    catch (error) {
      const raced = await this.findCanaryWaitSkip(input);
      if (raced) return raced;
      if (isTransactionAssertion(error)) return { kind: "conflict", reason: "stale_or_ineligible" };
      throw error;
    }
    const updated = await this.getReleaseRetryStatus(input.releaseId);
    return updated ? { kind: "accepted", duplicate: false, status: updated } : { kind: "not_found" };
  }

  /** Resolves an accepted retry receipt without requiring external evidence verification. */
  async findPreRuntimeCanaryRetry(
    input: Pick<ReleaseRetryCommand, "releaseId" | "idempotencyKey" | "requestHash">,
  ): Promise<ReleaseRetryResult | null> {
    const prior = await this.readRetryIdempotency(`release:${input.releaseId}`, input.idempotencyKey);
    if (!prior) return null;
    if (
      prior.request_hash !== input.requestHash ||
      prior.response_kind !== "release-canary-build-retry" ||
      prior.response_id !== input.releaseId
    ) {
      return { kind: "conflict", reason: "idempotency_key_reused" };
    }
    const status = await this.getReleaseRetryStatus(input.releaseId);
    return status ? { kind: "accepted", duplicate: true, status } : { kind: "not_found" };
  }

  /**
   * Resets only a failed, pre-runtime canary build through one guarded D1 batch.
   * The failed attempt row remains immutable; the build lease epoch and workflow
   * lease epoch advance so delayed reports and workflow owners are fenced.
   */
  async retryPreRuntimeCanaryBuild(
    input: ReleaseRetryCommand,
  ): Promise<ReleaseRetryResult> {
    const prior = await this.findPreRuntimeCanaryRetry(input);
    if (prior) return prior;

    const scope = `release:${input.releaseId}`;
    const status = await this.getReleaseRetryStatus(input.releaseId);
    if (!status) return { kind: "not_found" };
    if (status.workflow.revision !== input.expectedRevision) {
      return { kind: "conflict", reason: "stale_or_ineligible" };
    }

    const context = await this.readOperatorRetryContext(input);
    if (!context || !isEligiblePreRuntimeCanaryRetry(context, input.canary)) {
      return { kind: "conflict", reason: "stale_or_ineligible" };
    }
    const candidate = ReleaseCandidateSchema.parse(JSON.parse(context.candidate_json) as unknown);
    const modulesJson = JSON.stringify([...input.canary.requestedModules].sort());
    const common = {
      releaseId: input.releaseId,
      candidateJson: context.candidate_json,
      expectedRevision: input.expectedRevision,
      canary: input.canary,
      modulesJson,
    };
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `UPDATE builds SET status = 'pending', lease_epoch = lease_epoch + 1,
               active_attempt_id = NULL, worker_id = NULL, lease_token = NULL,
               lease_expires_at = NULL, report_sequence = 0, last_report_digest = NULL,
               progress_json = NULL, cancel_requested = 0, candidate_ref = NULL,
               manifest_digest = NULL, artifact_digest = NULL, failure_json = NULL, updated_at = ?
           WHERE build_id = ? AND status = 'failed'
             AND EXISTS (${retryEligibilitySql("failed", "failed")})`,
        )
        .bind(input.now, context.build_id, ...retryEligibilityValues(common)),
      this.assertOneChange(),
      this.db
        .prepare(
          `UPDATE deployment_revisions SET status = 'building', artifact_digest = NULL
           WHERE revision_id = ? AND status = 'failed' AND artifact_digest IS NULL
             AND EXISTS (
               SELECT 1 FROM release_candidate_workflows w
               JOIN release_candidates c ON c.release_id = w.release_id
               JOIN builds b ON b.build_key = w.canary_build_key
               JOIN idempotency_records p
                 ON p.scope = ?
                AND p.idempotency_key = 'stable-canary-plan:' || c.release_id
                AND p.response_kind = 'configuration-plan'
               JOIN logical_instances i ON i.instance_id = ?
               JOIN repository_bindings rb ON rb.repository_id = ? AND rb.instance_id = i.instance_id
               WHERE w.release_id = ?
                 AND (
                   (w.state = 'blocked' AND w.failure_code = 'canary_build_failed')
                   OR (w.state = 'canary_building' AND w.failure_code IS NULL)
                 )
                 AND w.revision = ?
                 AND w.lease_owner IS NULL AND w.lease_expires_at IS NULL
                 AND w.canary_build_key = b.build_key AND b.status = 'pending'
                 AND p.response_id = deployment_revisions.revision_id
                 AND deployment_revisions.build_id = b.build_id
                 AND deployment_revisions.instance_id = i.instance_id
                 AND deployment_revisions.repository_id = i.repository_id
                 AND deployment_revisions.actor_id = 'system:stable-release-canary'
                 AND json_extract(deployment_revisions.selection_json, '$.releaseId') = c.release_id
                 AND json_extract(deployment_revisions.selection_json, '$.policy') = 'pinned'
                 AND json_extract(deployment_revisions.selection_json, '$.resourceProfileId') = ?
                 AND json_extract(deployment_revisions.selection_json, '$.requestedModules') = ?
                 AND rb.binding_epoch = ? AND rb.authorization_revision = ? AND rb.suspended = 0
                 AND i.generation = deployment_revisions.generation
                 AND i.desired_revision_id = deployment_revisions.revision_id
                 AND i.desired_state = 'stopped' AND i.observed_state = 'absent'
                 AND i.observed_generation IS NULL AND i.observed_runtime_epoch IS NULL
                 AND i.runtime_epoch = 0 AND i.reservation_state IN ('none', 'released')
                 AND i.reservation_id IS NULL AND i.desired_artifact_digest IS NULL
                 AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.instance_id = i.instance_id)
                 AND NOT EXISTS (SELECT 1 FROM runtime_reservations r WHERE r.instance_id = i.instance_id)
                 AND NOT EXISTS (SELECT 1 FROM artifacts a WHERE a.build_id = b.build_id)
             )`,
        )
        .bind(
          context.revision_id,
          `repository:${input.canary.repositoryId}`,
          input.canary.instanceId,
          input.canary.repositoryId,
          input.releaseId,
          input.expectedRevision,
          input.canary.resourceProfileId,
          modulesJson,
          input.canary.bindingEpoch,
          input.canary.authorizationRevision,
        ),
      this.assertOneChange(),
      this.db
        .prepare(
          `UPDATE release_candidate_workflows
              SET state = 'canary_building', revision = revision + 1, attempts = attempts + 1,
                  next_attempt_at = NULL, lease_owner = NULL, lease_epoch = lease_epoch + 1,
                  lease_expires_at = NULL, canary_artifact_digest = NULL,
                  canary_runtime_id = NULL, canary_operation_id = NULL, healthy_since = NULL,
                  last_healthy_at = NULL, last_health_evidence_json = NULL,
                  cleanup_evidence_json = NULL, follower_cursor = NULL,
                  follower_planning_complete = 0, canary_cleanup_complete = 0,
                  cleanup_disposition = NULL, failure_code = NULL, updated_at = ?
            WHERE release_id = ? AND revision = ?
              AND (
                (state = 'blocked' AND failure_code = 'canary_build_failed')
                OR (state = 'canary_building' AND failure_code IS NULL)
              )
              AND EXISTS (
                SELECT 1 FROM release_candidates c
                JOIN idempotency_records p
                  ON p.scope = ?
                 AND p.idempotency_key = 'stable-canary-plan:' || c.release_id
                 AND p.response_kind = 'configuration-plan'
                JOIN deployment_revisions d ON d.revision_id = p.response_id
                JOIN builds b ON b.build_key = release_candidate_workflows.canary_build_key
                JOIN logical_instances i ON i.instance_id = ?
                JOIN repository_bindings rb ON rb.repository_id = ? AND rb.instance_id = i.instance_id
                WHERE c.release_id = release_candidate_workflows.release_id
                  AND c.status = 'candidate' AND d.status = 'building' AND d.artifact_digest IS NULL
                  AND d.build_id = b.build_id AND b.status = 'pending'
                  AND d.instance_id = i.instance_id AND d.repository_id = i.repository_id
                  AND d.actor_id = 'system:stable-release-canary'
                  AND json_extract(d.selection_json, '$.releaseId') = c.release_id
                  AND json_extract(d.selection_json, '$.policy') = 'pinned'
                  AND json_extract(d.selection_json, '$.resourceProfileId') = ?
                  AND json_extract(d.selection_json, '$.requestedModules') = ?
                  AND p.response_id = d.revision_id AND rb.binding_epoch = ?
                  AND rb.authorization_revision = ? AND rb.suspended = 0
                  AND i.generation = d.generation AND i.desired_revision_id = d.revision_id
                  AND i.desired_state = 'stopped' AND i.observed_state = 'absent'
                  AND i.observed_generation IS NULL AND i.observed_runtime_epoch IS NULL
                  AND i.runtime_epoch = 0 AND i.reservation_state IN ('none', 'released')
                  AND i.reservation_id IS NULL AND i.desired_artifact_digest IS NULL
                  AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.instance_id = i.instance_id)
                  AND NOT EXISTS (SELECT 1 FROM runtime_reservations r WHERE r.instance_id = i.instance_id)
                  AND NOT EXISTS (SELECT 1 FROM artifacts a WHERE a.build_id = b.build_id)
              )`,
        )
        .bind(
          input.now,
          input.releaseId,
          input.expectedRevision,
          `repository:${input.canary.repositoryId}`,
          input.canary.instanceId,
          input.canary.repositoryId,
          input.canary.resourceProfileId,
          modulesJson,
          input.canary.bindingEpoch,
          input.canary.authorizationRevision,
        ),
      this.assertOneChange(),
      this.db
        .prepare(
          `INSERT INTO idempotency_records
             (scope, idempotency_key, request_hash, response_kind, response_id, created_at)
           VALUES (?, ?, ?, 'release-canary-build-retry', ?, ?)`,
        )
        .bind(scope, input.idempotencyKey, input.requestHash, input.releaseId, input.now),
      this.assertOneChange(),
      this.db
        .prepare(
          `INSERT INTO audit_events
             (event_id, repository_id, instance_id, operation_id, actor_id, actor_kind,
              action, outcome, request_id, metadata_json, occurred_at)
           VALUES (?, ?, ?, NULL, ?, 'operator', 'release.canary-build.retried',
                   'accepted', ?, ?, ?)`,
        )
        .bind(
          `aud_canary_retry_${crypto.randomUUID()}`,
          input.canary.repositoryId,
          input.canary.instanceId,
          input.actorId,
          input.requestId,
          JSON.stringify({
            releaseId: candidate.id,
            buildId: context.build_id,
            previousWorkflowRevision: input.expectedRevision,
            workflowRevision: input.expectedRevision + 1,
          }),
          input.now,
        ),
      this.assertOneChange(),
    ];

    try {
      await this.db.batch(statements);
    } catch (error) {
      if (isTransactionAssertion(error)) {
        return { kind: "conflict", reason: "stale_or_ineligible" };
      }
      if (isConstraintError(error)) {
        const raced = await this.readRetryIdempotency(scope, input.idempotencyKey);
        if (raced) {
          if (
            raced.request_hash !== input.requestHash ||
            raced.response_kind !== "release-canary-build-retry" ||
            raced.response_id !== input.releaseId
          ) {
            return { kind: "conflict", reason: "idempotency_key_reused" };
          }
          const duplicateStatus = await this.getReleaseRetryStatus(input.releaseId);
          return duplicateStatus
            ? { kind: "accepted", duplicate: true, status: duplicateStatus }
            : { kind: "not_found" };
        }
      }
      throw error;
    }

    const updated = await this.getReleaseRetryStatus(input.releaseId);
    return updated
      ? { kind: "accepted", duplicate: false, status: updated }
      : { kind: "not_found" };
  }

  private async readOperatorRetryContext(
    input: ReleaseRetryCommand,
  ): Promise<OperatorRetryContextRow | null> {
    return this.db
      .prepare(
        `SELECT c.candidate_json, c.status AS candidate_status,
                w.state AS workflow_state, w.revision AS workflow_revision,
                w.failure_code AS workflow_failure_code, w.lease_owner AS workflow_lease_owner,
                w.lease_expires_at AS workflow_lease_expires_at,
                w.canary_artifact_digest AS workflow_canary_artifact_digest,
                w.canary_runtime_id AS workflow_canary_runtime_id,
                w.canary_operation_id AS workflow_canary_operation_id,
                w.healthy_since AS workflow_healthy_since, w.last_healthy_at AS workflow_last_healthy_at,
                w.last_health_evidence_json AS workflow_last_health_evidence_json,
                w.cleanup_evidence_json AS workflow_cleanup_evidence_json,
                w.follower_cursor AS workflow_follower_cursor,
                w.follower_planning_complete AS workflow_follower_planning_complete,
                w.canary_cleanup_complete AS workflow_canary_cleanup_complete,
                w.cleanup_disposition AS workflow_cleanup_disposition,
                w.canary_build_key, d.revision_id, d.status AS revision_status,
                d.artifact_digest AS revision_artifact_digest, d.actor_id AS revision_actor_id,
                d.selection_json AS revision_selection_json, d.generation AS revision_generation,
                b.build_id, b.status AS build_status, b.failure_json AS build_failure_json,
                b.active_attempt_id AS build_active_attempt_id, b.lease_epoch AS build_lease_epoch,
                b.build_key, b.attempt_count AS build_attempt_count,
                i.generation AS instance_generation, i.runtime_epoch AS instance_runtime_epoch,
                i.desired_state AS instance_desired_state, i.observed_state AS instance_observed_state,
                i.observed_generation AS instance_observed_generation,
                i.observed_runtime_epoch AS instance_observed_runtime_epoch,
                i.desired_revision_id AS instance_desired_revision_id,
                i.desired_artifact_digest AS instance_desired_artifact_digest,
                i.reservation_state AS instance_reservation_state, i.reservation_id AS instance_reservation_id,
                rb.suspended AS binding_suspended, rb.binding_epoch, rb.authorization_revision,
                a.status AS active_attempt_status, a.lease_epoch AS active_attempt_epoch,
                EXISTS (SELECT 1 FROM operations op WHERE op.instance_id = i.instance_id) AS has_instance_operations,
                EXISTS (SELECT 1 FROM runtime_reservations rr WHERE rr.instance_id = i.instance_id) AS has_instance_reservations,
                EXISTS (SELECT 1 FROM runtime_health_observations ho WHERE ho.instance_id = i.instance_id) AS has_runtime_health_observations,
                EXISTS (SELECT 1 FROM artifacts ar WHERE ar.build_id = b.build_id) AS has_build_artifacts
           FROM release_candidates c
           JOIN release_candidate_workflows w ON w.release_id = c.release_id
           JOIN idempotency_records p
             ON p.scope = ?
            AND p.idempotency_key = 'stable-canary-plan:' || c.release_id
            AND p.response_kind = 'configuration-plan'
           JOIN deployment_revisions d ON d.revision_id = p.response_id
           JOIN logical_instances i ON i.instance_id = d.instance_id
           JOIN repository_bindings rb ON rb.repository_id = ? AND rb.instance_id = i.instance_id
           JOIN builds b ON b.build_id = d.build_id AND b.build_key = w.canary_build_key
           LEFT JOIN build_attempts a ON a.attempt_id = b.active_attempt_id AND a.build_id = b.build_id
          WHERE c.release_id = ? LIMIT 1`,
      )
      .bind(
        `repository:${input.canary.repositoryId}`,
        input.canary.repositoryId,
        input.releaseId,
      )
      .first<OperatorRetryContextRow>();
  }

  private async readRetryIdempotency(
    scope: string,
    key: string,
  ): Promise<RetryIdempotencyRow | null> {
    return this.db
      .prepare(
        `SELECT request_hash, response_kind, response_id
           FROM idempotency_records WHERE scope = ? AND idempotency_key = ? LIMIT 1`,
      )
      .bind(scope, key)
      .first<RetryIdempotencyRow>();
  }

  async getCanaryHealthSchedule(
    input: CanaryHealthScheduleInput,
  ): Promise<CanaryHealthSchedule | null> {
    const row = await this.db
      .prepare(
        `SELECT w.release_id, w.canary_operation_id, o.status AS operation_status,
                o.created_at AS operation_created_at, h.observed_at AS health_observed_at,
                EXISTS (
                  SELECT 1 FROM operations active
                  WHERE active.instance_id = i.instance_id
                    AND active.status IN ('pending', 'claimed', 'running')
                ) AS has_active_operation
           FROM release_candidate_workflows w
           JOIN operations o ON o.operation_id = w.canary_operation_id
           JOIN logical_instances i ON i.instance_id = o.instance_id
           JOIN repository_bindings b
             ON b.instance_id = i.instance_id AND b.repository_id = i.repository_id
           JOIN runtime_reservations r
             ON r.instance_id = i.instance_id AND r.runtime_epoch = i.observed_runtime_epoch
           LEFT JOIN runtime_health_observations h
             ON h.instance_id = i.instance_id AND h.repository_id = i.repository_id
            AND h.operation_id = o.operation_id
            AND h.runtime_epoch = i.runtime_epoch AND h.generation = i.generation
            AND h.cluster_id = r.cluster_id
          WHERE w.state = 'canary_observing'
            AND w.canary_runtime_id = i.instance_id
            AND i.instance_id = ? AND i.repository_id = ?
            AND i.generation = ? AND i.observed_generation = i.generation
            AND i.runtime_epoch = ? AND i.observed_runtime_epoch = i.runtime_epoch
            AND i.desired_state = 'running' AND i.observed_state = 'ready'
            AND b.suspended = 0
            AND r.repository_id = i.repository_id AND r.generation = i.generation
            AND r.cluster_id = ? AND r.status IN ('reserved', 'allocated')
            AND o.repository_id = i.repository_id AND o.generation = i.generation
            AND o.runtime_epoch = i.runtime_epoch
            AND o.deployment_revision_id = i.observed_revision_id
            AND o.cluster_id = r.cluster_id
            AND o.kind IN ('start', 'update', 'redeploy')
          ORDER BY w.updated_at DESC, w.release_id LIMIT 1`,
      )
      .bind(
        input.instanceId,
        input.repositoryId,
        input.generation,
        input.runtimeEpoch,
        input.clusterId,
      )
      .first<CanaryHealthScheduleRow>();
    if (!row) return null;
    const sampleDueAt =
      (row.health_observed_at ?? row.operation_created_at) + CANARY_HEALTH_SAMPLE_INTERVAL_MS;
    if (!Number.isSafeInteger(sampleDueAt) || sampleDueAt < 0) {
      throw new TypeError("canary health schedule timestamp is invalid");
    }
    const sampleable = row.operation_status === "succeeded" && row.has_active_operation === 0;
    const due = sampleable && sampleDueAt <= input.now;
    const boundedCheckAt = input.now + CANARY_HEALTH_SAMPLE_INTERVAL_MS;
    return {
      healthOperationId: row.canary_operation_id,
      nextCheckAt: due
        ? boundedCheckAt
        : sampleable
          ? sampleDueAt
          : sampleDueAt <= input.now
            ? boundedCheckAt
            : Math.min(sampleDueAt, boundedCheckAt),
      sampleDueAt: due ? sampleDueAt : null,
    };
  }

  async prepareCanaryHealthProgress(input: {
    readonly operationId: string;
    readonly now: number;
  }): Promise<CanaryHealthProgressState> {
    const row = await this.db
      .prepare(
        `SELECT w.release_id, w.state, w.revision, w.canary_operation_id,
                w.next_attempt_at, w.lease_owner, w.lease_expires_at,
                w.last_healthy_at, h.observed_at AS health_observed_at
           FROM release_candidate_workflows w
           LEFT JOIN runtime_health_observations h
             ON h.instance_id = w.canary_runtime_id AND h.operation_id = w.canary_operation_id
          WHERE w.canary_operation_id = ?
          ORDER BY w.updated_at DESC, w.release_id LIMIT 1`,
      )
      .bind(input.operationId)
      .first<CanaryHealthProgressRow>();
    if (
      !row ||
      row.state !== "canary_observing" ||
      row.canary_operation_id !== input.operationId
    ) {
      return { kind: "inactive" };
    }
    if (
      row.health_observed_at === null ||
      (row.last_healthy_at !== null && row.health_observed_at <= row.last_healthy_at)
    ) {
      return { kind: "consumed" };
    }
    if (
      row.lease_owner !== null && row.lease_expires_at !== null && row.lease_expires_at > input.now
    ) {
      return {
        kind: "leased",
        releaseId: row.release_id,
        leaseExpiresAt: row.lease_expires_at,
      };
    }
    if (row.next_attempt_at !== null && row.next_attempt_at <= input.now) {
      return { kind: "due", releaseId: row.release_id };
    }
    const result = await this.db
      .prepare(
        `UPDATE release_candidate_workflows
            SET next_attempt_at = ?, revision = revision + 1, updated_at = ?
          WHERE release_id = ? AND state = 'canary_observing'
            AND revision = ? AND canary_operation_id = ?
            AND (next_attempt_at IS NULL OR next_attempt_at > ?)
            AND (lease_owner IS NULL OR lease_expires_at <= ?)
            AND EXISTS (
              SELECT 1 FROM runtime_health_observations h
               WHERE h.instance_id = release_candidate_workflows.canary_runtime_id
                 AND h.operation_id = release_candidate_workflows.canary_operation_id
                 AND h.observed_at > COALESCE(release_candidate_workflows.last_healthy_at, -1)
            )`,
      )
      .bind(
        input.now,
        input.now,
        row.release_id,
        row.revision,
        input.operationId,
        input.now,
        input.now,
      )
      .run();
    if (result.meta.changes === 1) return { kind: "due", releaseId: row.release_id };

    const refreshed = await this.prepareCanaryHealthProgressWithoutUpdate(input.operationId);
    if (
      refreshed?.lease_owner &&
      refreshed.lease_expires_at !== null &&
      refreshed.lease_expires_at > input.now
    ) {
      return {
        kind: "leased",
        releaseId: refreshed.release_id,
        leaseExpiresAt: refreshed.lease_expires_at,
      };
    }
    if (
      !refreshed ||
      refreshed.state !== "canary_observing" ||
      refreshed.health_observed_at === null ||
      (refreshed.last_healthy_at !== null &&
        refreshed.health_observed_at <= refreshed.last_healthy_at)
    ) {
      return { kind: "consumed" };
    }
    return { kind: "due", releaseId: refreshed.release_id };
  }

  private async prepareCanaryHealthProgressWithoutUpdate(
    operationId: string,
  ): Promise<CanaryHealthProgressRow | null> {
    return this.db
      .prepare(
        `SELECT w.release_id, w.state, w.revision, w.canary_operation_id,
                w.next_attempt_at, w.lease_owner, w.lease_expires_at,
                w.last_healthy_at, h.observed_at AS health_observed_at
           FROM release_candidate_workflows w
           LEFT JOIN runtime_health_observations h
             ON h.instance_id = w.canary_runtime_id AND h.operation_id = w.canary_operation_id
          WHERE w.canary_operation_id = ?
          ORDER BY w.updated_at DESC, w.release_id LIMIT 1`,
      )
      .bind(operationId)
      .first<CanaryHealthProgressRow>();
  }

  async findCanaryReleaseId(operationId: string): Promise<string | null> {
    const row = await this.db
      .prepare(
        `SELECT release_id FROM release_candidate_workflows
          WHERE state = 'canary_observing' AND canary_operation_id = ?
          ORDER BY updated_at DESC, release_id LIMIT 1`,
      )
      .bind(operationId)
      .first<{ release_id: string }>();
    return row?.release_id ?? null;
  }

  /** Makes only the matching successful canary cleanup due for event-driven continuation. */
  async wakeCanaryCleanupAfterStop(operationId: string, now: number): Promise<string | null> {
    if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("canary stop wake time is invalid");
    const row = await this.db
      .prepare(
        `SELECT w.release_id, w.revision, w.next_attempt_at,
                w.lease_owner, w.lease_expires_at
           FROM release_candidate_workflows w
           JOIN operations o
             ON o.instance_id = w.canary_runtime_id
            AND o.idempotency_key = 'stable-canary-stop:' || w.release_id
          WHERE o.operation_id = ? AND o.kind = 'stop' AND o.status = 'succeeded'
            AND o.actor_id = 'system:stable-release-canary'
            AND w.state = 'canary_cleanup' AND w.cleanup_disposition = 'promote'
          ORDER BY w.updated_at DESC, w.release_id LIMIT 1`,
      )
      .bind(operationId)
      .first<{
        readonly release_id: string;
        readonly revision: number;
        readonly next_attempt_at: number | null;
        readonly lease_owner: string | null;
        readonly lease_expires_at: number | null;
      }>();
    if (!row) return null;
    if (row.next_attempt_at === null || row.next_attempt_at <= now) return row.release_id;
    if (row.lease_owner !== null && row.lease_expires_at !== null && row.lease_expires_at > now)
      return null;
    const woken = await this.db
      .prepare(
        `UPDATE release_candidate_workflows SET next_attempt_at = ?, revision = revision + 1,
                updated_at = ?
          WHERE release_id = ? AND state = 'canary_cleanup' AND cleanup_disposition = 'promote'
            AND revision = ? AND next_attempt_at = ?
            AND (lease_owner IS NULL OR lease_expires_at <= ?)
            AND EXISTS (
              SELECT 1 FROM operations o
               WHERE o.operation_id = ? AND o.instance_id = canary_runtime_id
                 AND o.idempotency_key = 'stable-canary-stop:' || release_id
                 AND o.kind = 'stop' AND o.status = 'succeeded'
                 AND o.actor_id = 'system:stable-release-canary'
            )`,
      )
      .bind(now, now, row.release_id, row.revision, row.next_attempt_at, now, operationId)
      .run();
    return woken.meta.changes === 1 ? row.release_id : null;
  }

  async findById(id: string): Promise<ReleaseCandidate | null> {
    const row = await this.db
      .prepare(
        `SELECT release_id, image_digest, status, candidate_json
           FROM release_candidates WHERE release_id = ?`,
      )
      .bind(id)
      .first<CandidateRow>();
    return row ? readCandidate(row) : null;
  }

  async findByDigest(imageDigest: string): Promise<ReleaseCandidate | null> {
    const row = await this.db
      .prepare(
        `SELECT release_id, image_digest, status, candidate_json
           FROM release_candidates WHERE image_digest = ?`,
      )
      .bind(imageDigest)
      .first<CandidateRow>();
    return row ? readCandidate(row) : null;
  }

  async listCandidates(
    cursor: string | null,
    limit: number,
  ): Promise<CursorPage<ReleaseCandidate>> {
    const size = Math.max(1, Math.min(100, Math.trunc(limit)));
    const cursorValues = cursor === null ? null : cursorDecode(cursor);
    const rows = await this.db
      .prepare(
        `SELECT release_id, image_digest, status, candidate_json
           FROM release_candidates
          WHERE (? IS NULL OR created_at > ? OR (created_at = ? AND release_id > ?))
          ORDER BY created_at, release_id LIMIT ?`,
      )
      .bind(
        cursorValues?.[0] ?? null,
        cursorValues?.[0] ?? null,
        cursorValues?.[0] ?? null,
        cursorValues?.[1] ?? null,
        size + 1,
      )
      .all<CandidateRow & { readonly created_at: string }>();
    const candidates = [...(rows.results ?? [])];
    const hasMore = candidates.length > size;
    const pageRows = hasMore ? candidates.slice(0, size) : candidates;
    const last = pageRows.at(-1);
    return {
      items: pageRows.map(readCandidate),
      nextCursor: hasMore && last ? cursorEncode(last.created_at, last.release_id) : null,
    };
  }

  async createCandidate(candidate: ReleaseCandidate): Promise<"created" | "duplicate"> {
    const results = await this.db.batch([
      this.candidateInsert(candidate),
      this.initialWorkflowInsert(candidate),
    ]);
    return results[0]?.meta.changes === 1 ? "created" : "duplicate";
  }

  async createCandidateWithAudit(input: {
    readonly candidate: ReleaseCandidate;
    readonly audit: {
      readonly actorId: string;
      readonly requestId: string;
      readonly action: "release.candidate.admit";
      readonly targetId: string;
      readonly outcome: "accepted";
      readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
      readonly occurredAt: string;
    };
  }): Promise<"created" | "duplicate"> {
    const { candidate, audit } = input;
    const results = await this.db.batch([
      this.candidateInsert(candidate),
      this.auditStatement(audit, true),
      this.initialWorkflowInsert(candidate),
    ]);
    return results[0]?.meta.changes === 1 ? "created" : "duplicate";
  }

  private candidateInsert(candidate: ReleaseCandidate): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT OR IGNORE INTO release_candidates
           (release_id, image_digest, version, image_repository, status, candidate_json, created_at)
         VALUES (?, ?, ?, ?, 'candidate', ?, ?)`,
      )
      .bind(
        candidate.id,
        candidate.imageDigest,
        candidate.version,
        candidate.imageRepository,
        JSON.stringify(candidate),
        candidate.createdAt,
      );
  }

  private initialWorkflowInsert(candidate: ReleaseCandidate): D1PreparedStatement {
    const createdAt = Date.parse(candidate.createdAt);
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
      throw new TypeError("release candidate creation time is invalid");
    }
    return this.db
      .prepare(
        `INSERT OR IGNORE INTO release_candidate_workflows
           (release_id, state, revision, attempts, next_attempt_at, lease_owner,
            lease_epoch, lease_expires_at, canary_artifact_digest, canary_build_key,
            canary_runtime_id, canary_operation_id, healthy_since, last_healthy_at,
            last_health_evidence_json, cleanup_evidence_json, follower_cursor,
            follower_planning_complete, canary_cleanup_complete, cleanup_disposition,
            failure_code, updated_at)
         SELECT ?, 'queued', 0, 0, NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                NULL, NULL, NULL, 0, 0, NULL, NULL, ?
          WHERE EXISTS (
            SELECT 1 FROM release_candidates WHERE release_id = ?
          )`,
      )
      .bind(candidate.id, createdAt, candidate.id);
  }

  private auditStatement(
    input: {
      readonly actorId: string;
      readonly requestId: string;
      readonly action: "release.candidate.admit";
      readonly targetId: string;
      readonly outcome: "accepted" | "denied" | "failed";
      readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
      readonly occurredAt: string;
    },
    onlyIfCandidateInserted = false,
  ): D1PreparedStatement {
    const guard = onlyIfCandidateInserted ? " WHERE changes() = 1" : "";
    return this.db
      .prepare(
        `INSERT INTO audit_events
           (event_id, repository_id, instance_id, operation_id, actor_id, actor_kind,
            action, outcome, request_id, metadata_json, occurred_at)
         SELECT ?, NULL, NULL, NULL, ?, 'operator', ?, ?, ?, ?, ?${guard}`,
      )
      .bind(
        `aud_${crypto.randomUUID()}`,
        input.actorId,
        input.action,
        input.outcome,
        input.requestId,
        JSON.stringify({ targetId: input.targetId, ...input.metadata }),
        Date.parse(input.occurredAt),
      );
  }

  async appendAudit(input: {
    readonly actorId: string;
    readonly requestId: string;
    readonly action: "release.candidate.admit";
    readonly targetId: string;
    readonly outcome: "accepted" | "denied" | "failed";
    readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
    readonly occurredAt: string;
  }): Promise<void> {
    await this.auditStatement(input).run();
  }

  async getStableChannel(): Promise<StableReleaseChannel> {
    const row = await this.db
      .prepare(
        `SELECT current_release_id, revision, updated_at
           FROM stable_release_channels WHERE channel_key = 'stable'`,
      )
      .first<{
        readonly current_release_id: string | null;
        readonly revision: number;
        readonly updated_at: number;
      }>();
    if (!row) throw new Error("T11 stable channel seed row is missing");
    return {
      key: "stable",
      currentReleaseId: row.current_release_id,
      revision: row.revision,
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  async promoteStable(input: {
    readonly releaseId: string;
    readonly expectedRevision: number;
    readonly promotedAt: string;
  }): Promise<"promoted" | "conflict" | "ineligible"> {
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE stable_release_channels
              SET current_release_id = ?, revision = revision + 1, updated_at = ?
            WHERE channel_key = 'stable' AND revision = ?
              AND EXISTS (
                SELECT 1 FROM release_candidates
                 WHERE release_id = ? AND status = 'candidate'
              )`,
        )
        .bind(
          input.releaseId,
          Date.parse(input.promotedAt),
          input.expectedRevision,
          input.releaseId,
        ),
      this.db
        .prepare(
          `UPDATE release_candidates SET status = 'available'
            WHERE release_id = ? AND status = 'candidate'
              AND EXISTS (
                SELECT 1 FROM stable_release_channels
                 WHERE channel_key = 'stable' AND current_release_id = ? AND revision = ?
              )`,
        )
        .bind(input.releaseId, input.releaseId, input.expectedRevision + 1),
      this.db
        .prepare(
          `INSERT INTO audit_events
             (event_id, repository_id, instance_id, operation_id, actor_id, actor_kind,
              action, outcome, request_id, metadata_json, occurred_at)
           SELECT ?, NULL, NULL, NULL, 'system:stable-release', 'system',
                  'release.stable.promoted', 'accepted', ?, ?, ?
            WHERE changes() = 1`,
        )
        .bind(
          `aud_release_stable_${input.releaseId}_${input.expectedRevision + 1}`,
          `release-promotion:${input.releaseId}:${input.expectedRevision + 1}`,
          JSON.stringify({
            releaseId: input.releaseId,
            channelRevision: input.expectedRevision + 1,
          }),
          Date.parse(input.promotedAt),
        ),
    ]);
    if (
      results[0]?.meta.changes === 1 &&
      results[1]?.meta.changes === 1 &&
      results[2]?.meta.changes === 1
    ) {
      return "promoted";
    }
    const current = await this.findById(input.releaseId);
    return current?.status === "candidate" ? "conflict" : "ineligible";
  }

  async getDiscoveryCheckpoint(): Promise<DiscoveryCheckpoint> {
    const row = await this.db
      .prepare(
        `SELECT cursor, revision FROM release_discovery_checkpoints WHERE checkpoint_id = 'stable'`,
      )
      .first<{ readonly cursor: string | null; readonly revision: number }>();
    if (!row) throw new Error("T11 stable discovery checkpoint row is missing");
    return { cursor: row.cursor, revision: row.revision };
  }

  async commitDiscoveryPage(input: {
    readonly expectedRevision: number;
    readonly expectedCursor: string | null;
    readonly page: CursorPage<ReleaseCandidate>;
    readonly at: string;
  }): Promise<"advanced" | "conflict"> {
    const timestamp = Date.parse(input.at);
    const lastCandidate = input.page.items.at(-1);
    const checkpointCursor =
      input.page.nextCursor ??
      (lastCandidate ? cursorEncode(lastCandidate.createdAt, lastCandidate.id) : input.expectedCursor);
    const statements = [
      this.db
        .prepare(
          `UPDATE release_discovery_checkpoints
              SET cursor = ?, revision = revision + 1, updated_at = ?
            WHERE checkpoint_id = 'stable' AND revision = ? AND cursor IS ?`,
        )
        .bind(checkpointCursor, timestamp, input.expectedRevision, input.expectedCursor),
      ...input.page.items.map((candidate) =>
        this.db
          .prepare(
            `INSERT OR IGNORE INTO release_candidate_workflows
               (release_id, state, revision, attempts, next_attempt_at, lease_owner,
                lease_epoch, lease_expires_at, canary_artifact_digest, canary_build_key,
                canary_runtime_id, canary_operation_id, healthy_since, last_healthy_at, last_health_evidence_json,
                cleanup_evidence_json, follower_cursor,
                follower_planning_complete, canary_cleanup_complete, cleanup_disposition,
                failure_code, updated_at)
             SELECT ?, 'queued', 0, 0, ?, NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                    NULL, NULL, NULL, 0, 0, NULL, NULL, ?
              WHERE EXISTS (
                SELECT 1 FROM release_discovery_checkpoints
                 WHERE checkpoint_id = 'stable' AND revision = ? AND cursor IS ?
              )`,
          )
          .bind(
            candidate.id,
            timestamp,
            timestamp,
            input.expectedRevision + 1,
            checkpointCursor,
          ),
      ),
    ];
    const results = await this.db.batch(statements);
    return results[0]?.meta.changes === 1 ? "advanced" : "conflict";
  }

  async claimCandidateWork(input: {
    readonly owner: string;
    readonly now: number;
    readonly leaseMs: number;
    readonly limit: number;
    readonly releaseId?: string;
  }): Promise<readonly CandidateWorkLease[]> {
    const limit = Math.max(1, Math.min(10, Math.trunc(input.limit)));
    const expiresAt = input.now + input.leaseMs;
    const hasReleaseId = input.releaseId !== undefined;
    const releaseIdValues: D1BindValue[] = input.releaseId === undefined ? [] : [input.releaseId];
    const releaseFilter = hasReleaseId ? "AND release_id = ?" : "";
    const selectedReleaseFilter = hasReleaseId ? "AND w.release_id = ?" : "";
    const claimValues: D1BindValue[] = [
      input.owner,
      expiresAt,
      input.now,
      input.now,
      input.now,
      ...releaseIdValues,
      limit,
      input.now,
    ];
    const selectedValues: D1BindValue[] = [
      input.owner,
      expiresAt,
      input.now,
      ...releaseIdValues,
    ];
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE release_candidate_workflows
              SET lease_owner = ?, lease_epoch = lease_epoch + 1, lease_expires_at = ?, updated_at = ?
            WHERE release_id IN (
              SELECT release_id FROM release_candidate_workflows
               WHERE state NOT IN ('complete', 'blocked', 'rejected', 'superseded')
                 AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
                 AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
                 ${releaseFilter}
               ORDER BY COALESCE(next_attempt_at, 0), release_id LIMIT ?
            )
              AND state NOT IN ('complete', 'blocked', 'rejected', 'superseded')
              AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
        )
        .bind(...claimValues),
      this.db
        .prepare(
          `SELECT c.release_id, c.image_digest, c.status, c.candidate_json,
                  w.release_id, w.state, w.revision, w.attempts, w.next_attempt_at,
                  w.lease_owner, w.lease_epoch, w.lease_expires_at,
                  w.canary_artifact_digest, w.canary_build_key, w.canary_runtime_id,
                  w.canary_operation_id,
                  w.healthy_since, w.last_healthy_at, w.last_health_evidence_json,
                  w.cleanup_evidence_json, w.follower_cursor,
                  w.follower_planning_complete, w.canary_cleanup_complete,
                  w.cleanup_disposition, w.failure_code, w.updated_at
             FROM release_candidate_workflows AS w
             JOIN release_candidates AS c ON c.release_id = w.release_id
            WHERE w.lease_owner = ? AND w.lease_expires_at = ? AND w.updated_at = ?
              ${selectedReleaseFilter}
            ORDER BY COALESCE(w.next_attempt_at, 0), w.release_id`,
        )
        .bind(...selectedValues),
    ]);
    const rows = (results[1]?.results ?? []) as readonly (CandidateRow & WorkflowRow)[];
    return rows.map((row) => {
      const workflow = readWorkflow(row);
      if (workflow.leaseExpiresAt === null || workflow.leaseOwner === null) {
        throw new TypeError("claimed release workflow is missing its lease");
      }
      return {
        candidate: readCandidate(row),
        workflow,
        owner: workflow.leaseOwner,
        epoch: workflow.leaseEpoch,
      };
    });
  }

  async saveCandidateWorkflow(input: {
    readonly lease: CandidateWorkLease;
    readonly next: Omit<
      CandidateWorkflow,
      "revision" | "leaseOwner" | "leaseEpoch" | "leaseExpiresAt"
    >;
    readonly releaseLease: boolean;
  }): Promise<"saved" | "stale"> {
    const { lease, next, releaseLease } = input;
    const leaseOwner = releaseLease ? null : lease.owner;
    const leaseExpiresAt = releaseLease ? null : lease.workflow.leaseExpiresAt;
    const values = workflowValues({ ...lease.workflow, ...next });
    const result = await this.db
      .prepare(
        `UPDATE release_candidate_workflows
            SET state = ?, attempts = ?, next_attempt_at = ?, canary_artifact_digest = ?,
                canary_build_key = ?, canary_runtime_id = ?, canary_operation_id = ?, healthy_since = ?,
                last_healthy_at = ?, last_health_evidence_json = ?, cleanup_evidence_json = ?,
                follower_cursor = ?, follower_planning_complete = ?,
                canary_cleanup_complete = ?, cleanup_disposition = ?, failure_code = ?,
                updated_at = ?, revision = revision + 1, lease_owner = ?, lease_expires_at = ?
          WHERE release_id = ? AND revision = ? AND lease_owner = ? AND lease_epoch = ?
            AND lease_expires_at > ?`,
      )
      .bind(
        ...values,
        leaseOwner,
        leaseExpiresAt,
        lease.workflow.releaseId,
        lease.workflow.revision,
        lease.owner,
        lease.epoch,
        Date.parse(next.updatedAt),
      )
      .run();
    return result.meta.changes === 1 ? "saved" : "stale";
  }

  async recordFollowerPage(input: {
    readonly releaseId: string;
    readonly expectedCursor: string | null;
    readonly page: CursorPage<StableFollower>;
    readonly at: string;
  }): Promise<"recorded" | "stale"> {
    const pageHash = await digest(input.page.items);
    const current = await this.db
      .prepare(
        `SELECT cursor, revision, last_input_cursor, last_next_cursor, last_page_hash
           FROM stable_rollout_fanout WHERE release_id = ?`,
      )
      .bind(input.releaseId)
      .first<FanoutRow>();
    if (
      current &&
      current.cursor !== input.expectedCursor &&
      current.last_input_cursor === input.expectedCursor &&
      current.last_next_cursor === input.page.nextCursor &&
      current.last_page_hash === pageHash
    ) {
      return "recorded";
    }
    if (current && current.cursor !== input.expectedCursor) return "stale";

    const timestamp = Date.parse(input.at);
    const expectedRevision = current?.revision ?? 0;
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `INSERT OR IGNORE INTO stable_rollout_fanout
             (release_id, cursor, revision, complete, last_input_cursor,
              last_next_cursor, last_page_hash, updated_at)
           VALUES (?, NULL, 0, 0, NULL, NULL, NULL, ?)`,
        )
        .bind(input.releaseId, timestamp),
      this.db
        .prepare(
          `UPDATE stable_rollout_fanout
              SET cursor = ?, revision = revision + 1, complete = ?,
                  last_input_cursor = ?, last_next_cursor = ?, last_page_hash = ?, updated_at = ?
            WHERE release_id = ? AND revision = ? AND cursor IS ?`,
        )
        .bind(
          input.page.nextCursor,
          Number(input.page.nextCursor === null),
          input.expectedCursor,
          input.page.nextCursor,
          pageHash,
          timestamp,
          input.releaseId,
          expectedRevision,
          input.expectedCursor,
        ),
      ...(await Promise.all(
        input.page.items.map(async (follower) => {
          const id = await rolloutId(input.releaseId, follower.instanceId);
          return this.db
            .prepare(
              `INSERT OR IGNORE INTO stable_rollouts
               (rollout_id, release_id, instance_id, cluster_id, snapshot_json, state,
                revision, build_key, build_id, artifact_digest, deployment_revision_id,
                operation_id, failure_code, next_attempt_at, updated_at)
             SELECT ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?
              WHERE EXISTS (
                SELECT 1 FROM stable_rollout_fanout
                 WHERE release_id = ? AND revision = ? AND last_page_hash = ?
              )`,
            )
            .bind(
              id,
              input.releaseId,
              follower.instanceId,
              follower.clusterId,
              JSON.stringify(follower),
              timestamp,
              timestamp,
              input.releaseId,
              expectedRevision + 1,
              pageHash,
            );
        }),
      )),
    ];
    const results = await this.db.batch(statements);
    return results[1]?.meta.changes === 1 ? "recorded" : "stale";
  }

  async listDueRollouts(now: number, limit: number): Promise<readonly StableRollout[]> {
    const size = Math.max(1, Math.min(100, Math.trunc(limit)));
    const states = ACTIVE_ROLLOUT_STATES.map(() => "?").join(", ");
    const rows = await this.db
      .prepare(
        `SELECT rollout_id, release_id, instance_id, cluster_id, snapshot_json, state,
                revision, build_key, build_id, artifact_digest, deployment_revision_id,
                operation_id, failure_code, next_attempt_at, updated_at
           FROM stable_rollouts
          WHERE state IN (${states}) AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
          ORDER BY COALESCE(next_attempt_at, 0), updated_at, rollout_id LIMIT ?`,
      )
      .bind(...ACTIVE_ROLLOUT_STATES, now, size)
      .all<RolloutRow>();
    return (rows.results ?? []).map(readRollout);
  }

  async findRollout(id: string): Promise<StableRollout | null> {
    const row = await this.db
      .prepare(
        `SELECT rollout_id, release_id, instance_id, cluster_id, snapshot_json, state,
                revision, build_key, build_id, artifact_digest, deployment_revision_id,
                operation_id, failure_code, next_attempt_at, updated_at
           FROM stable_rollouts WHERE rollout_id = ?`,
      )
      .bind(id)
      .first<RolloutRow>();
    return row ? readRollout(row) : null;
  }

  async saveRollout(input: {
    readonly rollout: StableRollout;
    readonly expectedRevision: number;
    readonly at: string;
  }): Promise<"saved" | "stale"> {
    const values = rolloutValues(input.rollout);
    const result = await this.db
      .prepare(
        `UPDATE stable_rollouts
            SET instance_id = ?, cluster_id = ?, snapshot_json = ?, state = ?, build_key = ?,
                build_id = ?, artifact_digest = ?, deployment_revision_id = ?, operation_id = ?,
                failure_code = ?, next_attempt_at = ?, updated_at = ?, revision = revision + 1
          WHERE rollout_id = ? AND revision = ?`,
      )
      .bind(...values, input.rollout.id, input.expectedRevision)
      .run();
    return result.meta.changes === 1 ? "saved" : "stale";
  }

  async claimClusterLease(input: {
    readonly clusterId: string;
    readonly rolloutId: string;
    readonly owner: string;
    readonly now: number;
    readonly leaseMs: number;
  }): Promise<ClusterRolloutLease | null> {
    const expiresAt = input.now + input.leaseMs;
    const rows = await this.db.batch([
      this.db
        .prepare(
          `INSERT OR IGNORE INTO cluster_rollout_leases
             (cluster_id, rollout_id, owner, lease_epoch, lease_expires_at,
              active_operation_id, updated_at)
           VALUES (?, ?, ?, 0, 0, NULL, ?)`,
        )
        .bind(input.clusterId, input.rolloutId, input.owner, input.now),
      this.db
        .prepare(
          `UPDATE cluster_rollout_leases
              SET rollout_id = ?, owner = ?, lease_epoch = lease_epoch + 1,
                  lease_expires_at = ?, updated_at = ?
            WHERE cluster_id = ? AND active_operation_id IS NULL
              AND (lease_expires_at <= ? OR (rollout_id = ? AND owner = ?))`,
        )
        .bind(
          input.rolloutId,
          input.owner,
          expiresAt,
          input.now,
          input.clusterId,
          input.now,
          input.rolloutId,
          input.owner,
        ),
      this.db
        .prepare(
          `SELECT cluster_id, rollout_id, owner, lease_epoch, lease_expires_at, active_operation_id
             FROM cluster_rollout_leases
            WHERE cluster_id = ? AND rollout_id = ? AND owner = ? AND lease_expires_at = ?
              AND active_operation_id IS NULL`,
        )
        .bind(input.clusterId, input.rolloutId, input.owner, expiresAt),
    ]);
    const row = rows[2]?.results?.[0] as ClusterLeaseRow | undefined;
    return row ? readClusterLease(row) : null;
  }

  async findClusterLease(clusterId: string): Promise<ClusterRolloutLease | null> {
    const row = await this.db
      .prepare(
        `SELECT cluster_id, rollout_id, owner, lease_epoch, lease_expires_at, active_operation_id
           FROM cluster_rollout_leases WHERE cluster_id = ?`,
      )
      .bind(clusterId)
      .first<ClusterLeaseRow>();
    return row ? readClusterLease(row) : null;
  }

  async renewClusterLease(input: {
    readonly lease: ClusterRolloutLease;
    readonly now: number;
    readonly leaseMs: number;
  }): Promise<ClusterRolloutLease | null> {
    const expiresAt = input.now + input.leaseMs;
    const result = await this.db
      .prepare(
        `UPDATE cluster_rollout_leases
            SET lease_expires_at = ?, updated_at = ?
          WHERE cluster_id = ? AND rollout_id = ? AND owner = ? AND lease_epoch = ?
            AND active_operation_id IS ?
            AND (active_operation_id IS NOT NULL OR lease_expires_at > ?)`,
      )
      .bind(
        expiresAt,
        input.now,
        input.lease.clusterId,
        input.lease.rolloutId,
        input.lease.owner,
        input.lease.epoch,
        input.lease.activeOperationId,
        input.now,
      )
      .run();
    return result.meta.changes === 1 ? this.findClusterLease(input.lease.clusterId) : null;
  }

  async releaseClusterLease(lease: ClusterRolloutLease): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE cluster_rollout_leases
            SET lease_expires_at = 0, updated_at = 0
          WHERE cluster_id = ? AND rollout_id = ? AND owner = ? AND lease_epoch = ?
            AND active_operation_id IS NULL`,
      )
      .bind(lease.clusterId, lease.rolloutId, lease.owner, lease.epoch)
      .run();
    return result.meta.changes === 1;
  }

  async dispatchUnderClusterLease(input: {
    readonly lease: ClusterRolloutLease;
    readonly rollout: StableRollout;
    readonly current: StableFollower;
    readonly actorId: string;
    readonly idempotencyKey: string;
    readonly at: string;
  }): Promise<FencedUpdateResult> {
    if (
      input.lease.clusterId !== input.rollout.clusterId ||
      input.lease.rolloutId !== input.rollout.id ||
      input.current.clusterId !== input.rollout.clusterId ||
      input.lease.activeOperationId !== null ||
      input.rollout.state !== "dispatch_pending" ||
      !input.rollout.buildKey ||
      !input.rollout.buildId ||
      !input.rollout.artifactDigest
    ) {
      return { kind: "lease_lost" };
    }
    const now = Date.parse(input.at);
    const operationId = this.createOperationId();
    const stageKey = await stableRolloutStageIdempotencyKey(
      input.rollout.releaseId,
      input.current.instanceId,
      input.current.configurationRevision,
    );
    const stage = await this.stagedActivator.findStageByIdempotency(
      input.current.repositoryId,
      stageKey,
    );
    if (
      !stage ||
      stage.status !== "staged" ||
      stage.buildKey !== input.rollout.buildKey ||
      stage.buildId !== input.rollout.buildId ||
      stage.artifactDigest !== input.rollout.artifactDigest
    ) {
      return { kind: "stale" };
    }
    const activated = await this.stagedActivator.activateStageUnderClusterFence({
      stageId: stage.stageId,
      clusterId: input.lease.clusterId,
      rolloutId: input.rollout.id,
      releaseId: input.rollout.releaseId,
      owner: input.lease.owner,
      leaseEpoch: input.lease.epoch,
      expectedRolloutRevision: input.rollout.revision,
      expectedBuildKey: input.rollout.buildKey,
      expectedBuildId: input.rollout.buildId,
      expectedArtifactDigest: input.rollout.artifactDigest,
      actorId: input.actorId,
      actorKind: "system",
      requestId: stageKey,
      operationId,
      operationIdempotencyKey: input.idempotencyKey,
      now,
    });
    return activated
      ? { kind: "dispatched", operationId: activated.operationId, generation: activated.generation }
      : { kind: "stale" };
  }

  async setOperationResult(input: {
    readonly rolloutId: string;
    readonly expectedRevision: number;
    readonly operation: OperationObservation;
    readonly at: string;
  }): Promise<"saved" | "stale"> {
    const rollout = await this.findRollout(input.rolloutId);
    if (
      !rollout ||
      rollout.revision !== input.expectedRevision ||
      rollout.state !== "operation_pending" ||
      rollout.operationId === null ||
      input.operation.operationId !== rollout.operationId
    ) {
      return "stale";
    }
    let state: StableRollout["state"];
    let failureCode: string | null;
    if (input.operation.status === "succeeded") {
      state = "complete";
      failureCode = null;
    } else if (input.operation.status === "failed" || input.operation.status === "blocked") {
      state = "blocked";
      failureCode = input.operation.code;
    } else {
      return "stale";
    }
    const now = Date.parse(input.at);
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE stable_rollouts
              SET state = ?, failure_code = ?, next_attempt_at = NULL,
                  updated_at = ?, revision = revision + 1
            WHERE rollout_id = ? AND revision = ? AND state = 'operation_pending'
              AND operation_id = ?
              AND EXISTS (
                SELECT 1 FROM cluster_rollout_leases
                 WHERE cluster_id = ? AND rollout_id = ? AND active_operation_id = ?
              )`,
        )
        .bind(
          state,
          failureCode,
          now,
          rollout.id,
          input.expectedRevision,
          rollout.operationId,
          rollout.clusterId,
          rollout.id,
          rollout.operationId,
        ),
      this.db
        .prepare(
          `UPDATE cluster_rollout_leases
              SET active_operation_id = NULL, lease_expires_at = 0, updated_at = ?
            WHERE cluster_id = ? AND rollout_id = ? AND active_operation_id = ?
              AND changes() = 1
              AND EXISTS (
                SELECT 1 FROM stable_rollouts
                 WHERE rollout_id = ? AND revision = ? AND state = ?
                   AND operation_id = ?
              )`,
        )
        .bind(
          now,
          rollout.clusterId,
          rollout.id,
          rollout.operationId,
          rollout.id,
          input.expectedRevision + 1,
          state,
          rollout.operationId,
        ),
    ]);
    return results[0]?.meta.changes === 1 ? "saved" : "stale";
  }

  async hasUnsettledRollouts(releaseId: string): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 AS found FROM stable_rollouts
          WHERE release_id = ? AND state NOT IN
            ('complete', 'deferred_stopped', 'skipped_pinned', 'blocked', 'superseded')
          LIMIT 1`,
      )
      .bind(releaseId)
      .first<{ readonly found: number }>();
    return row !== null;
  }
}

function operatorRetryStatus(row: OperatorRetryStatusRow): ReleaseRetryStatus {
  const buildFailure = safeBuildFailure(row.build_failure_json);
  return {
    release: {
      id: row.release_id,
      version: row.version,
      imageDigest: row.image_digest,
      status: row.candidate_status,
    },
    workflow: {
      state: row.workflow_state,
      revision: row.workflow_revision,
      failureCode: row.workflow_failure_code,
      attempts: row.workflow_attempts,
      nextAttemptAt: row.workflow_next_attempt_at,
      canaryBuildKey: row.canary_build_key,
      canaryOperationId: row.canary_operation_id,
    },
    build:
      row.build_id && row.build_status
        ? {
            id: row.build_id,
            status: row.build_status,
            attemptCount: row.build_attempt_count ?? 0,
            progress: safeBuildProgress(row.build_progress_json),
            failure: buildFailure,
          }
        : null,
  };
}

function safeBuildProgress(
  value: string | null,
): NonNullable<ReleaseRetryStatus["build"]>["progress"] {
  if (!value) return null;
  try {
    const progress: unknown = JSON.parse(value);
    if (typeof progress !== "object" || progress === null || Array.isArray(progress)) return null;
    const item = progress as Record<string, unknown>;
    if (
      item.stage !== "preparing" &&
      item.stage !== "building" &&
      item.stage !== "publishing"
    ) {
      return null;
    }
    if (
      item.percent !== null &&
      (typeof item.percent !== "number" || !Number.isFinite(item.percent) || item.percent < 0 || item.percent > 100)
    ) {
      return null;
    }
    return { stage: item.stage, percent: item.percent };
  } catch {
    return null;
  }
}

function safeBuildFailure(
  value: string | null,
): NonNullable<ReleaseRetryStatus["build"]>["failure"] {
  if (!value) return null;
  try {
    const failure: unknown = JSON.parse(value);
    if (typeof failure !== "object" || failure === null || Array.isArray(failure)) return null;
    const item = failure as Record<string, unknown>;
    if (
      item.code !== "BUILD_FAILED" &&
      item.code !== "BUILD_TIMEOUT" &&
      item.code !== "BUILD_CANCELED" &&
      item.code !== "ARTIFACT_REJECTED"
    ) {
      return null;
    }
    return { code: item.code, retryable: item.retryable === true };
  } catch {
    return null;
  }
}

function isEligiblePreRuntimeCanaryRetry(
  row: OperatorRetryContextRow,
  canary: ReleaseRetryCommand["canary"],
): boolean {
  let candidate: ReleaseCandidate;
  let selection: unknown;
  let failure: unknown;
  try {
    candidate = ReleaseCandidateSchema.parse(JSON.parse(row.candidate_json) as unknown);
    selection = JSON.parse(row.revision_selection_json) as unknown;
    failure = row.build_failure_json ? (JSON.parse(row.build_failure_json) as unknown) : null;
  } catch {
    return false;
  }
  const selected =
    typeof selection === "object" && selection !== null && !Array.isArray(selection)
      ? (selection as Record<string, unknown>)
      : null;
  const buildFailure =
    typeof failure === "object" && failure !== null && !Array.isArray(failure)
      ? (failure as Record<string, unknown>)
      : null;
  const retryableWorkflowState =
    (row.workflow_state === "blocked" && row.workflow_failure_code === "canary_build_failed") ||
    (row.workflow_state === "canary_building" && row.workflow_failure_code === null);
  const requestedModules = [...canary.requestedModules].sort();
  return (
    candidate.id.length > 0 &&
    candidate.status === "candidate" &&
    row.candidate_status === "candidate" &&
    retryableWorkflowState &&
    row.workflow_lease_owner === null &&
    row.workflow_lease_expires_at === null &&
    row.workflow_canary_artifact_digest === null &&
    row.workflow_canary_runtime_id === null &&
    row.workflow_canary_operation_id === null &&
    row.workflow_healthy_since === null &&
    row.workflow_last_healthy_at === null &&
    row.workflow_last_health_evidence_json === null &&
    row.workflow_cleanup_evidence_json === null &&
    row.workflow_follower_cursor === null &&
    row.workflow_follower_planning_complete === 0 &&
    row.workflow_canary_cleanup_complete === 0 &&
    row.workflow_cleanup_disposition === null &&
    row.canary_build_key === row.build_key &&
    row.revision_id.length > 0 &&
    row.revision_status === "failed" &&
    row.revision_artifact_digest === null &&
    row.revision_actor_id === "system:stable-release-canary" &&
    row.revision_generation === row.instance_generation &&
    row.build_status === "failed" &&
    (buildFailure?.code === "BUILD_FAILED" ||
      buildFailure?.code === "BUILD_TIMEOUT" ||
      (buildFailure?.code === "ARTIFACT_REJECTED" &&
        buildFailure.reason === "registry_mismatch" &&
        buildFailure.retryable === false)) &&
    row.build_active_attempt_id !== null &&
    row.active_attempt_status === "failed" &&
    row.active_attempt_epoch === row.build_lease_epoch &&
    row.build_attempt_count > 0 &&
    row.binding_suspended === 0 &&
    row.binding_epoch === canary.bindingEpoch &&
    row.authorization_revision === canary.authorizationRevision &&
    row.instance_generation === row.revision_generation &&
    row.instance_runtime_epoch === 0 &&
    row.instance_desired_state === "stopped" &&
    row.instance_observed_state === "absent" &&
    row.instance_observed_generation === null &&
    row.instance_observed_runtime_epoch === null &&
    row.instance_desired_revision_id === row.revision_id &&
    row.instance_desired_artifact_digest === null &&
    (row.instance_reservation_state === "none" || row.instance_reservation_state === "released") &&
    row.instance_reservation_id === null &&
    row.has_instance_operations === 0 &&
    row.has_instance_reservations === 0 &&
    row.has_runtime_health_observations === 0 &&
    row.has_build_artifacts === 0 &&
    selected !== null &&
    selected.releaseId === candidate.id &&
    selected.policy === "pinned" &&
    selected.resourceProfileId === canary.resourceProfileId &&
    Array.isArray(selected.requestedModules) &&
    selected.requestedModules.length === requestedModules.length &&
    selected.requestedModules.every((module, index) => module === requestedModules[index])
  );
}

function retryEligibilitySql(buildStatus: "failed", revisionStatus: "failed"): string {
  return `SELECT 1 FROM release_candidate_workflows w
    JOIN release_candidates c ON c.release_id = w.release_id
    JOIN idempotency_records p
      ON p.scope = ?
     AND p.idempotency_key = 'stable-canary-plan:' || c.release_id
     AND p.response_kind = 'configuration-plan'
    JOIN deployment_revisions d ON d.revision_id = p.response_id
    JOIN logical_instances i ON i.instance_id = ?
    JOIN repository_bindings rb ON rb.repository_id = ? AND rb.instance_id = i.instance_id
    JOIN builds b ON b.build_key = w.canary_build_key AND b.build_id = d.build_id
    JOIN build_attempts a ON a.attempt_id = b.active_attempt_id AND a.build_id = b.build_id
   WHERE (
       c.release_id = ? AND c.candidate_json = ? AND c.status = 'candidate'
       AND w.release_id = c.release_id AND w.revision = ?
       AND (
         (w.state = 'blocked' AND w.failure_code = 'canary_build_failed')
         OR (w.state = 'canary_building' AND w.failure_code IS NULL)
       )
       AND w.lease_owner IS NULL
       AND w.lease_expires_at IS NULL AND w.canary_artifact_digest IS NULL
       AND w.canary_runtime_id IS NULL AND w.canary_operation_id IS NULL
       AND w.healthy_since IS NULL AND w.last_healthy_at IS NULL
       AND w.last_health_evidence_json IS NULL AND w.cleanup_evidence_json IS NULL
       AND w.follower_cursor IS NULL AND w.follower_planning_complete = 0
       AND w.canary_cleanup_complete = 0 AND w.cleanup_disposition IS NULL
     ) AND (
       d.status = '${revisionStatus}' AND d.artifact_digest IS NULL
       AND d.actor_id = 'system:stable-release-canary' AND d.instance_id = i.instance_id
       AND d.repository_id = i.repository_id AND d.generation = i.generation
       AND json_extract(d.selection_json, '$.releaseId') = c.release_id
       AND json_extract(d.selection_json, '$.policy') = 'pinned'
       AND json_extract(d.selection_json, '$.resourceProfileId') = ?
       AND json_extract(d.selection_json, '$.requestedModules') = ?
       AND p.response_id = d.revision_id AND b.build_id = builds.build_id
       AND b.build_key = w.canary_build_key AND b.status = '${buildStatus}'
       AND b.failure_json IS NOT NULL
       AND (
         json_extract(b.failure_json, '$.code') IN ('BUILD_FAILED', 'BUILD_TIMEOUT')
         OR (
           json_extract(b.failure_json, '$.code') = 'ARTIFACT_REJECTED'
           AND json_extract(b.failure_json, '$.reason') = 'registry_mismatch'
           AND json_extract(b.failure_json, '$.retryable') = 0
         )
       )
       AND b.active_attempt_id IS NOT NULL AND a.status = 'failed'
       AND a.lease_epoch = b.lease_epoch AND b.attempt_count > 0
       AND b.cancel_requested = 0 AND b.artifact_digest IS NULL
       AND b.candidate_ref IS NULL AND b.manifest_digest IS NULL
     ) AND (
       rb.binding_epoch = ? AND rb.authorization_revision = ? AND rb.suspended = 0
       AND i.desired_revision_id = d.revision_id AND i.desired_state = 'stopped'
       AND i.observed_state = 'absent' AND i.observed_generation IS NULL
       AND i.observed_runtime_epoch IS NULL AND i.runtime_epoch = 0
       AND i.reservation_state IN ('none', 'released') AND i.reservation_id IS NULL
       AND i.desired_artifact_digest IS NULL
     ) AND (
       NOT EXISTS (SELECT 1 FROM operations op WHERE op.instance_id = i.instance_id)
       AND NOT EXISTS (SELECT 1 FROM runtime_reservations rr WHERE rr.instance_id = i.instance_id)
       AND NOT EXISTS (SELECT 1 FROM runtime_health_observations ho WHERE ho.instance_id = i.instance_id)
       AND NOT EXISTS (SELECT 1 FROM artifacts ar WHERE ar.build_id = b.build_id)
     )`;
}

function retryEligibilityValues(input: {
  readonly releaseId: string;
  readonly candidateJson: string;
  readonly expectedRevision: number;
  readonly canary: ReleaseRetryCommand["canary"];
  readonly modulesJson: string;
}): readonly D1BindValue[] {
  return [
    `repository:${input.canary.repositoryId}`,
    input.canary.instanceId,
    input.canary.repositoryId,
    input.releaseId,
    input.candidateJson,
    input.expectedRevision,
    input.canary.resourceProfileId,
    input.modulesJson,
    input.canary.bindingEpoch,
    input.canary.authorizationRevision,
  ];
}

function isTransactionAssertion(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("platform_transaction_sentinel");
}

function isConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unique constraint|constraint failed/iu.test(message);
}
