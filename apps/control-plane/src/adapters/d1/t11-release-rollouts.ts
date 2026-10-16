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
} from "@praetorium/application/releases";
import type {
  ClusterRolloutLease,
  OperationObservation,
  StableFollower,
  StableRollout,
  StableRolloutRepository,
} from "@praetorium/application/rollouts";

/** Minimal structural subset of Cloudflare D1 used by this adapter. */
export type D1BindValue = string | number | null | boolean | ArrayBuffer | ArrayBufferView;

export interface D1PreparedStatement {
  bind(...values: D1BindValue[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(columnName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result<never>>;
}

export interface D1Result<T> {
  readonly results?: readonly T[];
  readonly success?: boolean;
  readonly meta: { readonly changes: number };
}

export interface T11D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

export type FencedUpdateResult =
  | { readonly kind: "dispatched"; readonly operationId: string; readonly generation: number }
  | { readonly kind: "stale" | "pinned" | "stopped" | "lease_lost" };

/**
 * Implemented by the D1PlatformStore composition root. It executes the supplied
 * T11 statements and the normal desired-update operation in one D1 batch.
 */
export interface FencedDesiredUpdateWriter {
  enqueueDesiredUpdateWithFence(input: {
    readonly operationId: string;
    readonly fenceStatements: readonly D1PreparedStatement[];
    readonly instanceId: string;
    readonly repositoryId: number;
    readonly bindingEpoch: number;
    readonly authorizationRevision: number;
    readonly expectedGeneration: number;
    readonly expectedRuntimeEpoch: number;
    readonly expectedClusterId: string;
    readonly expectedConfigurationRevision: string;
    readonly expectedDesiredState: "running";
    readonly expectedPolicy: "stable";
    readonly targetRevisionId: string;
    readonly actorId: string;
    readonly idempotencyKey: string;
    readonly requestId: string;
    readonly now: string;
  }): Promise<FencedUpdateResult>;
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

const ACTIVE_ROLLOUT_STATES = [
  "pending",
  "building",
  "waiting_build",
  "dispatch_pending",
  "operation_pending",
] as const;
const NEXT_OPERATION_POLL_MS = 5 * 60 * 1_000;

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
    private readonly updateWriter: FencedDesiredUpdateWriter,
    private readonly createOperationId: () => string = () => crypto.randomUUID(),
  ) {}

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
    const result = await this.db
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
      )
      .run();
    return result.meta.changes === 1 ? "created" : "duplicate";
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
      this.db
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
        ),
      this.auditStatement(audit, true),
    ]);
    return results[0]?.meta.changes === 1 ? "created" : "duplicate";
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
    const statements = [
      this.db
        .prepare(
          `UPDATE release_discovery_checkpoints
              SET cursor = ?, revision = revision + 1, updated_at = ?
            WHERE checkpoint_id = 'stable' AND revision = ? AND cursor IS ?`,
        )
        .bind(input.page.nextCursor, timestamp, input.expectedRevision, input.expectedCursor),
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
            input.page.nextCursor,
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
  }): Promise<readonly CandidateWorkLease[]> {
    const limit = Math.max(1, Math.min(10, Math.trunc(input.limit)));
    const expiresAt = input.now + input.leaseMs;
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
               ORDER BY COALESCE(next_attempt_at, 0), release_id LIMIT ?
            )
              AND state NOT IN ('complete', 'blocked', 'rejected', 'superseded')
              AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
        )
        .bind(input.owner, expiresAt, input.now, input.now, input.now, limit, input.now),
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
            ORDER BY COALESCE(w.next_attempt_at, 0), w.release_id`,
        )
        .bind(input.owner, expiresAt, input.now),
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
      !input.rollout.deploymentRevisionId
    ) {
      return { kind: "lease_lost" };
    }
    const now = Date.parse(input.at);
    const operationId = this.createOperationId();
    const fenceStatements = [
      this.db
        .prepare(
          `UPDATE cluster_rollout_leases
              SET active_operation_id = ?, updated_at = ?
            WHERE cluster_id = ? AND rollout_id = ? AND owner = ? AND lease_epoch = ?
              AND lease_expires_at > ? AND active_operation_id IS NULL`,
        )
        .bind(
          operationId,
          now,
          input.lease.clusterId,
          input.lease.rolloutId,
          input.lease.owner,
          input.lease.epoch,
          now,
        ),
      this.db
        .prepare(
          `UPDATE stable_rollouts
              SET state = 'operation_pending', operation_id = ?,
                  next_attempt_at = ?, updated_at = ?, revision = revision + 1
            WHERE rollout_id = ? AND revision = ? AND state = 'dispatch_pending'
              AND operation_id IS NULL AND deployment_revision_id = ?
              AND EXISTS (
                SELECT 1 FROM stable_release_channels
                 WHERE channel_key = 'stable' AND current_release_id = ?
              )
              AND changes() = 1`,
        )
        .bind(
          operationId,
          now + NEXT_OPERATION_POLL_MS,
          now,
          input.rollout.id,
          input.rollout.revision,
          input.rollout.deploymentRevisionId,
          input.rollout.releaseId,
        ),
    ];
    return this.updateWriter.enqueueDesiredUpdateWithFence({
      operationId,
      fenceStatements,
      instanceId: input.current.instanceId,
      repositoryId: input.current.repositoryId,
      bindingEpoch: input.current.bindingEpoch,
      authorizationRevision: input.current.authorizationRevision,
      expectedGeneration: input.current.generation,
      expectedRuntimeEpoch: input.current.runtimeEpoch,
      expectedClusterId: input.current.clusterId,
      expectedConfigurationRevision: input.current.configurationRevision,
      expectedDesiredState: "running",
      expectedPolicy: "stable",
      targetRevisionId: input.rollout.deploymentRevisionId,
      actorId: input.actorId,
      idempotencyKey: input.idempotencyKey,
      requestId: `stable-rollout:${input.rollout.id}`,
      now: input.at,
    });
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
