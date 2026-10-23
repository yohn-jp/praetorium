import type { SourceBuildDetail, SourceBuildSummary } from "@praetorium/contracts";
import type { SourceReleaseView } from "./release-sources.js";

export type ConsoleSection = "overview" | "releases" | "builds" | "audit";
export type ConsoleMode = "desktop" | "mobile";
export interface ConsoleDependency<T> {
  readonly endpoint: string;
  readonly status: number | null;
  readonly code: string | null;
  readonly reason?: string | null;
  readonly value: T | null;
}
export interface ConsoleRelease {
  readonly release: { id: string; version: string; imageDigest: string; status: string; createdAt: string };
  readonly workflow: {
    workflow: { state: string; revision: number; failureCode: string | null; attempts: number; nextAttemptAt: number | null };
    build: { status: string; failure: { code: string } | null } | null;
  } | null;
}
export interface ConsoleReleaseStatus {
  readonly release: { id: string; version: string; imageDigest: string; status: string };
  readonly workflow: { state: string; revision: number; failureCode: string | null; attempts: number;
    nextAttemptAt: number | null; canaryBuildKey?: string | null; canaryOperationId?: string | null };
  readonly build: { id: string; status: string; attemptCount: number;
    failure: { code: string; retryable: boolean } | null } | null;
}
export interface ConsoleAuditEvent {
  readonly actorId: string | null;
  readonly action: string;
  readonly outcome: string;
  readonly occurredAt: number;
}
/** Presentation only. Authorization, data loading and mutations stay in console.ts. */
export interface ConsoleViewModel {
  readonly section: ConsoleSection;
  readonly mode: ConsoleMode;
  readonly csrf: string;
  readonly notice: string | null;
  readonly catalog: ConsoleDependency<{
    items: ConsoleRelease[]; nextCursor?: string | null;
    stableChannel?: { currentReleaseId: string | null; revision: number } | null;
  }>;
  readonly sourceViews: ConsoleDependency<readonly SourceReleaseView[]>;
  readonly builds: ConsoleDependency<{ items: SourceBuildSummary[]; nextCursor?: string | null }>;
  readonly audit: ConsoleDependency<{ events: ConsoleAuditEvent[]; nextCursor?: string | null }>;
  readonly detail: ConsoleDependency<SourceBuildDetail> | null;
  readonly selectedBuildId: string | null;
  readonly selectedReleaseId?: string | null;
  readonly releaseDetail?: ConsoleDependency<ConsoleReleaseStatus> | null;
  readonly buildStateFilter: string | null;
  readonly buildSort?: "recent" | "source" | "state" | "attempt";
  readonly auditQuery: string;
}
export function consoleHref(section: ConsoleSection, mode: ConsoleMode): string {
  return (section === "overview" ? "/" : "/" + section) + "?ui=" + mode;
}
export function buildHref(id: string, mode: ConsoleMode): string {
  return "/builds/" + encodeURIComponent(id) + "?ui=" + mode;
}
