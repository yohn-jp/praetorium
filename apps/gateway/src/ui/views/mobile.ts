import { evidenceLedgerRepositories } from "./repository-ledger-list.js";
import { evidenceLedgerRepository } from "./evidence-ledger.js";
import type {
  RepositoryDetailView,
  RepositoryListView,
} from "../presentation.js";

/** Styles for the single mobile composition selected by the server renderer. */
export const MOBILE_STYLES = `
.mobile-repositories,
.mobile-repository { min-width: 0; width: 100%; max-width: 42rem; margin-inline: auto; }
.mobile-repositories-heading { min-width: 0; margin-bottom: 1rem; }
.mobile-repositories-connection { margin: 0 0 1rem; padding: .65rem .8rem; border: 1px solid var(--line); border-radius: 8px; background: #fff; color: var(--muted); font-size: .875rem; }
.mobile-repositories-connection > .status-panel { margin: 0; padding: 0; border: 0; }
.mobile-repository-list { min-width: 0; margin: 0; padding: 0; list-style: none; }
.mobile-repository-row { min-width: 0; padding: 1rem 0 1.25rem; border-bottom: 1px solid var(--line); }
.mobile-repository-row:first-child { border-top: 1px solid var(--line); }
.mobile-repository-summary { display: grid; min-width: 0; gap: .75rem; }
.mobile-repository-identity { min-width: 0; font-size: 1.125rem; font-weight: 700; overflow-wrap: anywhere; }
.mobile-repository-identity a { overflow-wrap: anywhere; }
.mobile-repository-status { display: flex; min-width: 0; flex-wrap: wrap; align-items: center; gap: .5rem .75rem; font-size: 1rem; }
.mobile-repository-runtime, .mobile-repository-access,
.mobile-repository-installation, .mobile-repository-reason,
.mobile-repository-operation, .mobile-repository-revisions { min-width: 0; overflow-wrap: anywhere; }
.mobile-repository-installation { color: var(--muted); font-size: .875rem; }
.mobile-repository-context { display: grid; min-width: 0; gap: .25rem; color: var(--muted); }
.mobile-repository-reason, .mobile-repository-operation { font-size: .9375rem; }
.mobile-repository-actions { display: grid; min-width: 0; gap: .5rem; }
.mobile-repository-actions a, .mobile-repository-actions button,
.mobile-repository-actions input[type="submit"] { display: inline-flex; min-width: 0; min-height: 44px; align-items: center; justify-content: center; max-width: 100%; padding: .6rem .85rem; overflow-wrap: anywhere; }
.mobile-repository-revisions { padding-top: .25rem; font-size: .875rem; }
.mobile-repository-revisions summary { min-height: 44px; display: flex; align-items: center; overflow-wrap: anywhere; }
.mobile-repository-revisions > :not(summary) { overflow-wrap: anywhere; }
.mobile-repository-empty { padding: 1.25rem 0; }
.mobile-repository-heading { min-width: 0; margin-bottom: 1rem; overflow-wrap: anywhere; }
.mobile-repository-title { min-width: 0; overflow-wrap: anywhere; }
.mobile-repository-state { display: grid; min-width: 0; gap: .5rem; margin-top: .75rem; color: var(--muted); }
.mobile-section-nav { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); min-width: 0; margin: 0 0 1rem; border-bottom: 1px solid var(--line); }
.mobile-section-nav a { display: flex; min-width: 0; min-height: 44px; align-items: center; justify-content: center; padding: .4rem .2rem; border-bottom: 2px solid transparent; color: var(--muted); font-size: .8125rem; font-weight: 650; text-align: center; text-decoration: none; overflow-wrap: anywhere; }
.mobile-section-nav a:hover, .mobile-section-nav a:focus-visible { color: var(--ink); }
.mobile-overview, .mobile-configuration-section, .mobile-activity { min-width: 0; scroll-margin-top: 1rem; }
.mobile-section-heading { margin: 0 0 .75rem; font-size: 1.125rem; }
.mobile-deployment-summaries { display: grid; min-width: 0; gap: 1rem; }
.mobile-deployment-summary, .mobile-policy-summary,
.mobile-limits-summary, .mobile-preview-summary,
.mobile-operations-summary, .mobile-redeploy-summary { min-width: 0; padding: 1rem 0; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }
.mobile-deployment-summary .release-card { padding: 0; }
.mobile-deployment-summary h3, .mobile-policy-summary h3,
.mobile-limits-summary h3, .mobile-preview-summary h3,
.mobile-operations-summary h3, .mobile-redeploy-summary h3 { margin: 0 0 .5rem; font-size: 1rem; }
.mobile-configuration-section, .mobile-activity { margin-top: 1.5rem; padding-top: 1.25rem; border-top: 1px solid var(--line); }
.mobile-configuration-content, .mobile-limits-content, .mobile-preview-content,
.mobile-operations-content, .mobile-redeploy-content { min-width: 0; width: 100%; max-width: 100%; overflow-wrap: anywhere; }
.mobile-configuration-section form { min-width: 0; width: 100%; max-width: 100%; }
.mobile-configuration-section input, .mobile-configuration-section select,
.mobile-configuration-section textarea, .mobile-configuration-section button { max-width: 100%; }
.mobile-configuration-section select, .mobile-configuration-section input:not([type="checkbox"]):not([type="radio"]),
.mobile-configuration-section textarea { min-height: 44px; font-size: 1rem; }
.mobile-configuration-section input[type="checkbox"], .mobile-configuration-section input[type="radio"] { width: 1.25rem; height: 1.25rem; }
.mobile-configuration-section button, .mobile-configuration-section input[type="submit"] { min-height: 44px; }
.mobile-configuration-section section { min-width: 0; margin: 0; padding: 1rem 0; border: 0; border-top: 1px solid var(--line); border-radius: 0; background: transparent; box-shadow: none; }
.mobile-configuration-section section:first-child { border-top: 0; }
.mobile-repository code, .mobile-repository pre { max-width: 100%; overflow-wrap: anywhere; white-space: pre-wrap; }
.mobile-repository table { display: block; width: 100%; max-width: 100%; overflow-wrap: anywhere; }
.mobile-repository [id] { scroll-margin-top: 1rem; }
@media (min-width: 761px) {
  .mobile-repository-list { padding-inline: 0; }
  .mobile-repository-row { padding-inline: .25rem; }
}
@media (max-width: 360px) {
  .mobile-section-nav a { font-size: .75rem; }
  .mobile-repository-status { align-items: flex-start; flex-direction: column; }
}
/* Mobile is a task-oriented workspace, not a four-column desktop scaled down. */
body:has(.mobile-repository) .page-shell{padding-bottom:112px}
.mobile-repository .evidence-intro{padding:10px 0 20px}
.mobile-repository .evidence-intro .page-heading{display:block}
.mobile-repository .evidence-intro .page-heading h1{font-size:clamp(25px,6vw,36px);letter-spacing:-.05em;line-height:1.17}
.mobile-repository .evidence-intro .breadcrumb{margin:0 0 8px}
.mobile-repository .evidence-overview,.mobile-repository .evidence-configuration,.mobile-repository .evidence-activity{display:none}
.mobile-repository:not(:has(#configuration:target,#activity:target)) .evidence-overview{display:block}
.mobile-repository:has(#configuration:target) .evidence-configuration{display:block}
.mobile-repository:has(#activity:target) .evidence-activity{display:block}
.mobile-repository .evidence-navigation{position:fixed;inset:auto 0 0 0;z-index:20;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0;margin:0;min-height:70px;padding:4px max(12px,env(safe-area-inset-right)) calc(5px + env(safe-area-inset-bottom)) max(12px,env(safe-area-inset-left));background:#fdfefb;border-top:1px solid #cbdbd0;border-bottom:0;box-shadow:0 -8px 30px #153c2f13}
.mobile-repository .evidence-navigation a{min-height:54px;justify-content:center;text-align:center;font-size:13px;letter-spacing:-.015em;border:0;border-radius:7px;color:#678071}
.mobile-repository:not(:has(#configuration:target,#activity:target)) .evidence-navigation a[href="#overview"],
.mobile-repository:has(#configuration:target) .evidence-navigation a[href="#configuration"],
.mobile-repository:has(#activity:target) .evidence-navigation a[href="#activity"]{background:#e4eee6;color:#153c2f;font-weight:750}
.mobile-repository .evidence-eyebrow{margin:8px 0 12px}
.mobile-repository .evidence-workspace{display:flex;flex-direction:column;gap:15px;border:0;background:transparent}
.mobile-repository .evidence-runtime{min-height:0;padding:24px 23px 19px;border-radius:12px;gap:10px}
.mobile-repository .evidence-runtime .entry-panel{min-height:0;padding:4px 0 12px}
.mobile-repository .evidence-runtime .entry-panel>h2{margin:0 0 10px;font-size:11px}
.mobile-repository .evidence-runtime .entry-panel>.status-badge{font-size:clamp(30px,8vw,42px);letter-spacing:-.06em;line-height:1.12}
.mobile-repository .evidence-runtime .entry-panel>.muted{font-size:13px;line-height:1.55;max-width:100%}
.mobile-repository .evidence-runtime .entry-actions{margin-top:14px;display:grid;grid-template-columns:minmax(0,1fr);width:100%}
.mobile-repository .evidence-runtime .entry-actions form,
.mobile-repository .evidence-runtime .entry-actions .button,
.mobile-repository .evidence-runtime .entry-actions button{width:100%;min-width:0}
.mobile-repository .evidence-access{padding-top:12px}
.mobile-repository .evidence-access .status-grid{gap:10px}
.mobile-repository .evidence-material{padding:17px 15px;background:#fff;border:1px solid #dbe5dc;border-radius:10px;min-width:0}
.mobile-repository .evidence-material-heading{font-size:16px;padding-bottom:13px}
.mobile-repository .evidence-material-heading span+span{font-size:10px}
.mobile-repository .evidence-deployment-comparison{display:grid;grid-template-columns:minmax(0,1fr);gap:12px}
.mobile-repository .evidence-deployment{padding:16px;border-radius:7px}
.mobile-repository .evidence-secondary{padding:6px 0 35px;border:0;min-width:0}
.mobile-repository .evidence-section-title h2{font-size:24px}
.mobile-repository .mobile-policy-summary,
.mobile-repository .mobile-limits-summary,
.mobile-repository .mobile-preview-summary{padding:17px 0}
.mobile-repository .mobile-configuration-content{padding:16px 0}
.mobile-repository .desktop-activity-content{display:block}
.mobile-repository .desktop-activity-content>*{margin-bottom:18px}
.mobile-repository .evidence-configuration form,
.mobile-repository .evidence-activity form{width:100%}
.mobile-repository .evidence-configuration button,
.mobile-repository .evidence-activity button{min-height:48px}
.ledger-list-mobile .ledger-list-header{padding:12px 0 20px}
.ledger-list-mobile .ledger-list-header .page-heading h1{font-size:clamp(28px,7vw,40px)}
.ledger-list-mobile .ledger-list-connection{margin:14px 0 22px}
.ledger-list-mobile .ledger-list-rows{display:grid;gap:14px}
.ledger-list-mobile .ledger-list-item{border:0}
.ledger-list-mobile .ledger-list-card{display:flex;flex-direction:column;gap:0;padding:0;background:#fff;border:1px solid #d6e1da;border-radius:11px;overflow:hidden}
.ledger-list-mobile .ledger-list-identity{padding:17px 18px 13px}
.ledger-list-mobile .ledger-list-identity>a{font-size:clamp(18px,5vw,24px);margin:8px 0}
.ledger-list-mobile .ledger-list-state{padding:14px 18px}
.ledger-list-mobile .ledger-list-runtime{margin:5px 0}
.ledger-list-mobile .ledger-list-runtime .status-badge{font-size:24px}
.ledger-list-mobile .ledger-list-evidence{padding:13px 18px}
.ledger-list-mobile .ledger-list-operation{margin:6px 0 10px}
.ledger-list-mobile .ledger-list-actions{display:grid;grid-template-columns:repeat(auto-fit,minmax(135px,1fr));gap:8px;padding:0 18px 18px}
.ledger-list-mobile .ledger-list-actions>*{min-width:0}
.ledger-list-mobile .ledger-list-actions .button,
.ledger-list-mobile .ledger-list-actions button{width:100%;min-height:46px}
`;

export function mobileRepositories(view: RepositoryListView): string {
  return evidenceLedgerRepositories(view, "mobile");
}

/** Arrange one repository's authoritative fragments into the mobile task composition. */
export function mobileRepository(view: RepositoryDetailView): string {
  return evidenceLedgerRepository(view, "mobile");
}
