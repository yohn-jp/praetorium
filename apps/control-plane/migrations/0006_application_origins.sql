-- Preserve all legacy logical keys and history. Old-origin browser recovery
-- and cookies may be abandoned by the owner decision of 2026-10-19.
-- Runtime work is NOT discarded: migration requires drained operation leases;
-- the next start/redeploy retires the source through the existing lifecycle.
CREATE TABLE IF NOT EXISTS application_origin_migration_guard (safe INTEGER NOT NULL CHECK (safe = 1));
INSERT INTO application_origin_migration_guard
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM operations WHERE status IN ('pending', 'claimed', 'running')
) THEN 0 ELSE 1 END;
DROP TABLE application_origin_migration_guard;
ALTER TABLE repository_bindings ADD COLUMN app_identity TEXT NOT NULL DEFAULT 'scriptorium'
  CHECK (app_identity = 'scriptorium');
CREATE UNIQUE INDEX application_binding_identity ON repository_bindings(app_identity, repository_id);
ALTER TABLE logical_instances ADD COLUMN legacy_runtime_epoch INTEGER NULL;
UPDATE logical_instances SET legacy_runtime_epoch = observed_runtime_epoch
WHERE observed_runtime_epoch > 0;
-- Physical identity is an injective (binding ID, monotonic runtime epoch)
-- encoding, not a reinterpretation of any legacy instance_id foreign key.
CREATE VIEW application_bindings AS
SELECT b.app_identity, b.repository_id, b.instance_id AS binding_id,
       CASE WHEN i.observed_runtime_epoch IS NULL THEN NULL
            WHEN i.observed_runtime_epoch = i.legacy_runtime_epoch THEN i.instance_id
            ELSE 'run_' || substr(i.instance_id, 5) || '_' || i.observed_runtime_epoch
       END AS instance_id,
       i.observed_runtime_epoch AS runtime_epoch
FROM repository_bindings b JOIN logical_instances i ON i.instance_id = b.instance_id;
