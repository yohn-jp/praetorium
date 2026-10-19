import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  BuildInputSchema,
  ResourceRequirementsSchema,
  RuntimeMetadataSchema,
  buildKey,
  canonicalBuildInput,
} from "@praetorium/contracts";
import type {
  ConfigurationStageActivationMutation,
  ConfigurationStageMutation,
} from "@praetorium/application/configurations";
import { ConfigurationIdempotencyConflictError } from "@praetorium/application/configurations";
import { D1ConfigurationStore } from "../src/d1/configuration-store.js";
import type { D1Database, D1PreparedStatement, D1Result } from "../src/d1/types.js";

type BindValue = string | number | null | ArrayBuffer | Uint8Array;

class SQLiteD1Statement implements D1PreparedStatement {
  private values: readonly BindValue[] = [];

  constructor(
    private readonly sql: string,
    private readonly statement: StatementSync,
  ) {}

  bind(...values: BindValue[]): D1PreparedStatement {
    this.values = values;
    return this;
  }

  private sqlValues(): SQLInputValue[] {
    return this.values.map((value) => {
      if (value instanceof ArrayBuffer) return new Uint8Array(value);
      return value;
    });
  }

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.sqlValues()) as T | undefined) ?? null;
  }

  async all<T>(): Promise<D1Result<T>> {
    return {
      results: this.statement.all(...this.sqlValues()) as T[],
      meta: { changes: 0 },
    };
  }

  async run<T>(): Promise<D1Result<T>> {
    const result = this.statement.run(...this.sqlValues());
    return { results: [], meta: { changes: Number(result.changes) } };
  }

  execute(): D1Result<unknown> {
    const result = this.statement.run(...this.sqlValues());
    return { results: [], meta: { changes: Number(result.changes) } };
  }
}

class SQLiteD1 implements D1Database {
  readonly database = new DatabaseSync(":memory:");

  constructor() {
    this.database.exec("PRAGMA foreign_keys = ON");
    for (const path of [
      "../../../apps/control-plane/migrations/0001_repository_platform.sql",
      "../../../apps/control-plane/migrations/0002_stable_release_rollouts.sql",
      "../../../apps/control-plane/migrations/0003_staged_configurations.sql",
      "../../../apps/control-plane/migrations/0006_application_origins.sql",
    ]) {
      this.database.exec(readFileSync(new URL(path, import.meta.url), "utf8"));
    }
  }

  prepare(sql: string): D1PreparedStatement {
    return new SQLiteD1Statement(sql, this.database.prepare(sql));
  }

  async batch<T>(statements: readonly D1PreparedStatement[]): Promise<readonly D1Result<T>[]> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => (statement as SQLiteD1Statement).execute());
      this.database.exec("COMMIT");
      return results as D1Result<T>[];
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

const liveDatabases: SQLiteD1[] = [];
afterEach(() => {
  for (const db of liveDatabases.splice(0)) db.database.close();
});

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const DIGEST_C = `sha256:${"c".repeat(64)}`;
const BUILD_INPUT = BuildInputSchema.parse({
  contractVersion: "scriptorium-build/v1",
  producerRevision: "a".repeat(40),
  runtimeBaseDigest: DIGEST_A,
  buildKitDigest: DIGEST_B,
  recipeDigest: DIGEST_C,
  sourceDigest: DIGEST_A,
  lockDigest: DIGEST_B,
  requestedModules: [],
  resolvedModules: [],
  platform: "linux/amd64",
  options: {},
});
const RESOURCES = ResourceRequirementsSchema.parse({
  cpuMilli: 500,
  memoryMiB: 1024,
  ephemeralStorageMiB: 2048,
});
const RUNTIME_METADATA = RuntimeMetadataSchema.parse({
  contractVersion: "scriptorium-platform/v1",
  producerRevision: "a".repeat(40),
  listener: { port: 3000 },
  paths: {
    liveness: "/health/live",
    readiness: "/health/ready",
    metadata: "/api/platform/v1/metadata",
    shutdown: "/api/platform/v1/shutdown",
    status: "/api/platform/v1/status",
    quiesce: "/api/platform/v1/quiesce",
    resume: "/api/platform/v1/resume",
  },
  shutdownTimeoutSeconds: 30,
});
const SELECTION = {
  releaseId: "release-1",
  requestedModules: [],
  resourceProfileId: "standard",
  policy: "stable",
} as const;

