import { applicationHostname, BuilderArtifactStatementSchema } from "@praetorium/contracts";
import type { OperationService } from "@praetorium/application/operations";
import type { OperationRecord, RepositorySnapshot, InstanceService } from "@praetorium/application/instances";
import type { WriterCensus } from "@praetorium/application/lifecycle";
import type { D1Database } from "@praetorium/persistence/d1";
import { Hono } from "hono";
import { z } from "zod";

const Id = z.string().min(1).max(128);
const FenceSchema = z.strictObject({
  workerId: Id,
  leaseToken: z.string().min(32).max(256),
  leaseEpoch: z.number().int().nonnegative().safe(),
  expectedCheckpointSequence: z.number().int().nonnegative().safe(),
  census: z.strictObject({
    complete: z.boolean(),
    providerObservationId: z.string().min(1).max(512),
    observedAt: z.string().datetime(),
    matchedWriterCount: z.number().int().nonnegative().safe(),
    writers: z.array(z.strictObject({
      runtimeEpoch: z.number().int().nonnegative().safe().nullable(),
      phase: z.enum(["running", "terminating"]),
      identities: z.array(z.string().min(1).max(512)).max(256),
    })).max(256),
  }),
});
const GatewayResponseSchema = z.strictObject({
  issuer: z.string().url(),
  jwksUrl: z.string().url(),
  origin: z.string().url(),
  audience: z.string().url(),
  authorizationRevision: z.number().int().nonnegative().safe(),
  grant: z.string().min(16).max(16_384),
  permissions: z.array(z.enum(["read", "write", "maintain", "admin"])).max(4),
});

const MAX_CENSUS_AGE_MS = 30_000;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const ACTOR_ID = /^[1-9][0-9]{0,15}$/u;
const MAX_BODY_BYTES = 32_768;
const LEGACY_MCP_MODULE_ID = "mcp";
const LEGACY_MCP_MODULE_VERSION = "0.1.0";

interface OperationActorRow {
  readonly actor_id: string;
  readonly authorization_revision: number;
}

interface AdmittedHistoryArtifactRow {
  readonly revision_status: string;
  readonly artifact_digest: string | null;
  readonly artifact_status: string;
  readonly platform_manifest_digest: string;
  readonly composition_manifest_digest: string;
  readonly producer_revision: string;
  readonly statement_json: string;
}

export interface HistoryDrainGatewayBinding {
  fetch(request: Request): Promise<Response>;
}

export interface LegacyDrainArtifactAllowlistEntry {
  readonly platformManifestDigest: string;
  readonly producerRevision: string;
  readonly enabledModuleIds: readonly string[];
}

export interface ProvisionerHistoryDrainGrantDependencies {
  readonly db: D1Database;
  readonly operations: Pick<OperationService, "getById">;
  readonly instances: Pick<InstanceService, "getByInstanceId">;
  readonly gateway: HistoryDrainGatewayBinding;
  readonly gatewaySecret: string;
  readonly gatewayOrigin: string;
  readonly workerId: string;
  readonly clusterId: string;
  readonly legacyDrainArtifacts?: readonly LegacyDrainArtifactAllowlistEntry[];
  readonly now?: () => number;
}

