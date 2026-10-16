import { createHandoffCode } from "@praetorium/auth";
import type { UserId } from "@praetorium/auth";
import { instanceHostname } from "@praetorium/contracts";
import type { AccessDecision } from "@praetorium/contracts";
import type { AccessibleRepository } from "@praetorium/github";
import { GitHubAccessUnavailableError } from "@praetorium/github";
import { generateToken } from "@praetorium/auth";
import type { GatewayContext } from "../context.js";
import type {
  PortalActor,
  PortalCommand,
  PortalCommandResult,
  PortalOperation,
  PortalPermission,
  PortalRepositoryDashboard,
  PortalRepositoryList,
  PortalRepositorySummary,
  PortalResult,
  PortalService,
} from "../ui/index.js";
import type { RepositorySnapshot } from "../adapters/control-plane-client.js";

type ServiceError = Extract<PortalResult<never>, { readonly ok: false }>["error"];

function failure<T>(code: ServiceError["code"], message: string, retryable = false): PortalResult<T> {
  return { ok: false, error: { code, message, retryable } };
}

function success<T>(value: T): PortalResult<T> {
  return { ok: true, value };
}

function numericId(value: string): number | null {
  if (!/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function permission(role: AccessibleRepository["role"]): PortalPermission {
  return role;
}

function instanceState(snapshot: RepositorySnapshot | null): PortalRepositorySummary["instance"] {
  if (!snapshot) return { state: "unknown", instanceId: null, retryable: true, reason: "No repository binding exists yet." };
  const instance = snapshot.instance;
  if (instance.reservationState === "blocked") return { state: "blocked", instanceId: instance.instanceId, retryable: true, reason: "Runtime capacity is not currently available." };
  if (instance.observedState === "failed") return { state: "failed", instanceId: instance.instanceId, retryable: true, reason: "The runtime reported a failure." };
  if (
    instance.observedState === "ready" &&
    instance.observedGeneration === instance.generation &&
    instance.observedRuntimeEpoch === instance.runtimeEpoch
  ) return { state: "ready", instanceId: instance.instanceId, retryable: false, reason: null };
  if (instance.desiredState === "stopped" && instance.observedState === "stopped") {
    return { state: "stopped", instanceId: instance.instanceId, retryable: true, reason: null };
  }
  return { state: "starting", instanceId: instance.instanceId, retryable: true, reason: null };
}

function summary(
  repository: AccessibleRepository,
  snapshot: RepositorySnapshot | null,
): PortalRepositorySummary {
  return {
    repositoryId: String(repository.repositoryId),
    fullName: `${repository.owner}/${repository.name}`,
    installation: "active",
    permission: permission(repository.role),
    instance: instanceState(snapshot),
    currentImageDigest: snapshot?.instance.currentArtifactDigest ?? null,
    desiredImageDigest: snapshot?.instance.desiredArtifactDigest ?? null,
    operation: null,
  };
}

function operation(op: NonNullable<Awaited<ReturnType<GatewayContext["controlPlane"]["requestDesiredState"]>>["operation"]>): PortalOperation {
  const state = op.status === "pending" ? "queued"
    : op.status === "claimed" || op.status === "running" ? "running"
      : op.status === "succeeded" ? "succeeded"
        : op.status === "failed" ? "failed"
          : "blocked";
  return {
    operationId: op.id,
    kind: op.kind,
    state,
    progressPercent: null,
    message: op.phase || null,
    error: null,
    retryable: state === "failed" || state === "blocked",
  };
}

function accessError(): ServiceError {
  return { code: "FORBIDDEN", message: "Current GitHub repository access is required." };
}

function mapControlPlaneError(error: unknown): ServiceError {
  if (error && typeof error === "object" && "status" in error && typeof error.status === "number") {
    const status = error.status;
    const code = "code" in error && typeof error.code === "string" ? error.code : "UPSTREAM_UNAVAILABLE";
    if (status === 404) return { code: "NOT_FOUND", message: "Repository instance was not found." };
    if (status === 409) return { code: "CONFLICT", message: "Repository state changed. Reload and try again." };
    if (status === 401 || status === 403) return { code: "UNAUTHORIZED", message: "Gateway authority was rejected." };
    return { code: "UPSTREAM_UNAVAILABLE", message: `Control Plane is temporarily unavailable (${code}).`, retryable: true };
  }
  return { code: "UPSTREAM_UNAVAILABLE", message: "Repository authority is temporarily unavailable.", retryable: true };
}

async function accessibleRepository(
  context: GatewayContext,
  userId: string,
  repositoryId: number,
): Promise<AccessibleRepository | null> {
  const result = await context.githubAccess.listRepositories(userId);
  if (!result.ok) return null;
  return result.value.find((repository) => repository.repositoryId === repositoryId) ?? null;
}

async function authorize(
  context: GatewayContext,
  actor: PortalActor,
  repositoryId: number,
  action: "read" | "write" | "maintain",
): Promise<AccessDecision | null> {
  const decision = await context.githubAccess.authorize(actor.userId, repositoryId, action);
  if (!decision.allowed || decision.repositoryId !== repositoryId || decision.expiresAt <= Date.parse(context.requestNow)) return null;
  return decision;
}

function dashboard(repository: AccessibleRepository, snapshot: RepositorySnapshot | null): PortalRepositoryDashboard {
  const repo = summary(repository, snapshot);
  const instance = snapshot?.instance;
  return {
    repository: repo,
    generation: instance?.generation ?? 0,
    releasePolicy: instance?.policy === "pinned"
      ? { kind: "pinned", releaseId: "" }
      : { kind: "stable" },
    current: null,
    desired: null,
    preview: null,
    approvedReleases: [],
    modules: [],
    resourceProfiles: [],
    resourceLimits: { cpuMilli: null, memoryMiB: null, ephemeralStorageMiB: null, capacityState: "unknown" },
    operations: [],
    canConfigure: false,
  };
}

async function enterRepository(
  context: GatewayContext,
  actor: PortalActor,
  repositoryId: number,
): Promise<PortalResult<PortalCommandResult>> {
  let listed;
  try {
    listed = await context.githubAccess.listRepositories(actor.userId);
  } catch {
    return failure("UPSTREAM_UNAVAILABLE", "GitHub repository access is temporarily unavailable.", true);
  }
  if (!listed.ok) return failure("UPSTREAM_UNAVAILABLE", "GitHub repository access is temporarily unavailable.", true);
  const repository = listed.value.find((item) => item.repositoryId === repositoryId);
  if (!repository) return { ok: false, error: accessError() };

  try {
    if (!(await context.wakeRateLimiter.consume(`${actor.userId}:${repositoryId}`, context.requestNow))) {
      return failure("RATE_LIMITED", "Repository entry is temporarily rate limited.", true);
    }
    const existing = await context.controlPlane.getByRepositoryId(repositoryId);
    if (existing) {
      const decision = await authorize(context, actor, repositoryId, "read");
      if (!decision) return { ok: false, error: accessError() };
      if (
        decision.installationId !== existing.binding.installationId ||
        existing.binding.owner.toLowerCase() !== repository.owner.toLowerCase() ||
        existing.binding.name.toLowerCase() !== repository.name.toLowerCase()
      ) return { ok: false, error: accessError() };
    }
    const resolved = await context.controlPlane.resolveRepository({
      repositoryId,
      installationId: repository.installationId,
      owner: repository.owner,
      name: repository.name,
      authorizationRevision: existing?.binding.authorizationRevision ?? 0,
      ...(existing ? { bindingEpoch: existing.binding.bindingEpoch } : {}),
      actorId: actor.userId,
      idempotencyKey: `entry_${generateToken(128)}`,
      requestId: context.requestId,
      now: Date.parse(context.requestNow),
    });
    const fresh = await context.githubAccess.checkBoundAccess(
      actor.userId,
      repositoryId,
      resolved.instance.instanceId,
      resolved.instance.runtimeEpoch,
      context.requestNow,
    );
    if (
      fresh.status === "unavailable" ||
      fresh.status !== "allowed" ||
      fresh.repositoryId !== repositoryId ||
      fresh.instanceId !== resolved.instance.instanceId ||
      fresh.runtimeEpoch !== resolved.instance.runtimeEpoch ||
      fresh.authorizationRevision !== resolved.binding.authorizationRevision ||
      fresh.installationId !== resolved.binding.installationId ||
      fresh.expiresAt <= Date.parse(context.requestNow) ||
      !fresh.permissions.includes("read")
    ) return { ok: false, error: fresh.status === "unavailable"
      ? { code: "UPSTREAM_UNAVAILABLE", message: "Repository authority is temporarily unavailable.", retryable: true }
      : accessError() };

    if (!resolved.instance.desiredArtifactDigest) {
      return failure(
        "UNAVAILABLE",
        "Configuration is required before this repository instance can start. Open the repository dashboard to review the available setup.",
      );
    }

    const desired = await context.controlPlane.requestDesiredState(resolved.instance.instanceId, {
      actorId: actor.userId,
      expectedGeneration: resolved.instance.generation,
      desiredState: "running",
      idempotencyKey: `wake_${generateToken(128)}`,
      bindingEpoch: resolved.binding.bindingEpoch,
      authorizationRevision: fresh.authorizationRevision,
      requestId: context.requestId,
      now: Date.parse(context.requestNow),
    });
    if (
      desired.instance.observedState !== "ready" ||
      desired.instance.observedGeneration !== desired.instance.generation ||
      desired.instance.observedRuntimeEpoch !== desired.instance.runtimeEpoch
    ) {
      if (desired.operation) return success({ kind: "operation", operation: operation(desired.operation) });
      return failure("UNAVAILABLE", "The repository instance is starting without an active operation report.", true);
    }
    const readyAccess = await context.githubAccess.checkBoundAccess(
      actor.userId,
      repositoryId,
      desired.instance.instanceId,
      desired.instance.runtimeEpoch,
      context.requestNow,
    );
    if (
      readyAccess.status !== "allowed" ||
      readyAccess.repositoryId !== repositoryId ||
      readyAccess.instanceId !== desired.instance.instanceId ||
      readyAccess.runtimeEpoch !== desired.instance.runtimeEpoch ||
      readyAccess.installationId !== desired.binding.installationId ||
      readyAccess.authorizationRevision !== desired.binding.authorizationRevision ||
      readyAccess.expiresAt <= Date.parse(context.requestNow) ||
      !readyAccess.permissions.includes("read")
    ) return { ok: false, error: accessError() };

    const origin = `https://${instanceHostname(desired.instance.instanceId, context.config.instanceHostnameSuffix)}`;
    const created = await createHandoffCode(context.handoffStore, {
      userId: actor.userId as UserId,
      gatewaySessionDigest: sessionDigestOf(actor),
      repositoryId,
      instanceId: desired.instance.instanceId,
      runtimeEpoch: desired.instance.runtimeEpoch,
      hostname: new URL(origin).hostname,
      origin,
      audience: "instance-access",
      returnPath: "/",
      requestedPermissions: readyAccess.permissions,
      now: context.requestNow,
      ttlSeconds: Math.min(60, context.config.handoffTtlSeconds),
      pepper: context.config.handoffPepper,
    });
    return success({ kind: "handoff", handoff: { origin, code: created.rawCode, returnPath: "/" } });
  } catch (error) {
    if (error instanceof GitHubAccessUnavailableError) {
      return failure("UPSTREAM_UNAVAILABLE", "GitHub repository access is temporarily unavailable.", true);
    }
    return { ok: false, error: mapControlPlaneError(error) };
  }
}

export function createPortalService(context: GatewayContext): PortalService {
  return {
    async listRepositories(actor): Promise<PortalResult<PortalRepositoryList>> {
      const listed = await context.githubAccess.listRepositories(actor.userId);
      if (!listed.ok) return failure("UPSTREAM_UNAVAILABLE", "GitHub repository access is temporarily unavailable.", true);
      try {
        const repositories = await Promise.all(listed.value.map(async (repository) => {
          const snapshot = await context.controlPlane.getByRepositoryId(repository.repositoryId);
          return summary(repository, snapshot);
        }));
        return success({
          repositories,
          githubApp: { installationState: "active", message: "Connected through current GitHub App permissions." },
        });
      } catch (error) {
        return { ok: false, error: mapControlPlaneError(error) };
      }
    },

    async getRepository(actor, rawRepositoryId): Promise<PortalResult<PortalRepositoryDashboard>> {
      const repositoryId = numericId(rawRepositoryId);
      if (repositoryId === null) return failure("INVALID_REQUEST", "Repository identifier is invalid.");
      const allowed = await authorize(context, actor, repositoryId, "read");
      if (!allowed) return { ok: false, error: accessError() };
      const repository = await accessibleRepository(context, actor.userId, repositoryId);
      if (!repository || repository.installationId !== allowed.installationId) return { ok: false, error: accessError() };
      try {
        const snapshot = await context.controlPlane.getByRepositoryId(repositoryId);
        return success(dashboard(repository, snapshot));
      } catch (error) {
        return { ok: false, error: mapControlPlaneError(error) };
      }
    },

    async execute(actor, rawRepositoryId, command: PortalCommand): Promise<PortalResult<PortalCommandResult>> {
      const repositoryId = numericId(rawRepositoryId);
      if (repositoryId === null) return failure("INVALID_REQUEST", "Repository identifier is invalid.");
      if (command.kind === "enter") return enterRepository(context, actor, repositoryId);
      let decision: AccessDecision | null;
      try {
        decision = await authorize(context, actor, repositoryId, command.kind === "preview" ? "read" : "maintain");
      } catch (error) {
        if (error instanceof GitHubAccessUnavailableError) {
          return failure("UPSTREAM_UNAVAILABLE", "GitHub repository access is temporarily unavailable.", true);
        }
        return failure("UPSTREAM_UNAVAILABLE", "Repository authority is temporarily unavailable.", true);
      }
      if (!decision) return { ok: false, error: accessError() };
      if (command.kind === "preview") {
        return failure("UNAVAILABLE", "No approved producer catalog is available for preview.", true);
      }
      return failure("UNAVAILABLE", "This Gateway has no configured build or release service.", true);
    },
  };
}

function sessionDigestOf(actor: PortalActor): string {
  const digest = (actor as PortalActor & { readonly gatewaySessionDigest?: unknown }).gatewaySessionDigest;
  if (typeof digest !== "string" || digest.length < 32) throw new Error("Authenticated Gateway session is required for handoff");
  return digest;
}
