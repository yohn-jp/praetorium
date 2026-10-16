import {
  BuildInputSchema,
  ResourceRequirementsSchema,
  RuntimeMetadataSchema,
  buildKey as calculateBuildKey,
  canonicalBuildInput,
} from "@praetorium/contracts";
import { ConfigurationSelectionSchema } from "@praetorium/application/configurations";
import type {
  ConfigurationBinding,
  ConfigurationContext,
  ConfigurationInstance,
  ConfigurationOperation,
  ConfigurationPlanMutation,
  ConfigurationPlanReceipt,
  ConfigurationRevision,
  ConfigurationSelection,
  ConfigurationStore,
} from "@praetorium/application/configurations";
import {
  ConfigurationIdempotencyConflictError,
} from "@praetorium/application/configurations";
import type { D1Database, D1PreparedStatement } from "./types.js";

interface JoinedRow {
  repository_id: number;
  instance_id: string;
  binding_epoch: number;
  authorization_revision: number;
  suspended: number;
  generation: number;
  runtime_epoch: number;
  desired_state: "running" | "stopped";
  policy: "stable" | "pinned";
  observed_generation: number | null;
  observed_runtime_epoch: number | null;
  observed_sequence: number;
  observed_state: ConfigurationInstance["observedState"];
  desired_revision_id: string | null;
  observed_revision_id: string | null;
  desired_artifact_digest: string | null;
  current_artifact_digest: string | null;
  reservation_state: ConfigurationInstance["reservationState"];
  reservation_id: string | null;
  created_at: number;
  updated_at: number;
}

interface RevisionRow {
  revision_id: string;
  instance_id: string;
  repository_id: number;
  generation: number;
  build_key: string;
  build_id: string;
  selection_json: string;
  resource_requirements_json: string;
  runtime_metadata_json: string;
  artifact_digest: string | null;
  status: ConfigurationRevision["status"];
  actor_id: string;
  created_at: number;
}

interface OperationRow {
  operation_id: string;
  instance_id: string;
  repository_id: number;
  generation: number;
  runtime_epoch: number;
  kind: ConfigurationOperation["kind"];
  status: ConfigurationOperation["status"];
  attempt: number;
  lease_epoch: number;
  report_sequence: number;
  lease_expires_at: number | null;
  cluster_id: string | null;
  reservation_id: string | null;
  deployment_revision_id: string | null;
  build_id: string | null;
  prerequisite_build_id: string | null;
  idempotency_key: string;
  idempotency_scope: string;
  phase: string;
  worker_id: string | null;
  lease_token: string | null;
  request_hash: string;
  checkpoint_sequence: number;
  checkpoint_json: string | null;
  result_json: string | null;
  created_at: number;
  updated_at: number;
}

interface IdempotencyRow {
  request_hash: string;
  response_kind: string;
  response_id: string;
}

const INSTANCE_COLUMNS = `
  b.repository_id, b.instance_id, b.binding_epoch, b.authorization_revision, b.suspended,
  i.generation, i.runtime_epoch, i.desired_state, i.policy,
  i.observed_generation, i.observed_runtime_epoch, i.observed_sequence, i.observed_state,
  i.desired_revision_id, i.observed_revision_id, i.desired_artifact_digest, i.current_artifact_digest,
  i.reservation_state, i.reservation_id, i.created_at, i.updated_at`;

/** D1 persistence for expected-generation configuration and deployment revision planning. */
export class D1ConfigurationStore implements ConfigurationStore {
  constructor(private readonly db: D1Database) {}

  async getPlanContext(repositoryId: number): Promise<ConfigurationContext | null> {
    return this.findContext("b.repository_id = ?", repositoryId);
  }

  async getByInstance(instanceId: string): Promise<ConfigurationContext | null> {
    return this.findContext("b.instance_id = ?", instanceId);
  }

  async getCurrentRevision(instanceId: string): Promise<ConfigurationRevision | null> {
    const row = await this.db
      .prepare(
        `SELECT d.* FROM logical_instances i
         JOIN deployment_revisions d ON d.revision_id = i.desired_revision_id
         WHERE i.instance_id = ? LIMIT 1`,
      )
      .bind(instanceId)
      .first<RevisionRow>();
    return row ? toRevision(row) : null;
  }

  async getRevision(revisionId: string): Promise<ConfigurationRevision | null> {
    const row = await this.db
      .prepare("SELECT * FROM deployment_revisions WHERE revision_id = ?")
      .bind(revisionId)
      .first<RevisionRow>();
    return row ? toRevision(row) : null;
  }

