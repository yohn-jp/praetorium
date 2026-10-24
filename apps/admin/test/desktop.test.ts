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
    expect(html).toContain("View diagnostics and recovery");
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

    expect(html).toContain("Attempt history and last reported stage");
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

  it("orders failure detail before recovery and identifiers and labels summary-only or absent evidence truthfully", () => {
    const render = (evidence: SourceBuildDetail["evidence"], diagnostic: SourceBuildDetail["attempts"][number]["diagnostic"]) =>
      renderDesktopConsole(view({
        selectedBuildId: job.id,
        detail: dependency("GET /v1/operator/source-builds/:id", {
          job,
          nextCursor: null,
          evidence,
          attempts: [{
            id: "attempt-current", attempt: 2, revision: 7, leaseEpoch: 3, state: "failed",
            stage: "metadata", startedAt: null, finishedAt: null, failureCode: job.error,
            evidence, expiresAt: evidence === "expired" ? 1_799_000_000_000 : null, diagnostic,
          }],
        }),
      }));
    const detailed = render("available", {
      stage: "metadata", reason: "verification_failed", summary: "Metadata verification failed.",
      excerpt: "git rev-parse HEAD failed", truncated: false,
    });
    const order = ["AUTHORITATIVE CURRENT STATE", "Recorded stage and reason", "Sanitized excerpt",
      "SAFE NEXT ACTION", "TECHNICAL IDENTIFIERS", "Attempt history"];
    const positions = order.map((text) => detailed.indexOf(text));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(detailed).toContain("This summary describes a failure category and may not identify the root cause.");
    expect(detailed).toContain("Scriptorium");

    const summaryOnly = render("available", {
      stage: "metadata", reason: "verification_failed", summary: "Metadata verification failed.", truncated: false,
    });
    expect(summaryOnly).toContain("Diagnostic evidence · Summary only");
    expect(summaryOnly).toContain("No detailed diagnostic excerpt was recorded.");
    expect(summaryOnly).not.toContain("View sanitized diagnostic excerpt");

    expect(render("not_recorded", null)).toContain("Diagnostic evidence was not recorded for this attempt.");
    expect(render("expired", null)).toContain("Diagnostic evidence expired");
    expect(render("available", null)).toContain("Diagnostic evidence is marked available, but its details are unavailable in this response.");
  });

  it("does not present an older revision's attempt as current on a history page", () => {
    const olderRevision = {
      id: "attempt-old-revision", attempt: job.attempt, revision: job.revision - 1, leaseEpoch: 9,
      state: "failed" as const, stage: "buildkit" as const, startedAt: 1_797_000_000_000,
      finishedAt: 1_797_000_120_000, failureCode: job.error, evidence: "available" as const,
      expiresAt: null, diagnostic: {
        stage: "buildkit" as const, reason: "build_failed" as const,
        summary: "Old revision failure must stay in its own attempt history.", excerpt: "old revision excerpt", truncated: false,
      },
    };
    const html = renderDesktopConsole(view({
      selectedBuildId: job.id,
      pageCursor: "history-older",
      detail: dependency("GET /v1/operator/source-builds/:id", {
        job, attempts: [olderRevision], nextCursor: null, evidence: "available",
      }),
    }));
    const start = html.indexOf('<section class="desktop-section desktop-failure-detail"');
    const failure = html.slice(start, html.indexOf("</section>", start));
    expect(failure).toContain("The current attempt is not included on this history page.");
    expect(failure).toContain(`href="/builds/${job.id}?ui=desktop"`);
    expect(failure).toContain("Not recorded");
    expect(failure).not.toContain("Old revision failure");
    expect(failure).not.toContain("old revision excerpt");
    expect(html).toContain("old revision excerpt");
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
    expect(denied).toContain("Retry is not permitted by the current queue policy.");
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
    expect(overview.indexOf("Active incidents")).toBeLessThan(overview.indexOf("CURRENT STABLE"));
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
    expect(releasePage).toContain("Inspect Canary / Stable");
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
        failure: { code: "BUILD_FAILED", retryable: false },
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
    const unavailableStable = renderDesktopConsole({ ...extended,
      catalog: { ...base.catalog, value: null, status: 503, code: "OPERATOR_UNAVAILABLE" },
    });
    expect(unavailableStable).toContain("Current Stable status is unavailable.");
    expect(unavailableStable).not.toContain("Current Stable release is not recorded.");
    expect(html).toContain("does not by itself mean the release is Stable");
    expect(html).toContain("Back to Releases");
    expect(html).toContain('href="/releases/rel_canary?ui=mobile"');

    const denied = renderDesktopConsole({
      ...extended,
      releaseDetail: dependency("GET /v1/operator/releases/rel_canary", {
        ...releaseDetail,
        workflow: { ...releaseDetail.workflow, state: "promoted", failureCode: null },
      }),
    });
    expect(denied).not.toContain('name="idempotencyKey"');
  });

  it("explains a known Canary configuration conflict on Source and Release detail without inventing operation links", () => {
    const conflict = "canary_configuration_conflict";
    const guidance = "Canary configuration changed or an operation is still active; inspect the current operation and let normal recovery finish before automatic retry.";
    const source = renderDesktopConsole(view({
      selectedBuildId: job.id,
      detail: dependency("GET /v1/operator/source-builds/:id", {
        job: { ...job, error: conflict },
        nextCursor: null,
        evidence: "available",
        attempts: [{
          id: "attempt-conflict", attempt: job.attempt, revision: job.revision, leaseEpoch: 9,
          state: "failed", stage: "metadata", startedAt: null, finishedAt: null,
          failureCode: conflict, evidence: "not_recorded", expiresAt: null, diagnostic: null,
        }],
      }),
    }));
    expect(source).toContain(`<code>${conflict}</code>`);
    expect(source).toContain(guidance);
    expect(source).not.toContain('href="/operations/');

    const release = renderDesktopConsole(view({
      section: "releases", selectedReleaseId: "rel_conflict",
      releaseDetail: dependency("GET /v1/operator/releases/rel_conflict", {
        release: { id: "rel_conflict", version: "0.3.8", imageDigest: "sha256:" + "d".repeat(64), status: "candidate" },
        workflow: { state: "canary_building", revision: 12, failureCode: conflict, attempts: 2,
          nextAttemptAt: null, canaryBuildKey: null, canaryOperationId: null },
        build: { id: "build_conflict", status: "building", attemptCount: 1, failure: null },
      }),
    }));
    expect(release).toContain(`<code>${conflict}</code>`);
    expect(release).toContain(guidance);
    expect(release).not.toContain('href="/operations/');
    expect(release).not.toContain(">Retry Canary build</button>");
  });

  it("provides a high contrast keyboard focus and narrow viewport layout", () => {
    expect(DESKTOP_ADMIN_STYLES).toContain(":focus-visible");
    expect(DESKTOP_ADMIN_STYLES).toContain("grid-template-columns:248px");
    expect(DESKTOP_ADMIN_STYLES).toContain("@media(max-width:760px)");
    expect(DESKTOP_ADMIN_STYLES).toContain("#f5f3eb");
    expect(DESKTOP_ADMIN_STYLES).toContain("#194937");
  });
});

