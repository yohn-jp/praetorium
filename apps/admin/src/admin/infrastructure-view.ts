import type { InfraDependencies, InfraServices, HostObservation } from "../infrastructure.js";
import { escapeHtml } from "../presentation.js";
import type { ConsoleDependency, ConsoleMode, ConsoleViewModel } from "./view-model.js";

const label: Record<HostObservation["role"], string> = {
  management: "Management",
  runtime: "Runtime",
  builder: "Builder",
};
function tone(state: string): string {
  return state === "healthy" ? "status-good" :
    state === "degraded" || state === "unknown" ? "status-warn" : "status-bad";
}
function metric(value: number | null, denominator: number | null): string {
  return value !== null && denominator !== null && denominator > 0
    ? Math.round(value / denominator * 100) + "%" : "Not collected";
}
function safeTime(timestamp: string): string {
  return '<time datetime="' + escapeHtml(timestamp) + '">' + escapeHtml(timestamp.replace("T", " ").replace("Z", " UTC")) + "</time>";
}
function stateBadge(state: string): string {
  return '<span class="status-badge ' + tone(state) + '">' + escapeHtml(state) + "</span>";
}
function failure<T>(title: string, dependency: ConsoleDependency<T> | null | undefined): string {
  if (dependency?.value) return "";
  return '<section class="infra-unavailable" role="status"><h2>' + escapeHtml(title) +
    ' unavailable</h2><p>Observability is not available. No host is assumed healthy.</p><p>Code: <code>' +
    escapeHtml(dependency?.code ?? "OBSERVER_UNAVAILABLE") + '</code></p></section>';
}
function detailUrl(id: string, mode: ConsoleMode): string {
  return "/infrastructure/hosts/" + encodeURIComponent(id) + "?ui=" + mode;
}
function hostCard(host: HostObservation, mode: ConsoleMode, mobile: boolean): string {
  const state = host.freshness === "fresh" ? host.state : host.freshness;
  return '<article class="infra-host-card" aria-label="' + escapeHtml(label[host.role] + " " + host.id) +
    '"><div class="infra-host-head"><div><span class="infra-role">' + label[host.role] +
    '</span><h3>' + escapeHtml(host.id) + "</h3></div>" + stateBadge(state) + "</div>" +
    '<dl class="infra-host-metrics">' +
    '<div><dt>CPU</dt><dd>' + (host.cpu.usedPercent === null ? (host.freshness === "fresh" && host.reasons.includes("cpu_baseline_pending") ? "Collecting baseline" : "Not collected") : host.cpu.usedPercent.toFixed(1) + "%") + "</dd></div>" +
    '<div><dt>Memory</dt><dd>' + metric(host.memory.usedBytes, host.memory.totalBytes) + "</dd></div>" +
    '<div><dt>Disk</dt><dd>' + metric(host.disk.usedBytes, host.disk.totalBytes) + "</dd></div></dl>" +
    '<p class="infra-seen">' + (host.freshness === "absent" ? "Observation unavailable as of " : "Observed ") + safeTime(host.observedAt) + "</p>" +
    (host.reasons.length ? '<p class="infra-reasons">Conditions: ' +
      host.reasons.map(escapeHtml).join(", ") + "</p>" : "") +
    '<a class="infra-detail-link" href="' + detailUrl(host.id, mode) + '">' +
    (mobile ? "View host details" : "Services and diagnostics") + " →</a></article>";
}
function services(detail: ConsoleDependency<InfraServices> | null | undefined): string {
  if (!detail?.value) return failure("Services", detail);
  if (!detail.value.services.length)
    return '<p class="infra-muted">No service observations configured for this host.</p>';
  return '<ul class="infra-services">' + detail.value.services.map(service =>
    '<li><span><strong>' + escapeHtml(service.id) + '</strong><small>Observed ' +
    safeTime(service.observedAt) + '</small></span>' + stateBadge(service.state) + "</li>").join("") + "</ul>";
}
function dependencies(detail: ConsoleDependency<InfraDependencies> | null | undefined): string {
  if (!detail?.value) return failure("Dependencies", detail);
  return '<div class="infra-dependencies">' + detail.value.targets.map(target =>
    '<article><h2>' + escapeHtml(label[target.role]) + " / " + escapeHtml(target.id) +
    '</h2><ul>' + target.services.map(s => '<li>' + escapeHtml(s.id) + " " +
    stateBadge(s.state) + "</li>").join("") + "</ul></article>").join("") + "</div>";
}
function header(title: string, description: string, mode: ConsoleMode, refreshPath: string): string {
  return '<div class="infra-page-head"><div><p class="infra-kicker">PLATFORM / INFRASTRUCTURE</p><h1>' +
    escapeHtml(title) + "</h1><p>" + escapeHtml(description) + '</p></div><a class="infra-refresh" href="' +
    refreshPath +
    "?ui=" + mode + '">Refresh status</a></div>';
}

export function infrastructureOverview(model: ConsoleViewModel): string {
  const data = model.infrastructure;
  const hosts = data?.value?.hosts ?? [];
  const available = data?.value !== null && data?.value !== undefined;
  const problem = hosts.filter(x => x.state !== "healthy" || x.freshness !== "fresh").length;
  const labelText = !available ? "Status unavailable" : problem ? problem + " need attention" : hosts.length + " observed";
  return '<section class="infra-overview" aria-label="Infrastructure status"><div><span class="infra-kicker">INFRASTRUCTURE</span>' +
    "<h2>Managed hosts</h2><p>" + escapeHtml(labelText) +
    '</p></div><a class="infra-detail-link" href="/infrastructure?ui=' + model.mode +
    '">View Infrastructure →</a></section>';
}

