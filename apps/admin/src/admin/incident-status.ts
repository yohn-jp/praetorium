import type { SourceBuildSummary } from "@praetorium/contracts";
import type { ConsoleRelease } from "./view-model.js";

/** Compare validated version precedence; malformed versions never supersede evidence. */
function semver(version: string): { core: readonly bigint[]; prerelease: readonly string[] | null } | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.exec(version);
  if (!match) return null;
  return {
    core: [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)],
    prerelease: match[4] ? match[4].split(".") : null,
  };
}

function compareVersion(left: string, right: string): number | null {
  const a = semver(left), b = semver(right);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i++) {
    if (a.core[i]! !== b.core[i]!) return a.core[i]! > b.core[i]! ? 1 : -1;
  }
  if (a.prerelease === null || b.prerelease === null) {
    return a.prerelease === b.prerelease ? 0 : a.prerelease === null ? 1 : -1;
  }
  const n = Math.min(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < n; i++) {
    const x = a.prerelease[i]!, y = b.prerelease[i]!;
    if (x === y) continue;
    const xn = /^(0|[1-9]\d*)$/u.test(x), yn = /^(0|[1-9]\d*)$/u.test(y);
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return a.prerelease.length === b.prerelease.length ? 0
    : a.prerelease.length > b.prerelease.length ? 1 : -1;
}

/** A newer *admitted Source* supersedes older Source job failures, not Stable status. */
export function activeSourceFailures(jobs: readonly SourceBuildSummary[]): readonly SourceBuildSummary[] {
  return jobs.filter(job => job.state === "failed" && !jobs.some(other =>
    other.sourceId === job.sourceId && other.state === "admitted" &&
    (compareVersion(other.version, job.version) ?? 0) > 0));
}

/** Obsolete failed candidate workflows remain in Releases/Audit history, not current incidents. */
export function activeReleaseFailures(items: readonly ConsoleRelease[]): readonly ConsoleRelease[] {
  return items.filter(item => {
    const state = item.workflow?.workflow.state;
    const isIncident = state === "blocked" || state === "failed" ||
      (state === "canary_cleanup" && !!item.workflow?.workflow.failureCode);
    if (!isIncident) return false;
    return !items.some(other => {
      const newerState = other.workflow?.workflow.state;
      return (compareVersion(other.release.version, item.release.version) ?? 0) > 0 &&
        newerState !== undefined && !["blocked", "failed", "rejected", "superseded"].includes(newerState);
    });
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