it("keeps bounded build and release pages reachable while preserving the selected state and sort", () => {
  const builds = renderDesktopConsole(view({ buildStateFilter: "building", buildSort: "state",
    builds: dependency("queue", { items: [], nextCursor: "older.page" }) }));
  expect(builds).toContain("No Source builds match the selected state.");
  expect(builds).toContain('href="/builds?ui=desktop&amp;sort=state&amp;cursor=older.page&amp;state=building"');
  expect(builds).not.toContain('href="/builds/' + job.id);
  const releases = renderDesktopConsole(view({ section: "releases",
    catalog: dependency("catalog", { items: [], nextCursor: "older.release", stableChannel: null }) }));
  expect(releases).toContain('href="/releases?ui=desktop&amp;cursor=older.release"');
});

it("describes an admission retry as re-verifying the existing output", () => {
  const html = renderDesktopConsole(view({ selectedBuildId: job.id,
    detail: dependency("detail", { job: { ...job, error: "SOURCE_ADMISSION_RETRIES_EXHAUSTED" },
      attempts: [], evidence: "not_recorded", nextCursor: null }) }));
  expect(html).toContain('type="submit">Retry admission</button>');
  expect(html).toContain("existing produced result");
  expect(html).not.toContain('type="submit">Retry Source build</button>');
});


