/** Process-local hints only. Durable claim, lease and fencing remain in D1. */
export class WorkAvailability {
  private pending = false;
  private wake: (() => void) | undefined;

  notify(): void {
    this.pending = true;
    this.wake?.();
  }

  /** Retains notifications arriving during a claim, including before an empty result. */
  async wait(signal: AbortSignal, timeoutMs: number): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) {
      throw new TypeError("work recovery timeout must be between 1ms and one hour");
    }
    if (this.wake) throw new Error("work availability supports one consumer");
    if (signal.aborted) return;
    if (this.pending) {
      this.pending = false;
      return;
    }
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        this.wake = undefined;
        this.pending = false;
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      this.wake = finish;
      signal.addEventListener("abort", finish, { once: true });
    });
  }
}
