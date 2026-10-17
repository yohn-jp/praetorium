import {
  RuntimeGitCredentialRecordSchema,
  RuntimeGitCredentialRegistrationSchema,
  type RuntimeGitCredentialRecord,
  type RuntimeGitCredentialRegistration,
} from "@praetorium/contracts";
import type { D1Database } from "./types.js";

type RuntimeGitCredentialStatus = RuntimeGitCredentialRecord["status"];

interface RuntimeGitCredentialRow {
  readonly token_id: string;
  readonly repository_id: number;
  readonly installation_id: number;
  readonly instance_id: string;
  readonly runtime_id: string;
  readonly runtime_epoch: number;
  readonly lease_id: string;
  readonly permission: "read" | "write";
  readonly expires_at: number;
  readonly encrypted_secret_json: string;
  readonly status: RuntimeGitCredentialStatus;
  readonly created_at: number;
  readonly updated_at: number;
}

export class RuntimeGitCredentialConflictError extends Error {
  readonly code = "RUNTIME_GIT_CREDENTIAL_CONFLICT";

  constructor() {
    super("runtime Git credential token ID is already bound to another credential");
    this.name = "RuntimeGitCredentialConflictError";
  }
}

/** Stores Gateway-encrypted installation token envelopes, never bearer credentials. */
export class D1RuntimeGitCredentialStore {
  constructor(private readonly db: D1Database) {}

  async register(
    untrustedRegistration: RuntimeGitCredentialRegistration,
    now: number,
  ): Promise<RuntimeGitCredentialRecord> {
    validateTimestamp(now);
    const registration = RuntimeGitCredentialRegistrationSchema.parse(untrustedRegistration);
    const expiresAt = Date.parse(registration.expiresAt);
    if (!Number.isSafeInteger(expiresAt) || expiresAt < 0)
      throw new TypeError("runtime Git credential expiry is invalid");

    await this.db
      .prepare(
        `INSERT INTO runtime_git_credentials (
           token_id, repository_id, installation_id, instance_id, runtime_id,
           runtime_epoch, lease_id, permission, expires_at, encrypted_secret_json,
           status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
         ON CONFLICT(token_id) DO NOTHING`,
      )
      .bind(
        registration.tokenId,
        registration.repositoryId,
        registration.installationId,
        registration.instanceId,
        registration.runtimeId,
        registration.runtimeEpoch,
        registration.leaseId,
        registration.permission,
        expiresAt,
        JSON.stringify(registration.encryptedSecret),
        now,
        now,
      )
      .run();

    const existing = await this.getByTokenId(registration.tokenId);
    if (!existing || !matchesRegistration(existing, registration, expiresAt))
      throw new RuntimeGitCredentialConflictError();
    return existing;
  }

  /** Marks active credentials for one exact runtime as requiring Gateway revocation. */
  async markPendingForRuntime(
    repositoryId: number,
    instanceId: string,
    runtimeEpoch: number,
    now: number,
  ): Promise<number> {
    validateRepositoryId(repositoryId);
    validateId(instanceId, "instance ID");
    validateRuntimeEpoch(runtimeEpoch);
    validateTimestamp(now);
    const result = await this.db
      .prepare(
        `UPDATE runtime_git_credentials SET status = 'revocation_pending', updated_at = ?
         WHERE repository_id = ? AND instance_id = ? AND runtime_epoch = ? AND status = 'active'`,
      )
      .bind(now, repositoryId, instanceId, runtimeEpoch)
      .run();
    return result.meta.changes;
  }

  /** Marks one active credential pending without changing already-pending or revoked rows. */
  async markPending(tokenId: string, now: number): Promise<RuntimeGitCredentialRecord | null> {
    validateTimestamp(now);
    validateTokenId(tokenId);
    await this.db
      .prepare(
        `UPDATE runtime_git_credentials SET status = 'revocation_pending', updated_at = ?
         WHERE token_id = ? AND status = 'active'`,
      )
      .bind(now, tokenId)
      .run();
    return this.getByTokenId(tokenId);
  }

  async listPending(
    repositoryId: number,
    runtimeEpoch: number,
    now: number,
    limit: number,
  ): Promise<RuntimeGitCredentialRecord[]> {
    validateRepositoryId(repositoryId);
    validateRuntimeEpoch(runtimeEpoch);
    validateTimestamp(now);
    validateLimit(limit, 8, "pending credential limit");
    const result = await this.db
      .prepare(
        `SELECT * FROM runtime_git_credentials
         WHERE repository_id = ? AND runtime_epoch = ?
           AND status = 'revocation_pending' AND expires_at > ?
         ORDER BY expires_at, token_id LIMIT ?`,
      )
      .bind(repositoryId, runtimeEpoch, now, limit)
      .all<RuntimeGitCredentialRow>();
    return result.results.map(toRecord);
  }

