import { EVIDENCE_LEDGER_LIST_STYLES } from "./views/repository-ledger-list.js";
import { EVIDENCE_LEDGER_STYLES } from "./views/evidence-ledger.js";
import { DESKTOP_STYLES } from "./views/desktop.js";
import { MOBILE_STYLES } from "./views/mobile.js";
import type { PortalUiMode } from "./presentation.js";

/** Common controls and tokens. Composition styles are assembled per selected UI mode. */
export const PORTAL_STYLES = `
:root { color-scheme:light; font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans JP",sans-serif; color:#18212f; background:#f6f7f9; font-synthesis:none; --ink:#18212f; --muted:#526071; --line:#dfe4eb; --surface:#fff; --surface-soft:#f0f2f5; --brand:#244fc6; --brand-dark:#1c3ea0; --good:#16664b; --good-soft:#ecf6f0; --warn:#875507; --warn-soft:#fff6e6; --bad:#aa3037; --bad-soft:#fff0f0; }
* { box-sizing:border-box; }
body { min-width:320px; margin:0; font-size:14px; line-height:1.55; }
body[data-ui="mobile"] { font-size:16px; }
a { color:var(--brand-dark); text-underline-offset:.18em; }
a:hover { text-decoration:underline; }
:focus-visible { outline:3px solid #244fc6; outline-offset:3px; }
.skip-link { position:absolute; z-index:5; top:8px; left:8px; transform:translateY(-180%); padding:8px 12px; background:#fff; }
.skip-link:focus { transform:none; }
.topbar { background:#fff; border-bottom:1px solid var(--line); }
.topbar-inner,.page-shell,.footer-inner { max-width:1280px; margin-inline:auto; padding-inline:32px; }
.topbar-inner { min-height:56px; display:flex; align-items:center; gap:24px; }
.brand { display:inline-flex; align-items:center; gap:8px; color:var(--ink); font-size:16px; font-weight:750; text-decoration:none; }
.brand-mark { display:grid; place-items:center; width:28px; height:28px; border-radius:6px; background:var(--brand); color:#fff; }
.topbar nav { display:flex; align-items:center; gap:12px; }
.topbar nav:last-child { margin-left:auto; }
.topbar nav a { display:inline-flex; align-items:center; min-height:44px; font-size:13px; text-decoration:none; }
.topbar nav [aria-current] { font-weight:750; text-decoration:underline; text-underline-offset:6px; }
.page-shell { min-height:calc(100vh - 120px); padding-block:32px 48px; }
h1,h2,h3,h4 { line-height:1.3; color:var(--ink); }
h1 { margin:0; font-size:28px; font-weight:650; letter-spacing:-.035em; overflow-wrap:anywhere; }
h2 { margin:0 0 12px; font-size:18px; font-weight:650; }
h3 { margin:0 0 12px; font-size:16px; font-weight:650; }
h4 { margin:16px 0 8px; font-size:14px; }
p { margin:8px 0; }
section,article,aside,header,form,div { min-width:0; }
.page-heading { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:16px; margin-bottom:24px; }
.page-heading p { color:var(--muted); }
.breadcrumb { margin-bottom:16px; font-size:13px; overflow-wrap:anywhere; }
.eyebrow { display:none; }
.muted,.field-help,.empty-state { color:var(--muted); }
.field-help { font-size:13px; font-weight:400; }
.status-badge { display:inline-flex; align-items:center; min-height:26px; max-width:100%; padding:3px 8px; border-radius:999px; font-size:12px; font-weight:650; overflow-wrap:anywhere; }
.status-good { color:var(--good); background:var(--good-soft); }
.status-warn { color:var(--warn); background:var(--warn-soft); }
.status-bad { color:var(--bad); background:var(--bad-soft); }
.status-neutral { color:var(--muted); background:var(--surface-soft); }
.status-panel { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:12px 16px; margin-bottom:24px; border-bottom:1px solid var(--line); background:#fff; }
.status-panel h2 { font-size:14px; margin:0; }
.status-panel p { margin:4px 0; }
.button,button { display:inline-flex; justify-content:center; align-items:center; min-height:44px; padding:10px 16px; border:1px solid transparent; border-radius:6px; background:var(--brand); color:#fff; font:inherit; font-size:14px; font-weight:600; line-height:1.4; text-align:center; text-decoration:none; cursor:pointer; overflow-wrap:anywhere; }
.button:hover,button:hover { background:var(--brand-dark); color:#fff; text-decoration:none; }
.button-secondary { border-color:#bbc5d2; background:#fff; color:var(--ink); }
.button-secondary:hover { background:var(--surface-soft); color:var(--ink); }
button:disabled { opacity:.65; cursor:not-allowed; }
.inline-form { display:inline-flex; }
.entry-actions,.form-actions,.card-actions { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
.entry-actions p { flex-basis:100%; }
.status-grid { display:flex; flex-wrap:wrap; gap:16px; }
.status-card h3 { margin:0 0 8px; font-size:13px; color:var(--muted); }
.panel-heading { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:12px; }
.release-card { padding:24px; }
.release-card p { overflow-wrap:anywhere; }
.resource-facts,.artifact-facts { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,120px),1fr)); gap:12px; margin:12px 0; }
.fact dt,.preview-facts dt { font-size:13px; color:var(--muted); }
.fact dd,.preview-facts dd { margin:4px 0 0; overflow-wrap:anywhere; }
.digest,code { font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:12px; overflow-wrap:anywhere; }
.digest { display:block; max-width:100%; }
details { margin-top:16px; }
summary { color:var(--brand-dark); cursor:pointer; min-height:44px; display:list-item; padding-block:10px; overflow-wrap:anywhere; }
.configuration-panel { padding:24px; background:#fff; }
.form-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:24px; }
.form-field { min-width:0; overflow-wrap:anywhere; display:grid; grid-template-columns:minmax(0,1fr); gap:8px; font-size:14px; font-weight:600; }
select { appearance:none; background-image:linear-gradient(45deg,transparent 50%,#526071 50%),linear-gradient(135deg,#526071 50%,transparent 50%); background-position:calc(100% - 17px) 50%,calc(100% - 12px) 50%; background-size:5px 5px; background-repeat:no-repeat; display:block; overflow:hidden; min-width:0; max-width:100%; width:100%; min-height:44px; padding:10px 32px 10px 12px; border:1px solid #bbc5d2; border-radius:6px; background-color:#fff; color:var(--ink); font:inherit; font-size:16px; }
.module-options { grid-column:1/-1; min-width:0; margin:0; padding:16px 0; border:0; }
.module-options legend { padding:0; font-weight:600; }
.module-option { display:flex; align-items:center; gap:12px; min-height:48px; padding:8px; border-bottom:1px solid var(--line); cursor:pointer; }
.module-option input { flex:0 0 auto; width:20px; height:20px; accent-color:var(--brand); }
.module-option span { overflow-wrap:anywhere; }
.module-option .field-help { display:block; }
.form-actions { padding-top:24px; }
.preview-facts { display:grid; gap:12px; }
.preview-facts > div { min-width:0; }
.alert { padding:12px 16px; background:var(--bad-soft); color:var(--bad); border-left:3px solid var(--bad); overflow-wrap:anywhere; }
.operation-card { padding:16px 0; border-bottom:1px solid var(--line); }
.operation-card p { overflow-wrap:anywhere; }
.progress-track { display:block; width:100%; height:12px; accent-color:var(--brand); }
.empty-state { padding:48px 24px; text-align:center; }
.page-footer { border-top:1px solid var(--line); font-size:12px; color:var(--muted); }
.footer-inner { display:flex; flex-wrap:wrap; justify-content:space-between; gap:12px; padding-block:16px; }
body[data-ui="mobile"] .topbar-inner,body[data-ui="mobile"] .page-shell,body[data-ui="mobile"] .footer-inner { padding-inline:16px; }
body[data-ui="mobile"] .form-grid { grid-template-columns:1fr; }
@media (max-width: 760px) { .topbar-inner,.page-shell,.footer-inner { padding-inline:16px; } .topbar-inner { flex-wrap:wrap; gap:8px 16px; padding-block:8px; } .topbar nav[aria-label="Primary"] { display:none; } .page-shell { padding-block:24px 32px; } .form-grid { grid-template-columns:1fr; } .configuration-panel,.release-card { padding:16px; } h1 { font-size:26px; } }
@media(prefers-reduced-motion:reduce) { *,*::before,*::after { scroll-behavior:auto!important; animation:none!important; transition:none!important; } }
`;

export const PORTAL_STYLE_HASHES = {
  desktop: "eTbsKlkmvuSYyle4s/7cHaB2ZdsViQ0+PI75EBcDvOc=",
  mobile: "AA0V5HAmF8eiCiGL/b7NFcO1qUertloCBTGaNMe7Z5I=",
} as const;
export function portalStyles(mode: PortalUiMode): string {
  return PORTAL_STYLES + (mode === "mobile" ? MOBILE_STYLES : DESKTOP_STYLES) + EVIDENCE_LEDGER_STYLES + EVIDENCE_LEDGER_LIST_STYLES;
}
