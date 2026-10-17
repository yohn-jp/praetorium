import { Hono } from "hono";
import { z } from "zod";
import { issueRuntimeIdentityCredential } from "@praetorium/auth";
import type { OperationService } from "@praetorium/application/operations";
import type { D1Database } from "@praetorium/persistence/d1";
import type { RuntimeBindingMetadata, RuntimeBindingMetadataReader } from "./runtime-binding.js";

const ID = z.string().min(1).max(128);
const POSITIVE_ID = z.number().int().positive().safe();
const COUNTER = z.number().int().nonnegative().safe();
const MAX_BODY_BYTES = 65_536;
const ALLOWED_PRIVATE_JWK_MEMBERS = new Set([
  "kty",
  "crv",
  "x",
  "y",
  "d",
  "alg",
  "use",
  "key_ops",
  "ext",
]);
const TARGET_PHASES = new Set([
  "old-writer-absent",
  "starting-target",
  "target-ready",
  "route-activated",
]);

const RuntimeIdentityRequestSchema = z
  .strictObject({
    runtimeId: ID,
    instanceId: ID,
    repositoryId: POSITIVE_ID,
    installationId: POSITIVE_ID,
    runtimeEpoch: z.number().int().positive().safe(),
    leaseId: ID,
    workerId: ID,
    clusterId: ID,
    operationId: ID.optional(),
    leaseToken: z.string().min(32).max(256).optional(),
    leaseEpoch: COUNTER.optional(),
  })
  .superRefine((value, context) => {
    const hasOperationId = value.operationId !== undefined;
    const hasLeaseToken = value.leaseToken !== undefined;
    const hasLeaseEpoch = value.leaseEpoch !== undefined;
    if (hasOperationId !== hasLeaseToken || hasOperationId !== hasLeaseEpoch) {
      context.addIssue({
        code: "custom",
        message: "operationId, leaseToken, and leaseEpoch must be supplied together",
      });
    }
  });

type RuntimeIdentityRequest = z.infer<typeof RuntimeIdentityRequestSchema>;

export interface RuntimeIdentityRoutesDependencies {
  readonly db: D1Database;
  readonly runtimeBindings: RuntimeBindingMetadataReader;
  readonly operations: Pick<OperationService, "getById">;
  readonly signingKey: {
    readonly kid: string;
    readonly privateKeyJwk: JsonWebKey;
  };
  readonly issuerOrigin: string;
  readonly workerId: string;
  readonly clusterId: string;
  readonly now?: () => number;
}

interface RuntimeIdentityJwks {
  readonly keys: readonly {
    readonly kty: "EC";
    readonly crv: "P-256";
    readonly x: string;
    readonly y: string;
    readonly use: "sig";
    readonly alg: "ES256";
    readonly kid: string;
  }[];
}

interface TargetLeaseRow {
  operation_id: string;
  instance_id: string;
  repository_id: number;
  generation: number;
  runtime_epoch: number;
  kind: string;
  status: string;
  phase: string;
  lease_epoch: number;
  worker_id: string | null;
  lease_token: string | null;
  lease_expires_at: number | null;
  checkpoint_sequence: number;
  cluster_id: string | null;
  reservation_id: string | null;
  observed_state: string;
  observed_runtime_epoch: number | null;
  current_checkpoint: string;
  absence_checkpoint: string;
}

class RequestTooLargeError extends Error {}
class RuntimeIdentitySignerUnavailableError extends Error {}

