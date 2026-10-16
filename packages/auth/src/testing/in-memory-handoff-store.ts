import type { HandoffCodeRecord, HandoffCodeStore } from "../handoff/types.js";

/** In-memory handoff-code store for tests; production persists this in a Durable Object with a short TTL. */
export function createInMemoryHandoffCodeStore(): HandoffCodeStore {
  const codes = new Map<string, HandoffCodeRecord>();
  return {
    async save(digest, record) {
      codes.set(digest, record);
    },
    async consume(digest) {
      const record = codes.get(digest) ?? null;
      codes.delete(digest);
      return record;
    },
  };
}
