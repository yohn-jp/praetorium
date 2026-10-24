import { describe, expect, it } from "vitest";
import {
  admittedReleaseHref,
  compositionBuildHref,
  isOperationId,
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
    const operation = "op_01J9Z7H3M4P6Q8R2S5T0V1WXYZ";
    const systemOperation = "operation_7e53e854-11d8-4722-b8d5-278a796a47d4";
    expect(isOperationId(operation)).toBe(true);
    expect(isOperationId("op_123")).toBe(true);
    expect(isOperationId(systemOperation)).toBe(true);
    expect(isOperationId("operation_" + "a".repeat(129))).toBe(false);
    expect(isOperationId("op_" + "a".repeat(125))).toBe(false);
    expect(isOperationId("op_123/../../audit")).toBe(false);
    expect(operationHref(operation, "mobile", "release_123")).toBe(
      "/operations/" + operation + "?ui=mobile&release=release_123",
    );
    expect(operationHref(systemOperation, "desktop", "release_123")).toBe(
      "/operations/" + systemOperation + "?ui=desktop&release=release_123",
    );
    expect(operationHref("bad/release", "mobile")).toBe("/releases?ui=mobile");
    expect(operationHref(operation, "mobile", "bad/release")).toBe("/operations/" + operation + "?ui=mobile");
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
      selectedOperationId: "op_01J9Z7H3M4P6Q8R2S5T0V1WXYZ",
      relatedReleaseId: "release_123",
      buildStateFilter: null,
      auditQuery: "",
    } as ConsoleViewModel;
    expect(viewHref(model, "mobile")).toBe("/operations/op_01J9Z7H3M4P6Q8R2S5T0V1WXYZ?ui=mobile&release=release_123");
  });
});
