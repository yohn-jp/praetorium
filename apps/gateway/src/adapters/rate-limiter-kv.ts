import type { RateLimiter } from "@praetorium/auth";

/**
 * Fixed-window rate limiter backed by KV. KV has no atomic increment, so a
 * request racing another in the same window can occasionally slip through
 * by one — an acceptable trade-off for abuse mitigation (unlike the
 * Durable-Object-backed stores, which need real atomicity for security
 * invariants, not just throttling).
 */
export function createKvRateLimiter(
  kv: KVNamespace,
  namespace: string,
  options: { readonly limit: number; readonly windowSeconds: number },
): RateLimiter {
  return {
    async consume(key, now) {
      const windowIndex = Math.floor(new Date(now).getTime() / 1000 / options.windowSeconds);
      const windowKey = `rate-limit:${namespace}:${key}:${windowIndex}`;

      const current = await kv.get(windowKey);
      const count = current ? Number(current) : 0;
      if (count >= options.limit) {
        return false;
      }

      await kv.put(windowKey, String(count + 1), { expirationTtl: options.windowSeconds * 2 });
      return true;
    },
  };
}
