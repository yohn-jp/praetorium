import type { RuntimeAuthorityRecoveryEvidence } from "@praetorium/application/lifecycle";
import { OperationFenceConflict, type OperationService } from "@praetorium/application/operations";
import type { D1Database } from "@praetorium/persistence/d1";
import { publishRuntimeAuthority } from "./runtime-authority-transition.js";

const MAX_CENSUS_AGE_MS = 30_000;
const RECOVERABLE_PHASES = new Set(["starting-target", "target-ready", "route-activated"]);
const RECOVERABLE_KINDS = new Set(["start", "redeploy", "update"]);

export interface RuntimeAuthorityRecoveryInput {
  readonly operationId: string;
  readonly workerId: string;
  readonly leaseToken: string;
  readonly leaseEpoch: number;
  readonly expectedCheckpointSequence: number;
  readonly evidence: RuntimeAuthorityRecoveryEvidence;
  readonly now: number;
}

/** Restores only a target grant from an already persisted, canonical old-writer absence proof. */
export function createRuntimeAuthorityRecovery(input: {
  readonly db: D1Database;
  readonly operations: OperationService;
}): (request: RuntimeAuthorityRecoveryInput) => Promise<boolean> {
  return async (request) => {
    const { evidence, now } = request;
    const observedAt = Date.parse(evidence.census.observedAt);
    const identities = evidence.census.writers.flatMap((writer) => writer.identities);
    if (
      !Number.isFinite(observedAt) || observedAt > now || now - observedAt > MAX_CENSUS_AGE_MS ||
      !evidence.census.complete || evidence.census.matchedWriterCount !== 1 ||
      evidence.census.writers.length !== 1 || evidence.census.writers[0]?.runtimeEpoch !== evidence.runtimeEpoch ||
      evidence.census.writers[0]?.phase !== "running" || identities.length === 0 ||
      identities.some((identity) => identity.trim().length === 0) ||
      new Set(identities).size !== identities.length
    ) return false;

    const operation = await input.operations.getById(request.operationId);
    if (
      !operation || !RECOVERABLE_KINDS.has(operation.kind) || !RECOVERABLE_PHASES.has(operation.phase) ||
      operation.id !== request.operationId || operation.workerId !== request.workerId ||
      operation.leaseToken !== request.leaseToken || operation.leaseEpoch !== request.leaseEpoch ||
      operation.leaseExpiresAt === null || operation.leaseExpiresAt <= now ||
      operation.checkpointSequence !== request.expectedCheckpointSequence ||
      operation.status !== "claimed" && operation.status !== "running" ||
      operation.clusterId !== evidence.clusterId || operation.reservationId !== evidence.reservationId ||
      operation.generation !== evidence.generation || operation.runtimeEpoch !== evidence.runtimeEpoch
    ) return false;

    const target = await input.db.prepare(
      `SELECT i.instance_id, i.repository_id, i.generation, i.runtime_epoch, i.desired_state,
              i.desired_revision_id, i.desired_artifact_digest, i.reservation_id,
              b.suspended, r.cluster_id, r.status AS reservation_status,
              d.status AS revision_status, d.artifact_digest, a.platform_manifest_digest,
              i.runtime_authority_reservation_id, i.runtime_authority_operation_id
       FROM logical_instances i
       JOIN repository_bindings b ON b.instance_id = i.instance_id AND b.repository_id = i.repository_id
       JOIN runtime_reservations r ON r.reservation_id = i.reservation_id
         AND r.instance_id = i.instance_id AND r.repository_id = i.repository_id
       JOIN deployment_revisions d ON d.revision_id = i.desired_revision_id
         AND d.instance_id = i.instance_id AND d.repository_id = i.repository_id
       JOIN artifacts a ON a.artifact_digest = d.artifact_digest AND a.status = 'admitted'
       WHERE i.instance_id = ? AND i.repository_id = ?`,
    ).bind(evidence.instanceId, evidence.repositoryId).first<{
      instance_id: string;
      repository_id: number;
      generation: number;
      runtime_epoch: number;
      desired_state: string;
      desired_revision_id: string | null;
      desired_artifact_digest: string | null;
      reservation_id: string | null;
      suspended: number;
      cluster_id: string;
      reservation_status: string;
      revision_status: string;
      artifact_digest: string | null;
      platform_manifest_digest: string;
      runtime_authority_reservation_id: string | null;
      runtime_authority_operation_id: string | null;
    }>();
    if (
      !target || target.suspended !== 0 || target.desired_state !== "running" ||
      target.instance_id !== operation.instanceId || target.repository_id !== operation.repositoryId ||
      target.generation !== evidence.generation || target.runtime_epoch !== evidence.runtimeEpoch ||
      target.reservation_id !== evidence.reservationId || target.cluster_id !== evidence.clusterId ||
      !["reserved", "allocated"].includes(target.reservation_status) ||
      target.revision_status !== "admitted" || !target.artifact_digest ||
      target.desired_artifact_digest !== target.artifact_digest ||
      target.platform_manifest_digest !== evidence.actualImageDigest ||
      operation.deploymentRevisionId !== target.desired_revision_id ||
      operation.checkpoint === null
    ) return false;

    // Do not overwrite a grant belonging to another operation. A replay of this
    // recovery is allowed and the publisher remains the sole authority writer.
    const authorityAbsent = target.runtime_authority_reservation_id === null &&
      target.runtime_authority_operation_id === null;
    const alreadyRecovered = target.runtime_authority_reservation_id === evidence.reservationId &&
      target.runtime_authority_operation_id === operation.id;
    if (!authorityAbsent && !alreadyRecovered) return false;

    const eventId = `runtime-authority-recovery:${operation.id}:${evidence.census.providerObservationId}`;
    const metadata = JSON.stringify({
      instanceId: evidence.instanceId,
      repositoryId: evidence.repositoryId,
      generation: evidence.generation,
      runtimeEpoch: evidence.runtimeEpoch,
      clusterId: evidence.clusterId,
      reservationId: evidence.reservationId,
      actualImageDigest: evidence.actualImageDigest,
      imageIdentityVerified: true,
      census: evidence.census,
      evidenceAdmitted: true,
    });
    await input.db.prepare(
      `INSERT OR IGNORE INTO audit_events (
         event_id, repository_id, instance_id, operation_id, actor_id, actor_kind,
         action, outcome, metadata_json, occurred_at
       ) VALUES (?, ?, ?, ?, ?, 'system', 'runtime.authority.recovery-evidence-admitted', 'recorded', ?, ?)`,
    ).bind(eventId, operation.repositoryId, operation.instanceId, operation.id, `runtime-authority-recovery:${operation.id}`, metadata, now).run();
    const audit = await input.db.prepare(
      "SELECT metadata_json FROM audit_events WHERE event_id = ?",
    ).bind(eventId).first<{ metadata_json: string }>();
    if (audit?.metadata_json !== metadata) return false;

    try {
      await publishRuntimeAuthority(input.db, operation, now);
    } catch (error) {
      if (error instanceof OperationFenceConflict) return false;
      throw error;
    }
    const published = await input.db.prepare(
      `SELECT runtime_authority_reservation_id, runtime_authority_operation_id
       FROM logical_instances WHERE instance_id = ? AND repository_id = ?`,
    ).bind(operation.instanceId, operation.repositoryId).first<{
      runtime_authority_reservation_id: string | null;
      runtime_authority_operation_id: string | null;
    }>();
    return published?.runtime_authority_reservation_id === operation.reservationId &&
      published.runtime_authority_operation_id === operation.id;
  };
}
