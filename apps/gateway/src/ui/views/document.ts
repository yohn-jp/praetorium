import { PORTAL_STYLES, PORTAL_STYLE_HASH } from "../styles.js";
import { localUrl, type PortalPresentation } from "../presentation.js";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function page(
  title: string,
  body: string,
  options: {
    readonly formAction?: string;
    readonly scriptNonce?: string;
    readonly presentation?: PortalPresentation;
  } = {},
): Response {
  const presentation = options.presentation ?? { mode: "desktop" };
  const home = localUrl("/", presentation.mode);
  const path = presentation.repositoryId
    ? `/repositories/${encodeURIComponent(presentation.repositoryId)}`
    : "/";
  const formAction = options.formAction ?? "'self'";
  const validNonce =
    options.scriptNonce && /^[A-Za-z0-9_-]{16,256}$/.test(options.scriptNonce)
      ? options.scriptNonce
      : undefined;
  const scriptPolicy = validNonce ? `; script-src 'nonce-${validNonce}'` : "";
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<meta name="color-scheme" content="light">` +
      `<title>${escapeHtml(title)}</title><style>${PORTAL_STYLES}</style></head><body data-ui="${presentation.mode}">` +
      `<a class="skip-link" href="#main-content">Skip to main content</a>` +
      `<header class="topbar"><div class="topbar-inner">` +
      `<a class="brand" href="${home}"><span class="brand-mark" aria-hidden="true">P</span><span>Praetorium</span></a>` +
      `<nav aria-label="Primary"><a href="${home}">Repositories</a></nav><nav aria-label="Presentation">${(["desktop", "mobile"] as const).map((mode) => `<a href="${localUrl(path, mode)}"${mode === presentation.mode ? ' aria-current="true"' : ""}>${mode === "desktop" ? "Desktop" : "Mobile"}</a>`).join(" ")}</nav></div></header>` +
      `<main id="main-content" class="page-shell">${body}</main>` +
      `<footer class="page-footer"><div class="footer-inner"><span>Praetorium repository workspace</span>` +
      `<span>Access is checked with your current GitHub permissions.</span></div></footer></body></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          `default-src 'none'; frame-ancestors 'none'; base-uri 'none'; ` +
          `form-action ${formAction}; style-src 'sha256-${PORTAL_STYLE_HASH}'${scriptPolicy}`,
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
