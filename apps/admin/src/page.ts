import { escapeHtml } from "./presentation.js";
import type { ConsoleMode } from "./presentation.js";

/** Admin owns its HTML and styles; tenant gateway rendering is not bundled. */
export function page(
  title: string, body: string,
  options: { readonly layout?: "handoff"; readonly presentation?: { mode: ConsoleMode } } = {},
): Response {
  const mode = options.presentation?.mode ?? "desktop";
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="color-scheme" content="light">' +
    '<title>' + escapeHtml(title) + '</title>' +
    '<link rel="stylesheet" href="/assets/admin.css?ui=' + mode + '">' +
    '</head><body data-ui="' + mode + '">' +
    '<a class="skip-link" href="#main-content">Skip to main content</a>' +
    '<main id="main-content" class="page-shell">' + body + '</main></body></html>';
  return new Response(html, { headers: {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; style-src 'self'; script-src 'none'",
    "Referrer-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
  } });
}