/** Same authenticated snapshots with distinct desktop/tablet and mobile/task layouts. */
export function renderInfrastructure(model: ConsoleViewModel, mobile = false): string {
  if (model.dependenciesSelected) return header("Dependencies", "Private services and health observations", model.mode, "/infrastructure/dependencies") +
    '<p><a href="/infrastructure?ui=' + model.mode + '">← All hosts</a></p>' +
    dependencies(model.dependencies);
  if (model.selectedHostId) {
    const host = model.hostDetail?.value;
    return header("Host diagnostics", "Read-only resource and service observations", model.mode,
      "/infrastructure/hosts/" + encodeURIComponent(model.selectedHostId)) +
      '<p><a href="/infrastructure?ui=' + model.mode + '">← All hosts</a></p>' +
      (host ? hostCard(host, model.mode, mobile) : failure("Host observation", model.hostDetail)) +
      '<section class="infra-services-section"><h2>Services</h2>' + services(model.hostServices) + "</section>";
  }
  const data = model.infrastructure;
  return header("Infrastructure", "Management, Runtime and Builder host observations", model.mode, "/infrastructure") +
    '<p class="infra-muted">Status is a fresh observation, not an inferred service guarantee. Unavailable components remain visible.</p>' +
    (data?.value ?
      '<div class="' + (mobile ? "infra-host-grid infra-mobile" : "infra-host-grid") + '">' +
      data.value.hosts.map(host => hostCard(host, model.mode, mobile)).join("") + "</div>" +
      '<a class="infra-detail-link" href="/infrastructure/dependencies?ui=' +
      model.mode + '">Inspect dependencies →</a>'
      : failure("Infrastructure inventory", data));
}

export const INFRASTRUCTURE_STYLES = `
.infra-page-head{display:flex;justify-content:space-between;gap:18px;align-items:flex-start;margin:12px 0 27px;padding-bottom:21px;border-bottom:1px solid #d6dfd6}
.infra-page-head h1{font-size:clamp(25px,3vw,36px);color:#173d30}
.infra-page-head p{color:#5d7665}
.infra-kicker,.infra-role{font:700 11px/1.5 ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;color:#678574}
.infra-refresh,.infra-detail-link{display:inline-flex;align-items:center;min-height:44px;color:#22563f;font-size:13px;font-weight:650}
.infra-host-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,265px),1fr));gap:15px;margin:18px 0 26px}
.infra-host-card{min-width:0;padding:20px;border:1px solid #d6dfd5;background:#fffefa;border-radius:10px;box-shadow:0 3px 11px #193e2811;overflow-wrap:anywhere}
.infra-host-head{display:flex;justify-content:space-between;gap:12px;align-items:center}
.infra-host-head h3{margin:4px 0;color:#173d30;font-size:16px}
.infra-host-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;padding:16px 0 8px;margin:0}
.infra-host-metrics dt,.infra-seen,.infra-reasons,.infra-muted{color:#63776b;font-size:12px}
.infra-host-metrics dd{margin:3px 0;font-size:15px;font-weight:670;overflow-wrap:anywhere}
.infra-seen{margin:5px 0 0}
.infra-reasons{margin:9px 0 0;overflow-wrap:anywhere}
.infra-unavailable{padding:22px;margin:18px 0;border:1px solid #dbaead;background:#fff8f7;border-radius:8px;color:#7f3028}
.infra-unavailable h2{color:#7f3028;margin:0 0 6px;font-size:16px}
.infra-unavailable p{margin:5px 0}
.infra-services-section{margin:30px 0}
.infra-services{list-style:none;padding:0;margin:10px 0}
.infra-services li{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:13px 0;border-bottom:1px solid #dde5d9}
.infra-services small{display:block;color:#63776b;font-size:11px}
.infra-dependencies{display:grid;gap:17px}
.infra-dependencies article{padding:15px;background:#fff;border:1px solid #d6dfd5;border-radius:8px}
.infra-dependencies h2{font-size:17px}
.infra-dependencies ul{list-style:none;padding:0}
.infra-dependencies li{display:flex;justify-content:space-between;align-items:center;padding:7px 0}
.infra-overview{display:flex;justify-content:space-between;gap:15px;align-items:center;padding:17px 19px;margin:20px 0;border:1px solid #d0dccc;border-radius:8px;background:#f5f8f1}
.infra-overview h2{font-size:17px;margin:3px 0}
.infra-overview p{font-size:12px;margin:0}
body[data-ui="mobile"] .infra-page-head{display:block;padding-top:8px}
body[data-ui="mobile"] .infra-page-head h1{font-size:28px}
body[data-ui="mobile"] .infra-refresh{margin-top:10px}
body[data-ui="mobile"] .infra-host-grid{display:grid;grid-template-columns:minmax(0,1fr)}
body[data-ui="mobile"] .infra-host-card{padding:16px}
body[data-ui="mobile"] .infra-overview{display:block}
body[data-ui="mobile"] .infra-overview a{margin-top:8px}
@media(max-width:480px){.infra-host-metrics{gap:6px}.infra-page-head{display:block}.infra-page-head .infra-refresh{margin-top:8px}}
`;
