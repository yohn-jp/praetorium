import { BuilderArtifactStatementSchema, instanceHostname } from "@praetorium/contracts";
import type { OperationService } from "@praetorium/application/operations";
import type { OperationRecord } from "@praetorium/application/instances";
import type { InstanceService } from "@praetorium/application/instances";
import type { D1Database } from "@praetorium/persistence/d1";
import { Hono } from "hono";
import { z } from "zod";

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const REMOTE_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const ROLLBACK_EVIDENCE_MAX_AGE_MS = 10 * 60 * 1_000;
const RuntimePolicySchema = z.strictObject({
  issuer: z.string().url(),
  jwksUrl: z.string().url(),
  audience: z.string().url().or(z.literal("praetorium-runtime-control")),
});
const PolicyAssignmentSchema = z.strictObject({
  instanceId: z.string().min(1).max(128),
  repositoryId: z.number().int().positive().safe(),
  generation: z.number().int().positive().safe(),
  runtimeEpoch: z.number().int().positive().safe(),
  clusterId: z.string().min(1).max(128),
  revisionId: z.string().min(1).max(128),
  imageDigest: z.string().regex(DIGEST),
  platformManifestDigest: z.string().regex(DIGEST),
  compositionManifestDigest: z.string().regex(DIGEST),
  enabledModuleIds: z.array(z.string().min(1).max(64)).max(256),
  grantPolicy: RuntimePolicySchema,
  controlServicePolicy: RuntimePolicySchema,
});
const ProbeRequestSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("lease"),
    workerId: z.string().min(1).max(128),
    leaseToken: z.string().min(32).max(256),
    leaseEpoch: z.number().int().nonnegative().safe(),
    assignment: PolicyAssignmentSchema,
  }),
  z.strictObject({
    mode: z.literal("observed"),
    assignment: PolicyAssignmentSchema,
  }),
]);

const GrantResponseSchema = z.strictObject({
  issuer: z.string().url(),
  jwksUrl: z.string().url(),
  origin: z.string().url(),
  audience: z.string().url(),
  authorizationRevision: z.number().int().nonnegative().safe(),
  validGrant: z.string().min(16).max(16_384),
  wrongRepositoryGrant: z.string().min(16).max(16_384),
  wrongEpochGrant: z.string().min(16).max(16_384),
  permissions: z.array(z.enum(["read", "write", "maintain", "admin"])).min(1).max(4),
});

interface OperationActorRow {
  readonly actor_id: string;
  readonly authorization_revision: number;
}

interface UserAuditActorRow {
  readonly actor_id: string;
}

interface AdmittedArtifactRow {
  readonly status: string;
  readonly artifact_digest: string | null;
  readonly statement_json: string | null;
}

export interface RuntimeAuthProbeGatewayBinding {
  fetch(request: Request): Promise<Response>;
}

export interface RuntimeAuthProbeRouteDependencies {
  readonly db: D1Database;
  readonly operations: Pick<OperationService, "getById">;
  readonly instances: Pick<InstanceService, "getByInstanceId">;
  readonly gateway: RuntimeAuthProbeGatewayBinding;
  readonly gatewaySecret: string;
  readonly gatewayOrigin: string;
  readonly controlPlaneOrigin: string;
  readonly instanceHostSuffix: string;
  readonly workerId: string;
  readonly clusterId: string;
  readonly now?: () => number;
}

/**
 * Mount under `/internal/provisioner`. The Control Plane reads actor identity
 * from the operation row, fences lifecycle probes by the live lease, and allows
 * repeated read-only probes only for a successful operation serving the exact
 * same admitted revision in the configured cluster.
 */