/** Route set intended to be mounted by the Control Plane after its outer auth middleware. */
export function createRuntimeIdentityRoutes(deps: RuntimeIdentityRoutesDependencies) {
  const issuer = trustedOrigin(deps.issuerOrigin);
  const kid = validateSigningKey(deps.signingKey);
  if (!/^[A-Za-z0-9_.:-]{1,128}$/u.test(deps.workerId))
    throw new TypeError("runtime identity worker ID is invalid");
  if (!/^[A-Za-z0-9_.:-]{1,128}$/u.test(deps.clusterId))
    throw new TypeError("runtime identity cluster ID is invalid");

  const keySetupPromise = crypto.subtle
    .importKey("jwk", deps.signingKey.privateKeyJwk, { name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
    ])
    .then(async (privateKey) => {
      const publicJwk = await crypto.subtle.exportKey("jwk", privateKey);
      if (
        publicJwk.kty !== "EC" ||
        publicJwk.crv !== "P-256" ||
        typeof publicJwk.x !== "string" ||
        typeof publicJwk.y !== "string"
      )
        throw new TypeError("runtime identity key did not yield a public P-256 key");
      const jwks: RuntimeIdentityJwks = {
        keys: [
          {
            kty: "EC",
            crv: "P-256",
            x: publicJwk.x,
            y: publicJwk.y,
            use: "sig",
            alg: "ES256",
            kid,
          },
        ],
      };
      return { signingKey: { kid, privateKey }, jwks };
    })
    .then(
      (value) => ({ ok: true as const, value }),
      () => ({ ok: false as const }),
    );
  const loadSigner = async () => {
    const result = await keySetupPromise;
    if (!result.ok) throw new RuntimeIdentitySignerUnavailableError();
    return result.value;
  };
  const now = deps.now ?? Date.now;
  const app = new Hono();

  app.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    await next();
  });

  app.get("/.well-known/runtime-identity-jwks.json", async (context) => {
    const signer = await loadSigner();
    return context.json(signer.jwks);
  });

  app.get("/internal/runtime-bindings/:repositoryId", async (context) => {
    const repositoryId = parseRepositoryId(context.req.param("repositoryId"));
    const binding = await deps.runtimeBindings.getCurrent(repositoryId);
    if (!binding) return context.json({ error: { code: "RUNTIME_BINDING_UNAVAILABLE" } }, 404);
    return context.json(binding);
  });

  // The outer Control Plane middleware requires the Provisioner credential on
  // this namespace. No Gateway credential is projected into a tenant runtime.
  app.get("/internal/provisioner/runtime-bindings/:repositoryId", async (context) => {
    const repositoryId = parseRepositoryId(context.req.param("repositoryId"));
    const binding = await deps.runtimeBindings.getCurrent(repositoryId);
    if (!binding || binding.clusterId !== deps.clusterId)
      return context.json({ error: { code: "RUNTIME_BINDING_UNAVAILABLE" } }, 404);
    return context.json(binding);
  });

  app.post("/internal/provisioner/runtime-identity", async (context) => {
    const input = RuntimeIdentityRequestSchema.parse(await boundedJson(context.req.raw));
    const nowMs = now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0)
      throw new TypeError("runtime identity clock is invalid");
    if (input.workerId !== deps.workerId || input.clusterId !== deps.clusterId)
      return context.json({ error: { code: "RUNTIME_IDENTITY_FENCED" } }, 409);
    const binding = await deps.runtimeBindings.getCurrent(input.repositoryId);
    if (!binding || !matchesBinding(input, binding, deps.clusterId))
      return context.json({ error: { code: "RUNTIME_IDENTITY_FENCED" } }, 409);

    const ttlSeconds = 300;
    if (binding.authority === "post-absence-target") {
      if (
        input.operationId === undefined ||
        input.leaseToken === undefined ||
        input.leaseEpoch === undefined
      )
        return context.json({ error: { code: "RUNTIME_IDENTITY_FENCED" } }, 409);
      const targetLease = await verifyTargetLease(deps, input, binding, nowMs);
      if (!targetLease) return context.json({ error: { code: "RUNTIME_IDENTITY_FENCED" } }, 409);
      // This proves identity, not continuing operation authority. Brokerage
      // re-reads the current binding and live target lease on every request.
      // Keep enough lifetime for image pulls and projected Secret propagation.
    } else if (
      input.operationId !== undefined ||
      input.leaseToken !== undefined ||
      input.leaseEpoch !== undefined
    ) {
      return context.json({ error: { code: "RUNTIME_IDENTITY_FENCED" } }, 409);
    }

    const issued = await issueRuntimeIdentityCredential((await loadSigner()).signingKey, {
      issuer,
      runtimeId: binding.runtimeId,
      instanceId: binding.instanceId,
      repositoryId: binding.repositoryId,
      installationId: binding.installationId,
      runtimeEpoch: binding.runtimeEpoch,
      leaseId: binding.leaseId,
      now: new Date(nowMs).toISOString(),
      ttlSeconds,
    });
    return context.json({
      token: issued.token,
      expiresAt: new Date(issued.descriptor.exp * 1000).toISOString(),
    });
  });

  app.onError((error, context) => {
    if (error instanceof RequestTooLargeError)
      return context.json({ error: { code: "REQUEST_TOO_LARGE" } }, 413);
    if (error instanceof RuntimeIdentitySignerUnavailableError)
      return context.json({ error: { code: "RUNTIME_IDENTITY_UNAVAILABLE" } }, 503);
    if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof TypeError)
      return context.json({ error: { code: "INVALID_REQUEST" } }, 400);
    return context.json({ error: { code: "RUNTIME_IDENTITY_UNAVAILABLE" } }, 503);
  });

  return app;
}

