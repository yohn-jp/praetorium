import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { advanceStablePromotions, ReleaseCandidateSchema, type ReleaseCandidate } from "@praetorium/application/releases";
import type { StableFollower } from "@praetorium/application/rollouts";
import type { InstanceService } from "@praetorium/application/instances";
import type { OperationService } from "@praetorium/application/operations";
import { buildKey, canonicalBuildInput, type BuildInput } from "@praetorium/contracts";
import { D1BuildStore } from "@praetorium/persistence/d1";
import {
  stableRolloutOperationIdempotencyKey,
  stableRolloutStageIdempotencyKey,
} from "@praetorium/application/rollouts";
import { D1StableFollowerRepository } from "./stable-followers.js";
import { createProvisionerRoutes } from "../../provisioner-routes.js";
import { createT11RolloutComposition } from "../../rollout-composition.js";
import {
  D1T11ReleaseRolloutStore,
  type D1BindValue,
  type D1PreparedStatement,
  type D1Result,
  type StagedRolloutActivator,
  type T11D1Database,
} from "./t11-release-rollouts.js";
import type { CanaryWaitSkipCommand, ReleaseRetryCommand } from "../../releases/retry-contract.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const BUILD_KEY = `sha256:${"b".repeat(64)}`;
const PRODUCER = "a".repeat(40);
const TIME = "2026-01-01T00:00:00.000Z";
const NOW = Date.parse(TIME);

class SQLiteD1Statement implements D1PreparedStatement {
  private values: readonly D1BindValue[] = [];

  constructor(
    private readonly sql: string,
    private readonly statement: StatementSync,
  ) {}

  private sqlValues() {
    return this.values.map((value): SQLInputValue => {
      if (typeof value === "boolean") return Number(value);
      if (value instanceof ArrayBuffer) return new Uint8Array(value);
      return value;
    });
  }

  bind(...values: D1BindValue[]): D1PreparedStatement {
    this.values = values;
    return this;
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

  async executeBatch(): Promise<D1Result<unknown>> {
    if (/^\s*SELECT\b/iu.test(this.sql)) {
      return {
        results: this.statement.all(...this.sqlValues()) as unknown[],
        meta: { changes: 0 },
      };
    }
    const result = this.statement.run(...this.sqlValues());
    return { results: [], meta: { changes: Number(result.changes) } };
  }
}

class SQLiteD1 implements T11D1Database {
  readonly database = new DatabaseSync(":memory:");

  prepare(sql: string): SQLiteD1Statement {
    return new SQLiteD1Statement(sql, this.database.prepare(sql));
  }

