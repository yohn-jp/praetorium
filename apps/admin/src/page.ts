import { escapeHtml } from "./presentation.js";
import type { ConsoleMode } from "./presentation.js";

/** Admin owns its HTML and styles; tenant gateway rendering is not bundled. */
export function page(
  title: string, body: string,
  options: { readonly layout?: "handoff"; readonly presentation?: { mode: ConsoleMode; offerModeChoice?: boolean; mobileHref?: string; desktopHref?: string } } = {},
): Response {
  const mode = options.presentation?.mode ?? "desktop";
  const choice = options.presentation?.offerModeChoice &&
    options.presentation.mobileHref && options.presentation.desktopHref
    ? '<aside class="mode-choice" role="dialog" aria-modal="false" aria-labelledby="mode-choice-title">' +
      '<span class="mode-choice-kicker">DISPLAY / PREFERENCE</span>' +
      '<h2 id="mode-choice-title">Choose your workspace layout</h2>' +
      '<p>A compact mobile workspace is available. Your explicit choice is remembered.</p>' +
      '<div class="mode-choice-actions"><a class="button" href="' +
      escapeHtml(options.presentation.mobileHref) + '">Use mobile layout</a>' +
      '<a class="button button-secondary" href="' +
      escapeHtml(options.presentation.desktopHref) + '">Keep desktop</a></div></aside>'
    : "";

  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="color-scheme" content="light">' +
    '<title>' + escapeHtml(title) + '</title>' +
    '<link rel="stylesheet" href="/assets/admin.css?ui=' + mode + '">' +
    '</head><body data-ui="' + mode + '">' +
    '<a class="skip-link" href="#main-content">Skip to main content</a>' +
    '<main id="main-content" class="page-shell">' + body + '</main>' + choice + '</body></html>';
  return new Response(html, { headers: {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; style-src 'self'; script-src 'none'",
    "Referrer-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
  } });
}
