import {
  BuildClaimSchema,
  BuildHeartbeatRequestSchema,
  BuildInputSchema,
  BuildProgressSchema,
  BuildReportRequestSchema,
  buildKey as calculateBuildKey,
  canonicalBuildInput,
  type BuildClaim,
  type BuildHeartbeatRequest,
  type BuildInput,
  type BuildReportRequest,
} from "@praetorium/contracts";
import type { VerifiedArtifact } from "@praetorium/application/artifacts";
import type {
  BuildQueueHeartbeatResult,
  BuildQueueReportResult,
  BuildQueueStore,
} from "@praetorium/application/builds";
import type { D1Database, D1PreparedStatement } from "./types.js";

interface BuildRow {
  build_id: string;
  build_key: string;
  build_input_json: string;
  status: "reserved" | "pending" | "claimed" | "running" | "verifying" | "succeeded" | "failed" | "cancelled";
  attempt_count: number;
  lease_epoch: number;
  active_attempt_id: string | null;
  worker_id: string | null;
  lease_token: string | null;
  lease_expires_at: number | null;
  report_sequence: number;
  last_report_digest: string | null;
  progress_json: string | null;
  cancel_requested: number;
  candidate_ref: string | null;
  manifest_digest: string | null;
  artifact_digest: string | null;
  failure_json: string | null;
  created_at: number;
  updated_at: number;
}

interface AttemptRow {
  attempt_id: string;
  build_id: string;
  lease_epoch: number;
  worker_id: string;
  status: "claimed" | "running" | "verifying" | "succeeded" | "failed" | "expired" | "cancelled";
  lease_token: string;
  lease_expires_at: number;
  report_sequence: number;
  last_report_digest: string | null;
  progress_json: string | null;
  candidate_ref: string | null;
  manifest_digest: string | null;
  failure_json: string | null;
  started_at: number;
  updated_at: number;
  finished_at: number | null;
}

interface ArtifactIdentityRow {
  artifact_digest: string;
  build_key: string;
  status: "admitted" | "rejected";
  manifest_digest: string;
  platform_manifest_digest: string;
  composition_manifest_digest: string;
  producer_revision: string;
}

type StoredReport = {
  readonly request: BuildReportRequest;
  readonly serverNow: number;
  readonly reportDigest: string;
  readonly artifact: VerifiedArtifact | null;
  readonly admissionFailure?: { readonly code: string; readonly retryable: boolean };
};

/** Atomic D1 build claims, lease heartbeats and monotonic report admission. */
export class D1BuildStore implements BuildQueueStore {
  constructor(private readonly db: D1Database) {}

