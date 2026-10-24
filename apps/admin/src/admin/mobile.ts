import { generateToken } from "@praetorium/auth";
import { canaryWaitSkipForm } from "./canary-wait-action.js";
import { activeReleaseFailures, prioritySourceBuild } from "./incident-status.js";
import type {
  SourceBuildAttempt,
  SourceBuildDetail,
  SourceBuildSummary,
} from "@praetorium/contracts";
import { escapeHtml } from "../presentation.js";
import {
  buildHref,
  operationHref,
  consoleHref,
  viewHref,
  type ConsoleDependency,
  type ConsoleRelease,
  type ConsoleReleaseStatus,
  type ConsoleSection,
  type ConsoleViewModel,
} from "./view-model.js";
import type { PublishedSourceRelease, SourceReleaseView } from "./release-sources.js";
import { MOBILE_ADMIN_STYLES } from "./mobile-styles.js";
import { infrastructureOverview, renderInfrastructure } from "./infrastructure-view.js";

const SECTIONS: readonly { readonly id: ConsoleSection; readonly label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "infrastructure", label: "Hosts" },
  { id: "releases", label: "Releases" },
  { id: "builds", label: "Builds" },
  { id: "audit", label: "Audit" },
];

function value(input: unknown): string {
  return escapeHtml(input === null || input === undefined ? "" : String(input));
}

function tone(state: string): string {
  return ["available", "complete", "promoted", "succeeded", "admitted", "produced"].includes(state)
    ? "status-good"
    : ["blocked", "failed", "rejected", "lease_expired"].includes(state)
      ? "status-bad"
      : "status-warn";
}

function badge(state: string, label = state.replaceAll("_", " ")): string {
  return '<span class="status-badge ' + tone(state) + '">' + value(label) + "</span>";
}

function sectionUnavailable<T>(title: string, dependency: ConsoleDependency<T>): string {
  if (dependency.value !== null) return "";
  const status = dependency.status === null ? "unavailable" : String(dependency.status);
  return (
    '<div class="admin-mobile-unavailable" role="status"><strong>' +
    value(title) +
    " unavailable.</strong><span>Endpoint: <code>" +
    value(dependency.endpoint) +
    "</code></span><span>HTTP status: <code>" +
    value(status) +
    "</code>; code: <code>" +
    value(dependency.code ?? "OPERATOR_UNAVAILABLE") +
    "</code>.</span>" +
    (dependency.reason ? "<span>Reason: " + value(dependency.reason) + "</span>" : "") +
    "</div>"
  );
}

function formatTime(timestamp: number | null): {
  readonly label: string;
  readonly iso: string | null;
} {
  if (timestamp === null || !Number.isFinite(timestamp))
    return { label: "Time unavailable", iso: null };
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return { label: "Time unavailable", iso: null };
  return {
    label: date.toISOString().replace("T", " ").slice(0, 19) + " UTC",
    iso: date.toISOString(),
  };
}

function timeElement(timestamp: number | null): string {
  const time = formatTime(timestamp);
  return time.iso
    ? '<time datetime="' + value(time.iso) + '">' + value(time.label) + "</time>"
    : "<span>" + value(time.label) + "</span>";
}

function modeHref(model: ConsoleViewModel, mode: "desktop" | "mobile"): string {
  return viewHref(model, mode);
}

function mobileNavigation(model: ConsoleViewModel): string {
  const active: ConsoleSection = model.selectedReleaseId
    ? "releases"
    : model.selectedBuildId
      ? "builds"
      : model.section;
  return (
    '<nav class="admin-mobile-tabs" aria-label="Operator sections"><ul>' +
    SECTIONS.map(
      (section) =>
        '<li><a href="' +
        value(consoleHref(section.id, "mobile")) +
        '"' +
        (active === section.id ? ' aria-current="page"' : "") +
        ">" +
        value(section.label) +
        "</a></li>",
    ).join("") +
    "</ul></nav>"
  );
}

function header(model: ConsoleViewModel): string {
  return (
    '<a class="admin-mobile-skip" href="#admin-mobile-main">Skip to main content</a>' +
    '<header class="admin-mobile-header"><a class="admin-mobile-brand" href="' +
    value(consoleHref("overview", "mobile")) +
    '"><span class="admin-mobile-mark" aria-hidden="true">P</span>' +
    '<span>Praetorium <em>Admin</em></span></a><div class="admin-mobile-header-actions">' +
    '<a class="admin-mobile-mode" href="' +
    value(modeHref(model, "desktop")) +
    '">Desktop view</a>' +
    '<form method="post" action="/logout"><input type="hidden" name="csrfToken" value="' +
    value(model.csrf) +
    '"><button class="button button-secondary" type="submit">Sign out</button></form>' +
    "</div></header>"
  );
}

function toast(model: ConsoleViewModel): string {
  return model.notice
    ? '<div class="admin-mobile-toast" role="status" aria-live="polite">' +
        value(model.notice) +
        "</div>"
    : "";
}

function pageHeading(title: string, description: string): string {
  return (
    '<header class="admin-mobile-page-heading"><span class="admin-kicker">OPERATOR / CONTROL PLANE</span>' +
    "<h1>" +
    value(title) +
    "</h1><p>" +
    value(description) +
    "</p></header>"
  );
}

