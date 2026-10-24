import { describe, expect, it } from "vitest";
import {
  admittedReleaseHref,
  compositionBuildHref,
  operationHref,
  sourceReleaseExecutionHref,
  stableReleaseHref,
  viewHref,
  type ConsoleViewModel,
} from "./view-model.js";

describe("authoritative execution navigation", () => {
  it("uses the immutable Source identity to open its recorded build lookup", () => {
    expect(sourceReleaseExecutionHref("scriptorium", 416422590, "mobile")).toBe(
      "/source-release-builds/scriptorium/416422590?ui=mobile",
    );
    expect(sourceReleaseExecutionHref("invalid/id", 416422590, "desktop")).toBe(
      "/releases?ui=desktop",
    );
  });

  it("keeps admission, composition, and Stable status on the canonical Release record", () => {
    const href = "/releases/release_123?ui=desktop";
    expect(admittedReleaseHref("release_123", "desktop")).toBe(href);
    expect(compositionBuildHref("release_123", "desktop")).toBe(href);
    expect(stableReleaseHref("release_123", "desktop")).toBe(href);
  });

  it("carries a validated Release return context when following the operation evidence link", () => {
    expect(operationHref("op_123", "mobile", "release_123")).toBe(
      "/operations/op_123?ui=mobile&release=release_123",
    );
    expect(operationHref("op_123", "mobile", "bad/release")).toBe("/operations/op_123?ui=mobile");
  });

  it("preserves the related Release when an operator switches UI mode on operation evidence", () => {
    const model = {
      section: "releases",
      mode: "desktop",
      csrf: "",
      notice: null,
      catalog: { endpoint: "", status: 200, code: null, value: null },
      sourceViews: { endpoint: "", status: 200, code: null, value: null },
      builds: { endpoint: "", status: 200, code: null, value: null },
      audit: { endpoint: "", status: 200, code: null, value: null },
      detail: null,
      selectedBuildId: null,
      selectedOperationId: "op_123",
      relatedReleaseId: "release_123",
      buildStateFilter: null,
      auditQuery: "",
    } as ConsoleViewModel;
    expect(viewHref(model, "mobile")).toBe("/operations/op_123?ui=mobile&release=release_123");
  });
});