  async findPlanByIdempotency(input: {
    readonly repositoryId: number;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  }): Promise<ConfigurationPlanReceipt | null> {
    const row = await this.findIdempotency(input.repositoryId, input.idempotencyKey);
    if (!row) return null;
    if (row.request_hash !== input.requestHash || row.response_kind !== "configuration-plan") {
      throw new ConfigurationIdempotencyConflictError();
    }
    return this.receipt(row.response_id);
  }

  async getPlanByIdempotency(input: {
    readonly repositoryId: number;
    readonly idempotencyKey: string;
  }): Promise<ConfigurationPlanReceipt | null> {
    const row = await this.findIdempotency(input.repositoryId, input.idempotencyKey);
    if (!row) return null;
    if (row.response_kind !== "configuration-plan") throw new ConfigurationIdempotencyConflictError();
    return this.receipt(row.response_id);
  }

  async commitPlan(input: ConfigurationPlanMutation): Promise<ConfigurationPlanReceipt | null> {
    const canonicalInput = canonicalBuildInput(input.buildInput);
    const buildInput = BuildInputSchema.parse(JSON.parse(canonicalInput));
    if ((await calculateBuildKey(buildInput)) !== input.buildKey) {
      throw new TypeError("configuration build key does not match its persisted immutable input");
    }
    const resources = ResourceRequirementsSchema.parse(input.resources);
    const runtimeMetadata = RuntimeMetadataSchema.parse(input.runtimeMetadata);
    const selection = parseSelection(input.selection);
    const scope = `repository:${input.repositoryId}`;
    const expectedNextGeneration = input.expectedGeneration + 1;
    const encodedSelection = JSON.stringify(selection);
    const encodedResources = JSON.stringify(resources);
    const encodedMetadata = JSON.stringify(runtimeMetadata);
    const retryableOrCancelled = `
      status = 'reserved' OR status = 'cancelled' OR
      (status = 'failed' AND json_extract(failure_json, '$.retryable') = 1)`;
    const statements = [
      this.db
        .prepare(
          `INSERT INTO builds (
             build_id, build_key, build_input_json, status, attempt_count, lease_epoch,
             active_attempt_id, worker_id, lease_token, lease_expires_at, report_sequence,
             last_report_digest, progress_json, cancel_requested, candidate_ref, manifest_digest,
             artifact_digest, failure_json, created_at, updated_at
           ) VALUES (?, ?, ?, 'pending', 0, 0, NULL, NULL, NULL, NULL, 0, NULL, NULL, 0, NULL, NULL, NULL, NULL, ?, ?)
           ON CONFLICT(build_key) DO UPDATE SET
             status = CASE WHEN ${retryableOrCancelled} THEN 'pending' ELSE status END,
             active_attempt_id = CASE WHEN ${retryableOrCancelled} THEN NULL ELSE active_attempt_id END,
             worker_id = CASE WHEN ${retryableOrCancelled} THEN NULL ELSE worker_id END,
             lease_token = CASE WHEN ${retryableOrCancelled} THEN NULL ELSE lease_token END,
             lease_expires_at = CASE WHEN ${retryableOrCancelled} THEN NULL ELSE lease_expires_at END,
             report_sequence = CASE WHEN ${retryableOrCancelled} THEN 0 ELSE report_sequence END,
             last_report_digest = CASE WHEN ${retryableOrCancelled} THEN NULL ELSE last_report_digest END,
             progress_json = CASE WHEN ${retryableOrCancelled} THEN NULL ELSE progress_json END,
             cancel_requested = CASE WHEN ${retryableOrCancelled} THEN 0 ELSE cancel_requested END,
             candidate_ref = CASE WHEN ${retryableOrCancelled} THEN NULL ELSE candidate_ref END,
             manifest_digest = CASE WHEN ${retryableOrCancelled} THEN NULL ELSE manifest_digest END,
             artifact_digest = CASE WHEN ${retryableOrCancelled} THEN NULL ELSE artifact_digest END,
             failure_json = CASE WHEN ${retryableOrCancelled} THEN NULL ELSE failure_json END,
             updated_at = CASE WHEN ${retryableOrCancelled} THEN excluded.updated_at ELSE updated_at END
           WHERE builds.build_input_json = excluded.build_input_json`,
        )
        .bind(input.buildId, input.buildKey, canonicalInput, input.now, input.now),
      this.assertOneChange(),
      this.db
        .prepare(
          `INSERT INTO deployment_revisions (
             revision_id, instance_id, repository_id, generation, build_key, build_id,
             selection_json, resource_requirements_json, runtime_metadata_json, artifact_digest,
             status, actor_id, created_at
           ) SELECT ?, i.instance_id, i.repository_id, ?, b.build_key, b.build_id, ?, ?, ?,
                    CASE WHEN b.status = 'succeeded' AND a.status = 'admitted' THEN a.artifact_digest ELSE NULL END,
                    CASE
                      WHEN b.status = 'succeeded' AND a.status = 'admitted' THEN 'admitted'
                      WHEN b.status = 'failed' THEN 'failed'
                      WHEN b.status = 'succeeded' THEN 'failed'
                      ELSE 'building'
                    END,
                    ?, ?
             FROM logical_instances i JOIN builds b ON b.build_key = ?
             LEFT JOIN artifacts a ON a.build_key = b.build_key AND a.build_id = b.build_id AND a.status = 'admitted'
             WHERE i.instance_id = ? AND i.repository_id = ? AND i.generation = ?
               AND (b.status <> 'succeeded' OR a.status = 'admitted')`,
        )
        .bind(
          input.revisionId,
          expectedNextGeneration,
          encodedSelection,
          encodedResources,
          encodedMetadata,
          input.actorId,
          input.now,
          input.buildKey,
          input.instanceId,
          input.repositoryId,
          input.expectedGeneration,
        ),
      this.assertOneChange(),
      this.db
        .prepare(
          `UPDATE logical_instances
           SET generation = ?,
               runtime_epoch = CASE WHEN desired_state = 'running' THEN runtime_epoch + 1 ELSE runtime_epoch END,
               policy = ?, desired_revision_id = ?,
               desired_artifact_digest = (
                 SELECT artifact_digest FROM deployment_revisions WHERE revision_id = ?
               ), updated_at = ?
           WHERE instance_id = ? AND repository_id = ? AND generation = ?
             AND runtime_epoch = ? AND desired_state = ? AND policy = ?
             AND EXISTS (
               SELECT 1 FROM repository_bindings b
               WHERE b.repository_id = ? AND b.instance_id = logical_instances.instance_id
                 AND b.binding_epoch = ? AND b.authorization_revision = ? AND b.suspended = 0
             )
             AND NOT EXISTS (
               SELECT 1 FROM operations active
               WHERE active.instance_id = logical_instances.instance_id
                 AND active.status IN ('claimed', 'running')
             )
             AND EXISTS (
               SELECT 1 FROM deployment_revisions d
               WHERE d.revision_id = ? AND d.instance_id = logical_instances.instance_id
                 AND d.repository_id = logical_instances.repository_id AND d.generation = ?
             )`,
        )
        .bind(
          expectedNextGeneration,
          selection.policy,
          input.revisionId,
          input.revisionId,
          input.now,
          input.instanceId,
          input.repositoryId,
          input.expectedGeneration,
          input.expectedRuntimeEpoch,
          input.expectedDesiredState,
          input.expectedPolicy,
          input.repositoryId,
          input.bindingEpoch,
          input.authorizationRevision,
          input.revisionId,
          expectedNextGeneration,
        ),
      this.assertOneChange(),
      this.db
        .prepare(
          `UPDATE operations
           SET status = 'blocked', phase = 'superseded',
               result_json = ?, updated_at = ?
           WHERE instance_id = ? AND generation < ? AND status = 'pending'
             AND kind IN ('start', 'redeploy', 'update')`,
        )
        .bind(
          JSON.stringify({ code: "desired_configuration_superseded" }),
          input.now,
          input.instanceId,
          expectedNextGeneration,
        ),
      this.db
        .prepare(
          `UPDATE operations
           SET generation = ?, updated_at = ?
           WHERE instance_id = ? AND status = 'pending' AND kind = 'stop'
             AND runtime_epoch = ?
             AND EXISTS (SELECT 1 FROM logical_instances i WHERE i.instance_id = ? AND i.desired_state = 'stopped')`,
        )
        .bind(expectedNextGeneration, input.now, input.instanceId, input.expectedRuntimeEpoch, input.instanceId),
      this.db
        .prepare(
          `INSERT INTO operations (
             operation_id, instance_id, repository_id, generation, runtime_epoch, kind, status, phase,
             attempt, lease_epoch, worker_id, lease_token, lease_expires_at, report_sequence, last_report_digest,
             checkpoint_sequence, checkpoint_json, result_json, cluster_id, reservation_id,
             deployment_revision_id, build_id, prerequisite_build_id, idempotency_scope, idempotency_key,
             request_hash, actor_id, authorization_revision, request_id, created_at, updated_at
           ) SELECT ?, i.instance_id, i.repository_id, i.generation, i.runtime_epoch, 'update', 'pending',
                    'accepted', 0, 0, NULL, NULL, NULL, 0, NULL, 0, NULL, NULL, NULL, NULL,
                    d.revision_id, b.build_id, NULL, ?, ?, ?, ?, ?, ?, ?, ?
             FROM logical_instances i
             JOIN deployment_revisions d ON d.revision_id = ? AND d.status IN ('building', 'admitted')
             JOIN builds b ON b.build_id = d.build_id AND b.status IN ('pending', 'claimed', 'running', 'verifying', 'succeeded')
             WHERE i.instance_id = ? AND i.repository_id = ? AND i.generation = ?
               AND i.desired_state = 'running' AND i.runtime_epoch = ?`,
        )
        .bind(
          input.operationId,
          scope,
          input.idempotencyKey,
          input.requestHash,
          input.actorId,
          input.authorizationRevision,
          input.requestId,
          input.now,
          input.now,
          input.revisionId,
          input.instanceId,
          input.repositoryId,
          expectedNextGeneration,
          input.expectedRuntimeEpoch + 1,
        ),
      this.db
        .prepare(
          `INSERT INTO idempotency_records (scope, idempotency_key, request_hash, response_kind, response_id, created_at)
           SELECT ?, ?, ?, 'configuration-plan', ?, ?
           WHERE EXISTS (SELECT 1 FROM deployment_revisions WHERE revision_id = ?)`,
        )
        .bind(scope, input.idempotencyKey, input.requestHash, input.revisionId, input.now, input.revisionId),
      this.assertOneChange(),
      this.db
        .prepare(
          `INSERT INTO audit_events (
             event_id, repository_id, instance_id, operation_id, actor_id, actor_kind,
             action, outcome, request_id, metadata_json, occurred_at
           ) SELECT ?, ?, ?, CASE WHEN ? = 1 THEN ? ELSE NULL END, ?, 'user', 'configuration.planned', 'accepted', ?, ?, ?
             WHERE EXISTS (SELECT 1 FROM deployment_revisions WHERE revision_id = ?)`,
        )
        .bind(
          `configuration.planned:${input.revisionId}`,
          input.repositoryId,
          input.instanceId,
          input.expectedDesiredState === "running" ? 1 : 0,
          input.operationId,
          input.actorId,
          input.requestId,
          JSON.stringify({ generation: expectedNextGeneration, buildKey: input.buildKey, selection }),
          input.now,
          input.revisionId,
        ),
    ];

    try {
      const results = await this.db.batch(statements);
      if (results[11]?.meta.changes !== 1) throw new Error("configuration plan did not record idempotency");
    } catch (error) {
      if (isTransactionAssertion(error) || isConstraintError(error)) {
        const replay = await this.findIdempotency(input.repositoryId, input.idempotencyKey);
        if (replay) {
          if (replay.request_hash !== input.requestHash || replay.response_kind !== "configuration-plan") {
            throw new ConfigurationIdempotencyConflictError();
          }
          return this.receipt(replay.response_id);
        }
        if (isTransactionAssertion(error)) return null;
      }
      throw error;
    }
    return this.receipt(input.revisionId);
  }