function jobCard(job: SourceBuildSummary, compact = false): string {
  const status = job.state === "queued" ? "Queued" : job.state.replaceAll("_", " ");
  return (
    '<article class="admin-mobile-job-card' +
    (compact ? " admin-mobile-job-card-compact" : "") +
    '">' +
    '<a class="admin-mobile-job-link" href="' +
    value(buildHref(job.id, "mobile")) +
    '">' +
    '<div class="admin-mobile-job-card-heading">' +
    badge(job.state, status) +
    '<span class="admin-mobile-attempt-count">Attempt ' +
    value(job.attempt) +
    "</span></div>" +
    "<h3>" +
    value(job.sourceId) +
    " / " +
    value(job.tag) +
    "</h3>" +
    '<code class="admin-mobile-job-id">' +
    value(job.id) +
    "</code>" +
    '</a><dl class="admin-mobile-job-facts"><div><dt>Version</dt><dd>' +
    value(job.version) +
    "</dd></div><div><dt>Revision</dt><dd>" +
    value(job.revision) +
    "</dd></div></dl>" +
    (job.error
      ? '<p class="admin-mobile-error-code">Failure code: <code>' + value(job.error) + "</code></p>"
      : "") +
    "</article>"
  );
}

function nextSafeAction(job: SourceBuildSummary): string {
  if (job.state === "failed")
    return job.retryable
      ? "Review the recorded attempt evidence before choosing the available retry."
      : "Retry is unavailable under the current queue policy. Review the recorded evidence.";
  if (job.state === "queued")
    return "Accepted and waiting for a Worker. No completion time is available.";
  if (job.state === "building")
    return "The Worker is building this source. Wait for its next recorded state.";
  if (job.state === "produced")
    return "The image was produced. Check the admission state before treating it as available.";
  return "The Source build was admitted. Review the release ledger for promotion status.";
}

function overview(model: ConsoleViewModel): string {
  const jobs = model.builds.value?.items ?? [];
  const focusJob = prioritySourceBuild(jobs);
  const active = focusJob && ["failed", "building", "queued"].includes(focusJob.state);
  const incident = !model.builds.value
    ? sectionUnavailable("Source build queue", model.builds)
    : focusJob
      ? '<section class="admin-mobile-focus" aria-labelledby="admin-mobile-focus-title">' +
        '<div class="admin-mobile-focus-heading"><span class="admin-kicker">' +
        (focusJob.state === "failed"
          ? "ACTIVE INCIDENT"
          : active
            ? "SOURCE BUILD"
            : "LATEST SOURCE BUILD") +
        "</span>" +
        badge(
          focusJob.state,
          focusJob.state === "queued" ? "Queued" : focusJob.state.replaceAll("_", " "),
        ) +
        '</div><h2 id="admin-mobile-focus-title">' +
        value(focusJob.sourceId) +
        " / " +
        value(focusJob.tag) +
        '</h2><p class="admin-mobile-job-id"><code>' +
        value(focusJob.id) +
        "</code></p>" +
        (focusJob.error ? "<p>Failure code: <code>" + value(focusJob.error) + "</code></p>" : "") +
        '<p class="admin-mobile-next-action"><strong>Next safe action</strong><span>' +
        value(nextSafeAction(focusJob)) +
        '</span></p><a class="button" href="' +
        value(buildHref(focusJob.id, "mobile")) +
        '">Review build</a></section>'
      : '<section class="admin-mobile-focus"><span class="admin-kicker">SOURCE BUILDS</span>' +
        "<h2>No builds in the current view</h2><p>Queue a published Source release from the Releases tab.</p>" +
        '<a class="button" href="' +
        value(consoleHref("releases", "mobile")) +
        '">Open Releases</a></section>';

  const channel = model.catalog.value?.stableChannel;
  const stable = channel ? channel.currentReleaseId ?? "No release promoted yet" : "Status unavailable";
  const blockedReleases =
    activeReleaseFailures(model.catalog.value?.items ?? []).slice(0, 3) ??
    [];
  const releases =
    model.catalog.value === null
      ? sectionUnavailable("Release ledger", model.catalog)
      : blockedReleases.length
        ? '<ul class="admin-mobile-release-list">' +
          blockedReleases
            .map(
              (item) =>
                '<li><a href="/releases/' +
                value(encodeURIComponent(item.release.id)) +
                '?ui=mobile">' +
                "<strong>" +
                value(item.release.version) +
                "</strong><span>" +
                value(item.release.status.replaceAll("_", " ")) +
                "</span></a></li>",
            )
            .join("") +
          "</ul>"
        : '<p class="admin-mobile-empty-inline">No blocked releases in the current ledger page.</p>';

  const activeJobs = jobs.filter(job => ["queued", "building", "produced"].includes(job.state));
  const recent = (activeJobs.length ? activeJobs : jobs).slice(0, 4);
  return (
    incident +
    '<section class="admin-mobile-section"><div class="admin-mobile-section-heading">' +
    '<h2>Current Stable</h2><a href="' +
    value(consoleHref("releases", "mobile")) +
    '">View releases</a></div>' +
    '<p class="admin-mobile-stable">' +
    value(stable) +
    "</p></section>" +
    '<section class="admin-mobile-section"><div class="admin-mobile-section-heading">' +
    '<h2>Blocked releases</h2><a href="' +
    value(consoleHref("releases", "mobile")) +
    '">Release ledger</a></div>' +
    releases +
    "</section>" +
    '<section class="admin-mobile-section"><div class="admin-mobile-section-heading">' +
    '<h2>Build activity</h2><a href="' +
    value(consoleHref("builds", "mobile")) +
    '">All builds</a></div>' +
    (model.builds.value
      ? recent.length
        ? '<div class="admin-mobile-job-list">' +
          recent.map((job) => jobCard(job, true)).join("") +
          "</div>"
        : '<p class="admin-mobile-empty-inline">No active Source builds in this view.</p>'
      : "") +
    "</section>"
  );
}

