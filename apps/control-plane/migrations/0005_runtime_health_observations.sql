-- Current, authenticated Provisioner samples for the continuous canary window.
-- No manuscript or credential material is retained here.
CREATE TABLE runtime_health_observations (
  instance_id TEXT PRIMARY KEY REFERENCES logical_instances(instance_id),
  repository_id INTEGER NOT NULL,
  runtime_epoch INTEGER NOT NULL CHECK (runtime_epoch > 0),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  cluster_id TEXT NOT NULL,
  operation_id TEXT NOT NULL REFERENCES operations(operation_id),
  provider_observation_id TEXT NOT NULL UNIQUE,
  observed_at INTEGER NOT NULL CHECK (observed_at >= 0),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json))
);
