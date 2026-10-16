-- Stable release and rollout metadata. Apply only to an explicitly authorized database.
CREATE TABLE release_candidates (
  release_id TEXT PRIMARY KEY,
  image_digest TEXT NOT NULL UNIQUE,
  version TEXT NOT NULL,
  image_repository TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('candidate', 'available')),
  candidate_json TEXT NOT NULL CHECK (json_valid(candidate_json) AND length(candidate_json) <= 1048576),
  created_at TEXT NOT NULL
);
CREATE INDEX release_candidates_scan ON release_candidates(created_at, release_id);

CREATE TABLE stable_release_channels (
  channel_key TEXT PRIMARY KEY CHECK (channel_key = 'stable'),
  current_release_id TEXT NULL REFERENCES release_candidates(release_id),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  updated_at INTEGER NOT NULL
);
INSERT INTO stable_release_channels(channel_key, current_release_id, revision, updated_at)
VALUES ('stable', NULL, 0, 0);

CREATE TABLE release_discovery_checkpoints (
  checkpoint_id TEXT PRIMARY KEY CHECK (checkpoint_id = 'stable'),
  cursor TEXT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  updated_at INTEGER NOT NULL
);
INSERT INTO release_discovery_checkpoints(checkpoint_id, cursor, revision, updated_at)
VALUES ('stable', NULL, 0, 0);

CREATE TABLE release_candidate_workflows (
  release_id TEXT PRIMARY KEY REFERENCES release_candidates(release_id),
  state TEXT NOT NULL CHECK (state IN (
    'queued', 'canary_building', 'canary_starting', 'canary_observing',
    'canary_cleanup', 'promoting', 'promoted', 'rolling_out', 'complete',
    'blocked', 'rejected', 'superseded'
  )),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  next_attempt_at INTEGER NULL,
  lease_owner TEXT NULL,
  lease_epoch INTEGER NOT NULL CHECK (lease_epoch >= 0),
  lease_expires_at INTEGER NULL,
  canary_artifact_digest TEXT NULL,
  canary_build_key TEXT NULL,
  canary_runtime_id TEXT NULL,
  canary_operation_id TEXT NULL,
  healthy_since INTEGER NULL,
  last_healthy_at INTEGER NULL,
  last_health_evidence_json TEXT NULL CHECK (
    last_health_evidence_json IS NULL OR
    (json_valid(last_health_evidence_json) AND length(last_health_evidence_json) <= 8192)
  ),
  cleanup_evidence_json TEXT NULL CHECK (
    cleanup_evidence_json IS NULL OR
    (json_valid(cleanup_evidence_json) AND length(cleanup_evidence_json) <= 8192)
  ),
  follower_cursor TEXT NULL,
  follower_planning_complete INTEGER NOT NULL CHECK (follower_planning_complete IN (0, 1)),
  canary_cleanup_complete INTEGER NOT NULL CHECK (canary_cleanup_complete IN (0, 1)),
  cleanup_disposition TEXT NULL CHECK (cleanup_disposition IN ('promote', 'reject')),
  failure_code TEXT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL))
);
CREATE INDEX release_candidate_work_due
  ON release_candidate_workflows(state, next_attempt_at, lease_expires_at, release_id);

CREATE TABLE stable_rollout_fanout (
  release_id TEXT PRIMARY KEY REFERENCES release_candidates(release_id),
  cursor TEXT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
  last_input_cursor TEXT NULL,
  last_next_cursor TEXT NULL,
  last_page_hash TEXT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE stable_rollouts (
  rollout_id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL REFERENCES release_candidates(release_id),
  instance_id TEXT NOT NULL REFERENCES logical_instances(instance_id),
  cluster_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json) AND length(snapshot_json) <= 65536),
  state TEXT NOT NULL CHECK (state IN (
    'pending', 'building', 'waiting_build', 'dispatch_pending', 'operation_pending',
    'complete', 'deferred_stopped', 'skipped_pinned', 'blocked', 'superseded'
  )),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  build_key TEXT NULL,
  build_id TEXT NULL,
  artifact_digest TEXT NULL,
  deployment_revision_id TEXT NULL REFERENCES deployment_revisions(revision_id),
  operation_id TEXT NULL REFERENCES operations(operation_id),
  failure_code TEXT NULL,
  next_attempt_at INTEGER NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (release_id, instance_id),
  CHECK (state <> 'operation_pending' OR operation_id IS NOT NULL)
);
CREATE INDEX stable_rollouts_due ON stable_rollouts(state, next_attempt_at, updated_at, rollout_id);

CREATE TABLE cluster_rollout_leases (
  cluster_id TEXT PRIMARY KEY,
  rollout_id TEXT NOT NULL REFERENCES stable_rollouts(rollout_id),
  owner TEXT NOT NULL,
  lease_epoch INTEGER NOT NULL CHECK (lease_epoch >= 0),
  lease_expires_at INTEGER NOT NULL,
  active_operation_id TEXT NULL REFERENCES operations(operation_id),
  updated_at INTEGER NOT NULL
);
CREATE INDEX cluster_rollout_lease_due ON cluster_rollout_leases(lease_expires_at, cluster_id);
