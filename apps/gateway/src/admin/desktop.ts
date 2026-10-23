import { generateToken } from "@praetorium/auth";
import type {
  SourceBuildAttempt, SourceBuildDetail, SourceBuildSummary,
} from "@praetorium/contracts";
import { escapeHtml } from "../ui/presentation.js";
import {
  buildHref, consoleHref, type ConsoleDependency,
  type ConsoleRelease, type ConsoleSection, type ConsoleViewModel,
} from "./view-model.js";
import type { PublishedSourceRelease, SourceReleaseView } from "./release-sources.js";

const SECTIONS: readonly { readonly id: ConsoleSection; readonly label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "releases", label: "Releases" },
  { id: "builds", label: "Builds" },
  { id: "audit", label: "Audit" },
];

type BuildSort = "recent" | "source" | "state" | "attempt";
const BUILD_STATES = ["queued", "building", "produced", "admitted", "failed"] as const;
const SAFE_FAILURE_REASON_COPY: Readonly<Record<string, string>> = {
  schema_missing: "Required D1 schema is missing; check applied migrations.",
  binding_invalid: "The Control Plane binding is missing or invalid; check its configured binding.",
  constraint: "The database rejected the operation because a required data constraint was not satisfied.",
  query_limit: "The database rejected the operation at its configured query limit; review database capacity and query limits.",
  provider_unavailable: "The database provider is temporarily unavailable; retry after it recovers.",
};

function statusTone(state: string): "good" | "warn" | "bad" | "neutral" {
  if (["available", "admitted", "produced", "complete", "promoted", "succeeded"].includes(state))
    return "good";
  if (["failed", "blocked", "rejected"].includes(state)) return "bad";
  if (["queued", "building", "lease_expired", "unknown", "unavailable", "canary_building", "canary_running",
    "admitting", "promoting", "rolling_out", "evaluating", "staged"].includes(state))
    return "warn";
  return "neutral";
}

function badge(label: string, state: string): string {
  return `<span class="desktop-status desktop-status-${statusTone(state)}">${escapeHtml(label)}</span>`;
}

function humanize(value: string): string {
  return value.replaceAll("_", " ");
}

function dateTime(value: number | string | null): string {
  if (value === null) return "Not recorded";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? `${date.toISOString().slice(0, 19).replace("T", " ")} UTC` : "Time unavailable";
}

function dependencyUnavailable(title: string, dependency: ConsoleDependency<unknown>): string {
  if (dependency.value !== null) return "";
  const status = dependency.status === null ? "unavailable" : String(dependency.status);
  const code = dependency.code && /^[A-Z][A-Z0-9_]{0,89}$/u.test(dependency.code)
    ? dependency.code : "OPERATOR_UNAVAILABLE";
  const reason = dependency.reason && Object.hasOwn(SAFE_FAILURE_REASON_COPY, dependency.reason)
    ? SAFE_FAILURE_REASON_COPY[dependency.reason] : null;
  return `<div class="desktop-unavailable" role="status"><strong>${escapeHtml(title)} status unavailable.</strong>` +
    `<span>Endpoint <code>${escapeHtml(dependency.endpoint)}</code>; HTTP <code>${escapeHtml(status)}</code>; code <code>${escapeHtml(code)}</code>.</span>` +
    (reason ? `<span>${escapeHtml(reason)}</span>` : "") + `</div>`;
}

function notice(value: string | null): string {
  return `<div class="desktop-notice-slot" aria-live="polite" aria-atomic="true">${value
    ? `<p class="desktop-notice" role="status">${escapeHtml(value)}</p>` : ""}</div>`;
}

function selectedRelease(model: ConsoleViewModel, id: string): ConsoleRelease | undefined {
  return model.catalog.value?.items.find((item) => item.release.id === id);
}

function stablePanel(model: ConsoleViewModel): string {
  const catalog = model.catalog.value;
  if (!catalog) return dependencyUnavailable("Current Stable", model.catalog);
  const channel = catalog.stableChannel;
  if (channel === undefined)
    return `<section class="desktop-stable desktop-stable-unavailable" aria-labelledby="desktop-stable-title">` +
      `<span class="desktop-eyebrow">CURRENT STABLE</span><h2 id="desktop-stable-title">Status unavailable</h2></section>`;
  if (channel === null)
    return `<section class="desktop-stable desktop-stable-unavailable" aria-labelledby="desktop-stable-title">` +
      `<span class="desktop-eyebrow">CURRENT STABLE</span><h2 id="desktop-stable-title">Stable channel status unavailable</h2></section>`;
  if (channel.currentReleaseId === null)
    return `<section class="desktop-stable" aria-labelledby="desktop-stable-title">` +
      `<span class="desktop-eyebrow">CURRENT STABLE</span><h2 id="desktop-stable-title">No release promoted yet</h2></section>`;
  const current = selectedRelease(model, channel.currentReleaseId);
  const label = current?.release.version ?? `Release ${channel.currentReleaseId}`;
  return `<section class="desktop-stable" aria-labelledby="desktop-stable-title">` +
    `<div><span class="desktop-eyebrow">CURRENT STABLE</span><h2 id="desktop-stable-title">${escapeHtml(label)}</h2>` +
    `<code>${escapeHtml(channel.currentReleaseId)}</code></div>` +
    (current ? `<div class="desktop-stable-digest"><span>OCI digest</span><code>${escapeHtml(current.release.imageDigest)}</code></div>` :
      `<p class="desktop-muted">Release details are outside the loaded catalog page.</p>`) + `</section>`;
}

