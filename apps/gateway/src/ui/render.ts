import { escapeHtml, page } from "./views/document.js";
export { escapeHtml } from "./views/document.js";
import { localUrl, type PortalPresentation } from "./presentation.js";
import type {
  PortalArtifact,
  PortalHandoff,
  PortalModulePreview,
  PortalOperation,
  PortalRepositoryDashboard,
  PortalRepositoryList,
  PortalRepositorySummary,
  PortalResources,
} from "./types.js";

const MAX_AUTOMATIC_POLLS = 5;

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

function installationLabel(state: PortalRepositorySummary["installation"]): string {
  switch (state) {
    case "active":
      return "Active";
    case "pending":
      return "Setup pending";
    case "suspended":
      return "Suspended";
    case "removed":
      return "Not installed";
    case "unknown":
      return "Status unavailable";
  }
}

function permissionLabel(permission: PortalRepositorySummary["permission"]): string {
  switch (permission) {
    case "none":
      return "No access";
    case "read":
      return "Read access";
    case "write":
      return "Write access";
    case "maintain":
      return "Maintain access";
    case "admin":
      return "Admin access";
    case "unknown":
      return "Access status unavailable";
  }
}

function instanceStateLabel(state: PortalRepositorySummary["instance"]["state"]): string {
  switch (state) {
    case "ready":
      return "Ready";
    case "starting":
      return "Starting";
    case "stopped":
      return "Stopped";
    case "failed":
      return "Failed";
    case "blocked":
      return "Blocked";
    case "unknown":
      return "Status unavailable";
  }
}

function statusTone(state: string): string {
  if (["active", "ready", "succeeded", "valid", "write", "maintain", "admin"].includes(state))
    return "status-good";
  if (
    ["pending", "starting", "queued", "running", "blocked", "unknown", "unavailable"].includes(
      state,
    )
  )
    return "status-warn";
  if (
    ["suspended", "removed", "failed", "canceled", "cancelled", "unsupported", "none"].includes(
      state,
    )
  )
    return "status-bad";
  return "status-neutral";
}

function statusBadge(label: string, state: string): string {
  return `<span class="status-badge ${statusTone(state)}">${escapeHtml(label)}</span>`;
}

function canStopDashboard(dashboard: PortalRepositoryDashboard): boolean {
  return dashboard.canConfigure && dashboard.repository.instance.state === "ready";
}

function operationStateLabel(state: PortalOperation["state"]): string {
  switch (state) {
    case "queued":
      return "Queued";
    case "running":
      return "In progress";
    case "succeeded":
      return "Complete";
    case "failed":
      return "Failed";
    case "blocked":
      return "Blocked";
    case "canceled":
      return "Canceled";
    case "unknown":
      return "Status unavailable";
  }
}

function image(value: string | null): string {
  return value ? escapeHtml(value) : "Not built";
}

function shortDigest(value: string): string {
  const algorithmPrefix = "sha256:";
  if (value.startsWith(algorithmPrefix) && value.length > algorithmPrefix.length + 12) {
    return `${algorithmPrefix}${value.slice(algorithmPrefix.length, algorithmPrefix.length + 12)}…`;
  }
  return value.length > 24 ? `${value.slice(0, 21)}…` : value;
}

function safeCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function cpu(value: number): string {
  return safeCount(value) ? `${(value / 1000).toFixed(2)} vCPU` : "Unavailable";
}

function memory(value: number): string {
  if (!safeCount(value)) return "Unavailable";
  return value >= 1024 ? `${(value / 1024).toFixed(1)} GiB` : `${value} MiB`;
}