/** Mount below the provisioner-authenticated `/internal/provisioner` namespace. */
export function createProvisionerHistoryDrainGrantRoutes(
  dependencies: ProvisionerHistoryDrainGrantDependencies,
): Hono {
  const app = new Hono();
  const now = dependencies.now ?? Date.now;
  const legacyArtifacts = dependencies.legacyDrainArtifacts ?? [];

  app.post("/operations/:operationId/history-drain-grant", async (context) => {
    const parsedBody = await readBoundedJson(context.req.raw);
    const parsed = FenceSchema.safeParse(parsedBody);
    const operationId = context.req.param("operationId");
    if (!parsed.success || !Id.safeParse(operationId).success)
      return context.json({ error: { code: "INVALID_REQUEST" } }, 400);
    const input = parsed.data;
    if (input.workerId !== dependencies.workerId)
      return context.json({ error: { code: "HISTORY_DRAIN_GRANT_FENCED" } }, 409);
    const timestamp = now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0)
      return context.json({ error: { code: "HISTORY_DRAIN_GRANT_UNAVAILABLE" } }, 503);

    const operation = await dependencies.operations.getById(operationId);
    if (!operation || !matchesLease(operation, input, timestamp))
      return context.json({ error: { code: "HISTORY_DRAIN_GRANT_FENCED" } }, 409);
    const snapshot = await dependencies.instances.getByInstanceId(operation.instanceId);
    const actor = await readActor(dependencies.db, operation);
    const tuple = persistedOldAssignment(operation, snapshot, dependencies, legacyArtifacts);
    if (!snapshot || !actor || !tuple ||
      actor.authorization_revision !== snapshot.binding.authorizationRevision ||
      !ACTOR_ID.test(actor.actor_id) || !Number.isSafeInteger(Number(actor.actor_id)) ||
      !matchesSnapshot(operation, snapshot, dependencies))
      return context.json({ error: { code: "HISTORY_DRAIN_GRANT_FENCED" } }, 409);

    if (!(await admittedLegacyArtifactMatches(dependencies.db, operation, tuple)))
      return context.json({ error: { code: "HISTORY_DRAIN_ARTIFACT_REJECTED" } }, 409);

    const census = input.census as WriterCensus;
    if (!freshOldWriterCensus(census, tuple.runtimeEpoch, timestamp))
      return context.json({ error: { code: "HISTORY_DRAIN_CENSUS_REJECTED" } }, 409);

    const eventId = `history-drain-grant:${operation.id}:${census.providerObservationId}`;
    const auditMetadata = JSON.stringify({
      providerObservationId: census.providerObservationId,
      observedAt: census.observedAt,
      matchedWriterCount: census.matchedWriterCount,
      writers: census.writers,
      oldGeneration: tuple.generation,
      oldRuntimeEpoch: tuple.runtimeEpoch,
      currentGeneration: operation.generation,
      currentRuntimeEpoch: operation.runtimeEpoch,
      oldPlatformManifestDigest: tuple.platformManifestDigest,
      evidenceAdmitted: true,
    });
    await dependencies.db.prepare(
      `INSERT OR IGNORE INTO audit_events (
         event_id, repository_id, instance_id, operation_id, actor_id, actor_kind,
         action, outcome, metadata_json, occurred_at
       ) VALUES (?, ?, ?, ?, ?, 'provisioner', 'runtime.history-drain-census-admitted', 'recorded', ?, ?)`,
    ).bind(
      eventId,
      operation.repositoryId,
      operation.instanceId,
      operation.id,
      actor.actor_id,
      auditMetadata,
      timestamp,
    ).run();
    const persistedAudit = await dependencies.db.prepare(
      "SELECT metadata_json FROM audit_events WHERE event_id = ?",
    ).bind(eventId).first<{ metadata_json: string }>();
    if (persistedAudit?.metadata_json !== auditMetadata)
      return context.json({ error: { code: "HISTORY_DRAIN_GRANT_FENCED" } }, 409);

    // The audit write is asynchronous; reload every mutable authority input and
    // apply the fresh clock immediately before the Gateway side effect.
    const beforeGatewayArtifact = await admittedLegacyArtifactMatches(dependencies.db, operation, tuple);
    const beforeGateway = await readCurrentState(dependencies, operation.id);
    if (!beforeGateway || !matchesFenceAndEvidence(
      beforeGateway.operation,
      beforeGateway.snapshot,
      beforeGateway.actor,
      input,
      tuple,
      dependencies,
      now(),
    ) || beforeGateway.actor.actor_id !== actor.actor_id ||
      beforeGateway.actor.authorization_revision !== actor.authorization_revision ||
      !beforeGatewayArtifact)
      return context.json({ error: { code: "HISTORY_DRAIN_GRANT_FENCED" } }, 409);
    const gatewayInput = {
      operationId: operation.id,
      actorId: actor.actor_id,
      repositoryId: operation.repositoryId,
      instanceId: operation.instanceId,
      authorizationRevision: actor.authorization_revision,
      oldGeneration: tuple.generation,
      oldRuntimeEpoch: tuple.runtimeEpoch,
      currentGeneration: operation.generation,
      currentRuntimeEpoch: operation.runtimeEpoch,
    };
    let upstream: Response;
    try {
      upstream = await dependencies.gateway.fetch(new Request(
        "https://gateway.internal/internal/provisioner/history-drain-grant",
        {
          method: "POST",
          headers: {
            "X-Control-Plane-Gateway-Auth": dependencies.gatewaySecret,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(gatewayInput),
          signal: AbortSignal.timeout(5_000),
        },
      ));
    } catch {
      return context.json({ error: { code: "GATEWAY_AUTHORITY_UNAVAILABLE" } }, 503);
    }
    const responseBody = await readBoundedResponse(upstream, 32_768).catch(() => null);
    if (!upstream.ok)
      return context.json({ error: { code: upstream.status === 401 || upstream.status === 403
        ? "AUTHORIZATION_DENIED" : "GATEWAY_AUTHORITY_UNAVAILABLE" } },
      upstream.status === 401 || upstream.status === 403 ? 403 : 503);
    const grant = GatewayResponseSchema.safeParse(responseBody);
    if (!grant.success || !validGatewayGrant(grant.data, dependencies, operation.repositoryId, actor.authorization_revision))
      return context.json({ error: { code: "GATEWAY_RESPONSE_INVALID" } }, 503);

    const responseArtifact = await admittedLegacyArtifactMatches(dependencies.db, operation, tuple);
    const responseState = await readCurrentState(dependencies, operation.id);
    const finalNow = now();
    if (!responseState || !matchesFenceAndEvidence(
      responseState.operation,
      responseState.snapshot,
      responseState.actor,
      input,
      tuple,
      dependencies,
      finalNow,
    ) || responseState.actor.authorization_revision !== grant.data.authorizationRevision ||
      responseState.actor.actor_id !== actor.actor_id || !responseArtifact)
      return context.json({ error: { code: "HISTORY_DRAIN_GRANT_FENCED" } }, 409);

    return context.json(grant.data, 200, {
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    });
  });

  app.onError((error, context) => {
    if (error instanceof RequestTooLargeError)
      return context.json({ error: { code: "REQUEST_TOO_LARGE" } }, 413);
    return context.json({ error: { code: "HISTORY_DRAIN_GRANT_UNAVAILABLE" } }, 503);
  });
  return app;
}

