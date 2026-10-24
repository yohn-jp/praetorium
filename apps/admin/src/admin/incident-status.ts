import type { SourceBuildSummary } from "@praetorium/contracts";
import type { ConsoleRelease } from "./view-model.js";

/** Only a successful later revision of the same immutable Source target supersedes failure. */
export function activeSourceFailures(jobs: readonly SourceBuildSummary[]): readonly SourceBuildSummary[] {
  return jobs.filter(job => job.state === "failed" && !jobs.some(other =>
    other.sourceId === job.sourceId && other.releaseId === job.releaseId &&
    other.commit === job.commit && other.state === "admitted" && other.revision > job.revision));
}

/** Canonical terminal/superseded workflow state, never version ordering, resolves an incident. */
export function activeReleaseFailures(items: readonly ConsoleRelease[]): readonly ConsoleRelease[] {
  return items.filter(item => {
    const state = item.workflow?.workflow.state;
    return state === "blocked" || state === "failed" ||
      (state === "canary_cleanup" && !!item.workflow?.workflow.failureCode);
  });
}

/** Prioritize only unresolved failure evidence; keep terminal history inspectable elsewhere. */
export function prioritySourceBuild(jobs: readonly SourceBuildSummary[]): SourceBuildSummary | null {
  const unresolved = new Set(activeSourceFailures(jobs));
  const visible = jobs.filter(job => job.state !== "failed" || unresolved.has(job));
  const priority = ["failed", "building", "queued", "produced", "admitted"] as const;
  for (const state of priority) {
    const match = visible.find(job => job.state === state);
    if (match) return match;
  }
  return visible[0] ?? null;
}
