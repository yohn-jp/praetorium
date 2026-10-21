-- Additive recovery metadata; historical migration names and job identity remain intact.
ALTER TABLE source_release_builds ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0);
ALTER TABLE source_release_builds ADD COLUMN admission_attempt INTEGER NOT NULL DEFAULT 0 CHECK (admission_attempt >= 0);
ALTER TABLE source_release_builds ADD COLUMN next_attempt_at INTEGER;
CREATE INDEX idx_source_release_admission_due
  ON source_release_builds(state, next_attempt_at, created_at, job_id);
