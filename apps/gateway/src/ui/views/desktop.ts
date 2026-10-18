import { evidenceLedgerRepositories } from "./repository-ledger-list.js";
import { evidenceLedgerRepository } from "./evidence-ledger.js";
import type { RepositoryDetailView, RepositoryListView } from "../presentation.js";

/**
 * Layout styles for the Desktop composition. The shared document renderer should
 * append this string to PORTAL_STYLES when mode is "desktop".
 */
export const DESKTOP_STYLES = `
.page-shell:has(.desktop-composition) {
  width: 100%;
  padding-block: 2rem 3rem;
}
.desktop-composition {
  min-width: 0;
  color: var(--ink);
}
.desktop-page-heading {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 1.5rem;
  margin-bottom: 1.25rem;
}
.desktop-page-heading > * { min-width: 0; width: 100%; }
.desktop-connection > .status-panel { margin: 0; padding: 0; border: 0; }
.desktop-row-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.desktop-page-heading h1 {
  margin: 0;
  font-size: clamp(1.65rem, 3vw, 1.9rem);
  line-height: 1.2;
  letter-spacing: -.035em;
}
.desktop-connection {
  margin-bottom: 1rem;
  padding: .55rem .8rem;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--surface);
  color: var(--muted);
  font-size: .82rem;
}
.desktop-repository-table-wrap {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--surface);
}
.desktop-repository-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  text-align: left;
}
.desktop-repository-table caption {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  clip-path: inset(50%);
}
.desktop-repository-table th,
.desktop-repository-table td { min-width: 0; padding: .85rem 1rem; vertical-align: middle; }
.desktop-repository-table thead { background: #fafbfc; }
.desktop-repository-table th {
  border-bottom: 1px solid var(--line);
  color: var(--muted);
  font-size: .72rem;
  font-weight: 650;
}
.desktop-repository-table td { border-bottom: 1px solid var(--line); font-size: .86rem; }
.desktop-repository-table tbody tr:last-child td { border-bottom: 0; }
.desktop-repository-table tbody tr:hover { background: #fafbfd; }
.desktop-repository-table th:nth-child(1) { width: 38%; }
.desktop-repository-table th:nth-child(2) { width: 13%; }
.desktop-repository-table th:nth-child(3) { width: 13%; }
.desktop-repository-table th:nth-child(4) { width: 20%; }
.desktop-repository-table th:nth-child(5) { width: 16%; }
.desktop-cell-label { display: none; }
.desktop-row-identity,
.desktop-row-runtime,
.desktop-row-access,
.desktop-row-operation,
.desktop-row-actions { min-width: 0; overflow-wrap: anywhere; }
.desktop-row-identity > :first-child { font-weight: 650; }
.desktop-row-installation,
.desktop-row-reason,
.desktop-row-revisions { display: block; margin-top: .28rem; color: var(--muted); font-size: .77rem; font-weight: 400; }
.desktop-row-reason { line-height: 1.45; }
.desktop-row-revisions summary { min-height: 0; font-size: .77rem; }
.desktop-row-revisions details { margin-top: .25rem; }
.desktop-row-actions > * { max-width: 100%; }
.desktop-row-actions form { margin: 0; }
.desktop-row-actions .button,
.desktop-row-actions button { min-height: 38px; padding: .45rem .7rem; font-size: .82rem; }
.desktop-empty-state {
  padding: 1.25rem;
  color: var(--muted);
  font-size: .9rem;
}
.desktop-empty-state > :first-child { margin-top: 0; }
.desktop-empty-state > :last-child { margin-bottom: 0; }
.desktop-detail-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1.5rem;
  margin-bottom: 1rem;
}
.desktop-detail-heading > * { min-width: 0; }
.desktop-detail-heading h1 { overflow-wrap: anywhere; }
.desktop-detail-state {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: .55rem 1rem;
  margin-top: .65rem;
  color: var(--muted);
  font-size: .84rem;
}
.desktop-section-nav {
  position: sticky;
  z-index: 1;
  top: 0;
  display: flex;
  gap: 1.65rem;
  margin: 0 0 1.5rem;
  border-bottom: 1px solid var(--line);
  background: var(--surface);
}
.desktop-section-nav a {
  display: inline-flex;
  min-height: 44px;
  align-items: center;
  border-bottom: 2px solid transparent;
  color: var(--muted);
  font-size: .85rem;
  font-weight: 650;
  text-decoration: none;
}
.desktop-section-nav a:hover,
.desktop-section-nav a:focus-visible { color: var(--ink); }
.desktop-region {
  min-width: 0;
  margin: 0 0 2rem;
  padding: 0;
  scroll-margin-top: 4rem;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}
.desktop-region > h2 {
  margin: 0 0 .85rem;
  font-size: 1.1rem;
  letter-spacing: -.02em;
}
.desktop-deployment-comparison {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1rem;
  align-items: start;
}
.desktop-deployment {
  min-width: 0;
  padding: 1rem 1.15rem;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--surface);
}
.desktop-deployment > .release-card { padding: 0; }
.desktop-deployment > :first-child { margin-top: 0; }
.desktop-deployment > :last-child { margin-bottom: 0; }
.desktop-deployment > section {
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}
.desktop-deployment > section > h2 { margin-top: 0; }
.desktop-configuration-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.8fr) minmax(220px, .8fr);
  gap: 1rem;
  align-items: start;
}
.desktop-configuration-layout > *,
.desktop-preview,
.desktop-activity-content > * { min-width: 0; }
.desktop-preview { margin-top: 1rem; }
.desktop-configuration-main {
  min-width: 0;
  padding: 1.15rem;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--surface);
}
.desktop-configuration-main > section {
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}
.desktop-configuration-main > section > section {
  margin: .85rem 0 0;
  padding: .85rem 0 0;
  border: 0;
  border-top: 1px solid var(--line);
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}
.desktop-configuration-layout aside {
  min-width: 0;
  padding: 1rem;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--surface);
}
.desktop-configuration-layout aside > :first-child,
.desktop-preview > :first-child,
.desktop-activity-content > :first-child { margin-top: 0; }
.desktop-configuration-layout aside > :last-child,
.desktop-preview > :last-child,
.desktop-activity-content > :last-child { margin-bottom: 0; }
.desktop-preview {
  padding: 1rem 1.15rem;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--surface);
}
.desktop-activity-content { display: grid; gap: 1rem; }
.desktop-activity-content > * { margin: 0; }
.desktop-redeploy { margin-top: 0; }
.desktop-redeploy .inline-form { display: inline-flex; }
@media (max-width: 920px) {
  .page-shell:has(.desktop-composition) { width: min(100% - 2rem, 1280px); }
  .desktop-repository-table,
  .desktop-repository-table tbody { display: block; }
  .desktop-repository-table thead {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    clip-path: inset(50%);
  }
  .desktop-repository-table tbody tr {
    display: grid;
    grid-template-columns: minmax(0, 1.7fr) minmax(0, 1fr);
    gap: .35rem 1rem;
    padding: .9rem 1rem;
    border-bottom: 1px solid var(--line);
  }
  .desktop-repository-table tbody tr:last-child { border-bottom: 0; }
  .desktop-repository-table td {
    display: grid;
    grid-template-columns: minmax(5.2rem, .36fr) minmax(0, 1fr);
    gap: .6rem;
    padding: .2rem 0;
    border: 0;
  }
  .desktop-cell-label { display: inline; color: var(--muted); font-size: .72rem; font-weight: 600; }
  .desktop-repository-table td[data-column="Repository"] { grid-column: 1 / -1; }
  .desktop-row-actions { grid-column: 1 / -1; }
  .desktop-section-nav { top: 0; }
}
@media (max-width: 640px) {
  .page-shell:has(.desktop-composition) { width: min(100% - 2rem, 1280px); padding-block: 1.25rem 2rem; }
  .desktop-page-heading,
  .desktop-detail-heading { align-items: flex-start; flex-direction: column; gap: .7rem; }
  .desktop-connection { margin-bottom: .75rem; }
  .desktop-repository-table tbody tr { grid-template-columns: minmax(0, 1fr); gap: .45rem; padding: .85rem; }
  .desktop-repository-table td { grid-template-columns: 5.4rem minmax(0, 1fr); }
  .desktop-repository-table td[data-column="Repository"] { grid-column: auto; }
  .desktop-repository-table td[data-column="Repository"] .desktop-cell-label { display: inline; }
  .desktop-row-actions { grid-column: auto; }
  .desktop-deployment-comparison,
  .desktop-configuration-layout { grid-template-columns: minmax(0, 1fr); }
  .desktop-section-nav { flex-wrap: wrap; gap: .4rem 1.1rem; }
  .desktop-section-nav a { flex: 0 0 auto; }
}
@media (prefers-reduced-motion: reduce) {
  .desktop-composition *, .desktop-composition *::before, .desktop-composition *::after {
    scroll-behavior: auto;
  }
}
`;

export function desktopRepositories(view: RepositoryListView): string {
  return evidenceLedgerRepositories(view, "desktop");
}

export function desktopRepository(view: RepositoryDetailView): string {
  return evidenceLedgerRepository(view, "desktop");
}