  async batch<T>(statements: readonly D1PreparedStatement[]): Promise<readonly D1Result<T>[]> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results: D1Result<unknown>[] = [];
      for (const statement of statements) {
        results.push(await (statement as SQLiteD1Statement).executeBatch());
      }
      this.database.exec("COMMIT");
      return results as D1Result<T>[];
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function candidate(id = "release-1", version = "1.0.0", digest = DIGEST): ReleaseCandidate {
  return ReleaseCandidateSchema.parse({
    schemaVersion: 1,
    id,
    version,
    imageRepository: "example/runtime",
    imageDigest: digest,
    catalog: {
      contractVersion: "scriptorium-build/v1",
      producerRevision: PRODUCER,
      runtimeBaseDigest: digest,
      buildKitDigest: DIGEST,
      recipeDigest: DIGEST,
      lockDigest: DIGEST,
      sourceDigest: DIGEST,
      supportedPlatforms: ["linux/amd64"],
      modules: [],
      baseResources: { cpuMilli: 0, memoryMiB: 0, ephemeralStorageMiB: 0 },
      sharedResourceGroups: [],
      resourceProfiles: [],
    },
    runtimeMetadata: {
      contractVersion: "scriptorium-platform/v1",
      producerRevision: PRODUCER,
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
    },
    signatureRef: "https://evidence.example/signature",
    provenanceRef: "https://evidence.example/provenance",
    admission: {
      registryConfirmed: true,
      provenanceVerified: true,
      runtimeMetadataVerified: true,
      evidence: ["verified test evidence"],
      verifiedAt: TIME,
    },
    status: "candidate",
    createdAt: TIME,
  });
}

const stagedActivator: StagedRolloutActivator = {
  async findStageByIdempotency() {
    return null;
  },
  async activateStageUnderClusterFence() {
    return null;
  },
};

function store(db: SQLiteD1, activator = stagedActivator) {
  return new D1T11ReleaseRolloutStore(db, activator, () => "op-test");
}

function installSchema(db: SQLiteD1) {
  db.database.exec("PRAGMA foreign_keys = ON");
  for (const migration of [
    "../../../migrations/0001_repository_platform.sql",
    "../../../migrations/0002_stable_release_rollouts.sql",
    "../../../migrations/0005_runtime_health_observations.sql",
  ]) {
    db.database.exec(readFileSync(new URL(migration, import.meta.url), "utf8"));
  }
}

const retryBinding = {
  repositoryId: 901,
  instanceId: "retry-canary-instance",
  bindingEpoch: 4,
  authorizationRevision: 7,
  requestedModules: ["forms"],
  resourceProfileId: "small",
} as const;

async function seedFailedPreRuntimeCanary(
  db: SQLiteD1,
  releaseId = "release-retry",
  failure: Readonly<Record<string, unknown>> = {
    code: "BUILD_FAILED",
    message: "BuildKit solve failed",
    retryable: false,
  },
) {
  const release = candidate(releaseId, "1.2.3", `sha256:${"d".repeat(64)}`);
  const releases = store(db);
  await releases.createCandidate(release);
  const buildInput: BuildInput = {
    contractVersion: "scriptorium-build/v1",
    producerRevision: PRODUCER,
    runtimeBaseDigest: release.imageDigest,
    buildKitDigest: DIGEST,
    recipeDigest: DIGEST,
    sourceDigest: DIGEST,
    lockDigest: DIGEST,
    requestedModules: ["forms"],
    resolvedModules: [{ id: "forms", version: "1.0.0", artifactDigest: DIGEST }],
    platform: "linux/amd64",
    options: {},
  };
  const encodedInput = canonicalBuildInput(buildInput);
  const retryBuildKey = await buildKey(buildInput);
  const buildId = "build-retry";
  const revisionId = "revision-retry";
  const attemptId = "attempt-retry-old";
  const requestHash = `sha256:${"e".repeat(64)}`;
  const failureJson = JSON.stringify(failure);
  db.database
    .prepare(
      `INSERT INTO logical_instances (
         instance_id, repository_id, generation, runtime_epoch, desired_state, policy,
         observed_generation, observed_runtime_epoch, observed_sequence, observed_state,
         desired_revision_id, observed_revision_id, desired_artifact_digest,
         reservation_state, reservation_id, created_at, updated_at
       ) VALUES (?, ?, 1, 0, 'stopped', 'pinned', NULL, NULL, 0, 'absent',
                 ?, NULL, NULL, 'none', NULL, ?, ?)`,
    )
    .run(retryBinding.instanceId, retryBinding.repositoryId, revisionId, NOW, NOW);
  db.database
    .prepare(
      `INSERT INTO repository_bindings (
         repository_id, instance_id, installation_id, owner, name, authorization_revision,
         binding_epoch, suspended, created_at, updated_at
       ) VALUES (?, ?, 901, 'owner', 'repo', ?, ?, 0, ?, ?)`,
    )
    .run(
      retryBinding.repositoryId,
      retryBinding.instanceId,
      retryBinding.authorizationRevision,
      retryBinding.bindingEpoch,
      NOW,
      NOW,
    );
  db.database
    .prepare(
      `INSERT INTO builds (
         build_id, build_key, build_input_json, status, attempt_count, lease_epoch,
         active_attempt_id, worker_id, lease_token, lease_expires_at, report_sequence,
         last_report_digest, progress_json, cancel_requested, candidate_ref, manifest_digest,
         artifact_digest, failure_json, created_at, updated_at
       ) VALUES (?, ?, ?, 'failed', 1, 1, ?, 'worker-old', 'lease-token-old-attempt-00000000',
                 ?, 1, ?, NULL, 0, NULL, NULL, NULL, ?, ?, ?)`,
    )
    .run(
      buildId,
      retryBuildKey,
      encodedInput,
      attemptId,
      NOW + 60_000,
      `sha256:${"f".repeat(64)}`,
      failureJson,
      NOW,
      NOW + 10_000,
    );
  db.database
    .prepare(
      `INSERT INTO build_attempts (
         attempt_id, build_id, lease_epoch, worker_id, status, lease_token, lease_expires_at,
         report_sequence, last_report_digest, progress_json, candidate_ref, manifest_digest,
         failure_json, started_at, updated_at, finished_at
       ) VALUES (?, ?, 1, 'worker-old', 'failed', 'lease-token-old-attempt-00000000', ?, 1, ?, NULL,
                 NULL, NULL, ?, ?, ?, ?)`,
    )
    .run(
      attemptId,
      buildId,
      NOW + 60_000,
      `sha256:${"f".repeat(64)}`,
      failureJson,
      NOW,
      NOW + 10_000,
      NOW + 10_000,
    );
  const selection = JSON.stringify({
    releaseId,
    requestedModules: ["forms"],
    resourceProfileId: retryBinding.resourceProfileId,
    policy: "pinned",
  });
  db.database
    .prepare(
      `INSERT INTO deployment_revisions (
         revision_id, instance_id, repository_id, generation, build_key, build_id,
         selection_json, resource_requirements_json, runtime_metadata_json, artifact_digest,
         status, actor_id, created_at
       ) VALUES (?, ?, ?, 1, ?, ?, ?, '{}', '{}', NULL, 'failed',
                 'system:stable-release-canary', ?)`,
    )
    .run(
      revisionId,
      retryBinding.instanceId,
      retryBinding.repositoryId,
      retryBuildKey,
      buildId,
      selection,
      NOW,
    );
  db.database
    .prepare(
      `INSERT INTO idempotency_records
         (scope, idempotency_key, request_hash, response_kind, response_id, created_at)
       VALUES (?, ?, ?, 'configuration-plan', ?, ?)`,
    )
    .run(
      `repository:${retryBinding.repositoryId}`,
      `stable-canary-plan:${releaseId}`,
      requestHash,
      revisionId,
      NOW,
    );
  db.database
    .prepare(
      `UPDATE release_candidate_workflows
          SET state = 'blocked', revision = 4, attempts = 1,
              canary_build_key = ?, failure_code = 'canary_build_failed', updated_at = ?
        WHERE release_id = ?`,
    )
    .run(retryBuildKey, NOW + 20_000, releaseId);
  return { release, buildId, buildKey: retryBuildKey, revisionId, attemptId, failureJson };
}

async function admitCanaryBuild(
  db: SQLiteD1,
  seed: Awaited<ReturnType<typeof seedFailedPreRuntimeCanary>>,
  nextAttemptAt: number,
): Promise<void> {
  const artifactDigest = `sha256:${"c".repeat(64)}`;
  db.database.prepare(
    `INSERT INTO artifacts (
       artifact_digest, build_key, build_id, attempt_id, manifest_digest,
       platform_manifest_digest, composition_manifest_digest, producer_revision,
       requested_modules_json, resolved_modules_json, contract_versions_json,
       sbom_ref, provenance_ref, verification_json, statement_json, signature_json,
       verifier_id, status, created_at, admitted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '["forms"]', '[]', '{}', NULL, NULL,
               '{}', '{}', '{}', 'test-verifier', 'admitted', ?, ?)`
  ).run(
    artifactDigest, seed.buildKey, seed.buildId, seed.attemptId, DIGEST, DIGEST, DIGEST,
    PRODUCER, NOW, NOW,
  );
  db.database.prepare(
    `UPDATE builds SET status = 'succeeded',
         artifact_digest = ?, manifest_digest = ?, updated_at = ? WHERE build_id = ?`
  ).run(artifactDigest, DIGEST, NOW + 30_000, seed.buildId);
  db.database.prepare(
    "UPDATE build_attempts SET status = 'succeeded', finished_at = ? WHERE attempt_id = ?"
  ).run(NOW + 30_000, seed.attemptId);
  db.database.prepare(
    "UPDATE deployment_revisions SET status = 'admitted', artifact_digest = ? WHERE revision_id = ?"
  ).run(artifactDigest, seed.revisionId);
  // Mirror the canonical D1BuildStore success report: it binds the admitted
  // artifact to the instance's desired revision before the wake hint runs.
  db.database.prepare(
    "UPDATE logical_instances SET desired_artifact_digest = ? WHERE instance_id = ?"
  ).run(artifactDigest, retryBinding.instanceId);
  db.database.prepare(
    `UPDATE release_candidate_workflows
        SET state = 'canary_building', revision = 5, failure_code = NULL,
            next_attempt_at = ?, updated_at = ? WHERE release_id = ?`
  ).run(nextAttemptAt, NOW + 20_000, seed.release.id);
}

function retryCommand(
  releaseId = "release-retry",
  overrides: Partial<ReleaseRetryCommand> = {},
): ReleaseRetryCommand {
  return {
    releaseId,
    expectedRevision: 4,
    idempotencyKey: "operator-retry-1",
    requestHash: `sha256:${"9".repeat(64)}`,
    actorId: "operator-test",
    requestId: "operator-request-1",
    now: NOW + 30_000,
    canary: retryBinding,
    ...overrides,
  };
}

function seedCanaryHealthFixture(
  db: SQLiteD1,
  releaseId: string,
  nextAttemptAt: number | null,
): void {
  db.database.exec(`
    INSERT INTO logical_instances (
      instance_id, repository_id, generation, runtime_epoch, desired_state, policy,
      observed_generation, observed_runtime_epoch, observed_sequence, observed_state,
      desired_revision_id, observed_revision_id, reservation_state, reservation_id,
      created_at, updated_at
    ) VALUES (
      'canary-instance', 101, 7, 4, 'running', 'stable', 7, 4, 1, 'ready',
      'canary-revision', 'canary-revision', 'allocated', 'canary-reservation', ${NOW}, ${NOW}
    );
    INSERT INTO repository_bindings (
      repository_id, instance_id, installation_id, owner, name, authorization_revision,
      binding_epoch, suspended, created_at, updated_at
    ) VALUES (101, 'canary-instance', 201, 'owner', 'repo', 3, 2, 0, ${NOW}, ${NOW});
    INSERT INTO builds (build_id, build_key, build_input_json, status, created_at, updated_at)
    VALUES ('canary-build', 'canary-build-key', '{}', 'succeeded', ${NOW}, ${NOW});
    INSERT INTO deployment_revisions (
      revision_id, instance_id, repository_id, generation, build_key, build_id,
      selection_json, resource_requirements_json, runtime_metadata_json, artifact_digest,
      status, actor_id, created_at
    ) VALUES (
      'canary-revision', 'canary-instance', 101, 7, 'canary-build-key', 'canary-build',
      '{}', '{}', '{}', NULL, 'admitted', 'test', ${NOW}
    );
    INSERT INTO runtime_reservations (
      reservation_id, instance_id, repository_id, runtime_epoch, generation, cluster_id,
      status, capacity_snapshot_epoch, cpu_milli, memory_mib, ephemeral_storage_mib,
      created_at, updated_at
    ) VALUES (
      'canary-reservation', 'canary-instance', 101, 4, 7, 'cluster-canary',
      'allocated', 1, 100, 128, 256, ${NOW}, ${NOW}
    );
    INSERT INTO operations (
      operation_id, instance_id, repository_id, generation, runtime_epoch, kind, status,
      phase, cluster_id, reservation_id, deployment_revision_id, idempotency_scope,
      idempotency_key, request_hash, actor_id, authorization_revision, created_at, updated_at
    ) VALUES (
      'canary-operation', 'canary-instance', 101, 7, 4, 'start', 'succeeded', 'complete',
      'cluster-canary', 'canary-reservation', 'canary-revision', 'canary-test',
      'canary-operation', 'hash', 'test', 3, ${NOW}, ${NOW}
    );
  `);
  db.database
    .prepare(
      `UPDATE release_candidate_workflows
          SET state = 'canary_observing', revision = 1, next_attempt_at = ?,
              canary_artifact_digest = ?, canary_build_key = ?, canary_runtime_id = ?,
              canary_operation_id = ?, updated_at = ?
        WHERE release_id = ?`,
    )
    .run(nextAttemptAt, DIGEST, BUILD_KEY, "canary-instance", "canary-operation", NOW, releaseId);
}

function follower(instanceId: string, clusterId = "cluster-1"): StableFollower {
  return {
    instanceId,
    repositoryId: 101,
    bindingEpoch: 1,
    authorizationRevision: 1,
    clusterId,
    generation: 2,
    runtimeEpoch: 1,
    desiredState: "running",
    policy: "stable",
    desiredReleaseId: null,
    desiredArtifactDigest: null,
    currentArtifactDigest: null,
    configurationRevision: "revision-1",
    selectedModuleIds: ["forms"],
    resourceProfileId: "standard",
    platform: "linux/amd64",
  };
}

describe("D1T11ReleaseRolloutStore against SQLite execution", () => {
  it("operator-retries a failed runtime only after exact stop proof and a fresh configured binding", async () => {
    const makeFixture = async () => {
      const db = new SQLiteD1();
      installSchema(db);
      const release = candidate("release-runtime-retry", "0.3.9");
      const releases = store(db);
      await releases.createCandidate(release);
      const cleanupEvidence = {
        operationId: "operation-stop20",
        startedOperationId: "operation-v039",
        observedAt: NOW,
        writerAbsence: {
          instanceId: "old-canary-instance",
          repositoryId: 101,
          retiredEpoch: 7,
          providerObservationId: "whole-instance-stop-census",
          censusObservedAt: NOW - 1_000,
          remainingWriters: 0,
          evidenceIdentities: ["old-pod-uid-gen17-epoch7"],
          source: "runtime-provider-census",
        },
      };
      db.database.prepare(
        `UPDATE release_candidate_workflows
            SET state = 'rejected', revision = 5, attempts = 2,
                canary_artifact_digest = ?, canary_runtime_id = 'old-canary-instance',
                canary_operation_id = 'operation-v039', canary_cleanup_complete = 1,
                cleanup_disposition = 'reject', cleanup_evidence_json = ?,
                failure_code = 'canary_assignment_superseded', updated_at = ?
          WHERE release_id = ?`,
      ).run(DIGEST, JSON.stringify(cleanupEvidence), NOW, release.id);
      db.database.exec(`
        INSERT INTO logical_instances (
          instance_id, repository_id, generation, runtime_epoch, desired_state, policy,
          observed_generation, observed_runtime_epoch, observed_sequence, observed_state,
          desired_revision_id, observed_revision_id, desired_artifact_digest,
          reservation_state, reservation_id, created_at, updated_at
        ) VALUES ('old-canary-instance', 101, 20, 9, 'stopped', 'pinned', 20, 9, 4, 'stopped',
          'revision-v039', 'revision-v039', '${DIGEST}', 'released', NULL, ${NOW}, ${NOW});
        INSERT INTO repository_bindings (
          repository_id, instance_id, installation_id, owner, name, authorization_revision,
          binding_epoch, suspended, created_at, updated_at
        ) VALUES (101, 'old-canary-instance', 201, 'owner', 'repo', 3, 3, 0, ${NOW}, ${NOW});
        INSERT INTO logical_instances (
          instance_id, repository_id, generation, runtime_epoch, desired_state, policy,
          observed_generation, observed_runtime_epoch, observed_sequence, observed_state,
          reservation_state, reservation_id, created_at, updated_at
        ) VALUES ('retry-canary-instance', 901, 0, 0, 'stopped', 'pinned', NULL, NULL, 0, 'absent',
          'none', NULL, ${NOW}, ${NOW});
        INSERT INTO repository_bindings (
          repository_id, instance_id, installation_id, owner, name, authorization_revision,
          binding_epoch, suspended, created_at, updated_at
        ) VALUES (901, 'retry-canary-instance', 202, 'owner', 'canary', 7, 4, 0, ${NOW}, ${NOW});
        INSERT INTO builds (build_id, build_key, build_input_json, status, created_at, updated_at)
          VALUES ('old-canary-build', 'old-canary-build-key', '{}', 'succeeded', ${NOW}, ${NOW});
        INSERT INTO deployment_revisions (
          revision_id, instance_id, repository_id, generation, build_key, build_id,
          selection_json, resource_requirements_json, runtime_metadata_json,
          status, actor_id, created_at
        ) VALUES ('revision-v039', 'old-canary-instance', 101, 19, 'old-canary-build-key',
          'old-canary-build', '{}', '{}', '{}', 'admitted', 'operator-user', ${NOW});
        INSERT INTO operations (
          operation_id, instance_id, repository_id, generation, runtime_epoch, kind, status,
          phase, lease_expires_at, idempotency_scope, idempotency_key, request_hash, actor_id,
          authorization_revision, deployment_revision_id, created_at, updated_at
        ) VALUES
          ('operation-v039', 'old-canary-instance', 101, 19, 9, 'update', 'running',
           'waiting-for-capacity', ${NOW - 1_000}, 'repository:101', 'old-start', 'old-hash',
           'system:stable-release-canary', 3, 'revision-v039', ${NOW - 60_000}, ${NOW}),
          ('operation-stop20', 'old-canary-instance', 101, 20, 9, 'stop', 'succeeded',
           'complete', NULL, 'repository:101', 'old-stop', 'stop-hash',
           'operator-user', 3, NULL, ${NOW - 30_000}, ${NOW});
      `);
      db.database.prepare("UPDATE operations SET checkpoint_json = ? WHERE operation_id = 'operation-stop20'")
        .run(JSON.stringify({
          schemaVersion: 1,
          writerAbsenceProof: {
            instanceId: "old-canary-instance",
            repositoryId: 101,
            retiredRuntimeEpoch: 7,
            providerObservationId: "whole-instance-stop-census",
            censusObservedAt: new Date(NOW - 1_000).toISOString(),
            remainingWriters: 0,
            evidenceIdentities: ["old-pod-uid-gen17-epoch7"],
            source: "runtime-provider-census",
          },
        }));
      return {
        db,
        releases,
        command: {
          releaseId: release.id,
          expectedRevision: 5,
          idempotencyKey: "operator-runtime-retry-1",
          requestHash: `sha256:${"9".repeat(64)}`,
          actorId: "operator-test",
          requestId: "operator-runtime-request-1",
          now: NOW,
          canary: retryBinding,
        },
      };
    };

    const valid = await makeFixture();
    const accepted = await valid.releases.retryFailedCanaryRuntime(valid.command);
    expect(accepted).toMatchObject({ kind: "accepted", duplicate: false });
    expect(accepted.kind === "accepted" ? accepted.status.workflow : null).toMatchObject({
      state: "canary_building",
      revision: 6,
      attempts: 3,
      canaryBuildKey: null,
      canaryOperationId: null,
      failureCode: null,
    });
    expect(valid.db.database.prepare(
      "SELECT action, actor_kind, outcome FROM audit_events WHERE action = 'release.canary-runtime.retried'",
    ).get()).toEqual({ action: "release.canary-runtime.retried", actor_kind: "operator", outcome: "accepted" });
    expect(await valid.releases.retryFailedCanaryRuntime(valid.command)).toMatchObject({
      kind: "accepted",
      duplicate: true,
    });

    const noHistory = await makeFixture();
    noHistory.db.database.prepare(
      `UPDATE release_candidate_workflows
          SET cleanup_evidence_json = json_set(cleanup_evidence_json,
            '$.writerAbsence.retiredEpoch', 9) WHERE release_id = ?`,
    ).run(noHistory.command.releaseId);
    noHistory.db.database.prepare(
      `UPDATE operations SET checkpoint_json = json_set(checkpoint_json,
        '$.writerAbsenceProof.retiredRuntimeEpoch', 9) WHERE operation_id = 'operation-stop20'`,
    ).run();
    expect(await noHistory.releases.retryFailedCanaryRuntime(noHistory.command)).toMatchObject({
      kind: "accepted",
      duplicate: false,
    });

    const invalidCases = ["stale-revision", "missing-cleanup", "healthy-evidence", "active-old-work", "wrong-new-binding", "missing-stop-proof", "wrong-retired-epoch"] as const;
    for (const invalidCase of invalidCases) {
      const fixture = await makeFixture();
      if (invalidCase === "missing-cleanup") fixture.db.database.prepare(
        "UPDATE release_candidate_workflows SET canary_cleanup_complete = 0 WHERE release_id = ?",
      ).run(fixture.command.releaseId);
      if (invalidCase === "healthy-evidence") fixture.db.database.prepare(
        "UPDATE release_candidate_workflows SET last_health_evidence_json = '{}' WHERE release_id = ?",
      ).run(fixture.command.releaseId);
      if (invalidCase === "active-old-work") fixture.db.database.prepare(
        `INSERT INTO operations (
           operation_id, instance_id, repository_id, generation, runtime_epoch, kind, status,
           phase, lease_expires_at, idempotency_scope, idempotency_key, request_hash, actor_id,
           authorization_revision, created_at, updated_at
         ) VALUES ('other-active-old', 'old-canary-instance', 101, 20, 9, 'update', 'running',
           'starting-target', ?, 'repository:101', 'other-active', 'active-hash', 'worker', 3, ?, ?)`,
      ).run(NOW + 60_000, NOW, NOW);
      if (invalidCase === "wrong-new-binding") fixture.db.database.prepare(
        "UPDATE repository_bindings SET authorization_revision = 8 WHERE repository_id = ?",
      ).run(retryBinding.repositoryId);
      if (invalidCase === "missing-stop-proof") fixture.db.database.prepare(
        "UPDATE operations SET checkpoint_json = NULL WHERE operation_id = 'operation-stop20'",
      ).run();
      if (invalidCase === "wrong-retired-epoch") fixture.db.database.prepare(
        "UPDATE operations SET checkpoint_json = json_set(checkpoint_json, '$.writerAbsenceProof.retiredRuntimeEpoch', 9) WHERE operation_id = 'operation-stop20'",
      ).run();
      const command = invalidCase === "stale-revision"
        ? { ...fixture.command, expectedRevision: fixture.command.expectedRevision - 1 }
        : fixture.command;
      await expect(fixture.releases.retryFailedCanaryRuntime(command), invalidCase).resolves.toMatchObject({
        kind: "conflict",
      });
      expect(fixture.db.database.prepare(
        "SELECT state, revision FROM release_candidate_workflows WHERE release_id = ?",
      ).get(fixture.command.releaseId)).toMatchObject({ state: "rejected", revision: 5 });
    }
  });

  it("acknowledges old v0.3.8 cleanup from current successful stop20 proof without stopping repointed v0.3.9", async () => {
    const db = new SQLiteD1();
    installSchema(db);
    const release = candidate("release-v038", "0.3.8");
    await store(db).createCandidate(release);
    db.database.prepare(
      `UPDATE release_candidate_workflows
          SET state = 'canary_cleanup', revision = 1, next_attempt_at = ?,
              canary_artifact_digest = ?, canary_runtime_id = 'old-canary-instance',
              canary_operation_id = 'operation-v038', cleanup_disposition = 'reject',
              failure_code = 'canary_assignment_superseded', updated_at = ?
        WHERE release_id = ?`,
    ).run(NOW, DIGEST, NOW, release.id);
    db.database.exec(`
      INSERT INTO logical_instances (
        instance_id, repository_id, generation, runtime_epoch, desired_state, policy,
        observed_generation, observed_runtime_epoch, observed_sequence, observed_state,
        desired_revision_id, observed_revision_id, desired_artifact_digest,
        reservation_state, reservation_id, created_at, updated_at
      ) VALUES ('old-canary-instance', 101, 20, 9, 'stopped', 'pinned', 20, 9, 3, 'stopped',
        'revision-v039', 'revision-v039', '${DIGEST}', 'released', NULL, ${NOW}, ${NOW});
      INSERT INTO repository_bindings (
        repository_id, instance_id, installation_id, owner, name, authorization_revision,
        binding_epoch, suspended, created_at, updated_at
      ) VALUES (101, 'old-canary-instance', 201, 'owner', 'repo', 3, 4, 0, ${NOW}, ${NOW});
      INSERT INTO operations (
        operation_id, instance_id, repository_id, generation, runtime_epoch, kind, status,
        phase, idempotency_scope, idempotency_key, request_hash, actor_id,
        authorization_revision, created_at, updated_at
      ) VALUES
        ('operation-v038', 'old-canary-instance', 101, 19, 9, 'update', 'running',
         'starting-target', 'repo:101', 'start-v038', 'hash-start', 'system:stable-release-canary', 3, ${NOW}, ${NOW}),
        ('operation-stop20', 'old-canary-instance', 101, 20, 9, 'stop', 'succeeded',
         'complete', 'repo:101', 'user-stop20', 'hash-stop', 'operator-user', 3, ${NOW}, ${NOW});
    `);
    db.database.prepare("UPDATE operations SET checkpoint_json = ? WHERE operation_id = 'operation-stop20'")
      .run(JSON.stringify({
        schemaVersion: 1,
        writerAbsenceProof: {
          instanceId: "old-canary-instance",
          repositoryId: 101,
          retiredRuntimeEpoch: 7,
          providerObservationId: "stop20-complete-census",
          censusObservedAt: new Date(NOW - 1_000).toISOString(),
          remainingWriters: 0,
          evidenceIdentities: ["old-pod-uid-gen17-epoch7"],
          source: "runtime-provider-census",
        },
      }));

    const startedOperation = {
      id: "operation-v038",
      instanceId: "old-canary-instance",
      repositoryId: 101,
      generation: 19,
      runtimeEpoch: 9,
      kind: "update" as const,
      status: "running" as const,
      deploymentRevisionId: "revision-v038",
      result: null,
    };
    const stopOperation = {
      id: "operation-stop20",
      instanceId: "old-canary-instance",
      repositoryId: 101,
      generation: 20,
      runtimeEpoch: 9,
      kind: "stop" as const,
      status: "succeeded" as const,
      deploymentRevisionId: "revision-v039",
      checkpoint: {
        writerAbsenceProof: {
          instanceId: "old-canary-instance",
          repositoryId: 101,
          retiredRuntimeEpoch: 7,
          providerObservationId: "stop20-complete-census",
          censusObservedAt: new Date(NOW - 1_000).toISOString(),
          remainingWriters: 0,
          evidenceIdentities: ["old-pod-uid-gen17-epoch7"],
          source: "runtime-provider-census",
        },
      },
      result: null,
    };
    let desiredStateWrites = 0;
    const composition = createT11RolloutComposition({
      db,
      configurations: {
        stage: async () => { throw new Error("not needed for failed canary cleanup"); },
        findStageByIdempotency: async () => null,
        activateStageUnderClusterFence: async () => null,
      },
      canaryConfigurations: {
        plan: async () => { throw new Error("not needed for cleanup"); },
        findByIdempotency: async () => null,
      },
      instances: {
        async getByRepositoryId() { throw new Error("read-only old cleanup must not use the new binding"); },
        async requestDesiredState() {
          desiredStateWrites += 1;
          throw new Error("read-only cleanup must not mutate desired state");
        },
      } as unknown as InstanceService,
      operations: {
        async getById(operationId: string) {
          if (operationId === startedOperation.id) return startedOperation;
          if (operationId === stopOperation.id) {
            const row = db.database.prepare("SELECT checkpoint_json FROM operations WHERE operation_id = ?")
              .get(operationId) as { readonly checkpoint_json: string | null };
            return {
              ...stopOperation,
              checkpoint: row.checkpoint_json ? JSON.parse(row.checkpoint_json) as Record<string, unknown> : null,
            };
          }
          return null;
        },
      } as unknown as OperationService,
      canaryBinding: {
        repositoryId: 101,
        instanceId: "new-canary-instance",
        bindingEpoch: 4,
        authorizationRevision: 3,
        requestedModules: [],
        resourceProfileId: "small",
      },
      canaryObservations: {
        latestHealth: async () => null,
        writerAbsence: async (input) => ({
          instanceId: input.instanceId,
          repositoryId: input.repositoryId,
          retiredEpoch: input.retiredEpoch,
          providerObservationId: "stop20-complete-census",
          censusObservedAt: NOW - 1_000,
          remainingWriters: 0 as const,
          evidenceIdentities: ["old-pod-uid-gen17-epoch7"],
          source: "runtime-provider-census" as const,
        }),
      },
      defaultClusterId: "cluster-canary",
      clock: { now: () => TIME, nowMs: () => NOW },
      ids: { newReleaseId: () => "unused-release" },
      workerId: "canary-cleanup-test",
      authorizeOperator: async () => null,
      registry: { async verifyImage(repository, manifestDigest, platform) { return { repository, manifestDigest, platform }; } },
      provenance: { async verify() { return { verified: true, evidence: [] }; } },
      producerMetadata: { async verify() { return { kind: "verified", evidence: [] }; } },
    });

    const recoverExistingStop = () => composition.scheduled.promotions.canaryRuntime.stop({
      runtimeId: "old-canary-instance",
      startedOperationId: startedOperation.id,
      idempotencyKey: `stable-canary-stop:${release.id}`,
      allowExistingStopRecovery: true,
    });
    db.database.prepare(
      "INSERT INTO operations (operation_id, instance_id, repository_id, generation, runtime_epoch, kind, status, phase, idempotency_scope, idempotency_key, request_hash, actor_id, authorization_revision, created_at, updated_at) VALUES ('active-conflict', 'old-canary-instance', 101, 20, 9, 'update', 'running', 'starting-target', 'repo:101', 'active-conflict', 'hash-active', 'worker', 3, ?, ?)",
    ).run(NOW, NOW);
    expect((await recoverExistingStop()).kind).toBe("blocked");
    db.database.prepare("DELETE FROM operations WHERE operation_id = 'active-conflict'").run();

    db.database.prepare("UPDATE repository_bindings SET suspended = 1 WHERE repository_id = 101").run();
    expect((await recoverExistingStop()).kind).toBe("blocked");
    db.database.prepare("UPDATE repository_bindings SET suspended = 0 WHERE repository_id = 101").run();

    db.database.prepare("UPDATE repository_bindings SET authorization_revision = 4 WHERE repository_id = 101").run();
    expect((await recoverExistingStop()).kind).toBe("blocked");
    db.database.prepare("UPDATE repository_bindings SET authorization_revision = 3 WHERE repository_id = 101").run();

    db.database.prepare("UPDATE logical_instances SET generation = 21, observed_generation = 21 WHERE instance_id = 'old-canary-instance'").run();
    expect((await recoverExistingStop()).kind).toBe("blocked");
    db.database.prepare("UPDATE logical_instances SET generation = 20, observed_generation = 20 WHERE instance_id = 'old-canary-instance'").run();

    const directCleanup = await recoverExistingStop();
    expect(directCleanup.kind).toBe("stopped");

    const result = await advanceStablePromotions(composition.scheduled.promotions, {
      releaseId: release.id,
      limit: 1,
    });
    expect(result).toEqual({ claimed: 1, advanced: 0, retried: 0, terminal: 1 });
    expect(desiredStateWrites).toBe(0);
    expect(
      db.database.prepare(
        "SELECT state, canary_cleanup_complete, cleanup_evidence_json FROM release_candidate_workflows WHERE release_id = ?",
      ).get(release.id),
    ).toMatchObject({
      state: "rejected",
      canary_cleanup_complete: 1,
      cleanup_evidence_json: expect.stringContaining("operation-stop20"),
    });
  });

  it("wakes only the configured admitted canary whose build just succeeded", async () => {
    const db = new SQLiteD1();
    installSchema(db);
    const seed = await seedFailedPreRuntimeCanary(db, "release-build-wake");
    await admitCanaryBuild(db, seed, NOW + 5 * 60_000);
    db.database.prepare(
      "UPDATE release_candidate_workflows SET lease_owner = 'expired', lease_epoch = 3, lease_expires_at = ? WHERE release_id = ?"
    ).run(NOW + 25_000, seed.release.id);

    const releases = store(db);
    const wake = () => releases.wakeSuccessfulCanaryBuild({
      buildId: seed.buildId,
      binding: retryBinding,
      now: NOW + 30_000,
    });
    // Missing and mismatched desired digests must remain ineligible.
    db.database.prepare(
      "UPDATE logical_instances SET desired_artifact_digest = NULL WHERE instance_id = ?"
    ).run(retryBinding.instanceId);
    await expect(wake()).resolves.toBeNull();
    db.database.prepare(
      "UPDATE logical_instances SET desired_artifact_digest = ? WHERE instance_id = ?"
    ).run(`sha256:${"d".repeat(64)}`, retryBinding.instanceId);
    await expect(wake()).resolves.toBeNull();
    db.database.prepare(
      "UPDATE logical_instances SET desired_artifact_digest = ? WHERE instance_id = ?"
    ).run(`sha256:${"c".repeat(64)}`, retryBinding.instanceId);
    // The build's completed attempt is still referenced by active_attempt_id;
    // a mismatched status or report digest must not issue a Canary start.
    db.database.prepare(
      "UPDATE build_attempts SET status = 'failed' WHERE attempt_id = ?"
    ).run(seed.attemptId);
    await expect(wake()).resolves.toBeNull();
    db.database.prepare(
      "UPDATE build_attempts SET status = 'succeeded' WHERE attempt_id = ?"
    ).run(seed.attemptId);
    db.database.prepare(
      "UPDATE builds SET last_report_digest = ? WHERE build_id = ?"
    ).run(`sha256:${"8".repeat(64)}`, seed.buildId);
    await expect(wake()).resolves.toBeNull();
    db.database.prepare(
      "UPDATE builds SET last_report_digest = ? WHERE build_id = ?"
    ).run(`sha256:${"f".repeat(64)}`, seed.buildId);
    // The exact admitted digest and the fenced completed attempt together
    // constitute the canonical Build report evidence for this Canary.
    await expect(wake()).resolves.toBe(seed.release.id);
    expect(db.database.prepare(
      "SELECT state, revision, next_attempt_at, lease_epoch, lease_owner FROM release_candidate_workflows WHERE release_id = ?"
    ).get(seed.release.id)).toEqual({
      state: "canary_building",
      revision: 6,
      next_attempt_at: NOW + 30_000,
      lease_epoch: 4,
      lease_owner: null,
    });
    const claim = await releases.claimCandidateWork({
      owner: "release-build-wake-worker",
      now: NOW + 30_001,
      leaseMs: 60_000,
      limit: 1,
      releaseId: seed.release.id,
    });
    expect(claim).toHaveLength(1);
    expect(claim[0]?.workflow).toMatchObject({
      state: "canary_building",
      nextAttemptAt: NOW + 30_000,
      leaseEpoch: 5,
    });
  });

  it("does not wake while a promotion lease is still active or for a different canary binding", async () => {
    const db = new SQLiteD1();
    installSchema(db);
    const seed = await seedFailedPreRuntimeCanary(db, "release-build-wake-guard");
    await admitCanaryBuild(db, seed, NOW + 5 * 60_000);
    db.database.prepare(
      "UPDATE release_candidate_workflows SET lease_owner = 'active', lease_expires_at = ? WHERE release_id = ?"
    ).run(NOW + 60_000, seed.release.id);
    const releases = store(db);
    const input = { buildId: seed.buildId, binding: retryBinding, now: NOW + 30_000 };

    await expect(releases.wakeSuccessfulCanaryBuild(input)).resolves.toBeNull();
    await expect(
      releases.wakeSuccessfulCanaryBuild({
        ...input,
        binding: { ...retryBinding, repositoryId: retryBinding.repositoryId + 1 },
      }),
    ).resolves.toBeNull();
    expect(db.database.prepare(
      "SELECT revision, next_attempt_at, lease_epoch, lease_owner FROM release_candidate_workflows WHERE release_id = ?"
    ).get(seed.release.id)).toEqual({
      revision: 5,
      next_attempt_at: NOW + 5 * 60_000,
      lease_epoch: 0,
      lease_owner: "active",
    });
  });

  it("retries only the exact pre-runtime canary build and fences its failed attempt", async () => {
    const db = new SQLiteD1();
    installSchema(db);
    const seed = await seedFailedPreRuntimeCanary(db);
    const releases = store(db);
    const beforeCandidate = db.database
      .prepare("SELECT candidate_json FROM release_candidates WHERE release_id = ?")
      .get(seed.release.id) as { readonly candidate_json: string };

    const result = await releases.retryPreRuntimeCanaryBuild(retryCommand());
    if (result.kind !== "accepted") throw new Error(`expected an accepted retry: ${JSON.stringify(result)}`);
    expect(result.duplicate).toBe(false);
    expect(result.status).toMatchObject({
      release: { id: seed.release.id, status: "candidate", imageDigest: seed.release.imageDigest },
      workflow: {
        state: "canary_building",
        revision: 5,
        attempts: 2,
        failureCode: null,
        canaryBuildKey: seed.buildKey,
      },
      build: { id: seed.buildId, status: "pending", attemptCount: 1, failure: null, progress: null },
    });
    expect(
      db.database
        .prepare("SELECT candidate_json FROM release_candidates WHERE release_id = ?")
        .get(seed.release.id),
    ).toEqual(beforeCandidate);
    expect(
      db.database
        .prepare("SELECT status, lease_epoch, active_attempt_id, failure_json FROM builds WHERE build_id = ?")
        .get(seed.buildId),
    ).toEqual({ status: "pending", lease_epoch: 2, active_attempt_id: null, failure_json: null });
    expect(
      db.database
        .prepare("SELECT status, lease_epoch, failure_json FROM build_attempts WHERE attempt_id = ?")
        .get(seed.attemptId),
    ).toMatchObject({ status: "failed", lease_epoch: 1, failure_json: seed.failureJson });
    expect(
      db.database
        .prepare("SELECT status, artifact_digest FROM deployment_revisions WHERE revision_id = ?")
        .get(seed.revisionId),
    ).toEqual({ status: "building", artifact_digest: null });
    expect(
      db.database
        .prepare("SELECT action, outcome, actor_id, request_id FROM audit_events")
        .all(),
    ).toEqual([
      {
        action: "release.canary-build.retried",
        outcome: "accepted",
        actor_id: "operator-test",
        request_id: "operator-request-1",
      },
    ]);

    const duplicate = await releases.retryPreRuntimeCanaryBuild(retryCommand());
    expect(duplicate).toMatchObject({ kind: "accepted", duplicate: true });
    const reusedKey = await releases.retryPreRuntimeCanaryBuild(
      retryCommand(seed.release.id, { requestHash: `sha256:${"8".repeat(64)}` }),
    );
    expect(reusedKey).toEqual({ kind: "conflict", reason: "idempotency_key_reused" });

    const buildQueue = new D1BuildStore(db);
    const staleReport = await buildQueue.recordReport({
      request: {
        buildId: seed.buildId,
        attemptId: seed.attemptId,
        leaseEpoch: 1,
        leaseToken: "lease-token-old-attempt-00000000",
        workerId: "worker-old",
        sequence: 2,
        buildKey: seed.buildKey,
        result: {
          kind: "failed",
          code: "BUILD_FAILED",
          message: "late report",
          retryable: false,
        },
      },
      serverNow: NOW + 40_000,
      reportDigest: `sha256:${"7".repeat(64)}`,
      artifact: null,
    });
    expect(staleReport).toEqual({ accepted: false, duplicate: false });

    const claim = await buildQueue.claimNext({
      workerId: "worker-retry",
      attemptId: "attempt-retry-new",
      leaseToken: "lease-token-new-attempt-0000000000",
      now: NOW + 50_000,
      leaseSeconds: 120,
    });
    expect(claim).toMatchObject({
      buildId: seed.buildId,
      buildKey: seed.buildKey,
      attempt: 2,
      leaseEpoch: 3,
    });
    expect(
      db.database
        .prepare("SELECT status FROM build_attempts WHERE attempt_id = ?")
        .get(seed.attemptId),
    ).toEqual({ status: "failed" });
    expect(
      db.database
        .prepare("SELECT COUNT(*) AS count FROM build_attempts WHERE build_id = ?")
        .get(seed.buildId),
    ).toEqual({ count: 2 });
  });

  it("retries a rejected registry mismatch through the normal pre-runtime path and fences its report", async () => {
    const db = new SQLiteD1();
    installSchema(db);
    const seed = await seedFailedPreRuntimeCanary(db, "release-registry-mismatch", {
      code: "ARTIFACT_REJECTED",
      reason: "registry_mismatch",
      retryable: false,
    });
    const releases = store(db);
    const candidateBefore = db.database
      .prepare("SELECT candidate_json FROM release_candidates WHERE release_id = ?")
      .get(seed.release.id);
    const status = await releases.getReleaseRetryStatus(seed.release.id);
    expect(status?.build?.failure).toEqual({ code: "ARTIFACT_REJECTED", retryable: false });
    expect(status?.build?.failure).not.toHaveProperty("reason");

    const result = await releases.retryPreRuntimeCanaryBuild(retryCommand(seed.release.id));
    if (result.kind !== "accepted") throw new Error(`expected an accepted retry: ${JSON.stringify(result)}`);
    expect(result.duplicate).toBe(false);
    expect(result.status.build).toMatchObject({ status: "pending", attemptCount: 1, failure: null });
    expect(
      db.database
        .prepare("SELECT candidate_json FROM release_candidates WHERE release_id = ?")
        .get(seed.release.id),
    ).toEqual(candidateBefore);
    expect(
      db.database
        .prepare("SELECT status, lease_epoch, active_attempt_id, failure_json FROM builds WHERE build_id = ?")
        .get(seed.buildId),
    ).toEqual({ status: "pending", lease_epoch: 2, active_attempt_id: null, failure_json: null });
    expect(
      db.database
        .prepare("SELECT status, lease_epoch, failure_json FROM build_attempts WHERE attempt_id = ?")
        .get(seed.attemptId),
    ).toMatchObject({ status: "failed", lease_epoch: 1, failure_json: seed.failureJson });

    const buildQueue = new D1BuildStore(db);
    const staleReport = await buildQueue.recordReport({
      request: {
        buildId: seed.buildId,
        attemptId: seed.attemptId,
        leaseEpoch: 1,
        leaseToken: "lease-token-old-attempt-00000000",
        workerId: "worker-old",
        sequence: 2,
        buildKey: seed.buildKey,
        result: { kind: "failed", code: "BUILD_FAILED", message: "late report", retryable: false },
      },
      serverNow: NOW + 40_000,
      reportDigest: `sha256:${"7".repeat(64)}`,
      artifact: null,
    });
    expect(staleReport).toEqual({ accepted: false, duplicate: false });

    const claim = await buildQueue.claimNext({
      workerId: "worker-retry",
      attemptId: "attempt-retry-registry-mismatch",
      leaseToken: "lease-token-new-attempt-0000000000",
      now: NOW + 50_000,
      leaseSeconds: 120,
    });
    expect(claim).toMatchObject({ buildId: seed.buildId, attempt: 2, leaseEpoch: 3 });
    expect(
      db.database
        .prepare("SELECT status FROM build_attempts WHERE attempt_id = ?")
        .get(seed.attemptId),
    ).toEqual({ status: "failed" });
  });

  it("allows immediate retry of a terminal-failed canary build before workflow reconciliation", async () => {
    const db = new SQLiteD1();
    installSchema(db);
    const seed = await seedFailedPreRuntimeCanary(db, "release-unreconciled-failure", {
      code: "ARTIFACT_REJECTED",
      reason: "registry_mismatch",
      retryable: false,
    });
    db.database
      .prepare(
        `UPDATE release_candidate_workflows
            SET state = 'canary_building', failure_code = NULL, next_attempt_at = ?
          WHERE release_id = ?`,
      )
      .run(NOW + 5 * 60_000, seed.release.id);

    const result = await store(db).retryPreRuntimeCanaryBuild(retryCommand(seed.release.id));
    if (result.kind !== "accepted") throw new Error(`expected an accepted retry: ${JSON.stringify(result)}`);
    expect(result.duplicate).toBe(false);
    expect(result.status).toMatchObject({
      workflow: {
        state: "canary_building",
        revision: 5,
        attempts: 2,
        failureCode: null,
        nextAttemptAt: null,
      },
      build: { id: seed.buildId, status: "pending", attemptCount: 1, failure: null },
    });
    expect(
      db.database
        .prepare("SELECT status, lease_epoch, failure_json FROM build_attempts WHERE attempt_id = ?")
        .get(seed.attemptId),
    ).toMatchObject({ status: "failed", lease_epoch: 1, failure_json: seed.failureJson });
  });

  it.each([
    { reason: "persisted_input_mismatch", retryable: false },
    { reason: "composition_content_mismatch", retryable: false },
    { reason: "registry_mismatch", retryable: true },
  ])("does not retry ARTIFACT_REJECTED with $reason and retryable=$retryable", async ({ reason, retryable }) => {
    const db = new SQLiteD1();
    installSchema(db);
    const seed = await seedFailedPreRuntimeCanary(db, `release-reject-${reason}-${retryable}`, {
      code: "ARTIFACT_REJECTED",
      reason,
      retryable,
    });
    const before = {
      build: db.database.prepare("SELECT * FROM builds WHERE build_id = ?").get(seed.buildId),
      revision: db.database
        .prepare("SELECT * FROM deployment_revisions WHERE revision_id = ?")
        .get(seed.revisionId),
      workflow: db.database
        .prepare("SELECT * FROM release_candidate_workflows WHERE release_id = ?")
        .get(seed.release.id),
    };

    await expect(
      store(db).retryPreRuntimeCanaryBuild(retryCommand(seed.release.id)),
    ).resolves.toEqual({ kind: "conflict", reason: "stale_or_ineligible" });
    expect({
      build: db.database.prepare("SELECT * FROM builds WHERE build_id = ?").get(seed.buildId),
      revision: db.database
        .prepare("SELECT * FROM deployment_revisions WHERE revision_id = ?")
        .get(seed.revisionId),
      workflow: db.database
        .prepare("SELECT * FROM release_candidate_workflows WHERE release_id = ?")
        .get(seed.release.id),
    }).toEqual(before);
  });

  it("does not retry a still-running build in canary_building", async () => {
    const db = new SQLiteD1();
    installSchema(db);
    const seed = await seedFailedPreRuntimeCanary(db, "release-running-build", {
      code: "ARTIFACT_REJECTED",
      reason: "registry_mismatch",
      retryable: false,
    });
    db.database
      .prepare(
        `UPDATE release_candidate_workflows
            SET state = 'canary_building', failure_code = NULL, next_attempt_at = ?
          WHERE release_id = ?`,
      )
      .run(NOW + 5 * 60_000, seed.release.id);
    db.database
      .prepare("UPDATE builds SET status = 'running' WHERE build_id = ?")
      .run(seed.buildId);
    db.database
      .prepare("UPDATE build_attempts SET status = 'running' WHERE attempt_id = ?")
      .run(seed.attemptId);
    const before = {
      build: db.database.prepare("SELECT * FROM builds WHERE build_id = ?").get(seed.buildId),
      revision: db.database
        .prepare("SELECT * FROM deployment_revisions WHERE revision_id = ?")
        .get(seed.revisionId),
      workflow: db.database
        .prepare("SELECT * FROM release_candidate_workflows WHERE release_id = ?")
        .get(seed.release.id),
      attempt: db.database
        .prepare("SELECT * FROM build_attempts WHERE attempt_id = ?")
        .get(seed.attemptId),
    };

    await expect(
      store(db).retryPreRuntimeCanaryBuild(retryCommand(seed.release.id)),
    ).resolves.toEqual({ kind: "conflict", reason: "stale_or_ineligible" });
    expect({
      build: db.database.prepare("SELECT * FROM builds WHERE build_id = ?").get(seed.buildId),
      revision: db.database
        .prepare("SELECT * FROM deployment_revisions WHERE revision_id = ?")
        .get(seed.revisionId),
      workflow: db.database
        .prepare("SELECT * FROM release_candidate_workflows WHERE release_id = ?")
        .get(seed.release.id),
      attempt: db.database
        .prepare("SELECT * FROM build_attempts WHERE attempt_id = ?")
        .get(seed.attemptId),
    }).toEqual(before);
  });

  it("resolves retry receipts before reverification without mutating release state", async () => {
    const db = new SQLiteD1();
    installSchema(db);
    const seed = await seedFailedPreRuntimeCanary(db, "release-retry-receipt");
    const releases = store(db);
    const command = retryCommand(seed.release.id);
    const accepted = await releases.retryPreRuntimeCanaryBuild(command);
    expect(accepted.kind).toBe("accepted");

    const snapshot = () => ({
      build: db.database.prepare("SELECT * FROM builds WHERE build_id = ?").get(seed.buildId),
      revision: db.database
        .prepare("SELECT * FROM deployment_revisions WHERE revision_id = ?")
        .get(seed.revisionId),
      workflow: db.database
        .prepare("SELECT * FROM release_candidate_workflows WHERE release_id = ?")
        .get(seed.release.id),
      receipts: db.database
        .prepare("SELECT * FROM idempotency_records WHERE scope = ? ORDER BY idempotency_key")
        .all(`release:${seed.release.id}`),
      auditCount: db.database.prepare("SELECT COUNT(*) AS count FROM audit_events").get(),
    });
    const before = snapshot();

    await expect(
      releases.findPreRuntimeCanaryRetry({
        releaseId: seed.release.id,
        idempotencyKey: command.idempotencyKey,
        requestHash: command.requestHash,
      }),
    ).resolves.toMatchObject({ kind: "accepted", duplicate: true });
    await expect(
      releases.findPreRuntimeCanaryRetry({
        releaseId: seed.release.id,
        idempotencyKey: "missing-retry-receipt",
        requestHash: command.requestHash,
      }),
    ).resolves.toBeNull();
    await expect(
      releases.findPreRuntimeCanaryRetry({
        releaseId: seed.release.id,
        idempotencyKey: command.idempotencyKey,
        requestHash: `sha256:${"8".repeat(64)}`,
      }),
    ).resolves.toEqual({ kind: "conflict", reason: "idempotency_key_reused" });

    expect(snapshot()).toEqual(before);
  });

  it("rejects stale revisions and runtime or active-build retries without changing durable rows", async () => {
    const staleDb = new SQLiteD1();
    installSchema(staleDb);
    const staleSeed = await seedFailedPreRuntimeCanary(staleDb, "release-stale-retry");
    const staleStore = store(staleDb);
    expect(
      await staleStore.retryPreRuntimeCanaryBuild(
        retryCommand(staleSeed.release.id, { expectedRevision: 3 }),
      ),
    ).toEqual({ kind: "conflict", reason: "stale_or_ineligible" });
    expect(
      staleDb.database.prepare("SELECT status FROM builds WHERE build_id = ?").get(staleSeed.buildId),
    ).toEqual({ status: "failed" });

    const runtimeDb = new SQLiteD1();
    installSchema(runtimeDb);
    const runtimeSeed = await seedFailedPreRuntimeCanary(runtimeDb, "release-runtime-retry");
    runtimeDb.database
      .prepare(
        `UPDATE logical_instances SET runtime_epoch = 1, desired_state = 'running',
           observed_state = 'starting', observed_generation = 1, observed_runtime_epoch = 1,
           reservation_state = 'pending' WHERE instance_id = ?`,
      )
      .run(retryBinding.instanceId);
    expect(
      await store(runtimeDb).retryPreRuntimeCanaryBuild(
        retryCommand(runtimeSeed.release.id),
      ),
    ).toEqual({ kind: "conflict", reason: "stale_or_ineligible" });
    expect(
      runtimeDb.database
        .prepare("SELECT status FROM deployment_revisions WHERE revision_id = ?")
        .get(runtimeSeed.revisionId),
    ).toEqual({ status: "failed" });

    const activeDb = new SQLiteD1();
    installSchema(activeDb);
    const activeSeed = await seedFailedPreRuntimeCanary(activeDb, "release-active-retry");
    activeDb.database
      .prepare("UPDATE builds SET status = 'claimed' WHERE build_id = ?")
      .run(activeSeed.buildId);
    expect(
      await store(activeDb).retryPreRuntimeCanaryBuild(
        retryCommand(activeSeed.release.id),
      ),
    ).toEqual({ kind: "conflict", reason: "stale_or_ineligible" });
    expect(
      activeDb.database
        .prepare("SELECT state, revision FROM release_candidate_workflows WHERE release_id = ?")
        .get(activeSeed.release.id),
    ).toEqual({ state: "blocked", revision: 4 });
  });

  it("keeps the durable canary sample token through Cron and progresses health written during its lease", async () => {
    const db = new SQLiteD1();
    installSchema(db);
    const release = candidate();
    const releases = store(db);
    await releases.createCandidate(release);
    const sampleAt = NOW + 60_000;
    seedCanaryHealthFixture(db, release.id, sampleAt);
    const activeCheckAt = sampleAt + 10 * 60_000;
    db.database
      .prepare("UPDATE operations SET status = 'running' WHERE operation_id = 'canary-operation'")
      .run();
    await expect(
      releases.getCanaryHealthSchedule({
        instanceId: "canary-instance",
        repositoryId: 101,
        generation: 7,
        runtimeEpoch: 4,
        clusterId: "cluster-canary",
        now: activeCheckAt,
      }),
    ).resolves.toMatchObject({
      nextCheckAt: activeCheckAt + 60_000,
      sampleDueAt: null,
    });
    db.database
      .prepare("UPDATE operations SET status = 'succeeded' WHERE operation_id = 'canary-operation'")
      .run();

    const schedule = await releases.getCanaryHealthSchedule({
      instanceId: "canary-instance",
      repositoryId: 101,
      generation: 7,
      runtimeEpoch: 4,
      clusterId: "cluster-canary",
      now: sampleAt,
    });
    expect(schedule).toEqual({
      healthOperationId: "canary-operation",
      nextCheckAt: sampleAt + 60_000,
      sampleDueAt: sampleAt,
    });

    const cronLease = (
      await releases.claimCandidateWork({
        owner: "cron-worker",
        now: sampleAt,
        leaseMs: 60_000,
        limit: 1,
        releaseId: release.id,
      })
    )[0]!;
    expect(cronLease.workflow.state).toBe("canary_observing");

    db.database
      .prepare(
        `INSERT INTO runtime_health_observations (
           instance_id, repository_id, runtime_epoch, generation, cluster_id, operation_id,
           provider_observation_id, observed_at, evidence_json
         ) VALUES ('canary-instance', 101, 4, 7, 'cluster-canary', 'canary-operation',
                   'provider-sample-1', ?, '{}')`,
      )
      .run(sampleAt + 1);
    await expect(
      releases.prepareCanaryHealthProgress({
        operationId: "canary-operation",
        now: sampleAt + 2,
      }),
    ).resolves.toMatchObject({ kind: "leased", releaseId: release.id });

    const cronSnapshot = {
      ...cronLease.workflow,
      updatedAt: new Date(sampleAt + 3).toISOString(),
    };
    expect(
      await releases.saveCandidateWorkflow({
        lease: cronLease,
        next: cronSnapshot,
        releaseLease: true,
      }),
    ).toBe("saved");
    expect(
      db.database
        .prepare("SELECT next_attempt_at FROM release_candidate_workflows WHERE release_id = ?")
        .get(release.id),
    ).toEqual({ next_attempt_at: sampleAt });

    await expect(
      releases.prepareCanaryHealthProgress({
        operationId: "canary-operation",
        now: sampleAt + 4,
      }),
    ).resolves.toEqual({ kind: "due", releaseId: release.id });
    const targeted = await releases.claimCandidateWork({
      owner: "health-event-worker",
      now: sampleAt + 4,
      leaseMs: 60_000,
      limit: 1,
      releaseId: release.id,
    });
    expect(targeted.map(({ candidate: item }) => item.id)).toEqual([release.id]);
  });

  it("matches a successful canonical canary stop only to its promoting cleanup workflow", async () => {
    const db = new SQLiteD1();
    installSchema(db);
    const release = candidate();
    const releases = store(db);
    await releases.createCandidate(release);
    seedCanaryHealthFixture(db, release.id, NOW + 300_000);
    db.database
      .prepare(
        `UPDATE release_candidate_workflows
            SET state = 'canary_cleanup', cleanup_disposition = 'promote'
          WHERE release_id = ?`,
      )
      .run(release.id);
    db.database
      .prepare(
        `INSERT INTO operations (
           operation_id, instance_id, repository_id, generation, runtime_epoch, kind, status,
           phase, idempotency_scope, idempotency_key, request_hash, actor_id,
           authorization_revision, created_at, updated_at
         ) VALUES ('canary-stop-operation', 'canary-instance', 101, 7, 4, 'stop', 'succeeded',
                   'complete', 'canary-test', ?, 'hash', 'system:stable-release-canary', 3, ?, ?)`,
      )
      .run(`stable-canary-stop:${release.id}`, NOW, NOW);

    await expect(
      releases.wakeCanaryCleanupAfterStop("canary-stop-operation", NOW + 60_000),
    ).resolves.toBe(
      release.id,
    );
    expect(
      db.database
        .prepare("SELECT next_attempt_at FROM release_candidate_workflows WHERE release_id = ?")
        .get(release.id),
    ).toEqual({ next_attempt_at: NOW + 60_000 });
    db.database
      .prepare("UPDATE operations SET actor_id = 'operator-test' WHERE operation_id = ?")
      .run("canary-stop-operation");
    await expect(
      releases.wakeCanaryCleanupAfterStop("canary-stop-operation", NOW + 60_000),
    ).resolves.toBeNull();
  });

  it("promotes automatically from the second 60-second health sample through reported stop completion", async () => {
    const db = new SQLiteD1();
    installSchema(db);
    const release = candidate();
    const releases = store(db);
    await releases.createCandidate(release);
    const firstHealth = {
      artifactDigest: DIGEST,
      runtimeId: "canary-instance",
      operationId: "canary-operation",
      runtimeEpoch: 4,
      providerObservationId: "health-first",
      source: "runtime-provisioner-observation" as const,
      imageIdentityVerified: true as const,
      observedAt: NOW,
      checks: { startup: true as const, auth: true as const, uiApiMcp: true as const, persistence: true as const },
      checkEvidence: { startup: "startup-1", auth: "auth-1", uiApiMcp: "mcp-1", persistence: "persistence-1" },
    };
    const secondHealth = {
      ...firstHealth,
      providerObservationId: "health-second",
      observedAt: NOW + 60_000,
    };
    seedCanaryHealthFixture(db, release.id, NOW + 60_000);
    db.database
      .prepare(
        `UPDATE release_candidate_workflows
            SET healthy_since = ?, last_healthy_at = ?, last_health_evidence_json = ?
          WHERE release_id = ?`,
      )
      .run(NOW, NOW, JSON.stringify(firstHealth), release.id);
    db.database
      .prepare(
        `INSERT INTO runtime_health_observations (
           instance_id, repository_id, runtime_epoch, generation, cluster_id, operation_id,
           provider_observation_id, observed_at, evidence_json
         ) VALUES ('canary-instance', 101, 4, 7, 'cluster-canary', 'canary-operation', ?, ?, '{}')`,
      )
      .run(secondHealth.providerObservationId, secondHealth.observedAt);
    db.database
      .prepare(
        `INSERT INTO operations (
           operation_id, instance_id, repository_id, generation, runtime_epoch, kind, status,
           phase, idempotency_scope, idempotency_key, request_hash, actor_id,
           authorization_revision, created_at, updated_at
         ) VALUES ('canary-stop-operation', 'canary-instance', 101, 8, 4, 'stop', 'pending',
                   'accepted', 'canary-test', ?, 'hash', 'system:stable-release-canary', 3, ?, ?)`,
      )
      .run(`stable-canary-stop:${release.id}`, NOW, NOW);

    let currentTime = NOW + 60_000;
    let stopStatus: "pending" | "succeeded" = "pending";
    const stopOperation = () => ({
      id: "canary-stop-operation",
      idempotencyKey: `stable-canary-stop:${release.id}`,
      instanceId: "canary-instance",
      repositoryId: 101,
      generation: 8,
      runtimeEpoch: 4,
      kind: "stop" as const,
      status: stopStatus,
      deploymentRevisionId: "canary-revision",
      result: null,
    });
    const startOperation = {
      id: "canary-operation",
      instanceId: "canary-instance",
      repositoryId: 101,
      generation: 7,
      runtimeEpoch: 4,
      kind: "start" as const,
      status: "succeeded" as const,
      deploymentRevisionId: "canary-revision",
      result: null,
    };
    const proof = {
      instanceId: "canary-instance",
      repositoryId: 101,
      retiredEpoch: 4,
      providerObservationId: "writer-census-zero",
      censusObservedAt: NOW + 61_000,
      remainingWriters: 0 as const,
      evidenceIdentities: ["census:canary-instance:4"],
      source: "runtime-provider-census" as const,
    };
    let canaryInstance: {
      instanceId: string;
      repositoryId: number;
      generation: number;
      runtimeEpoch: number;
      desiredState: "running" | "stopped";
      observedState: "ready" | "stopped";
      desiredRevisionId: string;
      desiredArtifactDigest: string;
      observedRevisionId: string;
      observedRuntimeEpoch: number;
    } = {
      instanceId: "canary-instance",
      repositoryId: 101,
      generation: 7,
      runtimeEpoch: 4,
      desiredState: "running" as const,
      observedState: "ready" as const,
      desiredRevisionId: "canary-revision",
      desiredArtifactDigest: DIGEST,
      observedRevisionId: "canary-revision",
      observedRuntimeEpoch: 4,
    };
    const composition = createT11RolloutComposition({
      db,
      configurations: {
        stage: async () => { throw new Error("not needed for canary promotion"); },
        findStageByIdempotency: async () => null,
        activateStageUnderClusterFence: async () => null,
      },
      canaryConfigurations: {
        plan: async () => { throw new Error("canary is already running"); },
        findByIdempotency: async () => null,
      },
      instances: {
        async getByRepositoryId() {
          return {
            binding: {
              repositoryId: 101,
              instanceId: "canary-instance",
              bindingEpoch: 2,
              authorizationRevision: 3,
              suspended: false,
            },
            instance: canaryInstance,
          };
        },
        async requestDesiredState() {
          canaryInstance = {
            ...canaryInstance,
            generation: 8,
            desiredState: "stopped",
            observedState: "stopped",
          };
          return {
            instance: canaryInstance,
            operation: stopOperation(),
          };
        },
      } as unknown as InstanceService,
      operations: {
        async getById(operationId: string) {
          return operationId === "canary-operation" ? startOperation : stopOperation();
        },
      } as unknown as OperationService,
      canaryBinding: {
        repositoryId: 101,
        instanceId: "canary-instance",
        bindingEpoch: 2,
        authorizationRevision: 3,
        requestedModules: [],
        resourceProfileId: "small",
      },
      canaryObservations: {
        latestHealth: async () => secondHealth,
        writerAbsence: async () => ({ ...proof, censusObservedAt: currentTime - 1_000 }),
      },
      defaultClusterId: "cluster-canary",
      clock: {
        now: () => new Date(currentTime).toISOString(),
        nowMs: () => currentTime,
      },
      ids: { newReleaseId: () => "unused-release" },
      workerId: "canary-promotion-test",
      healthWindowMs: 60_000,
      authorizeOperator: async () => null,
      registry: {
        async verifyImage(repository, manifestDigest, platform) {
          return { repository, manifestDigest, platform };
        },
      },
      provenance: { async verify() { return { verified: true, evidence: [] }; } },
      producerMetadata: { async verify() { return { kind: "verified", evidence: [] }; } },
    });

    await composition.progressCanaryHealth("canary-operation");
    expect(
      db.database
        .prepare("SELECT state, next_attempt_at FROM release_candidate_workflows WHERE release_id = ?")
        .get(release.id),
    ).toMatchObject({ state: "canary_cleanup", next_attempt_at: expect.any(Number) });
    expect((await composition.releases.getStableChannel()).currentReleaseId).toBeNull();

    currentTime += 10_000;
    stopStatus = "succeeded";
    db.database
      .prepare("UPDATE operations SET status = 'succeeded', phase = 'complete', updated_at = ? WHERE operation_id = ?")
      .run(currentTime, "canary-stop-operation");
    const stopReportRoutes = createProvisionerRoutes({
      operations: {
        async report() {
          return { operation: stopOperation(), applied: true, duplicate: false };
        },
      } as unknown as OperationService,
      workerId: "provisioner-test",
      clusterId: "cluster-canary",
      now: () => currentTime,
      afterCanaryStopReported: composition.progressCanaryStop,
      resolveRuntimeContext: async () => null,
    });
    const background: Promise<unknown>[] = [];
    const stopReport = await stopReportRoutes.fetch(
      new Request("https://control.example/report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operationId: "canary-stop-operation",
          workerId: "provisioner-test",
          leaseToken: "lease-token-aaaaaaaaaaaaaaaaaaaaaaaa",
          leaseEpoch: 1,
          sequence: 1,
          terminal: "succeeded",
          observation: {
            instanceId: "canary-instance",
            repositoryId: 101,
            generation: 8,
            runtimeEpoch: 4,
            sequence: 1,
            observedState: "stopped",
            observedArtifactDigest: null,
            observedRevisionId: null,
          },
        }),
      }),
      {},
      {
        waitUntil(promise) { background.push(promise); },
        passThroughOnException() {},
        props: {},
      },
    );
    expect(stopReport.status).toBe(200);
    await Promise.all(background);

    expect((await composition.releases.getStableChannel()).currentReleaseId).toBe(release.id);
    expect((await composition.releases.findById(release.id))?.status).toBe("available");
    expect(
      db.database
        .prepare(
          `SELECT state, canary_cleanup_complete, cleanup_evidence_json
             FROM release_candidate_workflows WHERE release_id = ?`,
        )
        .get(release.id),
    ).toMatchObject({
      state: "promoted",
      canary_cleanup_complete: 1,
      cleanup_evidence_json: expect.any(String),
    });
    expect(
      db.database
        .prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'release.stable.promoted'")
        .get(),
    ).toMatchObject({ count: 1 });
  });