export function createProvisionerRuntimeAuthProbeRoutes(
  dependencies: RuntimeAuthProbeRouteDependencies,
): Hono {
  if (dependencies.gatewaySecret.length < 32 || /[^\x21-\x7e]/u.test(dependencies.gatewaySecret)) {
    throw new TypeError("Gateway service authentication secret is invalid");
  }
  const gatewayOrigin = httpsOrigin(dependencies.gatewayOrigin);
  const controlPlaneOrigin = httpsOrigin(dependencies.controlPlaneOrigin);
  if (gatewayOrigin !== dependencies.gatewayOrigin || controlPlaneOrigin !== dependencies.controlPlaneOrigin) {
    throw new TypeError("Runtime auth probe issuer origins must be canonical HTTPS origins");
  }
  const app = new Hono();
  const now = dependencies.now ?? Date.now;

  app.post("/operations/:operationId/auth-probe", async (c) => {
    let input: z.infer<typeof ProbeRequestSchema>;
    try {
      input = ProbeRequestSchema.parse(await readBoundedJson(c.req.raw));
    } catch {
      return c.json({ error: { code: "INVALID_REQUEST" } }, 400);
    }
    const operationId = c.req.param("operationId");
    const timestamp = now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) return c.json({ error: { code: "AUTHORITY_UNAVAILABLE" } }, 503);
    if (!assignmentPoliciesMatch(input.assignment, {
      gatewayOrigin,
      controlPlaneOrigin,
      instanceHostSuffix: dependencies.instanceHostSuffix,
    })) return c.json({ error: { code: "ASSIGNMENT_POLICY_MISMATCH" } }, 409);

    const operation = await dependencies.operations.getById(operationId);
    if (!operation || !(await operationMatchesProbe(operation, input, dependencies, timestamp))) {
      return c.json({ error: { code: "OPERATION_FENCE_CONFLICT" } }, 409);
    }

    const snapshot = await dependencies.instances.getByInstanceId(operation.instanceId);
    if (
      !snapshot ||
      snapshot.binding.suspended ||
      snapshot.binding.repositoryId !== operation.repositoryId ||
      snapshot.binding.instanceId !== operation.instanceId ||
      snapshot.instance.repositoryId !== operation.repositoryId ||
      snapshot.instance.instanceId !== operation.instanceId ||
      snapshot.instance.clusterId !== dependencies.clusterId ||
      snapshot.instance.generation !== input.assignment.generation ||
      snapshot.instance.runtimeEpoch !== input.assignment.runtimeEpoch ||
      operation.clusterId !== dependencies.clusterId ||
      input.assignment.clusterId !== dependencies.clusterId
    ) return c.json({ error: { code: "CURRENT_BINDING_REQUIRED" } }, 409);

    const actor = await dependencies.db
      .prepare(
        `SELECT actor_id, authorization_revision
           FROM operations
          WHERE operation_id = ? AND instance_id = ? AND repository_id = ?`,
      )
      .bind(operationId, operation.instanceId, operation.repositoryId)
      .first<OperationActorRow>();
    if (!actor || !Number.isSafeInteger(actor.authorization_revision)) {
      return c.json({ error: { code: "CURRENT_BINDING_REQUIRED" } }, 409);
    }
    const probeActor = await resolveProbeActor(
      dependencies.db,
      operation,
      actor,
      snapshot.binding.authorizationRevision,
    );
    if (!probeActor) return c.json({ error: { code: "CURRENT_USER_AUTHORITY_REQUIRED" } }, 403);

    if (!(await admittedArtifactMatches(dependencies.db, operation, input.assignment))) {
      return c.json({ error: { code: "ASSIGNMENT_NOT_ADMITTED" } }, 409);
    }

    const currentBinding = {
      operationId,
      actorId: probeActor.actorId,
      repositoryId: operation.repositoryId,
      instanceId: operation.instanceId,
      generation: operation.generation,
      runtimeEpoch: operation.runtimeEpoch,
      authorizationRevision: probeActor.authorizationRevision,
    };
    const headers = new Headers({
      "X-Control-Plane-Gateway-Auth": dependencies.gatewaySecret,
      "Content-Type": "application/json",
      Accept: "application/json",
    });
    let upstream: Response;
    try {
      upstream = await dependencies.gateway.fetch(new Request(
        "https://gateway.internal/internal/provisioner/runtime-auth-probe",
        {
          method: "POST",
          headers,
          body: JSON.stringify(currentBinding),
          signal: AbortSignal.timeout(5_000),
        },
      ));
    } catch {
      return c.json({ error: { code: "GATEWAY_AUTHORITY_UNAVAILABLE" } }, 503);
    }
    const body = await readBoundedJsonResponse(upstream, 32_768).catch(() => null);
    if (!upstream.ok) {
      return c.json({ error: { code: upstream.status === 401 || upstream.status === 403 ? "AUTHORIZATION_DENIED" : "GATEWAY_AUTHORITY_UNAVAILABLE" } },
        upstream.status === 401 || upstream.status === 403 ? 403 : 503);
    }
    const parsed = GrantResponseSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: { code: "GATEWAY_RESPONSE_INVALID" } }, 503);
    if (parsed.data.authorizationRevision !== probeActor.authorizationRevision) {
      return c.json({ error: { code: "GATEWAY_BINDING_CHANGED" } }, 409);
    }

    // Grant material is a one-minute, repository-specific internal response.
    // `Cache-Control: no-store` is applied at both hops; tokens are never logged
    // or persisted in the provisioner operation checkpoint.
    return c.json({
      ...parsed.data,
      grantPolicyMatched: true,
      controlServicePolicyMatched: true,
    }, 200, { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  });
  return app;
}

