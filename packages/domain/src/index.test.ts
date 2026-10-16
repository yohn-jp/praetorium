import { expect, it } from "vitest";
import { canRetire } from "./index.js";
it("unpublished or uncertain work cannot be retired", () => {
  const safe = {
    disposition: "safe" as const,
    activeMutations: 0,
    activeJobs: 0,
    unpublishedCheckpoints: 0,
    uncertainPublication: false,
  };
  expect(canRetire(safe)).toBe(true);
  for (const change of [
    { activeMutations: 1 },
    { activeJobs: 1 },
    { unpublishedCheckpoints: 1 },
    { uncertainPublication: true },
    { disposition: "unknown" as const },
  ])
    expect(canRetire({ ...safe, ...change })).toBe(false);
});
