import type {
  AccessRefreshCredentialRecord,
  AccessRefreshCredentialStore,
} from "../refresh/types.js";

/** Strongly consistent test double for the production per-credential Durable Object store. */
export function createInMemoryAccessRefreshCredentialStore(): AccessRefreshCredentialStore {
  const records = new Map<string, { digest: string; record: AccessRefreshCredentialRecord }>();
  return {
    async create(credentialId, digest, record) {
      if (records.has(credentialId)) throw new Error("refresh credential id collision");
      records.set(credentialId, { digest, record });
    },
    async get(credentialId) {
      const entry = records.get(credentialId);
      return entry ? { digest: entry.digest, record: entry.record } : null;
    },
    async rotate(credentialId, currentDigest, nextDigest, now) {
      const entry = records.get(credentialId);
      if (
        !entry ||
        entry.digest !== currentDigest ||
        entry.record.revokedAt !== null ||
        new Date(entry.record.expiresAt).getTime() <= new Date(now).getTime()
      ) {
        return false;
      }
      records.set(credentialId, { digest: nextDigest, record: entry.record });
      return true;
    },
    async revoke(credentialId, digest, revokedAt) {
      const entry = records.get(credentialId);
      if (!entry || entry.digest !== digest || entry.record.revokedAt !== null) return false;
      records.set(credentialId, { ...entry, record: { ...entry.record, revokedAt } });
      return true;
    },
  };
}