function matchesLease(
  operation: OperationRecord,
  input: z.infer<typeof FenceSchema>,
  now: number,
): boolean {
  return (operation.status === "claimed" || operation.status === "running") &&
    operation.phase === "stopping-old" &&
    operation.workerId === input.workerId &&
    operation.leaseToken === input.leaseToken &&
    operation.leaseEpoch === input.leaseEpoch &&
    operation.leaseExpiresAt !== null && operation.leaseExpiresAt > now &&
    operation.checkpointSequence === input.expectedCheckpointSequence &&
    (operation.kind === "stop" || operation.kind === "update" || operation.kind === "redeploy");
}

function persistedOldAssignment(
  operation: OperationRecord,
  snapshot: RepositorySnapshot | null,
  dependencies: ProvisionerHistoryDrainGrantDependencies,
  allowedArtifacts: readonly LegacyDrainArtifactAllowlistEntry[],
): {
  readonly generation: number;
  readonly runtimeEpoch: number;
  readonly revisionId: string;
  readonly reservationId: string;
  readonly platformManifestDigest: string;
  readonly imageDigest: string;
  readonly compositionManifestDigest: string;
  readonly producerRevision: string;
  readonly enabledModuleIds: readonly string[];
} | null {
  const checkpoint = operation.checkpoint;
  if (!snapshot || !isRecord(checkpoint) || checkpoint["schemaVersion"] !== 1 ||
    !isRecord(checkpoint["lifecycle"])) return null;
  const lifecycle = checkpoint["lifecycle"];
  const current = lifecycle["current"];
  const deployment = isRecord(current) ? current["deployment"] : null;
  const request = lifecycle["quiesceRequest"];
  const receipt = lifecycle["quiesceReceipt"];
  if (!isRecord(current) || !isRecord(deployment) || !isRecord(request) || !isRecord(receipt)) return null;
  const generation = current["generation"];
  const runtimeEpoch = current["runtimeEpoch"];
  const revisionId = deployment["revisionId"];
  const platformManifestDigest = deployment["platformManifestDigest"];
  const imageDigest = deployment["imageDigest"];
  const compositionManifestDigest = deployment["compositionManifestDigest"];
  const enabledModuleIds = deployment["enabledModuleIds"];
  const runtimeMetadata = deployment["runtimeMetadata"];
  const producerRevision = isRecord(runtimeMetadata) ? runtimeMetadata["producerRevision"] : null;
  const reservationId = current["reservationId"];
  const oldEpoch = runtimeEpoch;
  const isStop = operation.kind === "stop";
  const reason = operation.kind;
  if (
    lifecycle["id"] !== operation.id || lifecycle["instanceId"] !== operation.instanceId ||
    lifecycle["repositoryId"] !== operation.repositoryId || lifecycle["generation"] !== operation.generation ||
    lifecycle["runtimeEpoch"] !== operation.runtimeEpoch || lifecycle["clusterId"] !== dependencies.clusterId ||
    lifecycle["kind"] !== operation.kind || lifecycle["phase"] !== "stopping-old" ||
    !Number.isSafeInteger(generation) || typeof generation !== "number" || generation < 1 ||
    !Number.isSafeInteger(runtimeEpoch) || typeof runtimeEpoch !== "number" || runtimeEpoch < 1 ||
    (isStop
      ? runtimeEpoch > operation.runtimeEpoch || generation >= operation.generation
      : runtimeEpoch >= operation.runtimeEpoch) ||
    typeof reservationId !== "string" || reservationId.length === 0 || reservationId.length > 128 ||
    typeof platformManifestDigest !== "string" || !DIGEST.test(platformManifestDigest) ||
    imageDigest !== platformManifestDigest ||
    typeof compositionManifestDigest !== "string" || !DIGEST.test(compositionManifestDigest) ||
    typeof producerRevision !== "string" || !/^[a-f0-9]{40}$/u.test(producerRevision) ||
    !Array.isArray(enabledModuleIds) ||
    !(enabledModuleIds.length === 0 ||
      (enabledModuleIds.length === 1 && enabledModuleIds[0] === LEGACY_MCP_MODULE_ID)) ||
    !allowedArtifacts.some((allowed) =>
      allowed.platformManifestDigest === platformManifestDigest &&
      allowed.producerRevision === producerRevision &&
      allowed.enabledModuleIds.length === enabledModuleIds.length &&
      allowed.enabledModuleIds.every((moduleId, index) => moduleId === enabledModuleIds[index])) ||
    current["instanceId"] !== operation.instanceId || current["repositoryId"] !== operation.repositoryId ||
    current["clusterId"] !== dependencies.clusterId ||
    typeof revisionId !== "string" || revisionId.length === 0 || revisionId.length > 128 ||
    deployment["repositoryId"] !== operation.repositoryId ||
    imageDigest !== snapshot.instance.currentArtifactDigest ||
    revisionId !== snapshot.instance.observedRevisionId ||
    generation !== snapshot.instance.observedGeneration ||
    oldEpoch !== snapshot.instance.observedRuntimeEpoch ||
    request["contractVersion"] !== "scriptorium-platform/v1" ||
    request["operationId"] !== operation.id || request["instanceId"] !== operation.instanceId ||
    request["runtimeEpoch"] !== oldEpoch || request["reason"] !== reason ||
    receipt["contractVersion"] !== "scriptorium-platform/v1" ||
    receipt["operationId"] !== operation.id || receipt["instanceId"] !== operation.instanceId ||
    receipt["runtimeEpoch"] !== oldEpoch || receipt["disposition"] !== "safe" ||
    receipt["activeMutations"] !== 0 || receipt["activeJobs"] !== 0 ||
    receipt["pendingCheckpoints"] !== 0 || receipt["uncertainPublication"] !== false ||
    typeof receipt["quiesceRevision"] !== "string" || receipt["quiesceRevision"].length === 0 ||
    (operation.kind !== "stop" && operation.kind !== "update" && operation.kind !== "redeploy") ||
    (isStop && (lifecycle["target"] !== null || lifecycle["targetEpoch"] !== null ||
      lifecycle["targetReservationId"] !== null)) ||
    lifecycle["writerAbsenceProof"] !== null ||
    (checkpoint["writerAbsenceProof"] !== undefined && checkpoint["writerAbsenceProof"] !== null) ||
    lifecycle["rollbackEpoch"] !== null || lifecycle["rollbackCompatibilityEvidence"] !== null ||
    lifecycle["rollbackCompatible"] === true
  ) return null;
  return {
    generation,
    runtimeEpoch,
    revisionId,
    reservationId,
    platformManifestDigest,
    imageDigest: imageDigest as string,
    compositionManifestDigest: compositionManifestDigest as string,
    producerRevision: producerRevision as string,
    enabledModuleIds: enabledModuleIds as string[],
  };
}