  async claimNext(input: {
    readonly workerId: string;
    readonly attemptId: string;
    readonly leaseToken: string;
    readonly now: number;
    readonly leaseSeconds: number;
  }): Promise<BuildClaim | null> {
    validateTimestamp(input.now);
    validateLeaseSeconds(input.leaseSeconds);
    const candidate = await this.db
      .prepare(
        `SELECT * FROM builds
         WHERE cancel_requested = 0
           AND (status = 'pending' OR (status IN ('claimed', 'running', 'verifying') AND lease_expires_at <= ?))
         ORDER BY created_at, build_key LIMIT 1`,
      )
      .bind(input.now)
      .first<BuildRow>();
    if (!candidate) return null;
    const buildInput = await readBuildInput(candidate);
    const attempt = candidate.attempt_count + 1;
    const leaseEpoch = candidate.lease_epoch + 1;
    const leaseExpiresAt = input.now + input.leaseSeconds * 1000;
    if (!Number.isSafeInteger(leaseExpiresAt)) throw new TypeError("build lease expiry exceeds the safe timestamp range");
    try {
      const results = await this.db.batch([
        this.db
          .prepare(
            `UPDATE builds SET status = 'claimed', attempt_count = ?, lease_epoch = ?,
                 active_attempt_id = ?, worker_id = ?, lease_token = ?, lease_expires_at = ?,
                 report_sequence = 0, last_report_digest = NULL, progress_json = NULL,
                 cancel_requested = 0, candidate_ref = NULL, manifest_digest = NULL,
                 artifact_digest = NULL, failure_json = NULL, updated_at = ?
             WHERE build_id = ? AND lease_epoch = ? AND cancel_requested = 0
               AND (status = 'pending' OR (status IN ('claimed', 'running', 'verifying') AND lease_expires_at <= ?))
               AND (active_attempt_id IS NULL OR EXISTS (
                 SELECT 1 FROM build_attempts old
                 WHERE old.attempt_id = builds.active_attempt_id AND old.build_id = builds.build_id
                   AND old.lease_epoch < ? AND old.status IN ('claimed', 'running', 'verifying')
                   AND old.lease_expires_at <= ?
               ))`,
          )
          .bind(
            attempt,
            leaseEpoch,
            input.attemptId,
            input.workerId,
            input.leaseToken,
            leaseExpiresAt,
            input.now,
            candidate.build_id,
            candidate.lease_epoch,
            input.now,
            leaseEpoch,
            input.now,
          ),
        this.assertOneChange(),
        this.db
          .prepare(
            `UPDATE build_attempts SET status = 'expired', finished_at = ?, updated_at = ?
             WHERE attempt_id = ? AND build_id = ? AND status IN ('claimed', 'running', 'verifying')
               AND lease_expires_at <= ?`,
          )
          .bind(input.now, input.now, candidate.active_attempt_id, candidate.build_id, input.now),
        this.db
          .prepare(
            `INSERT INTO build_attempts (
               attempt_id, build_id, lease_epoch, worker_id, status, lease_token,
               lease_expires_at, report_sequence, last_report_digest, progress_json,
               candidate_ref, manifest_digest, failure_json, started_at, updated_at, finished_at
             ) SELECT ?, build_id, ?, ?, 'claimed', ?, ?, 0, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL
               FROM builds WHERE build_id = ? AND active_attempt_id = ? AND lease_epoch = ?`,
          )
          .bind(input.attemptId, leaseEpoch, input.workerId, input.leaseToken, leaseExpiresAt, input.now, input.now, candidate.build_id, input.attemptId, leaseEpoch),
      ]);
      if (results[0]?.meta.changes !== 1 || results[3]?.meta.changes !== 1) return null;
    } catch (error) {
      if (isTransactionAssertion(error)) return null;
      throw error;
    }
    return BuildClaimSchema.parse({
      buildId: candidate.build_id,
      buildKey: candidate.build_key,
      input: buildInput,
      attemptId: input.attemptId,
      attempt,
      leaseEpoch,
      leaseToken: input.leaseToken,
      leaseExpiresAt,
    });
  }