function httpsOrigin(value: string): string {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== value ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) throw new TypeError("Runtime auth probe origins must be HTTPS origins");
  return parsed.origin;
}

function assignmentPoliciesMatch(
  assignment: z.infer<typeof PolicyAssignmentSchema>,
  expected: {
    readonly gatewayOrigin: string;
    readonly controlPlaneOrigin: string;
    readonly instanceHostSuffix: string;
  },
): boolean {
  try {
    const audience = `https://${instanceHostname(assignment.instanceId, expected.instanceHostSuffix)}`;
    return assignment.grantPolicy.issuer === expected.gatewayOrigin &&
      assignment.grantPolicy.jwksUrl === `${expected.gatewayOrigin}/.well-known/jwks.json` &&
      assignment.grantPolicy.audience === audience &&
      assignment.controlServicePolicy.issuer === expected.controlPlaneOrigin &&
      assignment.controlServicePolicy.jwksUrl === `${expected.controlPlaneOrigin}/.well-known/control-jwks.json` &&
      assignment.controlServicePolicy.audience === "praetorium-runtime-control";
  } catch {
    return false;
  }
}

async function resolveProbeActor(
  db: D1Database,
  operation: OperationRecord,
  row: OperationActorRow,
  currentAuthorizationRevision: number,
): Promise<{ readonly actorId: string; readonly authorizationRevision: number } | null> {
  if (/^[1-9][0-9]{0,15}$/u.test(row.actor_id) && Number.isSafeInteger(Number(row.actor_id))) {
    if (row.authorization_revision !== currentAuthorizationRevision) return null;
    return { actorId: row.actor_id, authorizationRevision: row.authorization_revision };
  }
  if (row.actor_id !== "system:stable-release" && row.actor_id !== "system:stable-release-canary") return null;
  const recentUsers = await db.prepare(
    `SELECT actor_id
       FROM audit_events
      WHERE repository_id = ? AND instance_id = ? AND actor_kind = 'user' AND outcome = 'accepted'
        AND actor_id GLOB '[1-9]*' AND actor_id NOT GLOB '*[^0-9]*'
      ORDER BY occurred_at DESC, event_id DESC
      LIMIT 16`,
  ).bind(operation.repositoryId, operation.instanceId).all<UserAuditActorRow>();
  for (const candidate of recentUsers.results ?? []) {
    if (/^[1-9][0-9]{0,15}$/u.test(candidate.actor_id) && Number.isSafeInteger(Number(candidate.actor_id))) {
      return { actorId: candidate.actor_id, authorizationRevision: currentAuthorizationRevision };
    }
  }
  return null;
}

