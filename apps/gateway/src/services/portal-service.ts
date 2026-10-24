import { isAdmin } from "../admin/session.js";
import { createHandoffCode } from "@praetorium/auth";
import type { UserId } from "@praetorium/auth";
import { applicationHostname, physicalInstanceId } from "@praetorium/contracts";
import type { InstanceDashboard } from "@praetorium/contracts";
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
import { hasReadyCurrentRuntime, hasReadyDesiredRuntime, runtimeEpochForAccess } from "../active-runtime.js";

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
  if (hasReadyCurrentRuntime(instance)) return { state: "ready", instanceId: instance.instanceId, retryable: false, reason: null };
  if (instance.reservationState === "blocked") return { state: "blocked", instanceId: instance.instanceId, retryable: true, reason: "Runtime capacity is not currently available." };
  if (instance.observedState === "failed") return { state: "failed", instanceId: instance.instanceId, retryable: true, reason: "The runtime reported a failure." };
  if (instance.desiredState === "stopped" && instance.observedState === "stopped") {
    return { state: "stopped", instanceId: instance.instanceId, retryable: true, reason: null };
  }
  return { state: "starting", instanceId: instance.instanceId, retryable: true, reason: null };
}

function summary(
  repository: AccessibleRepository,
  snapshot: RepositorySnapshot | null,
  latestOperation: PortalOperation | null = null,
): PortalRepositorySummary {
  return {
    repositoryId: String(repository.repositoryId),
    fullName: `${repository.owner}/${repository.name}`,
    installation: "active",
    permission: permission(repository.role),
    instance: instanceState(snapshot),
    currentImageDigest: snapshot?.instance.currentArtifactDigest ?? null,
    desiredImageDigest: snapshot?.instance.desiredArtifactDigest ?? null,
    operation: latestOperation,
  };
}

