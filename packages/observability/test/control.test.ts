import { expect, it } from "vitest";
import { serializeControlEvent } from "../src/index.js";
it("rejects manuscript and credentials regardless of field names", () => {
  expect(() =>
    serializeControlEvent({ event: "operation", correlationId: "c", ...{ body: "draft" } }),
  ).toThrow();
  expect(() =>
    serializeControlEvent({ event: "operation", correlationId: "c", phase: "Bearer secret token" }),
  ).toThrow();
  expect(
    JSON.parse(
      serializeControlEvent({ event: "build.complete", correlationId: "c", durationMs: 100 }),
    ),
  ).toEqual({ event: "build.complete", correlationId: "c", durationMs: 100 });
});