  private async findContext(where: string, value: number | string): Promise<ConfigurationContext | null> {
    const row = await this.db
      .prepare(
        `SELECT ${INSTANCE_COLUMNS} FROM repository_bindings b
         JOIN logical_instances i ON i.instance_id = b.instance_id
         WHERE ${where} LIMIT 1`,
      )
      .bind(value)
      .first<JoinedRow>();
    return row ? toContext(row) : null;
  }

  private async findIdempotency(repositoryId: number, key: string): Promise<IdempotencyRow | null> {
    return this.db
      .prepare("SELECT request_hash, response_kind, response_id FROM idempotency_records WHERE scope = ? AND idempotency_key = ?")
      .bind(`repository:${repositoryId}`, key)
      .first<IdempotencyRow>();
  }

  private async receipt(revisionId: string): Promise<ConfigurationPlanReceipt> {
    const revision = await this.getRevision(revisionId);
    if (!revision) throw new Error("configuration idempotency record references a missing revision");
    const context = await this.getByInstance(revision.instanceId);
    if (!context) throw new Error("configuration revision has no repository binding");
    const operationRow = await this.db
      .prepare("SELECT * FROM operations WHERE deployment_revision_id = ? ORDER BY created_at DESC LIMIT 1")
      .bind(revisionId)
      .first<OperationRow>();
    return {
      instance: context.instance,
      revision,
      operation: operationRow ? toOperation(operationRow) : null,
      buildId: revision.buildId,
      buildKey: revision.buildKey,
      replayed: false,
    };
  }

