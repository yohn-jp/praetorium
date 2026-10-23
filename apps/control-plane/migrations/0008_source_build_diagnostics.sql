-- Additive attempt evidence. Existing jobs/history are intentionally not backfilled:
-- no stage or diagnostic can be reconstructed from a legacy failure code.
CREATE TABLE source_release_build_attempts (
  job_id TEXT NOT NULL REFERENCES source_release_builds(job_id) ON DELETE CASCADE,
  lease_epoch INTEGER NOT NULL CHECK (lease_epoch > 0),
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  state TEXT NOT NULL CHECK (state IN ('building','produced','failed','lease_expired')),
  stage TEXT NOT NULL CHECK (stage IN ('unknown','release_check','source_checkout','build_environment','runtime_base','buildkit','metadata','oci_export','verification','admission')),
  started_at INTEGER,
  finished_at INTEGER,
  failure_code TEXT,
  diagnostic_json TEXT CHECK (diagnostic_json IS NULL OR (json_valid(diagnostic_json) AND length(CAST(diagnostic_json AS BLOB)) <= 12288)),
  evidence_expires_at INTEGER,
  PRIMARY KEY (job_id, lease_epoch),
  CHECK ((state='building' AND finished_at IS NULL) OR (state<>'building' AND finished_at IS NOT NULL)),
  CHECK (diagnostic_json IS NULL OR evidence_expires_at IS NOT NULL)
);
CREATE INDEX idx_source_build_attempts_job_epoch ON source_release_build_attempts(job_id, lease_epoch DESC);
CREATE INDEX idx_source_build_attempts_expiry ON source_release_build_attempts(evidence_expires_at) WHERE diagnostic_json IS NOT NULL;