function sourceReleaseCard(
  sourceId: string,
  release: PublishedSourceRelease,
  csrf: string,
  builds: readonly SourceBuildSummary[],
): string {
  const build = builds.find((job) => job.sourceId === sourceId && job.releaseId === release.id);
  const progress = build
    ? '<p class="admin-mobile-release-progress">Build Worker: ' +
      badge(build.state) +
      (build.error ? "<span>Failure code: <code>" + value(build.error) + "</code></span>" : "") +
      "</p>"
    : "";
  const selectedHref = build?.state === "admitted" && build.admittedReleaseId
    ? "/releases/" + encodeURIComponent(build.admittedReleaseId) + "?ui=mobile"
    : build ? buildHref(build.id, "mobile") : null;
  const action = build && selectedHref
    ? '<a class="button button-secondary" href="' + value(selectedHref) + '">' +
      (build.state === "admitted" ? "Inspect Canary / Stable" :
        build.state === "failed" ? "Review failure / retry" : "View current build") + '</a>'
    : release.version
      ? '<form method="post" action="/source-releases/deploy?ui=mobile">' +
        '<input type="hidden" name="csrfToken" value="' +
        value(csrf) +
        '">' +
        '<input type="hidden" name="sourceId" value="' +
        value(sourceId) +
        '">' +
        '<input type="hidden" name="releaseId" value="' +
        value(release.id) +
        '">' +
        '<button type="submit">Build &amp; deploy</button></form>'
      : '<p class="admin-mobile-muted">Not deployable: release tag is not SemVer.</p>';
  return (
    '<article class="admin-mobile-release-card"><div class="admin-mobile-release-title">' +
    '<span class="admin-kicker">' +
    (release.prerelease ? "PRERELEASE" : "PUBLISHED RELEASE") +
    "</span>" +
    "<h3>" +
    value(release.tag) +
    "</h3><p>" +
    value(release.name) +
    "</p></div>" +
    '<dl class="admin-mobile-release-facts"><div><dt>Version</dt><dd>' +
    value(release.version ?? "Not deployable") +
    "</dd></div><div><dt>Published</dt><dd>" +
    value(release.publishedAt.slice(0, 10)) +
    "</dd></div></dl>" +
    (release.notes
      ? '<p class="admin-mobile-release-notes">' + value(release.notes) + "</p>"
      : "") +
    progress +
    '<div class="admin-mobile-card-action">' +
    action +
    "</div></article>"
  );
}

function sourceView(
  view: SourceReleaseView,
  csrf: string,
  builds: readonly SourceBuildSummary[],
): string {
  const releases = view.error
    ? '<p class="admin-mobile-unavailable" role="status">' +
      value(view.error) +
      " Endpoint: <code>" +
      value(view.endpoint) +
      "</code>; HTTP status: <code>" +
      value(view.status === null ? "unavailable" : view.status) +
      "</code>; code: <code>" +
      value(view.code ?? "GITHUB_RELEASES_UNAVAILABLE") +
      "</code>.</p>"
    : view.releases.length
      ? '<div class="admin-mobile-release-list">' +
        view.releases
          .map((release) => sourceReleaseCard(view.source.id, release, csrf, builds))
          .join("") +
        "</div>"
      : '<p class="admin-mobile-empty-inline">No published GitHub Releases were found.</p>';
  return (
    '<section class="admin-mobile-section" aria-labelledby="source-' +
    value(view.source.id) +
    '">' +
    '<div class="admin-mobile-section-heading"><div><span class="admin-kicker">SOURCE / ' +
    value(view.source.githubRepository) +
    '</span><h2 id="source-' +
    value(view.source.id) +
    '">' +
    value(view.source.label) +
    "</h2></div></div>" +
    releases +
    "</section>"
  );
}

function releaseRetryForm(release: ConsoleRelease, csrf: string): string {
  const workflow = release.workflow?.workflow;
  const state = workflow?.state ?? release.release.status;
  const preRuntimeFailure =
    (state === "blocked" && workflow?.failureCode === "canary_build_failed") ||
    (state === "canary_building" && workflow?.failureCode === null);
  if (
    !workflow ||
    !Number.isSafeInteger(workflow.revision) ||
    workflow.revision < 0 ||
    !preRuntimeFailure ||
    release.workflow?.build?.status !== "failed"
  )
    return "";
  return (
    '<form method="post" action="/releases/' +
    value(encodeURIComponent(release.release.id)) +
    '/retry?ui=mobile"><input type="hidden" name="csrfToken" value="' +
    value(csrf) +
    '"><input type="hidden" name="expectedRevision" value="' +
    value(workflow.revision) +
    '"><input type="hidden" name="idempotencyKey" value="' +
    value(generateToken(128)) +
    '"><button class="button button-secondary" type="submit">Retry Canary build</button></form>'
  );
}

