import { describe, expect, it } from "vitest";
import { canaryWaitSkipForm } from "./canary-wait-action.js";
import type { ConsoleReleaseStatus } from "./view-model.js";
const status: ConsoleReleaseStatus = {
  release: {id: "rel_test", version: "1.0.0", imageDigest: "sha256:" + "a".repeat(64), status: "candidate"},
  workflow: {state: "canary_observing", revision: 3, failureCode: null, attempts: 1,
    nextAttemptAt: null, canaryBuildKey: null, canaryOperationId: "op_test"}, build: null,
};
describe("Canary wait operator action", () => {
  it.each(["desktop", "mobile"] as const)("offers a reason and CSRF-protected form only during observation (%s)", mode => {
    const html = canaryWaitSkipForm(status, '<csrf"token>', mode);
    expect(html).toContain(`/releases/rel_test/skip-canary-wait?ui=${mode}`);
    expect(html).toContain('name="reason" required maxlength="200"');
    expect(html).toContain('name="expectedRevision" value="3"');
    expect(html).toContain('&lt;csrf&quot;token&gt;');
    expect(html).toContain("Safe stop and writer-absence verification still run");
    for(const state of ["queued", "canary_building", "canary_cleanup", "complete", "blocked"])
      expect(canaryWaitSkipForm({...status, workflow: {...status.workflow, state}}, "csrf", mode)).toBe("");
  });
});
