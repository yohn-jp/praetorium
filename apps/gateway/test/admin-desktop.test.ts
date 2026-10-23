import { describe, expect, it } from "vitest";
import type { SourceBuildDetail, SourceBuildSummary } from "@praetorium/contracts";
import { renderDesktopConsole } from "../src/admin/desktop.js";
import { DESKTOP_ADMIN_STYLES } from "../src/admin/desktop-styles.js";
import type { ConsoleDependency, ConsoleViewModel } from "../src/admin/view-model.js";
import type { SourceReleaseView } from "../src/admin/release-sources.js";

const job: SourceBuildSummary = {
  id: "sr_00000000-0000-4000-a000-000000000001",
  sourceId: "scriptorium",
  releaseId: 416422590,
  tag: "v0.3.3",
  commit: "a".repeat(40),
  version: "0.3.3",
  state: "failed",
  attempt: 2,
  revision: 7,
  error: "SOURCE_BUILD_FAILED",
  admittedReleaseId: null,
  retryable: true,
};

function dependency<T>(endpoint: string, value: T | null, status: number | null = 200): ConsoleDependency<T> {
  return { endpoint, value, status, code: value === null ? "OPERATOR_UNAVAILABLE" : null };
}

function view(overrides: Partial<ConsoleViewModel> = {}): ConsoleViewModel {
  return {
    section: "builds",
    mode: "desktop",
    csrf: "csrf<&\"",
    notice: null,
    catalog: dependency("GET /v1/operator/releases", {
      items: [], stableChannel: { currentReleaseId: null, revision: 0 },
    }),
    sourceViews: dependency("GET GitHub Releases", []),
    builds: dependency("GET /v1/operator/source-builds", { items: [job], nextCursor: null }),
    audit: dependency("GET /v1/operator/releases/audit", { events: [], nextCursor: null }),
    detail: null,
    selectedBuildId: null,
    buildStateFilter: null,
    auditQuery: "",
    ...overrides,
  };
}

