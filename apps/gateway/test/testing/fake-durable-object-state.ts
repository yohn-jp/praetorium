export interface FakeDurableObjectState extends DurableObjectState {
  readonly testMetrics: { listCalls: number; rowsReturned: number; maxRowsPerList: number };
}

/**
 * Minimal fake of `DurableObjectState.storage` backed by an in-memory Map,
 * enough to exercise a Durable Object class's logic directly without
 * Miniflare — real durability, coalescing, and cross-isolate guarantees are
 * out of scope for a unit test and belong to a `wrangler dev` smoke test.
 */
export function createFakeDurableObjectState(): FakeDurableObjectState {
  const data = new Map<string, unknown>();
  let transactionTail: Promise<void> = Promise.resolve();
  let alarm: number | null = null;
  const testMetrics = { listCalls: 0, rowsReturned: 0, maxRowsPerList: 0 };

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
    async list<T>(options?: { prefix?: string; startAfter?: string; limit?: number }): Promise<Map<string, T>> {
      testMetrics.listCalls += 1;
      const prefix = options?.prefix ?? "";
      const result = new Map<string, T>();
      for (const [key, value] of [...data.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
        if (key.startsWith(prefix) && (!options?.startAfter || key > options.startAfter)) {
          result.set(key, value as T);
          if (options?.limit !== undefined && result.size >= options.limit) break;
        }
      }
      testMetrics.rowsReturned += result.size;
      testMetrics.maxRowsPerList = Math.max(testMetrics.maxRowsPerList, result.size);
      return result;
    },
    async getAlarm(): Promise<number | null> { return alarm; },
    async setAlarm(at: number | Date): Promise<void> {
      alarm = at instanceof Date ? at.getTime() : at;
    },
    async deleteAlarm(): Promise<void> { alarm = null; },
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

  return { storage, testMetrics } as unknown as FakeDurableObjectState;
}
