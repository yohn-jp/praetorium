export const PORTAL_STYLES = `
:root {
  color-scheme: light;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: #16283f;
  background: #f2f5fa;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  --ink: #16283f;
  --muted: #5b6d84;
  --line: #d9e2ed;
  --surface: #ffffff;
  --surface-soft: #f7f9fc;
  --brand: #2455c7;
  --brand-dark: #1b429e;
  --good: #176e55;
  --good-soft: #e7f5ee;
  --warn: #895c05;
  --warn-soft: #fff4d8;
  --bad: #a12f34;
  --bad-soft: #fff0ef;
  --shadow: 0 12px 32px rgb(22 40 63 / 6%);
}
* { box-sizing: border-box; }
body { min-width: 320px; margin: 0; background: #f2f5fa; color: var(--ink); line-height: 1.55; }
a { color: var(--brand-dark); text-underline-offset: .18em; }
a:hover { color: #102f7b; }
a:focus-visible, button:focus-visible, select:focus-visible, summary:focus-visible { outline: 3px solid #77a7ff; outline-offset: 3px; }
.skip-link { position: absolute; z-index: 2; top: .5rem; left: .5rem; transform: translateY(-180%); padding: .6rem .8rem; border-radius: .5rem; background: #fff; color: var(--ink); }
.skip-link:focus { transform: translateY(0); }
.topbar { background: #fff; border-bottom: 1px solid var(--line); }
.topbar-inner, .page-shell, .footer-inner { width: min(1120px, calc(100% - 2rem)); margin-inline: auto; }
.topbar-inner { min-height: 68px; display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
.brand { display: inline-flex; align-items: center; gap: .7rem; color: var(--ink); font-size: 1.03rem; font-weight: 800; letter-spacing: -.025em; text-decoration: none; }
.brand-mark { display: grid; width: 34px; height: 34px; place-items: center; border-radius: 10px; background: var(--brand); color: #fff; font-size: .95rem; }
.topbar nav { display: flex; align-items: center; gap: 1.2rem; }
.topbar nav a { font-size: .9rem; font-weight: 650; text-decoration: none; }
.page-shell { min-height: calc(100vh - 122px); padding-block: 2rem 3.5rem; }
.page-footer { border-top: 1px solid var(--line); color: var(--muted); font-size: .82rem; }
.footer-inner { display: flex; justify-content: space-between; gap: 1rem; padding-block: 1rem; }
.page-heading { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 1rem; margin-bottom: 1.4rem; }
.page-heading h1 { margin: .1rem 0 .35rem; font-size: clamp(1.8rem, 4vw, 2.45rem); letter-spacing: -.045em; line-height: 1.12; overflow-wrap: anywhere; }
.page-heading p { max-width: 68ch; margin: 0; color: var(--muted); }
.eyebrow { margin: 0 0 .35rem; color: var(--brand-dark); font-size: .73rem; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; }
.breadcrumb { margin: 0 0 .75rem; color: var(--muted); font-size: .88rem; }
.breadcrumb a { font-weight: 650; }
.panel, section { min-width: 0; margin: 1rem 0; padding: clamp(1rem, 2.5vw, 1.4rem); border: 1px solid var(--line); border-radius: 16px; background: var(--surface); box-shadow: var(--shadow); }
.panel h2, section > h2 { margin: 0 0 .8rem; font-size: 1.12rem; letter-spacing: -.02em; }
section > h3 { margin: 0 0 .7rem; font-size: 1rem; }
section > h4 { margin: 1rem 0 .35rem; font-size: .9rem; }
p { margin-block: .55rem; }
.muted, .field-help, .empty-state { color: var(--muted); }
.status-panel { display: flex; align-items: flex-start; gap: .8rem; border-left: 4px solid var(--brand); }
.status-panel > div { min-width: 0; }
.status-panel p { margin: .15rem 0; }
.status-badge { display: inline-flex; flex: 0 0 auto; align-items: center; min-height: 1.7rem; padding: .15rem .62rem; border: 1px solid transparent; border-radius: 999px; font-size: .77rem; font-weight: 750; line-height: 1.25; white-space: nowrap; }
.status-good { border-color: #b8dfce; background: var(--good-soft); color: var(--good); }
.status-warn { border-color: #f0d58e; background: var(--warn-soft); color: var(--warn); }
.status-bad { border-color: #efc0bd; background: var(--bad-soft); color: var(--bad); }
.status-neutral { border-color: var(--line); background: #f2f5f8; color: #506278; }
.repository-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr)); gap: 1rem; margin: 0; padding: 0; list-style: none; }
.repository-card { display: flex; min-width: 0; flex-direction: column; gap: 1rem; padding: 1.2rem; border: 1px solid var(--line); border-radius: 16px; background: var(--surface); box-shadow: var(--shadow); }
.repository-card h2 { min-width: 0; margin: 0; font-size: 1.12rem; letter-spacing: -.02em; overflow-wrap: anywhere; }
.card-heading, .panel-heading, .card-actions { display: flex; align-items: center; justify-content: space-between; gap: .8rem; }
.card-heading > div, .panel-heading > div { min-width: 0; }
.repo-facts, .artifact-facts, .resource-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 145px), 1fr)); gap: .75rem; margin: 0; }
.fact { min-width: 0; padding: .72rem; border-radius: 10px; background: var(--surface-soft); }
.fact dt { color: var(--muted); font-size: .75rem; font-weight: 700; }
.fact dd { margin: .2rem 0 0; font-size: .91rem; font-weight: 680; overflow-wrap: anywhere; }
.digest { display: block; max-width: 100%; overflow-wrap: anywhere; font-size: .82rem; }
.card-actions { flex-wrap: wrap; justify-content: flex-start; margin-top: auto; }
.button, button { display: inline-flex; min-height: 44px; align-items: center; justify-content: center; gap: .4rem; padding: .65rem 1rem; border: 1px solid transparent; border-radius: 10px; background: var(--brand); color: #fff; font: inherit; font-size: .9rem; font-weight: 750; line-height: 1.2; text-align: center; text-decoration: none; cursor: pointer; }
.button:hover, button:hover { background: var(--brand-dark); color: #fff; }
.button-secondary, button.button-secondary { border-color: #c8d5e5; background: #fff; color: #263e5c; }
.button-secondary:hover, button.button-secondary:hover { border-color: #9fb4ce; background: #f5f8fc; color: #142b47; }
button:disabled { cursor: not-allowed; opacity: .55; }
.inline-form { display: inline-flex; margin: 0; }
.status-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); gap: .9rem; }
.status-card { padding: 1rem; border: 1px solid var(--line); border-radius: 13px; background: var(--surface); }
.status-card h2, .status-card h3 { margin: 0 0 .55rem; font-size: .93rem; }
.status-card p:last-child { margin-bottom: 0; }
.dashboard-grid { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(270px, .7fr); align-items: start; gap: 1rem; }
.dashboard-grid > section { margin: 0; }
.entry-panel { border-top: 4px solid var(--brand); }
.entry-actions { display: flex; flex-wrap: wrap; align-items: center; gap: .6rem; margin-top: 1rem; }
.entry-actions form { margin: 0; }
.release-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); gap: .8rem; }
.release-card { min-width: 0; padding: 1rem; border: 1px solid var(--line); border-radius: 12px; background: var(--surface-soft); }
.release-card h3 { margin: 0 0 .65rem; font-size: .96rem; }
.release-card p { font-size: .9rem; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
.form-field { display: flex; min-width: 0; flex-direction: column; gap: .4rem; font-size: .88rem; font-weight: 700; }
.form-field select { width: 100%; min-height: 44px; padding: .62rem .7rem; border: 1px solid #bccadd; border-radius: 9px; background: #fff; color: var(--ink); font: inherit; font-weight: 500; }
.form-field select[multiple] { min-height: 9rem; padding: .25rem; }
.field-help { font-size: .78rem; font-weight: 450; }
.preview-facts { display: grid; gap: .55rem; margin-block: .8rem; }
.preview-facts > div { display: grid; grid-template-columns: minmax(130px, .35fr) 1fr; gap: .7rem; }
.preview-facts dt { color: var(--muted); font-size: .84rem; font-weight: 700; }
.preview-facts dd { margin: 0; overflow-wrap: anywhere; }
.form-actions { display: flex; flex-wrap: wrap; gap: .6rem; margin-top: 1rem; }
.alert { padding: .85rem 1rem; border: 1px solid #efc0bd; border-radius: 11px; background: var(--bad-soft); color: #782328; }
.alert p { margin: .2rem 0; }
.operation-list { display: grid; gap: .75rem; }
.operation-card { padding: 1rem; border: 1px solid var(--line); border-radius: 12px; background: var(--surface-soft); }
.operation-card h3 { margin: 0 0 .35rem; font-size: .95rem; }
.operation-card code, .operation-card p { overflow-wrap: anywhere; }
.progress-track { display: block; width: 100%; height: .75rem; margin-block: .55rem; accent-color: var(--brand); }
.empty-state { padding: 1.2rem; border: 1px dashed #b9c7d8; border-radius: 12px; text-align: center; }
details { margin-top: .2rem; }
summary { color: var(--brand-dark); font-size: .86rem; font-weight: 700; cursor: pointer; }
dl { margin-block: .6rem; }
code { border-radius: 4px; background: #eef2f7; padding: .08rem .28rem; }
@media (max-width: 760px) {
  .page-shell { padding-top: 1.2rem; }
  .topbar-inner, .footer-inner { width: min(100% - 1.25rem, 1120px); }
  .page-shell { width: min(100% - 1.25rem, 1120px); }
  .dashboard-grid { grid-template-columns: 1fr; }
  .form-grid { grid-template-columns: 1fr; }
  .card-heading, .panel-heading { align-items: flex-start; }
  .footer-inner { flex-direction: column; gap: .2rem; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; }
}
`;

export const PORTAL_STYLE_HASH = "tniWXQE2icKDoxxO9zKijFshF09e1uhaQMJiWb8q630=";
