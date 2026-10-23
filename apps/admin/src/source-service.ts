import { SourceBuildSummarySchema, type SourceBuildSummary } from "@praetorium/contracts";
import type { AdminContext } from "./context.js";
import type {
  SourceBuildStatus, SourceReleaseView, SourceRetryIdentityResult,
} from "./admin/release-sources.js";

export type { SourceBuildStatus, SourceReleaseView };

export async function listRegisteredSources(
  context: AdminContext, sessionId: string,
): Promise<readonly SourceReleaseView[]> {
  const sources = await context.env.ADMIN_IDENTITY.listApprovedSourceReleases(sessionId);
  if (sources === null) throw new Error("Admin source authority unavailable");
  return sources;
}

export async function revalidateSourceRetryIdentity(
  context: AdminContext, sessionId: string, job: SourceBuildSummary,
): Promise<SourceRetryIdentityResult> {
  return context.env.ADMIN_IDENTITY.revalidateRetrySource(sessionId, job);
}

export type DispatchReleaseResult =
  | { readonly kind: "queued"; readonly job: SourceBuildStatus; readonly duplicate: boolean }
  | { readonly kind: "forbidden" | "conflict" | "unavailable" };

/** Only the Gateway broker can resolve an authenticated GitHub source identity.
 * Only the canonical Control Plane can enqueue the immutable build. */
export async function dispatchPublishedRelease(
  context: AdminContext, sessionId: string, actorId: string,
  sourceId: string, releaseId: number,
): Promise<DispatchReleaseResult> {
  const resolved = await context.env.ADMIN_IDENTITY.resolvePublishedRelease(
    sessionId, sourceId, releaseId,
  );
  if (resolved.kind !== "matched") return { kind: resolved.kind };
  let response: Response;
  try {
    response = await context.env.CONTROL_PLANE.fetch(
      "https://control-plane.internal/v1/operator/source-builds", {
        method: "POST",
        signal: AbortSignal.timeout(8000),
        headers: {
          "Content-Type": "application/json",
          "X-Control-Plane-Admin-Auth": context.config.controlPlaneSecret,
          "X-Praetorium-Admin-Actor": actorId,
        },
        body: JSON.stringify({
          sourceId: resolved.sourceId,
          githubReleaseId: resolved.githubReleaseId,
          sourceTag: resolved.sourceTag,
          sourceRevision: resolved.sourceRevision,
          releaseVersion: resolved.releaseVersion,
        }),
      },
    );
  } catch { return { kind: "unavailable" }; }
  if (response.status === 409) return { kind: "conflict" };
  if (response.status === 401 || response.status === 403) return { kind: "forbidden" };
  if (response.status !== 200 && response.status !== 202) return { kind: "unavailable" };
  try {
    const body: unknown = await response.json();
    const value = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const parsed = SourceBuildSummarySchema.safeParse(value.job);
    if (!parsed.success || parsed.data.sourceId !== resolved.sourceId ||
        parsed.data.releaseId !== resolved.githubReleaseId ||
        parsed.data.commit !== resolved.sourceRevision) return { kind: "unavailable" };
    return { kind: "queued", job: parsed.data, duplicate: value.duplicate === true };
  } catch { return { kind: "unavailable" }; }
}
