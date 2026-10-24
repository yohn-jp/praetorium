import type { SourceBuildDetail, SourceBuildSummary } from "@praetorium/contracts";
import type { SourceReleaseView } from "./release-sources.js";
import type { InfraDependencies, InfraHosts, InfraServices, HostObservation } from "../infrastructure.js";

export type ConsoleSection = "overview" | "infrastructure" | "releases" | "builds" | "audit";
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
  readonly actorId: string | null; readonly action: string; readonly outcome: string;
  readonly occurredAt: number;
  readonly eventId?: string;
  readonly jobId?: string | null; readonly releaseId?: string | null;
  readonly operationId?: string | null; readonly failureCode?: string | null;
  readonly revision?: number | null; readonly leaseEpoch?: number | null;
}
export interface OperatorOperationDetail {
  readonly operation: {
    id:string; instanceId:string; generation:number; runtimeEpoch:number;
    kind:string; status:string; phase:string; attempt:number;
    createdAt:number; updatedAt:number;
  };
  readonly readinessEvidence: unknown | null;
  readonly rollbackCompatibilityEvidence: unknown | null;
  readonly rollbackCompatible: boolean | null;
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
  readonly selectedOperationId?: string | null;
  /** Read-only return context from the canonical workflow that linked to this operation. */
  readonly relatedReleaseId?: string | null;
  readonly operationDetail?: ConsoleDependency<OperatorOperationDetail> | null;
  readonly releaseDetail?: ConsoleDependency<ConsoleReleaseStatus> | null;
  readonly pageCursor?: string | null;
  readonly buildStateFilter: string | null;
  readonly buildSort?: "recent" | "source" | "state" | "attempt";
  readonly auditQuery: string;
  readonly infrastructure?: ConsoleDependency<InfraHosts> | null;
  readonly selectedHostId?: string | null;
  readonly hostDetail?: ConsoleDependency<HostObservation> | null;
  readonly hostServices?: ConsoleDependency<InfraServices> | null;
  readonly dependenciesSelected?: boolean;
  readonly dependencies?: ConsoleDependency<InfraDependencies> | null;
}
export function consoleHref(section: ConsoleSection, mode: ConsoleMode): string {
  return (section === "overview" ? "/" : "/" + section) + "?ui=" + mode;
}
export function buildHref(id: string, mode: ConsoleMode): string {
  return "/builds/" + encodeURIComponent(id) + "?ui=" + mode;
}

const RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const SOURCE_ID = /^[a-z][a-z0-9-]{0,31}$/u;

export function sourceReleaseExecutionHref(sourceId:string,githubReleaseId:number,mode:ConsoleMode):string {
  if(!SOURCE_ID.test(sourceId)||!Number.isSafeInteger(githubReleaseId)||githubReleaseId<=0)
    return consoleHref("releases",mode);
  return "/source-release-builds/"+encodeURIComponent(sourceId)+"/"+githubReleaseId+"?ui="+mode;
}

export function admittedReleaseHref(releaseId:string,mode:ConsoleMode):string {
  return "/releases/"+encodeURIComponent(releaseId)+"?ui="+mode;
}

/** Composition status belongs to its canonical Release workflow read model. */
export function compositionBuildHref(releaseId:string,mode:ConsoleMode):string {
  return admittedReleaseHref(releaseId,mode);
}

/** Stable channel pointers name a canonical Release; its detail is the status authority. */
export function stableReleaseHref(releaseId:string,mode:ConsoleMode):string {
  return admittedReleaseHref(releaseId,mode);
}

/** Preserve existing bounded op_ IDs while accepting the canonical system operation UUID. */
export function isOperationId(id: string): boolean {
  return /^op_[A-Za-z0-9_.:-]{1,124}$/u.test(id) ||
    /^operation_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(id);
}

export function canRequestCanaryRecovery(workflow: {
  state: string; failureCode: string | null; revision: number;
} | null | undefined): boolean {
  return !!workflow && workflow.state === "rejected" && Number.isSafeInteger(workflow.revision) &&
    workflow.revision >= 0 && ["canary_assignment_superseded", "canary_operation_failed", "canary_stop_blocked"]
      .includes(workflow.failureCode ?? "");
}

export function operationHref(id:string, mode:ConsoleMode, relatedReleaseId?:string|null):string {
  if (!isOperationId(id)) return consoleHref("releases", mode);
  const params=new URLSearchParams({ui:mode});
  if(relatedReleaseId&&RELEASE_ID.test(relatedReleaseId))params.set("release",relatedReleaseId);
  return "/operations/" + encodeURIComponent(id) + "?" + params.toString();
}

/** Preserve the current authorized read context when switching UI composition. */
export function viewHref(model: ConsoleViewModel, mode: ConsoleMode): string {
  const params = new URLSearchParams({ ui: mode });
  if (model.selectedOperationId) return operationHref(model.selectedOperationId, mode,model.relatedReleaseId);
  if (model.selectedReleaseId)
    return "/releases/" + encodeURIComponent(model.selectedReleaseId) + "?" + params.toString();
  if (model.selectedBuildId) {
    if (model.pageCursor) params.set("cursor", model.pageCursor);
    return "/builds/" + encodeURIComponent(model.selectedBuildId) + "?" + params.toString();
  }
  if (model.selectedHostId)
    return "/infrastructure/hosts/" + encodeURIComponent(model.selectedHostId) + "?" + params.toString();
  if (model.dependenciesSelected) return "/infrastructure/dependencies?" + params.toString();
  if (model.section === "builds") {
    if (model.buildSort && model.buildSort !== "recent") params.set("sort", model.buildSort);
    if (model.buildStateFilter) params.set("state", model.buildStateFilter);
  } else if (model.section === "audit" && model.auditQuery) params.set("q", model.auditQuery);
  if (model.pageCursor && ["builds", "audit", "releases"].includes(model.section))
    params.set("cursor", model.pageCursor);
  const pathname = model.section === "overview" ? "/" : "/" + model.section;
  return pathname + "?" + params.toString();
}
