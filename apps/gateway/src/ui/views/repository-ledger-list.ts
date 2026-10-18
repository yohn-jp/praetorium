import type { RepositoryListView, RepositoryRowView } from "../presentation.js";

/** The list and detail views share a single evidence-first visual language. */
function row(view: RepositoryRowView): string {
  return '<li class="ledger-list-item"><article class="ledger-list-card">' +
    '<div class="ledger-list-identity"><div class="ledger-list-kicker">REPOSITORY / INSTANCE</div>' +
    view.identity + '<div class="ledger-list-installation">' + view.installation + '</div></div>' +
    '<div class="ledger-list-state"><span class="ledger-list-kicker">CURRENT RUNTIME</span>' +
    '<div class="ledger-list-runtime">' + view.runtime + '</div>' +
    (view.reason ? '<div class="ledger-list-reason">' + view.reason + '</div>' : '') + '</div>' +
    '<div class="ledger-list-evidence"><span class="ledger-list-kicker">LATEST OPERATION</span>' +
    '<div class="ledger-list-operation">' + view.operation + '</div>' +
    '<div class="ledger-list-access"><span class="ledger-list-kicker">YOUR ACCESS</span>' + view.access + '</div>' +
    (view.revisions.trim() ? '<details class="ledger-list-revisions"><summary>Current and desired revisions</summary>' + view.revisions + '</details>' : '') +
    '</div><div class="ledger-list-actions">' + view.actions + '</div>' +
    '</article></li>';
}

export function evidenceLedgerRepositories(view: RepositoryListView, mode: "desktop" | "mobile"): string {
  const content = view.rows.length
    ? '<ol class="ledger-list-rows">' + view.rows.map(row).join('') + '</ol>'
    : '<div class="ledger-list-empty">' + view.empty + '</div>';
  return '<div class="evidence-ledger-list ledger-list-' + mode + '">' +
    '<header class="ledger-list-header">' +
    '<div class="ledger-list-eyebrow">WORKSPACE / REPOSITORIES</div>' +
    view.heading + '</header>' +
    '<section class="ledger-list-connection" aria-label="GitHub connection">' + view.connection + '</section>' +
    '<section class="ledger-list-section" aria-label="Repository runtime overview">' +
    '<div class="ledger-list-section-heading"><span>01 / INVENTORY</span><h2>Repository overview</h2></div>' +
    content + '</section></div>';
}

