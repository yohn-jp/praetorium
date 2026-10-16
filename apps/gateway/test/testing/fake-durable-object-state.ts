/**
 * Minimal fake of `DurableObjectState.storage` backed by an in-memory Map,
 * enough to exercise a Durable Object class's logic directly without
 * Miniflare — real durability, coalescing, and cross-isolate guarantees are
 * out of scope for a unit test and belong to a `wrangler dev` smoke test.
 */
export function createFakeDurableObjectState(): DurableObjectState {
  const data = new Map<string, unknown>();
  let transactionTail: Promise<void> = Promise.resolve();

  const storage = {
    async get<T>(key: string): Promise<T | undefined> {
      return data.get(key) as T | undefined;
    },
    async put<T>(key: string, value: T): Promise<void> {
      data.set(key, value);
    },
    async delete(key: string): Promise<boolean> {
      return data.delete(key);
    },
    async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
      const prefix = options?.prefix ?? "";
      const result = new Map<string, T>();
      for (const [key, value] of data) {
        if (key.startsWith(prefix)) {
          result.set(key, value as T);
        }
      }
      return result;
    },
    async transaction<T>(callback: (transaction: typeof storage) => Promise<T>): Promise<T> {
      const prior = transactionTail;
      let release = () => undefined;
      transactionTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await prior;
      try {
        return await callback(storage);
      } finally {
        release();
      }
    },
  };

  return { storage } as unknown as DurableObjectState;
}
