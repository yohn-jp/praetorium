import { describe, expect, it } from "vitest";
import { createGatewayRouter } from "../src/index.js";

describe("Gateway package boundary", () => {
  it("exports the mounted HTTP router", () => {
    expect(createGatewayRouter).toBeTypeOf("function");
  });
});