function matchesBinding(
  input: RuntimeIdentityRequest,
  binding: RuntimeBindingMetadata,
  clusterId: string,
): boolean {
  return (
    input.runtimeId === binding.runtimeId &&
    input.instanceId === binding.instanceId &&
    input.repositoryId === binding.repositoryId &&
    input.installationId === binding.installationId &&
    input.runtimeEpoch === binding.runtimeEpoch &&
    input.leaseId === binding.leaseId &&
    input.clusterId === clusterId &&
    binding.clusterId === clusterId &&
    binding.active === true
  );
}

async function verifyTargetLease(
  deps: RuntimeIdentityRoutesDependencies,
  input: RuntimeIdentityRequest,
  binding: RuntimeBindingMetadata,
  nowMs: number,
): Promise<{ readonly leaseExpiresAt: number } | null> {
  const operationId = input.operationId;
  const leaseToken = input.leaseToken;
  const leaseEpoch = input.leaseEpoch;
  if (operationId === undefined || leaseToken === undefined || leaseEpoch === undefined)
    return null;

  const [operation, row] = await Promise.all([
    deps.operations.getById(operationId),
    deps.db
      .prepare(
        `SELECT o.operation_id, o.instance_id, o.repository_id, o.generation,
                o.runtime_epoch, o.kind, o.status, o.phase, o.lease_epoch,
                o.worker_id, o.lease_token, o.lease_expires_at, o.checkpoint_sequence,
                o.cluster_id,
                o.reservation_id, i.observed_state, i.observed_runtime_epoch,
                latest.checkpoint_json AS current_checkpoint,
                absence.checkpoint_json AS absence_checkpoint
         FROM repository_bindings b
         JOIN logical_instances i ON i.instance_id = b.instance_id
         JOIN operations o ON o.instance_id = i.instance_id
           AND o.repository_id = i.repository_id
         JOIN runtime_reservations r ON r.reservation_id = o.reservation_id
           AND r.instance_id = i.instance_id AND r.repository_id = i.repository_id
           AND r.runtime_epoch = o.runtime_epoch
         JOIN operation_checkpoints latest ON latest.operation_id = o.operation_id
           AND latest.sequence = o.checkpoint_sequence
           AND latest.runtime_epoch = o.runtime_epoch
         JOIN operation_checkpoints absence ON absence.operation_id = o.operation_id
           AND absence.phase = 'old-writer-absent'
           AND absence.runtime_epoch = o.runtime_epoch
           AND absence.sequence <= latest.sequence
         WHERE b.repository_id = ? AND b.suspended = 0
           AND o.operation_id = ?
           AND o.kind IN ('start', 'redeploy', 'update')
           AND o.status IN ('claimed', 'running')
           AND o.lease_expires_at > ?
           AND o.phase IN ('old-writer-absent', 'starting-target', 'target-ready', 'route-activated')
           AND latest.phase = o.phase
           AND latest.checkpoint_json = o.checkpoint_json
           AND o.generation = i.generation AND o.runtime_epoch = i.runtime_epoch
           AND o.runtime_epoch > COALESCE(i.observed_runtime_epoch, 0)
           AND (
             (i.observed_state = 'ready' AND json_extract(latest.checkpoint_json, '$.writerAbsenceProof.retiredRuntimeEpoch') = i.observed_runtime_epoch)
             OR (i.observed_state IN ('absent', 'stopped') AND (
               json_extract(latest.checkpoint_json, '$.writerAbsenceProof.retiredRuntimeEpoch') IS NULL
               OR json_extract(latest.checkpoint_json, '$.writerAbsenceProof.retiredRuntimeEpoch') = i.observed_runtime_epoch
             ))
           )
           AND i.reservation_id = r.reservation_id
           AND r.status IN ('reserved', 'allocated')
           AND r.cluster_id = o.cluster_id
           AND r.reservation_id = ? AND r.instance_id = ?
           AND r.repository_id = ? AND r.runtime_epoch = ? AND r.cluster_id = ?
           AND json_extract(latest.checkpoint_json, '$.schemaVersion') = 1
           AND json_extract(latest.checkpoint_json, '$.writerAbsenceProof.instanceId') = i.instance_id
           AND json_extract(latest.checkpoint_json, '$.writerAbsenceProof.repositoryId') = i.repository_id
           AND json_extract(latest.checkpoint_json, '$.writerAbsenceProof.source') = 'runtime-provider-census'
           AND json_type(latest.checkpoint_json, '$.writerAbsenceProof.remainingWriters') = 'integer'
           AND json_extract(latest.checkpoint_json, '$.writerAbsenceProof.remainingWriters') = 0
           AND json_type(latest.checkpoint_json, '$.writerAbsenceProof.providerObservationId') = 'text'
           AND length(json_extract(latest.checkpoint_json, '$.writerAbsenceProof.providerObservationId')) BETWEEN 1 AND 512
           AND json_type(latest.checkpoint_json, '$.writerAbsenceProof.censusObservedAt') = 'text'
           AND julianday(json_extract(latest.checkpoint_json, '$.writerAbsenceProof.censusObservedAt')) <= julianday(?)
           AND json_type(latest.checkpoint_json, '$.writerAbsenceProof.evidenceIdentities') = 'array'
           AND NOT EXISTS (
             SELECT 1 FROM json_each(latest.checkpoint_json, '$.writerAbsenceProof.evidenceIdentities') evidence_identity
             WHERE evidence_identity.type <> 'text' OR length(evidence_identity.value) > 512
           )
           AND json_extract(latest.checkpoint_json, '$.writerAbsenceProof.instanceId') IS json_extract(absence.checkpoint_json, '$.writerAbsenceProof.instanceId')
           AND json_extract(latest.checkpoint_json, '$.writerAbsenceProof.repositoryId') IS json_extract(absence.checkpoint_json, '$.writerAbsenceProof.repositoryId')
           AND json_extract(latest.checkpoint_json, '$.writerAbsenceProof.retiredRuntimeEpoch') IS json_extract(absence.checkpoint_json, '$.writerAbsenceProof.retiredRuntimeEpoch')
           AND json_extract(latest.checkpoint_json, '$.writerAbsenceProof.providerObservationId') IS json_extract(absence.checkpoint_json, '$.writerAbsenceProof.providerObservationId')
           AND json_extract(latest.checkpoint_json, '$.writerAbsenceProof.censusObservedAt') IS json_extract(absence.checkpoint_json, '$.writerAbsenceProof.censusObservedAt')
           AND json_extract(latest.checkpoint_json, '$.writerAbsenceProof.remainingWriters') IS json_extract(absence.checkpoint_json, '$.writerAbsenceProof.remainingWriters')
           AND json_extract(latest.checkpoint_json, '$.writerAbsenceProof.evidenceIdentities') IS json_extract(absence.checkpoint_json, '$.writerAbsenceProof.evidenceIdentities')
           AND json_extract(latest.checkpoint_json, '$.writerAbsenceProof.source') IS json_extract(absence.checkpoint_json, '$.writerAbsenceProof.source')
         LIMIT 1`,
      )
      .bind(
        input.repositoryId,
        operationId,
        nowMs,
        binding.leaseId,
        binding.instanceId,
        binding.repositoryId,
        binding.runtimeEpoch,
        binding.clusterId,
        new Date(nowMs).toISOString(),
      )
      .first<TargetLeaseRow>(),
  ]);
  if (!operation || !row || !row.lease_expires_at) return null;
  if (
    operation.id !== input.operationId ||
    operation.instanceId !== binding.instanceId ||
    operation.repositoryId !== binding.repositoryId ||
    operation.runtimeEpoch !== binding.runtimeEpoch ||
    operation.generation !== row.generation ||
    operation.reservationId !== binding.leaseId ||
    operation.clusterId !== binding.clusterId ||
    operation.workerId !== deps.workerId ||
    operation.leaseEpoch !== input.leaseEpoch ||
    operation.leaseToken === null ||
    !(await equalSecret(operation.leaseToken, leaseToken)) ||
    operation.leaseExpiresAt === null ||
    operation.leaseExpiresAt <= nowMs ||
    (operation.status !== "claimed" && operation.status !== "running") ||
    operation.kind !== row.kind ||
    operation.phase !== row.phase ||
    !TARGET_PHASES.has(operation.phase) ||
    operation.status !== row.status ||
    operation.checkpointSequence !== row.checkpoint_sequence ||
    operation.checkpoint === null ||
    JSON.stringify(operation.checkpoint) !== row.current_checkpoint ||
    row.operation_id !== operation.id ||
    row.instance_id !== binding.instanceId ||
    row.repository_id !== binding.repositoryId ||
    row.runtime_epoch !== binding.runtimeEpoch ||
    row.reservation_id !== binding.leaseId ||
    row.cluster_id !== binding.clusterId ||
    row.worker_id !== deps.workerId ||
    row.lease_epoch !== input.leaseEpoch ||
    row.lease_expires_at !== operation.leaseExpiresAt ||
    !(await equalSecret(row.lease_token ?? "", leaseToken)) ||
    !validAbsenceCheckpoint(row.current_checkpoint, binding, row, nowMs) ||
    !sameAbsenceCheckpoint(row.current_checkpoint, row.absence_checkpoint, binding, row, nowMs)
  )
    return null;
  return { leaseExpiresAt: operation.leaseExpiresAt };
}