async function admittedLegacyArtifactMatches(
  db: D1Database,
  operation: OperationRecord,
  tuple: NonNullable<ReturnType<typeof persistedOldAssignment>>,
): Promise<boolean> {
  const row = await db.prepare(
    `SELECT r.status AS revision_status, r.artifact_digest,
            a.status AS artifact_status, a.platform_manifest_digest,
            a.composition_manifest_digest, a.producer_revision, a.statement_json
       FROM deployment_revisions r
       JOIN artifacts a ON a.artifact_digest = r.artifact_digest
      WHERE r.revision_id = ? AND r.instance_id = ? AND r.repository_id = ?`,
  ).bind(tuple.revisionId, operation.instanceId, operation.repositoryId).first<AdmittedHistoryArtifactRow>();
  if (!row || row.revision_status !== "admitted" || row.artifact_status !== "admitted" ||
    !row.artifact_digest) return false;
  let statement: z.infer<typeof BuilderArtifactStatementSchema>;
  try {
    statement = BuilderArtifactStatementSchema.parse(JSON.parse(row.statement_json) as unknown);
  } catch {
    return false;
  }
  const modules = statement.resolvedModules;
  return statement.artifact.digest === row.artifact_digest &&
    row.artifact_digest === tuple.imageDigest &&
    statement.artifact.platformManifestDigest === tuple.platformManifestDigest &&
    row.platform_manifest_digest === tuple.platformManifestDigest &&
    statement.compositionManifest.digest === tuple.compositionManifestDigest &&
    row.composition_manifest_digest === tuple.compositionManifestDigest &&
    statement.producerRevision === tuple.producerRevision &&
    row.producer_revision === tuple.producerRevision &&
    tuple.imageDigest === tuple.platformManifestDigest &&
    (tuple.enabledModuleIds.length === 0
      ? modules.length === 0
      : tuple.enabledModuleIds.length === 1 && tuple.enabledModuleIds[0] === LEGACY_MCP_MODULE_ID &&
        modules.length === 1 && modules[0]?.id === LEGACY_MCP_MODULE_ID &&
        modules[0]?.version === LEGACY_MCP_MODULE_VERSION);
}