function operation(
  op: NonNullable<InstanceDashboard["operations"][number]>,
  currentGeneration?: number,
): PortalOperation {
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
    retryable: (op.status === "failed" || op.status === "blocked") && op.generation === currentGeneration,
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
    if (status === 400) return { code: "INVALID_REQUEST", message: "The selected release, modules, or resource profile are not supported." };
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

interface AuthorizedManagement {
  readonly repository: AccessibleRepository;
  readonly snapshot: RepositorySnapshot;
  readonly management: InstanceDashboard;
  readonly authorizationRevision: number;
}

async function authorizedManagement(
  context: GatewayContext,
  actor: PortalActor,
  repositoryId: number,
  action: "read" | "maintain",
): Promise<PortalResult<AuthorizedManagement>> {
  try {
    const decision = await authorize(context, actor, repositoryId, action);
    if (!decision) return { ok: false, error: accessError() };
    const listed = await context.githubAccess.listRepositories(actor.userId);
    if (!listed.ok) return failure("UPSTREAM_UNAVAILABLE", "GitHub repository access is temporarily unavailable.", true);
    const repository = listed.value.find((item) => item.repositoryId === repositoryId);
    if (!repository || repository.installationId !== decision.installationId) {
      return { ok: false, error: accessError() };
    }
    const initial = await context.controlPlane.getByRepositoryId(repositoryId);
    if (!initial) return failure("NOT_FOUND", "Repository instance was not found.");
    if (
      initial.binding.installationId !== repository.installationId ||
      initial.binding.owner.toLowerCase() !== repository.owner.toLowerCase() ||
      initial.binding.name.toLowerCase() !== repository.name.toLowerCase()
    ) return { ok: false, error: accessError() };
    const management = await context.controlPlane.getDashboard(initial.instance.instanceId);
    const snapshot = management.snapshot;
    if (
      snapshot.binding.repositoryId !== repositoryId ||
      snapshot.binding.installationId !== repository.installationId ||
      snapshot.binding.owner.toLowerCase() !== repository.owner.toLowerCase() ||
      snapshot.binding.name.toLowerCase() !== repository.name.toLowerCase() ||
      snapshot.instance.instanceId !== initial.instance.instanceId ||
      snapshot.binding.instanceId !== initial.instance.instanceId
    ) return { ok: false, error: accessError() };
    const fresh = await context.githubAccess.checkBoundAccess(
      actor.userId,
      repositoryId,
      snapshot.instance.instanceId,
      runtimeEpochForAccess(snapshot.instance),
      context.requestNow,
    );
    if (fresh.status === "unavailable") {
      return failure("UPSTREAM_UNAVAILABLE", "GitHub repository access is temporarily unavailable.", true);
    }
    const hasRequiredPermission = fresh.status === "allowed" && (
      action === "read"
        ? fresh.permissions.includes("read")
        : fresh.permissions.includes("maintain") || fresh.permissions.includes("admin")
    );
    if (
      !hasRequiredPermission ||
      fresh.repositoryId !== repositoryId ||
      fresh.instanceId !== snapshot.instance.instanceId ||
      fresh.runtimeEpoch !== runtimeEpochForAccess(snapshot.instance) ||
      fresh.installationId !== snapshot.binding.installationId ||
      fresh.authorizationRevision !== snapshot.binding.authorizationRevision ||
      fresh.expiresAt <= Date.parse(context.requestNow)
    ) return { ok: false, error: accessError() };
    return success({
      repository,
      snapshot,
      management,
      authorizationRevision: fresh.authorizationRevision,
    });
  } catch (error) {
    if (error instanceof GitHubAccessUnavailableError) {
      return failure("UPSTREAM_UNAVAILABLE", "GitHub repository access is temporarily unavailable.", true);
    }
    return { ok: false, error: mapControlPlaneError(error) };
  }
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

function dashboard(
  repository: AccessibleRepository,
  snapshot: RepositorySnapshot | null,
  managed: InstanceDashboard | null,
  availableReleases: readonly InstanceDashboard["releases"][number][] = [],
  operatorReleaseUrl?: string,
): PortalRepositoryDashboard {
  const operations = managed?.operations.map((op) => operation(op, snapshot?.instance.generation)) ?? [];
  const repo = summary(repository, snapshot, operations[0] ?? null);
  const instance = snapshot?.instance;
  const releases: readonly InstanceDashboard["releases"][number][] = managed?.releases ?? availableReleases;
  const releaseFor = (releaseId: string) => releases.find((release) => release.releaseId === releaseId);
  const artifact = (revision: InstanceDashboard["current"]): PortalRepositoryDashboard["current"] => {
    if (!revision) return null;
    const release = releaseFor(revision.selection.releaseId);
    return {
      revisionId: revision.revisionId,
      generation: revision.generation,
      releaseId: revision.selection.releaseId,
      releaseLabel: release?.version ?? null,
      baseImageDigest: release?.imageDigest ?? null,
      composedImageDigest: revision.artifactDigest,
      resourceProfileId: revision.selection.resourceProfileId,
      requestedModules: revision.selection.requestedModules,
      includedModules: revision.resolvedModules.map(({ id }) => id),
      resources: revision.resources,
    };
  };
  const current = artifact(managed?.current ?? null);
  const desired = artifact(managed?.desired ?? null);
  const selectedReleaseId = desired?.releaseId ?? current?.releaseId ?? releases[0]?.releaseId;
  const selectedRelease = selectedReleaseId ? releaseFor(selectedReleaseId) : undefined;
  const approvedReleases = releases.map((release) => ({
    releaseId: release.releaseId,
    label: release.version,
    imageDigest: release.imageDigest,
  }));
  const modules = selectedRelease?.catalog.modules.map((module) => ({
    moduleId: module.id,
    requires: module.requires,
    conflicts: module.conflicts,
    label: module.id,
    version: module.version,
    artifactDigest: module.artifactDigest,
  })) ?? [];
  const resourceProfiles = selectedRelease?.catalog.resourceProfiles.map((profile) => ({
    profileId: profile.id,
    label: profile.id,
    resources: {
      cpuMilli: profile.cpuMilli,
      memoryMiB: profile.memoryMiB,
      ephemeralStorageMiB: profile.ephemeralStorageMiB,
    },
  })) ?? [];
  const build = managed?.build
    ? {
        buildId: managed.build.id,
        buildKey: managed.build.buildKey,
        status: managed.build.status,
        stage: managed.build.progress?.stage ?? null,
        progressPercent: managed.build.progress?.percent ?? null,
        errorCode: managed.build.errorCode,
        updatedAt: managed.build.updatedAt,
      }
    : null;
  return {
    repository: repo,
    ...(operatorReleaseUrl ? { operatorReleaseUrl } : {}),
    generation: instance?.generation ?? 0,
    releasePolicy: instance?.policy === "pinned"
      ? { kind: "pinned", releaseId: desired?.releaseId ?? current?.releaseId ?? null }
      : { kind: "stable" },
    current,
    desired,
    preview: null,
    build,
    approvedReleases,
    modules,
    resourceProfiles,
    resourceLimits: {
      cpuMilli: managed?.resourceLimits?.cpuMilli ?? null,
      memoryMiB: managed?.resourceLimits?.memoryMiB ?? null,
      ephemeralStorageMiB: managed?.resourceLimits?.ephemeralStorageMiB ?? null,
    },
    operations,
    canConfigure: !!snapshot && !snapshot.binding.suspended &&
      (repository.role === "maintain" || repository.role === "admin"),
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
      runtimeEpochForAccess(resolved.instance),
      context.requestNow,
    );
    if (
      fresh.status === "unavailable" ||
      fresh.status !== "allowed" ||
      fresh.repositoryId !== repositoryId ||
      fresh.instanceId !== resolved.instance.instanceId ||
      fresh.runtimeEpoch !== runtimeEpochForAccess(resolved.instance) ||
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

    if (resolved.instance.observedState === "failed") return failure("CONFLICT", "The runtime failed. Open the repository dashboard and explicitly retry the failed operation.");
    let ready: RepositorySnapshot = resolved;
    if (!hasReadyCurrentRuntime(resolved.instance)) {
      // A runtime already requested to run may be in its waiting/polling state.
      // Only a new transition from stopped to running spends Wake quota.
      if (resolved.instance.desiredState === "stopped" &&
        !(await context.wakeRateLimiter.consume(`${actor.userId}:${repositoryId}`, context.requestNow))) {
        return failure("RATE_LIMITED", "Repository wake is temporarily rate limited.", true);
      }
      const desired = await context.controlPlane.requestDesiredState(resolved.instance.instanceId, {
        actorId: actor.userId,
        expectedGeneration: resolved.instance.generation,
        desiredState: "running",
        ...(resolved.instance.legacyRuntimeEpoch != null && resolved.instance.runtimeEpoch === resolved.instance.legacyRuntimeEpoch ? { forceNewRuntime: true } : {}),
        idempotencyKey: `wake_${generateToken(128)}`,
        bindingEpoch: resolved.binding.bindingEpoch,
        authorizationRevision: fresh.authorizationRevision,
        requestId: context.requestId,
        now: Date.parse(context.requestNow),
      });
      if (!hasReadyDesiredRuntime(desired.instance)) {
        if (desired.operation) return success({ kind: "operation", operation: operation(desired.operation) });
        return failure("UNAVAILABLE", "The repository instance is starting without an active operation report.", true);
      }
      ready = desired;
    }
    const readyRuntimeEpoch = runtimeEpochForAccess(ready.instance);
    const readyAccess = await context.githubAccess.checkBoundAccess(
      actor.userId,
      repositoryId,
      ready.instance.instanceId,
      readyRuntimeEpoch,
      context.requestNow,
    );
    if (
      readyAccess.status !== "allowed" ||
      readyAccess.repositoryId !== repositoryId ||
      readyAccess.instanceId !== ready.instance.instanceId ||
      readyAccess.runtimeEpoch !== readyRuntimeEpoch ||
      readyAccess.installationId !== ready.binding.installationId ||
      readyAccess.authorizationRevision !== ready.binding.authorizationRevision ||
      readyAccess.expiresAt <= Date.parse(context.requestNow) ||
      !readyAccess.permissions.includes("read")
    ) return { ok: false, error: accessError() };

    const origin = `https://${applicationHostname(ready.binding.appIdentity ?? "scriptorium", repositoryId)}`;
    const created = await createHandoffCode(context.handoffStore, {
      userId: actor.userId as UserId,
      gatewaySessionDigest: sessionDigestOf(actor),
      repositoryId,
      instanceId: physicalInstanceId(ready.instance.instanceId, readyRuntimeEpoch, ready.instance.legacyRuntimeEpoch),
      runtimeEpoch: readyRuntimeEpoch,
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
          githubApp: repositories.length
            ? { installationState: "active", message: "Connected through current GitHub App permissions." }
            : { installationState: "unknown", message: "No accessible repositories returned. Installation status and repository permissions could not be determined from this result. A repository administrator can check the GitHub App installation and repository access." },
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
      const operatorReleaseUrl = isAdmin(context, actor.userId) ? context.config.adminOrigin + "/releases" : undefined;
      try {
        const initial = await context.controlPlane.getByRepositoryId(repositoryId);
        if (!initial) {
          const releases = await context.controlPlane.listReleases();
          return success(dashboard(repository, null, null, releases, operatorReleaseUrl));
        }
        const managed = await context.controlPlane.getDashboard(initial.instance.instanceId);
        const snapshot = managed.snapshot;
        if (
          snapshot.binding.repositoryId !== repositoryId ||
          snapshot.binding.installationId !== repository.installationId ||
          snapshot.binding.owner.toLowerCase() !== repository.owner.toLowerCase() ||
          snapshot.binding.name.toLowerCase() !== repository.name.toLowerCase() ||
          snapshot.instance.instanceId !== initial.instance.instanceId ||
          snapshot.binding.instanceId !== initial.instance.instanceId
        ) return { ok: false, error: accessError() };
        return success(dashboard(repository, snapshot, managed, [], operatorReleaseUrl));
      } catch (error) {
        return { ok: false, error: mapControlPlaneError(error) };
      }
    },

    async execute(actor, rawRepositoryId, command: PortalCommand): Promise<PortalResult<PortalCommandResult>> {
      const repositoryId = numericId(rawRepositoryId);
      if (repositoryId === null) return failure("INVALID_REQUEST", "Repository identifier is invalid.");
      if (command.kind === "enter") return enterRepository(context, actor, repositoryId);
      const authority = await authorizedManagement(
        context,
        actor,
        repositoryId,
        command.kind === "preview" ? "read" : "maintain",
      );
      if (!authority.ok) return authority;
      const { snapshot, authorizationRevision } = authority.value;
      if (command.kind === "preview") {
        try {
          const preview = await context.controlPlane.previewConfiguration(snapshot.instance.instanceId, {
            bindingEpoch: snapshot.binding.bindingEpoch,
            authorizationRevision,
            expectedGeneration: snapshot.instance.generation,
            selection: {
              releaseId: command.releaseId,
              requestedModules: [...command.moduleIds],
              resourceProfileId: command.resourceProfileId,
              policy: command.releasePolicy,
            },
          });
          return success({
            kind: "preview",
            preview: {
              state: "valid",
              releasePolicy: command.releasePolicy,
              releaseId: command.releaseId,
              requestedModules: preview.requestedModules,
              resourceProfileId: command.resourceProfileId,
              includedModules: preview.resolvedModules.map(({ id }) => id),
              unsupportedReasons: [],
              resources: preview.resources,
            },
          });
        } catch (error) {
          return { ok: false, error: mapControlPlaneError(error) };
        }
      }
      if (command.kind === "configure") {
        if (command.expectedGeneration !== snapshot.instance.generation) {
          return failure("CONFLICT", "Repository state changed. Reload and try again.");
        }
        try {
          const result = await context.controlPlane.planConfiguration(snapshot.instance.instanceId, {
            actorId: actor.userId,
            bindingEpoch: snapshot.binding.bindingEpoch,
            authorizationRevision,
            expectedGeneration: command.expectedGeneration,
            selection: {
              releaseId: command.releaseId,
              requestedModules: [...command.moduleIds],
              resourceProfileId: command.resourceProfileId,
              policy: command.releasePolicy,
            },
            idempotencyKey: command.idempotencyKey,
            requestId: context.requestId,
          });
          return success({
            kind: "configuration",
            revisionId: result.revision.revisionId,
            buildId: result.buildId,
          });
        } catch (error) {
          return { ok: false, error: mapControlPlaneError(error) };
        }
      }
      if (command.kind === "stop") {
        if (command.expectedGeneration !== snapshot.instance.generation) {
          return failure("CONFLICT", "Repository state changed. Reload and try again.");
        }
        if (snapshot.instance.observedState !== "ready" || snapshot.instance.currentArtifactDigest === null || snapshot.instance.observedRuntimeEpoch === null) {
          return failure("CONFLICT", "The current runtime is not ready to stop. Refresh status before trying again.");
        }
        try {
          const result = await context.controlPlane.requestDesiredState(snapshot.instance.instanceId, {
            actorId: actor.userId,
            expectedGeneration: command.expectedGeneration,
            desiredState: "stopped",
            idempotencyKey: command.idempotencyKey,
            bindingEpoch: snapshot.binding.bindingEpoch,
            authorizationRevision,
            requestId: context.requestId,
            now: Date.parse(context.requestNow),
          });
          return result.operation
            ? success({ kind: "operation", operation: operation(result.operation) })
            : failure("CONFLICT", "The instance is already stopped. Refresh status to confirm.");
        } catch (error) {
          return { ok: false, error: mapControlPlaneError(error) };
        }
      }
      if (command.kind === "redeploy") {
        if (command.expectedGeneration !== snapshot.instance.generation) {
          return failure("CONFLICT", "Repository state changed. Reload and try again.");
        }
        try {
          const result = await context.controlPlane.requestDesiredState(snapshot.instance.instanceId, {
            actorId: actor.userId,
            expectedGeneration: command.expectedGeneration,
            desiredState: "running",
            idempotencyKey: command.idempotencyKey,
            bindingEpoch: snapshot.binding.bindingEpoch,
            authorizationRevision,
            forceNewRuntime: true,
            requestId: context.requestId,
            now: Date.parse(context.requestNow),
          });
          return result.operation
            ? success({ kind: "operation", operation: operation(result.operation) })
            : failure("UNAVAILABLE", "The redeploy request was accepted without an operation report.", true);
        } catch (error) {
          return { ok: false, error: mapControlPlaneError(error) };
        }
      }
      if (command.kind === "retry") {
        try {
          const oldOperation = authority.value.management.operations.find((op) => op.id === command.operationId) ??
            await context.controlPlane.getOperation(command.operationId);
          if (
            !oldOperation ||
            oldOperation.instanceId !== snapshot.instance.instanceId ||
            (oldOperation.status !== "failed" && oldOperation.status !== "blocked")
          ) return failure("CONFLICT", "Operation state changed. Reload and try again.");
          // On a fresh retry this equals the current generation. Keeping the recorded generation
          // also lets the Control Plane recognize an idempotent receipt after generation advances;
          // it rejects any stale key without a matching receipt.
          const retried = await context.controlPlane.retryOperation(command.operationId, {
            actorId: actor.userId,
            bindingEpoch: snapshot.binding.bindingEpoch,
            authorizationRevision,
            expectedGeneration: oldOperation.generation,
            idempotencyKey: command.idempotencyKey,
            requestId: context.requestId,
          });
          return success({ kind: "operation", operation: operation(retried) });
        } catch (error) {
          return { ok: false, error: mapControlPlaneError(error) };
        }
      }
      return failure("INVALID_REQUEST", "The requested operation is invalid.");
    },
  };
}

function sessionDigestOf(actor: PortalActor): string {
  const digest = (actor as PortalActor & { readonly gatewaySessionDigest?: unknown }).gatewaySessionDigest;
  if (typeof digest !== "string" || digest.length < 32) throw new Error("Authenticated Gateway session is required for handoff");
  return digest;
}