  private assertOneChange(): D1PreparedStatement {
    return this.db.prepare("INSERT INTO platform_transaction_sentinel(id) SELECT 1 WHERE changes() <> 1");
  }
}

function toContext(row: JoinedRow): ConfigurationContext {
  const binding: ConfigurationBinding = {
    repositoryId: row.repository_id,
    instanceId: row.instance_id,
    bindingEpoch: row.binding_epoch,
    authorizationRevision: row.authorization_revision,
    suspended: row.suspended === 1,
  };
  const instance: ConfigurationInstance = {
    instanceId: row.instance_id,
    repositoryId: row.repository_id,
    generation: row.generation,
    runtimeEpoch: row.runtime_epoch,
    desiredState: row.desired_state,
    policy: row.policy,
    observedGeneration: row.observed_generation,
    observedRuntimeEpoch: row.observed_runtime_epoch,
    observedSequence: row.observed_sequence,
    observedState: row.observed_state,
    desiredRevisionId: row.desired_revision_id,
    observedRevisionId: row.observed_revision_id,
    desiredArtifactDigest: row.desired_artifact_digest,
    currentArtifactDigest: row.current_artifact_digest,
    reservationState: row.reservation_state,
    reservationId: row.reservation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  return { binding, instance };
}

function toRevision(row: RevisionRow): ConfigurationRevision {
  return {
    revisionId: row.revision_id,
    instanceId: row.instance_id,
    repositoryId: row.repository_id,
    generation: row.generation,
    buildKey: row.build_key,
    buildId: row.build_id,
    selection: parseSelection(parseJson(row.selection_json)),
    resources: ResourceRequirementsSchema.parse(parseJson(row.resource_requirements_json)),
    runtimeMetadata: RuntimeMetadataSchema.parse(parseJson(row.runtime_metadata_json)),
    artifactDigest: row.artifact_digest,
    status: row.status,
    actorId: row.actor_id,
    createdAt: row.created_at,
  };
}

function toOperation(row: OperationRow): ConfigurationOperation {
  return {
    id: row.operation_id,
    instanceId: row.instance_id,
    repositoryId: row.repository_id,
    generation: row.generation,
    runtimeEpoch: row.runtime_epoch,
    kind: row.kind,
    status: row.status,
    attempt: row.attempt,
    leaseEpoch: row.lease_epoch,
    reportSequence: row.report_sequence,
    leaseExpiresAt: row.lease_expires_at,
    clusterId: row.cluster_id,
    reservationId: row.reservation_id,
    deploymentRevisionId: row.deployment_revision_id,
    buildId: row.build_id,
    prerequisiteBuildId: row.prerequisite_build_id,
    idempotencyKey: row.idempotency_key,
    phase: row.phase,
    workerId: row.worker_id,
    leaseToken: row.lease_token,
    requestHash: row.request_hash,
    checkpointSequence: row.checkpoint_sequence,
    checkpoint: row.checkpoint_json ? parseRecord(row.checkpoint_json) : null,
    result: row.result_json ? parseRecord(row.result_json) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseSelection(value: unknown): ConfigurationSelection {
  const parsed = ConfigurationSelectionSchema.parse(value);
  return {
    ...parsed,
    requestedModules: [...parsed.requestedModules].sort(),
  };
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function parseRecord(value: string): Readonly<Record<string, unknown>> {
  const parsed = parseJson(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new TypeError("stored object JSON is invalid");
  return parsed as Readonly<Record<string, unknown>>;
}

function isTransactionAssertion(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("platform_transaction_sentinel");
}

function isConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unique constraint|constraint failed|UNIQUE constraint/iu.test(message);
}