async function createStage(db: SQLiteD1) {
  const key = await buildKey(BUILD_INPUT);
  const store = new D1ConfigurationStore(db);
  db.database
    .prepare(
      `INSERT INTO logical_instances (
         instance_id, repository_id, generation, runtime_epoch, desired_state, policy,
         desired_revision_id, desired_artifact_digest, created_at, updated_at
       ) VALUES ('instance-1', 101, 2, 3, 'running', 'stable', 'revision-current', NULL, 1, 1)`,
    )
    .run();
  db.database
    .prepare(
      `INSERT INTO repository_bindings (
         repository_id, instance_id, installation_id, owner, name,
         authorization_revision, binding_epoch, suspended, created_at, updated_at
       ) VALUES (101, 'instance-1', 201, 'owner', 'repo', 4, 7, 0, 1, 1)`,
    )
    .run();
  const priorInput = { ...BUILD_INPUT, runtimeBaseDigest: DIGEST_C };
  const priorKey = await buildKey(priorInput);
  db.database
    .prepare(
      `INSERT INTO builds (
         build_id, build_key, build_input_json, status, created_at, updated_at
       ) VALUES ('build-current', ?, ?, 'succeeded', 1, 1)`,
    )
    .run(priorKey, canonicalBuildInput(priorInput));
  db.database
    .prepare(
      `INSERT INTO deployment_revisions (
         revision_id, instance_id, repository_id, generation, build_key, build_id,
         selection_json, resource_requirements_json, runtime_metadata_json, artifact_digest,
         status, actor_id, created_at
       ) VALUES ('revision-current', 'instance-1', 101, 2, ?, 'build-current', ?, ?, ?, NULL,
         'admitted', 'system:seed', 1)`,
    )
    .run(
      priorKey,
      JSON.stringify({ ...SELECTION, releaseId: "release-old" }),
      JSON.stringify(RESOURCES),
      JSON.stringify(RUNTIME_METADATA),
    );
  const input: ConfigurationStageMutation = {
    repositoryId: 101,
    instanceId: "instance-1",
    bindingEpoch: 7,
    authorizationRevision: 4,
    expectedGeneration: 2,
    expectedRuntimeEpoch: 3,
    expectedPolicy: "stable",
    expectedDesiredState: "running",
    selection: SELECTION,
    buildInput: BUILD_INPUT,
    buildKey: key,
    resources: RESOURCES,
    runtimeMetadata: RUNTIME_METADATA,
    actorId: "system:stable-release",
    idempotencyKey: "stable-rollout-build:release-1:instance-1:revision-current",
    requestHash: `sha256:${"d".repeat(64)}`,
    requestId: "request-stage-1",
    stageId: "stage-1",
    buildId: "build-stage-1",
    now: 10,
  };
  const receipt = await store.stageConfiguration(input);
  if (!receipt) throw new Error("configuration stage did not persist");
  return { store, input, receipt, key };
}

function seedAdmittedArtifact(db: SQLiteD1, buildKeyValue: string, artifactDigest: string): void {
  db.database
    .prepare(
      `INSERT INTO build_attempts (
         attempt_id, build_id, lease_epoch, worker_id, status, lease_token, lease_expires_at,
         report_sequence, last_report_digest, progress_json, candidate_ref, manifest_digest,
         failure_json, started_at, updated_at, finished_at
       ) VALUES ('attempt-1', 'build-stage-1', 1, 'builder-1', 'succeeded', 'lease-token', 1000,
         1, 'report-digest', NULL, 'oci://candidate', ?, NULL, 20, 30, 30)`,
    )
    .run(artifactDigest);
  db.database
    .prepare(
      `UPDATE builds SET status='succeeded', attempt_count=1, lease_epoch=1,
         active_attempt_id='attempt-1', worker_id='builder-1', lease_token='lease-token',
         lease_expires_at=1000, report_sequence=1, last_report_digest='report-digest',
         manifest_digest=?, artifact_digest=?, updated_at=30 WHERE build_id='build-stage-1'`,
    )
    .run(artifactDigest, artifactDigest);
  db.database
    .prepare(
      `INSERT INTO artifacts (
         artifact_digest, build_key, build_id, attempt_id, manifest_digest,
         platform_manifest_digest, composition_manifest_digest, producer_revision,
         requested_modules_json, resolved_modules_json, contract_versions_json,
         sbom_ref, provenance_ref, verification_json, statement_json, signature_json,
         verifier_id, status, created_at, admitted_at
       ) VALUES (?, ?, 'build-stage-1', 'attempt-1', ?, ?, ?, ?, '[]', '[]', '{}',
         NULL, NULL, '{}', '{}', '{}', 'test-verifier', 'admitted', 30, 30)`,
    )
    .run(
      artifactDigest,
      buildKeyValue,
      artifactDigest,
      artifactDigest,
      artifactDigest,
      "a".repeat(40),
    );
}