function platformRelease(release: ConsoleRelease, csrf: string): string {
  const workflow = release.workflow?.workflow;
  const state = workflow?.state ?? release.release.status;
  const failureCode = workflow?.failureCode ?? release.workflow?.build?.failure?.code ?? null;
  return (
    '<article class="admin-mobile-platform-release"><div class="admin-mobile-release-title">' +
    '<span class="admin-kicker">PLATFORM RELEASE</span><h3><a href="/releases/' +
    value(encodeURIComponent(release.release.id)) +
    '?ui=mobile">' +
    value(release.release.version) +
    '</a></h3><p class="admin-mobile-release-id"><code>' +
    value(release.release.id) +
    "</code></p></div>" +
    '<div class="admin-mobile-release-status">' +
    badge(state) +
    (failureCode ? "<p>Failure code: <code>" + value(failureCode) + "</code></p>" : "") +
    "</div>" +
    '<dl class="admin-mobile-release-facts"><div><dt>Created</dt><dd>' +
    value(release.release.createdAt) +
    '</dd></div></dl><div class="admin-mobile-digest"><span class="admin-kicker">OCI IMAGE DIGEST</span>' +
    "<code>" +
    value(release.release.imageDigest) +
    "</code></div>" +
    '<div class="admin-mobile-card-action">' +
    releaseRetryForm(release, csrf) +
    "</div></article>"
  );
}

function releases(model: ConsoleViewModel): string {
  const builds = model.builds.value?.items ?? [];
  const sourceContent =
    model.sourceViews.value === null
      ? sectionUnavailable("GitHub Release catalog", model.sourceViews)
      : model.sourceViews.value.length
        ? model.sourceViews.value.map((view) => sourceView(view, model.csrf, builds)).join("")
        : '<p class="admin-mobile-empty-inline">No release sources are registered.</p>';
  const platformContent =
    model.catalog.value === null
      ? sectionUnavailable("Release ledger", model.catalog)
      : model.catalog.value.items.length
        ? '<div class="admin-mobile-platform-releases">' +
          model.catalog.value.items
            .map((release) => platformRelease(release, model.csrf))
            .join("") +
          "</div>"
        : '<p class="admin-mobile-empty-inline">No admitted platform releases yet.</p>';
  const channel = model.catalog.value?.stableChannel;
  const stable = channel ? channel.currentReleaseId ?? "No release promoted yet" : "Status unavailable";
  return (
    pageHeading(
      "Releases",
      "Select a published Source release and inspect admitted platform artifacts.",
    ) +
    '<section class="admin-mobile-stable-panel"><span class="admin-kicker">CURRENT STABLE CHANNEL</span>' +
    "<strong>" +
    value(stable) +
    "</strong></section>" +
    sourceContent +
    '<section class="admin-mobile-section" aria-labelledby="platform-release-ledger">' +
    '<div class="admin-mobile-section-heading"><div><span class="admin-kicker">ADMISSION / PROMOTION</span>' +
    '<h2 id="platform-release-ledger">Platform release ledger</h2></div></div>' +
    platformContent +
    (model.catalog.value?.nextCursor ? '<a class="button button-secondary admin-mobile-older" href="' +
      value(consoleHref("releases", "mobile") + "&cursor=" + encodeURIComponent(model.catalog.value.nextCursor)) + '">Older releases</a>' : "") +
    "</section>"
  );
}

function buildFilter(model: ConsoleViewModel): string {
  const options = [
    ["", "All states"],
    ["queued", "Queued"],
    ["building", "Building"],
    ["produced", "Produced"],
    ["admitted", "Admitted"],
    ["failed", "Failed"],
  ] as const;
  const selected = model.buildStateFilter ?? "";
  return (
    '<form class="admin-mobile-filter" method="get" action="/builds" aria-label="Filter builds">' +
    '<input type="hidden" name="ui" value="mobile"><input type="hidden" name="sort" value="' + value(model.buildSort ?? "recent") + '"><label for="admin-mobile-build-state">State</label>' +
    '<select id="admin-mobile-build-state" name="state">' +
    options
      .map(
        ([state, label]) =>
          '<option value="' +
          value(state) +
          '"' +
          (selected === state ? " selected" : "") +
          ">" +
          value(label) +
          "</option>",
      )
      .join("") +
    '</select><button class="button button-secondary" type="submit">Apply</button></form>'
  );
}

function builds(model: ConsoleViewModel): string {
  const jobs = model.builds.value?.items ?? []; // The queue applies filters before page limiting.
  const cursor = model.builds.value?.nextCursor;
  const nextQuery = new URLSearchParams({ ui: "mobile", sort: model.buildSort ?? "recent", ...(cursor ? { cursor } : {}) });
  if (model.buildStateFilter) nextQuery.set("state", model.buildStateFilter);
  const empty = model.buildStateFilter
    ? "No Source builds match this state filter."
    : "No Source builds are available on this page.";
  return (
    pageHeading("Builds", "Review Source jobs, recorded attempts and permitted recovery actions.") +
    buildFilter(model) +
    (model.builds.value === null
      ? sectionUnavailable("Source build queue", model.builds)
      : jobs.length
        ? '<div class="admin-mobile-job-list" aria-label="Source builds">' +
          jobs.map((job) => jobCard(job)).join("") +
          "</div>"
        : '<p class="admin-mobile-empty">' + value(empty) + "</p>") +
    (cursor ? '<a class="button button-secondary admin-mobile-older" href="/builds?' + value(nextQuery.toString()) + '">Older builds</a>' : "") +
    '<p class="admin-subtext">State filtering and sorting are performed before queue pagination.</p>'
  );
}

