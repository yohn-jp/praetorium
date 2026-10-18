/** Presentation metadata never enters the domain command contract. */
export type PortalUiMode = "desktop" | "mobile";
export interface PortalPresentation {
  readonly mode: PortalUiMode;
  readonly repositoryId?: string;
}
const COOKIE = "praetorium_ui";
function isMode(value: string | undefined): value is PortalUiMode {
  return value === "desktop" || value === "mobile";
}
export function resolvePresentation(request: Request): {
  readonly mode: PortalUiMode;
  readonly cookie?: string;
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
    };
  return { mode: isMode(preference) ? preference : "desktop" };
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
  readonly current: string;
  readonly desired: string;
  readonly policy: string;
  readonly configuration: string;
  readonly limits: string;
  readonly preview: string;
  readonly operations: string;
  readonly redeploy: string;
}