async function operationMatchesProbe(
  operation: OperationRecord,
  input: z.infer<typeof ProbeRequestSchema>,
  dependencies: RuntimeAuthProbeRouteDependencies,
  now: number,
): Promise<boolean> {
  const assignment = input.assignment;
  if (
    operation.id.length === 0 ||
    operation.instanceId !== assignment.instanceId ||
    operation.repositoryId !== assignment.repositoryId ||
    operation.generation !== assignment.generation ||
    operation.runtimeEpoch !== assignment.runtimeEpoch ||
    operation.clusterId !== assignment.clusterId ||
    operation.clusterId !== dependencies.clusterId
  ) return false;

  if (input.mode === "lease") {
    const rollbackAssignment = operation.deploymentRevisionId === assignment.revisionId
      ? false
      : await matchesPersistedRollbackAssignment(operation, assignment, now);
    if (!rollbackAssignment && operation.deploymentRevisionId !== assignment.revisionId) return false;
    return input.workerId === dependencies.workerId &&
      operation.workerId === input.workerId &&
      operation.leaseToken === input.leaseToken &&
      operation.leaseEpoch === input.leaseEpoch &&
      operation.leaseExpiresAt !== null &&
      operation.leaseExpiresAt > now &&
      (operation.status === "claimed" || operation.status === "running");
  }

  if (operation.deploymentRevisionId !== assignment.revisionId) return false;
  if (operation.status !== "succeeded" ||
      (operation.kind !== "start" && operation.kind !== "update" && operation.kind !== "redeploy")) return false;
  const snapshot = await dependencies.instances.getByInstanceId(operation.instanceId);
  return Boolean(snapshot &&
    snapshot.instance.desiredState === "running" &&
    snapshot.instance.observedState === "ready" &&
    snapshot.instance.observedGeneration === assignment.generation &&
    snapshot.instance.observedRuntimeEpoch === assignment.runtimeEpoch &&
    snapshot.instance.observedRevisionId === assignment.revisionId &&
    snapshot.instance.currentArtifactDigest === assignment.imageDigest &&
    snapshot.instance.clusterId === dependencies.clusterId);
}