function seedCurrentStableRollout(
  db: SQLiteD1,
  stage: Awaited<ReturnType<typeof createStage>>,
  artifactDigest: string,
): void {
  db.database
    .prepare(
      `INSERT INTO release_candidates (
         release_id, image_digest, version, image_repository, status, candidate_json, created_at
       ) VALUES ('release-1', ?, '1.0.0', 'example/runtime', 'available', '{}', '2026-01-01T00:00:00.000Z')`,
    )
    .run(DIGEST_C);
  db.database
    .prepare(
      `UPDATE stable_release_channels SET current_release_id='release-1', revision=1, updated_at=40
       WHERE channel_key='stable'`,
    )
    .run();
  const snapshot = {
    instanceId: "instance-1",
    repositoryId: 101,
    bindingEpoch: 7,
    authorizationRevision: 4,
    clusterId: "cluster-1",
    generation: 2,
    runtimeEpoch: 3,
    desiredState: "running",
    policy: "stable",
    desiredReleaseId: "release-old",
    desiredArtifactDigest: DIGEST_B,
    currentArtifactDigest: DIGEST_B,
    configurationRevision: "revision-current",
    selectedModuleIds: [],
    resourceProfileId: "standard",
    platform: "linux/amd64",
  };
  db.database
    .prepare(
      `INSERT INTO stable_rollouts (
         rollout_id, release_id, instance_id, cluster_id, snapshot_json, state, revision,
         build_key, build_id, artifact_digest, updated_at
       ) VALUES ('rollout-1', 'release-1', 'instance-1', 'cluster-1', ?, 'dispatch_pending', 6,
         ?, 'build-stage-1', ?, 40)`,
    )
    .run(JSON.stringify(snapshot), stage.key, artifactDigest);
  db.database
    .prepare(
      `INSERT INTO cluster_rollout_leases (
         cluster_id, rollout_id, owner, lease_epoch, lease_expires_at, active_operation_id, updated_at
       ) VALUES ('cluster-1', 'rollout-1', 'rollout-worker', 9, 1000, NULL, 40)`,
    )
    .run();
}

function activationInput(
  stage: Awaited<ReturnType<typeof createStage>>,
  artifactDigest: string,
): ConfigurationStageActivationMutation {
  return {
    stageId: stage.receipt.stage.stageId,
    clusterId: "cluster-1",
    rolloutId: "rollout-1",
    releaseId: "release-1",
    owner: "rollout-worker",
    leaseEpoch: 9,
    expectedRolloutRevision: 6,
    expectedBuildKey: stage.key,
    expectedBuildId: "build-stage-1",
    expectedArtifactDigest: artifactDigest,
    actorId: "system:stable-release",
    actorKind: "system",
    operationId: "operation-stable-1",
    operationIdempotencyKey: "stable-rollout:release-1:instance-1:2:build-key",
    requestId: "stable-rollout:rollout-1",
    now: 50,
  };
}

