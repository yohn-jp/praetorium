import { describe, expect, it } from "vitest";
import { packageBoundary } from "../src/index.js";

describe("observability package", () => {
  it("exposes its package boundary", () => {
    expect(packageBoundary).toBe("observability");
  });
});
