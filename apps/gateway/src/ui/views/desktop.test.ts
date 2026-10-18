import { describe, expect, it } from "vitest";
import { DESKTOP_STYLES, desktopRepositories, desktopRepository } from "./desktop.js";
import type { RepositoryDetailView, RepositoryListView } from "../presentation.js";

describe("Desktop repository compositions", () => {
  it("keeps repository-specific state and actions in aligned table columns", () => {
    const view: RepositoryListView = {
      heading: `<h1>Repositories <span>2 available</span></h1>`,
      connection: `<span>GitHub connection: Active</span>`,
      rows: [
        {
          identity: `<a href="/repositories/123?ui=desktop">owner/long-project-name</a>`,
          runtime: `<span>Blocked</span>`,
          access: `<span>Read</span>`,
          installation: `GitHub App: Suspended`,
          reason: `Approval is required<br>before this repository can run.`,
          operation: `No operation`,
          revisions: `<details><summary>Image revisions</summary><code>sha256:full-digest</code></details>`,
          actions: `<a href="/repositories/123?ui=desktop">Open details</a>`,
        },
      ],
      empty: `<p>No repositories available.</p>`,
    };

    const html = desktopRepositories(view);

    expect(html).toContain(
      `<div class="desktop-connection"><span>GitHub connection: Active</span></div>`,
    );
    expect(html).toContain(`<th scope="col">Repository</th><th scope="col">Runtime</th>`);
    expect(html).toContain(
      `<th scope="col">Access</th><th scope="col">Latest operation</th><th scope="col">Actions</th>`,
    );
    expect(html).toContain(`<span class="desktop-row-installation">GitHub App: Suspended</span>`);
    expect(html).toContain(
      `<span class="desktop-row-reason">Approval is required<br>before this repository can run.</span>`,
    );
    expect(html).toContain(
      `<details class="desktop-row-revisions"><summary>Image revisions</summary><details><summary>Image revisions</summary><code>sha256:full-digest</code></details></details>`,
    );
    expect(html).toContain(
      `<td class="desktop-row-actions" data-column="Actions"><span class="desktop-cell-label">Actions</span><a href="/repositories/123?ui=desktop">Open details</a></td>`,
    );
    expect(html).not.toContain("No repositories available.");
  });

  it("renders the real empty state without inventing repository rows", () => {
    const html = desktopRepositories({
      heading: `<h1>Repositories <span>0 available</span></h1>`,
      connection: `<span>GitHub connection: Pending</span>`,
      rows: [],
      empty: `<h2>No repositories available</h2><p>Install the Praetorium App to continue.</p>`,
    });

    expect(html).toContain(`<h1>Repositories <span>0 available</span></h1>`);
    expect(html).toContain(`<div class="desktop-empty-state"><h2>No repositories available</h2>`);
    expect(html).toContain(`Install the Praetorium App to continue.`);
    expect(html).not.toContain(`<table class="desktop-repository-table">`);
    expect(html).not.toContain(`<tr class="desktop-repository-row">`);
  });

  it("keeps all detail regions mounted and places shared fragments under native anchors", () => {
    const view: RepositoryDetailView = {
      heading: `<h1>owner/project</h1>`,
      runtime: `<span>Ready</span>`,
      access: `<span>Maintain</span>`,
      evidence: `<p>Build failed while runtime remains Ready</p>`,
      current: `<section aria-label="Current deployment"><h3>Current</h3><code>sha256:current</code></section>`,
      desired: `<section aria-label="Desired deployment"><h3>Desired</h3><code>sha256:desired</code></section>`,
      policy: `<p>Release policy: stable</p>`,
      configuration: `<form action="/repositories/123/actions?ui=desktop"><button>Save configuration and build</button></form>`,
      limits: `<p>Operator limits: 4 CPU</p>`,
      preview: `<div role="status">Preview unavailable</div>`,
      operations: `<article>Latest operation: build failed</article>`,
      redeploy: `<form><button>Retry operation</button></form>`,
    };

    const html = desktopRepository(view);

    expect(html).toContain(`<a href="#overview">Overview</a>`);
    expect(html).toContain(`<a href="#configuration">Configuration</a>`);
    expect(html).toContain(`<a href="#activity">Activity</a>`);
    expect(html).toContain(`<section id="overview"`);
    expect(html).toContain(`evidence-workspace`);
    expect(html).toContain(`Build failed while runtime remains Ready`);
    expect(html.indexOf(`Build failed while runtime remains Ready`)).toBeLessThan(html.indexOf(view.current));
    expect(html.indexOf(view.current)).toBeLessThan(html.indexOf(view.desired));
    expect(html).toContain(
      `<div class="desktop-configuration-main">${view.policy}${view.configuration}</div>`,
    );
    expect(html).toContain(`<aside class="desktop-limits">${view.limits}</aside>`);
    expect(html).toContain(`<div class="desktop-preview">${view.preview}</div>`);
    expect(html).toContain(`<div class="desktop-operations">${view.operations}</div>`);
    expect(html).toContain(`<div class="desktop-redeploy">${view.redeploy}</div>`);
    expect(html.indexOf(`id="overview"`)).toBeLessThan(html.indexOf(`id="configuration"`));
    expect(html.indexOf(`id="configuration"`)).toBeLessThan(html.indexOf(`id="activity"`));
  });

  it("provides stacked layouts at tablet and phone widths", () => {
    expect(DESKTOP_STYLES).toContain("@media (max-width: 920px)");
    expect(DESKTOP_STYLES).toContain("@media (max-width: 640px)");
    expect(DESKTOP_STYLES).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(DESKTOP_STYLES).not.toContain("overflow-x: auto");
  });
});
