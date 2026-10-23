import { EVIDENCE_LEDGER_LIST_STYLES } from "./views/repository-ledger-list.js";
import { EVIDENCE_LEDGER_STYLES } from "./views/evidence-ledger.js";
import { DESKTOP_STYLES } from "./views/desktop.js";
import { MOBILE_STYLES } from "./views/mobile.js";
import { ADMIN_STYLES } from "../admin/styles.js";
import { DESKTOP_ADMIN_STYLES } from "../admin/desktop-styles.js";
import { MOBILE_ADMIN_STYLES } from "../admin/mobile-styles.js";
import type { PortalUiMode } from "./presentation.js";

/** Common controls and tokens. Composition styles are assembled per selected UI mode. */
export const PORTAL_STYLES = `
:root { color-scheme:light; font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans JP",sans-serif; color:#17372f; background:#f3f5f0; font-synthesis:none; --ink:#17372f; --muted:#596f66; --line:#d6e1da; --surface:#fff; --surface-soft:#eef2ed; --brand:#235d4b; --brand-dark:#174937; --good:#146447; --good-soft:#e5f2e9; --warn:#885421; --warn-soft:#fff6e6; --bad:#a44337; --bad-soft:#fff0f0; }
* { box-sizing:border-box; }
body { min-width:320px; margin:0; font-size:14px; line-height:1.55; }
body[data-ui="mobile"] { font-size:16px; }
a { color:var(--brand-dark); text-underline-offset:.18em; }
a:hover { text-decoration:underline; }
:focus-visible { outline:3px solid #235d4b; outline-offset:3px; }
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
.button-secondary { border-color:#c9dacd; background:#fff; color:var(--ink); }
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
select { appearance:none; background-image:linear-gradient(45deg,transparent 50%,#596f66 50%),linear-gradient(135deg,#596f66 50%,transparent 50%); background-position:calc(100% - 17px) 50%,calc(100% - 12px) 50%; background-size:5px 5px; background-repeat:no-repeat; display:block; overflow:hidden; min-width:0; max-width:100%; width:100%; min-height:44px; padding:10px 32px 10px 12px; border:1px solid #c9dacd; border-radius:6px; background-color:#fff; color:var(--ink); font:inherit; font-size:16px; }
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

/* Login shares the Evidence Ledger palette rather than the retired blue shell. */
.signin-panel{max-width:520px;margin:clamp(38px,10vh,115px) auto;padding:clamp(25px,5vw,48px);background:#fff;border:1px solid #d6e1da;border-radius:10px;box-shadow:0 22px 70px #17372f0a}
.signin-mark{width:48px;height:48px;display:grid;place-items:center;background:#153c2f;color:#edf7ee;font-size:26px;font-weight:750;border-radius:9px;margin-bottom:28px}
.signin-kicker{font:700 11px ui-monospace,monospace;letter-spacing:.11em;color:#72927e;margin-bottom:14px}
.signin-panel h1{font-size:clamp(29px,5vw,43px);font-weight:710;letter-spacing:-.055em;color:#173f30;line-height:1.13}
.signin-description{font-size:15px;line-height:1.7;color:#5e7767;margin:16px 0 28px}
.signin-action{width:100%;min-height:52px;font-size:15px;background:#235d4b}
.signin-footnote{font-size:12px;line-height:1.5;color:#708878;text-align:center;margin-top:20px}
/* No UA detection: the first-visit choice is visible only on touch-sized viewports. */
.mode-choice{display:none}
@media(max-width:900px) and (pointer:coarse){
.mode-choice{display:block;position:fixed;z-index:30;left:max(10px,env(safe-area-inset-left));right:max(10px,env(safe-area-inset-right));bottom:max(10px,env(safe-area-inset-bottom));max-width:480px;margin:0 auto;padding:23px 21px 19px;background:#fff;border:1px solid #b9d0c1;border-radius:16px;box-shadow:0 12px 60px #0e33294a}
.mode-choice-kicker{font:700 11px ui-monospace,monospace;letter-spacing:.08em;color:#6b8977}
.mode-choice h2{font-size:21px;letter-spacing:-.035em;color:#153c2f;margin:10px 0 7px}
.mode-choice p{color:#596f66;font-size:13px;line-height:1.55;margin-bottom:16px}
.mode-choice-actions{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:9px}
.mode-choice-actions .button{min-width:0;padding:12px 8px;min-height:48px;font-size:13px;line-height:1.3;text-align:center}
}
@media(prefers-reduced-motion:reduce) { *,*::before,*::after { scroll-behavior:auto!important; animation:none!important; transition:none!important; } }
`;

export const PORTAL_STYLE_HASHES = {
  desktop: "KUzVpuJJ5vczMj1lGzjUJ8nZCjcDMC5iLoqZ3xm6vt8=",
  mobile: "4LdMob4Vx8mflak7GQH3Qe0rqgL0lNfTG+GkfxcuXZs=",
} as const;
export function portalStyles(mode: PortalUiMode): string {
  return PORTAL_STYLES + (mode === "mobile" ? MOBILE_STYLES : DESKTOP_STYLES) + EVIDENCE_LEDGER_STYLES + EVIDENCE_LEDGER_LIST_STYLES + ADMIN_STYLES +
    (mode === "mobile" ? MOBILE_ADMIN_STYLES : DESKTOP_ADMIN_STYLES);
}