function matchesSnapshot(
  operation: OperationRecord,
  snapshot: RepositorySnapshot,
  dependencies: ProvisionerHistoryDrainGrantDependencies,
): boolean {
  const desiredState = operation.kind === "stop" ? "stopped" : "running";
  return !snapshot.binding.suspended &&
    snapshot.binding.repositoryId === operation.repositoryId &&
    snapshot.binding.instanceId === operation.instanceId &&
    snapshot.instance.repositoryId === operation.repositoryId &&
    snapshot.instance.instanceId === operation.instanceId &&
    snapshot.binding.authorizationRevision >= 0 &&
    snapshot.instance.desiredState === desiredState &&
    snapshot.instance.generation === operation.generation &&
    snapshot.instance.runtimeEpoch === operation.runtimeEpoch &&
    (operation.kind === "stop" || snapshot.instance.desiredRevisionId === operation.deploymentRevisionId) &&
    snapshot.instance.observedState === "ready" &&
    snapshot.instance.clusterId === dependencies.clusterId &&
    operation.clusterId === dependencies.clusterId;
}

function freshOldWriterCensus(census: WriterCensus, epoch: number, now: number): boolean {
  const observedAt = Date.parse(census.observedAt);
  const writers = census.writers;
  const identities = writers.flatMap((writer) => writer.identities);
  return census.complete && census.matchedWriterCount === 1 && writers.length === 1 &&
    writers[0]?.runtimeEpoch === epoch && writers[0]?.phase === "running" &&
    identities.length === 1 && identities.every((identity) => identity.trim().length > 0) &&
    new Set(identities).size === identities.length &&
    Number.isFinite(observedAt) && observedAt <= now && now - observedAt <= MAX_CENSUS_AGE_MS;
}