function activeIncidents(model: ConsoleViewModel): string {
  const incidents: string[] = [];
  for (const job of model.builds.value?.items ?? []) {
    if (job.state !== "failed") continue;
    incidents.push(`<li><div><a href="${escapeHtml(buildHref(job.id, model.mode))}">${escapeHtml(job.sourceId)} ${escapeHtml(job.tag)}</a>` +
      `<span class="desktop-muted"> · ${escapeHtml(job.id)}</span></div><div>${badge("Build failed", "failed")}` +
      `<span class="desktop-incident-code">${escapeHtml(job.error ?? "Failure code unavailable")}</span></div></li>`);
  }
  for (const item of model.catalog.value?.items ?? []) {
    const workflow = item.workflow?.workflow;
    if (!workflow || !["blocked", "failed"].includes(workflow.state)) continue;
    const code = workflow.failureCode ?? item.workflow?.build?.failure?.code ?? "Failure code unavailable";
    incidents.push(`<li><div><a href="/releases/${encodeURIComponent(item.release.id)}?ui=${model.mode}">Release ${escapeHtml(item.release.version)}</a>` +
      `<span class="desktop-muted"> · ${escapeHtml(item.release.id)}</span></div><div>${badge(humanize(workflow.state), workflow.state)}` +
      `<span class="desktop-incident-code">${escapeHtml(code)}</span></div></li>`);
  }
  if (incidents.length) return `<ul class="desktop-incident-list">${incidents.join("")}</ul>`;
  if (!model.builds.value && !model.catalog.value)
    return `<p class="desktop-empty">Incident status is unavailable because both build and release status could not be loaded.</p>`;
  const hasUnavailableSource = !model.builds.value || !model.catalog.value;
  return `<p class="desktop-empty">${hasUnavailableSource
    ? "No incident is visible in the available data. Some status sources are unavailable."
    : "No active failed builds or blocked releases are reported."}</p>`;
}

function overview(model: ConsoleViewModel): string {
  const jobs = model.builds.value?.items ?? [];
  const activeJobs = jobs.filter((job) => ["queued", "building", "produced"].includes(job.state));
  const active = activeJobs.length;
  const activity = activeJobs.length ? `<ul class="desktop-incident-list">${activeJobs.slice(0, 6).map(job =>
    `<li><a href="${escapeHtml(buildHref(job.id, model.mode))}">${escapeHtml(job.sourceId)} ${escapeHtml(job.tag)}</a>${badge(humanize(job.state), job.state)}</li>`).join("")}</ul>` : "";
  const releases = model.catalog.value?.items ?? [];
  const blocked = releases.filter((item) => ["blocked", "failed"].includes(item.workflow?.workflow.state ?? "")).length;
  return `<section class="desktop-page-heading"><p class="desktop-eyebrow">OPERATOR / CONTROL PLANE</p>` +
    `<h1>Overview</h1><p>See current release health, active work, and actionable failures.</p></section>` +
    notice(model.notice) + stablePanel(model) +
    `<section class="desktop-section" aria-labelledby="desktop-incidents-title"><div class="desktop-section-heading">` +
    `<div><p class="desktop-eyebrow">NEEDS ATTENTION</p><h2 id="desktop-incidents-title">Active incidents</h2></div>` +
    `<a class="desktop-text-link" href="${consoleHref("builds", model.mode)}">Open Builds</a></div>` +
    activeIncidents(model) + `</section>` +
    `<section class="desktop-section" aria-labelledby="desktop-activity-title"><div class="desktop-section-heading">` +
    `<div><p class="desktop-eyebrow">CURRENT WORK</p><h2 id="desktop-activity-title">Build activity</h2></div>` +
    `<a class="desktop-text-link" href="${consoleHref("builds", model.mode)}">View build queue</a></div>` +
    (model.builds.value
      ? activity + `<div class="desktop-overview-metrics"><article><strong>${active}</strong><span>Visible active jobs</span></article>` +
        `<article><strong>${blocked}</strong><span>Blocked releases</span></article>` +
        `<article><strong>${jobs.length}</strong><span>Visible Source builds</span></article></div>`
      : dependencyUnavailable("Build activity", model.builds)) + `</section>`;
}

function canaryRetryForm(item: ConsoleRelease, csrf: string, mode: ConsoleViewModel["mode"]): string {
  const workflow = item.workflow?.workflow;
  const retryableState = (workflow?.state === "blocked" && workflow.failureCode === "canary_build_failed") ||
    (workflow?.state === "canary_building" && workflow.failureCode === null);
  const revision = workflow?.revision;
  if (!retryableState || !Number.isSafeInteger(revision) || item.workflow?.build?.status !== "failed") return "";
  return `<form method="post" action="/releases/${encodeURIComponent(item.release.id)}/retry?ui=${mode}" class="desktop-inline-form">` +
    `<input type="hidden" name="csrfToken" value="${escapeHtml(csrf)}">` +
    `<input type="hidden" name="expectedRevision" value="${revision}">` +
    `<input type="hidden" name="idempotencyKey" value="${escapeHtml(generateToken(128))}">` +
    `<button class="desktop-button desktop-button-secondary" type="submit">Retry Canary build</button></form>`;
}