  it("keeps same-owner same-timestamp targeted claims isolated by release", async () => {
    const db = new SQLiteD1();
    installSchema(db);
    const releases = store(db);
    const firstRelease = candidate("release-a", "1.0.0", DIGEST);
    const secondRelease = candidate("release-b", "1.0.1", `sha256:${"c".repeat(64)}`);
    await releases.createCandidate(firstRelease);
    await releases.createCandidate(secondRelease);

    const first = await releases.claimCandidateWork({
      owner: "shared-worker",
      now: NOW,
      leaseMs: 60_000,
      limit: 1,
      releaseId: firstRelease.id,
    });
    const second = await releases.claimCandidateWork({
      owner: "shared-worker",
      now: NOW,
      leaseMs: 60_000,
      limit: 1,
      releaseId: secondRelease.id,
    });

    expect(first.map(({ candidate: item }) => item.id)).toEqual([firstRelease.id]);
    expect(second.map(({ candidate: item }) => item.id)).toEqual([secondRelease.id]);
  });

  it("rolls back candidate and audit if atomic admission cannot create its workflow", async () => {
    const db = new SQLiteD1();
    installSchema(db);
    db.database.exec(`
      CREATE TRIGGER reject_initial_release_workflow
      BEFORE INSERT ON release_candidate_workflows
      BEGIN SELECT RAISE(ABORT, 'workflow admission failed'); END;
    `);
    const release = candidate();

    await expect(
      store(db).createCandidateWithAudit({
        candidate: release,
        audit: {
          actorId: "operator-1",
          requestId: "request-1",
          action: "release.candidate.admit",
          targetId: release.id,
          outcome: "accepted",
          metadata: { digest: release.imageDigest },
          occurredAt: TIME,
        },
      }),
    ).rejects.toThrow("workflow admission failed");

    expect(
      db.database.prepare("SELECT COUNT(*) AS count FROM release_candidates").get(),
    ).toMatchObject({ count: 0 });
    expect(db.database.prepare("SELECT COUNT(*) AS count FROM audit_events").get()).toMatchObject({
      count: 0,
    });
  });