async function readActor(db: D1Database, operation: OperationRecord): Promise<OperationActorRow | null> {
  return db.prepare(
    `SELECT actor_id, authorization_revision FROM operations
      WHERE operation_id = ? AND instance_id = ? AND repository_id = ?`,
  ).bind(operation.id, operation.instanceId, operation.repositoryId).first<OperationActorRow>();
}

async function readCurrentState(
  dependencies: ProvisionerHistoryDrainGrantDependencies,
  operationId: string,
): Promise<{ readonly operation: OperationRecord; readonly snapshot: RepositorySnapshot; readonly actor: OperationActorRow } | null> {
  const operation = await dependencies.operations.getById(operationId);
  if (!operation) return null;
  const snapshot = await dependencies.instances.getByInstanceId(operation.instanceId);
  const actor = await readActor(dependencies.db, operation);
  return snapshot && actor ? { operation, snapshot, actor } : null;
}

function matchesFenceAndEvidence(
  operation: OperationRecord,
  snapshot: RepositorySnapshot,
  actor: OperationActorRow,
  input: z.infer<typeof FenceSchema>,
  tuple: NonNullable<ReturnType<typeof persistedOldAssignment>>,
  dependencies: ProvisionerHistoryDrainGrantDependencies,
  now: number,
): boolean {
  return matchesLease(operation, input, now) &&
    samePersistedTuple(operation, snapshot, tuple, dependencies) &&
    actor.authorization_revision === snapshot.binding.authorizationRevision &&
    ACTOR_ID.test(actor.actor_id) && Number.isSafeInteger(Number(actor.actor_id)) &&
    freshOldWriterCensus(input.census as WriterCensus, tuple.runtimeEpoch, now);
}

function samePersistedTuple(
  operation: OperationRecord,
  snapshot: RepositorySnapshot,
  expected: NonNullable<ReturnType<typeof persistedOldAssignment>>,
  dependencies: ProvisionerHistoryDrainGrantDependencies,
): boolean {
  const current = persistedOldAssignment(
    operation,
    snapshot,
    dependencies,
    dependencies.legacyDrainArtifacts ?? [],
  );
  return current !== null && current.generation === expected.generation &&
    current.runtimeEpoch === expected.runtimeEpoch && current.revisionId === expected.revisionId &&
    current.reservationId === expected.reservationId &&
    current.platformManifestDigest === expected.platformManifestDigest &&
    current.imageDigest === expected.imageDigest &&
    current.compositionManifestDigest === expected.compositionManifestDigest &&
    current.producerRevision === expected.producerRevision &&
    current.enabledModuleIds.length === expected.enabledModuleIds.length &&
    current.enabledModuleIds.every((moduleId, index) => moduleId === expected.enabledModuleIds[index]) &&
    matchesSnapshot(operation, snapshot, dependencies);
}

function validGatewayGrant(
  value: z.infer<typeof GatewayResponseSchema>,
  dependencies: ProvisionerHistoryDrainGrantDependencies,
  repositoryId: number,
  authorizationRevision: number,
): boolean {
  let origin: string;
  try {
    origin = `https://${applicationHostname("scriptorium", repositoryId)}`;
  } catch {
    return false;
  }
  const gatewayOrigin = new URL(dependencies.gatewayOrigin).origin;
  return value.issuer === gatewayOrigin &&
    value.jwksUrl === `${gatewayOrigin}/.well-known/jwks.json` &&
    value.origin === origin && value.audience === origin &&
    value.authorizationRevision === authorizationRevision &&
    value.permissions.length === 1 && value.permissions[0] === "read";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBoundedJson(request: Request): Promise<unknown> {
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_BODY_BYTES) throw new RequestTooLargeError();
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_BODY_BYTES) throw new RequestTooLargeError();
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<unknown> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maximumBytes) throw new RequestTooLargeError();
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

class RequestTooLargeError extends Error {}