function releaseRow(item: ConsoleRelease, csrf: string, mode: ConsoleViewModel["mode"]): string {
  const release = item.release;
  const workflow = item.workflow?.workflow;
  const state = workflow?.state ?? release.status;
  const issue = workflow?.failureCode ?? item.workflow?.build?.failure?.code ?? null;
  return `<article class="desktop-release-card"><div><p class="desktop-eyebrow">PLATFORM RELEASE</p>` +
    `<h3><a href="/releases/${encodeURIComponent(release.id)}?ui=${mode}">${escapeHtml(release.version)}</a></h3>` +
    `<code>${escapeHtml(release.id)}</code></div><div><span class="desktop-field-label">State</span>${badge(humanize(state), state)}` +
    (issue ? `<p class="desktop-incident-code">${escapeHtml(issue)}</p>` : "") + `</div>` +
    `<div><span class="desktop-field-label">Immutable OCI digest</span><code class="desktop-digest">${escapeHtml(release.imageDigest)}</code></div>` +
    `<div class="desktop-release-actions">${canaryRetryForm(item, csrf, mode)}</div></article>`;
}

function priorBuildForRelease(builds: readonly SourceBuildSummary[], sourceId: string, releaseId: number): SourceBuildSummary | undefined {
  return builds.find((job) => job.sourceId === sourceId && job.releaseId === releaseId);
}

function sourceReleaseCard(source: SourceReleaseView, model: ConsoleViewModel): string {
  const header = `<div class="desktop-source-header"><div><p class="desktop-eyebrow">PUBLISHED SOURCE</p>` +
    `<h3>${escapeHtml(source.source.label)}</h3><code>${escapeHtml(source.source.githubRepository)}</code></div></div>`;
  if (source.error) return `<article class="desktop-source-card">${header}<div class="desktop-unavailable" role="status">` +
    `<strong>${escapeHtml(source.error)}</strong><span>${escapeHtml(source.endpoint)}; HTTP ` +
    `<code>${escapeHtml(source.status === null ? "unavailable" : String(source.status))}</code>; code ` +
    `<code>${escapeHtml(source.code ?? "SOURCE_CATALOG_UNAVAILABLE")}</code>.</span></div></article>`;
  if (!source.releases.length) return `<article class="desktop-source-card">${header}<p class="desktop-empty">No published releases are available.</p></article>`;
  return `<article class="desktop-source-card">${header}<div class="desktop-source-releases">${source.releases.map((release) =>
    sourceReleaseOption(source, release, model)).join("")}</div></article>`;
}

function sourceReleaseOption(source: SourceReleaseView, release: PublishedSourceRelease, model: ConsoleViewModel): string {
  const job = priorBuildForRelease(model.builds.value?.items ?? [], source.source.id, release.id);
  const exactIdentity = job
    ? `<div class="desktop-source-identity"><span>Resolved immutable commit</span><code>${escapeHtml(job.commit)}</code>` +
      `<span>Praetorium job</span><a href="${escapeHtml(buildHref(job.id, model.mode))}">${escapeHtml(job.id)}</a> ${badge(humanize(job.state), job.state)}</div>`
    : `<p class="desktop-muted">Praetorium resolves and pins the exact commit when this release is submitted.</p>`;
  const deployAction = release.version
    ? `<form method="post" action="/source-releases/deploy?ui=${model.mode}" class="desktop-inline-form">` +
      `<input type="hidden" name="csrfToken" value="${escapeHtml(model.csrf)}">` +
      `<input type="hidden" name="sourceId" value="${escapeHtml(source.source.id)}">` +
      `<input type="hidden" name="releaseId" value="${escapeHtml(String(release.id))}">` +
      `<button class="desktop-button" type="submit">Build &amp; deploy</button></form>`
    : `<span class="desktop-muted">Not deployable: release tag is not SemVer.</span>`;
  return `<div class="desktop-source-release"><div class="desktop-source-release-heading"><div>` +
    `<p class="desktop-eyebrow">${release.prerelease ? "PRERELEASE" : "PUBLISHED RELEASE"}</p>` +
    `<h4>${escapeHtml(release.name)}</h4><p><code>${escapeHtml(release.tag)}</code> · Published ${escapeHtml(dateTime(release.publishedAt))}</p>` +
    `<span class="desktop-muted">GitHub Release ID ${escapeHtml(String(release.id))}</span></div>` +
    `${deployAction}</div>${exactIdentity}` +
    (release.notes ? `<p class="desktop-release-notes">${escapeHtml(release.notes)}</p>` : "") + `</div>`;
}