  it("persists admitted candidates, audit, cursor, workflow leases and channel CAS across store reconstruction", async () => {
    const db = new SQLiteD1();
    installSchema(db);
    const release = candidate();
    const first = store(db);
    expect(
      await first.createCandidateWithAudit({
        candidate: release,
        audit: {
          actorId: "operator-1",
          requestId: "request-1",
          action: "release.candidate.admit",
          targetId: release.id,
          outcome: "accepted",
          metadata: { digest: release.imageDigest },
          occurredAt: TIME,
        },
      }),
    ).toBe("created");
    expect(
      db.database
        .prepare("SELECT state, next_attempt_at FROM release_candidate_workflows WHERE release_id = ?")
        .get(release.id),
    ).toMatchObject({ state: "queued", next_attempt_at: null });
    db.database
      .prepare("DELETE FROM release_candidate_workflows WHERE release_id = ?")
      .run(release.id);
    expect(await first.createCandidate(release)).toBe("duplicate");
    expect(
      db.database
        .prepare("SELECT state FROM release_candidate_workflows WHERE release_id = ?")
        .get(release.id),
    ).toMatchObject({ state: "queued" });
    expect(db.database.prepare("SELECT count(*) AS count FROM audit_events").get()).toMatchObject({
      count: 1,
    });
    expect(
      await first.commitDiscoveryPage({
        expectedRevision: 0,
        expectedCursor: null,
        page: { items: [release], nextCursor: null },
        at: TIME,
      }),
    ).toBe("advanced");

    const afterRestart = store(db);
    const lease = (
      await afterRestart.claimCandidateWork({
        owner: "worker-a",
        now: NOW,
        leaseMs: 60_000,
        limit: 1,
      })
    )[0];
    expect(lease?.workflow.state).toBe("queued");
    expect(
      await afterRestart.saveCandidateWorkflow({
        lease: lease!,
        next: { ...lease!.workflow, state: "canary_building", attempts: 1, updatedAt: TIME },
        releaseLease: true,
      }),
    ).toBe("saved");
    const reclaimed = (
      await store(db).claimCandidateWork({
        owner: "worker-b",
        now: NOW + 1,
        leaseMs: 60_000,
        limit: 1,
      })
    )[0];
    expect(reclaimed?.workflow.state).toBe("canary_building");
    expect(reclaimed?.workflow.revision).toBe(1);
    expect(
      await afterRestart.promoteStable({
        releaseId: release.id,
        expectedRevision: 0,
        promotedAt: TIME,
      }),
    ).toBe("promoted");
    expect(db.database.prepare("SELECT count(*) AS count FROM audit_events").get()).toMatchObject({
      count: 2,
    });
    expect(
      db.database
        .prepare(
          "SELECT actor_kind, action, outcome FROM audit_events WHERE action = 'release.stable.promoted'",
        )
        .get(),
    ).toMatchObject({
      actor_kind: "system",
      action: "release.stable.promoted",
      outcome: "accepted",
    });
    expect(
      await store(db).promoteStable({
        releaseId: release.id,
        expectedRevision: 0,
        promotedAt: TIME,
      }),
    ).toBe("ineligible");
    const next = candidate("release-2", "2.0.0", `sha256:${"b".repeat(64)}`);
    await store(db).createCandidate(next);
    const checkpoint = await store(db).getDiscoveryCheckpoint();
    expect(checkpoint.cursor).toBe(encodeURIComponent(JSON.stringify([TIME, release.id])));
    const unreconciledTail = await store(db).listCandidates(checkpoint.cursor, 50);
    expect(unreconciledTail.items.map((item) => item.id)).toEqual([next.id]);
    expect(
      db.database
        .prepare("SELECT state FROM release_candidate_workflows WHERE release_id = ?")
        .get(next.id),
    ).toMatchObject({ state: "queued" });
    expect(
      await store(db).promoteStable({
        releaseId: next.id,
        expectedRevision: 0,
        promotedAt: TIME,
      }),
    ).toBe("conflict");
    expect((await store(db).getStableChannel()).currentReleaseId).toBe(release.id);
    expect((await store(db).findById(release.id))?.status).toBe("available");
  });

