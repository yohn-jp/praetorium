import {
  BuildInputSchema,
  BuildProgressSchema,
  DigestSchema,
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
  ConfigurationStage,
  ConfigurationStageActivationMutation,
  ConfigurationStageActivationReceipt,
  ConfigurationStageBuild,
  ConfigurationStageMutation,
  ConfigurationStageReceipt,
  ConfigurationStore,
} from "@praetorium/application/configurations";
import { ConfigurationIdempotencyConflictError } from "@praetorium/application/configurations";
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
  build_input_json: string;
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

interface StageRow {
  stage_id: string;
  repository_id: number;
  instance_id: string;
  binding_epoch: number;
  authorization_revision: number;
  expected_generation: number;
  expected_runtime_epoch: number;
  expected_policy: ConfigurationStage["expectedPolicy"];
  expected_desired_state: ConfigurationStage["expectedDesiredState"];
  selection_json: string;
  build_input_json: string;
  build_key: string;
  build_id: string;
  resource_requirements_json: string;
  runtime_metadata_json: string;
  actor_id: string;
  idempotency_key: string;
  request_hash: string;
  request_id: string | null;
  created_at: number;
  status: ConfigurationStage["status"];
  activation_generation: number | null;
  deployment_revision_id: string | null;
  operation_id: string | null;
  updated_at: number;
  build_status: ConfigurationStageBuild["status"];
  artifact_digest: string | null;
  progress_json: string | null;
  failure_json: string | null;
  build_updated_at: number;
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
        `SELECT d.*, b.build_input_json FROM logical_instances i
         JOIN deployment_revisions d ON d.revision_id = i.desired_revision_id
         JOIN builds b ON b.build_id = d.build_id AND b.build_key = d.build_key
         WHERE i.instance_id = ? LIMIT 1`,
      )
      .bind(instanceId)
      .first<RevisionRow>();
    return row ? toRevision(row) : null;
  }

  async getRevision(revisionId: string): Promise<ConfigurationRevision | null> {
    const row = await this.db
      .prepare(
        `SELECT d.*, b.build_input_json FROM deployment_revisions d
         JOIN builds b ON b.build_id = d.build_id AND b.build_key = d.build_key
         WHERE d.revision_id = ?`,
      )
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
    if (row.response_kind !== "configuration-plan")
      throw new ConfigurationIdempotencyConflictError();
    return this.receipt(row.response_id);
  }

  async stageConfiguration(
    input: ConfigurationStageMutation,
  ): Promise<ConfigurationStageReceipt | null> {
    const canonicalInput = canonicalBuildInput(input.buildInput);
    const buildInput = BuildInputSchema.parse(JSON.parse(canonicalInput));
    if ((await calculateBuildKey(buildInput)) !== input.buildKey) {
      throw new TypeError("configuration build key does not match its persisted immutable input");
    }
    const selection = parseSelection(input.selection);
    const resources = ResourceRequirementsSchema.parse(input.resources);
    const runtimeMetadata = RuntimeMetadataSchema.parse(input.runtimeMetadata);
    const scope = `repository:${input.repositoryId}`;
    const encodedInput = canonicalInput;
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
        .bind(input.buildId, input.buildKey, encodedInput, input.now, input.now),
      this.assertOneChange(),
      this.db
        .prepare(
          `INSERT INTO staged_configurations (
             stage_id, repository_id, instance_id, binding_epoch, authorization_revision,
             expected_generation, expected_runtime_epoch, expected_policy, expected_desired_state,
             selection_json, build_input_json, build_key, build_id, resource_requirements_json,
             runtime_metadata_json, actor_id, idempotency_scope, idempotency_key, request_hash,
             request_id, created_at, status, activation_generation, deployment_revision_id,
             operation_id, updated_at
           ) SELECT ?, i.repository_id, i.instance_id, ?, ?, ?, ?, ?, ?, ?, ?, b.build_key, b.build_id,
                    ?, ?, ?, ?, ?, ?, ?, ?, 'staged', NULL, NULL, NULL, ?
             FROM logical_instances i
             JOIN repository_bindings binding ON binding.repository_id = i.repository_id
               AND binding.instance_id = i.instance_id
             JOIN builds b ON b.build_key = ?
             WHERE i.instance_id = ? AND i.repository_id = ? AND i.generation = ?
               AND i.runtime_epoch = ? AND i.policy = ? AND i.desired_state = ?
               AND binding.binding_epoch = ? AND binding.authorization_revision = ? AND binding.suspended = 0
               AND b.build_input_json = ?`,
        )
        .bind(
          input.stageId,
          input.bindingEpoch,
          input.authorizationRevision,
          input.expectedGeneration,
          input.expectedRuntimeEpoch,
          input.expectedPolicy,
          input.expectedDesiredState,
          encodedSelection,
          encodedInput,
          encodedResources,
          encodedMetadata,
          input.actorId,
          scope,
          input.idempotencyKey,
          input.requestHash,
          input.requestId,
          input.now,
          input.now,
          input.buildKey,
          input.instanceId,
          input.repositoryId,
          input.expectedGeneration,
          input.expectedRuntimeEpoch,
          input.expectedPolicy,
          input.expectedDesiredState,
          input.bindingEpoch,
          input.authorizationRevision,
          encodedInput,
        ),
      this.assertOneChange(),
      this.db
        .prepare(
          `INSERT INTO idempotency_records (
             scope, idempotency_key, request_hash, response_kind, response_id, created_at
           ) SELECT ?, ?, ?, 'configuration-stage', stage_id, ?
             FROM staged_configurations WHERE stage_id = ?`,
        )
        .bind(scope, input.idempotencyKey, input.requestHash, input.now, input.stageId),
      this.assertOneChange(),
      this.db
        .prepare(
          `INSERT INTO audit_events (
             event_id, repository_id, instance_id, operation_id, actor_id, actor_kind,
             action, outcome, request_id, metadata_json, occurred_at
           ) SELECT ?, repository_id, instance_id, NULL, actor_id, 'system',
                    'configuration.staged', 'accepted', request_id, ?, ?
             FROM staged_configurations WHERE stage_id = ?`,
        )
        .bind(
          `configuration.staged:${input.stageId}`,
          JSON.stringify({
            generation: input.expectedGeneration,
            buildKey: input.buildKey,
            selection,
          }),
          input.now,
          input.stageId,
        ),
      this.assertOneChange(),
    ];

    try {
      await this.db.batch(statements);
    } catch (error) {
      if (isTransactionAssertion(error)) return null;
      if (isConstraintError(error)) {
        const replay = await this.findIdempotency(input.repositoryId, input.idempotencyKey);
        if (replay) {
          if (
            replay.request_hash !== input.requestHash ||
            replay.response_kind !== "configuration-stage"
          ) {
            throw new ConfigurationIdempotencyConflictError();
          }
          return this.stageReceipt(replay.response_id);
        }
      }
      throw error;
    }
    return this.stageReceipt(input.stageId);
  }

  async findStageByIdempotency(input: {
    readonly repositoryId: number;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  }): Promise<ConfigurationStageReceipt | null> {
    const row = await this.findIdempotency(input.repositoryId, input.idempotencyKey);
    if (!row) return null;
    if (row.request_hash !== input.requestHash || row.response_kind !== "configuration-stage") {
      throw new ConfigurationIdempotencyConflictError();
    }
    return this.stageReceipt(row.response_id);
  }

  async getStageByIdempotency(input: {
    readonly repositoryId: number;
    readonly idempotencyKey: string;
  }): Promise<ConfigurationStageReceipt | null> {
    const row = await this.findIdempotency(input.repositoryId, input.idempotencyKey);
    if (!row) return null;
    if (row.response_kind !== "configuration-stage")
      throw new ConfigurationIdempotencyConflictError();
    return this.stageReceipt(row.response_id);
  }

  async getLatestStage(instanceId: string): Promise<ConfigurationStageReceipt | null> {
    const row = await this.db
      .prepare(
        `SELECT stage_id FROM staged_configurations
         WHERE instance_id = ? ORDER BY created_at DESC, stage_id DESC LIMIT 1`,
      )
      .bind(instanceId)
      .first<{ stage_id: string }>();
    return row ? this.stageReceipt(row.stage_id) : null;
  }

  async activateStageUnderClusterFence(
    input: ConfigurationStageActivationMutation,
  ): Promise<ConfigurationStageActivationReceipt | null> {
    DigestSchema.parse(input.expectedBuildKey);
    DigestSchema.parse(input.expectedArtifactDigest);
    const stageIdentity = await this.db
      .prepare("SELECT repository_id FROM staged_configurations WHERE stage_id = ?")
      .bind(input.stageId)
      .first<{ repository_id: number }>();
    if (!stageIdentity) return null;

    const operationHash = await stageActivationRequestHash(input);
    const scope = `repository:${stageIdentity.repository_id}`;
    const prior = await this.findIdempotencyByScope(scope, input.operationIdempotencyKey);
    if (prior) {
      if (
        prior.request_hash !== operationHash ||
        prior.response_kind !== "configuration-stage-activation" ||
        prior.response_id !== input.stageId
      ) {
        throw new ConfigurationIdempotencyConflictError();
      }
      const replay = await this.activatedStageReceipt(input, true, operationHash);
      if (!replay) throw new Error("configuration activation idempotency record is inconsistent");
      return replay;
    }
    const activationCte = `
      WITH activation AS (
        SELECT ? AS stage_id, ? AS cluster_id, ? AS rollout_id, ? AS release_id,
               ? AS owner, ? AS lease_epoch, ? AS rollout_revision, ? AS build_key,
               ? AS build_id, ? AS artifact_digest, ? AS actor_id, ? AS actor_kind,
               ? AS operation_id, ? AS operation_key, ? AS request_id, ? AS now,
               ? AS request_hash, ? AS idempotency_scope
      )`;
    const activationValues = [
      input.stageId,
      input.clusterId,
      input.rolloutId,
      input.releaseId,
      input.owner,
      input.leaseEpoch,
      input.expectedRolloutRevision,
      input.expectedBuildKey,
      input.expectedBuildId,
      input.expectedArtifactDigest,
      input.actorId,
      input.actorKind,
      input.operationId,
      input.operationIdempotencyKey,
      input.requestId,
      input.now,
      operationHash,
      scope,
    ] as const;
    const statements = [
      this.db
        .prepare(
          `${activationCte}
           INSERT INTO deployment_revisions (
             revision_id, instance_id, repository_id, generation, build_key, build_id,
             selection_json, resource_requirements_json, runtime_metadata_json, artifact_digest,
             status, actor_id, created_at
           ) SELECT s.stage_id, i.instance_id, i.repository_id, i.generation + 1,
                    s.build_key, s.build_id, s.selection_json, s.resource_requirements_json,
                    s.runtime_metadata_json, a.artifact_digest, 'admitted', x.actor_id, x.now
             FROM activation x
             JOIN staged_configurations s ON s.stage_id = x.stage_id AND s.status = 'staged'
             JOIN logical_instances i ON i.instance_id = s.instance_id AND i.repository_id = s.repository_id
             JOIN repository_bindings b ON b.instance_id = i.instance_id AND b.repository_id = i.repository_id
             JOIN builds build ON build.build_id = s.build_id AND build.build_key = s.build_key
               AND build.status = 'succeeded'
             JOIN artifacts a ON a.build_id = build.build_id AND a.build_key = build.build_key
               AND a.status = 'admitted' AND a.artifact_digest = x.artifact_digest
             JOIN stable_rollouts rollout ON rollout.rollout_id = x.rollout_id
             JOIN cluster_rollout_leases lease ON lease.cluster_id = x.cluster_id
               AND lease.rollout_id = rollout.rollout_id
             JOIN stable_release_channels channel ON channel.channel_key = 'stable'
               AND channel.current_release_id = x.release_id
             WHERE s.stage_id = x.stage_id AND s.build_key = x.build_key AND s.build_id = x.build_id
               AND s.selection_json IS NOT NULL
               AND json_extract(s.selection_json, '$.releaseId') = x.release_id
               AND json_extract(s.selection_json, '$.policy') = 'stable'
               AND s.expected_policy = 'stable' AND i.policy = s.expected_policy
               AND i.generation = s.expected_generation AND i.runtime_epoch = s.expected_runtime_epoch
               AND i.desired_state = 'running' AND s.expected_desired_state = i.desired_state
               AND i.generation = json_extract(rollout.snapshot_json, '$.generation')
               AND i.runtime_epoch = json_extract(rollout.snapshot_json, '$.runtimeEpoch')
               AND i.desired_state = json_extract(rollout.snapshot_json, '$.desiredState')
               AND i.policy = json_extract(rollout.snapshot_json, '$.policy')
               AND i.desired_revision_id IS json_extract(rollout.snapshot_json, '$.configurationRevision')
               AND i.repository_id = json_extract(rollout.snapshot_json, '$.repositoryId')
               AND x.cluster_id = json_extract(rollout.snapshot_json, '$.clusterId')
               AND s.binding_epoch = json_extract(rollout.snapshot_json, '$.bindingEpoch')
               AND s.authorization_revision = json_extract(rollout.snapshot_json, '$.authorizationRevision')
               AND json_extract(s.selection_json, '$.requestedModules') = json_extract(rollout.snapshot_json, '$.selectedModuleIds')
               AND json_extract(s.selection_json, '$.resourceProfileId') = json_extract(rollout.snapshot_json, '$.resourceProfileId')
               AND json_extract(s.build_input_json, '$.platform') = json_extract(rollout.snapshot_json, '$.platform')
               AND COALESCE(
                 (SELECT current_reservation.cluster_id FROM runtime_reservations current_reservation
                   WHERE current_reservation.reservation_id = i.reservation_id),
                 (SELECT latest_reservation.cluster_id FROM runtime_reservations latest_reservation
                   WHERE latest_reservation.instance_id = i.instance_id
                   ORDER BY latest_reservation.runtime_epoch DESC LIMIT 1),
                 x.cluster_id
               ) = x.cluster_id
               AND s.expected_generation = i.generation AND s.expected_runtime_epoch = i.runtime_epoch
               AND b.binding_epoch = s.binding_epoch AND b.authorization_revision = s.authorization_revision
               AND b.suspended = 0
               AND rollout.release_id = x.release_id AND rollout.instance_id = i.instance_id
               AND rollout.cluster_id = x.cluster_id AND rollout.state = 'dispatch_pending'
               AND rollout.revision = x.rollout_revision AND rollout.build_key = x.build_key
               AND rollout.build_id = x.build_id AND rollout.artifact_digest = x.artifact_digest
               AND lease.owner = x.owner AND lease.lease_epoch = x.lease_epoch
               AND lease.lease_expires_at > x.now AND lease.active_operation_id IS NULL
               AND NOT EXISTS (
                 SELECT 1 FROM operations active
                 WHERE active.instance_id = i.instance_id
                   AND active.status IN ('claimed', 'running', 'pending')
                   AND active.kind IN ('start', 'redeploy', 'update')
               )`,
        )
        .bind(...activationValues),
      this.assertOneChange(),
      this.db
        .prepare(
          `${activationCte}
           UPDATE logical_instances
           SET generation = generation + 1, runtime_epoch = runtime_epoch + 1,
               policy = 'stable',
               desired_revision_id = (SELECT stage_id FROM activation),
               desired_artifact_digest = (SELECT artifact_digest FROM activation),
               updated_at = (SELECT now FROM activation)
           WHERE desired_state = 'running' AND policy = 'stable'
             AND EXISTS (
               SELECT 1 FROM activation x JOIN staged_configurations s ON s.stage_id = x.stage_id
               JOIN repository_bindings b ON b.instance_id = logical_instances.instance_id
                 AND b.repository_id = logical_instances.repository_id
               JOIN stable_rollouts rollout ON rollout.rollout_id = x.rollout_id
               JOIN cluster_rollout_leases lease ON lease.cluster_id = x.cluster_id
                 AND lease.rollout_id = rollout.rollout_id
               JOIN stable_release_channels channel ON channel.channel_key = 'stable'
                 AND channel.current_release_id = x.release_id
               JOIN artifacts a ON a.build_key = x.build_key AND a.build_id = x.build_id
                 AND a.artifact_digest = x.artifact_digest AND a.status = 'admitted'
               WHERE s.stage_id = x.stage_id AND s.status = 'staged'
                 AND s.instance_id = logical_instances.instance_id
                 AND s.repository_id = logical_instances.repository_id
                 AND s.build_key = x.build_key AND s.build_id = x.build_id
                 AND s.expected_generation = logical_instances.generation
                 AND s.expected_runtime_epoch = logical_instances.runtime_epoch
                 AND s.expected_policy = logical_instances.policy
                 AND s.expected_desired_state = logical_instances.desired_state
                 AND json_extract(s.selection_json, '$.releaseId') = x.release_id
                 AND json_extract(s.selection_json, '$.policy') = 'stable'
                 AND b.binding_epoch = s.binding_epoch
                 AND b.authorization_revision = s.authorization_revision AND b.suspended = 0
                 AND rollout.instance_id = logical_instances.instance_id
                 AND rollout.release_id = x.release_id AND rollout.cluster_id = x.cluster_id
                 AND x.cluster_id = json_extract(rollout.snapshot_json, '$.clusterId')
                 AND rollout.state = 'dispatch_pending' AND rollout.revision = x.rollout_revision
                 AND rollout.build_key = x.build_key AND rollout.build_id = x.build_id
                 AND rollout.artifact_digest = x.artifact_digest
                 AND lease.owner = x.owner AND lease.lease_epoch = x.lease_epoch
                 AND lease.lease_expires_at > x.now AND lease.active_operation_id IS NULL
                 AND logical_instances.generation = s.expected_generation
                 AND logical_instances.runtime_epoch = s.expected_runtime_epoch
                 AND logical_instances.desired_state = s.expected_desired_state
                 AND logical_instances.policy = s.expected_policy
             )
             AND EXISTS (SELECT 1 FROM deployment_revisions d
               JOIN activation x ON x.stage_id = d.revision_id
               WHERE d.instance_id = logical_instances.instance_id
                 AND d.repository_id = logical_instances.repository_id
                 AND d.generation = logical_instances.generation + 1)`,
        )
        .bind(...activationValues),
      this.assertOneChange(),
      this.db
        .prepare(
          `${activationCte}
           INSERT INTO operations (
             operation_id, instance_id, repository_id, generation, runtime_epoch, kind, status, phase,
             attempt, lease_epoch, worker_id, lease_token, lease_expires_at, report_sequence, last_report_digest,
             checkpoint_sequence, checkpoint_json, result_json, cluster_id, reservation_id,
             deployment_revision_id, build_id, prerequisite_build_id, idempotency_scope, idempotency_key,
             request_hash, actor_id, authorization_revision, request_id, created_at, updated_at
           ) SELECT x.operation_id, i.instance_id, i.repository_id, i.generation, i.runtime_epoch,
                    'update', 'pending', 'accepted', 0, 0, NULL, NULL, NULL, 0, NULL, 0, NULL, NULL,
                    x.cluster_id, NULL, s.stage_id, s.build_id, NULL, x.idempotency_scope,
                    x.operation_key, x.request_hash, x.actor_id, s.authorization_revision,
                    x.request_id, x.now, x.now
             FROM activation x JOIN staged_configurations s ON s.stage_id = x.stage_id
             JOIN logical_instances i ON i.instance_id = s.instance_id AND i.repository_id = s.repository_id
             JOIN deployment_revisions d ON d.revision_id = s.stage_id AND d.status = 'admitted'
             JOIN builds b ON b.build_id = s.build_id AND b.build_key = s.build_key AND b.status = 'succeeded'
             JOIN artifacts a ON a.build_id = b.build_id AND a.build_key = b.build_key
               AND a.artifact_digest = x.artifact_digest AND a.status = 'admitted'
             JOIN stable_rollouts rollout ON rollout.rollout_id = x.rollout_id
               AND rollout.state = 'dispatch_pending' AND rollout.revision = x.rollout_revision
             JOIN cluster_rollout_leases lease ON lease.cluster_id = x.cluster_id
               AND lease.rollout_id = rollout.rollout_id AND lease.owner = x.owner
               AND lease.lease_epoch = x.lease_epoch AND lease.lease_expires_at > x.now
               AND lease.active_operation_id IS NULL
             WHERE i.generation = s.expected_generation + 1
               AND i.runtime_epoch = s.expected_runtime_epoch + 1
               AND i.desired_revision_id = s.stage_id AND s.status = 'staged'
               AND s.build_key = x.build_key AND s.build_id = x.build_id
               AND rollout.release_id = x.release_id AND rollout.cluster_id = x.cluster_id
               AND rollout.build_key = x.build_key AND rollout.build_id = x.build_id
               AND rollout.artifact_digest = x.artifact_digest`,
        )
        .bind(...activationValues),
      this.assertOneChange(),
      this.db
        .prepare(
          `${activationCte}
           UPDATE staged_configurations
           SET status = 'activated', activation_generation = expected_generation + 1,
               deployment_revision_id = stage_id, operation_id = ?, updated_at = ?
           WHERE stage_id = ? AND status = 'staged' AND build_key = ? AND build_id = ?
             AND expected_policy = 'stable' AND expected_desired_state = 'running'
             AND EXISTS (SELECT 1 FROM operations o WHERE o.operation_id = ?
               AND o.deployment_revision_id = staged_configurations.stage_id
               AND o.idempotency_scope = ? AND o.idempotency_key = ?)
             AND EXISTS (SELECT 1 FROM artifacts a WHERE a.build_key = ? AND a.build_id = ?
               AND a.artifact_digest = ? AND a.status = 'admitted')`,
        )
        .bind(
          ...activationValues,
          input.operationId,
          input.now,
          input.stageId,
          input.expectedBuildKey,
          input.expectedBuildId,
          input.operationId,
          scope,
          input.operationIdempotencyKey,
          input.expectedBuildKey,
          input.expectedBuildId,
          input.expectedArtifactDigest,
        ),
      this.assertOneChange(),
      this.db
        .prepare(
          `${activationCte}
           UPDATE stable_rollouts
           SET state = 'operation_pending', revision = revision + 1,
               deployment_revision_id = ?, operation_id = ?, updated_at = ?
           WHERE rollout_id = ? AND release_id = ? AND cluster_id = ?
             AND state = 'dispatch_pending' AND revision = ?
             AND build_key = ? AND build_id = ? AND artifact_digest = ?
             AND EXISTS (SELECT 1 FROM staged_configurations s WHERE s.stage_id = ?
               AND s.status = 'activated' AND s.operation_id = ?
               AND s.activation_generation = s.expected_generation + 1)
             AND EXISTS (SELECT 1 FROM operations o WHERE o.operation_id = ?
               AND o.deployment_revision_id = ? AND o.instance_id = stable_rollouts.instance_id)`,
        )
        .bind(
          ...activationValues,
          input.stageId,
          input.operationId,
          input.now,
          input.rolloutId,
          input.releaseId,
          input.clusterId,
          input.expectedRolloutRevision,
          input.expectedBuildKey,
          input.expectedBuildId,
          input.expectedArtifactDigest,
          input.stageId,
          input.operationId,
          input.operationId,
          input.stageId,
        ),
      this.assertOneChange(),
      this.db
        .prepare(
          `${activationCte}
           UPDATE cluster_rollout_leases
           SET active_operation_id = ?, updated_at = ?
           WHERE cluster_id = ? AND rollout_id = ? AND owner = ? AND lease_epoch = ?
             AND lease_expires_at > ? AND active_operation_id IS NULL
             AND EXISTS (SELECT 1 FROM stable_rollouts r WHERE r.rollout_id = ?
               AND r.state = 'operation_pending' AND r.operation_id = ?
               AND r.revision = ? + 1 AND r.deployment_revision_id = ?)
             AND EXISTS (SELECT 1 FROM operations o WHERE o.operation_id = ?
               AND o.cluster_id = cluster_rollout_leases.cluster_id AND o.deployment_revision_id = ?)`,
        )
        .bind(
          ...activationValues,
          input.operationId,
          input.now,
          input.clusterId,
          input.rolloutId,
          input.owner,
          input.leaseEpoch,
          input.now,
          input.rolloutId,
          input.operationId,
          input.expectedRolloutRevision,
          input.stageId,
          input.operationId,
          input.stageId,
        ),
      this.assertOneChange(),
      this.db
        .prepare(
          `${activationCte}
           INSERT INTO idempotency_records (
             scope, idempotency_key, request_hash, response_kind, response_id, created_at
           ) SELECT x.idempotency_scope, x.operation_key, x.request_hash,
                    'configuration-stage-activation', x.stage_id, x.now
             FROM activation x JOIN staged_configurations s ON s.stage_id = x.stage_id
               AND s.status = 'activated' AND s.operation_id = x.operation_id`,
        )
        .bind(...activationValues),
      this.assertOneChange(),
      this.db
        .prepare(
          `${activationCte}
           INSERT INTO audit_events (
             event_id, repository_id, instance_id, operation_id, actor_id, actor_kind,
             action, outcome, request_id, metadata_json, occurred_at
           ) SELECT 'configuration.activated:' || s.stage_id, s.repository_id, s.instance_id,
                    x.operation_id, x.actor_id, x.actor_kind, 'configuration.activated',
                    'accepted', x.request_id,
                    json_object('stageId', s.stage_id, 'generation', s.activation_generation,
                      'buildKey', s.build_key, 'artifactDigest', x.artifact_digest,
                      'rolloutId', x.rollout_id), x.now
             FROM activation x JOIN staged_configurations s ON s.stage_id = x.stage_id
               AND s.status = 'activated' AND s.operation_id = x.operation_id`,
        )
        .bind(...activationValues),
      this.assertOneChange(),
    ];

    try {
      await this.db.batch(statements);
    } catch (error) {
      if (isTransactionAssertion(error)) return null;
      if (isConstraintError(error)) {
        const idempotency = await this.findIdempotencyByScope(scope, input.operationIdempotencyKey);
        if (idempotency) {
          if (
            idempotency.request_hash !== operationHash ||
            idempotency.response_kind !== "configuration-stage-activation" ||
            idempotency.response_id !== input.stageId
          ) {
            throw new ConfigurationIdempotencyConflictError();
          }
          return this.activatedStageReceipt(input, true, operationHash);
        }
      }
      throw error;
    }
    return this.activatedStageReceipt(input, false, operationHash);
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
        .bind(
          expectedNextGeneration,
          input.now,
          input.instanceId,
          input.expectedRuntimeEpoch,
          input.instanceId,
        ),
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
        .bind(
          scope,
          input.idempotencyKey,
          input.requestHash,
          input.revisionId,
          input.now,
          input.revisionId,
        ),
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
          JSON.stringify({
            generation: expectedNextGeneration,
            buildKey: input.buildKey,
            selection,
          }),
          input.now,
          input.revisionId,
        ),
    ];

    try {
      const results = await this.db.batch(statements);
      if (results[11]?.meta.changes !== 1)
        throw new Error("configuration plan did not record idempotency");
    } catch (error) {
      if (isTransactionAssertion(error) || isConstraintError(error)) {
        const replay = await this.findIdempotency(input.repositoryId, input.idempotencyKey);
        if (replay) {
          if (
            replay.request_hash !== input.requestHash ||
            replay.response_kind !== "configuration-plan"
          ) {
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

  private async findContext(
    where: string,
    value: number | string,
  ): Promise<ConfigurationContext | null> {
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
    return this.findIdempotencyByScope(`repository:${repositoryId}`, key);
  }

  private async findIdempotencyByScope(scope: string, key: string): Promise<IdempotencyRow | null> {
    return this.db
      .prepare(
        "SELECT request_hash, response_kind, response_id FROM idempotency_records WHERE scope = ? AND idempotency_key = ?",
      )
      .bind(scope, key)
      .first<IdempotencyRow>();
  }

  private async stageReceipt(stageId: string): Promise<ConfigurationStageReceipt> {
    const row = await this.db
      .prepare(
        `SELECT s.*, b.status AS build_status,
                a.artifact_digest AS artifact_digest, b.progress_json, b.failure_json,
                b.updated_at AS build_updated_at
           FROM staged_configurations s
           JOIN builds b ON b.build_id = s.build_id AND b.build_key = s.build_key
           LEFT JOIN artifacts a ON a.build_id = b.build_id AND a.build_key = b.build_key
             AND a.status = 'admitted'
          WHERE s.stage_id = ? LIMIT 1`,
      )
      .bind(stageId)
      .first<StageRow>();
    if (!row) throw new Error("configuration idempotency record references a missing stage");
    const stage: ConfigurationStage = {
      stageId: row.stage_id,
      repositoryId: row.repository_id,
      instanceId: row.instance_id,
      bindingEpoch: row.binding_epoch,
      authorizationRevision: row.authorization_revision,
      expectedGeneration: row.expected_generation,
      expectedRuntimeEpoch: row.expected_runtime_epoch,
      expectedPolicy: row.expected_policy,
      expectedDesiredState: row.expected_desired_state,
      selection: parseSelection(parseJson(row.selection_json)),
      buildInput: BuildInputSchema.parse(parseJson(row.build_input_json)),
      buildKey: row.build_key,
      buildId: row.build_id,
      resources: ResourceRequirementsSchema.parse(parseJson(row.resource_requirements_json)),
      runtimeMetadata: RuntimeMetadataSchema.parse(parseJson(row.runtime_metadata_json)),
      actorId: row.actor_id,
      idempotencyKey: row.idempotency_key,
      requestHash: row.request_hash,
      requestId: row.request_id,
      createdAt: row.created_at,
      status: row.status,
      activationGeneration: row.activation_generation,
      deploymentRevisionId: row.deployment_revision_id,
      operationId: row.operation_id,
      updatedAt: row.updated_at,
    };
    const failure = row.failure_json ? parseRecord(row.failure_json) : null;
    const failureCode = failure?.code;
    const build: ConfigurationStageBuild = {
      buildId: row.build_id,
      buildKey: row.build_key,
      status: row.build_status,
      artifactDigest: row.artifact_digest,
      progress: row.progress_json ? BuildProgressSchema.parse(parseJson(row.progress_json)) : null,
      errorCode:
        typeof failureCode === "string" && /^[A-Z0-9_]{1,128}$/u.test(failureCode)
          ? failureCode
          : row.build_status === "failed"
            ? "BUILD_FAILED"
            : null,
      updatedAt: row.build_updated_at,
    };
    return { stage, build, replayed: false };
  }

  private async activatedStageReceipt(
    input: ConfigurationStageActivationMutation,
    replayed = true,
    expectedRequestHash?: string,
  ): Promise<ConfigurationStageActivationReceipt | null> {
    const requestHash = expectedRequestHash ?? (await stageActivationRequestHash(input));
    const row = await this.db
      .prepare(
        `SELECT s.stage_id FROM staged_configurations s
         JOIN operations o ON o.operation_id = s.operation_id
         JOIN stable_rollouts r ON r.rollout_id = ? AND r.operation_id = o.operation_id
           AND r.deployment_revision_id = s.stage_id
         JOIN artifacts a ON a.build_id = s.build_id AND a.build_key = s.build_key
           AND a.artifact_digest = ? AND a.status = 'admitted'
         JOIN idempotency_records idem ON idem.scope = o.idempotency_scope
           AND idem.idempotency_key = o.idempotency_key
         WHERE s.stage_id = ? AND s.status = 'activated'
           AND s.build_key = ? AND s.build_id = ? AND s.activation_generation IS NOT NULL
           AND r.release_id = ? AND r.cluster_id = ? AND r.build_key = s.build_key
           AND r.build_id = s.build_id AND r.artifact_digest = a.artifact_digest
           AND o.idempotency_scope = ('repository:' || s.repository_id)
           AND o.idempotency_key = ?
           AND idem.request_hash = ? AND idem.response_kind = 'configuration-stage-activation'
           AND idem.response_id = s.stage_id
         LIMIT 1`,
      )
      .bind(
        input.rolloutId,
        input.expectedArtifactDigest,
        input.stageId,
        input.expectedBuildKey,
        input.expectedBuildId,
        input.releaseId,
        input.clusterId,
        input.operationIdempotencyKey,
        requestHash,
      )
      .first<{ stage_id: string }>();
    if (!row) return null;
    const receipt = await this.stageReceipt(row.stage_id);
    if (!receipt.stage.operationId)
      throw new Error("activated configuration stage has no operation");
    const [instanceContext, revision] = await Promise.all([
      this.getByInstance(receipt.stage.instanceId),
      this.getRevision(receipt.stage.deploymentRevisionId!),
    ]);
    if (!instanceContext || !revision)
      throw new Error("activated configuration references missing state");
    const operationRow = await this.db
      .prepare("SELECT * FROM operations WHERE operation_id = ? LIMIT 1")
      .bind(receipt.stage.operationId)
      .first<OperationRow>();
    if (!operationRow) throw new Error("activated configuration references a missing operation");
    return {
      stage: receipt.stage,
      instance: instanceContext.instance,
      revision,
      operation: toOperation(operationRow),
      operationId: operationRow.operation_id,
      generation: operationRow.generation,
      replayed,
    };
  }

  private async receipt(revisionId: string): Promise<ConfigurationPlanReceipt> {
    const revision = await this.getRevision(revisionId);
    if (!revision)
      throw new Error("configuration idempotency record references a missing revision");
    const context = await this.getByInstance(revision.instanceId);
    if (!context) throw new Error("configuration revision has no repository binding");
    const operationRow = await this.db
      .prepare(
        "SELECT * FROM operations WHERE deployment_revision_id = ? ORDER BY created_at DESC LIMIT 1",
      )
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
    return this.db.prepare(
      "INSERT INTO platform_transaction_sentinel(id) SELECT 1 WHERE changes() <> 1",
    );
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
    resolvedModules: BuildInputSchema.parse(parseJson(row.build_input_json)).resolvedModules,
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
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new TypeError("stored object JSON is invalid");
  return parsed as Readonly<Record<string, unknown>>;
}

async function digestJson(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function stageActivationRequestHash(input: ConfigurationStageActivationMutation): Promise<string> {
  return digestJson({
    stageId: input.stageId,
    clusterId: input.clusterId,
    rolloutId: input.rolloutId,
    releaseId: input.releaseId,
    owner: input.owner,
    leaseEpoch: input.leaseEpoch,
    expectedRolloutRevision: input.expectedRolloutRevision,
    buildKey: input.expectedBuildKey,
    buildId: input.expectedBuildId,
    artifactDigest: input.expectedArtifactDigest,
    actorId: input.actorId,
    actorKind: input.actorKind,
  });
}

function isTransactionAssertion(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("platform_transaction_sentinel");
}

function isConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unique constraint|constraint failed|UNIQUE constraint/iu.test(message);
}
