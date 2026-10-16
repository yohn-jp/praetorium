import type { McpCredentialId, UserId } from "../domain.js";
import type { RepositoryPermission } from "../repository-access.js";

/**
 * Per-instance MCP credential metadata. The plaintext credential is shown
 * exactly once at creation and is never itself persisted — only its
 * keyed digest (the store's key) and this metadata are.
 */
export interface McpCredentialRecord {
  readonly id: McpCredentialId;
  readonly userId: UserId;
  readonly sessionRevision: number;
  readonly repositoryId: number;
  readonly instanceId: string;
  readonly runtimeEpoch: number;
  readonly name: string;
  readonly permissions: readonly RepositoryPermission[];
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
}

/** A listed credential paired with its digest — never the plaintext — so a caller can revoke the one it names. */
export interface McpCredentialListEntry {
  readonly digest: string;
  readonly record: McpCredentialRecord;
}

export interface McpCredentialStore {
  create(digest: string, record: McpCredentialRecord): Promise<void>;
  get(digest: string): Promise<McpCredentialRecord | null>;
  listForUser(userId: UserId): Promise<readonly McpCredentialListEntry[]>;
  /** Debounced last-used update; callers bucket the timing decision themselves. */
  touchLastUsed(digest: string, lastUsedAt: string): Promise<void>;
  revoke(digest: string, revokedAt: string): Promise<void>;
  revokeAllForUser(userId: UserId, revokedAt: string): Promise<void>;
}
