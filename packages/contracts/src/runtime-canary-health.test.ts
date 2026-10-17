import { describe, expect, it } from "vitest";
import { RuntimeCanaryHealthDueResponseSchema } from "./runtime-canary-health.js";

describe("explicit canary health deadlines", () => {
  it("requires a fixed persisted token for each due sample", () => {
    const due = { active: true, nextCheckAt: 1000, sampleDueAt: 1000, healthOperationId: "op-1" };
    expect(RuntimeCanaryHealthDueResponseSchema.safeParse(due).success).toBe(true);
    expect(
      RuntimeCanaryHealthDueResponseSchema.safeParse({ ...due, sampleDueAt: 999 }).success,
    ).toBe(true);
    expect(
      RuntimeCanaryHealthDueResponseSchema.safeParse({ ...due, sampleDueAt: 1001 }).success,
    ).toBe(false);
    expect(
      RuntimeCanaryHealthDueResponseSchema.safeParse({ ...due, healthOperationId: null }).success,
    ).toBe(false);
    expect(RuntimeCanaryHealthDueResponseSchema.safeParse({ ...due, active: false }).success).toBe(
      false,
    );
    expect(
      RuntimeCanaryHealthDueResponseSchema.safeParse({
        active: false,
        nextCheckAt: null,
        sampleDueAt: null,
        healthOperationId: null,
      }).success,
    ).toBe(true);
  });
});