  it("bounds workflow claims and recovers a lease after a worker crash", async () => {
    const db = new SQLiteD1();
    installSchema(db);
    const releases = [
      candidate("release-a"),
      candidate("release-b", "2.0.0", `sha256:${"b".repeat(64)}`),
    ];
    const first = store(db);
    for (const release of releases) await first.createCandidate(release);
    await first.commitDiscoveryPage({
      expectedRevision: 0,
      expectedCursor: null,
      page: { items: releases, nextCursor: null },
      at: TIME,
    });

    const originalLease = await first.claimCandidateWork({
      owner: "worker-before-crash",
      now: NOW,
      leaseMs: 60_000,
      limit: 1,
    });
    expect(originalLease).toHaveLength(1);
    expect(originalLease[0]?.candidate.id).toBe("release-a");

    const recoveredLease = await store(db).claimCandidateWork({
      owner: "worker-after-crash",
      now: NOW + 60_000,
      leaseMs: 60_000,
      limit: 1,
    });
    expect(recoveredLease).toHaveLength(1);
    expect(recoveredLease[0]?.candidate.id).toBe("release-a");
    expect(recoveredLease[0]?.epoch).toBe(originalLease[0]!.epoch + 1);
  });

  it("creates durable rollout fanout and permits only one unexpired cluster writer", async () => {
    const db = new SQLiteD1();
    installSchema(db);
    const release = candidate();
    const first = store(db);
    await first.createCandidate(release);
    await first.promoteStable({ releaseId: release.id, expectedRevision: 0, promotedAt: TIME });
    db.database
      .prepare(
        "INSERT INTO logical_instances(instance_id, repository_id, desired_state, created_at, updated_at) VALUES (?, ?, 'running', ?, ?)",
      )
      .run("instance-1", 101, NOW, NOW);
    expect(
      await first.recordFollowerPage({
        releaseId: release.id,
        expectedCursor: null,
        page: { items: [follower("instance-1")], nextCursor: null },
        at: TIME,
      }),
    ).toBe("recorded");
    const afterRestart = store(db);
    const due = await afterRestart.listDueRollouts(NOW, 10);
    expect(due).toHaveLength(1);
    expect(due[0]?.snapshot.instanceId).toBe("instance-1");

    const lease = await afterRestart.claimClusterLease({
      clusterId: "cluster-1",
      rolloutId: due[0]!.id,
      owner: "rollout-worker-a",
      now: NOW,
      leaseMs: 60_000,
    });
    expect(lease).not.toBeNull();
    const concurrent = await store(db).claimClusterLease({
      clusterId: "cluster-1",
      rolloutId: due[0]!.id,
      owner: "rollout-worker-b",
      now: NOW + 1,
      leaseMs: 60_000,
    });
    expect(concurrent).toBeNull();
    expect(await afterRestart.findClusterLease("cluster-1")).toMatchObject({
      owner: "rollout-worker-a",
      activeOperationId: null,
    });
  });

