import { repositoryListView } from "./views/repositories.js";
import { repositoryView } from "./views/repository.js";
import { configurationForm, modulePreview } from "./views/configuration.js";
import { page } from "./views/document.js";
export { escapeHtml } from "./presentation.js";
import {
  escapeHtml,
  installationLabel,
  permissionLabel,
  instanceStateLabel,
  statusBadge,
  operationStateLabel,
  image,
  moduleNames,
  resources,
  cpu,
  memory,
  localUrl,
  type RepositoryRowView,
  type ConfigurationSelection,
  type PortalPresentation,
} from "./presentation.js";
import type {
  PortalArtifact,
  PortalHandoff,
  PortalModulePreview,
  PortalOperation,
  PortalRepositoryDashboard,
  PortalRepositoryList,
  PortalRepositorySummary,
} from "./types.js";

import { mutationForm, operationView, buildStatus, pollingScript } from "./views/operations.js";

export function renderPortalError(
  message: string,
  status = 503,
  presentation?: PortalPresentation,
): Response {
  const response = page(
    "Repository management",
    `<header class="page-heading"><div><p class="eyebrow">Praetorium workspace</p>` +
      `<h1>Repository management</h1><p class="alert" role="alert">${escapeHtml(message)}</p></div></header>` +
      `<p><a class="button button-secondary" href="${localUrl("/", presentation?.mode ?? "desktop")}">Return to repositories</a></p>`,
    { ...(presentation ? { presentation } : {}) },
  );
  return new Response(response.body, { status, headers: response.headers });
}

function canStopDashboard(dashboard: PortalRepositoryDashboard): boolean {
  return dashboard.canConfigure && dashboard.repository.instance.state === "ready";
}

function limits(dashboard: PortalRepositoryDashboard): string {
  const limit = dashboard.resourceLimits;
  return (
    `<section aria-labelledby="resource-limits"><div class="panel-heading"><div><p class="eyebrow">Capacity</p>` +
    `<h2 id="resource-limits">Operator limits</h2></div></div>` +
    `<dl class="resource-facts">` +
    `<div class="fact"><dt>CPU</dt><dd>${limit.cpuMilli === null ? "Unavailable" : cpu(limit.cpuMilli)}</dd></div>` +
    `<div class="fact"><dt>Memory</dt><dd>${limit.memoryMiB === null ? "Unavailable" : memory(limit.memoryMiB)}</dd></div>` +
    `<div class="fact"><dt>Ephemeral storage</dt><dd>${limit.ephemeralStorageMiB === null ? "Unavailable" : memory(limit.ephemeralStorageMiB)}</dd></div>` +
    `</dl></section>`
  );
}

function artifactSection(
  title: string,
  artifact: PortalArtifact | null,
  dashboard: PortalRepositoryDashboard,
): string {
  if (!artifact)
    return `<article class="release-card"><h3>${title}</h3><p>None</p><p class="muted">No approved deployment is configured.</p></article>`;
  const required = artifact.includedModules.filter((id) => !artifact.requestedModules.includes(id));
  return (
    `<article class="release-card"><h3>${title}</h3>` +
    `${artifact.composedImageDigest === null ? '<p class="muted">Not built</p>' : ""}` +
    `<p><strong>Base release</strong><br>${escapeHtml(artifact.releaseLabel ?? "Unavailable")} ` +
    `</p>` +
    `<p><strong>Requested modules:</strong><br>${moduleNames(artifact.requestedModules, dashboard)}</p>` +
    `<p><strong>Included modules:</strong><br>${moduleNames(artifact.includedModules, dashboard)}</p>` +
    `<p><strong>Required dependencies:</strong><br>${moduleNames(required, dashboard)}</p>` +
    `<h4>Resource allocation</h4>${resources(artifact.resources)}` +
    `<details><summary>Exact artifact identifiers</summary><p>Release <code class="digest">${escapeHtml(artifact.releaseId ?? "Unavailable")}</code></p><p>Base image <code class="digest">${escapeHtml(artifact.baseImageDigest ?? "Unavailable")}</code></p><p>Composed image <code class="digest">${image(artifact.composedImageDigest)}</code></p></details></article>`
  );
}

