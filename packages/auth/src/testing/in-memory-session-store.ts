import type { UserId } from "../domain.js";
import type { SessionRecord, SessionStore } from "../session/types.js";

/** In-memory session store for tests; production persists this in a Durable Object or D1. */
export function createInMemorySessionStore(): SessionStore {
  const records = new Map<string, SessionRecord>();

  function isActive(record: SessionRecord, now: string): boolean {
    const nowMs = new Date(now).getTime();
    const notRevoked = !record.revokedAt || new Date(record.revokedAt).getTime() > nowMs;
    const notExpired = new Date(record.expiresAt).getTime() > nowMs;
    return notRevoked && notExpired;
  }

  return {
    async create(digest, record) {
      records.set(digest, record);
    },
    async get(digest) {
      return records.get(digest) ?? null;
    },
    async touch(digest, lastActivityBucket, expiresAt) {
      const existing = records.get(digest);
      if (!existing) {
        return;
      }
      records.set(digest, { ...existing, lastActivityBucket, expiresAt });
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
    async countActiveForUser(userId: UserId, now) {
      let count = 0;
      for (const record of records.values()) {
        if (record.userId === userId && isActive(record, now)) {
          count += 1;
        }
      }
      return count;
    },
  };
}
