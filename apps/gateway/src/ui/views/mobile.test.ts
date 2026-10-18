import { describe, expect, it } from "vitest";
import { MOBILE_STYLES, mobileRepositories, mobileRepository } from "./mobile.js";
import type { RepositoryDetailView, RepositoryListView } from "../presentation.js";

function listView(overrides: Partial<RepositoryListView> = {}): RepositoryListView {
  return {
    heading: "<h1>Repositories</h1>",
    connection: "<p>GitHub App active</p>",
    rows: [
      {
        identity: '<a href="/repositories/123">owner/long-project-name</a>',
        runtime: "<span>Blocked</span>",
        access: "<span>Maintain access</span>",
        installation: "<span>Installation active</span>",
        reason: "<p>Choose an approved configuration.</p>",
        operation: "<p>No operation</p>",
        revisions: "<dl><dt>Desired image</dt><dd><code>sha256:full-exact-digest</code></dd></dl>",
        actions: '<a href="/repositories/123">Review configuration</a>',
      },
    ],
    empty: "<p>No repositories are available.</p>",
    ...overrides,
  };
}

function detailView(overrides: Partial<RepositoryDetailView> = {}): RepositoryDetailView {
  return {
    heading: "<h1>owner/project</h1>",
    runtime: "<span>Ready</span>",
    access: "<span>Maintain access</span>",
    current: "<dl><dt>Image</dt><dd>sha256:current</dd></dl>",
    desired: "<dl><dt>Image</dt><dd>sha256:desired</dd></dl>",
    policy: "<p>Follow stable releases</p>",
    configuration:
      '<form action="/repositories/123/actions"><label>Resource profile<select name="resourceProfileId"><option>small</option></select></label></form>',
    limits: "<p>1 CPU · 2 GiB</p>",
    preview: '<button type="submit">Preview selection</button>',
    operations: "<p>Build failed</p>",
    redeploy:
      '<form action="/repositories/123/actions"><button name="action" value="redeploy">Redeploy</button></form>',
    ...overrides,
  };
}

describe("mobile UI compositions", () => {
  it("orders repository summaries and retains installation, revisions, and existing actions", () => {
    const html = mobileRepositories(listView());
    const fragments = [
      "owner/long-project-name",
      "Blocked",
      "Maintain access",
      "Choose an approved configuration.",
      "No operation",
      "Review configuration",
      "Installation active",
      "Current and desired revisions",
      "sha256:full-exact-digest",
    ];
    const positions = fragments.map((fragment) => html.indexOf(fragment));

    expect(html).toContain('<ol class="mobile-repository-list">');
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(html).not.toContain("<table");
    expect(html).not.toContain("hidden");
  });

  it("renders only the supplied empty state when there are no rows", () => {
    const html = mobileRepositories(listView({ rows: [] }));

    expect(html).toContain(
      '<div class="mobile-repository-empty"><p>No repositories are available.</p>',
    );
    expect(html).not.toContain("mobile-repository-list");
    expect(html).not.toContain("Review configuration");
  });

  it("keeps overview, configuration, and activity mounted behind native section links", () => {
    const html = mobileRepository(detailView());

    expect(html).toContain('<a href="#overview">Overview</a>');
    expect(html).toContain('<a href="#configuration">Configuration</a>');
    expect(html).toContain('<a href="#activity">Activity</a>');
    const positions = [
      html.indexOf('id="overview"'),
      html.indexOf('id="configuration"'),
      html.indexOf('id="activity"'),
    ];
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    for (const fragment of [
      '<h3 id="mobile-current-heading">Current</h3>',
      "sha256:current",
      '<h3 id="mobile-desired-heading">Desired</h3>',
      "sha256:desired",
      "Follow stable releases",
      "Resource profile",
      "1 CPU · 2 GiB",
      "Preview selection",
      "Build failed",
      'value="redeploy"',
    ]) {
      expect(html).toContain(fragment);
    }
    expect(html.match(/<form\b/g)).toHaveLength(2);
    expect(html).not.toContain(" hidden");
    expect(html).not.toContain("<script");
  });

  it("uses full-width mobile controls and 44px touch targets", () => {
    expect(MOBILE_STYLES).toContain("min-height: 44px");
    expect(MOBILE_STYLES).toContain("width: 100%");
    expect(MOBILE_STYLES).toContain("overflow-wrap: anywhere");
  });
});