function validAbsenceCheckpoint(
  serialized: string,
  binding: RuntimeBindingMetadata,
  row: TargetLeaseRow,
  nowMs: number,
): boolean {
  try {
    const checkpoint: unknown = JSON.parse(serialized);
    if (
      !isRecord(checkpoint) ||
      checkpoint.schemaVersion !== 1 ||
      !isRecord(checkpoint.writerAbsenceProof)
    )
      return false;
    const proof = checkpoint.writerAbsenceProof;
    const censusTime =
      typeof proof.censusObservedAt === "string" ? Date.parse(proof.censusObservedAt) : NaN;
    return (
      proof.instanceId === binding.instanceId &&
      proof.repositoryId === binding.repositoryId &&
      proof.source === "runtime-provider-census" &&
      proof.remainingWriters === 0 &&
      typeof proof.providerObservationId === "string" &&
      proof.providerObservationId.length > 0 &&
      proof.providerObservationId.length <= 512 &&
      Number.isFinite(censusTime) &&
      censusTime <= nowMs &&
      Array.isArray(proof.evidenceIdentities) &&
      proof.evidenceIdentities.every(
        (identity) => typeof identity === "string" && identity.length <= 512,
      ) &&
      (proof.retiredRuntimeEpoch === null ||
        (Number.isSafeInteger(proof.retiredRuntimeEpoch) &&
          (proof.retiredRuntimeEpoch as number) >= 0 &&
          (proof.retiredRuntimeEpoch as number) < binding.runtimeEpoch)) &&
      (row.observed_state !== "ready" ||
        proof.retiredRuntimeEpoch === row.observed_runtime_epoch) &&
      ["ready", "absent", "stopped"].includes(row.observed_state)
    );
  } catch {
    return false;
  }
}

