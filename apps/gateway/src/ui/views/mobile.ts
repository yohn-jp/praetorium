import type {
  RepositoryDetailView,
  RepositoryListView,
  RepositoryRowView,
} from "../presentation.js";

/** Styles for the single mobile composition selected by the server renderer. */
export const MOBILE_STYLES = `
.mobile-repositories,
.mobile-repository { min-width: 0; width: 100%; max-width: 42rem; margin-inline: auto; }
.mobile-repositories-heading { min-width: 0; margin-bottom: 1rem; }
.mobile-repositories-connection { margin: 0 0 1rem; padding: .65rem .8rem; border: 1px solid var(--line); border-radius: 8px; background: #fff; color: var(--muted); font-size: .875rem; }
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
`;

function optionalFragment(fragment: string, className: string): string {
  return fragment.trim() ? `<div class="${className}">${fragment}</div>` : "";
}

function repositoryRow(view: RepositoryRowView): string {
  return (
    `<li class="mobile-repository-row"><article class="mobile-repository-summary">` +
    `<div class="mobile-repository-identity">${view.identity}</div>` +
    `<div class="mobile-repository-status"><div class="mobile-repository-runtime">${view.runtime}</div>` +
    `<div class="mobile-repository-access">${view.access}</div></div>` +
    optionalFragment(view.reason, "mobile-repository-reason") +
    optionalFragment(view.operation, "mobile-repository-operation") +
    `<div class="mobile-repository-actions">${view.actions}</div>` +
    optionalFragment(view.installation, "mobile-repository-installation") +
    (view.revisions.trim()
      ? `<details class="mobile-repository-revisions"><summary>Current and desired revisions</summary>${view.revisions}</details>`
      : "") +
    `</article></li>`
  );
}

/** Arrange already escaped, authoritative fragments into the mobile repository list. */
export function mobileRepositories(view: RepositoryListView): string {
  const content = view.rows.length
    ? `<ol class="mobile-repository-list">${view.rows.map(repositoryRow).join("")}</ol>`
    : `<div class="mobile-repository-empty">${view.empty}</div>`;
  return (
    `<div class="mobile-repositories">` +
    `<header class="mobile-repositories-heading">${view.heading}</header>` +
    optionalFragment(view.connection, "mobile-repositories-connection") +
    content +
    `</div>`
  );
}

/** Arrange one repository's authoritative fragments into the mobile task composition. */
export function mobileRepository(view: RepositoryDetailView): string {
  return (
    `<div class="mobile-repository">` +
    `<header class="mobile-repository-heading"><div class="mobile-repository-title">${view.heading}</div>` +
    `<div class="mobile-repository-state"><div class="mobile-repository-runtime">${view.runtime}</div>` +
    `<div class="mobile-repository-access">${view.access}</div></div></header>` +
    `<nav class="mobile-section-nav" aria-label="Repository sections">` +
    `<a href="#overview">Overview</a><a href="#configuration">Configuration</a><a href="#activity">Activity</a></nav>` +
    `<section id="overview" class="mobile-overview" aria-labelledby="mobile-overview-heading">` +
    `<h2 id="mobile-overview-heading" class="mobile-section-heading">Overview</h2>` +
    `<div class="mobile-deployment-summaries">` +
    `<section class="mobile-deployment-summary" aria-labelledby="mobile-current-heading">` +
    `<h3 id="mobile-current-heading">Current</h3>${view.current}</section>` +
    `<section class="mobile-deployment-summary" aria-labelledby="mobile-desired-heading">` +
    `<h3 id="mobile-desired-heading">Desired</h3>${view.desired}</section></div></section>` +
    `<section id="configuration" class="mobile-configuration-section" aria-labelledby="mobile-configuration-heading">` +
    `<h2 id="mobile-configuration-heading" class="mobile-section-heading">Configuration</h2>` +
    `<div class="mobile-policy-summary"><h3>Release policy</h3>${view.policy}</div>` +
    `<div class="mobile-configuration-content">${view.configuration}</div>` +
    `<div class="mobile-limits-summary"><h3>Limits</h3><div class="mobile-limits-content">${view.limits}</div></div>` +
    `<div class="mobile-preview-summary"><h3>Preview</h3><div class="mobile-preview-content">${view.preview}</div></div></section>` +
    `<section id="activity" class="mobile-activity" aria-labelledby="mobile-activity-heading">` +
    `<h2 id="mobile-activity-heading" class="mobile-section-heading">Activity</h2>` +
    `<div class="mobile-operations-summary"><h3>Operations</h3><div class="mobile-operations-content">${view.operations}</div></div>` +
    `<div class="mobile-redeploy-summary"><h3>Redeploy</h3><div class="mobile-redeploy-content">${view.redeploy}</div></div></section>` +
    `</div>`
  );
}