async function matchesPersistedRollbackAssignment(
  operation: OperationRecord,
  assignment: z.infer<typeof PolicyAssignmentSchema>,
  now: number,
): Promise<boolean> {
  if (operation.kind !== "update" && operation.kind !== "redeploy") return false;
  const checkpoint = operation.checkpoint;
  if (!checkpoint || checkpoint["schemaVersion"] !== 1 || !isRecord(checkpoint["lifecycle"])) return false;
  const lifecycle = checkpoint["lifecycle"];
  const current = lifecycle["current"];
  const target = lifecycle["target"];
  const proof = lifecycle["writerAbsenceProof"];
  const compatibilityEvidence = lifecycle["rollbackCompatibilityEvidence"];
  const quiesceReceipt = lifecycle["quiesceReceipt"];
  const targetEpoch = lifecycle["targetEpoch"];
  const rollbackEpoch = lifecycle["rollbackEpoch"];
  if (
    !Number.isSafeInteger(targetEpoch) || typeof targetEpoch !== "number" ||
    !Number.isSafeInteger(rollbackEpoch) || typeof rollbackEpoch !== "number" ||
    !isRecord(current) || !isRecord(current["deployment"]) || !isRecord(target)
  ) return false;
  const currentEpoch = current["runtimeEpoch"];
  const targetModuleIds = target["enabledModuleIds"];
  if (
    !Number.isSafeInteger(currentEpoch) || typeof currentEpoch !== "number" ||
    !Array.isArray(targetModuleIds) || targetModuleIds.length > 256 ||
    !targetModuleIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= 64)
  ) return false;
  if (
    lifecycle["id"] !== operation.id ||
    lifecycle["instanceId"] !== operation.instanceId ||
    lifecycle["repositoryId"] !== operation.repositoryId ||
    lifecycle["generation"] !== operation.generation ||
    lifecycle["clusterId"] !== operation.clusterId ||
    lifecycle["kind"] !== operation.kind ||
    lifecycle["phase"] !== "starting-target" ||
    lifecycle["runtimeEpoch"] !== operation.runtimeEpoch ||
    lifecycle["rollbackCompatible"] !== true ||
    targetEpoch >= rollbackEpoch ||
    rollbackEpoch !== targetEpoch + 1 ||
    rollbackEpoch !== assignment.runtimeEpoch ||
    operation.deploymentRevisionId !== target["revisionId"] ||
    lifecycle["targetRevisionId"] !== target["revisionId"] ||
    target["repositoryId"] !== operation.repositoryId ||
    !DIGEST.test(String(target["imageDigest"])) ||
    !DIGEST.test(String(target["compositionManifestDigest"])) ||
    !DIGEST.test(String(target["platformManifestDigest"])) ||
    current["instanceId"] !== assignment.instanceId ||
    current["repositoryId"] !== assignment.repositoryId ||
    current["generation"] !== assignment.generation ||
    current["clusterId"] !== assignment.clusterId ||
    currentEpoch >= rollbackEpoch ||
    currentEpoch >= targetEpoch ||
    currentEpoch < 1 ||
    current["revisionId"] !== assignment.revisionId ||
    current["deployment"]["repositoryId"] !== assignment.repositoryId ||
    current["deployment"]["revisionId"] !== assignment.revisionId ||
    current["deployment"]["imageDigest"] !== assignment.imageDigest ||
    current["deployment"]["platformManifestDigest"] !== assignment.platformManifestDigest ||
    current["deployment"]["compositionManifestDigest"] !== assignment.compositionManifestDigest ||
    !sameStrings(current["deployment"]["enabledModuleIds"], assignment.enabledModuleIds) ||
    !samePolicy(current["deployment"]["grantPolicy"], assignment.grantPolicy) ||
    !samePolicy(current["deployment"]["controlServicePolicy"], assignment.controlServicePolicy) ||
    !isWriterAbsenceProof(proof, operation, targetEpoch) ||
    !isWriterAbsenceProof(checkpoint["writerAbsenceProof"], operation, targetEpoch) ||
    !sameWriterAbsenceProof(proof, checkpoint["writerAbsenceProof"]) ||
    !rollbackCompatibilityEvidenceMatches({
      evidence: compatibilityEvidence,
      receipt: quiesceReceipt,
      operation,
      targetDeployment: target,
      targetEpoch,
      absenceProof: proof,
      now,
    })
  ) return false;
  return true;
}

