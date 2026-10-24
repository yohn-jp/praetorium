import { escapeHtml, statusBadge, operationStateLabel } from "../presentation.js";
import type { PortalOperation, PortalRepositoryDashboard } from "../types.js";
const MAX_AUTOMATIC_POLLS = 5;

export function buildStatusLabel(
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

export function buildStatus(build: PortalRepositoryDashboard["build"]): string {
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
    `<details><summary>Build identifiers</summary><p>Build <code>${escapeHtml(build.buildId)}</code></p>` +
    `<p>Build key <code class="digest">${escapeHtml(build.buildKey)}</code></p>` +
    `</details>${stage}${progress}${error}</article>`
  );
}

export function mutationForm(
  action: string,
  csrfToken: string,
  idempotencyKey: string,
  body: string,
  label: string,
): string {
  const impact = label === "Stop application"
    ? "This repository application will become unavailable until started again. Stop waits for quiesce and confirmed checkpoints; an unconfirmed writer cannot be replaced."
    : label === "Retry operation"
      ? "Retry requests a new attempt of this operation. Its result may affect availability. The service checks the current generation and writer safety before proceeding."
      : "Recreate this repository runtime from the desired configuration. Work may be unavailable during replacement. Quiesce, unpublished checkpoints, writer absence and compatibility checks must permit replacement.";
  return (
    `<form class="inline-form mutation-form" method="post" action="${action}">` +
    `<details class="mutation-impact"><summary>Review impact: ${escapeHtml(label)}</summary><p>${impact}</p>` +
    `<label><input type="checkbox" required> I understand the impact on this repository</label>` +
    `<button class="button button-secondary" type="submit">${label}</button></details>` +
    `<input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}">` +
    `<input type="hidden" name="idempotencyKey" value="${escapeHtml(idempotencyKey)}">` +
    `${body}</form>`
  );
}

export function operationView(
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
    `<details><summary>Operation identifier</summary><p>Operation <code>${escapeHtml(operation.operationId)}</code></p></details>${progress}${message}${error}${retry}</article>`
  );
}

export function pollingScript(nonce: string, pollCount: number): string {
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
        `if(u.pathname.endsWith('/actions'))u.pathname=u.pathname.slice(0,-8);` +
        `u.searchParams.set('poll',String(n+1));` +
        `setTimeout(()=>{if(document.visibilityState==='hidden')return;if(document.querySelector('[data-configuration-form]')?.dataset.dirty==='true')return;u.hash=location.hash;location.replace(u.toString());},Math.min(16000,1000*2**n));` +
        `</script>`;
  return `<div data-portal-active-operation="true">${pollMarkup}</div>${script}`;
}
