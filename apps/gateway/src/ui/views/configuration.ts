import {
  escapeHtml,
  statusBadge,
  resources,
  moduleNames,
  shortDigest,
  type ConfigurationSelection,
} from "../presentation.js";
import type { PortalModulePreview, PortalRepositoryDashboard } from "../types.js";

export function modulePreview(
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
  const missing =
    selectedId && !dashboard.approvedReleases.some((release) => release.releaseId === selectedId)
      ? `<option value="${escapeHtml(selectedId)}" selected>Unavailable selection: ${escapeHtml(selectedId)}</option>`
      : "";
  return (
    missing +
    dashboard.approvedReleases
      .map(
        (release) =>
          `<option value="${escapeHtml(release.releaseId)}"${release.releaseId === selectedId ? " selected" : ""}>` +
          `${escapeHtml(release.label)} · ${escapeHtml(shortDigest(release.imageDigest))}</option>`,
      )
      .join("")
  );
}

function optionsForModules(
  dashboard: PortalRepositoryDashboard,
  selectedModules: readonly string[],
): string {
  const selected = new Set(selectedModules);
  const missing = selectedModules
    .filter((id) => !dashboard.modules.some((module) => module.moduleId === id))
    .map(
      (id, index) =>
        `<label class="module-option" for="configuration-unavailable-module-${index}"><input id="configuration-unavailable-module-${index}" type="checkbox" name="moduleIds" value="${escapeHtml(id)}" checked><span>Unavailable selection: ${escapeHtml(id)}</span></label>`,
    )
    .join("");
  return (
    missing +
      dashboard.modules
        .map(
          (module, index) =>
            `<label class="module-option" for="configuration-module-${index}"><input id="configuration-module-${index}" type="checkbox" name="moduleIds" value="${escapeHtml(module.moduleId)}"${selected.has(module.moduleId) ? " checked" : ""}><span>${escapeHtml(module.label)} <span class="field-help">${escapeHtml(module.version)} · ${escapeHtml(shortDigest(module.artifactDigest))}</span></span></label>`,
        )
        .join("") || `<p class="muted">No optional modules are available.</p>`
  );
}

function optionsForResources(
  dashboard: PortalRepositoryDashboard,
  selectedProfileId: string | undefined,
): string {
  const missing =
    selectedProfileId &&
    !dashboard.resourceProfiles.some((profile) => profile.profileId === selectedProfileId)
      ? `<option value="${escapeHtml(selectedProfileId)}" selected>Unavailable selection: ${escapeHtml(selectedProfileId)}</option>`
      : "";
  return (
    missing +
    dashboard.resourceProfiles
      .map((profile) => {
        const selected = profile.profileId === selectedProfileId ? " selected" : "";
        return `<option value="${escapeHtml(profile.profileId)}"${selected}>${escapeHtml(profile.label)}</option>`;
      })
      .join("")
  );
}

export function configurationForm(
  dashboard: PortalRepositoryDashboard,
  csrfToken: string,
  createIdempotencyKey: () => string,
  actionPath: string,
  preview: PortalModulePreview | null,
  selection?: ConfigurationSelection,
): string {
  const policy = selection?.releasePolicy ?? preview?.releasePolicy ?? dashboard.releasePolicy.kind;
  const releaseId =
    selection?.releaseId ??
    preview?.releaseId ??
    (dashboard.releasePolicy.kind === "pinned"
      ? (dashboard.releasePolicy.releaseId ?? dashboard.approvedReleases[0]?.releaseId)
      : (dashboard.desired?.releaseId ?? dashboard.approvedReleases[0]?.releaseId));
  const selectedModules =
    selection?.moduleIds ??
    preview?.requestedModules ??
    dashboard.desired?.requestedModules ??
    dashboard.current?.requestedModules ??
    [];
  const resourceProfileId =
    selection?.resourceProfileId ??
    preview?.resourceProfileId ??
    dashboard.desired?.resourceProfileId;
  const canSave = preview?.state !== "unsupported" && preview?.state !== "unavailable";
  const formFields = () =>
    `<div class="form-grid">` +
    `<label class="form-field" for="configuration-release-policy"><span>Release policy</span><select id="configuration-release-policy" name="releasePolicy" required>` +
    `<option value="stable"${policy === "stable" ? " selected" : ""}>Follow stable releases</option>` +
    `<option value="pinned"${policy === "pinned" ? " selected" : ""}>Pin an approved release</option></select>` +
    `<span class="field-help">Stable follows the approved stable release; pinned keeps the selected approved release.</span></label>` +
    `<label class="form-field" for="configuration-release-id"><span>Approved base release</span><select id="configuration-release-id" name="releaseId" required>${optionsForReleases(dashboard, releaseId)}</select>` +
    `<span class="field-help">Choose an approved release. Unavailable selections are retained for review.</span></label>` +
    `<fieldset class="module-options" aria-describedby="configuration-module-ids-help"><legend>Requested modules</legend>` +
    `${optionsForModules(dashboard, selectedModules)}` +
    `<span class="field-help" id="configuration-module-ids-help">Select optional modules. Required dependencies are shown separately in the preview.</span></fieldset>` +
    `<label class="form-field" for="configuration-resource-profile"><span>Resource profile</span><select id="configuration-resource-profile" name="resourceProfileId" required>${optionsForResources(dashboard, resourceProfileId)}</select>` +
    `<span class="field-help">The application service checks this profile against current operator limits.</span></label></div>`;
  return (
    `<section class="configuration-panel" aria-labelledby="configuration-heading"><p class="eyebrow">Configuration</p>` +
    `<h2 id="configuration-heading">Desired configuration</h2>` +
    `<p class="muted">Preview your selection before saving. A saved configuration starts a verified build.</p>` +
    `<form data-configuration-form data-dirty="${selection ? "true" : "false"}" method="post" action="${actionPath}#configuration">` +
    `<input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}">` +
    `<input type="hidden" name="idempotencyKey" value="${escapeHtml(createIdempotencyKey())}">` +
    `<input type="hidden" name="expectedGeneration" value="${dashboard.generation}">` +
    `${formFields()}<div class="form-actions">` +
    `<button class="button" type="submit" name="action" value="configure"${canSave ? "" : " disabled"}>Save configuration and build</button>` +
    `<button type="submit" class="button button-secondary" name="action" value="preview">Preview selection</button>` +
    `</div></form></section>`
  );
}