function evidence(attempt: SourceBuildAttempt): string {
  if (attempt.evidence !== "available" || !attempt.diagnostic) {
    const label =
      attempt.evidence === "expired"
        ? "Diagnostic evidence expired."
        : attempt.evidence === "not_recorded"
          ? "Diagnostic evidence was not recorded for this attempt."
          : "Diagnostic details are not available for this attempt.";
    return '<p class="admin-mobile-evidence-unavailable" role="status">' + value(label) + "</p>";
  }
  const diagnostic = attempt.diagnostic;
  return (
    '<section class="admin-mobile-diagnostic"><h4>Recorded diagnostic</h4>' +
    "<p>" +
    value(diagnostic.summary || "No failure summary was recorded.") +
    "</p>" +
    "<dl><div><dt>Reason</dt><dd>" +
    value(diagnostic.reason.replaceAll("_", " ")) +
    "</dd></div><div><dt>Diagnostic stage</dt><dd>" +
    value(
      diagnostic.stage === "unknown"
        ? "Unknown / not recorded"
        : diagnostic.stage.replaceAll("_", " "),
    ) +
    "</dd></div><div><dt>Evidence</dt><dd>Sanitized and bounded</dd></div></dl>" +
    (diagnostic.excerpt
      ? "<details><summary>Show sanitized diagnostic excerpt</summary><pre>" +
        value(diagnostic.excerpt) +
        "</pre></details>"
      : "") +
    (diagnostic.truncated
      ? '<p class="admin-mobile-evidence-unavailable">The stored excerpt was truncated at its size limit.</p>'
      : "") +
    "</section>"
  );
}

function attemptCard(attempt: SourceBuildAttempt): string {
  return (
    '<li class="admin-mobile-attempt"><article><header class="admin-mobile-attempt-heading">' +
    '<div><span class="admin-kicker">REVISION ' +
    value(attempt.revision) + " · ATTEMPT " + value(attempt.attempt) + " · EPOCH " + value(attempt.leaseEpoch) +
    "</span>" +
    "<h3>" +
    badge(attempt.state) +
    "</h3></div><code>" +
    value(attempt.id) +
    "</code></header>" +
    '<dl class="admin-mobile-attempt-facts"><div><dt>Stage</dt><dd>' +
    value(
      attempt.stage === "unknown" ? "Unknown / not recorded" : attempt.stage.replaceAll("_", " "),
    ) +
    "</dd></div><div><dt>Lease epoch</dt><dd>" +
    value(attempt.leaseEpoch) +
    "</dd></div><div><dt>Started</dt><dd>" +
    timeElement(attempt.startedAt) +
    "</dd></div><div><dt>Finished</dt><dd>" +
    timeElement(attempt.finishedAt) +
    "</dd></div><div><dt>Failure code</dt><dd><code>" +
    value(attempt.failureCode ?? "None recorded") +
    "</code></dd></div></dl>" +
    evidence(attempt) +
    "</article></li>"
  );
}

function retryAction(job: SourceBuildSummary, csrf: string): string {
  if (
    job.state === "failed" &&
    job.retryable &&
    Number.isSafeInteger(job.revision) &&
    job.revision >= 0
  ) {
    const admission = job.error === "SOURCE_ADMISSION_RETRIES_EXHAUSTED";
    const label = admission ? "Retry admission" : "Retry Source build";
    const copy = admission ? "This rechecks the existing produced result for admission without starting another Source build."
      : "This requests a new build attempt. The recorded failure remains available and the job is not complete until a later state is recorded.";
    return (
      '<div class="admin-mobile-action-copy"><strong>Retry is permitted</strong><span>' + copy + '</span></div>' +
      '<form method="post" action="/source-builds/' +
      value(encodeURIComponent(job.id)) +
      '/retry?ui=mobile"><input type="hidden" name="csrfToken" value="' +
      value(csrf) +
      '"><input type="hidden" name="expectedRevision" value="' +
      value(job.revision) +
      '"><input type="hidden" name="idempotencyKey" value="' +
      value(generateToken(128)) +
      '"><button type="submit">' + label + '</button></form>'
    );
  }
  const copy =
    job.state === "failed"
      ? "Retry is unavailable under the current queue policy. Review the recorded evidence."
      : job.state === "queued" || job.state === "building"
        ? "This job is still active. Wait for the Worker to report its next state."
        : "No retry action is available for this job state.";
  return '<p class="admin-mobile-action-copy">' + value(copy) + "</p>";
}