describe("D1ConfigurationStore staged configuration", () => {
  it("persists a reusable build snapshot without changing desired state or creating operations", async () => {
    const db = new SQLiteD1();
    liveDatabases.push(db);
    const { store, input, receipt, key } = await createStage(db);

    expect(receipt).toMatchObject({
      stage: {
        stageId: "stage-1",
        expectedGeneration: 2,
        expectedRuntimeEpoch: 3,
        expectedPolicy: "stable",
        expectedDesiredState: "running",
        buildKey: key,
        buildId: "build-stage-1",
        status: "staged",
      },
      build: { status: "pending", artifactDigest: null },
      replayed: false,
    });
    expect(
      await store.findStageByIdempotency({
        repositoryId: input.repositoryId,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
      }),
    ).toMatchObject({ stage: { stageId: "stage-1" } });
    expect(await store.getByInstance("instance-1")).toMatchObject({
      instance: { generation: 2, runtimeEpoch: 3, desiredRevisionId: "revision-current" },
    });
    expect(
      db.database.prepare("SELECT count(*) AS count FROM deployment_revisions").get(),
    ).toMatchObject({
      count: 1,
    });
    expect(db.database.prepare("SELECT count(*) AS count FROM operations").get()).toMatchObject({
      count: 0,
    });
    expect(
      db.database
        .prepare(
          "SELECT actor_id, actor_kind FROM audit_events WHERE action='configuration.staged'",
        )
        .get(),
    ).toMatchObject({ actor_id: "system:stable-release", actor_kind: "system" });
    expect(
      db.database.prepare("SELECT count(*) AS count FROM staged_configurations").get(),
    ).toMatchObject({
      count: 1,
    });
  });

  it("activates only an admitted stage under the live rollout lease in one D1 batch", async () => {
    const db = new SQLiteD1();
    liveDatabases.push(db);
    const stage = await createStage(db);
    seedAdmittedArtifact(db, stage.key, DIGEST_A);
    seedCurrentStableRollout(db, stage, DIGEST_A);
    const invalid = await stage.store.activateStageUnderClusterFence(
      activationInput(stage, DIGEST_C),
    );
    expect(invalid).toBeNull();
    expect(await stage.store.getByInstance("instance-1")).toMatchObject({
      instance: { generation: 2, runtimeEpoch: 3, desiredRevisionId: "revision-current" },
    });
    expect(db.database.prepare("SELECT count(*) AS count FROM operations").get()).toMatchObject({
      count: 0,
    });

    const input = activationInput(stage, DIGEST_A);
    const activated = await stage.store.activateStageUnderClusterFence(input);
    expect(activated).toMatchObject({
      stage: {
        stageId: "stage-1",
        status: "activated",
        activationGeneration: 3,
        deploymentRevisionId: "stage-1",
        operationId: "operation-stable-1",
      },
      instance: { generation: 3, runtimeEpoch: 4, desiredRevisionId: "stage-1" },
      revision: {
        revisionId: "stage-1",
        generation: 3,
        artifactDigest: DIGEST_A,
        status: "admitted",
      },
      operation: {
        id: "operation-stable-1",
        generation: 3,
        runtimeEpoch: 4,
        deploymentRevisionId: "stage-1",
        clusterId: "cluster-1",
        status: "pending",
      },
      operationId: "operation-stable-1",
      generation: 3,
      replayed: false,
    });
    expect(
      db.database
        .prepare(
          "SELECT state, revision, operation_id FROM stable_rollouts WHERE rollout_id='rollout-1'",
        )
        .get(),
    ).toMatchObject({
      state: "operation_pending",
      revision: 7,
      operation_id: "operation-stable-1",
    });
    expect(
      db.database
        .prepare(
          "SELECT active_operation_id FROM cluster_rollout_leases WHERE cluster_id='cluster-1'",
        )
        .get(),
    ).toMatchObject({
      active_operation_id: "operation-stable-1",
    });
    expect(
      db.database
        .prepare(
          "SELECT count(*) AS count FROM audit_events WHERE action='configuration.activated'",
        )
        .get(),
    ).toMatchObject({
      count: 1,
    });
    const replay = await stage.store.activateStageUnderClusterFence(input);
    expect(replay).toMatchObject({
      operationId: "operation-stable-1",
      generation: 3,
      replayed: true,
    });
    await expect(
      stage.store.activateStageUnderClusterFence({ ...input, owner: "different-owner" }),
    ).rejects.toBeInstanceOf(ConfigurationIdempotencyConflictError);
  });

  it("rejects activation if the live runtime reservation has moved to another cluster", async () => {
    const db = new SQLiteD1();
    liveDatabases.push(db);
    const stage = await createStage(db);
    seedAdmittedArtifact(db, stage.key, DIGEST_A);
    seedCurrentStableRollout(db, stage, DIGEST_A);
    db.database
      .prepare(
        `INSERT INTO runtime_reservations (
           reservation_id, instance_id, repository_id, runtime_epoch, generation, cluster_id,
           status, capacity_snapshot_epoch, cpu_milli, memory_mib, ephemeral_storage_mib,
           created_at, updated_at
         ) VALUES ('reservation-other', 'instance-1', 101, 3, 2, 'cluster-other',
           'allocated', 1, 500, 1024, 2048, 40, 40)`,
      )
      .run();
    db.database
      .prepare(
        "UPDATE logical_instances SET reservation_id='reservation-other', reservation_state='allocated' WHERE instance_id='instance-1'",
      )
      .run();

    const result = await stage.store.activateStageUnderClusterFence(
      activationInput(stage, DIGEST_A),
    );
    expect(result).toBeNull();
    expect(await stage.store.getByInstance("instance-1")).toMatchObject({
      instance: { generation: 2, runtimeEpoch: 3, reservationId: "reservation-other" },
    });
    expect(
      db.database.prepare("SELECT count(*) AS count FROM deployment_revisions").get(),
    ).toMatchObject({ count: 1 });
    expect(db.database.prepare("SELECT count(*) AS count FROM operations").get()).toMatchObject({
      count: 0,
    });
    expect(
      db.database
        .prepare(
          "SELECT active_operation_id FROM cluster_rollout_leases WHERE cluster_id='cluster-1'",
        )
        .get(),
    ).toMatchObject({ active_operation_id: null });
  });
});