  it("activates the persisted build stage through the current cluster lease", async () => {
    const db = new SQLiteD1();
    installSchema(db);
    const release = candidate();
    const activationCalls: unknown[] = [];
    const activator: StagedRolloutActivator = {
      async findStageByIdempotency(repositoryId, idempotencyKey) {
        expect(repositoryId).toBe(101);
        expect(idempotencyKey).toBe(
          await stableRolloutStageIdempotencyKey("release-1", "instance-1", "revision-1"),
        );
        return {
          stageId: "stage-1",
          buildKey: BUILD_KEY,
          buildId: "build-1",
          artifactDigest: DIGEST,
          status: "staged",
        };
      },
      async activateStageUnderClusterFence(input) {
        activationCalls.push(input);
        return { operationId: "op-activated", generation: 8 };
      },
    };
    const rollouts = store(db, activator);
    await rollouts.createCandidate(release);
    await rollouts.promoteStable({ releaseId: release.id, expectedRevision: 0, promotedAt: TIME });
    db.database
      .prepare(
        "INSERT INTO logical_instances(instance_id, repository_id, desired_state, created_at, updated_at) VALUES (?, ?, 'running', ?, ?)",
      )
      .run("instance-1", 101, NOW, NOW);
    await rollouts.recordFollowerPage({
      releaseId: release.id,
      expectedCursor: null,
      page: { items: [follower("instance-1")], nextCursor: null },
      at: TIME,
    });
    const [initial] = await rollouts.listDueRollouts(NOW, 1);
    expect(initial).toBeDefined();
    await rollouts.saveRollout({
      rollout: {
        ...initial!,
        state: "dispatch_pending",
        buildKey: BUILD_KEY,
        buildId: "build-1",
        artifactDigest: DIGEST,
        updatedAt: TIME,
      },
      expectedRevision: initial!.revision,
      at: TIME,
    });
    const rollout = (await rollouts.findRollout(initial!.id))!;
    const lease = await rollouts.claimClusterLease({
      clusterId: rollout.clusterId,
      rolloutId: rollout.id,
      owner: "rollout-worker",
      now: NOW,
      leaseMs: 60_000,
    });
    expect(lease).not.toBeNull();

    await expect(
      rollouts.dispatchUnderClusterLease({
        lease: lease!,
        rollout,
        current: follower("instance-1"),
        actorId: "system:stable-release",
        idempotencyKey: await stableRolloutOperationIdempotencyKey(
          "release-1",
          "instance-1",
          2,
          BUILD_KEY,
        ),
        at: TIME,
      }),
    ).resolves.toEqual({ kind: "dispatched", operationId: "op-activated", generation: 8 });
    expect(activationCalls).toEqual([
      {
        stageId: "stage-1",
        clusterId: "cluster-1",
        rolloutId: rollout.id,
        releaseId: release.id,
        owner: "rollout-worker",
        leaseEpoch: lease!.epoch,
        expectedRolloutRevision: rollout.revision,
        expectedBuildKey: BUILD_KEY,
        expectedBuildId: "build-1",
        expectedArtifactDigest: DIGEST,
        actorId: "system:stable-release",
        actorKind: "system",
        requestId: await stableRolloutStageIdempotencyKey("release-1", "instance-1", "revision-1"),
        operationId: "op-test",
        operationIdempotencyKey: await stableRolloutOperationIdempotencyKey(
          "release-1",
          "instance-1",
          2,
          BUILD_KEY,
        ),
        now: NOW,
      },
    ]);
  });