it("preserves server-filtered Builds and Audit context on Desktop/Mobile switch", () => {
  const builds = renderDesktopConsole(view({
    section: "builds", buildStateFilter: "failed", buildSort: "attempt",
    ...({ pageCursor: "queue_older" } as object),
  }));
  expect(builds).toContain('href="/builds?ui=mobile&amp;sort=attempt&amp;state=failed&amp;cursor=queue_older"');
  const audit = renderDesktopConsole(view({
    section:"audit", auditQuery:"lease epoch", ...({ pageCursor:"12:evt_1" } as object),
  }));
  expect(audit).toContain('href="/audit?ui=mobile&amp;q=lease+epoch&amp;cursor=12%3Aevt_1"');
});

it("links allowlisted operation identities from the Audit ledger", () => {
  const html=renderDesktopConsole(view({section:"audit",audit:dependency("audit",{
    events:[{eventId:"aud_1",action:"release.canary-wait.skipped",outcome:"accepted",actorId:"213253858",
      occurredAt:1792000000000,operationId:"op_01J9Z7H3M4P6Q8R2S5T0V1WXYZ",jobId:null,releaseId:null,failureCode:null}],
    nextCursor:null,
  })}));
  expect(html).toContain('href="/operations/op_01J9Z7H3M4P6Q8R2S5T0V1WXYZ?ui=desktop"');
});


it("keeps both Release and Operation evidence destinations when one audit event refers to both", () => {
  const html=renderDesktopConsole(view({section:"audit",audit:dependency("audit",{
    events:[{eventId:"aud_2",action:"release.canary-wait.skipped",outcome:"accepted",
      actorId:"213253858",occurredAt:1792000000000,
      releaseId:"rel_candidate",operationId:"op_01J9Z7H3M4P6Q8R2S5T0V1WXYZ",jobId:null,failureCode:null}],
    nextCursor:null,
  })}));
  expect(html).toContain('href="/releases/rel_candidate?ui=desktop"');
  expect(html).toContain('href="/operations/op_01J9Z7H3M4P6Q8R2S5T0V1WXYZ?ui=desktop"');
});


it("keeps an independent Source failure active when a different version is admitted", () => {
  const older={...job,id:"sr_00000000-0000-4000-a000-000000000002",version:"0.3.3",tag:"v0.3.3"};
  const newer={...job,id:"sr_00000000-0000-4000-a000-000000000003",
    version:"0.3.4",tag:"v0.3.4",state:"admitted" as const,error:null,retryable:false,
    admittedReleaseId:"rel_current"};
  const html=renderDesktopConsole(view({section:"overview",
    builds:dependency("GET /v1/operator/source-builds",{items:[older,newer],nextCursor:null})}));
  expect(html).toContain("No release promoted yet");
  expect(html).toContain("SOURCE_BUILD_FAILED");
  expect(html).not.toContain("No unresolved failed builds");
});


it("does not offer duplicate Source dispatch for an already admitted version", () => {
  const admitted={...job,sourceId:"scriptorium",releaseId:416422590,
    version:"0.3.4",tag:"v0.3.4",state:"admitted" as const,
    admittedReleaseId:"rel_abcd",error:null,retryable:false};
  const source: SourceReleaseView={
    source:{id:"scriptorium",label:"Scriptorium",githubRepository:"yohn-jp/scriptorium",adapter:"scriptorium-v1"},
    releases:[{id:416422590,tag:"v0.3.4",name:"0.3.4",version:"0.3.4",
      prerelease:false,publishedAt:"2026-10-23T15:58:15Z",notes:""}],
    error:null,endpoint:"github",status:200,code:null,
  };
  const html=renderDesktopConsole(view({section:"releases",
    builds:dependency("builds",{items:[admitted],nextCursor:null}),
    sourceViews:dependency("sources",[source])}));
  expect(html).toContain('href="/releases/rel_abcd?ui=desktop"');
  expect(html).not.toContain('action="/source-releases/deploy?ui=desktop"');
});
