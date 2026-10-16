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

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function page(
  title: string,
  body: string,
  options: { readonly formAction?: string; readonly scriptNonce?: string } = {},
): Response {
  const formAction = options.formAction ?? "'self'";
  const validNonce =
    options.scriptNonce && /^[A-Za-z0-9_-]{16,256}$/.test(options.scriptNonce)
      ? options.scriptNonce
      : undefined;
  const scriptPolicy = validNonce ? `; script-src 'nonce-${validNonce}'` : "";
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<title>${escapeHtml(title)}</title></head><body><main>${body}</main></body></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          `default-src 'none'; frame-ancestors 'none'; base-uri 'none'; ` +
          `form-action ${formAction}${scriptPolicy}`,
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

export function renderPortalError(message: string, status = 503): Response {
  const response = page(
    "Repository management",
    `<h1>Repository management</h1><p role="alert">${escapeHtml(message)}</p>` +
      `<p><a href="/">Retry</a></p>`,
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
    `<dl><dt>CPU</dt><dd>${cpu(value.cpuMilli)}</dd>` +
    `<dt>Memory</dt><dd>${memory(value.memoryMiB)}</dd>` +
    `<dt>Ephemeral storage</dt><dd>${memory(value.ephemeralStorageMiB)}</dd>` +
    `<dt>Shared model pool</dt><dd>${memory(value.modelPoolMiB)}</dd>` +
    `<dt>Maximum workers</dt><dd>${safeCount(value.workerMax) ? value.workerMax : "Unavailable"}</dd></dl>`
  );
}

function limits(dashboard: PortalRepositoryDashboard): string {
  const limit = dashboard.resourceLimits;
  return (
    `<section aria-labelledby="resource-limits"><h3 id="resource-limits">Operator limits</h3>` +
    `<p>Capacity observation: ${escapeHtml(limit.capacityState)}</p>` +
    `<dl><dt>CPU</dt><dd>${limit.cpuMilli === null ? "Unavailable" : cpu(limit.cpuMilli)}</dd>` +
    `<dt>Memory</dt><dd>${limit.memoryMiB === null ? "Unavailable" : memory(limit.memoryMiB)}</dd>` +
    `<dt>Ephemeral storage</dt><dd>${limit.ephemeralStorageMiB === null ? "Unavailable" : memory(limit.ephemeralStorageMiB)}</dd></dl></section>`
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
    `<section><h3>${title}</h3>` +
    `<p>Composed image: <code>${image(artifact.composedImageDigest)}</code></p>` +
    `<p>Base release: ${escapeHtml(artifact.releaseLabel)} ` +
    `(<code>${escapeHtml(artifact.baseImageDigest)}</code>)</p>` +
    `<p>Requested modules: ${moduleNames(artifact.requestedModules, dashboard)}</p>` +
    `<p>Included modules: ${moduleNames(artifact.includedModules, dashboard)}</p>` +
    `<p>Required dependencies: ${moduleNames(required, dashboard)}</p>` +
    `<h4>Resource allocation</h4>${resources(artifact.resources)}</section>`
  );
}

function summaryItem(repository: PortalRepositorySummary): string {
  const status = escapeHtml(instanceStateLabel(repository.instance.state));
  const details = repository.instance.reason
    ? `<p>${escapeHtml(repository.instance.reason)}</p>`
    : "";
  const action = `<p><a href="/repositories/${encodeURIComponent(repository.repositoryId)}">Manage repository</a></p>`;
  const operation = repository.operation
    ? `<p>Latest ${escapeHtml(repository.operation.kind)} operation: ` +
      `${escapeHtml(operationStateLabel(repository.operation.state))}</p>`
    : "";
  return (
    `<li><h2>${escapeHtml(repository.fullName)}</h2>` +
    `<p>GitHub App: ${escapeHtml(installationLabel(repository.installation))}</p>` +
    `<p>Repository access: ${escapeHtml(permissionLabel(repository.permission))}</p>` +
    `<p>Instance: ${status}</p>${details}` +
    `<p>Current image: <code>${image(repository.currentImageDigest)}</code></p>` +
    `<p>Desired image: <code>${image(repository.desiredImageDigest)}</code></p>` +
    `${operation}${action}</li>`
  );
}

export function renderRepositoryList(list: PortalRepositoryList, csrfToken: string): Response {
  const repos = list.repositories.map(summaryItem).join("");
  const content = list.repositories.length
    ? `<ul>${repos}</ul>`
    : `<p>No repositories are available to this GitHub account.</p>`;
  const retry =
    list.githubApp.installationState === "suspended" ||
    list.githubApp.installationState === "pending" ||
    list.githubApp.installationState === "unknown"
      ? `<p><a href="/">Refresh status</a></p>`
      : "";
  return page(
    "Repository management",
    `<h1>Repository management</h1>` +
      `<section><h2>GitHub App installation</h2>` +
      `<p>Status: ${escapeHtml(installationLabel(list.githubApp.installationState))}</p>` +
      `<p>${escapeHtml(list.githubApp.message)}</p>${retry}</section>` +
      `<section><h2>Repositories</h2>${content}</section>` +
      `<form method="post" action="/auth/logout">` +
      `<input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}">` +
      `<button type="submit">Sign out</button></form>`,
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
    ? `<ul>${preview.unsupportedReasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>`
    : "";
  const resourceDetails = preview.resources
    ? `<h4>Resolved resource allocation</h4>${resources(preview.resources)}`
    : "";
  return (
    `<div role="status"><p>${stateText}</p>` +
    `<p>Requested modules: ${moduleNames(preview.requestedModules, dashboard)}</p>` +
    `<p>Included modules: ${moduleNames(preview.includedModules, dashboard)}</p>` +
    `<p>Required dependencies: ${moduleNames(
      preview.includedModules.filter((id) => !preview.requestedModules.includes(id)),
      dashboard,
    )}</p>` +
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
        `${escapeHtml(release.label)} · ${escapeHtml(release.channel)} · ` +
        `${escapeHtml(release.imageDigest)}</option>`,
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
        `${escapeHtml(module.label)} (${escapeHtml(module.version)} · ${escapeHtml(module.artifactDigest)})</option>`,
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
    `<form method="post" action="${action}">` +
    `<input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}">` +
    `<input type="hidden" name="idempotencyKey" value="${escapeHtml(idempotencyKey)}">` +
    `${body}<button type="submit">${label}</button></form>`
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
      ? `<progress max="100" value="${operation.progressPercent}">${operation.progressPercent}%</progress>`
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
    `<article><h3>${escapeHtml(operation.kind)}: ${escapeHtml(operationStateLabel(operation.state))}</h3>` +
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
      ? dashboard.releasePolicy.releaseId
      : (dashboard.desired?.releaseId ?? dashboard.approvedReleases[0]?.releaseId));
  const selectedModules =
    preview?.requestedModules ??
    dashboard.desired?.requestedModules ??
    dashboard.current?.requestedModules ??
    [];
  const resourceProfileId = preview?.resourceProfileId ?? dashboard.desired?.resourceProfileId;
  const canSave = preview?.state !== "unsupported" && preview?.state !== "unavailable";
  const formFields =
    `<input type="hidden" name="action" value="configure">` +
    `<input type="hidden" name="expectedGeneration" value="${dashboard.generation}">` +
    `<label>Release policy <select name="releasePolicy">` +
    `<option value="stable"${policy === "stable" ? " selected" : ""}>Follow stable releases</option>` +
    `<option value="pinned"${policy === "pinned" ? " selected" : ""}>Pin an approved release</option></select></label>` +
    `<label>Approved base release <select name="releaseId">${optionsForReleases(dashboard, releaseId)}</select></label>` +
    `<label>Requested modules <select name="moduleIds" multiple size="${Math.min(Math.max(dashboard.modules.length, 2), 12)}">` +
    `${optionsForModules(dashboard, selectedModules)}</select></label>` +
    `<label>Resource profile <select name="resourceProfileId">${optionsForResources(dashboard, resourceProfileId)}</select></label>`;
  return (
    `<section aria-labelledby="configuration"><h3 id="configuration">Desired configuration</h3>` +
    `<p>The selected modules and resource profile are validated by the application service.</p>` +
    `<form method="post" action="${actionPath}">` +
    `<input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}">` +
    `<input type="hidden" name="idempotencyKey" value="${escapeHtml(createIdempotencyKey())}">` +
    `${formFields}<button type="submit"${canSave ? "" : " disabled"}>Save and build</button></form>` +
    `<form method="post" action="${actionPath}">` +
    `<input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}">` +
    `<input type="hidden" name="action" value="preview">` +
    `${formFields.replace('<input type="hidden" name="action" value="configure">', "")}` +
    `<button type="submit">Preview selection</button></form></section>`
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
  const actionPath = `/repositories/${repositoryId}/actions`;
  const access =
    `<p>GitHub App: ${escapeHtml(installationLabel(dashboard.repository.installation))}</p>` +
    `<p>Repository access: ${escapeHtml(permissionLabel(dashboard.repository.permission))}</p>`;
  const current = artifactSection("Current deployment", dashboard.current, dashboard);
  const desired = artifactSection("Desired deployment", dashboard.desired, dashboard);
  const reason = dashboard.repository.instance.reason
    ? `<p role="status">${escapeHtml(dashboard.repository.instance.reason)}</p>`
    : "";
  const instanceState = dashboard.repository.instance.state;
  const canEnter =
    dashboard.repository.installation === "active" &&
    ["read", "write", "maintain", "admin"].includes(dashboard.repository.permission);
  const entryLabel =
    instanceState === "ready"
      ? "Enter application"
      : instanceState === "failed" || instanceState === "blocked"
        ? "Retry application start"
        : "Start or wait for application";
  const shouldOfferEntry =
    canEnter &&
    (instanceState === "ready" ||
      instanceState === "starting" ||
      instanceState === "stopped" ||
      ((instanceState === "failed" || instanceState === "blocked") &&
        dashboard.repository.instance.retryable));
  const enter = shouldOfferEntry
    ? `<form method="post" action="${actionPath}">` +
      `<input type="hidden" name="csrfToken" value="${escapeHtml(options.csrfToken)}">` +
      `<input type="hidden" name="action" value="enter"><button type="submit">${entryLabel}</button></form>`
    : `<p>Application status: ${escapeHtml(instanceStateLabel(instanceState))}</p>` +
      `<p>Wait for the application to become ready, then refresh status.</p>`;
  const refresh = `<p><a href="/repositories/${repositoryId}">Refresh status</a></p>`;
  const latest =
    options.notice && (options.notice.state === "queued" || options.notice.state === "running")
      ? options.notice
      : dashboard.operations.find(
          (operation) => operation.state === "queued" || operation.state === "running",
        );
  const polling =
    latest && options.scriptNonce ? pollingScript(options.scriptNonce, options.pollCount ?? 0) : "";
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
  const canConfigure = dashboard.canConfigure;
  const canSelectConfiguration =
    dashboard.approvedReleases.length > 0 && dashboard.resourceProfiles.length > 0;
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
        ? `<p>No approved release and resource profile are currently available for a configuration change.</p>`
        : `<p>Configuration changes require current repository maintain or admin access.</p>`;
  const sameImage =
    dashboard.current?.composedImageDigest !== null &&
    dashboard.current?.composedImageDigest === dashboard.desired?.composedImageDigest;
  const redeploy =
    canConfigure && (dashboard.current !== null || dashboard.desired !== null)
      ? mutationForm(
          actionPath,
          options.csrfToken,
          options.createIdempotencyKey(),
          `<input type="hidden" name="action" value="redeploy">` +
            `<input type="hidden" name="expectedGeneration" value="${dashboard.generation}">`,
          "Redeploy current configuration",
        ) +
        `<p>A redeploy creates a new runtime epoch${sameImage ? " even though the image digest is unchanged" : ""}.</p>`
      : "";
  const selectedPreview =
    `<section aria-labelledby="module-preview"><h3 id="module-preview">Module resolution</h3>` +
    `${modulePreview(preview, dashboard)}</section>`;
  const activeOperation = latest !== undefined;
  const automaticStatus =
    activeOperation && polling === ""
      ? `<p role="status">Automatic refresh paused. Use Refresh status to check again.</p>`
      : polling;
  return page(
    dashboard.repository.fullName,
    `<p><a href="/">All repositories</a></p><h1>${escapeHtml(dashboard.repository.fullName)}</h1>` +
      `${access}<p>Instance: ${escapeHtml(instanceStateLabel(dashboard.repository.instance.state))}</p>${reason}` +
      `<section aria-labelledby="entry"><h2 id="entry">Application entry</h2>${enter}${refresh}</section>` +
      `<section aria-labelledby="deployments"><h2 id="deployments">Deployment</h2>` +
      `<p>Release policy: ${dashboard.releasePolicy.kind === "stable" ? "Follow stable" : "Pinned"}</p>` +
      `${current}${desired}</section>${limits(dashboard)}${selectedPreview}` +
      `<section aria-labelledby="operations"><h2 id="operations">Build and operation progress</h2>` +
      `${options.errorMessage ? `<p role="alert">${escapeHtml(options.errorMessage)}</p>` : ""}` +
      `${automaticStatus}${operationContent}</section>${configure}${redeploy}`,
    activeOperation && options.scriptNonce ? { scriptNonce: options.scriptNonce } : {},
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
