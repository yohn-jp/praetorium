-- Proposed T03 D1 schema. Sol owns migration numbering, installation and checksums.
-- Repository IDs are the durable identity; actor IDs occur only in audit rows.

CREATE TABLE logical_instances (
  instance_id TEXT PRIMARY KEY,
  repository_id INTEGER NOT NULL UNIQUE CHECK (repository_id > 0),
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  runtime_epoch INTEGER NOT NULL DEFAULT 0 CHECK (runtime_epoch >= 0),
  desired_state TEXT NOT NULL CHECK (desired_state IN ('running', 'stopped')),
  policy TEXT NOT NULL DEFAULT 'stable' CHECK (policy IN ('stable', 'pinned')),
  observed_generation INTEGER NULL CHECK (observed_generation IS NULL OR observed_generation >= 0),
  observed_runtime_epoch INTEGER NULL CHECK (observed_runtime_epoch IS NULL OR observed_runtime_epoch >= 0),
  observed_sequence INTEGER NOT NULL DEFAULT 0 CHECK (observed_sequence >= 0),
  observed_state TEXT NOT NULL DEFAULT 'absent' CHECK (observed_state IN ('absent', 'starting', 'ready', 'stopping', 'stopped', 'failed', 'unknown')),
  desired_revision_id TEXT NULL,
  observed_revision_id TEXT NULL,
  desired_artifact_digest TEXT NULL,
  current_artifact_digest TEXT NULL,
  reservation_state TEXT NOT NULL DEFAULT 'none' CHECK (reservation_state IN ('none', 'pending', 'reserved', 'allocated', 'blocked', 'released')),
  reservation_id TEXT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (repository_id, instance_id)
);

