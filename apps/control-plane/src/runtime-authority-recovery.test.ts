import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { OperationService, OperationFenceConflict } from "@praetorium/application/operations";
import { physicalInstanceId } from "@praetorium/contracts";
import {
  D1PlatformStore,
  D1RuntimeGitCredentialStore,
  type D1Database,
  type D1PreparedStatement,
  type D1Result,
} from "@praetorium/persistence/d1";
import { createCredentialRetirementBarrier } from "./credential-retirement.js";
import { createProvisionerRoutes } from "./provisioner-routes.js";
import { createRuntimeBindingMetadataReader } from "./runtime-binding.js";
import { createRuntimeGitCredentialRoutes } from "./runtime-git-credential-routes.js";
import { publishRuntimeAuthority } from "./runtime-authority-transition.js";
import { createRuntimeAuthorityRecovery } from "./runtime-authority-recovery.js";

const NOW = Date.now();
const REPOSITORY_ID = 7001;
const INSTANCE_ID = "ins_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const INSTALLATION_ID = 9001;
const CLUSTER_ID = "cluster-1";
const WORKER_ID = "provisioner-1";
const OPERATION_ID = "op-redeploy-5";
const LEASE_TOKEN = "lease-secret-".padEnd(64, "x");
const CURRENT_RESERVATION_ID = "res_current-4";
const TARGET_RESERVATION_ID = "res_target-5";
const TARGET_REVISION_ID = "revision-5";
const liveDatabases: DatabaseSync[] = [];

class SQLiteD1 implements D1Database {
  readonly database = new DatabaseSync(":memory:");
  beforeFirst: ((query: string) => void) | undefined;

  constructor() {
    liveDatabases.push(this.database);
  }

  prepare(query: string): D1PreparedStatement {
    return new SQLiteD1Statement(
      this.database,
      query,
      this.database.prepare(query),
      () => this.beforeFirst?.(query),
    );
  }

  async batch<T = unknown>(
    statements: readonly D1PreparedStatement[],
  ): Promise<readonly D1Result<T>[]> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results: D1Result<unknown>[] = [];
      for (const statement of statements)
        results.push(await (statement as SQLiteD1Statement).execute());
      this.database.exec("COMMIT");
      return results as D1Result<T>[];
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

class SQLiteD1Statement implements D1PreparedStatement {
  private values: readonly (string | number | null | ArrayBuffer | Uint8Array)[] = [];

  constructor(
    private readonly database: DatabaseSync,
    private readonly query: string,
    private readonly statement: StatementSync,
    private readonly beforeFirst: () => void,
  ) {}

  bind(
    ...values: readonly (string | number | null | ArrayBuffer | Uint8Array)[]
  ): D1PreparedStatement {
    this.values = values;
    return this;
  }

  private sqlValues(): SQLInputValue[] {
    return this.values.map((value) =>
      value instanceof ArrayBuffer ? new Uint8Array(value) : value,
    );
  }

  async first<T = unknown>(): Promise<T | null> {
    this.beforeFirst();
    return (this.statement.get(...this.sqlValues()) as T | undefined) ?? null;
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    return { results: this.statement.all(...this.sqlValues()) as T[], meta: { changes: 0 } };
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    const result = this.statement.run(...this.sqlValues());
    return { results: [], meta: { changes: Number(result.changes) } };
  }

