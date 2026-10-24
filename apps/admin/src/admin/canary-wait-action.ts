import { generateToken } from "@praetorium/auth";
import { escapeHtml } from "../presentation.js";
import type { ConsoleMode, ConsoleReleaseStatus } from "./view-model.js";

export function canaryWaitSkipForm(status: ConsoleReleaseStatus, csrf: string, mode: ConsoleMode): string {
  if (status.workflow.state !== "canary_observing" || status.workflow.failureCode !== null) return "";
  const prefix = mode === "desktop" ? "desktop" : "admin-mobile";
  return `<form method="post" action="/releases/${encodeURIComponent(status.release.id)}/skip-canary-wait?ui=${mode}" class="${prefix}-retry-form">` +
    `<input type="hidden" name="csrfToken" value="${escapeHtml(csrf)}">` +
    `<input type="hidden" name="expectedRevision" value="${status.workflow.revision}">` +
    `<input type="hidden" name="idempotencyKey" value="${escapeHtml(generateToken(128))}">` +
    `<label>Reason for skipping the wait <input name="reason" required maxlength="200" autocomplete="off"></label>` +
    `<p>Ends the observation wait using fresh successful checks. Safe stop and writer-absence verification still run. The operator and reason are recorded.</p>` +
    `<button type="submit" class="${mode === "desktop" ? "desktop-button" : "button"}">Skip Canary wait</button></form>`;
}