function releaseDetailRetry(status: ConsoleReleaseStatus, csrf: string): string {
  const workflow = status.workflow;
  const preRuntimeFailure =
    (workflow.state === "blocked" && workflow.failureCode === "canary_build_failed") ||
    (workflow.state === "canary_building" && workflow.failureCode === null);
  if (
    !Number.isSafeInteger(workflow.revision) ||
    workflow.revision < 0 ||
    !preRuntimeFailure ||
    status.build?.status !== "failed"
  ) {
    return '<p class="admin-mobile-action-copy">No retry is currently permitted by the Canary queue.</p>';
  }
  return (
    '<div class="admin-mobile-action-copy"><strong>Request a Canary retry</strong>' +
    "<span>Control Plane rechecks eligibility and the current workflow revision. The recorded failure remains available.</span></div>" +
    '<form method="post" action="/releases/' +
    value(encodeURIComponent(status.release.id)) +
    '/retry?ui=mobile"><input type="hidden" name="csrfToken" value="' +
    value(csrf) +
    '"><input type="hidden" name="expectedRevision" value="' +
    value(workflow.revision) +
    '"><input type="hidden" name="idempotencyKey" value="' +
    value(generateToken(128)) +
    '"><button type="submit">Retry Canary build</button></form>'
  );
}

function releaseDetail(model: ConsoleViewModel): string {
  const dependency = model.releaseDetail;
  if (!model.selectedReleaseId || !dependency || dependency.value === null) {
    const unavailable = dependency
      ? sectionUnavailable("Release status", dependency)
      : '<p class="admin-mobile-unavailable" role="status">Release status unavailable.</p>';
    return (
      '<a class="admin-mobile-back" href="' +
      value(consoleHref("releases", "mobile")) +
      '">Back to Releases</a>' +
      pageHeading(
        "Release status unavailable",
        "The canonical release workflow status is not available.",
      ) +
      unavailable
    );
  }
  const status: ConsoleReleaseStatus = dependency.value;
  if (status.release.id !== model.selectedReleaseId) {
    return (
      '<a class="admin-mobile-back" href="' +
      value(consoleHref("releases", "mobile")) +
      '">Back to Releases</a>' +
      pageHeading(
        "Release status unavailable",
        "The returned release did not match the requested ID.",
      ) +
      '<p class="admin-mobile-unavailable" role="status">Release status unavailable.</p>'
    );
  }
  const build = status.build;
  const failureCode = status.workflow.failureCode ?? build?.failure?.code ?? null;
  const stopBlocked = status.workflow.state === "canary_cleanup" && status.workflow.failureCode === "canary_stop_blocked";
  const refresh = "/releases/" + encodeURIComponent(status.release.id) + "?ui=mobile";
  return (
    '<a class="admin-mobile-back" href="' +
    value(consoleHref("releases", "mobile")) +
    '">Back to Releases</a>' +
    '<header class="admin-mobile-release-detail-heading"><span class="admin-kicker">CANONICAL RELEASE STATUS</span>' +
    badge(status.workflow.state, status.workflow.state.replaceAll("_", " ")) +
    "<h1>" +
    value(status.release.version) +
    "</h1><p><code>" +
    value(status.release.id) +
    '</code></p><a class="button button-secondary" href="' +
    value(refresh) +
    '">Refresh status</a></header>' +
    '<section class="admin-mobile-release-digest" aria-label="Immutable OCI image digest">' +
    '<span class="admin-kicker">OCI IMAGE DIGEST</span><code>' +
    value(status.release.imageDigest) +
    "</code></section>" +
    '<dl class="admin-mobile-detail-facts"><div><dt>Release state</dt><dd>' +
    badge(status.release.status) +
    "</dd></div><div><dt>Canary workflow</dt><dd>" +
    badge(status.workflow.state) +
    "</dd></div><div><dt>Workflow revision</dt><dd>" +
    value(status.workflow.revision) +
    "</dd></div><div><dt>Workflow attempts</dt><dd>" +
    value(status.workflow.attempts) +
    "</dd></div><div><dt>Canary build state</dt><dd>" +
    (build ? badge(build.status) : "Not started") +
    "</dd></div><div><dt>Canary build attempts</dt><dd>" +
    value(build?.attemptCount ?? 0) +
    "</dd></div><div><dt>Next retry time</dt><dd>" +
    timeElement(status.workflow.nextAttemptAt) +
    "</dd></div>" +
    (status.workflow.canaryBuildKey
      ? "<div><dt>Canary build key</dt><dd><code>" +
        value(status.workflow.canaryBuildKey) +
        "</code></dd></div>"
      : "") +
    (status.workflow.canaryOperationId
      ? '<div><dt>Canary operation</dt><dd><a href="' + value(operationHref(status.workflow.canaryOperationId, "mobile")) + '">' +
        value(status.workflow.canaryOperationId) +
        "</a></dd></div>"
      : "") +
    '</dl><section class="admin-mobile-section"><h2>Failure evidence</h2>' +
    (failureCode
      ? '<p class="admin-mobile-error-code">Failure code: <code>' +
        value(failureCode) +
        "</code></p>"
      : '<p class="admin-mobile-empty-inline">No workflow failure code is recorded.</p>') +
    (stopBlocked ? '<p class="admin-mobile-error-code">Canary stop is blocked by producer durability. Preserve unpublished local work and confirm writer absence before Stable promotion; Source admission alone is not Stable.</p>' : "") +
    '</section><section class="admin-mobile-action-region" aria-label="Canary recovery action">' +
    releaseDetailRetry(status, model.csrf) + canaryWaitSkipForm(status, model.csrf, "mobile") +
    "</section>"
  );
}

