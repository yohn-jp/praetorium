import { describe, expect, it } from "vitest";
import type {
  SourceBuildAttempt,
  SourceBuildDetail,
  SourceBuildSummary,
} from "@praetorium/contracts";
import type { ConsoleDependency, ConsoleReleaseStatus, ConsoleViewModel } from "./view-model.js";
import { MOBILE_ADMIN_STYLES, renderMobileConsole } from "./mobile.js";

const sourceJob: SourceBuildSummary = {
  id: "sr_54a61e4d-088c-453e-98ca-6be8588a4e1f",
  sourceId: "scriptorium",
  releaseId: 416422590,
  tag: "v0.3.3",
  commit: "a".repeat(40),
  version: "0.3.3",
  state: "failed",
  attempt: 1,
  revision: 5,
  error: "SOURCE_BUILD_FAILED",
  admittedReleaseId: null,
  retryable: true,
};

const attempt: SourceBuildAttempt = {
  id: "attempt-1",
  attempt: 1,
  revision: 5,
  leaseEpoch: 2,
  state: "failed",
  stage: "buildkit",
  startedAt: 1_792_000_000_000,
  finishedAt: 1_792_000_004_000,
  failureCode: "BUILD_STEP_FAILED",
  evidence: "available",
  expiresAt: 1_794_592_000_000,
  diagnostic: {
    stage: "buildkit",
    reason: "build_failed",
    summary: "Compiler exited with a nonzero status.",
    excerpt: "step failed: <script>alert('secret')</script>",
    truncated: false,
  },
};

function dependency<T>(value: T | null, endpoint: string): ConsoleDependency<T> {
  return {
    endpoint,
    status: value === null ? 503 : 200,
    code: value === null ? "UNAVAILABLE" : null,
    value,
  };
}

function model(overrides: Partial<ConsoleViewModel> = {}): ConsoleViewModel {
  const detail: SourceBuildDetail = {
    job: sourceJob,
    attempts: [attempt],
    nextCursor: null,
    evidence: "available",
  };
  return {
    section: "builds",
    mode: "mobile",
    csrf: "csrf-fixture",
    notice: null,
    catalog: dependency(
      {
        items: [
          {
            release: {
              id: "release-123",
              version: "2.3.4",
              imageDigest: "sha256:" + "b".repeat(64),
              status: "available",
              createdAt: "2026-10-20T12:00:00Z",
            },
            workflow: null,
          },
        ],
        stableChannel: { currentReleaseId: "release-123", revision: 4 },
      },
      "GET /v1/operator/releases",
    ),
    sourceViews: dependency(
      [
        {
          source: {
            id: "scriptorium",
            label: "Scriptorium",
            githubRepository: "yohn-jp/scriptorium",
            adapter: "scriptorium-v1",
          },
          releases: [
            {
              id: 416422590,
              tag: "v0.3.3",
              name: "Scriptorium 0.3.3",
              version: "0.3.3",
              publishedAt: "2026-10-21T10:20:00Z",
              prerelease: false,
              notes: "A published release.",
            },
          ],
          error: null,
          endpoint: "GET /repos/yohn-jp/scriptorium/releases",
          status: 200,
          code: null,
        },
      ],
      "GitHub Releases",
    ),
    builds: dependency({ items: [sourceJob], nextCursor: null }, "GET /v1/operator/source-builds"),
    audit: dependency(
      {
        events: [
          {
            actorId: "213253858",
            action: "source_build_retry_requested",
            outcome: "accepted",
            occurredAt: 1_792_000_000_000,
          },
        ],
        nextCursor: null,
      },
      "GET /v1/operator/releases/audit",
    ),
    detail: dependency(detail, "GET /v1/operator/source-builds/:id"),
    selectedBuildId: null,
    buildStateFilter: null,
    auditQuery: "",
    ...overrides,
  };
}

