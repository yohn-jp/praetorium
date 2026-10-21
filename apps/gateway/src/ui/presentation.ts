import type {
  PortalRepositorySummary,
  PortalOperation,
  PortalResources,
  PortalRepositoryDashboard,
  PortalCommand,
} from "./types.js";

/** Presentation metadata never enters the domain command contract. */
export type PortalUiMode = "desktop" | "mobile";
export interface PortalPresentation {
  readonly mode: PortalUiMode;
  readonly repositoryId?: string;
  /** Offer a choice only when the visitor has not selected either presentation. */
  readonly offerModeChoice?: boolean;
}
const COOKIE = "praetorium_ui";
function isMode(value: string | undefined): value is PortalUiMode {
  return value === "desktop" || value === "mobile";
}
export function resolvePresentation(request: Request): {
  readonly mode: PortalUiMode;
  readonly cookie?: string;
  readonly offerModeChoice: boolean;
} {
  const url = new URL(request.url);
  const choices = url.searchParams.getAll("ui");
  const cookies = (request.headers.get("Cookie") ?? "")
    .split(";")
    .map((part) => part.trim().split("="));
  const preferences = cookies.filter(([name]) => name === COOKIE);
  const preference =
    preferences.length === 1 && preferences[0]?.length === 2 ? preferences[0][1] : undefined;
  const explicit = choices.length === 1 ? choices[0] : undefined;
  if (isMode(explicit))
    return {
      mode: explicit,
      cookie: `${COOKIE}=${explicit}; Path=/; SameSite=Lax${url.protocol === "https:" ? "; Secure" : ""}`,
      offerModeChoice: false,
    };
  return { mode: isMode(preference) ? preference : "desktop",
    offerModeChoice: !isMode(preference) };
}
/** Accept only application paths supplied by the renderer; never external URLs. */
export function localUrl(path: string, mode: PortalUiMode): string {
  if (!path.startsWith("/") || path.startsWith("//") || /[?#\\]/.test(path))
    throw new Error("Invalid portal path");
  return `${path}?ui=${mode}`;
}

/** Escaped HTML fragments produced by the shared renderer; compositions only arrange them. */
export interface RepositoryRowView {
  readonly identity: string;
  readonly runtime: string;
  readonly access: string;
  readonly installation: string;
  readonly reason: string;
  readonly operation: string;
  readonly revisions: string;
  readonly actions: string;
}
export interface RepositoryListView {
  readonly heading: string;
  readonly connection: string;
  readonly rows: readonly RepositoryRowView[];
  readonly empty: string;
}
export interface RepositoryDetailView {
  readonly heading: string;
  readonly runtime: string;
  readonly access: string;
  /** Latest authoritative operation summary; purely presentational, when available. */
  readonly evidence?: string;
  readonly current: string;
  readonly desired: string;
  readonly policy: string;
  readonly configuration: string;
  readonly limits: string;
  readonly preview: string;
  readonly operations: string;
  readonly redeploy: string;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function installationLabel(state: PortalRepositorySummary["installation"]): string {
  switch (state) {
    case "active":
      return "Active";
    case "pending":
      return "Setup pending";
    case "suspended":
      return "Suspended";
    case "removed":
      return "Not installed";
    case "unknown":
      return "Status unavailable";
  }
}

export function permissionLabel(permission: PortalRepositorySummary["permission"]): string {
  switch (permission) {
    case "none":
      return "No access";
    case "read":
      return "Read access";
    case "write":
      return "Write access";
    case "maintain":
      return "Maintain access";
    case "admin":
      return "Admin access";
    case "unknown":
      return "Access status unavailable";
  }
}

export function instanceStateLabel(state: PortalRepositorySummary["instance"]["state"]): string {
  switch (state) {
    case "ready":
      return "Ready";
    case "starting":
      return "Starting";
    case "stopped":
      return "Stopped";
    case "failed":
      return "Failed";
    case "blocked":
      return "Blocked";
    case "unknown":
      return "Status unavailable";
  }
}

export function statusTone(state: string): string {
  if (["active", "ready", "succeeded", "valid", "write", "maintain", "admin"].includes(state))
    return "status-good";
  if (
    ["pending", "starting", "queued", "running", "blocked", "unknown", "unavailable"].includes(
      state,
    )
  )
    return "status-warn";
  if (
    ["suspended", "removed", "failed", "canceled", "cancelled", "unsupported", "none"].includes(
      state,
    )
  )
    return "status-bad";
  return "status-neutral";
}

export function statusBadge(label: string, state: string): string {
  return `<span class="status-badge ${statusTone(state)}">${escapeHtml(label)}</span>`;
}

export function operationStateLabel(state: PortalOperation["state"]): string {
  switch (state) {
    case "queued":
      return "Queued";
    case "running":
      return "In progress";
    case "succeeded":
      return "Complete";
    case "failed":
      return "Failed";
    case "blocked":
      return "Blocked";
    case "canceled":
      return "Canceled";
    case "unknown":
      return "Status unavailable";
  }
}

export function image(value: string | null): string {
  return value ? escapeHtml(value) : "Not built";
}

export function shortDigest(value: string): string {
  const algorithmPrefix = "sha256:";
  if (value.startsWith(algorithmPrefix) && value.length > algorithmPrefix.length + 12) {
    return `${algorithmPrefix}${value.slice(algorithmPrefix.length, algorithmPrefix.length + 12)}…`;
  }
  return value.length > 24 ? `${value.slice(0, 21)}…` : value;
}

export function safeCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function cpu(value: number): string {
  return safeCount(value) ? `${(value / 1000).toFixed(2)} vCPU` : "Unavailable";
}

export function memory(value: number): string {
  if (!safeCount(value)) return "Unavailable";
  return value >= 1024 ? `${(value / 1024).toFixed(1)} GiB` : `${value} MiB`;
}

export function resources(value: PortalResources): string {
  return (
    `<dl class="resource-facts">` +
    `<div class="fact"><dt>CPU</dt><dd>${cpu(value.cpuMilli)}</dd></div>` +
    `<div class="fact"><dt>Memory</dt><dd>${memory(value.memoryMiB)}</dd></div>` +
    `<div class="fact"><dt>Ephemeral storage</dt><dd>${memory(value.ephemeralStorageMiB)}</dd></div></dl>`
  );
}

export function moduleNames(ids: readonly string[], dashboard: PortalRepositoryDashboard): string {
  if (ids.length === 0) return "None";
  const options = new Map(dashboard.modules.map((module) => [module.moduleId, module]));
  return ids
    .map((id) => {
      const option = options.get(id);
      return option
        ? `${escapeHtml(option.label)} (${escapeHtml(option.version)})`
        : escapeHtml(id);
    })
    .join(", ");
}

export type ConfigurationSelection = Omit<Extract<PortalCommand, { kind: "preview" }>, "kind">;