  async execute(): Promise<D1Result> {
    if (/^\s*(SELECT|WITH)\b/iu.test(this.query))
      return { results: this.statement.all(...this.sqlValues()), meta: { changes: 0 } };
    const result = this.statement.run(...this.sqlValues());
    return { results: [], meta: { changes: Number(result.changes) } };
  }
}

function installSchema(db: SQLiteD1): void {
  db.database.exec("PRAGMA foreign_keys = ON");
  for (const migration of [
    "../migrations/0001_repository_platform.sql",
    "../migrations/0002_stable_release_rollouts.sql",
    "../migrations/0003_staged_configurations.sql",
    "../migrations/0004_runtime_git_credentials.sql",
    "../migrations/0006_application_origins.sql",
    "../migrations/0009_runtime_authority.sql",
  ])
    db.database.exec(readFileSync(new URL(migration, import.meta.url), "utf8"));
}

function seedOperation(db: SQLiteD1): void {
  const createdAt = NOW - 1000;
  db.database
    .prepare(
      `INSERT INTO logical_instances (
       instance_id, repository_id, generation, runtime_epoch, desired_state,
       observed_generation, observed_runtime_epoch, observed_state,
       observed_revision_id, desired_revision_id, current_artifact_digest,
       desired_artifact_digest, reservation_state, reservation_id, created_at, updated_at
     ) VALUES (?, ?, 8, 5, 'running', 7, 4, 'ready', 'revision-4', 'revision-5',
       'sha256:current', 'sha256:target', 'reserved', ?, ?, ?)`,
    )
    .run(INSTANCE_ID, REPOSITORY_ID, TARGET_RESERVATION_ID, createdAt, createdAt);
  db.database
    .prepare(
      `INSERT INTO repository_bindings (
       repository_id, instance_id, installation_id, owner, name,
       authorization_revision, binding_epoch, suspended, created_at, updated_at
     ) VALUES (?, ?, ?, 'owner', 'repo', 3, 2, 0, ?, ?)`,
    )
    .run(REPOSITORY_ID, INSTANCE_ID, INSTALLATION_ID, createdAt, createdAt);
  for (const reservation of [
    { id: CURRENT_RESERVATION_ID, epoch: 4, generation: 7 },
    { id: TARGET_RESERVATION_ID, epoch: 5, generation: 8 },
  ])
    db.database
      .prepare(
        `INSERT INTO runtime_reservations (
         reservation_id, instance_id, repository_id, runtime_epoch, generation,
         cluster_id, status, capacity_snapshot_epoch, cpu_milli, memory_mib,
         ephemeral_storage_mib, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'reserved', 1, 100, 256, 128, ?, ?)`,
      )
      .run(
        reservation.id,
        INSTANCE_ID,
        REPOSITORY_ID,
        reservation.epoch,
        reservation.generation,
        CLUSTER_ID,
        createdAt,
        createdAt,
      );
  db.database
    .prepare(
      `INSERT INTO operations (
       operation_id, instance_id, repository_id, generation, runtime_epoch, kind,
       status, phase, attempt, lease_epoch, worker_id, lease_token, lease_expires_at,
       report_sequence, checkpoint_sequence, checkpoint_json, cluster_id, reservation_id,
       idempotency_scope, idempotency_key, request_hash, actor_id,
       authorization_revision, created_at, updated_at
     ) VALUES (?, ?, ?, 8, 5, 'redeploy', 'running', 'accepted', 1, 4, ?, ?, ?,
       0, 0, NULL, ?, ?, 'repo:7001', 'request-5', 'request-hash', 'user-1', 3, ?, ?)`,
    )
    .run(
      OPERATION_ID,
      INSTANCE_ID,
      REPOSITORY_ID,
      WORKER_ID,
      LEASE_TOKEN,
      NOW + 30_000,
      CLUSTER_ID,
      TARGET_RESERVATION_ID,
      createdAt,
      NOW,
    );
}

function seedAdmittedTarget(db: SQLiteD1): void {
  db.database.prepare(
    `INSERT INTO builds (build_id, build_key, build_input_json, status, created_at, updated_at)
     VALUES ('build-target', 'build-key-target', '{}', 'succeeded', ?, ?)`,
  ).run(NOW - 1000, NOW - 1000);
  db.database.prepare(
    `INSERT INTO build_attempts (
       attempt_id, build_id, lease_epoch, worker_id, status, lease_token,
       lease_expires_at, started_at, updated_at, finished_at
     ) VALUES ('attempt-target', 'build-target', 1, 'builder', 'succeeded', 'build-lease', ?, ?, ?, ?)`,
  ).run(NOW - 500, NOW - 1000, NOW - 500, NOW - 500);
  db.database.prepare(
    `INSERT INTO artifacts (
       artifact_digest, build_key, build_id, attempt_id, manifest_digest,
       platform_manifest_digest, composition_manifest_digest, producer_revision,
       requested_modules_json, resolved_modules_json, contract_versions_json,
       verification_json, statement_json, signature_json, verifier_id, status,
       created_at, admitted_at
     ) VALUES ('sha256:target', 'build-key-target', 'build-target', 'attempt-target',
       'sha256:manifest', 'sha256:target', 'sha256:composition', 'producer-1',
       '[]', '[]', '{}', '{}', '{}', '{}', 'verifier-1', 'admitted', ?, ?)`,
  ).run(NOW - 1000, NOW - 500);
  db.database.prepare(
    `INSERT INTO deployment_revisions (
       revision_id, instance_id, repository_id, generation, build_key, build_id,
       selection_json, resource_requirements_json, runtime_metadata_json,
       artifact_digest, status, actor_id, created_at
     ) VALUES (?, ?, ?, 8, 'build-key-target', 'build-target', '{}', '{}', '{}',
       'sha256:target', 'admitted', 'user-1', ?)`,
  ).run(TARGET_REVISION_ID, INSTANCE_ID, REPOSITORY_ID, NOW - 1000);
  db.database.prepare(
    "UPDATE operations SET deployment_revision_id = ? WHERE operation_id = ?",
  ).run(TARGET_REVISION_ID, OPERATION_ID);
}

function recoveryEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    instanceId: INSTANCE_ID,
    repositoryId: REPOSITORY_ID,
    generation: 8,
    runtimeEpoch: 5,
    clusterId: CLUSTER_ID,
    reservationId: TARGET_RESERVATION_ID,
    actualImageDigest: "sha256:target",
    imageIdentityVerified: true,
    census: {
      complete: true,
      providerObservationId: "provider-observation-target-88",
      observedAt: new Date(NOW - 500).toISOString(),
      matchedWriterCount: 1,
      writers: [{ runtimeEpoch: 5, phase: "running", identities: ["pod-uid-target"] }],
    },
    ...overrides,
  };
}