function summaryItem(
  repository: PortalRepositorySummary,
  csrfToken: string,
  appInstalled: boolean,
  presentation: PortalPresentation,
): RepositoryRowView {
  const status = instanceStateLabel(repository.instance.state);
  const details = repository.instance.reason
    ? `<p class="muted">${escapeHtml(repository.instance.reason)}</p>`
    : "";
  const path = `/repositories/${encodeURIComponent(repository.repositoryId)}`;
  const repositoryPath = localUrl(path, presentation.mode);
  const actionPath = localUrl(`${path}/actions`, presentation.mode);
  const canEnter =
    appInstalled &&
    repository.installation === "active" &&
    ["read", "write", "maintain", "admin"].includes(repository.permission);
  const canEnterExisting =
    repository.instance.instanceId !== null &&
    (repository.currentImageDigest !== null || repository.desiredImageDigest !== null) &&
    (["ready", "starting", "stopped"].includes(repository.instance.state) ||
      (["failed", "blocked"].includes(repository.instance.state) && repository.instance.retryable));
  const enter =
    canEnter && (repository.instance.instanceId === null || canEnterExisting)
      ? `<form method="post" action="${actionPath}">` +
        `<input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}">` +
        `<input type="hidden" name="action" value="enter">` +
        `<button type="submit" class="button button-secondary">${repository.instance.instanceId ? "Open application" : "Connect repository"}</button></form>`
      : "";
  const manage =
    canEnter && repository.instance.instanceId
      ? `<a class="button" href="${repositoryPath}">Manage repository</a>`
      : "";
  const operation = repository.operation
    ? `<p class="operation-summary">Latest ${escapeHtml(repository.operation.kind)}: ` +
      `${statusBadge(operationStateLabel(repository.operation.state), repository.operation.state)}</p>`
    : "<p>No recent operation</p>";
  const imageFacts =
    `<dl class="artifact-facts">` +
    `<div class="fact"><dt>Current</dt><dd><code class="digest">${image(repository.currentImageDigest)}</code></dd></div>` +
    `<div class="fact"><dt>Desired</dt><dd><code class="digest">${image(repository.desiredImageDigest)}</code></dd></div></dl>`;
  return {
    identity: `<a href="${repositoryPath}">${escapeHtml(repository.fullName)}</a>`,
    runtime: statusBadge(status, repository.instance.state),
    access: escapeHtml(permissionLabel(repository.permission)),
    installation:
      repository.installation === "active" && appInstalled
        ? ""
        : `GitHub App: ${escapeHtml(installationLabel(repository.installation))}`,
    reason: details,
    operation,
    revisions: imageFacts,
    actions: `${manage}${enter}`,
  };
}

export function renderRepositoryList(
  list: PortalRepositoryList,
  csrfToken: string,
  presentation: PortalPresentation = { mode: "desktop" },
): Response {
  const appInstalled = list.githubApp.installationState === "active";
  const rows = list.repositories.map((repository) =>
    summaryItem(repository, csrfToken, appInstalled, presentation),
  );
  const empty = `<div class="empty-state"><h2>No repositories available</h2><p>There are no repositories available to this GitHub account through the installed Praetorium App.</p></div>`;
  const retry =
    list.githubApp.installationState === "suspended" ||
    list.githubApp.installationState === "pending" ||
    list.githubApp.installationState === "unknown"
      ? `<p><a href="${localUrl("/", presentation.mode)}">Refresh status</a></p>`
      : "";
  return page(
    "Repositories",
    repositoryListView(
      {
        heading: `<div class="page-heading"><div><h1>Repositories <span class="muted">${list.repositories.length}</span></h1><p>Your applications, configurations and runtime state.</p></div>${logoutForm(csrfToken)}</div>`,
        connection: `<section class="status-panel" aria-labelledby="github-installation"><div><h2 id="github-installation">GitHub connection</h2><p>${escapeHtml(list.githubApp.message)}</p>${retry}</div>${statusBadge(installationLabel(list.githubApp.installationState), list.githubApp.installationState)}</section>`,
        rows,
        empty,
      },
      presentation.mode,
    ),
    { presentation },
  );
}

