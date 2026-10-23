import type { SourceBuildSummary } from "@praetorium/contracts";
import type { SourceReleaseView, SourceRetryIdentityResult } from "./admin/release-sources.js";

export interface AdminPrincipal { readonly actorId: string; readonly csrfToken: string }
export type Redemption =
  | { readonly kind: "ok"; readonly sessionId: string; readonly csrfToken: string; readonly ttlSeconds: number }
  | { readonly kind: "expired" | "limit" | "unavailable" };
export type PreparedSource =
  | { readonly kind: "matched"; readonly sourceId: string; readonly githubReleaseId: number;
      readonly sourceTag: string; readonly sourceRevision: string; readonly releaseVersion: string }
  | { readonly kind: "forbidden" | "conflict" | "unavailable" };

/** Named private Gateway WorkerEntrypoint: no external fetch/URL proxy. */
export interface AdminIdentityRpc {
  redeemAdminHandoff(code: string): Promise<Redemption>;
  verifyAdminSession(sessionId: string): Promise<AdminPrincipal | null>;
  revokeAdminSession(sessionId: string): Promise<boolean>;
  listApprovedSourceReleases(sessionId: string): Promise<readonly SourceReleaseView[] | null>;
  resolvePublishedRelease(sessionId: string, sourceId: string, releaseId: number): Promise<PreparedSource>;
  revalidateRetrySource(sessionId: string, job: SourceBuildSummary): Promise<SourceRetryIdentityResult>;
}

export interface AdminEnv {
  readonly ADMIN_IDENTITY: AdminIdentityRpc;
  readonly CONTROL_PLANE: Fetcher;
  readonly ADMIN_ORIGIN?: string;
  readonly GATEWAY_ORIGIN?: string;
  readonly ADMIN_CONTROL_PLANE_AUTH?: string;
  readonly INFRASTRUCTURE?: Fetcher;
  readonly ADMIN_OBSERVER_AUTH?: string;
}

export interface AdminContext {
  readonly env: AdminEnv;
  readonly config: {
    readonly origin: string;
    readonly adminOrigin: string;
    readonly controlPlaneSecret: string;
  };
}

export function createAdminContext(env: AdminEnv): AdminContext {
  const origin = new URL(env.GATEWAY_ORIGIN ?? "");
  const admin = new URL(env.ADMIN_ORIGIN ?? "");
  if (origin.protocol !== "https:" || admin.protocol !== "https:" ||
      origin.origin === admin.origin || origin.href !== origin.origin + "/" ||
      admin.href !== admin.origin + "/" ||
      !env.ADMIN_IDENTITY || !env.CONTROL_PLANE ||
      !env.ADMIN_CONTROL_PLANE_AUTH ||
      !/^[\x21-\x7e]{32,4096}$/u.test(env.ADMIN_CONTROL_PLANE_AUTH))
    throw new TypeError("Admin bindings, origins or dedicated service credential invalid");
  return {
    env,
    config: {
      origin: origin.origin,
      adminOrigin: admin.origin,
      controlPlaneSecret: env.ADMIN_CONTROL_PLANE_AUTH,
    },
  };
}