function releases(model: ConsoleViewModel): string {
  const sourceContent = model.sourceViews.value
    ? model.sourceViews.value.length
      ? model.sourceViews.value.map((source) => sourceReleaseCard(source, model)).join("")
      : `<p class="desktop-empty">No release sources are configured.</p>`
    : dependencyUnavailable("GitHub Release catalog", model.sourceViews);
  const releaseRows = model.catalog.value
    ? model.catalog.value.items.length
      ? model.catalog.value.items.map((item) => releaseRow(item, model.csrf, model.mode)).join("")
      : `<p class="desktop-empty">No Platform releases are available.</p>`
    : dependencyUnavailable("Platform release ledger", model.catalog);
  return `<section class="desktop-page-heading"><p class="desktop-eyebrow">IMMUTABLE SOURCE AND PLATFORM ARTIFACTS</p>` +
    `<h1>Releases</h1><p>Select a published source release, then inspect the pinned commit and admitted image digest.</p></section>` +
    notice(model.notice) + stablePanel(model) +
    `<section class="desktop-section" aria-labelledby="desktop-source-releases-title"><div class="desktop-section-heading">` +
    `<div><p class="desktop-eyebrow">SOURCE AUTHORITY</p><h2 id="desktop-source-releases-title">Published source releases</h2></div></div>` +
    `<p class="desktop-section-intro">The selected published tag is revalidated and resolved to its exact commit before Praetorium accepts a build.</p>` +
    sourceContent + `</section>` +
    `<section class="desktop-section" aria-labelledby="desktop-platform-releases-title"><div class="desktop-section-heading">` +
    `<div><p class="desktop-eyebrow">ADMISSION AND PROMOTION</p><h2 id="desktop-platform-releases-title">Platform release ledger</h2></div></div>` +
    releaseRows + (model.catalog.value?.nextCursor
      ? `<p class="desktop-pagination"><a class="desktop-button desktop-button-secondary" href="${escapeHtml(consoleHref("releases", model.mode) + "&cursor=" + encodeURIComponent(model.catalog.value.nextCursor))}">Older releases</a></p>` : "") + `</section>`;
}

function releaseDetail(model: ConsoleViewModel): string {
  const selectedId = model.selectedReleaseId;
  const detail = model.releaseDetail;
  const back = `<a class="desktop-text-link" href="${consoleHref("releases", model.mode)}">Back to Releases</a>`;
  if (!selectedId) return `<section class="desktop-page-heading"><p class="desktop-eyebrow">RELEASE STATUS</p><h1>Release unavailable</h1>${back}</section>`;
  if (!detail || !detail.value)
    return `<section class="desktop-page-heading"><p class="desktop-eyebrow">RELEASE STATUS</p><h1>Release ${escapeHtml(selectedId)}</h1>${back}</section>` +
      notice(model.notice) + (detail ? dependencyUnavailable("Canonical release status", detail) :
        `<p class="desktop-unavailable" role="status">Canonical release status was not loaded.</p>`);
  const value = detail.value;
  if (value.release.id !== selectedId)
    return `<p class="desktop-unavailable" role="status">Release detail is unavailable because the returned release identity did not match the requested release.</p>`;
  const workflow = value.workflow;
  const build = value.build;
  const preRuntimeFailure = (workflow.state === "blocked" && workflow.failureCode === "canary_build_failed") ||
    (workflow.state === "canary_building" && workflow.failureCode === null);
  const retryable = preRuntimeFailure && build?.status === "failed" && Number.isSafeInteger(workflow.revision) && workflow.revision >= 0;
  const retry = retryable
    ? `<form method="post" action="/releases/${encodeURIComponent(value.release.id)}/retry?ui=${model.mode}" class="desktop-retry-form">` +
      `<input type="hidden" name="csrfToken" value="${escapeHtml(model.csrf)}">` +
      `<input type="hidden" name="expectedRevision" value="${workflow.revision}">` +
      `<input type="hidden" name="idempotencyKey" value="${escapeHtml(generateToken(128))}">` +
      `<button class="desktop-button" type="submit">Retry Canary build</button>` +
      `<p>The Control Plane rechecks the current workflow revision and retry policy.</p></form>`
    : workflow.state === "blocked" || workflow.state === "failed"
      ? `<p class="desktop-muted">Retry is unavailable under the current canonical workflow policy.</p>` : "";
  const failureCode = workflow.failureCode ?? build?.failure?.code ?? null;
  return `<section class="desktop-page-heading"><p class="desktop-eyebrow">CANONICAL RELEASE STATUS</p>` +
    `<h1>Release ${escapeHtml(value.release.version)}</h1><p>Admission, Canary execution, and promotion status from the Control Plane.</p>${back}</section>` +
    notice(model.notice) +
    `<section class="desktop-job-summary" aria-labelledby="desktop-release-summary-title"><div class="desktop-job-heading">` +
    `<div><p class="desktop-eyebrow">AUTHORITATIVE WORKFLOW</p><h2 id="desktop-release-summary-title">${badge(humanize(workflow.state), workflow.state)}</h2>` +
    `<code>${escapeHtml(value.release.id)}</code></div><div>${retry}</div></div>` +
    `<dl class="desktop-facts desktop-job-facts"><div><dt>Release status</dt><dd>${badge(humanize(value.release.status), value.release.status)}</dd></div>` +
    `<div><dt>Workflow revision</dt><dd>${workflow.revision}</dd></div><div><dt>Workflow attempts</dt><dd>${workflow.attempts}</dd></div>` +
    `<div class="desktop-fact-wide"><dt>Immutable OCI digest</dt><dd><code>${escapeHtml(value.release.imageDigest)}</code></dd></div>` +
    `<div><dt>Canonical failure</dt><dd>${escapeHtml(failureCode ?? "None recorded")}</dd></div>` +
    `<div><dt>Next attempt</dt><dd>${workflow.nextAttemptAt === null ? "Not scheduled" : escapeHtml(dateTime(workflow.nextAttemptAt))}</dd></div>` +
    `<div><dt>Canary build</dt><dd>${build
      ? `${badge(humanize(build.status), build.status)} <span>${escapeHtml(build.id)}</span> · ${build.attemptCount} attempts`
      : "No Canary build is attached"}</dd></div>` +
    `<div><dt>Canary build key</dt><dd>${escapeHtml(workflow.canaryBuildKey ?? "Not recorded")}</dd></div>` +
    `<div><dt>Canary operation</dt><dd>${escapeHtml(workflow.canaryOperationId ?? "Not recorded")}</dd></div></dl></section>` +
    `<section class="desktop-section" aria-labelledby="desktop-release-followthrough-title"><div class="desktop-section-heading">` +
    `<div><p class="desktop-eyebrow">SAFE FOLLOW-THROUGH</p><h2 id="desktop-release-followthrough-title">Canary and Stable progression</h2></div>` +
    `<a class="desktop-button desktop-button-secondary" href="/releases/${encodeURIComponent(value.release.id)}?ui=${model.mode}">Refresh status</a></div>` +
    `<p class="desktop-section-intro">A completed build or admitted artifact does not by itself mean the release is Stable. Stable promotion follows the verified Canary and rollout workflow.</p>` +
    `<div class="desktop-release-followthrough"><span>${badge(humanize(workflow.state), workflow.state)}</span>` +
    `<span class="desktop-muted">Current Stable channel status is shown on the Releases page.</span></div></section>`;
}

