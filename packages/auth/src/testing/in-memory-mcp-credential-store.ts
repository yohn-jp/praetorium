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
    async listForUser(userId: UserId, cursor?: string) {
      const entries = [...records.entries()]
        .filter(([, record]) => record.userId === userId)
        .map(([digest, record]) => ({ digest, record }))
        .sort((left, right) => left.record.id.localeCompare(right.record.id));
      const start = cursor ? entries.findIndex(({ record }) => record.id === cursor) + 1 : 0;
      if (cursor && start === 0) throw new Error("credential page cursor is invalid");
      const items = entries.slice(start, start + 100);
      return {
        items,
        ...(start + items.length < entries.length && items.length > 0
          ? { nextCursor: items.at(-1)!.record.id }
          : {}),
      };
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
    async revokeById(userId: UserId, id, revokedAt) {
      const match = [...records.entries()].find(([, record]) => record.userId === userId && record.id === id);
      if (!match) return false;
      const [digest, existing] = match;
      records.set(digest, { ...existing, revokedAt });
      return true;
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