describe("mobile operator console", () => {
  it("renders four task tabs and active build cards without a desktop table", () => {
    const html = renderMobileConsole(model());
    expect(html).toContain('class="admin-console admin-mobile-console"');
    expect(html).toContain('<nav class="admin-mobile-tabs" aria-label="Operator sections">');
    for (const label of ["Overview", "Releases", "Builds", "Audit"]) expect(html).toContain(label);
    expect(html).toContain('href="/builds?ui=mobile" aria-current="page">Builds</a>');
    expect(html).toContain('href="/builds/sr_54a61e4d-088c-453e-98ca-6be8588a4e1f?ui=mobile"');
    expect(html).toContain('<section class="admin-mobile-main" id="admin-mobile-main"');
    expect(html).not.toContain('<main class="admin-mobile-main"');
    expect(html).not.toContain("<table");
    expect(html).toContain("v0.3.3");
    expect(html).toContain("Attempt 1");
    expect(html.match(/action="\/source-builds\//g)).toBeNull();
  });

  it("puts a failed build and a safe next step first on Overview without retrying", () => {
    const html = renderMobileConsole(model({ section: "overview" }));
    expect(html.indexOf("ACTIVE INCIDENT")).toBeLessThan(html.indexOf("Current Stable"));
    expect(html).toContain(
      "Review the recorded attempt evidence before choosing the available retry.",
    );
    expect(html).toContain("Review build</a>");
    expect(html).not.toContain('action="/source-builds/');
    expect(html).toContain("release-123");
  });

  it("keeps operation notices in a fixed live region outside the content flow", () => {
    const html = renderMobileConsole(model({ notice: "Retry accepted" }));
    expect(html).toContain(
      '<div class="admin-mobile-toast" role="status" aria-live="polite">Retry accepted</div>',
    );
    expect(html).not.toContain('class="admin-mobile-notice"');
    expect(MOBILE_ADMIN_STYLES).toContain(".admin-mobile-toast{position:fixed");
  });

  it("shows full attempt evidence safely and places the revision-fenced retry in the detail action region", () => {
    const html = renderMobileConsole(model({ selectedBuildId: sourceJob.id }));
    expect(html).toContain("Attempt history and last reported stage");
    expect(html).toContain("buildkit");
    expect(html).toContain("BUILD_STEP_FAILED");
    expect(html).toContain("Compiler exited with a nonzero status.");
    expect(html).toContain("step failed: &lt;script&gt;alert(&#39;secret&#39;)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain('aria-label="Build recovery action"');
    expect(html).toContain(
      'action="/source-builds/sr_54a61e4d-088c-453e-98ca-6be8588a4e1f/retry?ui=mobile"',
    );
    expect(html).toContain('name="expectedRevision" value="5"');
    expect(html).toContain('name="csrfToken" value="csrf-fixture"');
    expect(html).toContain('name="idempotencyKey"');
    expect(html).toContain("Retry Source build");
    expect(html).toContain("The recorded failure remains available");
  });

  it("leads with authoritative state and Source, then stage, evidence, recovery, identifiers, and history", () => {
    const html = renderMobileConsole(model({ selectedBuildId: sourceJob.id }));
    const order = ["status-badge status-bad", "AFFECTED SOURCE", "RECORDED FAILURE", "Sanitized excerpt",
      'aria-label="Build recovery action"', "TECHNICAL IDENTIFIERS", "Attempt history"];
    const positions = order.map((text) => html.indexOf(text));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(html).toContain("Scriptorium <span>(scriptorium)</span>");
    expect(html).toContain("may not identify the root cause");
  });

  it("distinguishes summary-only, not recorded, expired, and unavailable diagnostic evidence", () => {
    const render = (evidenceState: SourceBuildAttempt["evidence"], diagnostic: SourceBuildAttempt["diagnostic"]) => {
      const changedAttempt = { ...attempt, evidence: evidenceState, diagnostic };
      const detail: SourceBuildDetail = {
        job: sourceJob, attempts: [changedAttempt], nextCursor: null, evidence: evidenceState,
      };
      return renderMobileConsole(model({
        selectedBuildId: sourceJob.id,
        detail: dependency(detail, "GET /v1/operator/source-builds/:id"),
      }));
    };
    const summaryOnly = render("available", {
      stage: "metadata", reason: "verification_failed", summary: "Metadata verification failed.", truncated: false,
    });
    expect(summaryOnly).toContain("Diagnostic evidence · Summary only");
    expect(summaryOnly).toContain("No detailed diagnostic excerpt was recorded.");
    expect(summaryOnly).not.toContain("Show sanitized diagnostic excerpt");
    expect(render("not_recorded", null)).toContain("Diagnostic evidence was not recorded for this attempt.");
    expect(render("expired", null)).toContain("Diagnostic evidence expired.");
    expect(render("available", null)).toContain("Diagnostic evidence is marked available, but its details are unavailable in this response.");
  });

  it("does not label an older revision's attempt as current on a history page", () => {
    const olderRevision: SourceBuildAttempt = {
      ...attempt,
      id: "attempt-old-revision",
      revision: sourceJob.revision - 1,
      diagnostic: {
        stage: "buildkit", reason: "build_failed",
        summary: "Old revision failure must stay in its own attempt history.",
        excerpt: "old revision excerpt", truncated: false,
      },
    };
    const html = renderMobileConsole(model({
      selectedBuildId: sourceJob.id,
      pageCursor: "history-older",
      detail: dependency({
        job: sourceJob, attempts: [olderRevision], nextCursor: null, evidence: "available",
      }, "GET /v1/operator/source-builds/:id"),
    }));
    const start = html.indexOf('<section class="admin-mobile-section admin-mobile-failure-detail"');
    const failure = html.slice(start, html.indexOf("</section>", start));
    expect(failure).toContain("The current attempt is not included on this history page.");
    expect(failure).toContain(`href="/builds/${sourceJob.id}?ui=mobile"`);
    expect(failure).toContain("Not recorded");
    expect(failure).not.toContain("Old revision failure");
    expect(failure).not.toContain("old revision excerpt");
    expect(html).toContain("old revision excerpt");
  });

  it("renders missing evidence and refuses to offer a retry when queue policy disallows it", () => {
    const unavailableAttempt: SourceBuildAttempt = {
      ...attempt,
      evidence: "not_recorded",
      diagnostic: null,
      expiresAt: null,
    };
    const unavailableJob: SourceBuildSummary = { ...sourceJob, retryable: false };
    const detail: SourceBuildDetail = {
      job: unavailableJob,
      attempts: [unavailableAttempt],
      nextCursor: null,
      evidence: "not_recorded",
    };
    const html = renderMobileConsole(
      model({
        selectedBuildId: sourceJob.id,
        detail: dependency(detail, "GET /v1/operator/source-builds/:id"),
      }),
    );
    expect(html).toContain("Diagnostic evidence was not recorded for this attempt.");
    expect(html).toContain("Retry is unavailable under the current queue policy.");
    expect(html).not.toContain('action="/source-builds/');
  });

  it("orders attempts by lease epoch and preserves the build cursor", () => {
    const newerAttempt: SourceBuildAttempt = {
      ...attempt,
      id: "attempt-2",
      attempt: 1,
      leaseEpoch: 3,
      revision: 6,
      failureCode: "NEWER_FAILURE",
      startedAt: null,
    };
    const detail: SourceBuildDetail = {
      job: sourceJob,
      attempts: [attempt, newerAttempt],
      nextCursor: "older.attempts",
      evidence: "available",
    };
    const html = renderMobileConsole(
      model({
        selectedBuildId: sourceJob.id,
        detail: dependency(detail, "GET /v1/operator/source-builds/:id"),
      }),
    );
    expect(html.indexOf("attempt-2")).toBeLessThan(html.indexOf("attempt-1"));
    expect(html).toContain(
      'href="/builds/sr_54a61e4d-088c-453e-98ca-6be8588a4e1f?ui=mobile&amp;cursor=older.attempts"',
    );
    expect(html).toContain("Older attempts");
    expect(html).toContain("Time unavailable");
  });

  it("explains when legacy attempt history was never recorded", () => {
    const detail: SourceBuildDetail = {
      job: sourceJob,
      attempts: [],
      nextCursor: null,
      evidence: "not_recorded",
    };
    const html = renderMobileConsole(
      model({
        selectedBuildId: sourceJob.id,
        detail: dependency(detail, "GET /v1/operator/source-builds/:id"),
      }),
    );
    expect(html).toContain(
      "No detailed attempt snapshot was recorded. The canonical job summary retains the known attempt and failure; stage and diagnostic evidence are unavailable.",
    );
  });

  it("keeps release selection and immutable digest inspection in Releases", () => {
    const canaryRelease = {
      release: {
        id: "release-canary",
        version: "2.3.5",
        imageDigest: "sha256:" + "c".repeat(64),
        status: "blocked",
        createdAt: "2026-10-22T11:00:00Z",
      },
      workflow: {
        workflow: {
          state: "blocked",
          revision: 6,
          failureCode: "canary_build_failed",
          attempts: 1,
          nextAttemptAt: null,
        },
        build: { status: "failed", failure: { code: "CANARY_BUILD_FAILED" } },
      },
    };
    const html = renderMobileConsole(
      model({
        section: "releases",
        catalog: dependency(
          {
            items: [canaryRelease],
            stableChannel: { currentReleaseId: "release-123", revision: 4 },
          },
          "GET /v1/operator/releases",
        ),
      }),
    );
    expect(html).toContain("CURRENT STABLE CHANNEL");
    expect(html).toContain("v0.3.3");
    expect(html).toContain("Review failure / retry");
    expect(html).toContain("sha256:" + "c".repeat(64));
    expect(html).toContain('action="/releases/release-canary/retry?ui=mobile"');
    expect(html).toContain("Retry Canary build");
  });

  it("shows canonical Canary status, refresh and retry eligibility on release detail", () => {
    const status: ConsoleReleaseStatus = {
      release: {
        id: "release-detail",
        version: "2.3.5",
        imageDigest: "sha256:" + "d".repeat(64),
        status: "candidate",
      },
      workflow: {
        state: "blocked",
        revision: 7,
        failureCode: "canary_build_failed",
        attempts: 2,
        nextAttemptAt: null,
        canaryBuildKey: "build-key-123",
        canaryOperationId: "op-canary-123",
      },
      build: {
        id: "build-canary-123",
        status: "failed",
        attemptCount: 1,
        failure: { code: "BUILD_FAILED", retryable: false },
      },
    };
    const html = renderMobileConsole(
      model({
        section: "releases",
        selectedReleaseId: "release-detail",
        releaseDetail: dependency(status, "GET /v1/operator/releases/release-detail"),
      }),
    );
    expect(html).toContain('href="/releases?ui=mobile">Back to Releases</a>');
    expect(html).toContain('href="/releases/release-detail?ui=mobile">Refresh status</a>');
    expect(html).toContain('href="/releases/release-detail?ui=desktop">Desktop view</a>');
    const base = model({ section: "releases", selectedReleaseId: "release-detail",
      releaseDetail: dependency(status, "GET /v1/operator/releases/release-detail"),
    });
    const unavailableStable = renderMobileConsole({ ...base,
      catalog: { ...base.catalog, value: null, status: 503, code: "UNAVAILABLE" },
    });
    expect(unavailableStable).toContain("Current Stable status is unavailable.");
    expect(unavailableStable).not.toContain("A current Stable release is not recorded.");
    expect(html).toContain("Canary workflow");
    expect(html).toContain("Composition build attempts");
    expect(html).toContain("canary_build_failed");
    expect(html).toContain("sha256:" + "d".repeat(64));
    expect(html).toContain('action="/releases/release-detail/retry?ui=mobile"');
    expect(html).toContain('name="expectedRevision" value="7"');
  });

  it("follows admitted builds to their release status in mobile mode", () => {
    const detail: SourceBuildDetail = {
      job: { ...sourceJob, admittedReleaseId: "release-admitted" },
      attempts: [attempt],
      nextCursor: null,
      evidence: "available",
    };
    const html = renderMobileConsole(
      model({
        selectedBuildId: sourceJob.id,
        detail: dependency(detail, "GET /v1/operator/source-builds/:id"),
      }),
    );
    expect(html).toContain('href="/releases/release-admitted?ui=mobile#composition-build">');
    expect(html).toContain("Composition Build release-admitted");
  });

  it("keeps Audit searchable, bounded and escaped", () => {
    const html = renderMobileConsole(
      model({
        section: "audit",
        auditQuery: "<script>",
      }),
    );
    expect(html).toContain('role="search"');
    expect(html).toContain('name="q" maxlength="100" value="&lt;script&gt;"');
    expect(html).toContain("source_build_retry_requested");
    expect(html).toContain("accepted");
  });

  it("preserves the audit query when loading older events", () => {
    const audit = dependency(
      { events: [], nextCursor: "cursor/older" },
      "GET /v1/operator/releases/audit",
    );
    const html = renderMobileConsole(
      model({ section: "audit", auditQuery: "failed retry", audit }),
    );
    expect(html).toContain(
      'href="/audit?ui=mobile&amp;q=failed%20retry&amp;cursor=cursor%2Folder"',
    );
  });

  it("provides narrow viewport, touch target and safe-area rules", () => {
    expect(MOBILE_ADMIN_STYLES).toContain("max-width:640px");
    expect(MOBILE_ADMIN_STYLES).toContain("@media(max-width:360px)");
    expect(MOBILE_ADMIN_STYLES).toContain("min-height:56px");
    expect(MOBILE_ADMIN_STYLES).toContain("env(safe-area-inset-bottom)");
    expect(MOBILE_ADMIN_STYLES).toContain("word-break:break-word");
  });
});

it("preserves server-filtered build pagination and navigation to older jobs and releases", () => {
  const builds = renderMobileConsole(model({ buildStateFilter: "building",
    builds: dependency({ items: [], nextCursor: "older.page" }, "queue") }));
  expect(builds).toContain("No Source builds match this state filter.");
  expect(builds).not.toContain('href="/builds/' + sourceJob.id);
  expect(builds).toContain('href="/builds?ui=mobile&amp;sort=recent&amp;cursor=older.page&amp;state=building"');
  const releases = renderMobileConsole(model({ section: "releases",
    catalog: dependency({ items: [], nextCursor: "older.release", stableChannel: null }, "catalog") }));
  expect(releases).toContain('href="/releases?ui=mobile&amp;cursor=older.release"');
  expect(releases).toContain("Status unavailable");
  expect(releases).not.toContain("No release promoted yet");
});


it("does not invent a prior failure for a never-claimed queued job", () => {
  const html = renderMobileConsole(model({ selectedBuildId: sourceJob.id,
    detail: dependency({ job: { ...sourceJob, state: "queued", attempt: 0, error: null, retryable: false },
      attempts: [], nextCursor: null, evidence: "not_recorded" }, "detail") }));
  expect(html).toContain("No Worker attempt has started.");
  expect(html).not.toContain("known attempt and failure");
});

it("describes admission recovery without promising another source build attempt", () => {
  const html = renderMobileConsole(model({ selectedBuildId: sourceJob.id,
    detail: dependency({ job: { ...sourceJob, error: "SOURCE_ADMISSION_RETRIES_EXHAUSTED" },
      attempts: [], evidence: "not_recorded", nextCursor: null }, "detail") }));
  expect(html).toContain('type="submit">Retry admission</button>');
  expect(html).toContain("existing produced result");
  expect(html).not.toContain('type="submit">Retry Source build</button>');
});


it("preserves list pagination, state and audit search when switching to desktop", () => {
  const builds=renderMobileConsole(model({
    section:"builds",buildStateFilter:"failed",buildSort:"attempt",
    ...({pageCursor:"queue_older"} as object),
  }));
  expect(builds).toContain('href="/builds?ui=desktop&amp;sort=attempt&amp;state=failed&amp;cursor=queue_older"');
  const audit=renderMobileConsole(model({section:"audit",auditQuery:"lease epoch",
    ...({pageCursor:"12:evt_1"} as object)}));
  expect(audit).toContain('href="/audit?ui=desktop&amp;q=lease+epoch&amp;cursor=12%3Aevt_1"');
});

it("links Canary operation evidence from the mobile audit trail", () => {
  const html=renderMobileConsole(model({section:"audit",
    audit:dependency({events:[{eventId:"aud_1",action:"release.canary-wait.skipped",
      outcome:"accepted",actorId:"213253858",occurredAt:1792000000000,
      operationId:"op_123",jobId:null,releaseId:null,failureCode:null}],nextCursor:null},"audit"),
  }));
  expect(html).toContain('href="/operations/op_123?ui=mobile"');
});


it("keeps an independently failed Source visible after a different version is admitted", () => {
  const newer={...sourceJob,id:"sr_00000000-0000-4000-a000-000000000003",
    version:"0.3.4",tag:"v0.3.4",state:"admitted" as const,error:null,
    retryable:false,admittedReleaseId:"rel_current"};
  const html=renderMobileConsole(model({section:"overview",
    builds:dependency({items:[sourceJob,newer],nextCursor:null},"builds")}));
  const from=html.indexOf('class="admin-mobile-focus"');
  const focus=html.slice(from,html.indexOf("</section>",from));
  expect(focus).toContain("v0.3.3");
  expect(focus).toContain("ACTIVE INCIDENT");
  expect(focus).toContain("SOURCE_BUILD_FAILED");
});


it("never offers Build and deploy again for an already admitted Source version", () => {
  const admitted={...sourceJob,releaseId:416422590,tag:"v0.3.4",version:"0.3.4",
    state:"admitted" as const,error:null,retryable:false,admittedReleaseId:"rel_abcd"};
  const html=renderMobileConsole(model({
    section:"releases",
    builds:dependency({items:[admitted],nextCursor:null},"source builds"),
    sourceViews:dependency([{source:{id:"scriptorium",label:"Scriptorium",githubRepository:"yohn-jp/scriptorium",
      adapter:"scriptorium-v1"},releases:[{id:416422590,tag:"v0.3.4",name:"v0.3.4",
      version:"0.3.4",publishedAt:"2026-10-23T15:58:15Z",prerelease:false,notes:""}],
      error:null,endpoint:"github",status:200,code:null}],"source views"),
  }));
  expect(html).toContain('href="/releases/rel_abcd?ui=mobile"');
  expect(html).not.toContain('action="/source-releases/deploy?ui=mobile"');
});