CREATE TABLE repository_bindings (
  repository_id INTEGER PRIMARY KEY CHECK (repository_id > 0),
  instance_id TEXT NOT NULL UNIQUE,
  installation_id INTEGER NOT NULL CHECK (installation_id > 0),
  owner TEXT NOT NULL CHECK (length(owner) BETWEEN 1 AND 255),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  authorization_revision INTEGER NOT NULL DEFAULT 0 CHECK (authorization_revision >= 0),
  binding_epoch INTEGER NOT NULL DEFAULT 1 CHECK (binding_epoch > 0),
  suspended INTEGER NOT NULL DEFAULT 0 CHECK (suspended IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (repository_id, instance_id) REFERENCES logical_instances(repository_id, instance_id)
);

CREATE TABLE repository_events (
  delivery_id TEXT PRIMARY KEY,
  repository_id INTEGER NOT NULL CHECK (repository_id > 0),
  event_kind TEXT NOT NULL CHECK (length(event_kind) BETWEEN 1 AND 128),
  occurred_at INTEGER NOT NULL
);

CREATE INDEX idx_repository_bindings_installation ON repository_bindings(installation_id, suspended);

CREATE TABLE builds (
  build_id TEXT PRIMARY KEY,
  build_key TEXT NOT NULL UNIQUE,
  build_input_json TEXT NOT NULL CHECK (json_valid(build_input_json)),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'pending', 'claimed', 'running', 'verifying', 'succeeded', 'failed', 'cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_epoch INTEGER NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  active_attempt_id TEXT NULL,
  worker_id TEXT NULL,
  lease_token TEXT NULL,
  lease_expires_at INTEGER NULL,
  report_sequence INTEGER NOT NULL DEFAULT 0 CHECK (report_sequence >= 0),
  last_report_digest TEXT NULL,
  progress_json TEXT NULL CHECK (progress_json IS NULL OR json_valid(progress_json)),
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
  candidate_ref TEXT NULL,
  manifest_digest TEXT NULL,
  artifact_digest TEXT NULL,
  failure_json TEXT NULL CHECK (failure_json IS NULL OR json_valid(failure_json)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_builds_claimable ON builds(status, lease_expires_at, created_at);

CREATE TABLE build_attempts (
  attempt_id TEXT PRIMARY KEY,
  build_id TEXT NOT NULL REFERENCES builds(build_id),
  lease_epoch INTEGER NOT NULL CHECK (lease_epoch > 0),
  worker_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('claimed', 'running', 'verifying', 'succeeded', 'failed', 'expired', 'cancelled')),
  lease_token TEXT NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  report_sequence INTEGER NOT NULL DEFAULT 0 CHECK (report_sequence >= 0),
  last_report_digest TEXT NULL,
  progress_json TEXT NULL CHECK (progress_json IS NULL OR json_valid(progress_json)),
  candidate_ref TEXT NULL,
  manifest_digest TEXT NULL,
  failure_json TEXT NULL CHECK (failure_json IS NULL OR json_valid(failure_json)),
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER NULL,
  UNIQUE (build_id, lease_epoch)
);

CREATE INDEX idx_build_attempts_build ON build_attempts(build_id, lease_epoch);

CREATE TABLE artifacts (
  artifact_digest TEXT NOT NULL,
  build_key TEXT NOT NULL REFERENCES builds(build_key),
  build_id TEXT NOT NULL REFERENCES builds(build_id),
  attempt_id TEXT NOT NULL REFERENCES build_attempts(attempt_id),
  manifest_digest TEXT NOT NULL,
  platform_manifest_digest TEXT NOT NULL,
  composition_manifest_digest TEXT NOT NULL,
  producer_revision TEXT NOT NULL,
  requested_modules_json TEXT NOT NULL CHECK (json_valid(requested_modules_json)),
  resolved_modules_json TEXT NOT NULL CHECK (json_valid(resolved_modules_json)),
  contract_versions_json TEXT NOT NULL CHECK (json_valid(contract_versions_json)),
  sbom_ref TEXT NULL,
  provenance_ref TEXT NULL,
  verification_json TEXT NOT NULL CHECK (json_valid(verification_json)),
  statement_json TEXT NOT NULL CHECK (json_valid(statement_json)),
  signature_json TEXT NOT NULL CHECK (json_valid(signature_json)),
  verifier_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('admitted', 'rejected')),
  created_at INTEGER NOT NULL,
  admitted_at INTEGER NULL,
  PRIMARY KEY (artifact_digest),
  UNIQUE (build_key, artifact_digest)
);

CREATE UNIQUE INDEX idx_artifacts_one_admitted_per_build
  ON artifacts(build_key) WHERE status = 'admitted';

CREATE TABLE deployment_revisions (
  revision_id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES logical_instances(instance_id),
  repository_id INTEGER NOT NULL CHECK (repository_id > 0),
  generation INTEGER NOT NULL CHECK (generation > 0),
  build_key TEXT NOT NULL REFERENCES builds(build_key),
  build_id TEXT NOT NULL REFERENCES builds(build_id),
  selection_json TEXT NOT NULL CHECK (json_valid(selection_json)),
  resource_requirements_json TEXT NOT NULL CHECK (json_valid(resource_requirements_json)),
  runtime_metadata_json TEXT NOT NULL CHECK (json_valid(runtime_metadata_json)),
  artifact_digest TEXT NULL REFERENCES artifacts(artifact_digest),
  status TEXT NOT NULL CHECK (status IN ('building', 'admitted', 'failed', 'superseded')),
  actor_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (instance_id, generation),
  UNIQUE (revision_id, instance_id, repository_id)
);

CREATE INDEX idx_deployment_revisions_repo ON deployment_revisions(repository_id, generation DESC);

CREATE TABLE cluster_capacity_snapshots (
  cluster_id TEXT PRIMARY KEY,
  capacity_epoch INTEGER NOT NULL CHECK (capacity_epoch > 0),
  observed_at INTEGER NOT NULL,
  complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
  allocatable_cpu_milli INTEGER NOT NULL CHECK (allocatable_cpu_milli >= 0),
  allocatable_memory_mib INTEGER NOT NULL CHECK (allocatable_memory_mib >= 0),
  allocatable_ephemeral_storage_mib INTEGER NOT NULL CHECK (allocatable_ephemeral_storage_mib >= 0),
  requested_cpu_milli INTEGER NOT NULL CHECK (requested_cpu_milli >= 0),
  requested_memory_mib INTEGER NOT NULL CHECK (requested_memory_mib >= 0),
  requested_ephemeral_storage_mib INTEGER NOT NULL CHECK (requested_ephemeral_storage_mib >= 0),
  node_resource_version TEXT NOT NULL CHECK (length(node_resource_version) BETWEEN 1 AND 255),
  pod_resource_version TEXT NOT NULL CHECK (length(pod_resource_version) BETWEEN 1 AND 255),
  represented_reservation_ids_json TEXT NOT NULL CHECK (json_valid(represented_reservation_ids_json)),
  updated_at INTEGER NOT NULL
);

CREATE TABLE runtime_reservations (
  reservation_id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES logical_instances(instance_id),
  repository_id INTEGER NOT NULL CHECK (repository_id > 0),
  runtime_epoch INTEGER NOT NULL CHECK (runtime_epoch > 0),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  cluster_id TEXT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'reserved', 'allocated', 'released', 'blocked')),
  capacity_snapshot_epoch INTEGER NOT NULL CHECK (capacity_snapshot_epoch > 0),
  cpu_milli INTEGER NOT NULL CHECK (cpu_milli >= 0),
  memory_mib INTEGER NOT NULL CHECK (memory_mib >= 0),
  ephemeral_storage_mib INTEGER NOT NULL CHECK (ephemeral_storage_mib >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (instance_id, runtime_epoch)
);

