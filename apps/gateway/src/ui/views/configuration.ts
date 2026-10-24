import {
  escapeHtml,
  statusBadge,
  resources,
  moduleNames,
  shortDigest,
  type ConfigurationSelection,
} from "../presentation.js";
import { applicationHostname } from "@praetorium/contracts";
import type { PortalModulePreview, PortalRepositoryDashboard } from "../types.js";

function moduleMembership(moduleId: string, artifact: PortalRepositoryDashboard["current"]): string {
  if (!artifact) return "Not configured";
  if (!artifact.includedModules.includes(moduleId)) return "Not included";
  return artifact.requestedModules.includes(moduleId)
    ? "Included as a selected module"
    : "Included as a required dependency";
}

function runtimeStateLabel(dashboard: PortalRepositoryDashboard): string {
  switch (dashboard.repository.instance.state) {
    case "ready": return "Ready";
    case "starting": return "Starting";
    case "stopped": return "Stopped";
    case "failed": return "Failed";
    case "blocked": return "Blocked";
    case "unknown": return "Unknown";
  }
}

function moduleActivationStatus(moduleId: string, dashboard: PortalRepositoryDashboard): string {
  return `<span class="field-help module-activation"><strong>Current:</strong> ${escapeHtml(moduleMembership(moduleId, dashboard.current))}` +
    ` · <strong>Desired:</strong> ${escapeHtml(moduleMembership(moduleId, dashboard.desired))}` +
    ` · <strong>Runtime:</strong> ${runtimeStateLabel(dashboard)}</span>`;
}

