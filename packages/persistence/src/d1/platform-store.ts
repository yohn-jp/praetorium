import {
  RuntimeMetadataSchema,
  type LogicalInstance,
  type Operation,
  type RepositoryBinding,
  type ResourceRequirements,
} from "@praetorium/contracts";
import type {
  DesiredStateMutationResult,
  InstanceSnapshot,
  OperationRecord,
  RepositoryRegistryInput,
  RepositorySnapshot,
  RevalidateBindingInput,
  SuspendBindingInput,
} from "@praetorium/application/instances";
import type {
  BlockClaimInput,
  ClaimedOperation,
  OperationCheckpointInput,
  OperationObservation,
  OperationStore,
  OperationTerminal,
  CapacityResourceSnapshot,
  ReserveRuntimeInput,
  ReservationSnapshot,
  RuntimeReservation,
} from "@praetorium/application/operations";
import type { D1Database, D1PreparedStatement } from "./types.js";

interface BindingRow {
  repository_id: number;
  instance_id: string;
  installation_id: number;
  owner: string;
  name: string;
  authorization_revision: number;
  binding_epoch: number;
  suspended: number;
  created_at: number;
  updated_at: number;
}

interface InstanceRow {
  instance_id: string;
  repository_id: number;
  generation: number;
  runtime_epoch: number;
  desired_state: "running" | "stopped";
  policy: "stable" | "pinned";
  observed_generation: number | null;
  observed_runtime_epoch: number | null;
  observed_sequence: number;
  legacy_runtime_epoch?: number | null;
  observed_state: InstanceSnapshot["observedState"];
  desired_revision_id: string | null;
  observed_revision_id: string | null;
  desired_artifact_digest: string | null;
  current_artifact_digest: string | null;
  reservation_state: InstanceSnapshot["reservationState"];
  reservation_id: string | null;
  created_at: number;
  updated_at: number;
  current_cluster_id?: string | null;
}

interface OperationRow {
  operation_id: string;
  instance_id: string;
  repository_id: number;
  generation: number;
  runtime_epoch: number;
  kind: Operation["kind"];
  status: Operation["status"];
  attempt: number;
  lease_epoch: number;
  report_sequence: number;
  lease_expires_at: number | null;
  phase: string;
  cluster_id: string | null;
  reservation_id: string | null;
  deployment_revision_id: string | null;
  build_id: string | null;
  prerequisite_build_id: string | null;
  idempotency_key: string;
  idempotency_scope: string;
  worker_id: string | null;
  lease_token: string | null;
  checkpoint_sequence: number;
  checkpoint_json: string | null;
  result_json: string | null;
  request_hash: string;
  last_report_digest: string | null;
  created_at: number;
  updated_at: number;
}

interface ReservationRow {
  reservation_id: string;
  instance_id: string;
  repository_id: number;
  runtime_epoch: number;
  generation: number;
  cluster_id: string | null;
  status: RuntimeReservation["status"];
  capacity_snapshot_epoch: number;
  cpu_milli: number;
  memory_mib: number;
  ephemeral_storage_mib: number;
  created_at: number;
  updated_at: number;
}

interface CapacitySnapshotRow {
  cluster_id: string;
  capacity_epoch: number;
  observed_at: number;
  complete: number;
  allocatable_cpu_milli: number;
  allocatable_memory_mib: number;
  allocatable_ephemeral_storage_mib: number;
  requested_cpu_milli: number;
  requested_memory_mib: number;
  requested_ephemeral_storage_mib: number;
  node_resource_version: string;
  pod_resource_version: string;
  represented_reservation_ids_json: string;
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
  status: "building" | "admitted" | "failed" | "superseded";
}

interface ArtifactRow {
  artifact_digest: string;
  manifest_digest: string;
  platform_manifest_digest: string;
  composition_manifest_digest: string;
  producer_revision: string;
  requested_modules_json: string;
  resolved_modules_json: string;
  contract_versions_json: string;
  sbom_ref: string | null;
  provenance_ref: string | null;
  verification_json: string;
  statement_json: string;
  signature_json: string;
  verifier_id: string;
  admitted_at: number | null;
}

export interface D1DesiredStateInput {
  readonly snapshot: RepositorySnapshot;
  readonly expectedGeneration: number;
  readonly desiredState: "running" | "stopped";
  readonly nextRuntimeEpoch: number;
  readonly operation: OperationRecord;
  readonly requestHash: string;
  readonly actorId: string;
  readonly authorizationRevision: number;
  readonly requestId: string | null;
  readonly now: number;
  readonly actorKind?: "user" | "system" | "provisioner" | "operator";
  readonly expectedPolicy?: "stable" | "pinned";
  readonly expectedDesiredState?: "running" | "stopped";
  readonly expectedDesiredRevisionId?: string | null;
  readonly expectedClusterId?: string;
  readonly expectedReservationId?: string | null;
  readonly expectedObservedRuntimeEpoch?: number | null;
}

export interface D1PlatformStoreOptions {
  readonly now?: () => number;
  readonly maxCapacitySnapshotAgeMs?: number;
}

/** D1 is the only desired-state authority; Durable Objects only serialize calls to this store. */
export class D1PlatformStore implements OperationStore {
  constructor(
    private readonly db: D1Database,
    private readonly options: D1PlatformStoreOptions = {},
  ) {}