function sameAbsenceCheckpoint(
  current: string,
  historical: string,
  binding: RuntimeBindingMetadata,
  row: TargetLeaseRow,
  nowMs: number,
): boolean {
  try {
    const currentCheckpoint: unknown = JSON.parse(current);
    const historicalCheckpoint: unknown = JSON.parse(historical);
    if (
      !isRecord(currentCheckpoint) ||
      !isRecord(historicalCheckpoint) ||
      !isRecord(currentCheckpoint.writerAbsenceProof) ||
      !isRecord(historicalCheckpoint.writerAbsenceProof)
    )
      return false;
    const currentProof = currentCheckpoint.writerAbsenceProof;
    const historicalProof = historicalCheckpoint.writerAbsenceProof;
    if (!validAbsenceCheckpoint(current, binding, row, nowMs)) return false;
    const historicalSerialized = JSON.stringify({
      schemaVersion: historicalCheckpoint.schemaVersion,
      writerAbsenceProof: historicalProof,
    });
    const historicalRow = { ...row, current_checkpoint: historicalSerialized };
    if (!validAbsenceCheckpoint(historicalSerialized, binding, historicalRow, nowMs)) return false;
    const fields = [
      "instanceId",
      "repositoryId",
      "retiredRuntimeEpoch",
      "providerObservationId",
      "censusObservedAt",
      "remainingWriters",
      "evidenceIdentities",
      "source",
    ] as const;
    return fields.every((field) => {
      const left = currentProof[field];
      const right = historicalProof[field];
      if (Array.isArray(left) && Array.isArray(right))
        return left.length === right.length && left.every((value, index) => value === right[index]);
      return left === right;
    });
  } catch {
    return false;
  }
}