function mcpConnectionGuide(dashboard: PortalRepositoryDashboard, scriptNonce?: string): string {
  const moduleAvailable = dashboard.modules.some(({ moduleId }) => moduleId === "mcp") ||
    dashboard.current?.includedModules.includes("mcp") === true ||
    dashboard.desired?.includedModules.includes("mcp") === true;
  if (!moduleAvailable) return "";
  const repositoryId = Number(dashboard.repository.repositoryId);
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0 ||
      String(repositoryId) !== dashboard.repository.repositoryId) {
    return `<aside class="mcp-guide" aria-labelledby="mcp-guide-heading"><h3 id="mcp-guide-heading">MCP connection</h3>` +
      `<p role="status">The stable application identity is unavailable, so an endpoint cannot be shown.</p></aside>`;
  }
  let endpoint: string;
  try {
    endpoint = `https://${applicationHostname("scriptorium", repositoryId)}/mcp`;
  } catch {
    return `<aside class="mcp-guide" aria-labelledby="mcp-guide-heading"><h3 id="mcp-guide-heading">MCP connection</h3>` +
      `<p role="status">The stable application identity is unavailable, so an endpoint cannot be shown.</p></aside>`;
  }
  const copyControl = scriptNonce && /^[A-Za-z0-9_-]{16,256}$/u.test(scriptNonce)
    ? `<button type="button" class="button button-secondary" data-copy-mcp-endpoint="${escapeHtml(endpoint)}" aria-describedby="mcp-copy-status">Copy endpoint</button>`
    : "";
  return `<aside class="mcp-guide" aria-labelledby="mcp-guide-heading"><h3 id="mcp-guide-heading">Connect an MCP client</h3>` +
    `<p><strong>Activation:</strong> Current configuration: ${escapeHtml(moduleMembership("mcp", dashboard.current))}. ` +
      `Desired configuration: ${escapeHtml(moduleMembership("mcp", dashboard.desired))}. ` +
      `Application runtime: ${runtimeStateLabel(dashboard)}. This page has not tested an MCP connection.</p>` +
    `<label class="form-field" for="mcp-endpoint"><span>Stable MCP endpoint</span>` +
      `<input id="mcp-endpoint" class="mcp-endpoint" type="url" readonly value="${escapeHtml(endpoint)}" ` +
      `aria-describedby="mcp-endpoint-help"></label>` +
    `<p class="field-help" id="mcp-endpoint-help">Use this HTTPS URL in the MCP client's remote server settings. Copy it manually if the Copy endpoint button is unavailable.</p>` +
    `${copyControl}<p class="field-help" id="mcp-copy-status" role="status" aria-live="polite"></p>` +
    `<details><summary>OAuth and client setup</summary>` +
      `<ol><li>Add the endpoint above as a remote HTTP MCP server and choose automatic OAuth authorization.</li>` +
      `<li>Praetorium supports public-client Authorization Code with PKCE S256 and no client secret. The client signs in through GitHub and asks for explicit repository consent.</li>` +
      `<li>ChatGPT connections use Client ID Metadata Documents (CIMD). Other clients must support the advertised OAuth discovery and public-client flow.</li>` +
      `<li>Grant only the requested access you need. MCP write access can create proposals; author approval is still required to apply changes.</li></ol>` +
    `</details></aside>`;
}

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
    `<p>Preview only: no build or runtime change has been requested. Compare this selection with the current deployment before saving.</p><dl class="preview-facts">` +
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
        `<label class="module-option" for="configuration-unavailable-module-${index}"><input id="configuration-unavailable-module-${index}" type="checkbox" name="moduleIds" value="${escapeHtml(id)}" checked><span class="module-option-copy"><strong>Unavailable selection: ${escapeHtml(id)}</strong>${moduleActivationStatus(id, dashboard)}</span></label>`,
    )
    .join("");
  return (
    missing +
      dashboard.modules
        .map(
          (module, index) => {
            const description = module.description
              ? `<span class="module-description">${escapeHtml(module.description)}</span>`
              : `<span class="field-help">Description is not included in this approved signed catalog.</span>`;
            const requires = module.requires?.length
              ? `<span class="field-help">Requires: ${moduleNames(module.requires, dashboard)}</span>`
              : "";
            const conflicts = module.conflicts?.length
              ? `<span class="field-help">Incompatible with: ${moduleNames(module.conflicts, dashboard)}</span>`
              : "";
            return `<label class="module-option" for="configuration-module-${index}">` +
              `<input id="configuration-module-${index}" type="checkbox" name="moduleIds" value="${escapeHtml(module.moduleId)}"${selected.has(module.moduleId) ? " checked" : ""}>` +
              `<span class="module-option-copy"><strong>${escapeHtml(module.label)}</strong>${description}` +
              `<span class="field-help">${escapeHtml(module.version)} · ${escapeHtml(shortDigest(module.artifactDigest))}</span>` +
              `${requires}${conflicts}${moduleActivationStatus(module.moduleId, dashboard)}</span></label>`;
          },
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
        return `<option value="${escapeHtml(profile.profileId)}"${selected}>${escapeHtml(profile.label)} · ${profile.resources.cpuMilli} mCPU / ${profile.resources.memoryMiB} MiB memory / ${profile.resources.ephemeralStorageMiB} MiB storage</option>`;
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
  scriptNonce?: string,
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
    `<span class="field-help" id="configuration-module-ids-help">The approved producer catalog supplies module names, descriptions, dependencies, and artifact identities. Select optional modules. Required dependencies are shown separately in the preview.</span></fieldset>` +
    `<label class="form-field" for="configuration-resource-profile"><span>Resource profile</span><select id="configuration-resource-profile" name="resourceProfileId" required>${optionsForResources(dashboard, resourceProfileId)}</select>` +
    `<span class="field-help">The application service checks this profile against current operator limits.</span></label></div>`;
  return (
    `<section class="configuration-panel" aria-labelledby="configuration-heading"><p class="eyebrow">Configuration</p>` +
    `<h2 id="configuration-heading">Desired configuration</h2>` +
    `<p class="muted">Preview your selection before saving. A saved configuration starts a verified build.</p>` +
    `<form data-configuration-form data-dirty="${selection ? "true" : "false"}" method="post" action="${actionPath}#configuration">` +
    `<input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}">` +
    `<input type="hidden" name="idempotencyKey" value="${escapeHtml(selection?.idempotencyKey ?? createIdempotencyKey())}">` +
    `<input type="hidden" name="expectedGeneration" value="${dashboard.generation}">` +
    `${formFields()}<p class="field-help" data-configuration-status role="status">Preview selections to review dependencies before saving.</p><p class="field-help">Saving requests a new desired configuration and verified build. The current runtime is separate; replacement may interrupt access and must pass checkpoint and writer safety checks.</p><div class="form-actions">` +
    `<button class="button" type="submit" name="action" value="configure"${canSave ? "" : " disabled"}>Save configuration and build</button>` +
    `<button type="submit" class="button button-secondary" name="action" value="preview">Preview selection</button>` +
    `</div></form>${mcpConnectionGuide(dashboard, scriptNonce)}</section>`
  );
}