  it("reads the current stable configuration and assigned cluster from actual D1 rows", async () => {
    const db = new SQLiteD1();
    installSchema(db);
    const selected = {
      releaseId: "release-old",
      requestedModules: ["forms"],
      resourceProfileId: "balanced",
      policy: "stable",
    };
    const buildInput = {
      contractVersion: "scriptorium-build/v1",
      producerRevision: PRODUCER,
      runtimeBaseDigest: DIGEST,
      buildKitDigest: DIGEST,
      recipeDigest: DIGEST,
      sourceDigest: DIGEST,
      lockDigest: DIGEST,
      requestedModules: ["forms"],
      resolvedModules: [{ id: "forms", version: "1.0.0", artifactDigest: DIGEST }],
      platform: "linux/amd64",
      options: {},
    };
    db.database.exec(`
      INSERT INTO logical_instances (
        instance_id, repository_id, desired_state, policy, generation, runtime_epoch,
        desired_revision_id, desired_artifact_digest, current_artifact_digest,
        reservation_state, reservation_id, created_at, updated_at
      ) VALUES ('instance-1', 101, 'running', 'stable', 7, 4,
        'revision-7', '${DIGEST}', '${DIGEST}', 'allocated', 'reservation-4', ${NOW}, ${NOW});
      INSERT INTO repository_bindings (
        repository_id, instance_id, installation_id, owner, name,
        authorization_revision, binding_epoch, suspended, created_at, updated_at
      ) VALUES (101, 'instance-1', 201, 'owner', 'repo', 3, 2, 0, ${NOW}, ${NOW});
      INSERT INTO builds (build_id, build_key, build_input_json, status, created_at, updated_at)
      VALUES ('build-7', 'key-7', '${JSON.stringify(buildInput)}', 'succeeded', ${NOW}, ${NOW});
      INSERT INTO deployment_revisions (
        revision_id, instance_id, repository_id, generation, build_key, build_id,
        selection_json, resource_requirements_json, runtime_metadata_json,
        artifact_digest, status, actor_id, created_at
      ) VALUES ('revision-7', 'instance-1', 101, 7, 'key-7', 'build-7',
        '${JSON.stringify(selected)}', '{"cpuMilli":100,"memoryMiB":128,"ephemeralStorageMiB":256}',
        '{"contractVersion":"scriptorium-platform/v1","producerRevision":"${PRODUCER}","listener":{"port":3000},"paths":{"liveness":"/health/live","readiness":"/health/ready","metadata":"/api/platform/v1/metadata","shutdown":"/api/platform/v1/shutdown","status":"/api/platform/v1/status","quiesce":"/api/platform/v1/quiesce","resume":"/api/platform/v1/resume"},"shutdownTimeoutSeconds":30}',
        NULL, 'admitted', 'actor', ${NOW});
      INSERT INTO runtime_reservations (
        reservation_id, instance_id, repository_id, runtime_epoch, generation,
        cluster_id, status, capacity_snapshot_epoch, cpu_milli, memory_mib,
        ephemeral_storage_mib, created_at, updated_at
      ) VALUES ('reservation-4', 'instance-1', 101, 4, 7, 'cluster-actual',
        'allocated', 1, 100, 128, 256, ${NOW}, ${NOW});
    `);

    const followers = new D1StableFollowerRepository(db, "cluster-default");
    const page = await followers.listInstances(null, 1);
    expect(page).toMatchObject({
      nextCursor: null,
      items: [
        {
          instanceId: "instance-1",
          repositoryId: 101,
          bindingEpoch: 2,
          authorizationRevision: 3,
          clusterId: "cluster-actual",
          generation: 7,
          runtimeEpoch: 4,
          desiredState: "running",
          policy: "stable",
          desiredReleaseId: "release-old",
          configurationRevision: "revision-7",
          selectedModuleIds: ["forms"],
          resourceProfileId: "balanced",
          platform: "linux/amd64",
        },
      ],
    });
    expect(await followers.findCurrent("instance-1")).toEqual(page.items[0]);
  });
});