function rollbackCompatibilityEvidenceMatches(input: {
  readonly evidence: unknown;
  readonly receipt: unknown;
  readonly operation: OperationRecord;
  readonly targetDeployment: Record<string, unknown>;
  readonly targetEpoch: number;
  readonly absenceProof: unknown;
  readonly now: number;
}): boolean {
  const { evidence, receipt, operation, targetDeployment, targetEpoch, absenceProof, now } = input;
  if (!isRecord(evidence) || !isRecord(receipt) || !isRecord(absenceProof)) return false;
  const receiptObservedAt = Date.parse(String(receipt["observedAt"]));
  const providerObservedAt = Date.parse(String(evidence["providerObservedAt"]));
  const observedAt = Date.parse(String(evidence["observedAt"]));
  const remoteObservedAt = Date.parse(String(evidence["remoteObservedAt"]));
  const absenceObservedAt = Date.parse(String(absenceProof["censusObservedAt"]));
  const confirmedCommit = receipt["lastConfirmedRemoteRevision"];
  if (
    evidence["contractVersion"] !== "praetorium-rollback-compatibility/v1" ||
    evidence["instanceId"] !== operation.instanceId ||
    evidence["repositoryId"] !== operation.repositoryId ||
    evidence["runtimeEpoch"] !== targetEpoch ||
    evidence["imageDigest"] !== targetDeployment["imageDigest"] ||
    evidence["compositionManifestDigest"] !== targetDeployment["compositionManifestDigest"] ||
    typeof evidence["providerObservationId"] !== "string" ||
    evidence["providerObservationId"].length < 1 ||
    evidence["providerObservationId"].length > 512 ||
    !Number.isFinite(receiptObservedAt) ||
    receipt["contractVersion"] !== "scriptorium-platform/v1" ||
    receipt["operationId"] !== operation.id ||
    receipt["instanceId"] !== operation.instanceId ||
    receipt["runtimeEpoch"] !== targetEpoch ||
    receipt["disposition"] !== "safe" ||
    receipt["activeMutations"] !== 0 ||
    receipt["activeJobs"] !== 0 ||
    receipt["pendingCheckpoints"] !== 0 ||
    receipt["uncertainPublication"] !== false ||
    typeof receipt["quiesceRevision"] !== "string" ||
    receipt["quiesceRevision"].length < 1 ||
    receipt["quiesceRevision"].length > 512 ||
    !((typeof confirmedCommit === "string" && REMOTE_REVISION.test(confirmedCommit)) ||
      (confirmedCommit === null && Array.isArray(evidence["formats"]) && evidence["formats"].length === 0)) ||
    evidence["quiesceRevision"] !== receipt["quiesceRevision"] ||
    evidence["quiesceRemoteCommit"] !== confirmedCommit ||
    evidence["observedRemoteCommit"] !== confirmedCommit ||
    !Number.isFinite(remoteObservedAt) ||
    remoteObservedAt > receiptObservedAt ||
    remoteObservedAt > observedAt ||
    observedAt - remoteObservedAt > 15_000 ||
    !Number.isFinite(providerObservedAt) ||
    !Number.isFinite(observedAt) ||
    providerObservedAt < receiptObservedAt ||
    providerObservedAt > observedAt ||
    observedAt < receiptObservedAt ||
    observedAt > now ||
    now - observedAt > ROLLBACK_EVIDENCE_MAX_AGE_MS ||
    !Number.isFinite(absenceObservedAt) ||
    absenceObservedAt < providerObservedAt ||
    absenceObservedAt > now ||
    now - absenceObservedAt > ROLLBACK_EVIDENCE_MAX_AGE_MS ||
    !validRollbackFormats(evidence["formats"])
  ) return false;
  return true;
}

/**
 * Lifecycle persists this marker only after the canonical persistence
 * compatibility check passes. The auth probe validates its evidence binding
 * and shape, but does not implement a second compatibility policy.
 */