function logoutForm(csrfToken: string): string {
  return `<form class="inline-form" method="post" action="/auth/logout"><input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}"><button class="button button-secondary" type="submit">Sign out</button></form>`;
}

export function renderRepositoryDashboard(
  dashboard: PortalRepositoryDashboard,
  options: {
    readonly presentation?: PortalPresentation;
    readonly csrfToken: string;
    readonly createIdempotencyKey: () => string;
    readonly selection?: ConfigurationSelection;
    readonly preview?: PortalModulePreview;
    readonly notice?: PortalOperation;
    readonly errorMessage?: string;
    readonly pollCount?: number;
    readonly scriptNonce?: string;
  },
): Response {
  const repositoryId = encodeURIComponent(dashboard.repository.repositoryId);
  const presentation = options.presentation ?? {
    mode: "desktop",
    repositoryId: dashboard.repository.repositoryId,
  };
  const actionPath = localUrl(`/repositories/${repositoryId}/actions`, presentation.mode);
  const access =
    `<div class="status-grid">` +
    `<article class="status-card"><h3>GitHub App</h3>${statusBadge(installationLabel(dashboard.repository.installation), dashboard.repository.installation)}</article>` +
    `<article class="status-card"><h3>Your repository access</h3>${statusBadge(permissionLabel(dashboard.repository.permission), dashboard.repository.permission)}</article>` +
    `</div>`;
  const current = artifactSection("Current deployment", dashboard.current, dashboard);
  const desired = artifactSection("Desired deployment", dashboard.desired, dashboard);
  const reason = dashboard.repository.instance.reason
    ? `<p class="muted" role="status">${escapeHtml(dashboard.repository.instance.reason)}</p>`
    : "";
  const instanceState = dashboard.repository.instance.state;
  const canConfigure = dashboard.canConfigure;
  const canSelectConfiguration =
    dashboard.approvedReleases.length > 0 && dashboard.resourceProfiles.length > 0;
  const needsInitialConfiguration = dashboard.current === null && dashboard.desired === null;
  const canEnter =
    dashboard.repository.installation === "active" &&
    ["read", "write", "maintain", "admin"].includes(dashboard.repository.permission);
  const entryLabel =
    instanceState === "ready"
      ? "Open application"
      : instanceState === "stopped"
        ? "Start application"
        : instanceState === "starting"
          ? "Check application"
          : instanceState === "failed" || instanceState === "blocked"
            ? "Retry application start"
            : "Application status unavailable";
  const shouldOfferEntry =
    canEnter &&
    !needsInitialConfiguration &&
    (instanceState === "ready" ||
      instanceState === "starting" ||
      instanceState === "stopped" ||
      ((instanceState === "failed" || instanceState === "blocked") &&
        dashboard.repository.instance.retryable));
  const enter = shouldOfferEntry
    ? `<form class="inline-form" method="post" action="${actionPath}">` +
      `<input type="hidden" name="csrfToken" value="${escapeHtml(options.csrfToken)}">` +
      `<input type="hidden" name="action" value="enter"><button class="button" type="submit">${entryLabel}</button></form>`
    : needsInitialConfiguration
      ? canConfigure && canSelectConfiguration
        ? `<p class="muted" role="status">Configuration is required before this application can start. <a href="#configuration">Choose an approved configuration below</a>, then save it to build and start the application.</p>`
        : canConfigure
          ? `<p class="muted" role="status">Configuration is required before this application can start. No approved release and resource profile are currently available.</p>`
          : `<p class="muted" role="status">Configuration is required before this application can start. Ask a repository maintainer or administrator to choose an approved release and resource profile.</p>`
      : `<p>Application status: ${escapeHtml(instanceStateLabel(instanceState))}</p>` +
        `<p>Wait for the application to become ready, then refresh status.</p>`;
  const refresh = `<a class="button button-secondary" href="${localUrl(`/repositories/${repositoryId}`, presentation.mode)}">Refresh status</a>`;
  const stop = canStopDashboard(dashboard)
    ? mutationForm(
        actionPath,
        options.csrfToken,
        options.createIdempotencyKey(),
        `<input type="hidden" name="action" value="stop">` +
          `<input type="hidden" name="expectedGeneration" value="${dashboard.generation}">`,
        "Stop application",
      )
    : "";
  const latest =
    options.notice && (options.notice.state === "queued" || options.notice.state === "running")
      ? options.notice
      : dashboard.operations.find(
          (operation) => operation.state === "queued" || operation.state === "running",
        );
  const activeBuild =
    dashboard.build !== null &&
    ["reserved", "pending", "claimed", "running", "verifying"].includes(dashboard.build.status);
  const polling =
    (latest || activeBuild) && options.scriptNonce
      ? pollingScript(options.scriptNonce, options.pollCount ?? 0)
      : "";
  const operations = [
    ...(options.notice ? [options.notice] : []),
    ...dashboard.operations.filter(
      (operation) => operation.operationId !== options.notice?.operationId,
    ),
  ]
    .map((operation) =>
      operationView(
        operation,
        dashboard,
        options.csrfToken,
        options.createIdempotencyKey,
        actionPath,
      ),
    )
    .join("");
  const operationContent = operations || "<p>No recent operations.</p>";
  const preview = options.preview ?? (options.selection ? null : dashboard.preview);
  const configure =
    canConfigure && canSelectConfiguration
      ? configurationForm(
          dashboard,
          options.csrfToken,
          options.createIdempotencyKey,
          actionPath,
          preview,
          options.selection,
        )
      : canConfigure
        ? `<section class="configuration-panel"><p class="eyebrow">Configuration</p><h2>Desired configuration</h2>` +
          `<p class="alert" role="status">No approved release and resource profile are currently available. Once they are approved, choose them here to configure and start the application.</p></section>`
        : `<section class="configuration-panel"><p class="eyebrow">Configuration</p><h2>Desired configuration</h2>` +
          `<p class="muted">Changes require current repository maintain or admin access. You can review the approved configuration and runtime status above.</p></section>`;
  const sameImage =
    dashboard.current?.composedImageDigest !== null &&
    dashboard.current?.composedImageDigest === dashboard.desired?.composedImageDigest;
  const redeploy =
    canConfigure && (dashboard.current !== null || dashboard.desired !== null)
      ? `<section class="configuration-panel"><p class="eyebrow">Runtime action</p><h2>Redeploy</h2>` +
        `<p class="muted">A redeploy creates a new runtime epoch${sameImage ? " even though the image digest is unchanged" : ""}.</p>` +
        `${mutationForm(
          actionPath,
          options.csrfToken,
          options.createIdempotencyKey(),
          `<input type="hidden" name="action" value="redeploy">` +
            `<input type="hidden" name="expectedGeneration" value="${dashboard.generation}">`,
          "Redeploy current configuration",
        )}</section>`
      : "";
  const selectedPreview =
    `<section aria-labelledby="module-preview"><p class="eyebrow">Configuration preview</p><h2 id="module-preview">Module resolution</h2>` +
    `${modulePreview(preview, dashboard)}</section>`;
  const activeOperation = latest !== undefined || activeBuild;
  const automaticStatus =
    activeOperation && polling === ""
      ? `<p role="status">Automatic refresh paused. Use Refresh status to check again.</p>`
      : polling;
  return page(
    dashboard.repository.fullName,
    repositoryView(
      {
        heading: `<div class="page-heading"><div><p class="breadcrumb"><a href="${localUrl("/", presentation.mode)}">Repositories</a> / ${escapeHtml(dashboard.repository.fullName)}</p><h1>${escapeHtml(dashboard.repository.fullName)}</h1></div>${logoutForm(options.csrfToken)}</div>${options.errorMessage && !options.selection ? `<p class="alert" role="alert">${escapeHtml(options.errorMessage)}</p>` : ""}`,
        runtime: `<section class="entry-panel" aria-labelledby="entry" data-runtime-state="${instanceState}"><h2 id="entry">Application status</h2>${statusBadge(instanceStateLabel(instanceState), instanceState)}${reason}<div class="entry-actions">${enter}${stop}${refresh}</div></section>`,
        access,
        current,
        desired,
        evidence: (() => {
          const recent = options.notice ?? dashboard.operations[0];
          if (!recent) return '<p class="evidence-no-activity">No recent operation.</p>';
          const summary = recent.error ?? recent.message ?? "No further information available.";
          return '<div class="evidence-incident"><span class="evidence-incident-label">LATEST OPERATION · ' +
            escapeHtml(recent.kind) + '</span>' +
            statusBadge(operationStateLabel(recent.state), recent.state) +
            '<p>' + escapeHtml(summary) + '</p></div>';
        })(),
        policy: statusBadge(
          dashboard.releasePolicy.kind === "stable" ? "Follow stable" : "Pinned release",
          dashboard.releasePolicy.kind,
        ),
        configuration: `${options.errorMessage && options.selection ? `<p class="alert" role="alert">${escapeHtml(options.errorMessage)}</p>` : ""}${configure}`,
        limits: limits(dashboard),
        preview: selectedPreview,
        operations: `<section aria-labelledby="operations"><div class="panel-heading"><h2 id="operations">Build and operation progress</h2>${activeOperation ? statusBadge("In progress", "running") : ""}</div>${automaticStatus}${buildStatus(dashboard.build)}<div class="operation-list">${operationContent}</div></section>`,
        redeploy,
      },
      presentation.mode,
    ),
    { presentation, ...(options.scriptNonce ? { scriptNonce: options.scriptNonce } : {}) },
  );
}

