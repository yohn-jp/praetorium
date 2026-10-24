import { describe, expect, it } from "vitest";
import { adminReturnPath } from "./redirect-allowlist.js";

describe("Admin workflow return targets", () => {
  it("preserves only the bounded Source execution and operation-to-Release paths", () => {
    expect(adminReturnPath("/source-release-builds/scriptorium/416422590?ui=mobile")).toBe(
      "/source-release-builds/scriptorium/416422590?ui=mobile",
    );
    expect(adminReturnPath("/operations/op_123?ui=desktop&release=release_123")).toBe(
      "/operations/op_123?ui=desktop&release=release_123",
    );
  });

  it("rejects invalid identifiers, repeated context, and context on other pages", () => {
    for (const target of [
      "/source-release-builds/scriptorium/0?ui=mobile",
      "/operations/op_123?ui=mobile&release=https://outside.test",
      "/operations/op_123?ui=mobile&release=release_123&release=release_456",
      "/builds?ui=mobile&release=release_123",
    ])
      expect(adminReturnPath(target)).toBe("/");
  });
});