/** Geometry and tone are inherited from Evidence Ledger detail, not the old blue table UI. */
export const EVIDENCE_LEDGER_LIST_STYLES = `
body:has(.evidence-ledger-list){--ink:#17372f;--muted:#596f66;--line:#d6e1da;--surface:#fff;--surface-soft:#eef2ed;--brand:#235d4b;--brand-dark:#174937;--good:#146447;--good-soft:#e5f2e9;--warn:#885421;--bad:#a44337;background:#f3f5f0}
body:has(.evidence-ledger-list) .topbar{background:#fdfefb;border-bottom:1px solid #dbe4dc}
body:has(.evidence-ledger-list) .brand-mark{background:#143e31}
body:has(.evidence-ledger-list) .page-shell{max-width:1500px;padding-inline:clamp(16px,4.5vw,76px)}
body:has(.evidence-ledger-list) .page-footer{background:#f3f5f0}
.evidence-ledger-list{color:#193c31;min-width:0}
.ledger-list-header{padding:26px 0 25px;border-bottom:1px solid #d6e1da}
.ledger-list-eyebrow,.ledger-list-kicker,.ledger-list-section-heading>span{font:700 11px ui-monospace,monospace;letter-spacing:.1em;color:#758d7f}
.ledger-list-eyebrow{margin-bottom:15px}
.ledger-list-header .page-heading{display:flex;justify-content:space-between;align-items:end;gap:20px}
.ledger-list-header .page-heading h1{font-size:clamp(32px,4.5vw,62px);font-weight:680;letter-spacing:-.065em;line-height:1.12;color:#183d31}
.ledger-list-header .page-heading p{font-size:13px;color:#6a8173;margin:10px 0 0}
.ledger-list-header .page-heading h1 .muted{color:#769184}
.ledger-list-connection{margin:20px 0 30px;padding:0;border:1px solid #dbe3dc;background:#fff}
.ledger-list-connection .status-panel{margin:0;padding:20px 24px;box-shadow:none;border:0;border-radius:0}
.ledger-list-connection .status-panel h2{font-size:15px;color:#234e3b}
.ledger-list-section-heading{display:flex;gap:16px;align-items:center;padding-bottom:16px;border-bottom:1px solid #dce5de}
.ledger-list-section-heading h2{font-size:23px;letter-spacing:-.04em;margin:0;color:#183d31}
.ledger-list-rows{list-style:none;margin:0;padding:0}
.ledger-list-item{border-bottom:1px solid #d7e2d8}
.ledger-list-card{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,.8fr) minmax(0,1fr) minmax(120px,.55fr);gap:20px;align-items:stretch;padding:20px 0;min-width:0}
.ledger-list-card>div{min-width:0}
.ledger-list-identity{padding:12px 0}
.ledger-list-identity>a{display:block;font-size:clamp(17px,1.7vw,23px);font-weight:720;letter-spacing:-.035em;color:#1c4936;overflow-wrap:anywhere;margin:12px 0 6px}
.ledger-list-installation{font-size:12px;color:#6a8173;overflow-wrap:anywhere}
.ledger-list-state{background:#153c2f;color:#f4fff8;padding:18px 20px;min-width:0}
.ledger-list-state .ledger-list-kicker{color:#b4d7c3}
.ledger-list-runtime{margin:12px 0 6px}
.ledger-list-runtime .status-badge{font-size:clamp(18px,2vw,27px);font-weight:750;letter-spacing:-.045em;background:transparent;border:0;padding:0;color:#f4fff8;white-space:normal;overflow-wrap:anywhere}
.ledger-list-reason{font-size:12px;line-height:1.55;color:#d6e8dd;overflow-wrap:anywhere}
.ledger-list-evidence{padding:12px 0;min-width:0}
.ledger-list-operation{font-size:13px;color:#284c3a;margin:12px 0 15px;overflow-wrap:anywhere}
.ledger-list-access{font-size:12px;color:#516e5e}
.ledger-list-access .ledger-list-kicker{display:block;margin-bottom:5px}
.ledger-list-revisions{font-size:12px;color:#516e5e;margin-top:14px;overflow-wrap:anywhere}
.ledger-list-revisions summary{cursor:pointer;min-height:44px;display:flex;align-items:center;color:#245a44}
.ledger-list-revisions code{overflow-wrap:anywhere}
.ledger-list-actions{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:8px;padding:12px 0}
.ledger-list-actions form{margin:0}
.ledger-list-actions .button,.ledger-list-actions button{background:#235d4b;color:#fff;border-color:#235d4b;min-height:44px;border-radius:4px}
.ledger-list-actions .button-secondary{background:transparent;color:#245a44}
.ledger-list-empty{padding:28px 0;color:#536b5b}
.ledger-list-empty .empty-state{border:1px solid #dbe3dc;background:#fff}
@media(max-width:1050px){.ledger-list-card{grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px 20px}.ledger-list-actions{justify-content:flex-start}}
@media(max-width:620px){.ledger-list-header .page-heading{display:block}.ledger-list-header .page-heading h1{font-size:clamp(30px,9vw,43px)}.ledger-list-header .page-heading form{margin-top:16px}.ledger-list-card{grid-template-columns:minmax(0,1fr);gap:0;padding:18px 0}.ledger-list-identity{padding:0 0 13px}.ledger-list-state{padding:18px}.ledger-list-evidence{padding:17px 0}.ledger-list-actions{padding:5px 0 0;display:grid}.ledger-list-actions .button,.ledger-list-actions button{width:100%;justify-content:center}.ledger-list-connection .status-panel{padding:18px}.ledger-list-section-heading{display:block}.ledger-list-section-heading h2{margin-top:6px;font-size:20px}}
`;