function resources(value: PortalResources): string {
  return (
    `<dl class="resource-facts">` +
    `<div class="fact"><dt>CPU</dt><dd>${cpu(value.cpuMilli)}</dd></div>` +
    `<div class="fact"><dt>Memory</dt><dd>${memory(value.memoryMiB)}</dd></div>` +
    `<div class="fact"><dt>Ephemeral storage</dt><dd>${memory(value.ephemeralStorageMiB)}</dd></div></dl>`
  );
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

function buildStatusLabel(
  status: NonNullable<PortalRepositoryDashboard["build"]>["status"],
): string {
  switch (status) {
    case "reserved":
      return "Reserved";
    case "pending":
      return "Queued";
    case "claimed":
      return "Claimed";
    case "running":
      return "Building";
    case "verifying":
      return "Verifying artifact";
    case "succeeded":
      return "Complete";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Canceled";
  }
}

function buildStatus(build: PortalRepositoryDashboard["build"]): string {
  if (!build) return "<p>No configuration build is associated with the desired revision.</p>";
  const progress =
    build.progressPercent !== null &&
    Number.isFinite(build.progressPercent) &&
    build.progressPercent >= 0 &&
    build.progressPercent <= 100
      ? `<progress class="progress-track" max="100" value="${build.progressPercent}" aria-label="Build progress">${build.progressPercent}%</progress>`
      : "";
  const stage = build.stage ? `<p>Build stage: ${escapeHtml(build.stage)}</p>` : "";
  const error = build.errorCode
    ? `<p role="alert">Build error: ${escapeHtml(build.errorCode)}</p>`
    : "";
  return (
    `<article class="operation-card"><div class="panel-heading"><h3>Configuration build</h3>${statusBadge(buildStatusLabel(build.status), build.status)}</div>` +
    `<p>Build <code>${escapeHtml(build.buildId)}</code></p>` +
    `<p>Build key <code class="digest">${escapeHtml(build.buildKey)}</code></p>` +
    `${stage}${progress}${error}</article>`
  );
}

function moduleNames(ids: readonly string[], dashboard: PortalRepositoryDashboard): string {
  if (ids.length === 0) return "None";
  const options = new Map(dashboard.modules.map((module) => [module.moduleId, module]));
  return ids
    .map((id) => {
      const option = options.get(id);
      return option
        ? `${escapeHtml(option.label)} (${escapeHtml(option.version)})`
        : escapeHtml(id);
    })
    .join(", ");
}

function artifactSection(
  title: string,
  artifact: PortalArtifact | null,
  dashboard: PortalRepositoryDashboard,
): string {
  if (!artifact) return `<section><h3>${title}</h3><p>None</p></section>`;
  const required = artifact.includedModules.filter((id) => !artifact.requestedModules.includes(id));
  return (
    `<article class="release-card"><h3>${title}</h3>` +
    `<p><strong>Composed image</strong><code class="digest">${image(artifact.composedImageDigest)}</code></p>` +
    `<p><strong>Base release</strong><br>${escapeHtml(artifact.releaseLabel ?? "Unavailable")} ` +
    `(<code class="digest">${escapeHtml(artifact.baseImageDigest ?? "Unavailable")}</code>)</p>` +
    `<p><strong>Requested modules:</strong><br>${moduleNames(artifact.requestedModules, dashboard)}</p>` +
    `<p><strong>Included modules:</strong><br>${moduleNames(artifact.includedModules, dashboard)}</p>` +
    `<p><strong>Required dependencies:</strong><br>${moduleNames(required, dashboard)}</p>` +
    `<h4>Resource allocation</h4>${resources(artifact.resources)}</article>`
  );
}

function summaryItem(
  repository: PortalRepositorySummary,
  csrfToken: string,
  appInstalled: boolean,
  presentation: PortalPresentation,
): string {
  const status = escapeHtml(instanceStateLabel(repository.instance.state));
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
  const enter = canEnter
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
    : "";
  const imageFacts =
    `<details><summary>Image revisions</summary><dl class="artifact-facts">` +
    `<div class="fact"><dt>Current</dt><dd><code class="digest">${image(repository.currentImageDigest)}</code></dd></div>` +
    `<div class="fact"><dt>Desired</dt><dd><code class="digest">${image(repository.desiredImageDigest)}</code></dd></div></dl></details>`;
  return (
    `<li class="repository-card"><header class="card-heading"><div><p class="eyebrow">GitHub repository</p>` +
    `<h2>${escapeHtml(repository.fullName)}</h2></div>${statusBadge(status, repository.instance.state)}</header>` +
    `<dl class="repo-facts">` +
    `<div class="fact"><dt>GitHub App</dt><dd>${escapeHtml(installationLabel(repository.installation))}</dd></div>` +
    `<div class="fact"><dt>Your access</dt><dd>${escapeHtml(permissionLabel(repository.permission))}</dd></div></dl>` +
    `${details}` +
    `${operation}${imageFacts}<div class="card-actions">${manage}${enter}</div></li>`
  );
}

export function renderRepositoryList(
  list: PortalRepositoryList,
  csrfToken: string,
  presentation: PortalPresentation = { mode: "desktop" },
): Response {
  const appInstalled = list.githubApp.installationState === "active";
  const repos = list.repositories
    .map((repository) => summaryItem(repository, csrfToken, appInstalled, presentation))
    .join("");
  const content = list.repositories.length
    ? `<ul class="repository-grid">${repos}</ul>`
    : `<div class="empty-state"><h3>No repositories available</h3><p>There are no repositories available to this GitHub account through the installed Praetorium App.</p></div>`;
  const retry =
    list.githubApp.installationState === "suspended" ||
    list.githubApp.installationState === "pending" ||
    list.githubApp.installationState === "unknown"
      ? `<p><a href="${localUrl("/", presentation.mode)}">Refresh status</a></p>`
      : "";
  return page(
    "Repository management",
    `<header class="page-heading"><div><p class="eyebrow">Workspace</p><h1>Your repositories</h1>` +
      `<p>Choose a connected repository to review its approved release, configuration, and runtime status.</p></div>` +
      `<form class="inline-form" method="post" action="/auth/logout">` +
      `<input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}">` +
      `<button type="submit" class="button button-secondary">Sign out</button></form></header>` +
      `<section class="status-panel" aria-labelledby="github-installation"><div>` +
      `<p class="eyebrow">GitHub connection</p><h2 id="github-installation">Praetorium App installation</h2>` +
      `<p>${escapeHtml(list.githubApp.message)}</p>${retry}</div>` +
      `${statusBadge(installationLabel(list.githubApp.installationState), list.githubApp.installationState)}</section>` +
      `<section aria-labelledby="repositories-heading"><div class="panel-heading"><div>` +
      `<p class="eyebrow">Repository access</p><h2 id="repositories-heading">Repositories</h2></div>` +
      `<span class="muted">${list.repositories.length} available</span></div>${content}</section>`,
    { presentation },
  );
}

function modulePreview(
  preview: PortalModulePreview | null,
  dashboard: PortalRepositoryDashboard,
): string {
  if (!preview) return `<p>No configuration preview is available yet.</p>`;
  const stateText =
    preview.state === "valid"
      ? "Supported module configuration"
      : preview.state === "unsupported"
        ? "Unsupported module configuration"
        : "Preview unavailable";
  const reasons = preview.unsupportedReasons.length
    ? `<ul class="preview-reasons">${preview.unsupportedReasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>`
    : "";
  const resourceDetails = preview.resources
    ? `<h4>Resolved resource allocation</h4>${resources(preview.resources)}`
    : "";
  return (
    `<div role="status" aria-live="polite">${statusBadge(stateText, preview.state)}` +
    `<dl class="preview-facts">` +
    `<div><dt>Requested modules:</dt><dd>${moduleNames(preview.requestedModules, dashboard)}</dd></div>` +
    `<div><dt>Included modules:</dt><dd>${moduleNames(preview.includedModules, dashboard)}</dd></div>` +
    `<div><dt>Required dependencies:</dt><dd>${moduleNames(
      preview.includedModules.filter((id) => !preview.requestedModules.includes(id)),
      dashboard,
    )}</dd></div></dl>` +
    `${reasons}${resourceDetails}</div>`
  );
}

function optionsForReleases(
  dashboard: PortalRepositoryDashboard,
  selectedId: string | undefined,
): string {
  return dashboard.approvedReleases
    .map(
      (release) =>
        `<option value="${escapeHtml(release.releaseId)}"${release.releaseId === selectedId ? " selected" : ""}>` +
        `${escapeHtml(release.label)} · ${escapeHtml(shortDigest(release.imageDigest))}</option>`,
    )
    .join("");
}

function optionsForModules(
  dashboard: PortalRepositoryDashboard,
  selectedModules: readonly string[],
): string {
  const selected = new Set(selectedModules);
  return dashboard.modules
    .map(
      (module) =>
        `<option value="${escapeHtml(module.moduleId)}"${selected.has(module.moduleId) ? " selected" : ""}>` +
        `${escapeHtml(module.label)} (${escapeHtml(module.version)} · ${escapeHtml(shortDigest(module.artifactDigest))})</option>`,
    )
    .join("");
}

function optionsForResources(
  dashboard: PortalRepositoryDashboard,
  selectedProfileId: string | undefined,
): string {
  return dashboard.resourceProfiles
    .map((profile) => {
      const selected = profile.profileId === selectedProfileId ? " selected" : "";
      return `<option value="${escapeHtml(profile.profileId)}"${selected}>${escapeHtml(profile.label)}</option>`;
    })
    .join("");
}

function mutationForm(
  action: string,
  csrfToken: string,
  idempotencyKey: string,
  body: string,
  label: string,
): string {
  return (
    `<form class="inline-form" method="post" action="${action}">` +
    `<input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}">` +
    `<input type="hidden" name="idempotencyKey" value="${escapeHtml(idempotencyKey)}">` +
    `${body}<button class="button button-secondary" type="submit">${label}</button></form>`
  );
}

function operationView(
  operation: PortalOperation,
  dashboard: PortalRepositoryDashboard,
  csrfToken: string,
  createIdempotencyKey: () => string,
  actionPath: string,
): string {
  const progress =
    operation.progressPercent !== null &&
    Number.isFinite(operation.progressPercent) &&
    operation.progressPercent >= 0 &&
    operation.progressPercent <= 100
      ? `<progress class="progress-track" max="100" value="${operation.progressPercent}" aria-label="${escapeHtml(operation.kind)} progress">${operation.progressPercent}%</progress>`
      : "";
  const message = operation.message ? `<p>${escapeHtml(operation.message)}</p>` : "";
  const error = operation.error ? `<p role="alert">${escapeHtml(operation.error)}</p>` : "";
  const retry =
    dashboard.canConfigure && operation.retryable
      ? mutationForm(
          actionPath,
          csrfToken,
          createIdempotencyKey(),
          `<input type="hidden" name="action" value="retry">` +
            `<input type="hidden" name="operationId" value="${escapeHtml(operation.operationId)}">`,
          "Retry operation",
        )
      : "";
  return (
    `<article class="operation-card"><div class="panel-heading"><h3>${escapeHtml(operation.kind)}</h3>` +
    `${statusBadge(operationStateLabel(operation.state), operation.state)}</div>` +
    `<p>Operation <code>${escapeHtml(operation.operationId)}</code></p>${progress}${message}${error}${retry}</article>`
  );
}

function configurationForm(
  dashboard: PortalRepositoryDashboard,
  csrfToken: string,
  createIdempotencyKey: () => string,
  actionPath: string,
  preview: PortalModulePreview | null,
): string {
  const policy = preview?.releasePolicy ?? dashboard.releasePolicy.kind;
  const releaseId =
    preview?.releaseId ??
    (dashboard.releasePolicy.kind === "pinned"
      ? (dashboard.releasePolicy.releaseId ?? dashboard.approvedReleases[0]?.releaseId)
      : (dashboard.desired?.releaseId ?? dashboard.approvedReleases[0]?.releaseId));
  const selectedModules =
    preview?.requestedModules ??
    dashboard.desired?.requestedModules ??
    dashboard.current?.requestedModules ??
    [];
  const resourceProfileId = preview?.resourceProfileId ?? dashboard.desired?.resourceProfileId;
  const canSave = preview?.state !== "unsupported" && preview?.state !== "unavailable";
  const formFields = () =>
    `<div class="form-grid">` +
    `<label class="form-field" for="configuration-release-policy"><span>Release policy</span><select id="configuration-release-policy" name="releasePolicy" required>` +
    `<option value="stable"${policy === "stable" ? " selected" : ""}>Follow stable releases</option>` +
    `<option value="pinned"${policy === "pinned" ? " selected" : ""}>Pin an approved release</option></select>` +
    `<span class="field-help">Stable follows the approved stable release; pinned keeps the selected approved release.</span></label>` +
    `<label class="form-field" for="configuration-release-id"><span>Approved base release</span><select id="configuration-release-id" name="releaseId" required>${optionsForReleases(dashboard, releaseId)}</select>` +
    `<span class="field-help">Only releases already approved for this workspace appear here.</span></label>` +
    `<label class="form-field" for="configuration-module-ids"><span>Requested modules</span><select id="configuration-module-ids" name="moduleIds" multiple size="${Math.min(Math.max(dashboard.modules.length, 2), 8)}" aria-describedby="configuration-module-ids-help">` +
    `${optionsForModules(dashboard, selectedModules)}</select>` +
    `<span class="field-help" id="configuration-module-ids-help">Use Ctrl or Command to select more than one module. Required dependencies are shown in the preview.</span></label>` +
    `<label class="form-field" for="configuration-resource-profile"><span>Resource profile</span><select id="configuration-resource-profile" name="resourceProfileId" required>${optionsForResources(dashboard, resourceProfileId)}</select>` +
    `<span class="field-help">The application service checks this profile against current operator limits.</span></label></div>`;
  return (
    `<section class="configuration-panel" aria-labelledby="configuration"><p class="eyebrow">Configuration</p>` +
    `<h2 id="configuration">Desired configuration</h2>` +
    `<p class="muted">Preview your selection before saving. A saved configuration starts a verified build.</p>` +
    `<form method="post" action="${actionPath}">` +
    `<input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}">` +
    `<input type="hidden" name="idempotencyKey" value="${escapeHtml(createIdempotencyKey())}">` +
    `<input type="hidden" name="expectedGeneration" value="${dashboard.generation}">` +
    `${formFields()}<div class="form-actions">` +
    `<button class="button" type="submit" name="action" value="configure"${canSave ? "" : " disabled"}>Save configuration and build</button>` +
    `<button type="submit" class="button button-secondary" name="action" value="preview">Preview selection</button>` +
    `</div></form></section>`
  );
}

function pollingScript(nonce: string, pollCount: number): string {
  const safeCount = Math.max(0, Math.min(MAX_AUTOMATIC_POLLS, Math.trunc(pollCount)));
  const pollMarkup =
    safeCount >= MAX_AUTOMATIC_POLLS
      ? `<p role="status">Automatic refresh paused. Use Refresh status to check again.</p>`
      : `<p role="status">Progress updates refresh automatically for a short time.</p>`;
  const script =
    safeCount >= MAX_AUTOMATIC_POLLS
      ? ""
      : `<script nonce="${escapeHtml(nonce)}">` +
        `const n=${safeCount};const u=new URL(location.href);` +
        `u.searchParams.set('poll',String(n+1));` +
        `setTimeout(()=>location.replace(u.toString()),Math.min(16000,1000*2**n));` +
        `</script>`;
  return `<div data-portal-active-operation="true">${pollMarkup}</div>${script}`;
}

export function renderRepositoryDashboard(
  dashboard: PortalRepositoryDashboard,
  options: {
    readonly presentation?: PortalPresentation;
    readonly csrfToken: string;
    readonly createIdempotencyKey: () => string;
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
  const operations = [...(options.notice ? [options.notice] : []), ...dashboard.operations]
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
  const preview = options.preview ?? dashboard.preview;
  const configure =
    canConfigure && canSelectConfiguration
      ? configurationForm(
          dashboard,
          options.csrfToken,
          options.createIdempotencyKey,
          actionPath,
          preview,
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
    `<header class="page-heading"><div><p class="breadcrumb"><a href="${localUrl("/", presentation.mode)}">Repositories</a> / ${escapeHtml(dashboard.repository.fullName)}</p>` +
      `<p class="eyebrow">Repository management</p><h1>${escapeHtml(dashboard.repository.fullName)}</h1>` +
      `<p>Review the current runtime, approved deployment, and repository configuration.</p></div>` +
      `${statusBadge(instanceStateLabel(instanceState), instanceState)}</header>` +
      `<div class="dashboard-grid"><section class="entry-panel" aria-labelledby="entry"><p class="eyebrow">Runtime</p>` +
      `<h2 id="entry">Application status</h2>${reason}` +
      `<p>The current instance is <strong>${escapeHtml(instanceStateLabel(instanceState))}</strong>.</p>` +
      `<div class="entry-actions">${enter}${stop}${refresh}</div></section>` +
      `<section aria-labelledby="access-heading"><p class="eyebrow">Authorization</p><h2 id="access-heading">Access and permissions</h2>${access}</section></div>` +
      `<section aria-labelledby="deployments"><div class="panel-heading"><div><p class="eyebrow">Images and policy</p>` +
      `<h2 id="deployments">Deployment</h2></div>${statusBadge(dashboard.releasePolicy.kind === "stable" ? "Follow stable" : "Pinned release", dashboard.releasePolicy.kind)}</div>` +
      `<div class="release-cards">${current}${desired}</div></section>${limits(dashboard)}${selectedPreview}` +
      `<section aria-labelledby="operations"><div class="panel-heading"><div><p class="eyebrow">Live status</p>` +
      `<h2 id="operations">Build and operation progress</h2></div>${activeOperation ? statusBadge("In progress", "running") : ""}</div>` +
      `${options.errorMessage ? `<p class="alert" role="alert">${escapeHtml(options.errorMessage)}</p>` : ""}` +
      `${automaticStatus}${buildStatus(dashboard.build)}<div class="operation-list">${operationContent}</div></section>` +
      `${configure}${redeploy}`,
    (activeOperation || activeBuild) && options.scriptNonce
      ? { scriptNonce: options.scriptNonce, presentation }
      : { presentation },
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
    `<h1>Continue to the application</h1>` +
      `<form id="handoff" method="post" action="${escapeHtml(action)}" enctype="application/x-www-form-urlencoded">` +
      `<input type="hidden" name="code" value="${escapeHtml(handoff.code)}">` +
      `<input type="hidden" name="returnPath" value="/">` +
      `<button type="submit">Continue</button></form>` +
      `<script nonce="${escapeHtml(nonce)}">document.getElementById('handoff')?.submit();</script>`,
    { formAction: origin.origin, scriptNonce: nonce },
  );
}