function buildSort(model: ConsoleViewModel): BuildSort {
  const sort = model.buildSort;
  return sort && ["recent", "source", "state", "attempt"].includes(sort) ? sort : "recent";
}

function buildSortHref(model: ConsoleViewModel, sort: BuildSort): string {
  const query = new URLSearchParams({ ui: model.mode, sort });
  if (model.buildStateFilter && BUILD_STATES.includes(model.buildStateFilter as (typeof BUILD_STATES)[number]))
    query.set("state", model.buildStateFilter);
  return `/builds?${query.toString()}`;
}

function sortLabel(sort: BuildSort): string {
  switch (sort) {
    case "recent": return "Most recent";
    case "source": return "Source";
    case "state": return "State";
    case "attempt": return "Attempt";
  }
}

function sortBuilds(items: readonly SourceBuildSummary[], sort: BuildSort): SourceBuildSummary[] {
  if (sort === "recent") return [...items];
  return [...items].sort((left, right) => {
    if (sort === "source") return `${left.sourceId}/${left.tag}`.localeCompare(`${right.sourceId}/${right.tag}`);
    if (sort === "state") return left.state.localeCompare(right.state) || right.attempt - left.attempt;
    return right.attempt - left.attempt || right.revision - left.revision;
  });
}

function buildTable(model: ConsoleViewModel): string {
  if (!model.builds.value) return dependencyUnavailable("Source build queue", model.builds);
  const sort = buildSort(model);
  const filtered = model.builds.value.items.filter((job) => !model.buildStateFilter || job.state === model.buildStateFilter);
  const jobs = sortBuilds(filtered, sort);
  if (!jobs.length) return `<p class="desktop-empty">${model.builds.value.items.length
    ? "No Source builds on this page match this state filter."
    : "No Source builds are available on this page."}</p>`;
  const header = (name: string, key: BuildSort) => `<th scope="col"${sort === key ? ` aria-sort="${["source", "state"].includes(sort) ? "ascending" : "descending"}"` : ""}>` +
    `<a href="${buildSortHref(model, key)}">${escapeHtml(name)}${sort === key ? '<span class="desktop-sr-only">, current sort</span>' : ""}</a></th>`;
  return `<div class="desktop-table-scroll"><table class="desktop-build-table"><caption class="desktop-sr-only">Source builds, ordered by ${escapeHtml(sortLabel(sort))}</caption>` +
    `<thead><tr>${header("Source", "source")}${header("State", "state")}${header("Attempt", "attempt")}` +
    `<th scope="col">Immutable release identity</th><th scope="col">Retry policy</th></tr></thead><tbody>` +
    jobs.map((job) => `<tr><th scope="row"><a href="${escapeHtml(buildHref(job.id, model.mode))}">${escapeHtml(job.sourceId)} / ${escapeHtml(job.tag)}</a>` +
      `<span class="desktop-table-id">${escapeHtml(job.id)}</span></th><td>${badge(humanize(job.state), job.state)}` +
      (job.error ? `<span class="desktop-table-error">${escapeHtml(job.error)}</span>` : "") + `</td>` +
      `<td>${job.attempt}</td><td><span class="desktop-table-identity">GitHub Release ${job.releaseId}</span>` +
      `<code>${escapeHtml(job.commit)}</code>` +
      (job.admittedReleaseId ? `<span class="desktop-table-identity">Admitted Platform release</span>` +
        `<a class="desktop-platform-release-link" href="/releases/${encodeURIComponent(job.admittedReleaseId)}?ui=${model.mode}">${escapeHtml(job.admittedReleaseId)}</a>` : "") +
      `</td><td>${job.state === "failed"
        ? job.retryable ? `<span class="desktop-policy-available">Retry available on detail</span>` : `<span class="desktop-muted">Retry not permitted</span>`
        : `<span class="desktop-muted">Not applicable</span>`}</td></tr>`).join("") + `</tbody></table></div>`;
}