function validRollbackFormats(formats: unknown): boolean {
  if (!Array.isArray(formats) || formats.length > 256) return false;
  const seen = new Set<string>();
  for (const item of formats) {
    if (
      !isRecord(item) ||
      typeof item["formatId"] !== "string" ||
      !/^[a-z][a-z0-9.-]{0,127}$/u.test(item["formatId"]) ||
      !Number.isSafeInteger(item["version"]) ||
      Number(item["version"]) < 1
    ) return false;
    const key = `${item["formatId"]}\u0000${item["version"]}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameStrings(left: unknown, right: readonly string[]): boolean {
  if (!Array.isArray(left) || !left.every((value): value is string => typeof value === "string")) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function samePolicy(left: unknown, right: { readonly issuer: string; readonly jwksUrl: string; readonly audience: string }): boolean {
  return isRecord(left) &&
    left["issuer"] === right.issuer &&
    left["jwksUrl"] === right.jwksUrl &&
    left["audience"] === right.audience;
}

function isWriterAbsenceProof(value: unknown, operation: OperationRecord, retiredEpoch: number): boolean {
  if (!isRecord(value)) return false;
  const censusObservedAt = Date.parse(String(value["censusObservedAt"]));
  const identities = value["evidenceIdentities"];
  return value["instanceId"] === operation.instanceId &&
    value["repositoryId"] === operation.repositoryId &&
    value["retiredRuntimeEpoch"] === retiredEpoch &&
    typeof value["providerObservationId"] === "string" &&
    value["providerObservationId"].length > 0 && value["providerObservationId"].length <= 512 &&
    typeof value["censusObservedAt"] === "string" && Number.isFinite(censusObservedAt) &&
    Array.isArray(identities) && identities.length <= 256 &&
    identities.every((identity) => typeof identity === "string" && identity.length <= 512) &&
    value["remainingWriters"] === 0 &&
    value["source"] === "runtime-provider-census";
}

function sameWriterAbsenceProof(left: unknown, right: unknown): boolean {
  if (!isRecord(left) || !isRecord(right)) return false;
  return left["instanceId"] === right["instanceId"] &&
    left["repositoryId"] === right["repositoryId"] &&
    left["retiredRuntimeEpoch"] === right["retiredRuntimeEpoch"] &&
    left["providerObservationId"] === right["providerObservationId"] &&
    left["censusObservedAt"] === right["censusObservedAt"] &&
    left["remainingWriters"] === right["remainingWriters"] &&
    left["source"] === right["source"];
}

async function admittedArtifactMatches(
  db: D1Database,
  operation: OperationRecord,
  assignment: z.infer<typeof PolicyAssignmentSchema>,
): Promise<boolean> {
  if (!operation.deploymentRevisionId) return false;
  const row = await db
    .prepare(
      `SELECT r.status, r.artifact_digest, a.statement_json
         FROM deployment_revisions r
         JOIN artifacts a ON a.artifact_digest = r.artifact_digest AND a.status = 'admitted'
        WHERE r.revision_id = ? AND r.instance_id = ? AND r.repository_id = ? AND r.generation = ?`,
    )
    .bind(assignment.revisionId, assignment.instanceId, assignment.repositoryId, assignment.generation)
    .first<AdmittedArtifactRow>();
  if (!row || row.status !== "admitted" || !row.statement_json) return false;
  let statement: z.infer<typeof BuilderArtifactStatementSchema>;
  try {
    statement = BuilderArtifactStatementSchema.parse(JSON.parse(row.statement_json) as unknown);
  } catch {
    return false;
  }
  const resolvedModuleIds = statement.resolvedModules.map((module) => module.id).sort();
  const requestedModuleIds = [...assignment.enabledModuleIds].sort();
  return row.artifact_digest === statement.artifact.digest &&
    statement.artifact.digest === assignment.imageDigest &&
    statement.artifact.platformManifestDigest === assignment.platformManifestDigest &&
    statement.compositionManifest.digest === assignment.compositionManifestDigest &&
    resolvedModuleIds.length === requestedModuleIds.length &&
    resolvedModuleIds.every((moduleId, index) => moduleId === requestedModuleIds[index]);
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const rawLength = request.headers.get("Content-Length");
  if (rawLength !== null && (!/^(0|[1-9][0-9]*)$/u.test(rawLength) || Number(rawLength) > 16_384)) {
    throw new TypeError("request too large");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new TypeError("request body required");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16_384) {
        await reader.cancel();
        throw new TypeError("request too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

async function readBoundedJsonResponse(response: Response, maximumBytes: number): Promise<unknown> {
  if (!response.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
    await response.body?.cancel();
    throw new TypeError("Gateway probe response is not JSON");
  }
  const rawLength = response.headers.get("Content-Length");
  if (rawLength !== null && (!/^(0|[1-9][0-9]*)$/u.test(rawLength) || Number(rawLength) > maximumBytes)) {
    await response.body?.cancel();
    throw new TypeError("Gateway probe response is too large");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new TypeError("Gateway probe response body is required");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new TypeError("Gateway probe response is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}
