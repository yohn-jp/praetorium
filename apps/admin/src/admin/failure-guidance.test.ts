import { describe, expect, it } from "vitest";
import { CANARY_CONFIGURATION_CONFLICT, failureGuidance } from "./failure-guidance.js";

describe("canonical failure guidance", () => {
  it("explains only the classified Canary configuration conflict", () => {
    expect(failureGuidance(CANARY_CONFIGURATION_CONFLICT)).toBe(
      "Canary configuration changed or an operation is still active; inspect the current operation and let normal recovery finish before automatic retry.",
    );
  });

  it("leaves generic failure codes to the existing fallback", () => {
    expect(failureGuidance("promotion_step_failed")).toBeNull();
    expect(failureGuidance(null)).toBeNull();
  });
});
