import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkAvailability } from "./work-availability.js";

describe("work notification recovery", () => {
  afterEach(() => vi.useRealTimers());

  it("retains a notification racing with an empty claim and coalesces duplicates", async () => {
    vi.useFakeTimers();
    const work = new WorkAvailability();
    const controller = new AbortController();
    work.notify();
    work.notify();
    await work.wait(controller.signal, 300_000);
    let recovered = false;
    const waiting = work.wait(controller.signal, 300_000).then(() => (recovered = true));
    await vi.advanceTimersByTimeAsync(299_999);
    expect(recovered).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(recovered).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("wakes an idle consumer immediately and cleans up on shutdown", async () => {
    vi.useFakeTimers();
    const work = new WorkAvailability();
    const controller = new AbortController();
    const waiting = work.wait(controller.signal, 300_000);
    work.notify();
    await waiting;
    expect(vi.getTimerCount()).toBe(0);
    const shutdown = work.wait(controller.signal, 300_000);
    controller.abort();
    await shutdown;
    expect(vi.getTimerCount()).toBe(0);
    await work.wait(controller.signal, 300_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
