import { OperationFenceConflict } from "@praetorium/application/operations";
import type { OperationRecord } from "@praetorium/application/instances";
import type { D1Database } from "@praetorium/persistence/d1";

function checkpointProofPredicate(checkpoint: string, instance: string, nowSlot: string): string {
  const proof = `${checkpoint}.checkpoint_json`;
  const path = (field: string) => `$.writerAbsenceProof.${field}`;
  return `
    json_extract(${proof}, '$.schemaVersion') = 1
    AND json_extract(${proof}, '${path("instanceId")}') = ${instance}.instance_id
    AND json_extract(${proof}, '${path("repositoryId")}') = ${instance}.repository_id
    AND json_extract(${proof}, '${path("source")}') = 'runtime-provider-census'
    AND json_type(${proof}, '${path("remainingWriters")}') = 'integer'
    AND json_extract(${proof}, '${path("remainingWriters")}') = 0
    AND json_type(${proof}, '${path("providerObservationId")}') = 'text'
    AND length(json_extract(${proof}, '${path("providerObservationId")}')) BETWEEN 1 AND 512
    AND json_type(${proof}, '${path("censusObservedAt")}') = 'text'
    AND julianday(json_extract(${proof}, '${path("censusObservedAt")}')) IS NOT NULL
    AND julianday(json_extract(${proof}, '${path("censusObservedAt")}')) <= julianday(${nowSlot})
    AND json_type(${proof}, '${path("evidenceIdentities")}') = 'array'
    AND NOT EXISTS (
      SELECT 1 FROM json_each(${proof}, '${path("evidenceIdentities")}') evidence_identity
      WHERE evidence_identity.type <> 'text' OR length(evidence_identity.value) > 512
    )
    AND json_type(${proof}, '${path("retiredRuntimeEpoch")}') IN ('integer', 'null')
    AND (
      json_type(${proof}, '${path("retiredRuntimeEpoch")}') = 'null'
      OR abs(json_extract(${proof}, '${path("retiredRuntimeEpoch")}')) <= 9007199254740991
    )
  `;
}

function sameWriterAbsenceProof(left: string, right: string): string {
  const fields = [
    "instanceId",
    "repositoryId",
    "retiredRuntimeEpoch",
    "providerObservationId",
    "censusObservedAt",
    "remainingWriters",
    "evidenceIdentities",
    "source",
  ];
  return fields
    .map(
      (field) =>
        `json_extract(${left}.checkpoint_json, '$.writerAbsenceProof.${field}') IS json_extract(${right}.checkpoint_json, '$.writerAbsenceProof.${field}')`,
    )
    .join(" AND ");
}

/** Resolve historical evidence only when publishing a fenced authority transition.
 * Ordinary authentication reads the durable current grant instead.
 */