describe("desktop operator composition", () => {
  it("renders separate keyboard-navigable sections and a state-filterable build table", () => {
    const html = renderDesktopConsole(view({ buildStateFilter: "failed" }));
    expect(html).toContain('aria-label="Operator sections"');
    expect(html).toContain('href="/releases?ui=desktop"');
    expect(html).toContain('href="/builds?ui=desktop" aria-current="page"');
    expect(html).toContain('href="/audit?ui=desktop"');
    expect(html).toContain('<select id="desktop-build-state" name="state">');
    expect(html).toContain('<option value="failed" selected>failed</option>');
    expect(html).toContain("v0.3.3");
    expect(html).toContain("a".repeat(40));
    expect(html).toContain("Retry available on detail");
  });

  it("shows attempt-scoped evidence and emits only the canonical revision-fenced retry fields", () => {
    const detail: SourceBuildDetail = {
      job,
      nextCursor: null,
      evidence: "available",
      attempts: [{
        id: "attempt-2",
        attempt: 2,
        revision: 7,
        leaseEpoch: 3,
        state: "failed",
        stage: "buildkit",
        startedAt: 1_797_000_000_000,
        finishedAt: 1_797_000_120_000,
        failureCode: "SOURCE_BUILD_FAILED",
        evidence: "available",
        expiresAt: 1_799_000_000_000,
        diagnostic: {
          stage: "buildkit",
          reason: "build_failed",
          summary: "Sanitized phase: <script>untrusted</script>",
          excerpt: "compiler output: <script>alert(1)</script>",
          truncated: true,
        },
      }],
    };
    const html = renderDesktopConsole(view({
      section: "builds",
      selectedBuildId: job.id,
      detail: dependency("GET /v1/operator/source-builds/:id", detail),
    }));

    expect(html).toContain("Attempt and stage timeline");
    expect(html).toContain("buildkit");
    expect(html).toContain("View sanitized diagnostic excerpt");
    expect(html).toContain("Sanitized phase: &lt;script&gt;untrusted&lt;/script&gt;");
    expect(html).toContain("compiler output: &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain('name="expectedRevision" value="7"');
    expect(html).toContain('name="idempotencyKey" value="');
    expect(html).toContain('name="csrfToken" value="csrf&lt;&amp;&quot;"');
    expect(html).toContain("Attempt ID <code>attempt-2</code>");
    expect(html).toContain('class="desktop-notice-slot" aria-live="polite"');
  });

  it("keeps queue outages separate from build failures and hides retry when policy denies it", () => {
    const unavailable = renderDesktopConsole(view({
      builds: { ...dependency("GET /v1/operator/source-builds", null, null), reason: "schema_missing" },
    }));
    expect(unavailable).toContain("Source build queue status unavailable.");
    expect(unavailable).toContain("Required D1 schema is missing; check applied migrations.");
    expect(unavailable).not.toContain("Build failed");

    const denied = renderDesktopConsole(view({
      selectedBuildId: job.id,
      detail: dependency("GET /v1/operator/source-builds/:id", {
        job: { ...job, retryable: false }, attempts: [], nextCursor: null, evidence: "not_recorded",
      }),
    }));
    expect(denied).toContain("Retry not permitted");
    expect(denied).not.toContain('name="idempotencyKey"');
    expect(denied).toContain("Canonical failure code <code>SOURCE_BUILD_FAILED</code>");
    expect(denied).toContain("Diagnostic evidence was not recorded for this job.");
  });

  it("puts current Stable and immutable source identity on Overview and Releases", () => {
    const release = {
      release: {
        id: "rel_stable", version: "1.2.3", imageDigest: "sha256:" + "b".repeat(64),
        status: "available", createdAt: "2026-10-20T00:00:00.000Z",
      },
      workflow: null,
    };
    const overview = renderDesktopConsole(view({
      section: "overview",
      catalog: dependency("GET /v1/operator/releases", {
        items: [release], stableChannel: { currentReleaseId: "rel_stable", revision: 4 },
      }),
    }));
    expect(overview.indexOf("CURRENT STABLE")).toBeLessThan(overview.indexOf("Active incidents"));
    expect(overview).toContain("sha256:" + "b".repeat(64));

    const source: SourceReleaseView = {
      source: {
        id: "scriptorium", label: "Scriptorium", githubRepository: "yohn-jp/scriptorium",
        adapter: "scriptorium-v1",
      },
      releases: [{
        id: job.releaseId, tag: job.tag, name: "Scriptorium v0.3.3", version: job.version,
        publishedAt: "2026-10-20T00:00:00.000Z", prerelease: false, notes: "",
      }],
      error: null, endpoint: "GET GitHub Releases", status: 200, code: null,
    };
    const releasePage = renderDesktopConsole(view({
      section: "releases",
      sourceViews: dependency("GET GitHub Releases", [source]),
      catalog: dependency("GET /v1/operator/releases", {
        items: [{
          release: {
            id: "rel_platform", version: "1.2.3", imageDigest: "sha256:" + "b".repeat(64),
            status: "available", createdAt: "2026-10-20T00:00:00.000Z",
          },
          workflow: null,
        }],
        stableChannel: { currentReleaseId: "rel_platform", revision: 2 },
      }),
      builds: dependency("GET /v1/operator/source-builds", {
        items: [{ ...job, state: "admitted", admittedReleaseId: "rel_admitted", retryable: false }], nextCursor: null,
      }),
    }));
    expect(releasePage).toContain("Resolved immutable commit");
    expect(releasePage).toContain(job.commit);
    expect(releasePage).toContain("Immutable OCI digest");
    expect(releasePage).toContain("Build &amp; deploy");
    expect(releasePage).toContain('href="/builds/sr_00000000-0000-4000-a000-000000000001?ui=desktop"');

    const admittedJobPage = renderDesktopConsole(view({
      builds: dependency("GET /v1/operator/source-builds", {
        items: [{ ...job, state: "admitted", admittedReleaseId: "rel_admitted", retryable: false }], nextCursor: null,
      }),
    }));
    expect(admittedJobPage).toContain('href="/releases/rel_admitted?ui=desktop"');
  });

  it("renders canonical release detail and a revision-fenced Canary retry without implying Stable", () => {
    const releaseDetail = {
      release: {
        id: "rel_canary", version: "1.4.0", imageDigest: "sha256:" + "c".repeat(64), status: "candidate",
      },
      workflow: {
        state: "blocked", revision: 9, failureCode: "canary_build_failed", attempts: 2,
        nextAttemptAt: null, canaryBuildKey: "canary:rel_canary", canaryOperationId: "op_canary",
      },
      build: {
        id: "build_canary", status: "failed", attemptCount: 1,
        failure: { code: "CANARY_BUILD_FAILED", retryable: true },
      },
    };
    const base = view({ section: "releases" });
    const extended = {
      ...base,
      selectedReleaseId: "rel_canary",
      releaseDetail: dependency("GET /v1/operator/releases/rel_canary", releaseDetail),
    };
    const html = renderDesktopConsole(extended);

    expect(html).toContain("CANONICAL RELEASE STATUS");
    expect(html).toContain("Workflow attempts</dt><dd>2");
    expect(html).toContain("canary_build_failed");
    expect(html).toContain("sha256:" + "c".repeat(64));
    expect(html).toContain('name="expectedRevision" value="9"');
    expect(html).toContain('name="idempotencyKey" value="');
    expect(html).toContain('href="/releases/rel_canary?ui=desktop">Refresh status</a>');
    expect(html).toContain("does not by itself mean the release is Stable");
    expect(html).toContain("Back to Releases");
    expect(html).toContain('href="/releases/rel_canary?ui=mobile"');

    const denied = renderDesktopConsole({
      ...extended,
      releaseDetail: dependency("GET /v1/operator/releases/rel_canary", {
        ...releaseDetail,
        build: { ...releaseDetail.build, failure: { code: "CANARY_BUILD_FAILED", retryable: false } },
      }),
    });
    expect(denied).not.toContain('name="idempotencyKey"');
  });

  it("provides a high contrast keyboard focus and narrow viewport layout", () => {
    expect(DESKTOP_ADMIN_STYLES).toContain(":focus-visible");
    expect(DESKTOP_ADMIN_STYLES).toContain("grid-template-columns:248px");
    expect(DESKTOP_ADMIN_STYLES).toContain("@media(max-width:760px)");
    expect(DESKTOP_ADMIN_STYLES).toContain("#f5f3eb");
    expect(DESKTOP_ADMIN_STYLES).toContain("#194937");
  });
});