async function prepareRecoverableOperation(h: Awaited<ReturnType<typeof harness>>): Promise<void> {
  seedAdmittedTarget(h.db);
  const proof = absenceCheckpoint();
  const fence = {
    operationId: OPERATION_ID,
    workerId: WORKER_ID,
    leaseToken: LEASE_TOKEN,
    leaseEpoch: 4,
  };
  await h.operations.checkpoint({
    ...fence,
    expectedCheckpointSequence: 0,
    phase: "old-writer-absent",
    checkpoint: proof,
    now: NOW,
  });
  await h.operations.checkpoint({
    ...fence,
    expectedCheckpointSequence: 1,
    phase: "starting-target",
    checkpoint: proof,
    now: NOW,
  });
}

function registration(input: {
  readonly token: string;
  readonly epoch: 4 | 5;
}): Record<string, unknown> {
  const old = input.epoch === 4;
  const runtimeId = old ? CURRENT_RESERVATION_ID : TARGET_RESERVATION_ID;
  return {
    tokenId: input.token.repeat(64),
    repositoryId: REPOSITORY_ID,
    installationId: INSTALLATION_ID,
    instanceId: physicalInstanceId(INSTANCE_ID, input.epoch, null),
    runtimeId,
    runtimeEpoch: input.epoch,
    leaseId: runtimeId,
    permission: "read",
    expiresAt: new Date(NOW + 120_000).toISOString(),
    encryptedSecret: {
      version: 1,
      keyId: "gateway-kek-test",
      iv: "AAAAAAAAAAAAAAAA",
      ciphertext: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    },
  };
}

function jsonInit(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function harness(
  options: {
    readonly now?: { value: number };
    readonly gateway?: (
      request: Request,
      app: ReturnType<typeof createRuntimeGitCredentialRoutes>,
    ) => Promise<Response>;
    readonly publish?: (
      db: D1Database,
      operation: Parameters<typeof publishRuntimeAuthority>[1],
      now: number,
    ) => Promise<boolean>;
  } = {},
) {
  const db = new SQLiteD1();
  installSchema(db);
  seedOperation(db);
  const clock = options.now ?? { value: NOW };
  const operations = new OperationService(new D1PlatformStore(db), () => "unused-generated-lease");
  const seed = await operations.getById(OPERATION_ID);
  if (!seed) throw new Error("missing operation fixture");
  // Establish the pre-transition observed writer through the real fenced publisher.
  expect(await publishRuntimeAuthority(db, seed, clock.value)).toBe(true);

  const credentials = new D1RuntimeGitCredentialStore(db);
  const credentialApp = createRuntimeGitCredentialRoutes({
    db,
    credentials,
    now: () => clock.value,
  });
  const gateway = options.gateway
    ? { fetch: (request: Request) => options.gateway!(request, credentialApp) }
    : undefined;
  const retireCredentials = createCredentialRetirementBarrier({
    db,
    ...(gateway ? { gateway } : {}),
    serviceSecret: "s".repeat(32),
    now: () => clock.value,
  });
  const app = createProvisionerRoutes({
    operations,
    workerId: WORKER_ID,
    clusterId: CLUSTER_ID,
    now: () => clock.value,
    resolveRuntimeContext: async () => ({}),
    retireCredentials,
    publishRuntimeAuthority: options.publish
      ? (operation, now) => options.publish!(db, operation, now)
      : (operation, now) => publishRuntimeAuthority(db, operation, now),
    recoverRuntimeAuthority: createRuntimeAuthorityRecovery({
      db,
      operations,
      now: () => clock.value,
    }),
  });
  app.onError((error, context) => {
    if (error instanceof OperationFenceConflict)
      return context.json({ error: { code: error.code } }, 409);
    return context.json({ error: { code: "INJECTED_FAILURE" } }, 500);
  });
  return {
    db,
    clock,
    operations,
    credentials,
    credentialApp,
    app,
    reader: createRuntimeBindingMetadataReader({ db, now: () => clock.value }),
  };
}

function checkpointRequest(
  phase: "quiescing-old" | "old-writer-absent" | "accepted",
  expectedCheckpointSequence: number,
  checkpoint: Record<string, unknown>,
): RequestInit {
  return jsonInit({
    operationId: OPERATION_ID,
    workerId: WORKER_ID,
    leaseToken: LEASE_TOKEN,
    leaseEpoch: 4,
    expectedCheckpointSequence,
    phase,
    checkpoint,
  });
}

function quiescingCheckpoint(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    lifecycle: {
      instanceId: INSTANCE_ID,
      repositoryId: REPOSITORY_ID,
      quiesceRequest: {
        contractVersion: "scriptorium-platform/v1",
        operationId: OPERATION_ID,
        instanceId: INSTANCE_ID,
        runtimeEpoch: 4,
        reason: "redeploy",
        deadline: new Date(NOW + 10_000).toISOString(),
      },
    },
  };
}