function buildDetail(model: ConsoleViewModel): string {
  const dependency = model.detail;
  if (
    !model.selectedBuildId ||
    !dependency ||
    dependency.value === null ||
    dependency.value.job.id !== model.selectedBuildId
  ) {
    const unavailable = dependency
      ? dependency.value !== null
        ? '<p class="admin-mobile-unavailable" role="status">Build detail unavailable: the returned job did not match the requested ID.</p>'
        : sectionUnavailable("Build detail", dependency)
      : '<p class="admin-mobile-unavailable" role="status">Build detail unavailable.</p>';
    return (
      '<a class="admin-mobile-back" href="' +
      value(consoleHref("builds", "mobile")) +
      '">Back to Builds</a>' +
      pageHeading("Build detail unavailable", "The current Source job status is not available.") +
      unavailable + (model.selectedBuildId ? '<p><a class="button button-secondary" href="' + value(buildHref(model.selectedBuildId, "mobile")) + '">Refresh status</a></p>' : "")
    );
  }
  const detail: SourceBuildDetail = dependency.value;
  const job = detail.job;
  const attempts = detail.attempts
    .slice()
    .sort((left, right) => right.leaseEpoch - left.leaseEpoch || right.attempt - left.attempt);
  const olderAttempts = detail.nextCursor
    ? '<a class="button button-secondary admin-mobile-older" href="' +
      value(buildHref(job.id, "mobile") + "&cursor=" + encodeURIComponent(detail.nextCursor)) +
      '">Older attempts</a>'
    : "";
  const noAttempts =
    detail.evidence === "not_recorded"
      ? job.error
        ? "No detailed attempt snapshot was recorded. The canonical job summary retains the known attempt and failure; stage and diagnostic evidence are unavailable."
        : job.attempt > 0
          ? "No detailed attempt snapshot was recorded. The canonical job summary retains the known attempt state; stage and diagnostic evidence are unavailable."
          : "No Worker attempt has started. Stage and diagnostic evidence are not recorded."
      : detail.evidence === "expired"
        ? "No retained attempt history is available. Diagnostic evidence may have expired."
        : "No attempt history is available.";
  const admission = job.admittedReleaseId
    ? '<a href="/releases/' +
      value(encodeURIComponent(job.admittedReleaseId)) +
      '?ui=mobile">' +
      value(job.admittedReleaseId) +
      "</a>"
    : "Not admitted";
  return (
    '<a class="admin-mobile-back" href="' +
    value(consoleHref("builds", "mobile")) +
    '">Back to Builds</a>' +
    '<section class="admin-mobile-build-detail" aria-labelledby="admin-mobile-build-title">' +
    '<header class="admin-mobile-detail-heading"><span class="admin-kicker">SOURCE BUILD / ' +
    value(job.sourceId) +
    "</span>" +
    badge(job.state, job.state === "queued" ? "Queued" : job.state.replaceAll("_", " ")) +
    '<h1 id="admin-mobile-build-title">' +
    value(job.tag) +
    "</h1><p>" +
    value(job.version) +
    '</p><code class="admin-mobile-job-id">' +
    value(job.id) +
    '</code><a class="button button-secondary" href="' + value(buildHref(job.id, "mobile")) + '">Refresh status</a></header>' +
    (job.state === "failed"
      ? '<section class="admin-mobile-diagnostic" role="status"><h2>Investigate failure</h2><p>' +
        value(attempts[0]?.diagnostic?.summary ??
          "No diagnostic evidence was recorded. Confirm Worker delivery before retrying.") +
        '</p><p>Failure code: ' + value(job.error ?? "Unknown") +
        ' · Last reported stage: ' + value(attempts[0]?.stage ?? "unknown") + '</p></section>' : "") +
    '<dl class="admin-mobile-detail-facts"><div><dt>Immutable source commit</dt><dd><code>' +
    value(job.commit) +
    "</code></dd></div><div><dt>Current attempt</dt><dd>" +
    value(job.attempt) +
    "</dd></div><div><dt>Revision</dt><dd>" +
    value(job.revision) +
    "</dd></div><div><dt>Queue policy</dt><dd>" +
    (job.retryable ? "Retry permitted" : "Retry unavailable") +
    "</dd></div><div><dt>Admitted release</dt><dd>" +
    admission +
    "</dd></div></dl>" +
    (job.error
      ? '<p class="admin-mobile-error-code">Failure code: <code>' + value(job.error) + "</code></p>"
      : "") +
    '<section class="admin-mobile-section" aria-labelledby="admin-mobile-attempts-title">' +
    '<div class="admin-mobile-section-heading"><div><span class="admin-kicker">STAGE / HISTORY</span>' +
    '<h2 id="admin-mobile-attempts-title">Attempt history and last reported stage</h2></div></div>' +
    '<p class="admin-mobile-evidence-state">Evidence: <strong>' +
    value(detail.evidence.replaceAll("_", " ")) +
    "</strong></p>" +
    (attempts.length
      ? '<ol class="admin-mobile-attempt-list">' + attempts.map(attemptCard).join("") + "</ol>"
      : '<p class="admin-mobile-empty">' + value(noAttempts) + "</p>") +
    olderAttempts +
    '</section><section class="admin-mobile-action-region" aria-label="Build recovery action">' +
    retryAction(job, model.csrf) +
    "</section></section>"
  );
}