CREATE INDEX idx_runtime_reservations_cluster_status ON runtime_reservations(cluster_id, status);

CREATE TABLE operations (
  operation_id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES logical_instances(instance_id),
  repository_id INTEGER NOT NULL CHECK (repository_id > 0),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  runtime_epoch INTEGER NOT NULL CHECK (runtime_epoch >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('start', 'stop', 'redeploy', 'update')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'running', 'succeeded', 'failed', 'blocked')),
  phase TEXT NOT NULL DEFAULT 'accepted',
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  lease_epoch INTEGER NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  worker_id TEXT NULL,
  lease_token TEXT NULL,
  lease_expires_at INTEGER NULL,
  report_sequence INTEGER NOT NULL DEFAULT 0 CHECK (report_sequence >= 0),
  last_report_digest TEXT NULL,
  checkpoint_sequence INTEGER NOT NULL DEFAULT 0 CHECK (checkpoint_sequence >= 0),
  checkpoint_json TEXT NULL CHECK (checkpoint_json IS NULL OR json_valid(checkpoint_json)),
  result_json TEXT NULL CHECK (result_json IS NULL OR json_valid(result_json)),
  cluster_id TEXT NULL,
  reservation_id TEXT NULL REFERENCES runtime_reservations(reservation_id),
  deployment_revision_id TEXT NULL,
  build_id TEXT NULL REFERENCES builds(build_id),
  prerequisite_build_id TEXT NULL REFERENCES builds(build_id),
  idempotency_scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  authorization_revision INTEGER NOT NULL CHECK (authorization_revision >= 0),
  request_id TEXT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (idempotency_scope, idempotency_key),
  FOREIGN KEY (deployment_revision_id, instance_id, repository_id)
    REFERENCES deployment_revisions(revision_id, instance_id, repository_id)
);

CREATE INDEX idx_operations_claimable ON operations(cluster_id, status, lease_expires_at, created_at);
CREATE INDEX idx_operations_repository ON operations(repository_id, created_at DESC);

CREATE TABLE operation_checkpoints (
  operation_id TEXT NOT NULL REFERENCES operations(operation_id),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  phase TEXT NOT NULL,
  runtime_epoch INTEGER NOT NULL CHECK (runtime_epoch >= 0),
  checkpoint_json TEXT NOT NULL CHECK (json_valid(checkpoint_json)),
  actor_id TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  PRIMARY KEY (operation_id, sequence)
);

CREATE TABLE idempotency_records (
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_kind TEXT NOT NULL,
  response_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (scope, idempotency_key)
);

CREATE TABLE audit_events (
  event_id TEXT PRIMARY KEY,
  repository_id INTEGER NULL,
  instance_id TEXT NULL,
  operation_id TEXT NULL,
  actor_id TEXT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'system', 'provisioner', 'build-worker', 'operator')),
  action TEXT NOT NULL,
  outcome TEXT NOT NULL,
  request_id TEXT NULL,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  occurred_at INTEGER NOT NULL
);

CREATE INDEX idx_audit_repository_time ON audit_events(repository_id, occurred_at);
CREATE INDEX idx_audit_actor_time ON audit_events(actor_kind, actor_id, occurred_at);
CREATE INDEX idx_audit_operation_time ON audit_events(operation_id, occurred_at);

-- D1 batch mutations use a duplicate-key violation to roll back earlier CAS
-- statements when a later guarded statement reports anything but one row.
CREATE TABLE platform_transaction_sentinel (
  id INTEGER PRIMARY KEY CHECK (id = 1)
);
INSERT INTO platform_transaction_sentinel(id) VALUES (1);