async function boundedJson(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new TypeError("Request body required");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new RequestTooLargeError("runtime identity request is too large");
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

function parseRepositoryId(value: string): number {
  if (!/^[1-9][0-9]{0,15}$/u.test(value)) throw new TypeError("repository ID is invalid");
  const repositoryId = Number(value);
  if (!Number.isSafeInteger(repositoryId)) throw new TypeError("repository ID is invalid");
  return repositoryId;
}

function trustedOrigin(value: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new TypeError("runtime identity issuer origin is required");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("runtime identity issuer origin is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new TypeError("runtime identity issuer must be a trusted HTTPS origin");
  return url.origin;
}

function validateSigningKey(value: RuntimeIdentityRoutesDependencies["signingKey"]): string {
  if (!value || typeof value !== "object")
    throw new TypeError("runtime identity signing key is required");
  if (typeof value.kid !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(value.kid))
    throw new TypeError("runtime identity signing key ID is invalid");
  const key = value.privateKeyJwk as JsonWebKey & Record<string, unknown>;
  if (!key || typeof key !== "object" || Array.isArray(key))
    throw new TypeError("runtime identity private JWK is required");
  if (Object.keys(key).some((member) => !ALLOWED_PRIVATE_JWK_MEMBERS.has(member)))
    throw new TypeError("runtime identity JWK contains unsupported key material");
  if (
    key.kty !== "EC" ||
    key.crv !== "P-256" ||
    typeof key.x !== "string" ||
    !key.x ||
    typeof key.y !== "string" ||
    !key.y ||
    typeof key.d !== "string" ||
    !key.d ||
    (key.alg !== undefined && key.alg !== "ES256") ||
    (key.use !== undefined && key.use !== "sig") ||
    (key.ext !== undefined && key.ext !== true) ||
    (key.key_ops !== undefined &&
      (!Array.isArray(key.key_ops) || key.key_ops.length !== 1 || key.key_ops[0] !== "sign"))
  )
    throw new TypeError("runtime identity key must be a strict P-256 ES256 signing key");
  return value.kid;
}

async function equalSecret(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftDigest);
  const rightBytes = new Uint8Array(rightDigest);
  let mismatch = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < leftBytes.length; index++)
    mismatch |= leftBytes[index]! ^ rightBytes[index]!;
  return mismatch === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