function audit(model: ConsoleViewModel): string {
  const events = model.audit.value?.events ?? [];
  const rows = events.length
    ? '<ol class="admin-mobile-audit-list">' +
      events
        .map((event) => {
          const time = formatTime(event.occurredAt);
          return (
            '<li><article><div class="admin-mobile-audit-heading">' +
            badge(event.outcome) +
            '<time datetime="' +
            value(time.iso ?? "") +
            '">' +
            value(time.label) +
            "</time></div>" +
            "<h2>" +
            value(event.action) +
            "</h2>" +
            (event.jobId ? '<p><a href="' + value(buildHref(event.jobId, "mobile")) + '">Build ' + value(event.jobId) + "</a></p>" : "") +
            (event.releaseId ? '<p><a href="/releases/' + value(encodeURIComponent(event.releaseId)) + '?ui=mobile">Release ' + value(event.releaseId) + "</a></p>" : "") +
            (event.operationId && /^op_[A-Za-z0-9_.:-]{1,124}$/u.test(event.operationId)
              ? '<p><a href="' + value(operationHref(event.operationId, "mobile")) +
                '">Operation ' + value(event.operationId) + '</a></p>' : "") +
            (event.failureCode ? "<p>Failure code: " + value(event.failureCode) + "</p>" : "") +
            (event.leaseEpoch == null ? "" : "<p>Epoch " + value(event.leaseEpoch) + "</p>") +
            "<p>Actor: " +
            value(event.actorId ?? "Unavailable") +
            "</p></article></li>"
          );
        })
        .join("") +
      "</ol>"
    : model.audit.value
      ? '<p class="admin-mobile-empty">No operator events match this search.</p>'
      : "";
  return (
    pageHeading("Audit", "Search bounded operator events from the existing audit ledger.") +
    '<form class="admin-mobile-search" method="get" action="/audit" role="search">' +
    '<input type="hidden" name="ui" value="mobile"><label for="admin-mobile-audit-query">Search events</label>' +
    '<div><input id="admin-mobile-audit-query" type="search" name="q" maxlength="100" value="' +
    value(model.auditQuery) +
    '"><button type="submit">Search</button></div></form>' +
    (model.audit.value === null ? sectionUnavailable("Operator audit", model.audit) : rows) +
    (model.audit.value?.nextCursor
      ? '<a class="button button-secondary admin-mobile-older" href="' +
        value(
          consoleHref("audit", "mobile") +
            "&q=" +
            encodeURIComponent(model.auditQuery) +
            "&cursor=" +
            encodeURIComponent(model.audit.value.nextCursor),
        ) +
        '">Older events</a>'
      : "")
  );
}

function operationDetail(model: ConsoleViewModel): string {
  const dependency=model.operationDetail,detail=dependency?.value;
  if(!detail)return pageHeading("Operation evidence unavailable","No current verified operation response.") +
    (dependency?sectionUnavailable("Operation evidence",dependency):"");
  if(detail.operation.id!==model.selectedOperationId)
    return '<p class="admin-mobile-unavailable">Operation identity mismatch.</p>';
  const op=detail.operation;
  return '<a class="admin-mobile-back" href="' + value(consoleHref("releases","mobile")) + '">Back to Releases</a>' +
    pageHeading("Canary / runtime operation", op.id) +
    '<section class="admin-mobile-section"><h2>' + value(op.status) + " · " + value(op.phase) + "</h2>" +
    '<dl class="admin-mobile-detail-facts"><div><dt>Instance</dt><dd>' + value(op.instanceId) + "</dd></div>" +
    "<div><dt>Kind</dt><dd>" + value(op.kind) + "</dd></div>" +
    "<div><dt>Generation</dt><dd>" + value(op.generation) + "</dd></div>" +
    "<div><dt>Runtime epoch</dt><dd>" + value(op.runtimeEpoch) + "</dd></div>" +
    "<div><dt>Updated</dt><dd>" + timeElement(op.updatedAt) + "</dd></div>" +
    "<div><dt>Readiness evidence</dt><dd>" + (detail.readinessEvidence===null?"Not recorded":"Recorded") + "</dd></div>" +
    "<div><dt>Rollback evidence</dt><dd>" + (detail.rollbackCompatibilityEvidence===null?"Not recorded":"Recorded") + "</dd></div>" +
    "</dl><p>An absent proof is not a successful operation.</p></section>";
}
function content(model: ConsoleViewModel): string {
  if (model.selectedOperationId) return operationDetail(model);
  if (model.selectedReleaseId) return releaseDetail(model);
  if (model.selectedBuildId) return buildDetail(model);
  if (model.section === "overview")
    return (
      pageHeading("Overview", "Operator status and the next safe Source build action.") +
      infrastructureOverview(model) + overview(model)
    );
  if (model.section === "infrastructure") return renderInfrastructure(model, true);
  if (model.section === "releases") return releases(model);
  if (model.section === "builds") return builds(model);
  return audit(model);
}

/** Render one mobile SSR composition. Authorization, data loading and mutation routing stay in console.ts. */
export function renderMobileConsole(model: ConsoleViewModel): string {
  return (
    '<div class="admin-console admin-mobile-console" data-ui="mobile">' +
    header(model) +
    toast(model) +
    '<section class="admin-mobile-main" id="admin-mobile-main" aria-label="Operator console content">' +
    content(model) +
    "</section>" +
    '<footer class="admin-mobile-footer">Praetorium / Operator-authorized actions only</footer>' +
    mobileNavigation(model) +
    "</div>"
  );
}

export { MOBILE_ADMIN_STYLES };
