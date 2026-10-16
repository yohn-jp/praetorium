-- Build staging preserves current desired state until fenced activation.
CREATE TABLE staged_configurations (
  stage_id TEXT PRIMARY KEY,
  repository_id INTEGER NOT NULL CHECK (repository_id > 0),
  instance_id TEXT NOT NULL,
  binding_epoch INTEGER NOT NULL CHECK (binding_epoch > 0),
  authorization_revision INTEGER NOT NULL CHECK (authorization_revision >= 0),
  expected_generation INTEGER NOT NULL CHECK (expected_generation >= 0),
  expected_runtime_epoch INTEGER NOT NULL CHECK (expected_runtime_epoch >= 0),
  expected_policy TEXT NOT NULL CHECK (expected_policy IN ('stable', 'pinned')),
  expected_desired_state TEXT NOT NULL CHECK (expected_desired_state IN ('running', 'stopped')),
  selection_json TEXT NOT NULL CHECK (json_valid(selection_json) AND length(selection_json) <= 65536),
  build_input_json TEXT NOT NULL CHECK (json_valid(build_input_json) AND length(build_input_json) <= 1048576),
  build_key TEXT NOT NULL REFERENCES builds(build_key),
  build_id TEXT NOT NULL REFERENCES builds(build_id),
  resource_requirements_json TEXT NOT NULL CHECK (json_valid(resource_requirements_json) AND length(resource_requirements_json) <= 8192),
  runtime_metadata_json TEXT NOT NULL CHECK (json_valid(runtime_metadata_json) AND length(runtime_metadata_json) <= 16384),
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 255),
  idempotency_scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  request_id TEXT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('staged', 'activated', 'superseded')),
  activation_generation INTEGER NULL CHECK (activation_generation IS NULL OR activation_generation > 0),
  deployment_revision_id TEXT NULL REFERENCES deployment_revisions(revision_id),
  operation_id TEXT NULL REFERENCES operations(operation_id),
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (repository_id, instance_id) REFERENCES logical_instances(repository_id, instance_id),
  UNIQUE (idempotency_scope, idempotency_key),
  CHECK ((status = 'activated' AND activation_generation IS NOT NULL AND deployment_revision_id IS NOT NULL)
      OR (status <> 'activated' AND activation_generation IS NULL AND deployment_revision_id IS NULL AND operation_id IS NULL))
);
CREATE INDEX idx_staged_configurations_instance ON staged_configurations(instance_id, created_at DESC);
CREATE INDEX idx_staged_configurations_build ON staged_configurations(build_id, status);