  async heartbeat(
    input: BuildHeartbeatRequest & { readonly now: number; readonly serverNow: number },
  ): Promise<BuildQueueHeartbeatResult> {
    validateTimestamp(input.serverNow);
    validateLeaseSeconds(input.leaseSeconds);
    const progress = input.progress === undefined ? undefined : BuildProgressSchema.parse(input.progress);
    const reportDigest = await digestJson(heartbeatWireRequest(input));
    const current = await this.readFence(input);
    if (!current) return { accepted: false, cancelRequested: false, leaseExpiresAt: null };
    if (input.sequence === current.attempt.report_sequence) {
      const duplicate = current.attempt.last_report_digest === reportDigest;
      return {
        accepted: duplicate,
        cancelRequested: current.build.cancel_requested === 1,
        leaseExpiresAt: duplicate ? current.attempt.lease_expires_at : null,
      };
    }
    if (
      input.sequence !== current.attempt.report_sequence + 1 ||
      current.attempt.lease_expires_at <= input.serverNow ||
      !isActiveAttempt(current.attempt.status) ||
      !isActiveBuild(current.build.status)
    ) {
      return { accepted: false, cancelRequested: current.build.cancel_requested === 1, leaseExpiresAt: null };
    }
    const leaseExpiresAt = input.serverNow + input.leaseSeconds * 1000;
    if (!Number.isSafeInteger(leaseExpiresAt)) throw new TypeError("build lease expiry exceeds the safe timestamp range");
    const progressJson = progress === undefined ? current.attempt.progress_json : JSON.stringify(progress);
    let results: readonly { readonly meta: { readonly changes: number } }[];
    try {
      results = await this.db.batch([
        this.db
          .prepare(
            `UPDATE builds SET status = 'running', report_sequence = ?, last_report_digest = ?,
                 lease_expires_at = ?, progress_json = ?, updated_at = ?
             WHERE build_id = ? AND active_attempt_id = ? AND worker_id = ? AND lease_token = ?
               AND lease_epoch = ? AND lease_expires_at > ? AND status IN ('claimed', 'running', 'verifying')
               AND report_sequence = ?`,
          )
          .bind(
            input.sequence,
            reportDigest,
            leaseExpiresAt,
            progressJson,
            input.serverNow,
            input.buildId,
            input.attemptId,
            input.workerId,
            input.leaseToken,
            input.leaseEpoch,
            input.serverNow,
            current.attempt.report_sequence,
          ),
        this.db
          .prepare(
            `UPDATE build_attempts SET status = 'running', report_sequence = ?, last_report_digest = ?,
                 lease_expires_at = ?, progress_json = ?, updated_at = ?
             WHERE attempt_id = ? AND build_id = ? AND worker_id = ? AND lease_token = ?
               AND lease_epoch = ? AND lease_expires_at > ? AND status IN ('claimed', 'running', 'verifying')
               AND report_sequence = ? AND changes() = 1`,
          )
          .bind(
            input.sequence,
            reportDigest,
            leaseExpiresAt,
            progressJson,
            input.serverNow,
            input.attemptId,
            input.buildId,
            input.workerId,
            input.leaseToken,
            input.leaseEpoch,
            input.serverNow,
            current.attempt.report_sequence,
          ),
        this.assertOneChange(),
      ]);
      if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
        return { accepted: false, cancelRequested: false, leaseExpiresAt: null };
      }
    } catch (error) {
      if (isTransactionAssertion(error)) return { accepted: false, cancelRequested: false, leaseExpiresAt: null };
      throw error;
    }
    return {
      accepted: true,
      cancelRequested: current.build.cancel_requested === 1,
      leaseExpiresAt,
    };
  }

  async getReportContext(input: {
    readonly buildId: string;
    readonly attemptId: string;
    readonly workerId: string;
    readonly leaseToken: string;
    readonly leaseEpoch: number;
  }): Promise<{
    readonly buildKey: string;
    readonly input: BuildInput;
    readonly reportSequence: number;
    readonly lastReportDigest: string | null;
    readonly leaseExpiresAt: number;
  } | null> {
    const current = await this.readFence(input);
    if (!current || current.build.lease_expires_at === null) return null;
    const buildInput = await readBuildInput(current.build);
    return {
      buildKey: current.build.build_key,
      input: buildInput,
      reportSequence: current.attempt.report_sequence,
      lastReportDigest: current.attempt.last_report_digest,
      leaseExpiresAt: current.attempt.lease_expires_at,
    };
  }

  async recordReport(input: StoredReport, resolveConcurrentArtifactConflict = true): Promise<BuildQueueReportResult> {
    const request = BuildReportRequestSchema.parse(input.request);
    const current = await this.readFence(request);
    if (!current) return { accepted: false, duplicate: false };
    if (request.sequence === current.attempt.report_sequence) {
      const duplicate = current.attempt.last_report_digest === input.reportDigest;
      return { accepted: duplicate, duplicate };
    }
    if (
      request.buildKey !== current.build.build_key ||
      request.sequence !== current.attempt.report_sequence + 1 ||
      current.attempt.lease_expires_at <= input.serverNow ||
      !isActiveAttempt(current.attempt.status) ||
      !isActiveBuild(current.build.status)
    ) {
      return { accepted: false, duplicate: false };
    }

    const result = request.result;
    let terminalStatus: "succeeded" | "failed" | "cancelled";
    let failure: Readonly<Record<string, unknown>> | null = null;
    let admitted = false;
    let artifactAlreadyAdmitted = false;
    if (current.build.cancel_requested === 1) {
      terminalStatus = "cancelled";
      failure = { code: "BUILD_CANCELED", message: "Build was canceled", retryable: false };
    } else if (result.kind === "succeeded" && input.artifact && !input.admissionFailure) {
      const expectedInput = await readBuildInput(current.build);
      if (
        input.artifact.buildKey !== current.build.build_key ||
        canonicalBuildInput(input.artifact.buildInput) !== canonicalBuildInput(expectedInput) ||
        input.artifact.image.digest !== result.manifestDigest ||
        input.artifact.compositionManifest.digest !== result.compositionManifest.digest
      ) {
        terminalStatus = "failed";
        failure = { code: "ARTIFACT_REJECTED", reason: "persisted_input_mismatch", retryable: false };
      } else {
        const digestConflict = await this.findArtifactIdentity(input.artifact.image.digest);
        const keyConflict = await this.findAdmittedArtifactForBuild(current.build.build_key);
        const sameAdmittedArtifact = digestConflict?.build_key === current.build.build_key &&
          digestConflict.status === "admitted" && keyConflict?.artifact_digest === input.artifact.image.digest;
        const sameVerifiedContent = sameAdmittedArtifact &&
          digestConflict.manifest_digest === result.manifestDigest &&
          digestConflict.platform_manifest_digest === input.artifact.image.platformManifestDigest &&
          digestConflict.composition_manifest_digest === result.compositionManifest.digest &&
          digestConflict.producer_revision === input.artifact.producerRevision;
        if (sameVerifiedContent) {
          terminalStatus = "succeeded";
          admitted = true;
          artifactAlreadyAdmitted = true;
        } else if (
          digestConflict !== null || keyConflict !== null
        ) {
          terminalStatus = "failed";
          failure = { code: "ARTIFACT_CONFLICT", retryable: false };
        } else {
          terminalStatus = "succeeded";
          admitted = true;
        }
      }
    } else if (result.kind === "succeeded") {
      terminalStatus = "failed";
      failure = input.admissionFailure?.code === "ARTIFACT_CONFLICT"
        ? { code: "ARTIFACT_CONFLICT", retryable: false }
        : {
            code: "ARTIFACT_REJECTED",
            reason: input.admissionFailure?.code ?? "verification_unavailable",
            retryable: input.admissionFailure?.retryable ?? true,
          };
    } else if (result.kind === "canceled") {
      terminalStatus = "cancelled";
      failure = { code: "BUILD_CANCELED", message: "Build was canceled", retryable: false };
    } else {
      terminalStatus = "failed";
      failure = {
        code: result.code,
        message: result.code === "BUILD_TIMEOUT" ? "Build exceeded its configured deadline" : "BuildKit solve failed",
        retryable: result.retryable,
      };
    }

    const artifact = admitted ? input.artifact : null;
    const resultCandidate = result.kind === "succeeded" ? result : null;
    const failureJson = failure === null ? null : JSON.stringify(failure);
    let results: readonly { readonly meta: { readonly changes: number } }[];
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `UPDATE builds SET status = ?, report_sequence = ?, last_report_digest = ?,
               candidate_ref = ?, manifest_digest = ?, artifact_digest = ?, failure_json = ?,
               updated_at = ?
           WHERE build_id = ? AND active_attempt_id = ? AND worker_id = ? AND lease_token = ?
             AND lease_epoch = ? AND lease_expires_at > ? AND status IN ('claimed', 'running', 'verifying')
             AND report_sequence = ?`,
        )
        .bind(
          terminalStatus,
          request.sequence,
          input.reportDigest,
          admitted ? resultCandidate?.candidateRef ?? null : null,
          admitted ? resultCandidate?.manifestDigest ?? null : null,
          artifact?.image.digest ?? null,
          failureJson,
          input.serverNow,
          request.buildId,
          request.attemptId,
          request.workerId,
          request.leaseToken,
          request.leaseEpoch,
          input.serverNow,
          current.attempt.report_sequence,
        ),
      this.db
        .prepare(
          `UPDATE build_attempts SET status = ?, report_sequence = ?, last_report_digest = ?,
               candidate_ref = ?, manifest_digest = ?, failure_json = ?, finished_at = ?, updated_at = ?
           WHERE attempt_id = ? AND build_id = ? AND worker_id = ? AND lease_token = ?
             AND lease_epoch = ? AND lease_expires_at > ? AND status IN ('claimed', 'running', 'verifying')
             AND report_sequence = ? AND changes() = 1`,
        )
        .bind(
          terminalStatus,
          request.sequence,
          input.reportDigest,
          admitted ? resultCandidate?.candidateRef ?? null : null,
          admitted ? resultCandidate?.manifestDigest ?? null : null,
          failureJson,
          input.serverNow,
          input.serverNow,
          request.attemptId,
          request.buildId,
          request.workerId,
          request.leaseToken,
          request.leaseEpoch,
          input.serverNow,
          current.attempt.report_sequence,
        ),
      this.assertOneChange(),
    ];

    if (artifact && !artifactAlreadyAdmitted) statements.push(this.insertArtifact(request, artifact, input.serverNow));
    statements.push(
      this.db
        .prepare(
          `UPDATE deployment_revisions SET status = 'admitted', artifact_digest = ?
           WHERE build_id = ? AND build_key = ? AND status = 'building' AND ? = 'succeeded'`,
        )
        .bind(artifact?.image.digest ?? null, request.buildId, request.buildKey, terminalStatus),
      this.db
        .prepare(
          `UPDATE logical_instances SET desired_artifact_digest = ?, updated_at = ?
           WHERE desired_revision_id IN (
             SELECT revision_id FROM deployment_revisions
             WHERE build_id = ? AND build_key = ? AND status = 'admitted' AND artifact_digest = ?
           ) AND ? = 'succeeded'`,
        )
        .bind(artifact?.image.digest ?? null, input.serverNow, request.buildId, request.buildKey, artifact?.image.digest ?? null, terminalStatus),
      this.db
        .prepare(
          `UPDATE deployment_revisions SET status = 'failed'
           WHERE build_id = ? AND build_key = ? AND status = 'building' AND ? IN ('failed', 'cancelled')`,
        )
        .bind(request.buildId, request.buildKey, terminalStatus),
      this.db
        .prepare(
          `UPDATE operations SET status = 'failed', phase = 'failed', result_json = ?, updated_at = ?
           WHERE deployment_revision_id IN (
             SELECT revision_id FROM deployment_revisions WHERE build_id = ? AND status = 'failed'
           ) AND status = 'pending' AND ? IN ('failed', 'cancelled')`,
        )
        .bind(failureJson ?? JSON.stringify({ code: "BUILD_FAILED" }), input.serverNow, request.buildId, terminalStatus),
      this.db
        .prepare(
          `INSERT INTO audit_events (
             event_id, repository_id, instance_id, operation_id, actor_id, actor_kind,
             action, outcome, request_id, metadata_json, occurred_at
           ) SELECT ?, NULL, NULL, NULL, ?, 'build-worker', 'build.reported', ?, NULL, ?, ?
             WHERE EXISTS (SELECT 1 FROM builds WHERE build_id = ? AND report_sequence = ? AND last_report_digest = ?)`,
        )
        .bind(
          `build.report:${request.buildId}:${request.leaseEpoch}:${request.sequence}`,
          request.workerId,
          terminalStatus,
          JSON.stringify({
            buildKey: request.buildKey,
            attemptId: request.attemptId,
            leaseEpoch: request.leaseEpoch,
            sequence: request.sequence,
            admitted,
            ...(input.admissionFailure === undefined ? {} : { admissionFailure: input.admissionFailure.code }),
          }),
          input.serverNow,
          request.buildId,
          request.sequence,
          input.reportDigest,
        ),
    );
    try {
      results = await this.db.batch(statements);
    } catch (error) {
      if (isTransactionAssertion(error)) return { accepted: false, duplicate: false };
      if (isConstraintError(error)) {
        // A concurrent report may win the unique artifact slot after our preflight reads.
        const result = request.result;
        if (result.kind === "succeeded") {
          const [digestConflict, keyConflict] = await Promise.all([
            this.findArtifactIdentity(result.manifestDigest),
            this.findAdmittedArtifactForBuild(request.buildKey),
          ]);
          if ((digestConflict || keyConflict) && resolveConcurrentArtifactConflict) {
            return this.recordReport(input, false);
          }
        }
        throw error;
      }
      throw error;
    }
    if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
      return { accepted: false, duplicate: false };
    }
    return { accepted: true, duplicate: false };
  }

  private async readFence(input: {
    readonly buildId: string;
    readonly attemptId: string;
    readonly workerId: string;
    readonly leaseToken: string;
    readonly leaseEpoch: number;
  }): Promise<{ readonly build: BuildRow; readonly attempt: AttemptRow } | null> {
    const row = await this.db
      .prepare(
        `SELECT b.*, a.attempt_id AS a_attempt_id, a.build_id AS a_build_id, a.lease_epoch AS a_lease_epoch,
                a.worker_id AS a_worker_id, a.status AS a_status, a.lease_token AS a_lease_token,
                a.lease_expires_at AS a_lease_expires_at, a.report_sequence AS a_report_sequence,
                a.last_report_digest AS a_last_report_digest, a.progress_json AS a_progress_json,
                a.candidate_ref AS a_candidate_ref, a.manifest_digest AS a_manifest_digest,
                a.failure_json AS a_failure_json, a.started_at AS a_started_at, a.updated_at AS a_updated_at,
                a.finished_at AS a_finished_at
         FROM builds b JOIN build_attempts a ON a.attempt_id = b.active_attempt_id
         WHERE b.build_id = ? AND b.active_attempt_id = ? AND b.worker_id = ?
           AND b.lease_token = ? AND b.lease_epoch = ?
           AND a.build_id = b.build_id AND a.worker_id = ? AND a.lease_token = ? AND a.lease_epoch = ?`,
      )
      .bind(
        input.buildId,
        input.attemptId,
        input.workerId,
        input.leaseToken,
        input.leaseEpoch,
        input.workerId,
        input.leaseToken,
        input.leaseEpoch,
      )
      .first<BuildRow & Record<string, unknown>>();
    if (!row) return null;
    const build = row as BuildRow;
    const attempt: AttemptRow = {
      attempt_id: String(row.a_attempt_id),
      build_id: String(row.a_build_id),
      lease_epoch: Number(row.a_lease_epoch),
      worker_id: String(row.a_worker_id),
      status: row.a_status as AttemptRow["status"],
      lease_token: String(row.a_lease_token),
      lease_expires_at: Number(row.a_lease_expires_at),
      report_sequence: Number(row.a_report_sequence),
      last_report_digest: typeof row.a_last_report_digest === "string" ? row.a_last_report_digest : null,
      progress_json: typeof row.a_progress_json === "string" ? row.a_progress_json : null,
      candidate_ref: typeof row.a_candidate_ref === "string" ? row.a_candidate_ref : null,
      manifest_digest: typeof row.a_manifest_digest === "string" ? row.a_manifest_digest : null,
      failure_json: typeof row.a_failure_json === "string" ? row.a_failure_json : null,
      started_at: Number(row.a_started_at),
      updated_at: Number(row.a_updated_at),
      finished_at: typeof row.a_finished_at === "number" ? row.a_finished_at : null,
    };
    return { build, attempt };
  }

  private async findArtifactIdentity(digest: string): Promise<ArtifactIdentityRow | null> {
    return this.db
      .prepare(`SELECT artifact_digest, build_key, status, manifest_digest, platform_manifest_digest,
                       composition_manifest_digest, producer_revision
                FROM artifacts WHERE artifact_digest = ?`)
      .bind(digest)
      .first<ArtifactIdentityRow>();
  }

  private async findAdmittedArtifactForBuild(buildKey: string): Promise<ArtifactIdentityRow | null> {
    return this.db
      .prepare(`SELECT artifact_digest, build_key, status, manifest_digest, platform_manifest_digest,
                       composition_manifest_digest, producer_revision
                FROM artifacts WHERE build_key = ? AND status = 'admitted' LIMIT 1`)
      .bind(buildKey)
      .first<ArtifactIdentityRow>();
  }

  private insertArtifact(
    request: BuildReportRequest,
    artifact: VerifiedArtifact,
    now: number,
  ): D1PreparedStatement {
    if (request.result.kind !== "succeeded") throw new TypeError("admitted artifact requires a success report");
    const verification = {
      schemaVersion: artifact.schemaVersion,
      verifiedAt: artifact.verifiedAt,
      signerKeyId: artifact.signerKeyId,
      reachableLayerBytes: artifact.reachableLayerBytes,
      compositionManifestBytes: artifact.compositionManifestBytes,
    };
    const contractVersions = {
      build: artifact.contractVersion,
      composition: "scriptorium-composition/v1",
    };
    return this.db
      .prepare(
        `INSERT INTO artifacts (
           artifact_digest, build_key, build_id, attempt_id, manifest_digest,
           platform_manifest_digest, composition_manifest_digest, producer_revision,
           requested_modules_json, resolved_modules_json, contract_versions_json,
           sbom_ref, provenance_ref, verification_json, statement_json, signature_json,
           verifier_id, status, created_at, admitted_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, 'control-plane-artifact-admission', 'admitted', ?, ?)`,
      )
      .bind(
        artifact.image.digest,
        artifact.buildKey,
        request.buildId,
        request.attemptId,
        request.result.manifestDigest,
        artifact.image.platformManifestDigest,
        artifact.compositionManifest.digest,
        artifact.producerRevision,
        JSON.stringify(artifact.buildInput.requestedModules),
        JSON.stringify(artifact.resolvedModules),
        JSON.stringify(contractVersions),
        JSON.stringify(verification),
        JSON.stringify(request.result.statement),
        JSON.stringify(request.result.signature),
        now,
        now,
      );
  }

  private assertOneChange(): D1PreparedStatement {
    return this.db.prepare("INSERT INTO platform_transaction_sentinel(id) SELECT 1 WHERE changes() <> 1");
  }
}

