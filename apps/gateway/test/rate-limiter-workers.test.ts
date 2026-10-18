import { describe, expect, it, vi } from "vitest";
import { createWorkersRateLimiter } from "../src/adapters/rate-limiter-workers.js";

describe("Cloudflare Workers rate limiter adapter", () => {
  it("uses environment-isolated native buckets and preserves allow/deny results", async () => {
    const limit = vi.fn()
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false });
    const limiter = createWorkersRateLimiter({ limit } as unknown as RateLimit, "preview");

    expect(await limiter.consume("123:456", "2026-10-19T00:00:00Z")).toBe(true);
    expect(await limiter.consume("123:456", "2026-10-19T00:00:01Z")).toBe(false);
    expect(limit).toHaveBeenNthCalledWith(1, { key: "preview:123:456" });
    expect(limit).toHaveBeenNthCalledWith(2, { key: "preview:123:456" });
  });

  it("does not silently permit a request on binding failure", async () => {
    const failed = new Error("rate limit service unavailable");
    const binding = { limit: vi.fn(async () => { throw failed; }) } as unknown as RateLimit;
    await expect(createWorkersRateLimiter(binding, "production").consume("actor", "2026-10-19T00:00:00Z"))
      .rejects.toThrow("rate limit service unavailable");
  });
});
