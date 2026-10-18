import type { RepositoryDetailView } from "../presentation.js";

/**
 * Evidence Ledger is a presentation-only composition. All fragments are produced
 * by the existing authoritative renderer; no commands, state or forms are cloned.
 */
export function evidenceLedgerRepository(
  view: RepositoryDetailView,
  mode: "desktop" | "mobile",
): string {
  const desktop = mode === "desktop";
  const outer = desktop
    ? "desktop-composition desktop-repository-detail evidence-ledger"
    : "mobile-repository evidence-ledger";
  const navigation = desktop ? "desktop-section-nav" : "mobile-section-nav";
  const config = desktop
    ? '<div class="desktop-configuration-layout"><div class="desktop-configuration-main">' +
      view.policy + view.configuration + '</div><aside class="desktop-limits">' +
      view.limits + '</aside></div><div class="desktop-preview">' + view.preview + '</div>'
    : '<div class="mobile-policy-summary"><h3>Release policy</h3>' + view.policy +
      '</div><div class="mobile-configuration-content">' + view.configuration +
      '</div><div class="mobile-limits-summary"><div class="mobile-limits-content">' +
      view.limits + '</div></div><div class="mobile-preview-summary"><div class="mobile-preview-content">' +
      view.preview + '</div></div>';
  return (
    '<div class="' + outer + '">' +
    '<header class="evidence-intro">' + view.heading + '</header>' +
    '<nav class="' + navigation + ' evidence-navigation" aria-label="Repository sections">' +
    '<a href="#overview">Overview</a><a href="#configuration">Configuration</a>' +
    '<a href="#activity">Activity</a></nav>' +
    '<section id="overview" class="evidence-overview" aria-labelledby="evidence-overview-title">' +
    '<h2 id="evidence-overview-title" class="evidence-eyebrow">INSTANCE / DEPLOYMENT</h2>' +
    '<div class="evidence-workspace">' +
    '<div class="evidence-runtime">' +
    '<div class="evidence-runtime-label">CURRENT RUNTIME</div>' + view.runtime +
    '<div class="evidence-access">' + view.access + '</div></div>' +
    '<div class="evidence-material">' +
    '<div class="evidence-material-heading"><span>Deployment evidence</span><span>Current / Desired</span></div>' +
    '<div class="evidence-operation-summary" aria-label="Latest operation">' + (view.evidence ?? '') + '</div>' +
    '<div class="evidence-deployment-comparison">' +
    '<div class="desktop-deployment evidence-deployment evidence-deployment-current">' + view.current + '</div>' +
    '<div class="desktop-deployment evidence-deployment evidence-deployment-desired">' + view.desired + '</div>' +
    '</div></div></div></section>' +
    '<section id="configuration" class="evidence-secondary evidence-configuration" aria-labelledby="evidence-configuration-title">' +
    '<div class="evidence-section-title"><span class="evidence-index">01 / COMPOSITION</span>' +
    '<h2 id="evidence-configuration-title">Configuration</h2></div>' + config + '</section>' +
    '<section id="activity" class="evidence-secondary evidence-activity" aria-labelledby="evidence-activity-title">' +
    '<div class="evidence-section-title"><span class="evidence-index">02 / EXECUTION</span>' +
    '<h2 id="evidence-activity-title">Activity</h2></div>' +
    '<div class="desktop-activity-content"><div class="desktop-operations">' + view.operations +
    '</div><div class="desktop-redeploy">' + view.redeploy + '</div></div></section></div>'
  );
}

/**
 * Product-specific geometry: runtime status, current/desired artifact evidence,
 * then configuration and operation history. Shared by explicit Desktop/Mobile
 * views; the browser does not silently select presentation mode.
 */