function builds(model: ConsoleViewModel): string {
  const state = model.buildStateFilter && BUILD_STATES.includes(model.buildStateFilter as (typeof BUILD_STATES)[number])
    ? model.buildStateFilter : "";
  const sort = buildSort(model);
  const cursor = model.builds.value?.nextCursor;
  const nextQuery = new URLSearchParams({ ui: model.mode, sort, ...(cursor ? { cursor } : {}) });
  if (state) nextQuery.set("state", state);
  return `<section class="desktop-page-heading"><p class="desktop-eyebrow">SOURCE BUILDER</p><h1>Builds</h1>` +
    `<p>Track accepted jobs by authoritative queue state and immutable source identity.</p></section>` + notice(model.notice) +
    `<section class="desktop-section" aria-labelledby="desktop-build-list-title"><div class="desktop-section-heading">` +
    `<div><p class="desktop-eyebrow">QUEUE</p><h2 id="desktop-build-list-title">Source build jobs</h2></div></div>` +
    `<form method="get" action="/builds" class="desktop-build-filter"><input type="hidden" name="ui" value="${model.mode}">` +
    `<input type="hidden" name="sort" value="${sort}"><label for="desktop-build-state">Filter by state</label>` +
    `<select id="desktop-build-state" name="state"><option value="">All states</option>${BUILD_STATES.map((value) =>
      `<option value="${value}"${state === value ? " selected" : ""}>${escapeHtml(humanize(value))}</option>`).join("")}</select>` +
    `<button class="desktop-button desktop-button-secondary" type="submit">Apply filter</button></form>` + buildTable(model) +
    (cursor ? `<p class="desktop-pagination"><a class="desktop-button desktop-button-secondary" href="/builds?${escapeHtml(nextQuery.toString())}">Older builds</a></p>` : "") +
    `<p class="desktop-table-footnote">Sorting and filtering apply to this bounded page. A queued job is accepted work. Status unavailable means the queue dependency did not respond; it does not mean a build failed.</p></section>`;
}

function attemptStateLabel(attempt: SourceBuildAttempt): string {
  return attempt.state === "lease_expired" ? "Lease expired" : humanize(attempt.state);
}

function diagnosticEvidence(attempt: SourceBuildAttempt): string {
  if (attempt.evidence === "expired")
    return `<p class="desktop-evidence-state" role="status">Diagnostic evidence expired${attempt.expiresAt ? ` on ${escapeHtml(dateTime(attempt.expiresAt))}` : ""}.</p>`;
  if (attempt.evidence === "not_recorded" || !attempt.diagnostic)
    return `<p class="desktop-evidence-state" role="status">Diagnostic evidence was not recorded for this attempt.</p>`;
  const diagnostic = attempt.diagnostic;
  return `<div class="desktop-diagnostic"><p><strong>${escapeHtml(diagnostic.summary)}</strong></p>` +
    `<p class="desktop-diagnostic-meta">${escapeHtml(humanize(diagnostic.reason))}${diagnostic.truncated ? " · excerpt truncated" : ""}</p>` +
    (diagnostic.excerpt ? `<details><summary>View sanitized diagnostic excerpt</summary><pre>${escapeHtml(diagnostic.excerpt)}</pre></details>` : "") +
    `</div>`;
}

function attemptTimeline(detail: SourceBuildDetail): string {
  if (!detail.attempts.length) {
    const failure = detail.job.error
      ? `<p class="desktop-empty">Canonical failure code <code>${escapeHtml(detail.job.error)}</code> is recorded; no attempt-level stage is available.</p>`
      : `<p class="desktop-empty">No detailed attempt snapshot was recorded. The canonical job summary retains the known attempt state.</p>`;
    const evidence = detail.evidence === "expired" ? "Diagnostic evidence has expired."
      : detail.evidence === "not_recorded" ? "Diagnostic evidence was not recorded for this job." : "";
    return failure + (evidence ? `<p class="desktop-evidence-state" role="status">${evidence}</p>` : "");
  }
  const chronological = [...detail.attempts].sort((left, right) => left.leaseEpoch - right.leaseEpoch);
  return `<ol class="desktop-attempt-timeline">${chronological.map((attempt, index) => {
    const stage = attempt.stage === "unknown" ? "Stage unavailable" : humanize(attempt.stage);
    const stageTone = statusTone(attempt.state);
    return `<li class="desktop-attempt" aria-labelledby="attempt-title-${index}">` +
      `<div class="desktop-attempt-rail" aria-hidden="true"><span class="desktop-attempt-dot desktop-attempt-dot-${stageTone}"></span></div>` +
      `<div class="desktop-attempt-content"><div class="desktop-attempt-heading"><div><p class="desktop-eyebrow">ATTEMPT ${attempt.attempt}</p>` +
      `<h3 id="attempt-title-${index}">${escapeHtml(stage)}</h3></div>${badge(attemptStateLabel(attempt), attempt.state)}</div>` +
      `<p class="desktop-attempt-id">Attempt ID <code>${escapeHtml(attempt.id)}</code></p>` +
      `<dl class="desktop-facts"><div><dt>Started</dt><dd>${escapeHtml(dateTime(attempt.startedAt))}</dd></div>` +
      `<div><dt>Finished</dt><dd>${escapeHtml(dateTime(attempt.finishedAt))}</dd></div>` +
      `<div><dt>Failure code</dt><dd>${escapeHtml(attempt.failureCode ?? "None recorded")}</dd></div>` +
      `<div><dt>Revision</dt><dd>${attempt.revision}</dd></div><div><dt>Lease epoch</dt><dd>${attempt.leaseEpoch}</dd></div>` +
      `<div><dt>Evidence</dt><dd>${escapeHtml(humanize(attempt.evidence))}</dd></div></dl>` +
      diagnosticEvidence(attempt) + `</div></li>`;
  }).join("")}</ol>`;
}

