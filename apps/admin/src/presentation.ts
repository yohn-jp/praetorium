export type ConsoleMode = "desktop" | "mobile";
export function escapeHtml(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&#39;");
}
const COOKIE = "praetorium_ui";
export function resolvePresentation(request: Request): { readonly mode: ConsoleMode; readonly cookie?: string; readonly offerModeChoice: boolean } {
  const url = new URL(request.url);
  const choices = url.searchParams.getAll("ui");
  const explicit = choices.length === 1 ? choices[0] : undefined;
  const parts = (request.headers.get("Cookie") ?? "").split(";").map(p => p.trim());
  const preferences = parts.filter(p => p.startsWith(COOKIE + "="));
  const stored = preferences.length === 1 ? preferences[0]!.slice(COOKIE.length + 1) : "";
  const valid = (value: string | undefined): value is ConsoleMode => value === "desktop" || value === "mobile";
  if (valid(explicit)) return { mode: explicit,
    cookie: COOKIE + "=" + explicit + "; Path=/; Secure; SameSite=Lax", offerModeChoice: false };
  return { mode: valid(stored) ? stored : "desktop", offerModeChoice: !valid(stored) };
}