function absenceCheckpoint(): Record<string, unknown> {
  const proof = {
    instanceId: INSTANCE_ID,
    repositoryId: REPOSITORY_ID,
    retiredRuntimeEpoch: 4,
    providerObservationId: "provider-observation-61",
    censusObservedAt: new Date(NOW - 500).toISOString(),
    remainingWriters: 0,
    evidenceIdentities: ["provider-pod-17"],
    source: "runtime-provider-census",
  };
  return {
    schemaVersion: 1,
    lifecycle: { instanceId: INSTANCE_ID, repositoryId: REPOSITORY_ID, writerAbsenceProof: proof },
    writerAbsenceProof: proof,
  };
}

async function register(
  app: ReturnType<typeof createRuntimeGitCredentialRoutes>,
  input: Record<string, unknown>,
): Promise<string> {
  const response = await app.request("/internal/runtime-credentials", jsonInit(input));
  expect(response.status).toBe(200);
  return ((await response.json()) as { status: string }).status;
}

async function statusOf(db: SQLiteD1, tokenId: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT status FROM runtime_git_credentials WHERE token_id = ?")
    .bind(tokenId)
    .first<{ status: string }>();
  return row?.status ?? null;
}

async function checkpointCount(db: SQLiteD1): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS count FROM operation_checkpoints WHERE operation_id = ?")
    .bind(OPERATION_ID)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function fakeRevocationGateway(
  request: Request,
  app: ReturnType<typeof createRuntimeGitCredentialRoutes>,
  options: {
    readonly afterSnapshot?: (tokenIds: readonly string[]) => Promise<void>;
    readonly revoke?: (tokenId: string) => boolean;
  } = {},
): Promise<Response> {
  const body = (await request.json()) as { repositoryId: number; runtimeEpoch: number };
  const pendingResponse = await app.request(
    "/internal/runtime-credentials/pending",
    jsonInit({ repositoryId: body.repositoryId, runtimeEpoch: body.runtimeEpoch }),
  );
  expect(pendingResponse.status).toBe(200);
  const pending = (await pendingResponse.json()) as {
    credentials: { tokenId: string }[];
    remaining: number;
  };
  await options.afterSnapshot?.(pending.credentials.map(({ tokenId }) => tokenId));
  for (const item of pending.credentials) {
    if (options.revoke && !options.revoke(item.tokenId)) continue;
    // The fake GitHub accepts this token's revocation; acknowledge it via the real CP route.
    const response = await app.request(
      `/internal/runtime-credentials/${item.tokenId}/revoked`,
      jsonInit({}),
    );
    expect(response.status).toBe(200);
  }
  return new Response(null, { status: 204 });
}

afterEach(() => {
  for (const database of liveDatabases.splice(0)) database.close();
});