  /** Acknowledge a GitHub 204 revocation, including a token whose registration response was lost. */
  async markRevoked(tokenId: string, now: number): Promise<RuntimeGitCredentialRecord | null> {
    validateTimestamp(now);
    validateTokenId(tokenId);
    await this.db
      .prepare(
        `UPDATE runtime_git_credentials SET status = 'revoked', updated_at = ?
         WHERE token_id = ? AND status <> 'revoked'`,
      )
      .bind(now, tokenId)
      .run();
    return this.getByTokenId(tokenId);
  }

  async pendingCount(repositoryId: number, runtimeEpoch: number, now: number): Promise<number> {
    validateRepositoryId(repositoryId);
    validateRuntimeEpoch(runtimeEpoch);
    validateTimestamp(now);
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM runtime_git_credentials
         WHERE repository_id = ? AND runtime_epoch = ?
           AND status = 'revocation_pending' AND expires_at > ?`,
      )
      .bind(repositoryId, runtimeEpoch, now)
      .first<{ readonly count: number }>();
    if (!row || !Number.isSafeInteger(row.count) || row.count < 0)
      throw new TypeError("runtime Git credential pending count is invalid");
    return row.count;
  }

  /** Deletes only expired ephemeral ciphertext rows, with a hard batch bound. */
  async purgeExpired(now: number, limit: number): Promise<number> {
    validateTimestamp(now);
    validateLimit(limit, 64, "expired credential purge limit");
    const result = await this.db
      .prepare(
        `DELETE FROM runtime_git_credentials
         WHERE token_id IN (
           SELECT token_id FROM runtime_git_credentials
           WHERE expires_at <= ? ORDER BY expires_at, token_id LIMIT ?
         )`,
      )
      .bind(now, limit)
      .run();
    return result.meta.changes;
  }

  private async getByTokenId(tokenId: string): Promise<RuntimeGitCredentialRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM runtime_git_credentials WHERE token_id = ?")
      .bind(tokenId)
      .first<RuntimeGitCredentialRow>();
    return row === null ? null : toRecord(row);
  }
}

function toRecord(row: RuntimeGitCredentialRow): RuntimeGitCredentialRecord {
  let encryptedSecret: unknown;
  try {
    encryptedSecret = JSON.parse(row.encrypted_secret_json);
  } catch {
    throw new TypeError("stored runtime Git credential ciphertext is invalid");
  }
  return RuntimeGitCredentialRecordSchema.parse({
    tokenId: row.token_id,
    repositoryId: row.repository_id,
    installationId: row.installation_id,
    instanceId: row.instance_id,
    runtimeId: row.runtime_id,
    runtimeEpoch: row.runtime_epoch,
    leaseId: row.lease_id,
    permission: row.permission,
    expiresAt: new Date(row.expires_at).toISOString(),
    encryptedSecret,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function matchesRegistration(
  record: RuntimeGitCredentialRecord,
  registration: RuntimeGitCredentialRegistration,
  expiresAt: number,
): boolean {
  return (
    record.tokenId === registration.tokenId &&
    record.repositoryId === registration.repositoryId &&
    record.installationId === registration.installationId &&
    record.instanceId === registration.instanceId &&
    record.runtimeId === registration.runtimeId &&
    record.runtimeEpoch === registration.runtimeEpoch &&
    record.leaseId === registration.leaseId &&
    record.permission === registration.permission &&
    Date.parse(record.expiresAt) === expiresAt &&
    record.encryptedSecret.version === registration.encryptedSecret.version &&
    record.encryptedSecret.keyId === registration.encryptedSecret.keyId &&
    record.encryptedSecret.iv === registration.encryptedSecret.iv &&
    record.encryptedSecret.ciphertext === registration.encryptedSecret.ciphertext
  );
}

function validateTokenId(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new TypeError("runtime Git credential token ID is invalid");
}

function validateId(value: string, name: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 128)
    throw new TypeError(`runtime Git credential ${name} is invalid`);
}

function validateRepositoryId(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new TypeError("runtime Git credential repository ID is invalid");
}

function validateRuntimeEpoch(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new TypeError("runtime Git credential runtime epoch is invalid");
}

function validateTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError("runtime Git credential timestamp is invalid");
}

function validateLimit(value: number, maximum: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new TypeError(`${name} is invalid`);
}