export function renderHandoff(handoff: PortalHandoff, nonce: string): Response {
  let origin: URL;
  try {
    origin = new URL(handoff.origin);
  } catch {
    return renderPortalError("Application entry could not be prepared.", 502);
  }
  if (
    !/^[A-Za-z0-9_-]{16,256}$/.test(nonce) ||
    origin.protocol !== "https:" ||
    origin.origin !== handoff.origin ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== "" ||
    origin.hostname.length > 253 ||
    !origin.hostname
      .split(".")
      .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
    handoff.returnPath !== "/"
  ) {
    return renderPortalError("Application entry could not be prepared.", 502);
  }
  const action = `${origin.origin}/_platform/handoff`;
  return page(
    "Enter application",
    `<section class="evidence-ledger evidence-handoff" aria-labelledby="handoff-title">` +
      `<header class="evidence-intro"><div class="page-heading"><div>` +
      `<h1 id="handoff-title">Opening application</h1>` +
      `<p>Continuing to your repository workspace.</p></div></div></header>` +
      `<form id="handoff" method="post" action="${escapeHtml(action)}" enctype="application/x-www-form-urlencoded">` +
      `<input type="hidden" name="code" value="${escapeHtml(handoff.code)}">` +
      `<input type="hidden" name="returnPath" value="/">` +
      `<button type="submit">Continue</button></form></section>` +
      `<script nonce="${escapeHtml(nonce)}">document.getElementById('handoff')?.submit();</script>`,
    {
      formAction: origin.origin,
      scriptNonce: nonce,
      // The document policy also survives an ingress response-header baseline.
      // Cross-origin form POSTs must retain the exact Gateway Origin.
      referrerPolicy: "strict-origin",
      layout: "handoff",
    },
  );
}