describe("operator Canary wait exception", () => {
  async function fixture() {
    const db = new SQLiteD1();
    installSchema(db);
    const releases = store(db), release = candidate();
    await releases.createCandidate(release);
    seedCanaryHealthFixture(db, release.id, NOW + 5 * 60_000);
    const evidence = {
      artifactDigest: DIGEST, runtimeId: "canary-instance", operationId: "canary-operation",
      runtimeEpoch: 4, providerObservationId: "health-skip-1", source: "runtime-provisioner-observation",
      imageIdentityVerified: true, observedAt: NOW,
      checks: { startup: true, auth: true, uiApiMcp: true, persistence: true },
      checkEvidence: { startup: "startup", auth: "auth", uiApiMcp: "ui-api-mcp", persistence: "persistence" },
    };
    db.database.prepare(`UPDATE release_candidate_workflows
      SET healthy_since = ?, last_healthy_at = ?, last_health_evidence_json = ? WHERE release_id = ?`)
      .run(NOW, NOW, JSON.stringify(evidence), release.id);
    db.database.prepare(`INSERT INTO runtime_health_observations
      (instance_id, repository_id, runtime_epoch, generation, cluster_id, operation_id,
       provider_observation_id, observed_at, evidence_json)
      VALUES ('canary-instance', 101, 4, 7, 'cluster-canary', 'canary-operation', 'health-skip-1', ?, '{}')`).run(NOW);
    const command: CanaryWaitSkipCommand = { releaseId: release.id, expectedRevision: 1,
      idempotencyKey: "skip-wait-1", requestHash: `sha256:${"d".repeat(64)}`, actorId: "operator-owner",
      requestId: "skip-request-1", now: NOW + 1_000, reason: "Owner requested immediate release" };
    return { db, releases, release, command };
  }

  it("skips only elapsed time, preserves real evidence, records one audited idempotent action and requires normal cleanup", async () => {
    const {db, releases, release, command} = await fixture();
    expect(await releases.skipCanaryWait(command)).toMatchObject({ kind: "accepted", duplicate: false,
      status: { workflow: { state: "canary_cleanup", revision: 2 } } });
    expect(db.database.prepare(`SELECT healthy_since, last_healthy_at, canary_cleanup_complete,
      cleanup_evidence_json, cleanup_disposition FROM release_candidate_workflows`).get()).toEqual({
      healthy_since: NOW, last_healthy_at: NOW, canary_cleanup_complete: 0,
      cleanup_evidence_json: null, cleanup_disposition: "promote",
    });
    expect((await releases.findById(release.id))?.status).toBe("candidate");
    expect((await releases.getStableChannel()).currentReleaseId).toBeNull();
    const audit = db.database.prepare("SELECT actor_id, action, metadata_json FROM audit_events WHERE action='release.canary-wait.skipped'").get()!;
    expect(audit.actor_id).toBe(command.actorId);
    expect(JSON.parse(String(audit.metadata_json))).toMatchObject({ reason: command.reason, healthObservedAt: NOW });
    expect(await releases.skipCanaryWait(command)).toMatchObject({kind: "accepted", duplicate: true});
    expect(db.database.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action='release.canary-wait.skipped'").get()).toEqual({count: 1});
    expect(await releases.skipCanaryWait({...command, requestHash: `sha256:${"e".repeat(64)}`}))
      .toEqual({kind: "conflict", reason: "idempotency_key_reused"});
  });

  it.each([
    "UPDATE release_candidate_workflows SET revision=2",
    "UPDATE release_candidate_workflows SET lease_owner='other', lease_expires_at=9999999999999",
    "UPDATE release_candidate_workflows SET state='blocked'",
    "UPDATE runtime_health_observations SET provider_observation_id='new-sample'",
    "UPDATE logical_instances SET runtime_epoch=5",
    "UPDATE repository_bindings SET suspended=1",
    "UPDATE operations SET status='running'",
    "DELETE FROM runtime_health_observations",
  ])("rejects stale or ineligible state without partial receipt/audit: %s", async sql => {
    const {db, releases, command} = await fixture();
    db.database.exec(sql);
    const before = db.database.prepare("SELECT state, revision FROM release_candidate_workflows").get();
    expect(await releases.skipCanaryWait(command)).toMatchObject({kind: "conflict"});
    expect(db.database.prepare("SELECT state, revision FROM release_candidate_workflows").get()).toEqual(before);
    expect(db.database.prepare("SELECT COUNT(*) AS count FROM idempotency_records WHERE response_kind='release-canary-wait-skip'").get()).toEqual({count: 0});
    expect(db.database.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action='release.canary-wait.skipped'").get()).toEqual({count: 0});
  });

  it("rejects stale, future, absent and unhealthy evidence", async () => {
    for (const kind of ["stale", "future", "absent", "unhealthy"]) {
      const {db, releases, command} = await fixture();
      if(kind === "absent") db.database.exec("UPDATE release_candidate_workflows SET last_health_evidence_json=NULL");
      else if(kind === "unhealthy") db.database.exec("UPDATE release_candidate_workflows SET last_health_evidence_json=json_set(last_health_evidence_json, '$.checks.auth', json('false'))");
      expect(await releases.skipCanaryWait({...command, now: kind === "stale" ? NOW + 10 * 60_000 + 1 : kind === "future" ? NOW - 1 : command.now})).toEqual({kind: "conflict", reason: "fresh_healthy_canary_required"});
    }
  });

  it("rechecks the current binding inside the atomic batch", async () => {
    const {db, releases, command} = await fixture();
    const batch = db.batch.bind(db);
    db.batch = async statements => {
      db.database.exec("UPDATE logical_instances SET generation=8");
      return batch(statements);
    };
    expect(await releases.skipCanaryWait(command)).toEqual({kind: "conflict", reason: "stale_or_ineligible"});
    expect(db.database.prepare("SELECT state, revision FROM release_candidate_workflows").get()).toEqual({state: "canary_observing", revision: 1});
  });
});
