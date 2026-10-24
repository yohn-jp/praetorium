/**
 * Reads the single current runtime grant on logical_instances. Historical
 * operation checkpoints are consulted only when a transition writes that
 * grant; ordinary readers use this bounded current-state query.
 *
 * Bind parameters in order: repository ID, current Unix time in milliseconds.
 */
export const CURRENT_RUNTIME_AUTHORITY_SQL = `
  SELECT
    CASE WHEN i.runtime_authority_operation_id IS NULL
      THEN 'observed-writer' ELSE 'post-absence-target' END AS authority,
    b.repository_id, b.installation_id, i.instance_id, i.legacy_runtime_epoch,
    r.reservation_id AS runtime_id, r.runtime_epoch,
    r.reservation_id AS lease_id, r.cluster_id
  FROM repository_bindings b
  JOIN logical_instances i ON i.instance_id = b.instance_id
  JOIN runtime_reservations r ON r.reservation_id = i.runtime_authority_reservation_id
    AND r.instance_id = i.instance_id AND r.repository_id = i.repository_id
  LEFT JOIN operations o ON o.operation_id = i.runtime_authority_operation_id
  WHERE b.repository_id = ? AND b.suspended = 0
    AND r.status IN ('reserved', 'allocated')
    AND r.cluster_id IS NOT NULL
    AND (
      (
        i.runtime_authority_operation_id IS NULL
        AND i.observed_state = 'ready'
        AND i.observed_runtime_epoch IS NOT NULL
        AND i.observed_revision_id IS NOT NULL
        AND i.current_artifact_digest IS NOT NULL
        AND r.runtime_epoch = i.observed_runtime_epoch
      )
      OR (
        i.runtime_authority_operation_id IS NOT NULL
        AND o.operation_id = i.runtime_authority_operation_id
        AND o.instance_id = i.instance_id AND o.repository_id = i.repository_id
        AND o.reservation_id = r.reservation_id
        AND i.reservation_id = r.reservation_id
        AND i.runtime_epoch = o.runtime_epoch AND r.runtime_epoch = o.runtime_epoch
        AND i.generation = o.generation AND r.generation = o.generation
        AND o.runtime_epoch > COALESCE(i.observed_runtime_epoch, 0)
        AND o.kind IN ('start', 'redeploy', 'update')
        AND o.status IN ('claimed', 'running')
        AND o.lease_expires_at > ?
        AND o.phase IN ('old-writer-absent', 'starting-target', 'target-ready', 'route-activated', 'complete')
        AND o.cluster_id IS NOT NULL AND r.cluster_id = o.cluster_id
        AND i.observed_state IN ('ready', 'absent', 'stopped')
      )
    )
  LIMIT 1
`;
