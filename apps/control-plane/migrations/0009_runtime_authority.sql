-- Current runtime authority lives on the existing logical instance. Historical
-- checkpoints remain evidence; ordinary authentication does not reconstruct them.
ALTER TABLE logical_instances ADD COLUMN runtime_authority_reservation_id TEXT NULL
  REFERENCES runtime_reservations(reservation_id);
ALTER TABLE logical_instances ADD COLUMN runtime_authority_operation_id TEXT NULL
  REFERENCES operations(operation_id);

-- One-time, fail-closed admission of existing observed writers and live targets.
-- Apply the same evidence, retirement and lease checks as transition publication,
-- so a migration does not strand an already-fenced in-flight lifecycle operation.
WITH candidates AS (
             SELECT
               0 AS priority, 'post-absence-target' AS authority, o.operation_id AS authority_operation_id,
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
             WHERE b.suspended = 0
               AND o.kind IN ('start', 'redeploy', 'update')
               AND o.status IN ('claimed', 'running')
               AND o.lease_expires_at > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
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
                     AND pending_credential.expires_at > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
                 )
               )
               AND o.cluster_id IS NOT NULL AND r.cluster_id = o.cluster_id
               AND i.reservation_id = r.reservation_id
               AND r.status IN ('reserved', 'allocated')
               AND 
    json_extract(latest.checkpoint_json, '$.schemaVersion') = 1
    AND json_extract(latest.checkpoint_json, '$.writerAbsenceProof.instanceId') = i.instance_id
    AND json_extract(latest.checkpoint_json, '$.writerAbsenceProof.repositoryId') = i.repository_id
    AND json_extract(latest.checkpoint_json, '$.writerAbsenceProof.source') = 'runtime-provider-census'
    AND json_type(latest.checkpoint_json, '$.writerAbsenceProof.remainingWriters') = 'integer'
    AND json_extract(latest.checkpoint_json, '$.writerAbsenceProof.remainingWriters') = 0
    AND json_type(latest.checkpoint_json, '$.writerAbsenceProof.providerObservationId') = 'text'
    AND length(json_extract(latest.checkpoint_json, '$.writerAbsenceProof.providerObservationId')) BETWEEN 1 AND 512
    AND json_type(latest.checkpoint_json, '$.writerAbsenceProof.censusObservedAt') = 'text'
    AND julianday(json_extract(latest.checkpoint_json, '$.writerAbsenceProof.censusObservedAt')) IS NOT NULL
    AND julianday(json_extract(latest.checkpoint_json, '$.writerAbsenceProof.censusObservedAt')) <= julianday(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    AND json_type(latest.checkpoint_json, '$.writerAbsenceProof.evidenceIdentities') = 'array'
    AND NOT EXISTS (
      SELECT 1 FROM json_each(latest.checkpoint_json, '$.writerAbsenceProof.evidenceIdentities') evidence_identity
      WHERE evidence_identity.type <> 'text' OR length(evidence_identity.value) > 512
    )
    AND json_type(latest.checkpoint_json, '$.writerAbsenceProof.retiredRuntimeEpoch') IN ('integer', 'null')
    AND (
      json_type(latest.checkpoint_json, '$.writerAbsenceProof.retiredRuntimeEpoch') = 'null'
      OR abs(json_extract(latest.checkpoint_json, '$.writerAbsenceProof.retiredRuntimeEpoch')) <= 9007199254740991
    )
  
               AND 
    json_extract(absence.checkpoint_json, '$.schemaVersion') = 1
    AND json_extract(absence.checkpoint_json, '$.writerAbsenceProof.instanceId') = i.instance_id
    AND json_extract(absence.checkpoint_json, '$.writerAbsenceProof.repositoryId') = i.repository_id
    AND json_extract(absence.checkpoint_json, '$.writerAbsenceProof.source') = 'runtime-provider-census'
    AND json_type(absence.checkpoint_json, '$.writerAbsenceProof.remainingWriters') = 'integer'
    AND json_extract(absence.checkpoint_json, '$.writerAbsenceProof.remainingWriters') = 0
    AND json_type(absence.checkpoint_json, '$.writerAbsenceProof.providerObservationId') = 'text'
    AND length(json_extract(absence.checkpoint_json, '$.writerAbsenceProof.providerObservationId')) BETWEEN 1 AND 512
    AND json_type(absence.checkpoint_json, '$.writerAbsenceProof.censusObservedAt') = 'text'
    AND julianday(json_extract(absence.checkpoint_json, '$.writerAbsenceProof.censusObservedAt')) IS NOT NULL
    AND julianday(json_extract(absence.checkpoint_json, '$.writerAbsenceProof.censusObservedAt')) <= julianday(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    AND json_type(absence.checkpoint_json, '$.writerAbsenceProof.evidenceIdentities') = 'array'
    AND NOT EXISTS (
      SELECT 1 FROM json_each(absence.checkpoint_json, '$.writerAbsenceProof.evidenceIdentities') evidence_identity
      WHERE evidence_identity.type <> 'text' OR length(evidence_identity.value) > 512
    )
    AND json_type(absence.checkpoint_json, '$.writerAbsenceProof.retiredRuntimeEpoch') IN ('integer', 'null')
    AND (
      json_type(absence.checkpoint_json, '$.writerAbsenceProof.retiredRuntimeEpoch') = 'null'
      OR abs(json_extract(absence.checkpoint_json, '$.writerAbsenceProof.retiredRuntimeEpoch')) <= 9007199254740991
    )
  
               AND json_extract(latest.checkpoint_json, '$.writerAbsenceProof.instanceId') IS json_extract(absence.checkpoint_json, '$.writerAbsenceProof.instanceId') AND json_extract(latest.checkpoint_json, '$.writerAbsenceProof.repositoryId') IS json_extract(absence.checkpoint_json, '$.writerAbsenceProof.repositoryId') AND json_extract(latest.checkpoint_json, '$.writerAbsenceProof.retiredRuntimeEpoch') IS json_extract(absence.checkpoint_json, '$.writerAbsenceProof.retiredRuntimeEpoch') AND json_extract(latest.checkpoint_json, '$.writerAbsenceProof.providerObservationId') IS json_extract(absence.checkpoint_json, '$.writerAbsenceProof.providerObservationId') AND json_extract(latest.checkpoint_json, '$.writerAbsenceProof.censusObservedAt') IS json_extract(absence.checkpoint_json, '$.writerAbsenceProof.censusObservedAt') AND json_extract(latest.checkpoint_json, '$.writerAbsenceProof.remainingWriters') IS json_extract(absence.checkpoint_json, '$.writerAbsenceProof.remainingWriters') AND json_extract(latest.checkpoint_json, '$.writerAbsenceProof.evidenceIdentities') IS json_extract(absence.checkpoint_json, '$.writerAbsenceProof.evidenceIdentities') AND json_extract(latest.checkpoint_json, '$.writerAbsenceProof.source') IS json_extract(absence.checkpoint_json, '$.writerAbsenceProof.source')
             UNION ALL
             SELECT
               1 AS priority, 'observed-writer' AS authority, NULL AS authority_operation_id,
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
             WHERE b.suspended = 0
               AND i.observed_state = 'ready'
               AND i.observed_runtime_epoch IS NOT NULL
               AND i.observed_revision_id IS NOT NULL
               AND i.current_artifact_digest IS NOT NULL
               AND r.status IN ('reserved', 'allocated')
               AND r.cluster_id IS NOT NULL
               AND NOT EXISTS (
                 SELECT 1 FROM operations permanently_retired
                 JOIN operation_checkpoints permanent_absence ON permanent_absence.operation_id = permanently_retired.operation_id
                 WHERE permanently_retired.instance_id = i.instance_id
                   AND permanently_retired.repository_id = i.repository_id
                   AND permanent_absence.phase = 'old-writer-absent'
                   AND json_extract(permanent_absence.checkpoint_json, '$.writerAbsenceProof.instanceId') = i.instance_id
                   AND json_extract(permanent_absence.checkpoint_json, '$.writerAbsenceProof.retiredRuntimeEpoch') = i.observed_runtime_epoch
               )
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
                   AND 
    json_extract(retired_latest.checkpoint_json, '$.schemaVersion') = 1
    AND json_extract(retired_latest.checkpoint_json, '$.writerAbsenceProof.instanceId') = i.instance_id
    AND json_extract(retired_latest.checkpoint_json, '$.writerAbsenceProof.repositoryId') = i.repository_id
    AND json_extract(retired_latest.checkpoint_json, '$.writerAbsenceProof.source') = 'runtime-provider-census'
    AND json_type(retired_latest.checkpoint_json, '$.writerAbsenceProof.remainingWriters') = 'integer'
    AND json_extract(retired_latest.checkpoint_json, '$.writerAbsenceProof.remainingWriters') = 0
    AND json_type(retired_latest.checkpoint_json, '$.writerAbsenceProof.providerObservationId') = 'text'
    AND length(json_extract(retired_latest.checkpoint_json, '$.writerAbsenceProof.providerObservationId')) BETWEEN 1 AND 512
    AND json_type(retired_latest.checkpoint_json, '$.writerAbsenceProof.censusObservedAt') = 'text'
    AND julianday(json_extract(retired_latest.checkpoint_json, '$.writerAbsenceProof.censusObservedAt')) IS NOT NULL
    AND julianday(json_extract(retired_latest.checkpoint_json, '$.writerAbsenceProof.censusObservedAt')) <= julianday(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    AND json_type(retired_latest.checkpoint_json, '$.writerAbsenceProof.evidenceIdentities') = 'array'
    AND NOT EXISTS (
      SELECT 1 FROM json_each(retired_latest.checkpoint_json, '$.writerAbsenceProof.evidenceIdentities') evidence_identity
      WHERE evidence_identity.type <> 'text' OR length(evidence_identity.value) > 512
    )
    AND json_type(retired_latest.checkpoint_json, '$.writerAbsenceProof.retiredRuntimeEpoch') IN ('integer', 'null')
    AND (
      json_type(retired_latest.checkpoint_json, '$.writerAbsenceProof.retiredRuntimeEpoch') = 'null'
      OR abs(json_extract(retired_latest.checkpoint_json, '$.writerAbsenceProof.retiredRuntimeEpoch')) <= 9007199254740991
    )
  
                   AND retired_latest.checkpoint_json = retired.checkpoint_json
                   AND json_extract(retired_latest.checkpoint_json, '$.writerAbsenceProof.instanceId') IS json_extract(retired_absence.checkpoint_json, '$.writerAbsenceProof.instanceId') AND json_extract(retired_latest.checkpoint_json, '$.writerAbsenceProof.repositoryId') IS json_extract(retired_absence.checkpoint_json, '$.writerAbsenceProof.repositoryId') AND json_extract(retired_latest.checkpoint_json, '$.writerAbsenceProof.retiredRuntimeEpoch') IS json_extract(retired_absence.checkpoint_json, '$.writerAbsenceProof.retiredRuntimeEpoch') AND json_extract(retired_latest.checkpoint_json, '$.writerAbsenceProof.providerObservationId') IS json_extract(retired_absence.checkpoint_json, '$.writerAbsenceProof.providerObservationId') AND json_extract(retired_latest.checkpoint_json, '$.writerAbsenceProof.censusObservedAt') IS json_extract(retired_absence.checkpoint_json, '$.writerAbsenceProof.censusObservedAt') AND json_extract(retired_latest.checkpoint_json, '$.writerAbsenceProof.remainingWriters') IS json_extract(retired_absence.checkpoint_json, '$.writerAbsenceProof.remainingWriters') AND json_extract(retired_latest.checkpoint_json, '$.writerAbsenceProof.evidenceIdentities') IS json_extract(retired_absence.checkpoint_json, '$.writerAbsenceProof.evidenceIdentities') AND json_extract(retired_latest.checkpoint_json, '$.writerAbsenceProof.source') IS json_extract(retired_absence.checkpoint_json, '$.writerAbsenceProof.source')
                   AND json_extract(retired_latest.checkpoint_json, '$.writerAbsenceProof.retiredRuntimeEpoch') = i.observed_runtime_epoch
               )
           ), ranked AS (
  SELECT *, row_number() OVER (PARTITION BY repository_id ORDER BY priority) AS position
  FROM candidates
)
UPDATE logical_instances
SET (runtime_authority_reservation_id, runtime_authority_operation_id) = (
  SELECT lease_id, authority_operation_id FROM ranked
  WHERE ranked.repository_id = logical_instances.repository_id AND position = 1
);
