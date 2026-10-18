import { portalStyles, PORTAL_STYLE_HASHES } from "../styles.js";
import { localUrl, type PortalPresentation } from "../presentation.js";

import { escapeHtml } from "../presentation.js";

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
      `<title>${escapeHtml(title)}</title><style>${portalStyles(presentation.mode)}</style></head><body data-ui="${presentation.mode}">` +
      `<a class="skip-link" href="#main-content">Skip to main content</a>` +
      `<header class="topbar"><div class="topbar-inner">` +
      `<a class="brand" href="${home}"><span class="brand-mark" aria-hidden="true">P</span><span>Praetorium</span></a>` +
      `<nav aria-label="Primary"><a href="${home}">Repositories</a></nav><nav aria-label="Presentation">${(["desktop", "mobile"] as const).map((mode) => `<a data-ui-choice href="${localUrl(path, mode)}"${mode === presentation.mode ? ' aria-current="true"' : ""}>${mode === "desktop" ? "Desktop" : "Mobile"}</a>`).join(" ")}</nav></div></header>` +
      `<main id="main-content" class="page-shell">${body}</main>` +
      `${validNonce ? interactionScript(validNonce) : ""}` +
      `<footer class="page-footer"><div class="footer-inner"><span>Praetorium repository workspace</span>` +
      `<span>Access is checked with your current GitHub permissions.</span></div></footer></body></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          `default-src 'none'; frame-ancestors 'none'; base-uri 'none'; ` +
          `form-action ${formAction}; style-src 'sha256-${PORTAL_STYLE_HASHES[presentation.mode]}'${scriptPolicy}`,
        "Referrer-Policy": "same-origin",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

/** Enhancement only: all navigation, labels and forms remain native without JS. */
function interactionScript(nonce: string): string {
  return `<script nonce="${escapeHtml(nonce)}">(()=>{
const form=document.querySelector('[data-configuration-form]');
let dirty=form?.dataset.dirty==='true';
const mark=()=>{dirty=true;form.dataset.dirty='true';const status=document.querySelector('[data-portal-active-operation] p');if(status)status.textContent='Automatic refresh paused while editing. Use Refresh status after finishing.';};
form?.addEventListener('input',mark);form?.addEventListener('change',mark);
addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
document.addEventListener('submit',event=>{if(dirty&&event.target!==form&&!confirm('Discard unsaved configuration changes?')){event.preventDefault();return;}dirty=false;});
const preserveSection=()=>{const section=['#overview','#configuration','#activity'].includes(location.hash)?location.hash:'';document.querySelectorAll('[data-ui-choice]').forEach(link=>{const url=new URL(link.href);url.hash=section;link.href=url.toString();});};
preserveSection();addEventListener('hashchange',preserveSection);
})();</script>`;
}