function retryForm(job: SourceBuildSummary, model: ConsoleViewModel): string {
  if (job.state !== "failed" || !job.retryable) return "";
  return `<form method="post" action="/source-builds/${encodeURIComponent(job.id)}/retry?ui=${model.mode}" class="desktop-retry-form">` +
    `<input type="hidden" name="csrfToken" value="${escapeHtml(model.csrf)}">` +
    `<input type="hidden" name="expectedRevision" value="${job.revision}">` +
    `<input type="hidden" name="idempotencyKey" value="${escapeHtml(generateToken(128))}">` +
    `<button class="desktop-button" type="submit">Retry Source build</button>` +
    `<p>Control Plane will recheck the current revision and canonical retry policy before accepting a new attempt.</p></form>`;
}

function buildDetail(model: ConsoleViewModel): string {
  const detailSection = model.detail;
  if (!detailSection) return `<p class="desktop-empty">Select a build from the queue to inspect its attempts.</p>`;
  if (!detailSection.value) return dependencyUnavailable("Build detail", detailSection) +
    (model.selectedBuildId ? `<p><a class="desktop-button desktop-button-secondary" href="${buildHref(model.selectedBuildId, model.mode)}">Refresh status</a></p>` : "");
  const detail = detailSection.value;
  const job = detail.job;
  if (model.selectedBuildId && model.selectedBuildId !== job.id)
    return `<p class="desktop-unavailable" role="status">Build detail is unavailable because the returned job identity did not match the requested job.</p>`;
  return `<section class="desktop-page-heading"><p class="desktop-eyebrow">BUILD DETAIL / ${escapeHtml(job.id)}</p>` +
    `<h1>${escapeHtml(job.sourceId)} / ${escapeHtml(job.tag)}</h1><p>Attempt history and bounded diagnostics for this immutable Source job.</p>` +
    `<a class="desktop-text-link" href="${consoleHref("builds", model.mode)}">Back to Builds</a> ` +
    `<a class="desktop-button desktop-button-secondary" href="${buildHref(job.id, model.mode)}">Refresh status</a></section>` + notice(model.notice) +
    `<section class="desktop-job-summary" aria-labelledby="desktop-job-summary-title"><div class="desktop-job-heading">` +
    `<div><p class="desktop-eyebrow">AUTHORITATIVE JOB STATE</p><h2 id="desktop-job-summary-title">${badge(humanize(job.state), job.state)}</h2>` +
    `<code>${escapeHtml(job.id)}</code></div><div>${retryForm(job, model)}</div></div>` +
    `<dl class="desktop-facts desktop-job-facts"><div><dt>Source</dt><dd>${escapeHtml(job.sourceId)}</dd></div>` +
    `<div><dt>Published tag</dt><dd>${escapeHtml(job.tag)}</dd></div><div><dt>Version</dt><dd>${escapeHtml(job.version)}</dd></div>` +
    `<div><dt>GitHub Release ID</dt><dd>${job.releaseId}</dd></div><div class="desktop-fact-wide"><dt>Immutable source commit</dt><dd><code>${escapeHtml(job.commit)}</code></dd></div>` +
    `<div><dt>Current revision</dt><dd>${job.revision}</dd></div><div><dt>Current attempt</dt><dd>${job.attempt}</dd></div>` +
    `<div><dt>Retry policy</dt><dd>${job.retryable ? "Retryable by queue policy" : "Retry not permitted"}</dd></div>` +
    `<div><dt>Admitted release</dt><dd>${job.admittedReleaseId
      ? `<a class="desktop-text-link" href="/releases/${encodeURIComponent(job.admittedReleaseId)}?ui=${model.mode}">Open Platform release ${escapeHtml(job.admittedReleaseId)}</a>`
      : "Not admitted"}</dd></div></dl></section>` +
    `<section class="desktop-section" aria-labelledby="desktop-attempts-title"><div class="desktop-section-heading">` +
    `<div><p class="desktop-eyebrow">RECORDED EXECUTION</p><h2 id="desktop-attempts-title">Attempt and stage timeline</h2></div></div>` +
    `<p class="desktop-section-intro">Each entry is tied to its attempt revision and lease epoch. Missing evidence is shown as unavailable.</p>` +
    attemptTimeline(detail) +
    (detail.nextCursor ? `<p class="desktop-pagination"><a class="desktop-button desktop-button-secondary" href="${buildHref(job.id, model.mode)}&amp;cursor=${encodeURIComponent(detail.nextCursor)}">Older attempts</a></p>` : "") +
    `</section>`;
}