export async function publishRuntimeAuthority(
  db: D1Database,
  operation: OperationRecord,
  now: number,
): Promise<boolean> {
  const nowText = new Date(now).toISOString();
  const expectedAuthority =
    operation.phase === "accepted" ? "observed-writer" : "post-absence-target";
  const published = await db
    .prepare(
      `WITH candidates AS (
             SELECT
               0 AS priority, 'post-absence-target' AS authority,
               b.repository_id, b.installation_id, i.instance_id, i.legacy_runtime_epoch,
               r.reservation_id AS runtime_id, r.runtime_epoch,
               r.reservation_id AS lease_id, r.cluster_id,
               i.observed_state, i.observed_runtime_epoch,
               o.phase AS operation_phase,
               latest.checkpoint_json AS checkpoint_json,
               absence.checkpoint_json AS absence_checkpoint_json
             FROM repository_bindings b
             JOIN logical_instances i ON i.instance_id = b.instance_id
             JOIN operations o ON o.instance_id = i.instance_id
               AND o.repository_id = i.repository_id
             JOIN runtime_reservations r ON r.reservation_id = o.reservation_id
               AND r.instance_id = i.instance_id AND r.repository_id = i.repository_id
               AND r.runtime_epoch = o.runtime_epoch
             JOIN operation_checkpoints latest ON latest.operation_id = o.operation_id
               AND latest.sequence = o.checkpoint_sequence
               AND latest.runtime_epoch = o.runtime_epoch
             JOIN operation_checkpoints absence ON absence.operation_id = o.operation_id
               AND absence.phase = 'old-writer-absent'
               AND absence.runtime_epoch = o.runtime_epoch
               AND absence.sequence <= latest.sequence
             WHERE b.repository_id = ? AND b.suspended = 0
               AND o.kind IN ('start', 'redeploy', 'update')
               AND o.status IN ('claimed', 'running')
               AND o.lease_expires_at > ?
               AND o.phase IN ('old-writer-absent', 'starting-target', 'target-ready', 'route-activated', 'complete')
               AND latest.phase = o.phase
               AND latest.checkpoint_json = o.checkpoint_json
               AND o.generation = i.generation AND o.runtime_epoch = i.runtime_epoch
               AND o.runtime_epoch > COALESCE(i.observed_runtime_epoch, 0)
               AND (
                 (i.observed_state = 'ready' AND json_extract(latest.checkpoint_json, '$.writerAbsenceProof.retiredRuntimeEpoch') = i.observed_runtime_epoch)
                 OR (i.observed_state IN ('absent', 'stopped') AND (
                   json_extract(latest.checkpoint_json, '$.writerAbsenceProof.retiredRuntimeEpoch') IS NULL
                   OR json_extract(latest.checkpoint_json, '$.writerAbsenceProof.retiredRuntimeEpoch') = i.observed_runtime_epoch
                 ))
               )
               AND (
                 json_extract(latest.checkpoint_json, '$.writerAbsenceProof.retiredRuntimeEpoch') IS NULL
                 OR NOT EXISTS (
                   SELECT 1 FROM runtime_git_credentials pending_credential
                   WHERE pending_credential.repository_id = b.repository_id
                     AND (pending_credential.instance_id = i.instance_id OR pending_credential.instance_id = 'run_' || substr(i.instance_id, 5) || '_' || pending_credential.runtime_epoch)
                     AND pending_credential.runtime_epoch = json_extract(latest.checkpoint_json, '$.writerAbsenceProof.retiredRuntimeEpoch')
                     AND pending_credential.status IN ('active', 'revocation_pending')
                     AND pending_credential.expires_at > ?
                 )
               )
               AND o.cluster_id IS NOT NULL AND r.cluster_id = o.cluster_id
               AND i.reservation_id = r.reservation_id
               AND r.status IN ('reserved', 'allocated')
               AND ${checkpointProofPredicate("latest", "i", "?")}
               AND ${checkpointProofPredicate("absence", "i", "?")}
               AND ${sameWriterAbsenceProof("latest", "absence")}
             UNION ALL
             SELECT
               1 AS priority, 'observed-writer' AS authority,
               b.repository_id, b.installation_id, i.instance_id, i.legacy_runtime_epoch,
               r.reservation_id AS runtime_id, r.runtime_epoch,
               r.reservation_id AS lease_id, r.cluster_id,
               i.observed_state, i.observed_runtime_epoch,
               NULL AS operation_phase,
               NULL AS checkpoint_json, NULL AS absence_checkpoint_json
             FROM repository_bindings b
             JOIN logical_instances i ON i.instance_id = b.instance_id
             JOIN runtime_reservations r ON r.instance_id = i.instance_id
               AND r.repository_id = i.repository_id
               AND r.runtime_epoch = i.observed_runtime_epoch
             WHERE b.repository_id = ? AND b.suspended = 0
               AND i.observed_state = 'ready'
               AND i.observed_runtime_epoch IS NOT NULL
               AND i.observed_revision_id IS NOT NULL
               AND i.current_artifact_digest IS NOT NULL
               AND r.status IN ('reserved', 'allocated')
               AND r.cluster_id IS NOT NULL
               AND NOT EXISTS (
                 SELECT 1 FROM operations retirement_operation
                 JOIN operation_checkpoints retirement_checkpoint
                   ON retirement_checkpoint.operation_id = retirement_operation.operation_id
                 WHERE retirement_operation.instance_id = i.instance_id
                   AND retirement_operation.repository_id = i.repository_id
                   AND retirement_checkpoint.phase IN ('quiescing-old', 'old-quiesced', 'stopping-old')
                   AND json_extract(retirement_checkpoint.checkpoint_json, '$.lifecycle.quiesceRequest.instanceId') = i.instance_id
                   AND json_extract(retirement_checkpoint.checkpoint_json, '$.lifecycle.quiesceRequest.runtimeEpoch') = i.observed_runtime_epoch
                   AND NOT EXISTS (
                     SELECT 1 FROM operation_checkpoints confirmed_resume
                     WHERE confirmed_resume.operation_id = retirement_checkpoint.operation_id
                       AND confirmed_resume.sequence > retirement_checkpoint.sequence
                       AND confirmed_resume.phase = 'accepted'
                       AND json_type(confirmed_resume.checkpoint_json, '$.lifecycle.quiesceRequest') = 'null'
                       AND json_type(confirmed_resume.checkpoint_json, '$.lifecycle.quiesceReceipt') = 'null'
                       AND NOT EXISTS (
                         SELECT 1 FROM operation_checkpoints retried_retirement
                         WHERE retried_retirement.operation_id = confirmed_resume.operation_id
                           AND retried_retirement.sequence > confirmed_resume.sequence
                           AND retried_retirement.phase IN ('quiescing-old', 'old-quiesced', 'stopping-old')
                           AND json_extract(retried_retirement.checkpoint_json, '$.lifecycle.quiesceRequest.instanceId') = i.instance_id
                           AND json_extract(retried_retirement.checkpoint_json, '$.lifecycle.quiesceRequest.runtimeEpoch') = i.observed_runtime_epoch
                       )
                   )
               )
               AND NOT EXISTS (
                 SELECT 1 FROM operations retired
                 JOIN operation_checkpoints retired_latest
                   ON retired_latest.operation_id = retired.operation_id
                   AND retired_latest.sequence = retired.checkpoint_sequence
                 JOIN operation_checkpoints retired_absence
                   ON retired_absence.operation_id = retired.operation_id
                   AND retired_absence.phase = 'old-writer-absent'
                   AND retired_absence.runtime_epoch = retired.runtime_epoch
                   AND retired_absence.sequence <= retired_latest.sequence
                 WHERE retired.instance_id = i.instance_id
                   AND retired.repository_id = i.repository_id
                   AND ${checkpointProofPredicate("retired_latest", "i", "?")}
                   AND retired_latest.checkpoint_json = retired.checkpoint_json
                   AND ${sameWriterAbsenceProof("retired_latest", "retired_absence")}
                   AND json_extract(retired_latest.checkpoint_json, '$.writerAbsenceProof.retiredRuntimeEpoch') = i.observed_runtime_epoch
               )
           )
           UPDATE logical_instances
           SET runtime_authority_reservation_id = (
                 SELECT lease_id FROM candidates candidate WHERE authority = ?
                   AND (authority <> 'observed-writer' OR NOT EXISTS (
                     SELECT 1 FROM operations retired
                     JOIN operation_checkpoints absence ON absence.operation_id = retired.operation_id
                     WHERE retired.instance_id = candidate.instance_id
                       AND retired.repository_id = candidate.repository_id
                       AND absence.phase = 'old-writer-absent'
                       AND json_extract(absence.checkpoint_json, '$.writerAbsenceProof.retiredRuntimeEpoch') = candidate.runtime_epoch
                   ))
                 ORDER BY priority LIMIT 1),
               runtime_authority_operation_id = CASE WHEN ? = 'post-absence-target' AND EXISTS (
                 SELECT 1 FROM candidates WHERE authority = 'post-absence-target') THEN ? ELSE NULL END
           WHERE instance_id = ? AND repository_id = ? AND EXISTS (
             SELECT 1 FROM operations fence
             WHERE fence.operation_id = ? AND fence.instance_id = logical_instances.instance_id
               AND fence.repository_id = logical_instances.repository_id
               AND fence.worker_id = ? AND fence.lease_token = ? AND fence.lease_epoch = ?
               AND fence.lease_expires_at > ? AND fence.status IN ('claimed', 'running')
               AND fence.checkpoint_sequence = ? AND fence.phase = ?
           )
           RETURNING runtime_authority_reservation_id, runtime_authority_operation_id`,
    )
    .bind(
      operation.repositoryId,
      now,
      now,
      nowText,
      nowText,
      operation.repositoryId,
      nowText,
      expectedAuthority,
      expectedAuthority,
      operation.id,
      operation.instanceId,
      operation.repositoryId,
      operation.id,
      operation.workerId,
      operation.leaseToken,
      operation.leaseEpoch,
      now,
      operation.checkpointSequence,
      operation.phase,
    )
    .first<{
      runtime_authority_reservation_id: string | null;
      runtime_authority_operation_id: string | null;
    }>();
  if (!published) throw new OperationFenceConflict("runtime authority publication lease is stale");
  // An accepted checkpoint may start with no observed writer. It can restore
  // only a proven observed grant; a resumed unobserved rollback target stays
  // fenced until a fresh absence/recovery transition admits it.
  return (
    operation.phase !== "old-writer-absent" ||
    operation.kind === "stop" ||
    (published.runtime_authority_reservation_id !== null &&
      published.runtime_authority_operation_id === operation.id)
  );
}
