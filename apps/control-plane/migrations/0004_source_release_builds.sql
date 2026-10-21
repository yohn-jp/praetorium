-- GitHub Release selection is a durable platform build intent. GitHub Actions is
-- not an execution authority for tenant/service deployments.
CREATE TABLE source_release_builds (
  job_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL CHECK (source_id = 'scriptorium'),
  github_release_id INTEGER NOT NULL CHECK (github_release_id > 0),
  source_repository TEXT NOT NULL CHECK (source_repository = 'yohn-jp/scriptorium'),
  source_tag TEXT NOT NULL CHECK (length(source_tag) BETWEEN 1 AND 128),
  source_revision TEXT NOT NULL CHECK (length(source_revision) = 40),
  release_version TEXT NOT NULL CHECK (length(release_version) BETWEEN 5 AND 128),
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  state TEXT NOT NULL CHECK (state IN ('queued', 'building', 'produced', 'admitted', 'failed')),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  lease_worker TEXT,
  lease_token TEXT,
  lease_epoch INTEGER NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  lease_expires_at INTEGER,
  progress_json TEXT CHECK (progress_json IS NULL OR (json_valid(progress_json) AND length(progress_json) <= 8192)),
  result_json TEXT CHECK (result_json IS NULL OR (json_valid(result_json) AND length(result_json) <= 65536)),
  failure_code TEXT,
  admitted_release_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(source_id, github_release_id),
  CHECK ((state = 'building' AND lease_worker IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR (state <> 'building' AND lease_worker IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL))
);
CREATE INDEX idx_source_release_build_claim ON source_release_builds(state, lease_expires_at, created_at);