function audit(model: ConsoleViewModel): string {
  if (!model.audit.value) return `<section class="desktop-page-heading"><p class="desktop-eyebrow">OPERATOR ACTION HISTORY</p><h1>Audit</h1></section>` +
    notice(model.notice) + dependencyUnavailable("Operator audit", model.audit);
  const query = model.auditQuery.trim().toLocaleLowerCase();
  const events = model.audit.value.events.filter((event) => !query ||
    [event.actorId, event.action, event.outcome, dateTime(event.occurredAt)].some((value) => value?.toLocaleLowerCase().includes(query)));
  const rows = events.length ? events.map((event) => `<tr><td>${escapeHtml(dateTime(event.occurredAt))}</td>` +
    `<th scope="row">${escapeHtml(event.action)}</th><td>${badge(humanize(event.outcome), event.outcome)}</td>` +
    `<td>${escapeHtml(event.actorId ?? "System")}</td></tr>`).join("") : "";
  const cursor = model.audit.value.nextCursor;
  const nextQuery = new URLSearchParams({ ui: model.mode });
  if (cursor && cursor.length <= 512) nextQuery.set("cursor", cursor);
  if (model.auditQuery) nextQuery.set("q", model.auditQuery);
  return `<section class="desktop-page-heading"><p class="desktop-eyebrow">OPERATOR ACTION HISTORY</p>` +
    `<h1>Audit</h1><p>Bounded, read-only operator events from the existing audit authority.</p></section>` + notice(model.notice) +
    `<section class="desktop-section" aria-labelledby="desktop-audit-title"><div class="desktop-section-heading">` +
    `<div><p class="desktop-eyebrow">AUDIT EVENTS</p><h2 id="desktop-audit-title">Recent operator activity</h2></div></div>` +
    `<form method="get" action="/audit" class="desktop-audit-search"><input type="hidden" name="ui" value="${model.mode}">` +
    `<label for="desktop-audit-query">Search audit events</label><input id="desktop-audit-query" name="q" type="search" maxlength="120" value="${escapeHtml(model.auditQuery)}">` +
    `<button class="desktop-button desktop-button-secondary" type="submit">Search</button></form>` +
    (events.length ? `<div class="desktop-table-scroll"><table class="desktop-audit-table"><caption class="desktop-sr-only">${events.length} audit events on this page</caption>` +
      `<thead><tr><th scope="col">Time (UTC)</th><th scope="col">Action</th><th scope="col">Outcome</th><th scope="col">Actor</th></tr></thead>` +
      `<tbody>${rows}</tbody></table></div>` : `<p class="desktop-empty">${model.audit.value.events.length
        ? "No events on this page match the search."
        : "No operator events are recorded on this page."}</p>`) +
    (cursor && cursor.length <= 512 ? `<p class="desktop-pagination"><a class="desktop-button desktop-button-secondary" href="/audit?${escapeHtml(nextQuery.toString())}">Next audit page</a></p>` : "") +
    `</section>`;
}

function sectionContent(model: ConsoleViewModel): string {
  if (model.section === "overview") return overview(model);
  if (model.section === "releases")
    return model.selectedReleaseId ? releaseDetail(model) : releases(model);
  if (model.section === "audit") return audit(model);
  if (model.selectedBuildId) return buildDetail(model);
  return builds(model);
}

function modeHref(model: ConsoleViewModel, mode: ConsoleViewModel["mode"]): string {
  const selectedReleaseId = model.selectedReleaseId;
  if (selectedReleaseId && model.section === "releases")
    return `/releases/${encodeURIComponent(selectedReleaseId)}?ui=${mode}`;
  if (model.selectedBuildId) return buildHref(model.selectedBuildId, mode);
  return consoleHref(model.section, mode);
}

function navigation(model: ConsoleViewModel): string {
  return `<nav class="desktop-operator-nav" aria-label="Operator sections">` + SECTIONS.map((section) =>
    `<a href="${consoleHref(section.id, model.mode)}"${model.section === section.id ? ' aria-current="page"' : ""}>` +
    `<span>${escapeHtml(section.label)}</span></a>`).join("") + `</nav>`;
}

/** Render the desktop operator composition. Authorization and route dispatch remain in console.ts. */
export function renderDesktopConsole(model: ConsoleViewModel): string {
  const selected = model.selectedBuildId && model.section === "builds" ? model.selectedBuildId : null;
  const contentModel = selected === model.selectedBuildId ? model : { ...model, selectedBuildId: selected };
  return `<div class="desktop-operator-console"><aside class="desktop-operator-sidebar">` +
    `<a class="desktop-operator-brand" href="${consoleHref("overview", model.mode)}"><span aria-hidden="true">P</span>` +
    `<span>Praetorium<small>Operator console</small></span></a>${navigation(model)}` +
    `<div class="desktop-sidebar-footer"><span>Authorized operations</span><span>Release and build operations</span></div></aside>` +
    `<div class="desktop-operator-main"><header class="desktop-operator-topbar"><div><span class="desktop-context-label">CONTROL PLANE</span>` +
    `<strong>Operator workspace</strong></div><div class="desktop-topbar-actions"><nav aria-label="Console layout">` +
    `<a href="${modeHref(model, "desktop")}"${model.mode === "desktop" ? ' aria-current="true"' : ""}>Desktop</a>` +
    `<a href="${modeHref(model, "mobile")}"${model.mode === "mobile" ? ' aria-current="true"' : ""}>Mobile</a></nav>` +
    `<form method="post" action="/logout?ui=${model.mode}"><input type="hidden" name="csrfToken" value="${escapeHtml(model.csrf)}">` +
    `<button class="desktop-button desktop-button-secondary" type="submit">Sign out</button></form></div></header>` +
    `<div class="desktop-operator-content">${sectionContent(contentModel)}</div></div></div>`;
}