  async resolveOrCreate(input: RepositoryRegistryInput & { readonly instanceId: string }): Promise<{
    readonly snapshot: RepositorySnapshot;
    readonly created: boolean;
  }> {
    const { repository, instanceId, actor, requestId, now } = input;
    const results = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO logical_instances (
             instance_id, repository_id, generation, runtime_epoch, desired_state, policy,
             observed_generation, observed_runtime_epoch, observed_sequence, observed_state,
             desired_revision_id, observed_revision_id, desired_artifact_digest, current_artifact_digest,
             reservation_state, reservation_id, created_at, updated_at
           ) SELECT ?, ?, 0, 0, 'stopped', 'stable', NULL, NULL, 0, 'absent',
                    NULL, NULL, NULL, NULL, 'none', NULL, ?, ?
             WHERE NOT EXISTS (SELECT 1 FROM repository_bindings WHERE repository_id = ?)
             ON CONFLICT(repository_id) DO NOTHING`,
        )
        .bind(instanceId, repository.repositoryId, now, now, repository.repositoryId),
      this.db
        .prepare(
          `INSERT INTO repository_bindings (
             repository_id, instance_id, installation_id, owner, name,
             authorization_revision, binding_epoch, suspended, created_at, updated_at
           ) SELECT ?, ?, ?, ?, ?, ?, 1, 0, ?, ?
             FROM logical_instances i
             WHERE i.repository_id = ? AND i.instance_id = ?
               AND NOT EXISTS (SELECT 1 FROM repository_bindings b WHERE b.repository_id = ?)
           ON CONFLICT(repository_id) DO NOTHING`,
        )
        .bind(
          repository.repositoryId,
          instanceId,
          repository.installationId,
          repository.owner,
          repository.name,
          repository.authorizationRevision,
          now,
          now,
          repository.repositoryId,
          instanceId,
          repository.repositoryId,
        ),
      this.db
        .prepare(
          `INSERT INTO audit_events (
             event_id, repository_id, instance_id, operation_id, actor_id, actor_kind,
             action, outcome, request_id, metadata_json, occurred_at
           ) SELECT ?, ?, ?, NULL, ?, ?, 'repository.binding.created', 'accepted', ?, ?, ?
             WHERE changes() = 1`,
        )
        .bind(
          `repository.binding.created:${instanceId}`,
          repository.repositoryId,
          instanceId,
          actor.id,
          actor.kind,
          requestId,
          JSON.stringify({ bindingEpoch: 1, installationId: repository.installationId }),
          now,
        ),
    ]);
    const snapshot = await this.getByRepositoryId(repository.repositoryId);
    if (!snapshot) throw new Error("repository binding transaction did not produce a binding");
    return { snapshot, created: results[1]?.meta.changes === 1 };
  }

  getByRepositoryId(repositoryId: number): Promise<RepositorySnapshot | null> {
    return this.findSnapshot("b.repository_id = ?", repositoryId);
  }

  getByInstanceId(instanceId: string): Promise<RepositorySnapshot | null> {
    return this.findSnapshot("b.instance_id = ?", instanceId);
  }

  async getDeploymentRevision(
    revisionId: string,
  ): Promise<NonNullable<ClaimedOperation["deploymentRevision"]> | null> {
    const row = await this.db
      .prepare("SELECT * FROM deployment_revisions WHERE revision_id = ?")
      .bind(revisionId)
      .first<RevisionRow>();
    if (!row) return null;
    const artifact = row.artifact_digest
      ? await this.db
          .prepare("SELECT * FROM artifacts WHERE artifact_digest = ?")
          .bind(row.artifact_digest)
          .first<ArtifactRow>()
      : null;
    return toRevisionSummary(row, artifact);
  }

  async suspendBinding(input: SuspendBindingInput): Promise<RepositoryBinding | null> {
    let results: readonly { readonly meta: { readonly changes: number } }[];
    try {
      results = await this.db.batch([
        this.db
          .prepare(
            `INSERT INTO repository_events (delivery_id, repository_id, event_kind, occurred_at)
           VALUES (?, ?, ?, ?) ON CONFLICT(delivery_id) DO NOTHING`,
          )
          .bind(input.eventId, input.repositoryId, input.eventKind, input.now),
        this.db
          .prepare(
            `UPDATE repository_bindings
           SET suspended = 1, binding_epoch = binding_epoch + 1, updated_at = ?
           WHERE repository_id = ? AND binding_epoch = ? AND suspended = 0 AND changes() = 1`,
          )
          .bind(input.now, input.repositoryId, input.expectedBindingEpoch),
        this.assertOneChange(),
        this.db
          .prepare(
            `INSERT INTO audit_events (
             event_id, repository_id, instance_id, operation_id, actor_id, actor_kind,
             action, outcome, request_id, metadata_json, occurred_at
           ) SELECT ?, repository_id, instance_id, NULL, NULL, 'system',
                    'repository.binding.suspended', 'accepted', ?, ?, ?
             FROM repository_bindings WHERE repository_id = ? AND suspended = 1 AND binding_epoch = ?`,
          )
          .bind(
            `repository.binding.suspended:${input.eventId}`,
            input.requestId,
            JSON.stringify({
              eventId: input.eventId,
              eventKind: input.eventKind,
              reason: input.reason.slice(0, 512),
            }),
            input.now,
            input.repositoryId,
            input.expectedBindingEpoch + 1,
          ),
      ]);
    } catch (error) {
      if (isTransactionAssertion(error)) return null;
      throw error;
    }
    if (results[1]?.meta.changes !== 1) return null;
    return this.findBinding(input.repositoryId);
  }

  async revalidateBinding(input: RevalidateBindingInput): Promise<RepositoryBinding | null> {
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE repository_bindings
           SET installation_id = ?, owner = ?, name = ?, authorization_revision = ?,
               binding_epoch = binding_epoch + 1, suspended = 0, updated_at = ?
           WHERE repository_id = ? AND binding_epoch = ? AND suspended = 1`,
        )
        .bind(
          input.installationId,
          input.owner,
          input.name,
          input.authorizationRevision,
          input.now,
          input.repositoryId,
          input.expectedBindingEpoch,
        ),
      this.db
        .prepare(
          `INSERT INTO audit_events (
             event_id, repository_id, instance_id, operation_id, actor_id, actor_kind,
             action, outcome, request_id, metadata_json, occurred_at
           ) SELECT ?, repository_id, instance_id, NULL, ?, 'user', 'repository.binding.revalidated', 'accepted', ?, ?, ?
             FROM repository_bindings
             WHERE repository_id = ? AND binding_epoch = ? AND suspended = 0 AND changes() = 1`,
        )
        .bind(
          `repository.binding.revalidated:${input.repositoryId}:${input.expectedBindingEpoch + 1}`,
          input.actorId,
          input.requestId,
          JSON.stringify({
            bindingEpoch: input.expectedBindingEpoch + 1,
            installationId: input.installationId,
          }),
          input.now,
          input.repositoryId,
          input.expectedBindingEpoch + 1,
        ),
    ]);
    if (results[0]?.meta.changes !== 1) return null;
    return this.findBinding(input.repositoryId);
  }

  async findOperationByIdempotency(scope: string, key: string): Promise<OperationRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM operations WHERE idempotency_scope = ? AND idempotency_key = ?")
      .bind(scope, key)
      .first<OperationRow>();
    return row ? toOperation(row) : null;
  }

  async findActiveOperation(
    instanceId: string,
    generation: number,
  ): Promise<OperationRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM operations WHERE instance_id = ? AND generation = ?
         AND status IN ('pending', 'claimed', 'running') ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(instanceId, generation)
      .first<OperationRow>();
    return row ? toOperation(row) : null;
  }

  async getOperationById(operationId: string): Promise<OperationRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM operations WHERE operation_id = ?")
      .bind(operationId)
      .first<OperationRow>();
    return row ? toOperation(row) : null;
  }

  async blockClaimOperation(input: BlockClaimInput): Promise<OperationRecord | null> {
    const resultJson = JSON.stringify({ code: input.code, message: input.message });
    let results: readonly { readonly meta: { readonly changes: number } }[];
    try {
      results = await this.db.batch([
        this.db
          .prepare(
            `UPDATE operations
             SET status = 'blocked', phase = 'blocked', result_json = ?,
                 lease_token = NULL, lease_expires_at = NULL, updated_at = ?
             WHERE operation_id = ? AND worker_id = ? AND lease_token = ? AND lease_epoch = ?
               AND lease_expires_at > ? AND status = 'claimed'`,
          )
          .bind(
            resultJson,
            input.now,
            input.operationId,
            input.workerId,
            input.leaseToken,
            input.leaseEpoch,
            input.now,
          ),
        this.assertOneChange(),
        this.db
          .prepare(
            `INSERT INTO audit_events (
               event_id, repository_id, instance_id, operation_id, actor_id, actor_kind,
               action, outcome, request_id, metadata_json, occurred_at
             ) SELECT ?, repository_id, instance_id, operation_id, ?, 'provisioner',
                      'operation.claim.blocked', 'blocked', request_id, ?, ?
               FROM operations WHERE operation_id = ? AND status = 'blocked' AND lease_epoch = ?`,
          )
          .bind(
            `operation.claim.blocked:${input.operationId}:${input.leaseEpoch}`,
            input.workerId,
            resultJson,
            input.now,
            input.operationId,
            input.leaseEpoch,
          ),
      ]);
    } catch (error) {
      if (isTransactionAssertion(error)) return null;
      throw error;
    }
    if (results[0]?.meta.changes !== 1) return null;
    return this.getOperationById(input.operationId);
  }

  requestDesiredState(input: D1DesiredStateInput): Promise<DesiredStateMutationResult | null> {
    return this.commitDesiredState(input, []);
  }

  requestDesiredStateWithFence(
    input: D1DesiredStateInput,
    fenceStatements: readonly D1PreparedStatement[],
  ): Promise<DesiredStateMutationResult | null> {
    if (fenceStatements.length === 0)
      throw new TypeError("at least one durable fence statement is required");
    return this.commitDesiredState(input, fenceStatements);
  }

  private async commitDesiredState(
    input: D1DesiredStateInput,
    fenceStatements: readonly D1PreparedStatement[],
  ): Promise<DesiredStateMutationResult | null> {
    const { snapshot, operation, requestHash, now } = input;
    const scope = `repository:${snapshot.binding.repositoryId}`;
    const expectedPolicy = input.expectedPolicy ?? snapshot.instance.policy;
    const expectedDesiredState = input.expectedDesiredState ?? snapshot.instance.desiredState;
    const expectedDesiredRevisionId =
      input.expectedDesiredRevisionId === undefined
        ? snapshot.instance.desiredRevisionId
        : input.expectedDesiredRevisionId;
    const expectedReservationId =
      input.expectedReservationId === undefined
        ? snapshot.instance.reservationId
        : input.expectedReservationId;
    const expectedObservedRuntimeEpoch =
      input.expectedObservedRuntimeEpoch === undefined
        ? snapshot.instance.observedRuntimeEpoch
        : input.expectedObservedRuntimeEpoch;
    const expectedClusterId = input.expectedClusterId ?? null;
    const statements: D1PreparedStatement[] = [...fenceStatements];
    if (fenceStatements.length > 0) statements.push(this.assertOneChange());
    statements.push(
      this.db
        .prepare(
          `UPDATE logical_instances
           SET desired_state = ?, generation = ?, runtime_epoch = ?, updated_at = ?
           WHERE instance_id = ? AND repository_id = ? AND generation = ?
             AND runtime_epoch = ? AND desired_state = ? AND policy = ?
             AND desired_revision_id IS ? AND reservation_id IS ? AND observed_runtime_epoch IS ?
             AND (? IS NULL OR EXISTS (
               SELECT 1 FROM runtime_reservations current_reservation
               WHERE current_reservation.instance_id = logical_instances.instance_id
                 AND current_reservation.runtime_epoch = logical_instances.observed_runtime_epoch
                 AND current_reservation.cluster_id = ?
                 AND current_reservation.status IN ('reserved', 'allocated')
             ))
             AND EXISTS (
               SELECT 1 FROM repository_bindings b
               WHERE b.repository_id = ? AND b.instance_id = logical_instances.instance_id
                 AND b.binding_epoch = ? AND b.authorization_revision = ? AND b.suspended = 0
             )`,
        )
        .bind(
          input.desiredState,
          operation.generation,
          input.nextRuntimeEpoch,
          now,
          snapshot.instance.instanceId,
          snapshot.binding.repositoryId,
          input.expectedGeneration,
          snapshot.instance.runtimeEpoch,
          expectedDesiredState,
          expectedPolicy,
          expectedDesiredRevisionId,
          expectedReservationId,
          expectedObservedRuntimeEpoch,
          expectedClusterId,
          expectedClusterId,
          snapshot.binding.repositoryId,
          snapshot.binding.bindingEpoch,
          input.authorizationRevision,
        ),
      this.assertOneChange(),
      this.db
        .prepare(
          `INSERT INTO operations (
             operation_id, instance_id, repository_id, generation, runtime_epoch, kind, status, phase,
             attempt, lease_epoch, worker_id, lease_token, lease_expires_at, report_sequence, last_report_digest,
             checkpoint_sequence, checkpoint_json, result_json, cluster_id, reservation_id,
             deployment_revision_id, build_id, prerequisite_build_id, idempotency_scope, idempotency_key,
             request_hash, actor_id, authorization_revision, request_id, created_at, updated_at
           ) SELECT ?, ?, ?, ?, ?, ?, 'pending', ?, 0, 0, NULL, NULL, NULL, 0, NULL,
                    0, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
             FROM logical_instances i JOIN repository_bindings b
               ON b.repository_id = i.repository_id AND b.instance_id = i.instance_id
             WHERE i.instance_id = ? AND i.repository_id = ? AND i.generation = ? AND i.runtime_epoch = ?
               AND i.desired_state = ? AND b.binding_epoch = ? AND b.authorization_revision = ? AND b.suspended = 0
               AND NOT EXISTS (SELECT 1 FROM operations prior WHERE prior.operation_id = ?)`,
        )
        .bind(
          operation.id,
          operation.instanceId,
          operation.repositoryId,
          operation.generation,
          operation.runtimeEpoch,
          operation.kind,
          operation.phase,
          operation.clusterId,
          operation.reservationId,
          operation.deploymentRevisionId,
          operation.buildId,
          operation.prerequisiteBuildId,
          scope,
          operation.idempotencyKey,
          requestHash,
          input.actorId,
          input.authorizationRevision,
          input.requestId,
          now,
          now,
          operation.instanceId,
          operation.repositoryId,
          operation.generation,
          operation.runtimeEpoch,
          input.desiredState,
          snapshot.binding.bindingEpoch,
          input.authorizationRevision,
          operation.id,
        ),
      this.assertOneChange(),
      this.db
        .prepare(
          `INSERT INTO idempotency_records (scope, idempotency_key, request_hash, response_kind, response_id, created_at)
           SELECT ?, ?, ?, 'operation', ?, ?
           WHERE EXISTS (SELECT 1 FROM operations WHERE operation_id = ?)`,
        )
        .bind(scope, operation.idempotencyKey, requestHash, operation.id, now, operation.id),
      this.db
        .prepare(
          `INSERT INTO audit_events (
             event_id, repository_id, instance_id, operation_id, actor_id, actor_kind,
             action, outcome, request_id, metadata_json, occurred_at
           ) SELECT ?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?, ?
             WHERE EXISTS (SELECT 1 FROM operations WHERE operation_id = ?)`,
        )
        .bind(
          `operation.requested:${operation.id}`,
          snapshot.binding.repositoryId,
          snapshot.instance.instanceId,
          operation.id,
          input.actorId,
          input.actorKind ?? "user",
          `instance.${input.desiredState === "running" ? "start" : "stop"}`,
          input.requestId,
          JSON.stringify({
            generation: operation.generation,
            runtimeEpoch: operation.runtimeEpoch,
            authorizationRevision: input.authorizationRevision,
          }),
          now,
          operation.id,
        ),
    );
    let results: readonly { readonly meta: { readonly changes: number } }[];
    try {
      results = await this.db.batch(statements);
    } catch (error) {
      if (isTransactionAssertion(error)) return null;
      throw error;
    }
    if (results.at(-1)?.meta.changes !== 1) return null;
    const updated = await this.getByRepositoryId(snapshot.binding.repositoryId);
    const storedOperation = await this.findOperationByIdempotency(scope, operation.idempotencyKey);
    if (!updated || !storedOperation)
      throw new Error("desired state batch committed without its operation");
    return { ...updated, operation: storedOperation, replayed: false };
  }

  private assertOneChange(): D1PreparedStatement {
    return this.db.prepare(
      "INSERT INTO platform_transaction_sentinel(id) SELECT 1 WHERE changes() <> 1",
    );
  }

  async reserveRuntime(input: ReserveRuntimeInput): Promise<RuntimeReservation | null> {
    const operation = await this.db
      .prepare(
        "SELECT operation_id, instance_id, repository_id, kind, status, runtime_epoch, cluster_id FROM operations WHERE operation_id = ? AND worker_id = ? AND lease_token = ? AND lease_epoch = ? AND lease_expires_at > ?",
      )
      .bind(input.operationId, input.workerId, input.leaseToken, input.leaseEpoch, input.now)
      .first<{
        operation_id: string;
        instance_id: string;
        repository_id: number;
        kind: Operation["kind"];
        status: Operation["status"];
        runtime_epoch: number;
        cluster_id: string | null;
      }>();
    if (
      !operation ||
      (operation.status !== "claimed" && operation.status !== "running") ||
      operation.runtime_epoch !== input.expectedRuntimeEpoch ||
      operation.cluster_id !== input.clusterId
    )
      return null;

    if (operation.kind === "stop") {
      let results: readonly { readonly meta: { readonly changes: number } }[];
      try {
        results = await this.db.batch([
          this.db
            .prepare(
              `UPDATE operations
             SET cluster_id = ?, reservation_id = COALESCE(reservation_id, (
                   SELECT reservation_id FROM runtime_reservations
                   WHERE instance_id = operations.instance_id AND runtime_epoch = ?
                   ORDER BY created_at DESC LIMIT 1
                 )), phase = 'accepted', updated_at = ?
             WHERE operation_id = ? AND status IN ('claimed', 'running') AND runtime_epoch = ?
               AND worker_id = ? AND lease_token = ? AND lease_epoch = ? AND lease_expires_at > ?
               AND cluster_id = ?
               AND EXISTS (SELECT 1 FROM logical_instances i WHERE i.instance_id = operations.instance_id
                           AND i.generation = operations.generation AND i.runtime_epoch = ?)
               AND NOT EXISTS (
                 SELECT 1 FROM runtime_reservations r
                 WHERE r.instance_id = operations.instance_id AND r.status = 'reserved'
                   AND r.cluster_id IS NOT NULL AND r.cluster_id <> ?
               )`,
            )
            .bind(
              input.clusterId,
              input.expectedRuntimeEpoch,
              input.now,
              input.operationId,
              input.expectedRuntimeEpoch,
              input.workerId,
              input.leaseToken,
              input.leaseEpoch,
              input.now,
              input.clusterId,
              input.expectedRuntimeEpoch,
              input.clusterId,
            ),
          this.db
            .prepare(
              `UPDATE logical_instances SET reservation_id = COALESCE(
                     reservation_id,
                     (SELECT reservation_id FROM operations WHERE operation_id = ?)
                   ), updated_at = ?
             WHERE instance_id = ? AND runtime_epoch = ? AND changes() = 1`,
            )
            .bind(input.operationId, input.now, operation.instance_id, input.expectedRuntimeEpoch),
          this.assertOneChange(),
        ]);
      } catch (error) {
        if (isTransactionAssertion(error)) return null;
        throw error;
      }
      if (results[0]?.meta.changes !== 1) return null;
      const row = await this.db
        .prepare(
          "SELECT * FROM runtime_reservations WHERE reservation_id = (SELECT reservation_id FROM operations WHERE operation_id = ?)",
        )
        .bind(input.operationId)
        .first<ReservationRow>();
      return row ? toReservation(row) : null;
    }

    const cutoff = input.now - (this.options.maxCapacitySnapshotAgeMs ?? 30_000);
    let results: readonly { readonly meta: { readonly changes: number } }[];
    try {
      results = await this.db.batch([
        this.db
          .prepare(
            `INSERT INTO runtime_reservations (
             reservation_id, instance_id, repository_id, runtime_epoch, generation,
             cluster_id, status, capacity_snapshot_epoch, cpu_milli, memory_mib, ephemeral_storage_mib, created_at, updated_at
           ) SELECT ?, o.instance_id, o.repository_id, o.runtime_epoch, o.generation,
                    ?, 'reserved', ?, ?, ?, ?, ?, ?
             FROM operations o JOIN logical_instances i ON i.instance_id = o.instance_id
             WHERE o.operation_id = ? AND o.status IN ('claimed', 'running') AND o.kind <> 'stop'
               AND o.worker_id = ? AND o.lease_token = ? AND o.lease_epoch = ? AND o.lease_expires_at > ?
               AND o.cluster_id = ?
               AND o.runtime_epoch = ? AND o.generation = i.generation AND o.runtime_epoch = i.runtime_epoch
               AND EXISTS (
                 SELECT 1 FROM deployment_revisions d JOIN builds b ON b.build_id = d.build_id
                   JOIN artifacts a ON a.artifact_digest = d.artifact_digest
                 WHERE d.revision_id = o.deployment_revision_id AND d.instance_id = o.instance_id
                   AND d.repository_id = o.repository_id AND d.status = 'admitted'
                   AND d.artifact_digest IS NOT NULL AND b.status = 'succeeded'
                   AND b.build_key = d.build_key AND b.artifact_digest = d.artifact_digest
                   AND a.build_key = d.build_key AND a.build_id = b.build_id AND a.status = 'admitted'
                   AND CAST(json_extract(d.resource_requirements_json, '$.cpuMilli') AS INTEGER) = ?
                   AND CAST(json_extract(d.resource_requirements_json, '$.memoryMiB') AS INTEGER) = ?
                   AND CAST(json_extract(d.resource_requirements_json, '$.ephemeralStorageMiB') AS INTEGER) = ?
               )
               AND EXISTS (
                 SELECT 1 FROM cluster_capacity_snapshots c
                 WHERE c.cluster_id = ? AND c.capacity_epoch = ? AND c.complete = 1
                   AND c.observed_at >= ? AND c.observed_at <= ?
                   AND c.allocatable_cpu_milli - c.requested_cpu_milli - COALESCE((
                     SELECT SUM(r.cpu_milli) FROM runtime_reservations r
                     WHERE r.cluster_id = c.cluster_id AND r.status = 'reserved'
                       AND NOT (r.instance_id = o.instance_id AND r.runtime_epoch = o.runtime_epoch)
                   ), 0) >= ?
                   AND c.allocatable_memory_mib - c.requested_memory_mib - COALESCE((
                     SELECT SUM(r.memory_mib) FROM runtime_reservations r
                     WHERE r.cluster_id = c.cluster_id AND r.status = 'reserved'
                       AND NOT (r.instance_id = o.instance_id AND r.runtime_epoch = o.runtime_epoch)
                   ), 0) >= ?
                   AND c.allocatable_ephemeral_storage_mib - c.requested_ephemeral_storage_mib - COALESCE((
                     SELECT SUM(r.ephemeral_storage_mib) FROM runtime_reservations r
                     WHERE r.cluster_id = c.cluster_id AND r.status = 'reserved'
                       AND NOT (r.instance_id = o.instance_id AND r.runtime_epoch = o.runtime_epoch)
                   ), 0) >= ?
               )
               AND (o.reservation_id IS NULL OR EXISTS (
                 SELECT 1 FROM runtime_reservations existing
                 WHERE existing.reservation_id = o.reservation_id AND existing.status = 'reserved'
                   AND existing.cluster_id = ?
                   AND existing.cpu_milli = ? AND existing.memory_mib = ? AND existing.ephemeral_storage_mib = ?
               ))
             ON CONFLICT(instance_id, runtime_epoch) DO NOTHING`,
          )
          .bind(
            input.reservationId,
            input.clusterId,
            input.expectedCapacityEpoch,
            input.resources.cpuMilli,
            input.resources.memoryMiB,
            input.resources.ephemeralStorageMiB,
            input.now,
            input.now,
            input.operationId,
            input.workerId,
            input.leaseToken,
            input.leaseEpoch,
            input.now,
            input.clusterId,
            input.expectedRuntimeEpoch,
            input.resources.cpuMilli,
            input.resources.memoryMiB,
            input.resources.ephemeralStorageMiB,
            input.clusterId,
            input.expectedCapacityEpoch,
            cutoff,
            input.now,
            input.resources.cpuMilli,
            input.resources.memoryMiB,
            input.resources.ephemeralStorageMiB,
            input.clusterId,
            input.resources.cpuMilli,
            input.resources.memoryMiB,
            input.resources.ephemeralStorageMiB,
          ),
        this.db
          .prepare(
            `UPDATE operations
           SET cluster_id = ?, reservation_id = (
                 SELECT reservation_id FROM runtime_reservations
                 WHERE instance_id = operations.instance_id AND runtime_epoch = ?
                   AND status = 'reserved' AND cluster_id = ?
               ), phase = 'capacity-reserved', updated_at = ?
           WHERE operation_id = ? AND status IN ('claimed', 'running') AND runtime_epoch = ?
             AND worker_id = ? AND lease_token = ? AND lease_epoch = ? AND lease_expires_at > ?
             AND cluster_id = ?
             AND EXISTS (SELECT 1 FROM logical_instances i WHERE i.instance_id = operations.instance_id
                         AND i.generation = operations.generation AND i.runtime_epoch = operations.runtime_epoch)
             AND EXISTS (SELECT 1 FROM deployment_revisions d JOIN builds b ON b.build_id = d.build_id
                           JOIN artifacts a ON a.artifact_digest = d.artifact_digest
                         WHERE d.revision_id = operations.deployment_revision_id AND d.status = 'admitted'
                           AND d.artifact_digest IS NOT NULL AND b.status = 'succeeded'
                           AND b.build_key = d.build_key AND b.artifact_digest = d.artifact_digest
                           AND a.build_key = d.build_key AND a.build_id = b.build_id AND a.status = 'admitted'
                           AND CAST(json_extract(d.resource_requirements_json, '$.cpuMilli') AS INTEGER) = ?
                           AND CAST(json_extract(d.resource_requirements_json, '$.memoryMiB') AS INTEGER) = ?
                           AND CAST(json_extract(d.resource_requirements_json, '$.ephemeralStorageMiB') AS INTEGER) = ?)
             AND EXISTS (
               SELECT 1 FROM runtime_reservations existing
               WHERE existing.instance_id = operations.instance_id
                 AND existing.runtime_epoch = operations.runtime_epoch
                 AND existing.cluster_id = ? AND existing.status = 'reserved'
                 AND existing.cpu_milli = ? AND existing.memory_mib = ? AND existing.ephemeral_storage_mib = ?
                 AND (operations.reservation_id IS NULL OR operations.reservation_id = existing.reservation_id)
             )`,
          )
          .bind(
            input.clusterId,
            input.expectedRuntimeEpoch,
            input.clusterId,
            input.now,
            input.operationId,
            input.expectedRuntimeEpoch,
            input.workerId,
            input.leaseToken,
            input.leaseEpoch,
            input.now,
            input.clusterId,
            input.resources.cpuMilli,
            input.resources.memoryMiB,
            input.resources.ephemeralStorageMiB,
            input.clusterId,
            input.resources.cpuMilli,
            input.resources.memoryMiB,
            input.resources.ephemeralStorageMiB,
          ),
        this.db
          .prepare(
            `UPDATE logical_instances
           SET reservation_state = 'reserved', reservation_id = (
                 SELECT reservation_id FROM operations WHERE operation_id = ?
               ), updated_at = ?
           WHERE instance_id = ? AND runtime_epoch = ? AND changes() = 1`,
          )
          .bind(input.operationId, input.now, operation.instance_id, input.expectedRuntimeEpoch),
        this.assertOneChange(),
      ]);
    } catch (error) {
      if (isTransactionAssertion(error)) return null;
      throw error;
    }
    if (results[1]?.meta.changes !== 1) return null;
    const row = await this.db
      .prepare(
        "SELECT * FROM runtime_reservations WHERE reservation_id = (SELECT reservation_id FROM operations WHERE operation_id = ?)",
      )
      .bind(input.operationId)
      .first<ReservationRow>();
    return row ? toReservation(row) : null;
  }

  async releaseRuntimeReservation(input: {
    readonly reservationId: string;
    readonly operationId: string;
    readonly workerId: string;
    readonly leaseToken: string;
    readonly leaseEpoch: number;
    readonly expectedReservationRuntimeEpoch: number;
    readonly now: number;
  }): Promise<boolean> {
    let results: readonly { readonly meta: { readonly changes: number } }[];
    try {
      results = await this.db.batch([
        this.db
          .prepare(
            `UPDATE runtime_reservations
             SET status = 'released', updated_at = CASE
               WHEN status IN ('reserved', 'allocated') THEN ? ELSE updated_at END
             WHERE reservation_id = ? AND runtime_epoch = ?
               AND ((status IN ('reserved', 'allocated') AND NOT EXISTS (
                 SELECT 1 FROM audit_events conflicting_release WHERE conflicting_release.event_id = ?
               )) OR (status = 'released' AND EXISTS (
                 SELECT 1 FROM audit_events prior_release
                 WHERE prior_release.event_id = ?
                   AND prior_release.operation_id = ?
                   AND prior_release.repository_id = runtime_reservations.repository_id
                   AND prior_release.instance_id = runtime_reservations.instance_id
                   AND prior_release.actor_kind = 'provisioner'
                   AND prior_release.action = 'runtime.reservation.released'
                   AND prior_release.outcome = 'accepted'
                   AND json_extract(prior_release.metadata_json, '$.reservationId') = runtime_reservations.reservation_id
                   AND CAST(json_extract(prior_release.metadata_json, '$.retiredRuntimeEpoch') AS INTEGER) = runtime_reservations.runtime_epoch
               )))
               AND EXISTS (
                 SELECT 1 FROM operations o JOIN logical_instances i ON i.instance_id = o.instance_id
                 WHERE o.operation_id = ? AND o.instance_id = runtime_reservations.instance_id
                   AND o.repository_id = runtime_reservations.repository_id
                   AND o.worker_id = ? AND o.lease_token = ? AND o.lease_epoch = ?
                   AND o.lease_expires_at > ? AND o.status IN ('claimed', 'running')
                   AND o.generation = i.generation
                   AND (
                     (o.kind = 'stop' AND o.phase IN ('old-writer-absent', 'complete')
                       AND o.runtime_epoch = i.runtime_epoch
                       AND i.observed_generation = runtime_reservations.generation
                       AND i.observed_runtime_epoch = runtime_reservations.runtime_epoch
                       AND i.reservation_id = runtime_reservations.reservation_id)
                     OR (o.kind <> 'stop' AND o.phase IN ('route-activated', 'complete')
                       AND o.runtime_epoch = i.runtime_epoch AND i.observed_runtime_epoch = o.runtime_epoch
                       AND i.observed_revision_id = o.deployment_revision_id
                       AND o.runtime_epoch <> runtime_reservations.runtime_epoch)
                   )
                   AND json_extract(o.checkpoint_json, '$.writerAbsenceProof.instanceId') = runtime_reservations.instance_id
                   AND CAST(json_extract(o.checkpoint_json, '$.writerAbsenceProof.repositoryId') AS INTEGER) = runtime_reservations.repository_id
                   AND CAST(json_extract(o.checkpoint_json, '$.writerAbsenceProof.retiredRuntimeEpoch') AS INTEGER) = runtime_reservations.runtime_epoch
                   AND (o.kind <> 'stop' OR EXISTS (
                     SELECT 1 FROM logical_instances current_instance
                     WHERE current_instance.instance_id = runtime_reservations.instance_id
                       AND current_instance.reservation_id = runtime_reservations.reservation_id
                       AND current_instance.observed_runtime_epoch = runtime_reservations.runtime_epoch
                   ))
               )`,
          )
          .bind(
            input.now,
            input.reservationId,
            input.expectedReservationRuntimeEpoch,
            `runtime.reservation.released:${input.reservationId}:${input.operationId}`,
            `runtime.reservation.released:${input.reservationId}:${input.operationId}`,
            input.operationId,
            input.operationId,
            input.workerId,
            input.leaseToken,
            input.leaseEpoch,
            input.now,
          ),
        this.assertOneChange(),
        this.db
          .prepare(
            `UPDATE logical_instances SET reservation_state = 'released', reservation_id = NULL,
               runtime_authority_reservation_id = NULL, runtime_authority_operation_id = NULL, updated_at = ?
             WHERE reservation_id = ? AND observed_runtime_epoch = ?
               AND EXISTS (SELECT 1 FROM operations WHERE operation_id = ? AND kind = 'stop')`,
          )
          .bind(
            input.now,
            input.reservationId,
            input.expectedReservationRuntimeEpoch,
            input.operationId,
          ),
        this.db
          .prepare(
            `INSERT INTO audit_events (
               event_id, repository_id, instance_id, operation_id, actor_id, actor_kind,
               action, outcome, request_id, metadata_json, occurred_at
           ) SELECT ?, repository_id, instance_id, operation_id, ?, 'provisioner',
                      'runtime.reservation.released', 'accepted', request_id, ?, ?
               FROM operations WHERE operation_id = ?
                 AND EXISTS (SELECT 1 FROM runtime_reservations WHERE reservation_id = ? AND status = 'released')
             ON CONFLICT(event_id) DO NOTHING`,
          )
          .bind(
            `runtime.reservation.released:${input.reservationId}:${input.operationId}`,
            input.workerId,
            JSON.stringify({
              reservationId: input.reservationId,
              retiredRuntimeEpoch: input.expectedReservationRuntimeEpoch,
            }),
            input.now,
            input.operationId,
            input.reservationId,
          ),
      ]);
    } catch (error) {
      if (isTransactionAssertion(error)) return false;
      throw error;
    }
    return results[0]?.meta.changes === 1;
  }

  async recordCapacitySnapshot(input: {
    readonly clusterId: string;
    readonly observedAt: number;
    readonly complete: boolean;
    readonly capacity: CapacityResourceSnapshot;
    readonly representedReservationIds: readonly string[];
  }): Promise<number | null> {
    const capacity = input.capacity;
    const representedReservationIds = input.complete
      ? [...new Set(input.representedReservationIds)]
      : [];
    const results = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO cluster_capacity_snapshots (
           cluster_id, capacity_epoch, observed_at, complete,
           allocatable_cpu_milli, allocatable_memory_mib, allocatable_ephemeral_storage_mib,
           requested_cpu_milli, requested_memory_mib, requested_ephemeral_storage_mib,
           node_resource_version, pod_resource_version, represented_reservation_ids_json, updated_at
         ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(cluster_id) DO UPDATE SET
           capacity_epoch = cluster_capacity_snapshots.capacity_epoch + 1,
           observed_at = excluded.observed_at,
           complete = excluded.complete,
           allocatable_cpu_milli = excluded.allocatable_cpu_milli,
           allocatable_memory_mib = excluded.allocatable_memory_mib,
           allocatable_ephemeral_storage_mib = excluded.allocatable_ephemeral_storage_mib,
           requested_cpu_milli = excluded.requested_cpu_milli,
           requested_memory_mib = excluded.requested_memory_mib,
           requested_ephemeral_storage_mib = excluded.requested_ephemeral_storage_mib,
           node_resource_version = excluded.node_resource_version,
           pod_resource_version = excluded.pod_resource_version,
           represented_reservation_ids_json = excluded.represented_reservation_ids_json,
           updated_at = excluded.updated_at
         WHERE excluded.observed_at > cluster_capacity_snapshots.observed_at
         RETURNING capacity_epoch`,
        )
        .bind(
          input.clusterId,
          input.observedAt,
          input.complete ? 1 : 0,
          capacity.allocatable.cpuMilli,
          capacity.allocatable.memoryMiB,
          capacity.allocatable.ephemeralStorageMiB,
          capacity.requested.cpuMilli,
          capacity.requested.memoryMiB,
          capacity.requested.ephemeralStorageMiB,
          capacity.nodeResourceVersion,
          capacity.podResourceVersion,
          JSON.stringify(representedReservationIds),
          input.observedAt,
        ),
      this.db
        .prepare(
          `UPDATE runtime_reservations
           SET status = CASE
             WHEN reservation_id IN (SELECT value FROM json_each(?)) THEN 'allocated'
             ELSE 'reserved' END,
             updated_at = ?
           WHERE cluster_id = ? AND status IN ('reserved', 'allocated') AND changes() = 1`,
        )
        .bind(JSON.stringify(representedReservationIds), input.observedAt, input.clusterId),
    ]);
    if (results[0]?.meta.changes !== 1) return null;
    const current = await this.db
      .prepare(
        `SELECT capacity_epoch FROM cluster_capacity_snapshots
         WHERE cluster_id = ? AND observed_at = ? AND node_resource_version = ? AND pod_resource_version = ?`,
      )
      .bind(
        input.clusterId,
        input.observedAt,
        capacity.nodeResourceVersion,
        capacity.podResourceVersion,
      )
      .first<{ capacity_epoch: number }>();
    return current?.capacity_epoch ?? null;
  }

  async currentReservations(clusterId: string): Promise<ReservationSnapshot> {
    const [capacityRow, rows] = await Promise.all([
      this.db
        .prepare("SELECT * FROM cluster_capacity_snapshots WHERE cluster_id = ?")
        .bind(clusterId)
        .first<CapacitySnapshotRow>(),
      this.db
        .prepare(
          `SELECT * FROM runtime_reservations
           WHERE cluster_id = ? AND status IN ('reserved', 'allocated') ORDER BY instance_id, runtime_epoch`,
        )
        .bind(clusterId)
        .all<ReservationRow>(),
    ]);
    return {
      clusterId,
      capacityEpoch: capacityRow?.capacity_epoch ?? 0,
      observedAt: capacityRow?.observed_at ?? 0,
      complete: capacityRow?.complete === 1,
      capacity: capacityRow ? toCapacitySnapshot(capacityRow) : null,
      representedReservationIds: capacityRow
        ? parseStringArray(capacityRow.represented_reservation_ids_json)
        : [],
      reservations: rows.results.map(toReservation),
    };
  }

  async claimNextOperation(input: {
    readonly workerId: string;
    readonly clusterId: string;
    readonly leaseToken: string;
    readonly now: number;
    readonly leaseSeconds: number;
  }): Promise<ClaimedOperation | null> {
    const row = await this.db
      .prepare(
        `UPDATE operations
         SET status = 'claimed', attempt = attempt + 1, lease_epoch = lease_epoch + 1,
             worker_id = ?, lease_token = ?, lease_expires_at = ?, report_sequence = 0,
             last_report_digest = NULL, updated_at = ?, cluster_id = COALESCE(cluster_id, ?)
         WHERE operation_id = (
           SELECT o.operation_id FROM operations o JOIN logical_instances i ON i.instance_id = o.instance_id
           WHERE (o.cluster_id = ? OR o.cluster_id IS NULL)
             AND (o.status = 'pending' OR (o.status IN ('claimed', 'running') AND o.lease_expires_at <= ?))
             AND o.generation = i.generation AND o.runtime_epoch = i.runtime_epoch
             AND (o.kind = 'stop' OR EXISTS (
               SELECT 1 FROM repository_bindings active_binding
               WHERE active_binding.repository_id = o.repository_id
                 AND active_binding.instance_id = o.instance_id AND active_binding.suspended = 0
                 AND active_binding.authorization_revision = o.authorization_revision
             ))
             AND (o.kind = 'stop' OR (
               o.deployment_revision_id IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM deployment_revisions d
                   JOIN builds verified_build ON verified_build.build_id = d.build_id
                   JOIN artifacts a ON a.artifact_digest = d.artifact_digest
                 WHERE d.revision_id = o.deployment_revision_id AND d.instance_id = o.instance_id
                   AND d.repository_id = o.repository_id AND d.status = 'admitted'
                   AND d.artifact_digest IS NOT NULL AND verified_build.status = 'succeeded'
                   AND verified_build.build_key = d.build_key AND verified_build.artifact_digest = d.artifact_digest
                   AND a.build_key = d.build_key AND a.build_id = verified_build.build_id AND a.status = 'admitted'
                   AND (o.build_id IS NULL OR o.build_id = d.build_id)
                   AND (o.prerequisite_build_id IS NULL OR o.prerequisite_build_id = d.build_id)
               )
             ))
           ORDER BY o.created_at, o.operation_id LIMIT 1
         )
         RETURNING *`,
      )
      .bind(
        input.workerId,
        input.leaseToken,
        input.now + input.leaseSeconds * 1000,
        input.now,
        input.clusterId,
        input.clusterId,
        input.now,
      )
      .first<OperationRow>();
    if (!row) return null;
    const snapshot = await this.getByInstanceId(row.instance_id);
    if (!snapshot) throw new Error("claimed operation has no repository binding");
    const reservationRow = row.reservation_id
      ? await this.db
          .prepare("SELECT * FROM runtime_reservations WHERE reservation_id = ?")
          .bind(row.reservation_id)
          .first<ReservationRow>()
      : null;
    const deploymentRevision = row.deployment_revision_id
      ? await this.getDeploymentRevision(row.deployment_revision_id)
      : null;
    const currentReservationRow =
      snapshot.instance.observedRuntimeEpoch === null
        ? null
        : await this.db
            .prepare(
              `SELECT * FROM runtime_reservations
             WHERE instance_id = ? AND runtime_epoch = ? AND status IN ('reserved', 'allocated') LIMIT 1`,
            )
            .bind(row.instance_id, snapshot.instance.observedRuntimeEpoch)
            .first<ReservationRow>();
    const currentDeploymentRevision = snapshot.instance.observedRevisionId
      ? await this.getDeploymentRevision(snapshot.instance.observedRevisionId)
      : null;
    return {
      operation: toOperation(row),
      snapshot,
      reservation: reservationRow ? toReservation(reservationRow) : null,
      deploymentRevision,
      currentReservation: currentReservationRow ? toReservation(currentReservationRow) : null,
      currentDeploymentRevision,
    };
  }

  async heartbeatOperation(input: {
    readonly operationId: string;
    readonly workerId: string;
    readonly leaseToken: string;
    readonly leaseEpoch: number;
    readonly sequence: number;
    readonly now: number;
    readonly leaseSeconds: number;
  }): Promise<{ readonly operation: OperationRecord; readonly leaseExpiresAt: number } | null> {
    const current = await this.db
      .prepare("SELECT * FROM operations WHERE operation_id = ?")
      .bind(input.operationId)
      .first<OperationRow>();
    if (
      !current ||
      current.worker_id !== input.workerId ||
      current.lease_token !== input.leaseToken ||
      current.lease_epoch !== input.leaseEpoch ||
      current.lease_expires_at === null ||
      current.lease_expires_at <= input.now
    )
      return null;
    if (input.sequence === current.report_sequence) {
      return { operation: toOperation(current), leaseExpiresAt: current.lease_expires_at };
    }
    if (
      input.sequence !== current.report_sequence + 1 ||
      !(current.status === "claimed" || current.status === "running")
    )
      return null;
    const leaseExpiresAt = input.now + input.leaseSeconds * 1000;
    const updated = await this.db
      .prepare(
        `UPDATE operations SET status = 'running', report_sequence = ?, lease_expires_at = ?, updated_at = ?
         WHERE operation_id = ? AND worker_id = ? AND lease_token = ? AND lease_epoch = ?
           AND status IN ('claimed', 'running') AND lease_expires_at > ? AND report_sequence = ?
         RETURNING *`,
      )
      .bind(
        input.sequence,
        leaseExpiresAt,
        input.now,
        input.operationId,
        input.workerId,
        input.leaseToken,
        input.leaseEpoch,
        input.now,
        current.report_sequence,
      )
      .first<OperationRow>();
    return updated ? { operation: toOperation(updated), leaseExpiresAt } : null;
  }

  async appendOperationCheckpoint(
    input: OperationCheckpointInput,
  ): Promise<OperationRecord | null> {
    const checkpointJson = encodeBoundedObject(input.checkpoint, 32_768);
    const sequence = input.expectedCheckpointSequence + 1;
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE operations SET phase = ?, checkpoint_sequence = ?, checkpoint_json = ?, updated_at = ?
           WHERE operation_id = ? AND worker_id = ? AND lease_token = ? AND lease_epoch = ?
             AND status IN ('claimed', 'running') AND lease_expires_at > ? AND checkpoint_sequence = ?
             AND (NOT EXISTS (
               SELECT 1 FROM logical_instances i WHERE i.runtime_authority_operation_id = operations.operation_id
             ) OR ? NOT IN ('starting-target', 'target-ready', 'route-activated', 'complete') OR (
               json_extract(?, '$.schemaVersion') = 1
               AND (SELECT COUNT(*) FROM json_each(?, '$.writerAbsenceProof') supplied
                    WHERE supplied.key IN ('instanceId', 'repositoryId', 'retiredRuntimeEpoch',
                      'providerObservationId', 'censusObservedAt', 'remainingWriters', 'evidenceIdentities', 'source')
                      AND supplied.value IS json_extract(operations.checkpoint_json, '$.writerAbsenceProof.' || supplied.key)
                      AND supplied.type IS json_type(operations.checkpoint_json, '$.writerAbsenceProof.' || supplied.key)
                   ) = 8
             ))`,
        )
        .bind(
          input.phase,
          sequence,
          checkpointJson,
          input.now,
          input.operationId,
          input.workerId,
          input.leaseToken,
          input.leaseEpoch,
          input.now,
          input.expectedCheckpointSequence,
          input.phase,
          checkpointJson,
          checkpointJson,
        ),
      this.db
        .prepare(
          `INSERT INTO operation_checkpoints (operation_id, sequence, phase, runtime_epoch, checkpoint_json, actor_id, occurred_at)
           SELECT operation_id, ?, phase, runtime_epoch, ?, ?, ? FROM operations
           WHERE operation_id = ? AND checkpoint_sequence = ? AND changes() = 1`,
        )
        .bind(sequence, checkpointJson, input.workerId, input.now, input.operationId, sequence),
      ...(["quiescing-old", "old-quiesced", "stopping-old", "old-writer-absent"].includes(input.phase)
        ? [this.db.prepare(
            `UPDATE logical_instances
             SET runtime_authority_reservation_id = NULL, runtime_authority_operation_id = NULL
             WHERE changes() = 1 AND instance_id = (
               SELECT instance_id FROM operations WHERE operation_id = ? AND checkpoint_sequence = ?
             )`,
          ).bind(input.operationId, sequence)]
        : []),
      ...(input.phase === "quiescing-old" || input.phase === "old-writer-absent"
        ? [
            this.db
              .prepare(
                `UPDATE runtime_git_credentials SET status = 'revocation_pending', updated_at = ?
         WHERE status = 'active' AND changes() = 1 AND EXISTS (
           SELECT 1 FROM operations o
           WHERE o.operation_id = ? AND o.checkpoint_sequence = ?
             AND (o.instance_id = runtime_git_credentials.instance_id OR runtime_git_credentials.instance_id = 'run_' || substr(o.instance_id, 5) || '_' || runtime_git_credentials.runtime_epoch)
             AND o.repository_id = runtime_git_credentials.repository_id
             AND (
               (o.phase = 'quiescing-old'
                AND json_extract(o.checkpoint_json, '$.lifecycle.quiesceRequest.instanceId') = o.instance_id
                AND json_extract(o.checkpoint_json, '$.lifecycle.quiesceRequest.runtimeEpoch') = runtime_git_credentials.runtime_epoch)
               OR
               (o.phase = 'old-writer-absent'
                AND json_type(o.checkpoint_json, '$.writerAbsenceProof.instanceId') = 'text'
                AND json_extract(o.checkpoint_json, '$.writerAbsenceProof.instanceId') = o.instance_id
                AND json_type(o.checkpoint_json, '$.writerAbsenceProof.repositoryId') = 'integer'
                AND json_extract(o.checkpoint_json, '$.writerAbsenceProof.repositoryId') = o.repository_id
                AND json_type(o.checkpoint_json, '$.writerAbsenceProof.retiredRuntimeEpoch') = 'integer'
                AND json_extract(o.checkpoint_json, '$.writerAbsenceProof.retiredRuntimeEpoch') = runtime_git_credentials.runtime_epoch)
             )
         )`,
              )
              .bind(input.now, input.operationId, sequence),
          ]
        : []),
    ]);
    if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) return null;
    const row = await this.db
      .prepare("SELECT * FROM operations WHERE operation_id = ?")
      .bind(input.operationId)
      .first<OperationRow>();
    return row ? toOperation(row) : null;
  }

  async advanceRuntimeEpochForRecovery(input: {
    readonly operationId: string;
    readonly workerId: string;
    readonly leaseToken: string;
    readonly leaseEpoch: number;
    readonly expectedRuntimeEpoch: number;
    readonly checkpoint: Readonly<Record<string, unknown>>;
    readonly now: number;
  }): Promise<OperationRecord | null> {
    const checkpointJson = encodeBoundedObject(input.checkpoint, 32_768);
    let results: readonly { readonly meta: { readonly changes: number } }[];
    try {
      results = await this.db.batch([
        this.db
          .prepare(
            `UPDATE logical_instances SET runtime_epoch = runtime_epoch + 1,
               runtime_authority_reservation_id = NULL, runtime_authority_operation_id = NULL,
               observed_state = 'unknown', observed_generation = NULL,
               observed_runtime_epoch = NULL, observed_sequence = 0,
               current_artifact_digest = NULL, updated_at = ?
           WHERE instance_id = (SELECT instance_id FROM operations WHERE operation_id = ?)
             AND runtime_epoch = ? AND generation = (SELECT generation FROM operations WHERE operation_id = ?)
             AND EXISTS (SELECT 1 FROM operations o WHERE o.operation_id = ? AND o.worker_id = ?
                         AND o.lease_token = ? AND o.lease_epoch = ? AND o.lease_expires_at > ?
                         AND o.runtime_epoch = ? AND o.status IN ('claimed', 'running'))`,
          )
          .bind(
            input.now,
            input.operationId,
            input.expectedRuntimeEpoch,
            input.operationId,
            input.operationId,
            input.workerId,
            input.leaseToken,
            input.leaseEpoch,
            input.now,
            input.expectedRuntimeEpoch,
          ),
        this.db
          .prepare(
            `UPDATE operations SET runtime_epoch = ?, phase = 'unknown', checkpoint_sequence = checkpoint_sequence + 1,
               checkpoint_json = ?, updated_at = ?
           WHERE operation_id = ? AND worker_id = ? AND lease_token = ? AND lease_epoch = ?
             AND lease_expires_at > ? AND runtime_epoch = ? AND status IN ('claimed', 'running')
             AND EXISTS (SELECT 1 FROM logical_instances i WHERE i.instance_id = operations.instance_id
                         AND i.generation = operations.generation AND i.runtime_epoch = ?)`,
          )
          .bind(
            input.expectedRuntimeEpoch + 1,
            checkpointJson,
            input.now,
            input.operationId,
            input.workerId,
            input.leaseToken,
            input.leaseEpoch,
            input.now,
            input.expectedRuntimeEpoch,
            input.expectedRuntimeEpoch + 1,
          ),
        this.assertOneChange(),
        this.db
          .prepare(
            `INSERT INTO operation_checkpoints (operation_id, sequence, phase, runtime_epoch, checkpoint_json, actor_id, occurred_at)
           SELECT operation_id, checkpoint_sequence, phase, runtime_epoch, ?, ?, ? FROM operations
           WHERE operation_id = ? AND runtime_epoch = ?`,
          )
          .bind(
            checkpointJson,
            input.workerId,
            input.now,
            input.operationId,
            input.expectedRuntimeEpoch + 1,
          ),
        this.assertOneChange(),
      ]);
    } catch (error) {
      if (isTransactionAssertion(error)) return null;
      throw error;
    }
    if (results.some((result) => result.meta.changes !== 1)) return null;
    const row = await this.db
      .prepare("SELECT * FROM operations WHERE operation_id = ?")
      .bind(input.operationId)
      .first<OperationRow>();
    return row ? toOperation(row) : null;
  }

  async reportOperation(input: {
    readonly operationId: string;
    readonly workerId: string;
    readonly leaseToken: string;
    readonly leaseEpoch: number;
    readonly sequence: number;
    readonly observation: OperationObservation | null;
    readonly terminal: OperationTerminal | null;
    readonly now: number;
  }): Promise<{
    readonly operation: OperationRecord;
    readonly applied: boolean;
    readonly duplicate: boolean;
  } | null> {
    const observation = input.observation;
    if (input.terminal === "succeeded" && observation === null) return null;
    if (input.terminal !== null && input.terminal !== "succeeded" && observation !== null)
      return null;
    if (input.terminal === null && observation !== null && observation.observedState !== "ready")
      return null;
    const digest = await digestJson({ observation, terminal: input.terminal });
    const current = await this.db
      .prepare("SELECT * FROM operations WHERE operation_id = ?")
      .bind(input.operationId)
      .first<OperationRow>();
    if (
      !current ||
      current.worker_id !== input.workerId ||
      current.lease_token !== input.leaseToken ||
      current.lease_epoch !== input.leaseEpoch
    )
      return null;
    if (input.sequence === current.report_sequence && current.last_report_digest === digest) {
      return { operation: toOperation(current), applied: false, duplicate: true };
    }
    if (current.lease_expires_at === null || current.lease_expires_at <= input.now) return null;
    if (
      input.sequence !== current.report_sequence + 1 ||
      !(current.status === "claimed" || current.status === "running")
    )
      return null;
    if (observation) {
      if (
        observation.instanceId !== current.instance_id ||
        observation.repositoryId !== current.repository_id ||
        observation.generation !== current.generation ||
        observation.runtimeEpoch !== current.runtime_epoch
      )
        return null;
      if (
        current.kind === "stop" &&
        ((observation.observedState !== "absent" && observation.observedState !== "stopped") ||
          observation.observedArtifactDigest !== null ||
          observation.observedRevisionId !== null)
      )
        return null;
    }

    const status = input.terminal ?? "running";
    const phase =
      input.terminal === "succeeded"
        ? "complete"
        : input.terminal === "failed"
          ? "failed"
          : input.terminal === "blocked"
            ? "blocked"
            : current.phase;
    const resultJson = JSON.stringify({ observation, terminal: input.terminal });
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `UPDATE operations SET status = ?, phase = ?, report_sequence = ?, last_report_digest = ?,
               result_json = ?, updated_at = ?
           WHERE operation_id = ? AND worker_id = ? AND lease_token = ? AND lease_epoch = ?
             AND lease_expires_at > ? AND status IN ('claimed', 'running') AND report_sequence = ?
             AND EXISTS (SELECT 1 FROM logical_instances i WHERE i.instance_id = operations.instance_id
                         AND i.generation = operations.generation AND i.runtime_epoch = operations.runtime_epoch)
             AND (
               ((? IS NULL OR ? IN ('failed', 'blocked')) AND ? IS NULL)
               OR (? = 'succeeded' AND (
                 (operations.kind = 'stop' AND operations.phase = 'complete'
                   AND ? IN ('absent', 'stopped') AND ? IS NULL AND ? IS NULL
                   AND EXISTS (
                     SELECT 1 FROM operation_checkpoints old_writer_absent
                     WHERE old_writer_absent.operation_id = operations.operation_id
                       AND old_writer_absent.phase = 'old-writer-absent'
                       AND old_writer_absent.runtime_epoch = operations.runtime_epoch
                       AND json_extract(old_writer_absent.checkpoint_json, '$.writerAbsenceProof.instanceId')
                           IS json_extract(operations.checkpoint_json, '$.writerAbsenceProof.instanceId')
                       AND json_extract(old_writer_absent.checkpoint_json, '$.writerAbsenceProof.repositoryId')
                           IS json_extract(operations.checkpoint_json, '$.writerAbsenceProof.repositoryId')
                       AND json_extract(old_writer_absent.checkpoint_json, '$.writerAbsenceProof.retiredRuntimeEpoch')
                           IS json_extract(operations.checkpoint_json, '$.writerAbsenceProof.retiredRuntimeEpoch')
                       AND json_extract(old_writer_absent.checkpoint_json, '$.writerAbsenceProof.providerObservationId')
                           IS json_extract(operations.checkpoint_json, '$.writerAbsenceProof.providerObservationId')
                       AND json_extract(old_writer_absent.checkpoint_json, '$.writerAbsenceProof.censusObservedAt')
                           IS json_extract(operations.checkpoint_json, '$.writerAbsenceProof.censusObservedAt')
                       AND json_extract(old_writer_absent.checkpoint_json, '$.writerAbsenceProof.remainingWriters')
                           IS json_extract(operations.checkpoint_json, '$.writerAbsenceProof.remainingWriters')
                       AND json_extract(old_writer_absent.checkpoint_json, '$.writerAbsenceProof.evidenceIdentities')
                           IS json_extract(operations.checkpoint_json, '$.writerAbsenceProof.evidenceIdentities')
                       AND json_extract(old_writer_absent.checkpoint_json, '$.writerAbsenceProof.source')
                           IS json_extract(operations.checkpoint_json, '$.writerAbsenceProof.source')
                   )
                   AND json_type(operations.checkpoint_json, '$.writerAbsenceProof.instanceId') = 'text'
                   AND json_extract(operations.checkpoint_json, '$.writerAbsenceProof.instanceId') = operations.instance_id
                   AND json_type(operations.checkpoint_json, '$.writerAbsenceProof.repositoryId') = 'integer'
                   AND json_extract(operations.checkpoint_json, '$.writerAbsenceProof.repositoryId') = operations.repository_id
                   AND json_type(operations.checkpoint_json, '$.writerAbsenceProof.retiredRuntimeEpoch') = 'integer'
                   AND json_type(operations.checkpoint_json, '$.writerAbsenceProof.providerObservationId') = 'text'
                   AND length(trim(json_extract(operations.checkpoint_json, '$.writerAbsenceProof.providerObservationId'))) > 0
                   AND json_type(operations.checkpoint_json, '$.writerAbsenceProof.censusObservedAt') = 'text'
                   AND length(trim(json_extract(operations.checkpoint_json, '$.writerAbsenceProof.censusObservedAt'))) > 0
                   AND json_type(operations.checkpoint_json, '$.writerAbsenceProof.remainingWriters') = 'integer'
                   AND json_extract(operations.checkpoint_json, '$.writerAbsenceProof.remainingWriters') = 0
                   AND json_type(operations.checkpoint_json, '$.writerAbsenceProof.evidenceIdentities') = 'array'
                   AND json_extract(operations.checkpoint_json, '$.writerAbsenceProof.source') = 'runtime-provider-census'
                   AND EXISTS (
                     SELECT 1 FROM logical_instances stopped_instance
                      WHERE stopped_instance.instance_id = operations.instance_id
                        AND stopped_instance.generation = operations.generation
                        AND stopped_instance.runtime_epoch = operations.runtime_epoch
                        AND NOT EXISTS (
                          SELECT 1 FROM runtime_reservations prior_reservation
                           WHERE prior_reservation.instance_id = operations.instance_id
                             AND prior_reservation.repository_id = operations.repository_id
                             AND prior_reservation.runtime_epoch < operations.runtime_epoch
                             AND prior_reservation.status IN ('reserved', 'allocated')
                        )
                        AND (
                          (stopped_instance.observed_runtime_epoch IS NOT NULL
                           AND json_type(operations.checkpoint_json, '$.writerAbsenceProof.retiredRuntimeEpoch') = 'integer'
                           AND json_extract(operations.checkpoint_json, '$.writerAbsenceProof.retiredRuntimeEpoch')
                             = stopped_instance.observed_runtime_epoch)
                          OR (stopped_instance.observed_runtime_epoch IS NULL
                           AND stopped_instance.observed_state IN ('absent', 'stopped')
                           AND json_extract(operations.checkpoint_json, '$.writerAbsenceProof.retiredRuntimeEpoch')
                             = operations.runtime_epoch)
                        )
                   ))
                 OR (operations.kind <> 'stop' AND operations.phase = 'complete' AND ? = 'ready' AND EXISTS (
                 SELECT 1 FROM operation_checkpoints route_activated
                 WHERE route_activated.operation_id = operations.operation_id
                   AND route_activated.phase = 'route-activated'
                   AND route_activated.runtime_epoch = operations.runtime_epoch
               ) AND EXISTS (
                 SELECT 1 FROM deployment_revisions d JOIN artifacts a ON a.artifact_digest = d.artifact_digest
                 WHERE d.revision_id = operations.deployment_revision_id AND d.instance_id = operations.instance_id
                   AND d.repository_id = operations.repository_id AND d.status = 'admitted'
                   AND d.revision_id = ? AND d.artifact_digest = ? AND a.status = 'admitted'
               ))
               ))
               OR (? IS NULL AND operations.kind <> 'stop' AND operations.phase = 'route-activated'
                 AND ? = 'ready'
                 AND EXISTS (
                   SELECT 1 FROM operation_checkpoints route_activated
                   WHERE route_activated.operation_id = operations.operation_id
                     AND route_activated.phase = 'route-activated'
                     AND route_activated.runtime_epoch = operations.runtime_epoch
                 )
                 AND EXISTS (
                   SELECT 1 FROM logical_instances instance
                   WHERE instance.instance_id = operations.instance_id
                     AND json_type(operations.checkpoint_json, '$.writerAbsenceProof.instanceId') = 'text'
                     AND json_extract(operations.checkpoint_json, '$.writerAbsenceProof.instanceId') = operations.instance_id
                     AND json_type(operations.checkpoint_json, '$.writerAbsenceProof.repositoryId') = 'integer'
                     AND json_extract(operations.checkpoint_json, '$.writerAbsenceProof.repositoryId') = operations.repository_id
                     AND json_type(operations.checkpoint_json, '$.writerAbsenceProof.retiredRuntimeEpoch') IN ('integer', 'null')
                     AND json_type(operations.checkpoint_json, '$.writerAbsenceProof.providerObservationId') = 'text'
                     AND length(trim(json_extract(operations.checkpoint_json, '$.writerAbsenceProof.providerObservationId'))) > 0
                     AND json_type(operations.checkpoint_json, '$.writerAbsenceProof.censusObservedAt') = 'text'
                     AND length(trim(json_extract(operations.checkpoint_json, '$.writerAbsenceProof.censusObservedAt'))) > 0
                     AND json_type(operations.checkpoint_json, '$.writerAbsenceProof.remainingWriters') = 'integer'
                     AND json_extract(operations.checkpoint_json, '$.writerAbsenceProof.remainingWriters') = 0
                     AND json_extract(operations.checkpoint_json, '$.writerAbsenceProof.source') = 'runtime-provider-census'
                     AND (
                       (instance.observed_runtime_epoch < operations.runtime_epoch
                         AND (instance.observed_state NOT IN ('stopped', 'absent') OR EXISTS (
                           SELECT 1 FROM runtime_reservations old_reservation
                           WHERE old_reservation.instance_id = operations.instance_id
                             AND old_reservation.repository_id = operations.repository_id
                             AND old_reservation.runtime_epoch < operations.runtime_epoch
                             AND old_reservation.status IN ('reserved', 'allocated')
                         ))
                         AND json_type(operations.checkpoint_json, '$.writerAbsenceProof.retiredRuntimeEpoch') = 'integer'
                         AND json_extract(operations.checkpoint_json, '$.writerAbsenceProof.retiredRuntimeEpoch') = instance.observed_runtime_epoch)
                       OR (instance.observed_runtime_epoch IS NULL
                         AND NOT EXISTS (
                           SELECT 1 FROM runtime_reservations old_reservation
                           WHERE old_reservation.instance_id = operations.instance_id
                             AND old_reservation.repository_id = operations.repository_id
                             AND old_reservation.runtime_epoch < operations.runtime_epoch
                             AND old_reservation.status IN ('reserved', 'allocated')
                         )
                         AND json_type(operations.checkpoint_json, '$.writerAbsenceProof.retiredRuntimeEpoch') = 'null')
                       OR (instance.observed_state IN ('stopped', 'absent')
                         AND NOT EXISTS (
                           SELECT 1 FROM runtime_reservations old_reservation
                           WHERE old_reservation.instance_id = operations.instance_id
                             AND old_reservation.repository_id = operations.repository_id
                             AND old_reservation.runtime_epoch < operations.runtime_epoch
                             AND old_reservation.status IN ('reserved', 'allocated')
                         )
                         AND json_type(operations.checkpoint_json, '$.writerAbsenceProof.retiredRuntimeEpoch') = 'null')
                       OR (instance.observed_runtime_epoch = operations.runtime_epoch
                         AND (json_type(operations.checkpoint_json, '$.writerAbsenceProof.retiredRuntimeEpoch') = 'null'
                           OR (json_type(operations.checkpoint_json, '$.writerAbsenceProof.retiredRuntimeEpoch') = 'integer'
                             AND json_extract(operations.checkpoint_json, '$.writerAbsenceProof.retiredRuntimeEpoch') < operations.runtime_epoch)))
                     )
                 )
                 AND EXISTS (
                   SELECT 1 FROM deployment_revisions d JOIN artifacts a ON a.artifact_digest = d.artifact_digest
                   WHERE d.revision_id = operations.deployment_revision_id AND d.instance_id = operations.instance_id
                     AND d.repository_id = operations.repository_id AND d.status = 'admitted'
                     AND d.revision_id = ? AND d.artifact_digest = ? AND a.status = 'admitted'
                     AND json_extract(operations.checkpoint_json, '$.schemaVersion') = 1
                     AND json_extract(operations.checkpoint_json, '$.lifecycle.id') = operations.operation_id
                     AND json_extract(operations.checkpoint_json, '$.lifecycle.phase') = 'route-activated'
                     AND json_extract(operations.checkpoint_json, '$.lifecycle.instanceId') = operations.instance_id
                     AND json_type(operations.checkpoint_json, '$.lifecycle.repositoryId') = 'integer'
                     AND json_extract(operations.checkpoint_json, '$.lifecycle.repositoryId') = operations.repository_id
                     AND json_type(operations.checkpoint_json, '$.lifecycle.generation') = 'integer'
                     AND json_extract(operations.checkpoint_json, '$.lifecycle.generation') = operations.generation
                     AND json_extract(operations.checkpoint_json, '$.lifecycle.clusterId') = operations.cluster_id
                     AND json_type(operations.checkpoint_json, '$.lifecycle.runtimeEpoch') = 'integer'
                     AND json_extract(operations.checkpoint_json, '$.lifecycle.runtimeEpoch') = operations.runtime_epoch
                     AND json_type(operations.checkpoint_json, '$.lifecycle.targetEpoch') = 'integer'
                     AND json_extract(operations.checkpoint_json, '$.lifecycle.targetEpoch') = operations.runtime_epoch
                     AND json_type(operations.checkpoint_json, '$.lifecycle.rollbackEpoch') = 'null'
                     AND json_extract(operations.checkpoint_json, '$.lifecycle.target.revisionId') = d.revision_id
                     AND json_extract(operations.checkpoint_json, '$.lifecycle.target.imageDigest') = d.artifact_digest
                     AND json_extract(operations.checkpoint_json, '$.lifecycle.readinessEvidence.assignment.instanceId') = operations.instance_id
                     AND json_type(operations.checkpoint_json, '$.lifecycle.readinessEvidence.assignment.repositoryId') = 'integer'
                     AND json_extract(operations.checkpoint_json, '$.lifecycle.readinessEvidence.assignment.repositoryId') = operations.repository_id
                     AND json_type(operations.checkpoint_json, '$.lifecycle.readinessEvidence.assignment.generation') = 'integer'
                     AND json_extract(operations.checkpoint_json, '$.lifecycle.readinessEvidence.assignment.generation') = operations.generation
                     AND json_extract(operations.checkpoint_json, '$.lifecycle.readinessEvidence.assignment.clusterId') = operations.cluster_id
                     AND json_type(operations.checkpoint_json, '$.lifecycle.readinessEvidence.assignment.runtimeEpoch') = 'integer'
                     AND json_extract(operations.checkpoint_json, '$.lifecycle.readinessEvidence.assignment.runtimeEpoch') = operations.runtime_epoch
                     AND json_extract(operations.checkpoint_json, '$.lifecycle.readinessEvidence.assignment.deployment.revisionId') = d.revision_id
                     AND json_extract(operations.checkpoint_json, '$.lifecycle.readinessEvidence.assignment.deployment.imageDigest') = d.artifact_digest
                 )
               )
             )
           `,
        )
        .bind(
          status,
          phase,
          input.sequence,
          digest,
          resultJson,
          input.now,
          input.operationId,
          input.workerId,
          input.leaseToken,
          input.leaseEpoch,
          input.now,
          current.report_sequence,
          input.terminal,
          input.terminal,
          observation?.observedState ?? null,
          input.terminal,
          observation?.observedState ?? null,
          observation?.observedArtifactDigest ?? null,
          observation?.observedRevisionId ?? null,
          observation?.observedState ?? null,
          observation?.observedRevisionId ?? null,
          observation?.observedArtifactDigest ?? null,
          input.terminal,
          observation?.observedState ?? null,
          observation?.observedRevisionId ?? null,
          observation?.observedArtifactDigest ?? null,
        ),
      this.assertOneChange(),
    ];
    if (observation) {
      statements.push(
        this.db
          .prepare(
            `UPDATE logical_instances
           SET observed_generation = ?, observed_runtime_epoch = ?, observed_sequence = ?, observed_state = ?,
               runtime_authority_reservation_id = CASE WHEN ? = 'ready' THEN (
                 SELECT reservation_id FROM operations WHERE operation_id = ?
               ) ELSE NULL END,
               runtime_authority_operation_id = NULL,
               observed_revision_id = ?,
               current_artifact_digest = CASE
                 WHEN ? = 'ready' THEN ?
                 WHEN ? IN ('absent', 'stopped') THEN NULL
                 ELSE current_artifact_digest END,
               reservation_state = CASE WHEN ? = 'ready' THEN 'reserved' ELSE reservation_state END,
               updated_at = ?
           WHERE instance_id = ? AND repository_id = ? AND generation = ? AND runtime_epoch = ?
             AND (? <> 'ready' OR (
               runtime_authority_reservation_id = (SELECT reservation_id FROM operations WHERE operation_id = ?)
               AND (runtime_authority_operation_id IS NULL OR runtime_authority_operation_id = ?)
             ))
             AND (? > COALESCE(observed_runtime_epoch, -1)
                  OR (? = COALESCE(observed_runtime_epoch, -1) AND ? > observed_sequence))
             `,
          )
          .bind(
            observation.generation,
            observation.runtimeEpoch,
            observation.sequence,
            observation.observedState,
            observation.observedState,
            input.operationId,
            observation.observedRevisionId,
            observation.observedState,
            observation.observedArtifactDigest,
            observation.observedState,
            observation.observedState,
            input.now,
            observation.instanceId,
            observation.repositoryId,
            observation.generation,
            observation.runtimeEpoch,
            observation.observedState,
            input.operationId,
            input.operationId,
            observation.runtimeEpoch,
            observation.runtimeEpoch,
            observation.sequence,
          ),
        this.assertOneChange(),
      );
    }
    statements.push(
      this.db
        .prepare(
          `INSERT INTO audit_events (
             event_id, repository_id, instance_id, operation_id, actor_id, actor_kind,
             action, outcome, request_id, metadata_json, occurred_at
           ) SELECT ?, repository_id, instance_id, operation_id, ?, 'provisioner', 'operation.reported', ?, request_id, ?, ?
             FROM operations WHERE operation_id = ? AND report_sequence = ?`,
        )
        .bind(
          `operation.report:${input.operationId}:${input.leaseEpoch}:${input.sequence}`,
          input.workerId,
          status,
          JSON.stringify({
            phase,
            observationSequence: observation?.sequence ?? null,
            observedRuntimeEpoch: observation?.runtimeEpoch ?? null,
          }),
          input.now,
          input.operationId,
          input.sequence,
        ),
    );
    let results: readonly { readonly meta: { readonly changes: number } }[];
    try {
      results = await this.db.batch(statements);
    } catch (error) {
      if (isTransactionAssertion(error)) return null;
      throw error;
    }
    if (results[0]?.meta.changes !== 1) return null;
    const row = await this.db
      .prepare("SELECT * FROM operations WHERE operation_id = ?")
      .bind(input.operationId)
      .first<OperationRow>();
    if (!row) throw new Error("reported operation disappeared");
    return { operation: toOperation(row), applied: true, duplicate: false };
  }

  private async findSnapshot(
    where: string,
    value: number | string,
  ): Promise<RepositorySnapshot | null> {
    const row = await this.db
      .prepare(
        `SELECT
           b.repository_id AS b_repository_id, b.instance_id AS b_instance_id,
           b.installation_id, b.owner, b.name, b.authorization_revision, b.binding_epoch,
           b.suspended, b.created_at AS b_created_at, b.updated_at AS b_updated_at,
           i.*, current_reservation.cluster_id AS current_cluster_id
         FROM repository_bindings b JOIN logical_instances i ON i.instance_id = b.instance_id
         LEFT JOIN runtime_reservations current_reservation
           ON current_reservation.instance_id = i.instance_id
          AND current_reservation.runtime_epoch = i.observed_runtime_epoch
          AND current_reservation.status IN ('reserved', 'allocated')
         WHERE ${where} LIMIT 1`,
      )
      .bind(value)
      .first<BindingInstanceRow>();
    if (!row) return null;
    return { binding: toBinding(row), instance: toInstance(row) };
  }

  private async findBinding(repositoryId: number): Promise<RepositoryBinding | null> {
    const row = await this.db
      .prepare("SELECT * FROM repository_bindings WHERE repository_id = ?")
      .bind(repositoryId)
      .first<BindingRow>();
    return row ? toBinding(row) : null;
  }
}

