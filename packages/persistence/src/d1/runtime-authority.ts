/**
 * The current runtime authority is a D1 projection on logical_instances.
 * Historical operation checkpoints are consulted only when a transition
 * writes that projection; ordinary readers use this bounded current-state
 * query.
 *
 * Bind parameters in order: repository ID, current Unix time in milliseconds.
 */
export const CURRENT_RUNTIME_AUTHORITY_SQL = `
  WITH parameters AS (
    SELECT ? AS repository_id, ? AS now_ms
  ), target_authorities AS (
    SELECT
      0 AS priority, 'post-absence-target' AS authority,
      b.repository_id, b.installation_id, i.instance_id, i.legacy_runtime_epoch,
      r.reservation_id AS runtime_id, r.runtime_epoch,
      r.reservation_id AS lease_id, r.cluster_id
    FROM parameters p
    JOIN repository_bindings b ON b.repository_id = p.repository_id
    JOIN logical_instances i ON i.instance_id = b.instance_id
    JOIN runtime_reservations r ON r.reservation_id = i.runtime_authority_reservation_id
      AND r.instance_id = i.instance_id AND r.repository_id = i.repository_id
    JOIN operations o ON o.operation_id = i.runtime_authority_operation_id
      AND o.instance_id = i.instance_id AND o.repository_id = i.repository_id
      AND o.reservation_id = r.reservation_id
    WHERE b.suspended = 0
      AND i.runtime_authority_operation_id IS NOT NULL
      AND i.reservation_id = r.reservation_id
      AND i.runtime_epoch = o.runtime_epoch AND r.runtime_epoch = o.runtime_epoch
      AND i.generation = o.generation AND r.generation = o.generation
      AND o.runtime_epoch > COALESCE(i.observed_runtime_epoch, 0)
      AND o.kind IN ('start', 'redeploy', 'update')
      AND o.status IN ('claimed', 'running')
      AND o.lease_expires_at > p.now_ms
      AND o.phase IN ('old-writer-absent', 'starting-target', 'target-ready', 'route-activated', 'complete')
      AND o.cluster_id IS NOT NULL AND r.cluster_id = o.cluster_id
      AND r.status IN ('reserved', 'allocated')
      AND i.observed_state IN ('ready', 'absent', 'stopped')
  ), observed_authorities AS (
    SELECT
      1 AS priority, 'observed-writer' AS authority,
      b.repository_id, b.installation_id, i.instance_id, i.legacy_runtime_epoch,
      r.reservation_id AS runtime_id, r.runtime_epoch,
      r.reservation_id AS lease_id, r.cluster_id
    FROM parameters p
    JOIN repository_bindings b ON b.repository_id = p.repository_id
    JOIN logical_instances i ON i.instance_id = b.instance_id
    JOIN runtime_reservations r ON r.reservation_id = i.runtime_authority_reservation_id
      AND r.instance_id = i.instance_id AND r.repository_id = i.repository_id
      AND r.runtime_epoch = i.observed_runtime_epoch
    WHERE b.suspended = 0
      AND i.runtime_authority_operation_id IS NULL
      AND i.observed_state = 'ready'
      AND i.observed_runtime_epoch IS NOT NULL
      AND i.observed_revision_id IS NOT NULL
      AND i.current_artifact_digest IS NOT NULL
      AND r.status IN ('reserved', 'allocated')
      AND r.cluster_id IS NOT NULL
  ), candidates AS (
    SELECT * FROM target_authorities
    UNION ALL
    SELECT * FROM observed_authorities
  )
  SELECT * FROM candidates ORDER BY priority LIMIT 1
`;
