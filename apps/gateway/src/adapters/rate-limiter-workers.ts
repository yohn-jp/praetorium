import type { RateLimiter } from "@praetorium/auth";

/**
 * Cloudflare's location-local, best-effort Rate Limiting binding.
 * The environment prefix prevents preview and production from spending
 * each other's quota when Cloudflare shares a namespace across Workers.
 */
export function createWorkersRateLimiter(binding: RateLimit, environment: string): RateLimiter {
  return {
    async consume(key) {
      const { success } = await binding.limit({ key: `${environment}:${key}` });
      return success;
    },
  };
}