export const EVIDENCE_LEDGER_STYLES = `
body:has(.evidence-ledger){--ink:#17372f;--muted:#596f66;--line:#d6e1da;--surface:#fff;--surface-soft:#eef2ed;--brand:#235d4b;--brand-dark:#174937;--good:#146447;--good-soft:#e5f2e9;--warn:#885421;--bad:#a44337;background:#f3f5f0}
body:has(.evidence-ledger) .topbar{background:#fdfefb;border-bottom:1px solid #dbe4dc}
body:has(.evidence-ledger) .brand-mark{background:#143e31}
body:has(.evidence-ledger) .page-shell{max-width:1500px;padding-inline:clamp(16px,4.5vw,76px)}
.evidence-ledger{color:#193c31;min-width:0}
.evidence-intro{padding:22px 0 22px}
.evidence-intro .page-heading{margin:0;align-items:end;gap:24px}
.evidence-intro .page-heading h1{font-size:clamp(32px,4.5vw,62px);font-weight:680;letter-spacing:-.065em;line-height:1.13;color:#183d31}
.evidence-intro .page-heading p{font-size:12px;color:#6c8477}
.evidence-intro .breadcrumb{color:#6a8375;margin:0 0 21px;font-size:12px}
.evidence-navigation{display:flex;gap:27px;min-height:52px;border-top:1px solid #dbe3dd;border-bottom:1px solid #dbe3dd;margin:0 0 18px;background:transparent;position:static}
.evidence-navigation a{display:flex;align-items:center;min-height:50px;min-width:0;font-size:12px;font-weight:700;color:#667b70;text-decoration:none;border-bottom:2px solid transparent}
.evidence-navigation a:first-child{color:#224d3c;border-color:#296449}
.evidence-eyebrow,.evidence-index{font-size:11px;letter-spacing:.13em;color:#758d7f;font-weight:750;font-family:ui-monospace,monospace}
.evidence-eyebrow{margin:12px 0 13px}
.evidence-workspace{display:grid;grid-template-columns:minmax(285px,.9fr) minmax(0,1.6fr);border:1px solid #dbe3dc;background:#fff;min-width:0}
.evidence-runtime{background:#153c2f;color:#eaf7ee;padding:30px clamp(22px,3vw,39px);display:flex;flex-direction:column;min-height:390px;min-width:0;position:relative}
.evidence-runtime:before{content:"";position:absolute;inset:0;background-image:linear-gradient(#a9c2ad12 1px,transparent 1px),linear-gradient(90deg,#a9c2ad12 1px,transparent 1px);background-size:40px 40px;pointer-events:none}
.evidence-runtime>*{position:relative}
.evidence-runtime-label{font-family:ui-monospace,monospace;color:#b4d7c3;letter-spacing:.12em;font-size:11px;font-weight:600}
.evidence-runtime .entry-panel{display:flex;flex:1;flex-direction:column;align-items:flex-start;justify-content:center;min-width:0;margin:0;padding:16px 0 20px;background:transparent;border:0;box-shadow:none;color:#e8f5ed}
.evidence-runtime .entry-panel>h2{font-size:11px;letter-spacing:.09em;color:#abcbbc;text-transform:uppercase;font-weight:600;margin:0 0 22px}
.evidence-runtime .entry-panel>.status-badge{font-size:clamp(47px,5.4vw,79px);line-height:1.06;letter-spacing:-.08em;padding:0;background:transparent;color:#f5fff8;text-transform:uppercase;border-radius:0;font-weight:750}
.evidence-runtime .entry-panel>.status-badge:after{content:".";color:#8fcfa7}
.evidence-runtime .entry-panel>.status-warn:after,.evidence-runtime .entry-panel>.status-bad:after{color:#f3ab7e}
.evidence-runtime .entry-panel>.muted{color:#c5d9ce;font-size:13px;line-height:1.7;max-width:34ch;overflow-wrap:anywhere}
.evidence-runtime .entry-actions{margin-top:24px;display:flex;align-items:stretch;gap:8px;flex-wrap:wrap}
.evidence-runtime .entry-actions .button,.evidence-runtime .entry-actions button{background:#e1f0e4;color:#193c2e;border:1px solid #e1f0e4;min-height:43px}
.evidence-runtime .entry-actions .button-secondary{background:transparent;color:#e1f0e4;border-color:#87aa96}
.evidence-runtime .entry-actions p{color:#d1e4d7}
.evidence-runtime .entry-actions a{color:#e1f0e4}
.evidence-access{border-top:1px solid #61857569;padding-top:18px}
.evidence-access .status-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
.evidence-access .status-card h3{font-size:11px;color:#b5d0c0}
.evidence-access .status-badge{background:transparent;color:#f1f7f2;padding:0;font-size:13px}
.evidence-material{padding:27px clamp(19px,2.8vw,36px);min-width:0}
.evidence-material-heading{display:flex;justify-content:space-between;gap:12px;padding-bottom:19px;border-bottom:1px solid #dce5dd;align-items:baseline;font-size:17px;font-weight:720}
.evidence-material-heading span+span{color:#73877b;font:600 11px ui-monospace,monospace}
.evidence-deployment-comparison{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;padding-top:18px}
.evidence-deployment{border:1px solid #d7e2d8;background:#f8faf6;padding:20px;min-width:0}
.evidence-deployment-desired{background:#fff}
.evidence-deployment .release-card{padding:0;background:transparent}
.evidence-deployment .release-card h3{font-size:12px;letter-spacing:.035em;color:#657e6c;margin:0 0 15px}
.evidence-deployment .release-card p{font-size:12px;line-height:1.65;overflow-wrap:anywhere}
.evidence-deployment .release-card strong{color:#284a38}
.evidence-deployment .resource-facts{gap:8px}
.evidence-deployment .fact dt,.evidence-deployment .fact dd{font-size:11px}
.evidence-deployment details{font-size:12px}
.evidence-secondary{padding:33px 0 24px;border-bottom:1px solid #d7e2d8;min-width:0}
.evidence-section-title{display:flex;gap:12px;align-items:center;padding-bottom:17px;margin-bottom:15px;border-bottom:1px solid #dce5de}
.evidence-section-title h2{font-size:23px;letter-spacing:-.04em;margin:0}
.evidence-configuration .desktop-configuration-layout{grid-template-columns:minmax(0,1.6fr) minmax(240px,.55fr);gap:18px}
.evidence-configuration .desktop-configuration-main,.evidence-configuration .desktop-limits,.evidence-configuration .desktop-preview{background:#fff;border:1px solid #dbe5db;border-radius:0}
.evidence-configuration .desktop-configuration-main{padding:23px}
.evidence-configuration .desktop-preview{margin-top:18px}
.evidence-activity .desktop-activity-content{grid-template-columns:minmax(0,1.5fr) minmax(220px,.7fr);align-items:start;gap:18px}
.evidence-activity .desktop-operations,.evidence-activity .desktop-redeploy{padding:22px;background:#fff;border:1px solid #dbe5db;min-width:0}
.evidence-ledger .button,.evidence-ledger button{border-radius:4px}
.evidence-ledger code{overflow-wrap:anywhere}
.evidence-ledger details summary{color:#245a44}
@media(max-width:980px){.evidence-workspace{grid-template-columns:minmax(0,1fr)}.evidence-runtime{min-height:295px}.evidence-runtime .entry-panel{padding:20px 0}.evidence-deployment-comparison{grid-template-columns:repeat(2,minmax(0,1fr))}.evidence-configuration .desktop-configuration-layout,.evidence-activity .desktop-activity-content{grid-template-columns:minmax(0,1fr)}}
@media(max-width:620px){body:has(.evidence-ledger) .page-shell{padding-inline:15px}.evidence-intro{padding:18px 0}.evidence-intro .page-heading{display:block}.evidence-intro .page-heading h1{font-size:clamp(28px,9vw,43px)}.evidence-navigation{gap:22px;margin-bottom:14px}.evidence-runtime{padding:22px 20px;min-height:280px}.evidence-runtime .entry-panel>.status-badge{font-size:clamp(43px,12vw,67px)}.evidence-runtime .entry-actions{gap:8px}.evidence-runtime .entry-actions button,.evidence-runtime .entry-actions .button{min-height:44px}.evidence-material{padding:20px 15px}.evidence-material-heading{font-size:16px}.evidence-deployment-comparison{grid-template-columns:minmax(0,1fr)}.evidence-secondary{padding-top:25px}.evidence-section-title h2{font-size:20px}.evidence-configuration .desktop-configuration-main{padding:17px}.evidence-activity .desktop-operations,.evidence-activity .desktop-redeploy{padding:17px}.evidence-access .status-grid{gap:8px}}
@media(max-width:360px){.evidence-runtime{padding-inline:16px}.evidence-runtime .entry-panel>.status-badge{font-size:43px}.evidence-runtime .entry-actions{flex-direction:column;width:100%}.evidence-runtime .entry-actions form,.evidence-runtime .entry-actions button{width:100%}}
.evidence-operation-summary{padding:18px 0 15px;border-bottom:1px solid #dbe4dc}
.evidence-incident{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px 12px;align-items:center}
.evidence-incident-label{font:700 11px ui-monospace,monospace;letter-spacing:.07em;color:#677e6d;overflow-wrap:anywhere}
.evidence-incident .status-badge{font-size:11px}
.evidence-incident p{grid-column:1/-1;margin:0;color:#536b5b;font-size:12px;line-height:1.65;overflow-wrap:anywhere}
.evidence-no-activity{margin:0;font-size:12px;color:#6c8071}

`;