interface BindingInstanceRow extends BindingRow, InstanceRow {
  b_repository_id: number;
  b_instance_id: string;
  b_created_at: number;
  b_updated_at: number;
}

function toBinding(row: BindingRow | BindingInstanceRow): RepositoryBinding {
  const source =
    "b_repository_id" in row
      ? {
          repository_id: row.b_repository_id,
          instance_id: row.b_instance_id,
          created_at: row.b_created_at,
          updated_at: row.b_updated_at,
        }
      : row;
  return {
    repositoryId: source.repository_id,
    instanceId: source.instance_id,
    appIdentity: "scriptorium",
    installationId: row.installation_id,
    owner: row.owner,
    name: row.name,
    authorizationRevision: row.authorization_revision,
    bindingEpoch: row.binding_epoch,
    suspended: row.suspended === 1,
  };
}

function toInstance(row: InstanceRow): InstanceSnapshot {
  const logical: LogicalInstance = {
    instanceId: row.instance_id,
    repositoryId: row.repository_id,
    generation: row.generation,
    runtimeEpoch: row.runtime_epoch,
    desiredState: row.desired_state,
    policy: row.policy,
    observedGeneration: row.observed_generation,
    currentArtifactDigest: row.current_artifact_digest,
    desiredArtifactDigest: row.desired_artifact_digest,
  };
  return {
    ...logical,
    observedState: row.observed_state,
    observedRuntimeEpoch: row.observed_runtime_epoch,
    observedSequence: row.observed_sequence,
    legacyRuntimeEpoch: row.legacy_runtime_epoch ?? null,
    desiredRevisionId: row.desired_revision_id,
    observedRevisionId: row.observed_revision_id,
    reservationState: row.reservation_state,
    reservationId: row.reservation_id,
    clusterId: row.current_cluster_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toOperation(row: OperationRow): OperationRecord {
  return {
    id: row.operation_id,
    instanceId: row.instance_id,
    generation: row.generation,
    runtimeEpoch: row.runtime_epoch,
    kind: row.kind,
    status: row.status,
    attempt: row.attempt,
    leaseEpoch: row.lease_epoch,
    reportSequence: row.report_sequence,
    leaseExpiresAt: row.lease_expires_at,
    repositoryId: row.repository_id,
    clusterId: row.cluster_id,
    reservationId: row.reservation_id,
    deploymentRevisionId: row.deployment_revision_id,
    buildId: row.build_id,
    prerequisiteBuildId: row.prerequisite_build_id,
    idempotencyKey: row.idempotency_key,
    phase: row.phase,
    workerId: row.worker_id,
    leaseToken: row.lease_token,
    checkpointSequence: row.checkpoint_sequence,
    checkpoint: parseObject(row.checkpoint_json),
    result: parseObject(row.result_json),
    requestHash: row.request_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseObject(value: string | null): Readonly<Record<string, unknown>> | null {
  if (value === null) return null;
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("stored JSON value is not an object");
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function toReservation(row: ReservationRow): RuntimeReservation {
  return {
    reservationId: row.reservation_id,
    instanceId: row.instance_id,
    repositoryId: row.repository_id,
    runtimeEpoch: row.runtime_epoch,
    generation: row.generation,
    clusterId: row.cluster_id,
    status: row.status,
    capacitySnapshotEpoch: row.capacity_snapshot_epoch,
    resources: {
      cpuMilli: row.cpu_milli,
      memoryMiB: row.memory_mib,
      ephemeralStorageMiB: row.ephemeral_storage_mib,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toCapacitySnapshot(row: CapacitySnapshotRow): CapacityResourceSnapshot {
  return {
    allocatable: {
      cpuMilli: row.allocatable_cpu_milli,
      memoryMiB: row.allocatable_memory_mib,
      ephemeralStorageMiB: row.allocatable_ephemeral_storage_mib,
    },
    requested: {
      cpuMilli: row.requested_cpu_milli,
      memoryMiB: row.requested_memory_mib,
      ephemeralStorageMiB: row.requested_ephemeral_storage_mib,
    },
    nodeResourceVersion: row.node_resource_version,
    podResourceVersion: row.pod_resource_version,
  };
}

function toRevisionSummary(
  row: RevisionRow,
  artifactRow: ArtifactRow | null = null,
): NonNullable<ClaimedOperation["deploymentRevision"]> {
  return {
    revisionId: row.revision_id,
    instanceId: row.instance_id,
    repositoryId: row.repository_id,
    generation: row.generation,
    buildKey: row.build_key,
    buildId: row.build_id,
    selection: parseObject(row.selection_json) ?? {},
    resources: resourceRequirementsFromJson(row.resource_requirements_json),
    runtimeMetadata: RuntimeMetadataSchema.parse(JSON.parse(row.runtime_metadata_json)),
    artifactDigest: row.artifact_digest,
    status: row.status,
    artifact: artifactRow ? toArtifactSummary(artifactRow) : null,
  };
}

function toArtifactSummary(
  row: ArtifactRow,
): NonNullable<NonNullable<ClaimedOperation["deploymentRevision"]>["artifact"]> {
  const requestedModules = parseStringArray(row.requested_modules_json);
  const resolvedModules: unknown = JSON.parse(row.resolved_modules_json);
  if (
    !Array.isArray(resolvedModules) ||
    resolvedModules.some(
      (entry) => entry === null || typeof entry !== "object" || Array.isArray(entry),
    )
  ) {
    throw new Error("stored resolved modules are invalid");
  }
  return {
    artifactDigest: row.artifact_digest,
    manifestDigest: row.manifest_digest,
    platformManifestDigest: row.platform_manifest_digest,
    compositionManifestDigest: row.composition_manifest_digest,
    producerRevision: row.producer_revision,
    requestedModules,
    resolvedModules: resolvedModules as readonly Readonly<Record<string, unknown>>[],
    contractVersions: parseObject(row.contract_versions_json) ?? {},
    sbomRef: row.sbom_ref,
    provenanceRef: row.provenance_ref,
    verification: parseObject(row.verification_json) ?? {},
    statement: parseObject(row.statement_json) ?? {},
    signature: parseObject(row.signature_json) ?? {},
    verifierId: row.verifier_id,
    admittedAt: row.admitted_at,
  };
}

function resourceRequirementsFromJson(value: string): ResourceRequirements {
  const parsed = parseObject(value);
  if (
    typeof parsed?.cpuMilli !== "number" ||
    typeof parsed.memoryMiB !== "number" ||
    typeof parsed.ephemeralStorageMiB !== "number"
  ) {
    throw new Error("stored resource requirements are invalid");
  }
  return {
    cpuMilli: parsed.cpuMilli,
    memoryMiB: parsed.memoryMiB,
    ephemeralStorageMiB: parsed.ephemeralStorageMiB,
  };
}

function parseStringArray(value: string): readonly string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error("stored reservation ID list is invalid");
  }
  return parsed;
}

function encodeBoundedObject(value: Readonly<Record<string, unknown>>, maxBytes: number): string {
  const encoded = JSON.stringify(value);
  if (new TextEncoder().encode(encoded).byteLength > maxBytes) {
    throw new TypeError(`checkpoint exceeds ${maxBytes} bytes`);
  }
  return encoded;
}

function isTransactionAssertion(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("platform_transaction_sentinel");
}

async function digestJson(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export type { D1PreparedStatement };