async function readBuildInput(row: BuildRow): Promise<BuildInput> {
  const input = BuildInputSchema.parse(JSON.parse(row.build_input_json));
  if (
    canonicalBuildInput(input) !== row.build_input_json ||
    (await calculateBuildKey(input)) !== row.build_key
  ) {
    throw new Error("persisted immutable build input does not match its build key");
  }
  return input;
}

function heartbeatWireRequest(input: BuildHeartbeatRequest & { readonly now: number; readonly serverNow?: number }): BuildHeartbeatRequest {
  const request: Record<string, unknown> = { ...input };
  delete request.now;
  delete request.serverNow;
  return BuildHeartbeatRequestSchema.parse(request);
}

async function digestJson(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function validateTimestamp(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("build queue timestamp is invalid");
}

function validateLeaseSeconds(seconds: number): void {
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 300) throw new TypeError("build lease must be between 1 and 300 seconds");
}

function isActiveAttempt(status: AttemptRow["status"]): boolean {
  return status === "claimed" || status === "running" || status === "verifying";
}

function isActiveBuild(status: BuildRow["status"]): boolean {
  return status === "claimed" || status === "running" || status === "verifying";
}

function isTransactionAssertion(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("platform_transaction_sentinel");
}

function isConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unique constraint|constraint failed|UNIQUE constraint/iu.test(message);
}
