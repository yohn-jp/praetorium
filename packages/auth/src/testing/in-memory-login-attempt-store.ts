import type { LoginAttemptRecord, LoginAttemptStore } from "../oauth/login-attempt.js";

/** In-memory login-attempt store for tests; production persists this with a TTL (Durable Object or KV). */
export function createInMemoryLoginAttemptStore(): LoginAttemptStore {
  const attempts = new Map<string, LoginAttemptRecord>();
  return {
    async save(record) {
      attempts.set(record.state, record);
    },
    async consume(state) {
      const record = attempts.get(state) ?? null;
      attempts.delete(state);
      return record;
    },
  };
}
