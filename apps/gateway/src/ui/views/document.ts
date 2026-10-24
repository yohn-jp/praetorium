import { portalStyles, PORTAL_STYLE_HASHES } from "../styles.js";
import { localUrl, type PortalPresentation } from "../presentation.js";

import { escapeHtml } from "../presentation.js";

export function page(
  title: string,
  body: string,
  options: {
    readonly formAction?: string;
    readonly scriptNonce?: string;
    readonly referrerPolicy?: "strict-origin";
    readonly layout?: "handoff";
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
  const showNavigation = options.layout !== "handoff";
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width, initial-scale=1">` +
      (options.referrerPolicy ? `<meta name="referrer" content="${options.referrerPolicy}">` : "") +
      `<meta name="color-scheme" content="light">` +
      `<title>${escapeHtml(title)}</title><style>${portalStyles(presentation.mode)}</style></head><body data-ui="${presentation.mode}">` +
      `<a class="skip-link" href="#main-content">Skip to main content</a>` +
      (showNavigation ? `<header class="topbar"><div class="topbar-inner">` +
      `<a class="brand" href="${home}"><span class="brand-mark" aria-hidden="true">P</span><span>Praetorium</span></a>` +
      `<nav aria-label="Primary"><a href="${home}">Repositories</a></nav><nav aria-label="Presentation">${(["desktop", "mobile"] as const).map((mode) => `<a data-ui-choice href="${localUrl(path, mode)}${presentation.repositoryQuery ? `&amp;q=${encodeURIComponent(presentation.repositoryQuery)}` : ""}"${mode === presentation.mode ? ' aria-current="true"' : ""}>${mode === "desktop" ? "Desktop" : "Mobile"}</a>`).join(" ")}</nav></div></header>` : "") +
      `<main id="main-content" class="page-shell">${body}</main>` +
      (showNavigation && presentation.offerModeChoice ? modeChoice(path, presentation.repositoryQuery) : "") +
      `${validNonce && showNavigation ? interactionScript(validNonce) : ""}` +
      (showNavigation ? `<footer class="page-footer"><div class="footer-inner"><span>Praetorium repository workspace</span>` +
      `<span>Access is checked with your current GitHub permissions.</span></div></footer>` : "") +
      `</body></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          `default-src 'none'; frame-ancestors 'none'; base-uri 'none'; ` +
          `form-action ${formAction}; style-src 'sha256-${PORTAL_STYLE_HASHES[presentation.mode]}'${scriptPolicy}`,
        "Referrer-Policy": options.referrerPolicy ?? "same-origin",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

/** CSS-only first-visit sheet: visible only to touch-sized devices, and each
 * decision writes the existing explicit UI preference cookie. No UA sniffing. */
function modeChoice(path: string, query?: string): string {
  const suffix = query ? "&amp;q=" + encodeURIComponent(query) : "";
  return '<aside class="mode-choice" role="dialog" aria-modal="false" aria-labelledby="mode-choice-title">' +
    '<span class="mode-choice-kicker">DISPLAY / PREFERENCE</span>' +
    '<h2 id="mode-choice-title">Choose your workspace layout</h2>' +
    '<p>A compact mobile workspace is available for this screen. Your choice is remembered.</p>' +
    '<div class="mode-choice-actions"><a class="button" href="' +
      localUrl(path, "mobile") + suffix + '">Use mobile layout</a>' +
    '<a class="button button-secondary" href="' + localUrl(path, "desktop") + suffix +
      '">Keep desktop</a></div></aside>';
}

/** Enhancement only: all navigation, labels and forms remain native without JS. */
function interactionScript(nonce: string): string {
  return `<script nonce="${escapeHtml(nonce)}">(()=>{
const form=document.querySelector('[data-configuration-form]');
let dirty=form?.dataset.dirty==='true';
const mark=()=>{dirty=true;form.dataset.dirty='true';const status=form.querySelector('[data-configuration-status]');if(status)status.textContent=document.querySelector('[data-portal-active-operation]')?'Automatic refresh paused while editing. Use Refresh status after finishing.':'Unsaved changes. Preview your selection before saving.';};
form?.addEventListener('input',mark);form?.addEventListener('change',mark);
addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
document.addEventListener('submit',event=>{if(event.defaultPrevented)return;if(event.target.dataset.submitting==='true'){event.preventDefault();return;}if(dirty&&event.target!==form&&!confirm('Discard unsaved configuration changes?')){event.preventDefault();return;}dirty=false;event.target.dataset.submitting='true';event.target.setAttribute('aria-busy','true');event.submitter?.setAttribute('aria-disabled','true');});
const canonical=new URL(location.href);const acceptedId=document.querySelector('[data-request-id]')?.dataset.requestId;if(acceptedId)canonical.searchParams.set('requestId',acceptedId);if(canonical.pathname.endsWith('/actions'))canonical.pathname=canonical.pathname.slice(0,-8);if(canonical.href!==location.href)history.replaceState(null,'',canonical);
const preserveSection=()=>{const section=['#overview','#configuration','#activity'].includes(location.hash)?location.hash:'';document.querySelectorAll('[data-ui-choice]').forEach(link=>{const url=new URL(link.href);url.hash=section;link.href=url.toString();});};
preserveSection();addEventListener('hashchange',()=>{preserveSection();const section=document.getElementById(location.hash.slice(1));if(section){section.tabIndex=-1;section.focus({preventScroll:true});}});
})();</script>`;
}