describe("runtime authority checkpoint recovery", () => {
  it("restores a NULL target grant only from a fresh, fenced target census and persisted absence proof", async () => {
    const h = await harness();
    await prepareRecoverableOperation(h);
    const before = await h.reader.getCurrent(REPOSITORY_ID);
    expect(before).toBeNull();
    const request = {
      operationId: OPERATION_ID,
      workerId: WORKER_ID,
      leaseToken: LEASE_TOKEN,
      leaseEpoch: 4,
      expectedCheckpointSequence: 2,
      evidence: recoveryEvidence(),
    };
    const response = await h.app.request("/runtime-authority/recover", jsonInit(request));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ recovered: true });
    const replay = await h.app.request("/runtime-authority/recover", jsonInit(request));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ recovered: true });
    expect(await h.reader.getCurrent(REPOSITORY_ID)).toMatchObject({
      authority: "post-absence-target",
      runtimeEpoch: 5,
      runtimeId: TARGET_RESERVATION_ID,
    });
    expect(await checkpointCount(h.db)).toBe(2);
    expect(h.db.database.prepare(
      "SELECT count(*) AS count FROM audit_events WHERE action = 'runtime.authority.recovery-evidence-admitted'",
    ).get()).toEqual({ count: 1 });
    expect(h.db.database.prepare(
      "SELECT action, outcome FROM audit_events WHERE operation_id = ?",
    ).all(OPERATION_ID)).toContainEqual({
      action: "runtime.authority.recovery-evidence-admitted",
      outcome: "recorded",
    });
  });

  it.each([
    ["stale lease", { leaseToken: "stale-lease-token-that-is-long-enough-to-parse" }, {}],
    ["wrong generation", {}, { generation: 7 }],
    ["wrong target epoch", {}, { runtimeEpoch: 4 }],
    ["wrong admitted digest", {}, { actualImageDigest: "sha256:other" }],
    ["incomplete census", {}, { census: {
      complete: false, providerObservationId: "provider-observation-target-88",
      observedAt: new Date(NOW - 500).toISOString(), matchedWriterCount: 1,
      writers: [{ runtimeEpoch: 5, phase: "running", identities: ["pod-uid-target"] }],
    } }],
    ["multiple writers", {}, { census: {
      complete: true, providerObservationId: "provider-observation-target-88",
      observedAt: new Date(NOW - 500).toISOString(), matchedWriterCount: 2,
      writers: [
        { runtimeEpoch: 5, phase: "running", identities: ["pod-uid-target"] },
        { runtimeEpoch: 4, phase: "running", identities: ["pod-uid-old"] },
      ],
    } }],
  ] as const)("rejects %s without restoring authority", async (_label, requestOverrides, evidenceOverrides) => {
    const h = await harness();
    await prepareRecoverableOperation(h);
    const response = await h.app.request("/runtime-authority/recover", jsonInit({
      operationId: OPERATION_ID,
      workerId: WORKER_ID,
      leaseToken: LEASE_TOKEN,
      leaseEpoch: 4,
      expectedCheckpointSequence: 2,
      evidence: recoveryEvidence(evidenceOverrides),
      ...requestOverrides,
    }));
    expect(response.status).toBe(409);
    expect(await h.reader.getCurrent(REPOSITORY_ID)).toBeNull();
    expect(await checkpointCount(h.db)).toBe(2);
  });

  it("records fresh census evidence but keeps authority absent while retired Git credentials remain", async () => {
    const h = await harness();
    await prepareRecoverableOperation(h);
    await register(h.credentialApp, registration({ token: "a", epoch: 4 }));
    const response = await h.app.request("/runtime-authority/recover", jsonInit({
      operationId: OPERATION_ID,
      workerId: WORKER_ID,
      leaseToken: LEASE_TOKEN,
      leaseEpoch: 4,
      expectedCheckpointSequence: 2,
      evidence: recoveryEvidence(),
    }));
    expect(response.status).toBe(409);
    expect(await h.reader.getCurrent(REPOSITORY_ID)).toBeNull();
    expect(h.db.database.prepare(
      "SELECT count(*) AS count FROM audit_events WHERE action = 'runtime.authority.recovery-evidence-admitted'",
    ).get()).toEqual({ count: 1 });
  });

  it.each([
    ["lease expiry", 30_000, new Date(NOW).toISOString()],
    ["census age limit", 29_501, new Date(NOW - 500).toISOString()],
  ] as const)("does not publish when the %s elapses during durable audit read", async (_label, elapsed, observedAt) => {
    const h = await harness();
    await prepareRecoverableOperation(h);
    h.db.beforeFirst = (query) => {
      if (query.includes("FROM audit_events WHERE event_id")) {
        h.db.beforeFirst = undefined;
        h.clock.value = NOW + elapsed;
      }
    };
    const response = await h.app.request("/runtime-authority/recover", jsonInit({
      operationId: OPERATION_ID,
      workerId: WORKER_ID,
      leaseToken: LEASE_TOKEN,
      leaseEpoch: 4,
      expectedCheckpointSequence: 2,
      evidence: recoveryEvidence({
        census: {
          complete: true,
          providerObservationId: "provider-observation-target-88",
          observedAt,
          matchedWriterCount: 1,
          writers: [{ runtimeEpoch: 5, phase: "running", identities: ["pod-uid-target"] }],
        },
      }),
    }));
    expect(response.status).toBe(409);
    expect(await h.reader.getCurrent(REPOSITORY_ID)).toBeNull();
    expect(await checkpointCount(h.db)).toBe(2);
  });

  it("keeps authority absent through failed and partial retirement while a stale registrar races", async () => {
    let gatewayCalls = 0;
    let staleRegistrationStatus = "";
    let staleInjected = false;
    const h = await harness({
      gateway: async (request, app) => {
        gatewayCalls += 1;
        if (gatewayCalls === 1) throw new Error("simulated retirement response loss");
        if (gatewayCalls === 2) {
          const firstId = "a".repeat(64);
          return fakeRevocationGateway(request, app, {
            afterSnapshot: async () => {
              expect(staleInjected).toBe(false);
              staleInjected = true;
              staleRegistrationStatus = await register(app, registration({ token: "b", epoch: 4 }));
            },
            revoke: (tokenId) => tokenId === firstId,
          });
        }
        return fakeRevocationGateway(request, app);
      },
    });
    const oldToken = registration({ token: "a", epoch: 4 });
    expect(await register(h.credentialApp, oldToken)).toBe("active");
    expect((await h.reader.getCurrent(REPOSITORY_ID))?.authority).toBe("observed-writer");

    const quiesce = quiescingCheckpoint();
    const failedRetirement = await h.app.request(
      "/checkpoint",
      checkpointRequest("quiescing-old", 0, quiesce),
    );
    expect(failedRetirement.status).toBe(500);
    expect(await checkpointCount(h.db)).toBe(1);
    expect(await statusOf(h.db, oldToken.tokenId as string)).toBe("revocation_pending");
    expect(await h.reader.getCurrent(REPOSITORY_ID)).toBeNull();

    const incomplete = await h.app.request(
      "/checkpoint",
      checkpointRequest("quiescing-old", 0, quiesce),
    );
    expect(incomplete.status).toBe(202);
    expect(staleRegistrationStatus).toBe("revocation_pending");
    expect(await checkpointCount(h.db)).toBe(1);
    expect(await statusOf(h.db, oldToken.tokenId as string)).toBe("revoked");
    expect(await statusOf(h.db, "b".repeat(64))).toBe("revocation_pending");
    expect(await h.reader.getCurrent(REPOSITORY_ID)).toBeNull();

    const quiesceRecovered = await h.app.request(
      "/checkpoint",
      checkpointRequest("quiescing-old", 0, quiesce),
    );
    expect(quiesceRecovered.status).toBe(200);
    expect(await checkpointCount(h.db)).toBe(1);
    expect(await statusOf(h.db, "b".repeat(64))).toBe("revoked");
    expect(await h.reader.getCurrent(REPOSITORY_ID)).toBeNull();
    expect(gatewayCalls).toBe(3);
  });

  it("converges after target publication response loss without duplicating or reviving credentials", async () => {
    let targetPublishAttempts = 0;
    const h = await harness({
      gateway: async (request, app) => fakeRevocationGateway(request, app),
      publish: async (db, operation, now) => {
        if (operation.phase === "old-writer-absent") {
          targetPublishAttempts += 1;
          if (targetPublishAttempts === 1)
            throw new Error("simulated publication failure before D1");
        }
        const result = await publishRuntimeAuthority(db, operation, now);
        if (operation.phase === "old-writer-absent" && targetPublishAttempts === 2) {
          throw new Error("simulated publication response loss after commit");
        }
        return result;
      },
    });
    const oldToken = registration({ token: "a", epoch: 4 });
    expect(await register(h.credentialApp, oldToken)).toBe("active");
    const quiesce = await h.app.request(
      "/checkpoint",
      checkpointRequest("quiescing-old", 0, quiescingCheckpoint()),
    );
    expect(quiesce.status).toBe(200);
    expect(await statusOf(h.db, oldToken.tokenId as string)).toBe("revoked");
    expect(await h.reader.getCurrent(REPOSITORY_ID)).toBeNull();

    const absence = absenceCheckpoint();
    const lostPublication = await h.app.request(
      "/checkpoint",
      checkpointRequest("old-writer-absent", 1, absence),
    );
    expect(lostPublication.status).toBe(500);
    expect(await checkpointCount(h.db)).toBe(2);
    expect(await statusOf(h.db, oldToken.tokenId as string)).toBe("revoked");
    expect(await h.reader.getCurrent(REPOSITORY_ID)).toBeNull();

    const committedButLost = await h.app.request(
      "/checkpoint",
      checkpointRequest("old-writer-absent", 1, absence),
    );
    expect(committedButLost.status).toBe(500);
    expect(await checkpointCount(h.db)).toBe(2);
    expect(await statusOf(h.db, oldToken.tokenId as string)).toBe("revoked");
    expect(await h.reader.getCurrent(REPOSITORY_ID)).toMatchObject({
      authority: "post-absence-target",
      runtimeEpoch: 5,
      runtimeId: TARGET_RESERVATION_ID,
    });

    const targetReplay = await h.app.request(
      "/checkpoint",
      checkpointRequest("old-writer-absent", 1, absence),
    );
    expect(targetReplay.status).toBe(200);
    expect(await checkpointCount(h.db)).toBe(2);
    expect(await statusOf(h.db, oldToken.tokenId as string)).toBe("revoked");

    // A stale epoch can register after publication, but the atomic D1 predicate
    // stores it pending and prevents reuse; target-epoch registration is active.
    expect(await register(h.credentialApp, registration({ token: "c", epoch: 4 }))).toBe(
      "revocation_pending",
    );
    const staleReuse = await h.credentialApp.request(
      "/internal/runtime-credentials/reuse",
      jsonInit({
        repositoryId: REPOSITORY_ID,
        installationId: INSTALLATION_ID,
        instanceId: physicalInstanceId(INSTANCE_ID, 4, null),
        runtimeId: CURRENT_RESERVATION_ID,
        runtimeEpoch: 4,
        leaseId: CURRENT_RESERVATION_ID,
        permission: "read",
      }),
    );
    expect(await staleReuse.json()).toEqual({ credential: null });
    expect(await register(h.credentialApp, oldToken)).toBe("revoked");
    const targetToken = registration({ token: "d", epoch: 5 });
    expect(await register(h.credentialApp, targetToken)).toBe("active");
    const targetReuse = await h.credentialApp.request(
      "/internal/runtime-credentials/reuse",
      jsonInit({
        repositoryId: REPOSITORY_ID,
        installationId: INSTALLATION_ID,
        instanceId: physicalInstanceId(INSTANCE_ID, 5, null),
        runtimeId: TARGET_RESERVATION_ID,
        runtimeEpoch: 5,
        leaseId: TARGET_RESERVATION_ID,
        permission: "read",
      }),
    );
    expect(
      ((await targetReuse.json()) as { credential?: { tokenId: string } }).credential?.tokenId,
    ).toBe(targetToken.tokenId);
  });

  it("does not publish after the lease expires inside the final retirement barrier", async () => {
    const clock = { value: NOW };
    const h = await harness({
      now: clock,
      gateway: async (request, app) => fakeRevocationGateway(request, app),
    });
    const activeToken = registration({ token: "e", epoch: 4 });
    expect(await register(h.credentialApp, activeToken)).toBe("active");
    const qResponse = await h.app.request(
      "/checkpoint",
      checkpointRequest("quiescing-old", 0, quiescingCheckpoint()),
    );
    expect(qResponse.status).toBe(200);
    expect(await h.reader.getCurrent(REPOSITORY_ID)).toBeNull();

    // A registration that began with the retired runtime identity after the
    // quiesce fence is itself pending, so the final barrier must drain it.
    const late = registration({ token: "f", epoch: 4 });
    expect(await register(h.credentialApp, late)).toBe("revocation_pending");
    let expiredInsideBarrier = false;
    // Replace only the local test's final Gateway behavior by advancing time
    // after the real revocation acknowledgement for the pending late token.
    const expiryApp = createProvisionerRoutes({
      operations: h.operations,
      workerId: WORKER_ID,
      clusterId: CLUSTER_ID,
      now: () => clock.value,
      resolveRuntimeContext: async () => ({}),
      retireCredentials: createCredentialRetirementBarrier({
        db: h.db,
        serviceSecret: "s".repeat(32),
        now: () => clock.value,
        gateway: {
          async fetch(request) {
            const response = await fakeRevocationGateway(request, h.credentialApp);
            clock.value = NOW + 31_000;
            expiredInsideBarrier = true;
            return response;
          },
        },
      }),
      publishRuntimeAuthority: (operation, now) => publishRuntimeAuthority(h.db, operation, now),
    });
    expiryApp.onError((error, context) => {
      if (error instanceof OperationFenceConflict)
        return context.json({ error: { code: error.code } }, 409);
      return context.json({ error: { code: "INJECTED_FAILURE" } }, 500);
    });
    const absent = await expiryApp.request(
      "/checkpoint",
      checkpointRequest("old-writer-absent", 1, absenceCheckpoint()),
    );
    expect(expiredInsideBarrier).toBe(true);
    expect(absent.status).toBe(409);
    expect(await checkpointCount(h.db)).toBe(2);
    expect(await statusOf(h.db, activeToken.tokenId as string)).toBe("revoked");
    expect(await statusOf(h.db, late.tokenId as string)).toBe("revoked");
    expect(await h.reader.getCurrent(REPOSITORY_ID)).toBeNull();
  });

  it("replays an accepted resume checkpoint after a published response is lost", async () => {
    let loseResponse = true;
    let gatewayCalls = 0;
    const h = await harness({
      gateway: async (request, app) => {
        gatewayCalls += 1;
        return fakeRevocationGateway(request, app);
      },
      publish: async (db, operation, now) => {
        const result = await publishRuntimeAuthority(db, operation, now);
        if (operation.phase === "accepted" && loseResponse) {
          loseResponse = false;
          throw new Error("simulated accepted publication response loss");
        }
        return result;
      },
    });
    const token = registration({ token: "1", epoch: 4 });
    expect(await register(h.credentialApp, token)).toBe("active");
    const quiesce = await h.app.request(
      "/checkpoint",
      checkpointRequest("quiescing-old", 0, quiescingCheckpoint()),
    );
    expect(quiesce.status).toBe(200);
    expect(await statusOf(h.db, token.tokenId as string)).toBe("revoked");
    expect(await h.reader.getCurrent(REPOSITORY_ID)).toBeNull();

    const accepted = {
      schemaVersion: 1,
      lifecycle: {
        instanceId: INSTANCE_ID,
        repositoryId: REPOSITORY_ID,
        quiesceRequest: null,
        quiesceReceipt: null,
      },
    };
    const lostResponse = await h.app.request(
      "/checkpoint",
      checkpointRequest("accepted", 1, accepted),
    );
    expect(lostResponse.status).toBe(500);
    expect(await checkpointCount(h.db)).toBe(2);
    expect(await h.reader.getCurrent(REPOSITORY_ID)).toMatchObject({
      authority: "observed-writer",
      runtimeEpoch: 4,
    });
    expect(await statusOf(h.db, token.tokenId as string)).toBe("revoked");

    const changedPayload = await h.app.request(
      "/checkpoint",
      checkpointRequest("accepted", 1, { ...accepted, unsafe: true }),
    );
    expect(changedPayload.status).toBe(409);
    expect(await checkpointCount(h.db)).toBe(2);

    for (const fence of [{ leaseToken: "x".repeat(64) }, { leaseEpoch: 2 }]) {
      const request = checkpointRequest("accepted", 1, accepted);
      request.body = JSON.stringify({ ...JSON.parse(String(request.body)), ...fence });
      const wrongFence = await h.app.request("/checkpoint", request);
      expect(wrongFence.status).toBe(409);
      expect(await checkpointCount(h.db)).toBe(2);
    }

    const replay = await h.app.request("/checkpoint", checkpointRequest("accepted", 1, accepted));
    expect(replay.status).toBe(200);
    expect(await checkpointCount(h.db)).toBe(2);
    expect(gatewayCalls).toBe(1);
    expect(await statusOf(h.db, token.tokenId as string)).toBe("revoked");
    expect(await h.reader.getCurrent(REPOSITORY_ID)).toMatchObject({
      authority: "observed-writer",
      runtimeEpoch: 4,
    });

    h.clock.value = NOW + 31_000;
    const staleLeaseReplay = await h.app.request(
      "/checkpoint",
      checkpointRequest("accepted", 1, accepted),
    );
    expect(staleLeaseReplay.status).toBe(409);
    expect(await checkpointCount(h.db)).toBe(2);
  });
});
