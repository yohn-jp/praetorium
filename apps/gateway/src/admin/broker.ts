import { WorkerEntrypoint } from "cloudflare:workers";
import { revokeSession } from "@praetorium/auth";
import { SourceBuildSummarySchema, type SourceBuildSummary } from "@praetorium/contracts";
import { createGitHubRestClient, GitHubApiError } from "@praetorium/github";
import { createGatewayContext, type GatewayContext } from "../context.js";
import type { GatewayEnv } from "../env.js";
import { authenticateAdmin, redeemAdminHandoffCode } from "./session.js";
import { SESSION_COOKIE_NAME } from "../http/session.js";
import {
  configuredReleaseSources, fetchSelectedRelease, listRegisteredSources,
  revalidateSourceRetryIdentity, type SourceReleaseView,
  type SourceRetryIdentityResult,
} from "./release-sources.js";

export interface BrokerPrincipal {
  readonly actorId: string;
  readonly csrfToken: string;
}

export type BrokerRedemption =
  | { readonly kind: "ok"; readonly sessionId: string; readonly csrfToken: string; readonly ttlSeconds: number; readonly returnTo?: string }
  | { readonly kind: "expired" | "limit" | "unavailable" };

export type PreparedSource =
  | { readonly kind: "matched"; readonly sourceId: string; readonly githubReleaseId: number;
      readonly sourceTag: string; readonly sourceRevision: string; readonly releaseVersion: string }
  | { readonly kind: "forbidden" | "conflict" | "unavailable" };

/**
 * Narrow, non-fetchable RPC interface. Admin is a separate Worker; the Gateway
 * retains the only OAuth, DO session and GitHub user token authorities.
 *
 * Binding this entrypoint grants no unauthenticated operator access: every
 * method validates the current opaque Admin session and current allowlist.
 */
export class AdminIdentityBroker extends WorkerEntrypoint<GatewayEnv> {
  private async context(): Promise<GatewayContext> {
    return createGatewayContext(this.env, crypto.randomUUID(), new Date().toISOString());
  }

  private async principal(context: GatewayContext, sessionId: string) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(sessionId) || !context.config.adminOrigin) return null;
    const request = new Request(context.config.adminOrigin + "/", {
      headers: { Cookie: SESSION_COOKIE_NAME + "=" + sessionId },
    });
    return authenticateAdmin(request, context);
  }

  async redeemAdminHandoff(code: string): Promise<BrokerRedemption> {
    if (typeof code !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(code))
      return { kind: "expired" };
    try {
      const result = await redeemAdminHandoffCode(code, await this.context());
      return result.kind === "ok"
        ? { kind: "ok", sessionId: result.rawSessionId,
            csrfToken: result.csrfToken, ttlSeconds: result.ttlSeconds,
            ...(result.returnTo ? { returnTo: result.returnTo } : {}) }
        : { kind: result.kind };
    } catch {
      return { kind: "unavailable" };
    }
  }

  async verifyAdminSession(sessionId: string): Promise<BrokerPrincipal | null> {
    const context = await this.context();
    const session = await this.principal(context, sessionId);
    return session
      ? { actorId: session.actor.userId, csrfToken: session.csrfToken }
      : null;
  }

  async revokeAdminSession(sessionId: string): Promise<boolean> {
    const context = await this.context();
    const session = await this.principal(context, sessionId);
    if (!session) return false;
    await revokeSession(context.sessionStore, session.resolved.digest, context.requestNow);
    return true;
  }

  async listApprovedSourceReleases(sessionId: string): Promise<readonly SourceReleaseView[] | null> {
    const context = await this.context();
    const session = await this.principal(context, sessionId);
    if (!session) return null;
    return listRegisteredSources(context, session.actor.userId);
  }

  async resolvePublishedRelease(
    sessionId: string, sourceId: string, releaseId: number,
  ): Promise<PreparedSource> {
    if (typeof sourceId !== "string" || !/^[a-z][a-z0-9-]{0,31}$/u.test(sourceId) ||
        !Number.isSafeInteger(releaseId) || releaseId <= 0) return { kind: "conflict" };
    const context = await this.context();
    const session = await this.principal(context, sessionId);
    if (!session) return { kind: "forbidden" };
    const source = configuredReleaseSources(context.env.PRAETORIUM_RELEASE_SOURCES_JSON)
      .find(value => value.id === sourceId);
    if (!source) return { kind: "forbidden" };
    const token = await context.githubUserTokens.accessTokenFor(session.actor.userId, context.requestNow);
    if (!token) return { kind: "forbidden" };
    try {
      const selected = await fetchSelectedRelease(
        source, releaseId, createGitHubRestClient({ requestTimeoutMs: 8000 }), token,
      );
      return { kind: "matched", sourceId: source.id, githubReleaseId: selected.release.id,
        sourceTag: selected.release.tag, sourceRevision: selected.commit,
        releaseVersion: selected.release.version! };
    } catch (error) {
      return { kind: error instanceof GitHubApiError && (error.status === 401 || error.status === 403)
        ? "forbidden" : "unavailable" };
    }
  }

  async revalidateRetrySource(
    sessionId: string, raw: SourceBuildSummary,
  ): Promise<SourceRetryIdentityResult> {
    const job = SourceBuildSummarySchema.safeParse(raw);
    if (!job.success) return { kind: "conflict" };
    const context = await this.context();
    const session = await this.principal(context, sessionId);
    if (!session) return { kind: "forbidden" };
    return revalidateSourceRetryIdentity(context, session.actor.userId, job.data);
  }
}
