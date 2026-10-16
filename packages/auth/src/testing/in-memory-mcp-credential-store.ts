import type { UserId } from "../domain.js";
import type { McpCredentialRecord, McpCredentialStore } from "../credential/types.js";

/** In-memory MCP credential store for tests; production persists this in D1. */
export function createInMemoryMcpCredentialStore(): McpCredentialStore {
  const records = new Map<string, McpCredentialRecord>();

  return {
    async create(digest, record) {
      records.set(digest, record);
    },
    async get(digest) {
      return records.get(digest) ?? null;
    },
    async listForUser(userId: UserId) {
      return [...records.entries()]
        .filter(([, record]) => record.userId === userId)
        .map(([digest, record]) => ({ digest, record }));
    },
    async touchLastUsed(digest, lastUsedAt) {
      const existing = records.get(digest);
      if (!existing) {
        return;
      }
      records.set(digest, { ...existing, lastUsedAt });
    },
    async revoke(digest, revokedAt) {
      const existing = records.get(digest);
      if (!existing) {
        return;
      }
      records.set(digest, { ...existing, revokedAt });
    },
    async revokeAllForUser(userId: UserId, revokedAt) {
      for (const [digest, record] of records) {
        if (record.userId === userId && !record.revokedAt) {
          records.set(digest, { ...record, revokedAt });
        }
      }
    },
  };
}
