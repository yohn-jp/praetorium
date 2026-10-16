-- Gateway-encrypted, repository/epoch-bound installation credentials.
-- Never store a plaintext GitHub token, user token or App private key here.
CREATE TABLE runtime_git_credentials (
  token_id TEXT PRIMARY KEY CHECK(length(token_id) = 64),
  repository_id INTEGER NOT NULL REFERENCES repository_bindings(repository_id),
  installation_id INTEGER NOT NULL,
  instance_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  runtime_epoch INTEGER NOT NULL CHECK(runtime_epoch > 0),
  lease_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  encrypted_secret_json TEXT NOT NULL CHECK(json_valid(encrypted_secret_json) AND length(encrypted_secret_json) <= 33000),
  status TEXT NOT NULL CHECK(status IN ('active', 'revocation_pending', 'revoked')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX runtime_git_credentials_retirement
  ON runtime_git_credentials(repository_id, runtime_epoch, status, expires_at);
