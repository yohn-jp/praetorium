/**
 * Rate limiting by an opaque key (e.g. client IP, not "does this user
 * exist") so limiting invalid attempts never itself becomes an enumeration
 * oracle.
 */
export interface RateLimiter {
  /** Returns whether the action is allowed, consuming one unit of budget under `key` if so. */
  consume(key: string, now: string): Promise<boolean>;
}

export interface FixedWindowRateLimiterOptions {
  readonly limit: number;
  readonly windowSeconds: number;
}

/** In-memory fixed-window limiter for tests; production uses a Durable Object or KV adapter. */
export function createInMemoryFixedWindowRateLimiter(
  options: FixedWindowRateLimiterOptions,
): RateLimiter {
  const windows = new Map<string, { windowStart: number; count: number }>();

  return {
    async consume(key, now) {
      const nowMs = new Date(now).getTime();
      const windowMs = options.windowSeconds * 1000;
      const current = windows.get(key);

      if (!current || nowMs - current.windowStart >= windowMs) {
        windows.set(key, { windowStart: nowMs, count: 1 });
        return true;
      }

      if (current.count >= options.limit) {
        return false;
      }

      current.count += 1;
      return true;
    },
  };
}
