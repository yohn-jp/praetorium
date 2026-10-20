import {
  type LifecycleDependencies,
  type LifecycleExecutionContext,
  type LifecycleOperation,
  type LifecyclePhase,
  type LifecycleReadinessEvidence,
  type LifecycleResult,
  type ProducerStatus,
  type QuiesceReceipt,
  type QuiesceRequest,
  type RuntimeAssignment,
  type RuntimeDeployment,
  type RuntimeEpoch,
  type RollbackCompatibilityEvidence,
  type WriterAbsenceProof,
  type WriterCensus,
  SCRIPTORIUM_PLATFORM_CONTRACT_VERSION,
} from "./ports.js";

const DEFAULT_QUIESCE_TIMEOUT_MS = 30_000;
const DEFAULT_READINESS_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_READINESS_EVIDENCE_MAX_AGE_MS = 30_000;
const REMOTE_OBSERVATION_MAX_AGE_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const CLEANUP_TIMEOUT_MS = 3_000;

class StaleLifecycleOperationError extends Error {
  constructor() {
    super("lifecycle operation lease or checkpoint is stale");
    this.name = "StaleLifecycleOperationError";
  }
}

function validCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function censusIsComplete(census: WriterCensus): boolean {
  return (
    census.complete &&
    census.providerObservationId.length > 0 &&
    Number.isFinite(Date.parse(census.observedAt)) &&
    validCount(census.matchedWriterCount) &&
    census.matchedWriterCount === census.writers.length
  );
}

function validSha256(value: string): boolean {
  return /^sha256:[a-f0-9]{64}$/u.test(value);
}

function validIsoTimestamp(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function validRemoteRevision(value: string | null): boolean {
  return value === null || /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value);
}

export function hasFreshRemoteObservation(
  assignment: RuntimeAssignment,
  status: ProducerStatus,
  now: number,
): boolean {
  const persistence = status.persistence;
  const observedAt = Date.parse(status.observedAt);
  const remoteObservedAt = Date.parse(persistence?.remoteObservedAt ?? "");
  const commit = persistence?.observedRemoteCommit ?? null;
  return (
    status.contractVersion === SCRIPTORIUM_PLATFORM_CONTRACT_VERSION &&
    status.instanceId === assignment.instanceId &&
    status.repositoryId === assignment.repositoryId &&
    status.runtimeEpoch === assignment.runtimeEpoch &&
    status.imageDigest === assignment.deployment.imageDigest &&
    status.compositionManifestDigest === assignment.deployment.compositionManifestDigest &&
    sameStrings(status.enabledModuleIds, assignment.deployment.enabledModuleIds) &&
    validIsoTimestamp(status.observedAt) &&
    observedAt <= now &&
    now - observedAt <= REMOTE_OBSERVATION_MAX_AGE_MS &&
    persistence?.state === "verified" &&
    validRemoteRevision(commit) &&
    status.lastConfirmedRemoteRevision === commit &&
    typeof persistence.remoteObservedAt === "string" &&
    validIsoTimestamp(persistence.remoteObservedAt) &&
    remoteObservedAt <= observedAt &&
    remoteObservedAt <= now &&
    now - remoteObservedAt <= REMOTE_OBSERVATION_MAX_AGE_MS
  );
}

function rollbackEvidenceFromStatus(
  assignment: RuntimeAssignment,
  receipt: QuiesceReceipt,
  status: ProducerStatus,
  census: WriterCensus,
  now: number,
): RollbackCompatibilityEvidence | null {
  const persistence = status.persistence;
  const observedAt = Date.parse(status.observedAt);
  const remoteObservedAt = Date.parse(persistence?.remoteObservedAt ?? "");
  const providerObservedAt = Date.parse(census.observedAt);
  const quiescedAt = Date.parse(receipt.observedAt);
  const commit = persistence?.observedRemoteCommit ?? null;
  if (
    persistence === undefined ||
    persistence.state !== "verified" ||
    !validRemoteRevision(commit) ||
    status.lastConfirmedRemoteRevision !== commit ||
    receipt.lastConfirmedRemoteRevision !== commit ||
    status.instanceId !== assignment.instanceId ||
    status.repositoryId !== assignment.repositoryId ||
    status.runtimeEpoch !== assignment.runtimeEpoch ||
    status.imageDigest !== assignment.deployment.imageDigest ||
    status.compositionManifestDigest !== assignment.deployment.compositionManifestDigest ||
    !sameStrings(status.enabledModuleIds, assignment.deployment.enabledModuleIds) ||
    status.activity.activeMutations !== 0 ||
    status.activity.activeJobs !== 0 ||
    status.activity.pendingCheckpoints !== 0 ||
    status.activity.uncertainPublication ||
    receipt.disposition !== "safe" ||
    census.providerObservationId.length === 0 ||
    !censusIsComplete(census) ||
    !Number.isFinite(observedAt) ||
    typeof persistence.remoteObservedAt !== "string" ||
    !validIsoTimestamp(persistence.remoteObservedAt) ||
    !Number.isFinite(remoteObservedAt) ||
    remoteObservedAt > quiescedAt ||
    remoteObservedAt > observedAt ||
    remoteObservedAt > now ||
    now - remoteObservedAt > REMOTE_OBSERVATION_MAX_AGE_MS ||
    !Number.isFinite(providerObservedAt) ||
    !Number.isFinite(quiescedAt) ||
    providerObservedAt < quiescedAt ||
    providerObservedAt > observedAt ||
    providerObservedAt > now ||
    now - providerObservedAt > DEFAULT_READINESS_EVIDENCE_MAX_AGE_MS ||
    observedAt < quiescedAt ||
    observedAt > now ||
    now - observedAt > DEFAULT_READINESS_EVIDENCE_MAX_AGE_MS ||
    !Array.isArray(persistence.formats) ||
    (commit === null && persistence.formats.length !== 0) ||
    persistence.formats.length > 256
  )
    return null;
  const seen = new Set<string>();
  const formats: { formatId: string; version: number }[] = [];
  for (const item of persistence.formats) {
    if (
      !/^[a-z][a-z0-9.-]{0,127}$/u.test(item.formatId) ||
      !Number.isSafeInteger(item.version) ||
      item.version < 1
    )
      return null;
    const pair = `${item.formatId}\u0000${item.version}`;
    if (seen.has(pair)) return null;
    seen.add(pair);
    formats.push({ formatId: item.formatId, version: item.version });
  }
  return {
    contractVersion: "praetorium-rollback-compatibility/v1",
    instanceId: assignment.instanceId,
    repositoryId: assignment.repositoryId,
    runtimeEpoch: assignment.runtimeEpoch,
    imageDigest: assignment.deployment.imageDigest,
    compositionManifestDigest: assignment.deployment.compositionManifestDigest,
    providerObservationId: census.providerObservationId,
    providerObservedAt: census.observedAt,
    observedAt: status.observedAt,
    remoteObservedAt: persistence.remoteObservedAt,
    observedRemoteCommit: commit,
    quiesceRevision: receipt.quiesceRevision,
    quiesceRemoteCommit: commit,
    formats,
  };
}

function rollbackEvidenceMatches(
  evidence: RollbackCompatibilityEvidence | null,
  assignment: RuntimeAssignment,
  receipt: QuiesceReceipt | null,
): evidence is RollbackCompatibilityEvidence {
  return (
    evidence !== null &&
    typeof evidence === "object" &&
    receipt !== null &&
    evidence.contractVersion === "praetorium-rollback-compatibility/v1" &&
    evidence.instanceId === assignment.instanceId &&
    evidence.repositoryId === assignment.repositoryId &&
    evidence.runtimeEpoch === assignment.runtimeEpoch &&
    evidence.imageDigest === assignment.deployment.imageDigest &&
    evidence.compositionManifestDigest === assignment.deployment.compositionManifestDigest &&
    typeof evidence.providerObservationId === "string" &&
    evidence.providerObservationId.length > 0 &&
    validRemoteRevision(evidence.observedRemoteCommit) &&
    Array.isArray(evidence.formats) &&
    (evidence.observedRemoteCommit !== null || evidence.formats.length === 0) &&
    Number.isFinite(Date.parse(evidence.providerObservedAt)) &&
    Date.parse(evidence.providerObservedAt) >= Date.parse(receipt.observedAt) &&
    Date.parse(evidence.providerObservedAt) <= Date.parse(evidence.observedAt) &&
    evidence.quiesceRevision === receipt.quiesceRevision &&
    evidence.quiesceRemoteCommit === receipt.lastConfirmedRemoteRevision &&
    evidence.observedRemoteCommit === receipt.lastConfirmedRemoteRevision &&
    Number.isFinite(Date.parse(evidence.observedAt)) &&
    Date.parse(evidence.observedAt) >= Date.parse(receipt.observedAt) &&
    typeof evidence.remoteObservedAt === "string" &&
    validIsoTimestamp(evidence.remoteObservedAt) &&
    Date.parse(evidence.remoteObservedAt) <= Date.parse(receipt.observedAt) &&
    Date.parse(evidence.remoteObservedAt) <= Date.parse(evidence.observedAt) &&
    receipt.disposition === "safe"
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

function sameAssignmentIdentity(left: RuntimeAssignment, right: RuntimeAssignment): boolean {
  return (
    left.instanceId === right.instanceId &&
    left.repositoryId === right.repositoryId &&
    left.runtimeEpoch === right.runtimeEpoch &&
    left.generation === right.generation &&
    left.clusterId === right.clusterId
  );
}

function boundReason(value: string): string {
  return value.replaceAll(/[\r\n\t]/g, " ").slice(0, 512);
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted)
    return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function validateDeployment(
  deployment: RuntimeDeployment,
  operation: LifecycleOperation,
): string | null {
  if (deployment.repositoryId !== operation.repositoryId) return "target_repository_mismatch";
  if (operation.targetRevisionId !== null && deployment.revisionId !== operation.targetRevisionId) {
    return "target_revision_mismatch";
  }
  if (!validSha256(deployment.imageDigest) || !validSha256(deployment.compositionManifestDigest)) {
    return "target_digest_invalid";
  }
  if (
    !/^[a-z0-9][a-z0-9./:_-]{0,254}@sha256:[0-9a-f]{64}$/u.test(deployment.artifactRef) ||
    !deployment.artifactRef.endsWith(`@${deployment.imageDigest}`) ||
    !validSha256(deployment.platformManifestDigest)
  )
    return "target_artifact_reference_invalid";
  if (new Set(deployment.enabledModuleIds).size !== deployment.enabledModuleIds.length) {
    return "target_module_set_invalid";
  }
  if (
    deployment.enabledModuleIds.length > 256 ||
    deployment.enabledModuleIds.some((moduleId) => !/^[a-z][a-z0-9-]{0,63}$/u.test(moduleId))
  )
    return "target_module_set_invalid";
  if (
    !/^[a-f0-9]{40}$/u.test(deployment.runtimeMetadata.producerRevision) ||
    !Number.isSafeInteger(deployment.runtimeMetadata.listenerPort) ||
    deployment.runtimeMetadata.listenerPort < 1 ||
    deployment.runtimeMetadata.listenerPort > 65_535 ||
    !Number.isSafeInteger(deployment.runtimeMetadata.shutdownTimeoutSeconds) ||
    deployment.runtimeMetadata.shutdownTimeoutSeconds < 1 ||
    deployment.runtimeMetadata.shutdownTimeoutSeconds > 600 ||
    deployment.runtimeMetadata.statusPath !== "/api/platform/v1/status" ||
    deployment.runtimeMetadata.quiescePath !== "/api/platform/v1/quiesce" ||
    deployment.runtimeMetadata.resumePath !== "/api/platform/v1/resume" ||
    [
      deployment.runtimeMetadata.livenessPath,
      deployment.runtimeMetadata.readinessPath,
      deployment.runtimeMetadata.metadataPath,
      deployment.runtimeMetadata.shutdownPath,
      deployment.runtimeMetadata.statusPath,
      deployment.runtimeMetadata.quiescePath,
      deployment.runtimeMetadata.resumePath,
    ].some((path) => !/^\/(?!\/)[^\r\n?#]{1,256}$/u.test(path))
  )
    return "target_runtime_metadata_invalid";
  if (
    !/^[a-z][a-z0-9-]{0,63}$/u.test(deployment.resourceProfileId) ||
    !Number.isSafeInteger(deployment.resources.cpuMilli) ||
    deployment.resources.cpuMilli < 1 ||
    !Number.isSafeInteger(deployment.resources.memoryMiB) ||
    deployment.resources.memoryMiB < 1 ||
    !Number.isSafeInteger(deployment.resources.ephemeralStorageMiB) ||
    deployment.resources.ephemeralStorageMiB < 1
  )
    return "target_resource_profile_invalid";
  try {
    const issuer = new URL(deployment.grantPolicy.issuer);
    const jwks = new URL(deployment.grantPolicy.jwksUrl);
    const controlIssuer = new URL(deployment.controlServicePolicy.issuer);
    const controlJwks = new URL(deployment.controlServicePolicy.jwksUrl);
    const hostname = new URL(`https://${deployment.hostname}`);
    const locator = new URL(deployment.repositoryLocator);
    if (
      issuer.protocol !== "https:" ||
      jwks.protocol !== "https:" ||
      controlIssuer.protocol !== "https:" ||
      controlJwks.protocol !== "https:" ||
      issuer.username !== "" ||
      issuer.password !== "" ||
      issuer.search !== "" ||
      issuer.hash !== "" ||
      jwks.username !== "" ||
      jwks.password !== "" ||
      jwks.search !== "" ||
      jwks.hash !== "" ||
      controlIssuer.username !== "" ||
      controlIssuer.password !== "" ||
      controlIssuer.search !== "" ||
      controlIssuer.hash !== "" ||
      controlJwks.username !== "" ||
      controlJwks.password !== "" ||
      controlJwks.search !== "" ||
      controlJwks.hash !== "" ||
      hostname.hostname !== deployment.hostname ||
      hostname.protocol !== "https:" ||
      hostname.port !== "" ||
      hostname.pathname !== "/" ||
      hostname.username !== "" ||
      hostname.password !== "" ||
      hostname.search !== "" ||
      hostname.hash !== "" ||
      locator.protocol !== "https:" ||
      locator.hostname !== "github.com" ||
      locator.port !== "" ||
      locator.username !== "" ||
      locator.password !== "" ||
      !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(locator.pathname) ||
      locator.search !== "" ||
      locator.hash !== ""
    ) {
      return "target_auth_or_host_invalid";
    }
  } catch {
    return "target_auth_or_host_invalid";
  }
  if (
    deployment.grantPolicy.audience.length === 0 ||
    deployment.controlServicePolicy.audience.length === 0 ||
    deployment.defaultBranchPolicy.length === 0 ||
    deployment.credentialBrokerLocator.length === 0
  )
    return "target_runtime_assignment_incomplete";
  if (deployment.resourceProfileId.length === 0) return "target_resource_profile_missing";
  return null;
}

function reasonForOperation(operation: LifecycleOperation): QuiesceRequest["reason"] {
  if (operation.reason === "idle") return "idle";
  if (operation.kind === "stop") return "stop";
  if (operation.kind === "update" || operation.reason === "update") return "update";
  return "redeploy";
}

function receiptMatches(
  receipt: QuiesceReceipt,
  request: QuiesceRequest,
  receivedAt: number,
): boolean {
  return (
    receipt.contractVersion === SCRIPTORIUM_PLATFORM_CONTRACT_VERSION &&
    receipt.operationId === request.operationId &&
    receipt.instanceId === request.instanceId &&
    receipt.runtimeEpoch === request.runtimeEpoch &&
    receipt.quiesceRevision.length > 0 &&
    validCount(receipt.activeMutations) &&
    validCount(receipt.activeJobs) &&
    validCount(receipt.restartableJobs) &&
    receipt.restartableJobs <= receipt.activeJobs &&
    validCount(receipt.pendingCheckpoints) &&
    validIsoTimestamp(receipt.observedAt) &&
    validRemoteRevision(receipt.lastConfirmedRemoteRevision) &&
    receipt.reasonCodes.length <= 64 &&
    receipt.reasonCodes.every((code) => /^[A-Z][A-Z0-9_]{0,63}$/u.test(code)) &&
    (receipt.disposition !== "safe" ||
      (receivedAt < Date.parse(request.deadline) &&
        Date.parse(receipt.observedAt) < Date.parse(request.deadline) &&
        Date.parse(receipt.observedAt) <= receivedAt))
  );
}

function quiesceIsSafe(receipt: QuiesceReceipt): boolean {
  return (
    receipt.disposition === "safe" &&
    receipt.activeMutations === 0 &&
    receipt.activeJobs === 0 &&
    receipt.pendingCheckpoints === 0 &&
    receipt.uncertainPublication === false
  );
}

function assignmentFor(
  operation: LifecycleOperation,
  deployment: RuntimeDeployment,
  runtimeEpoch: RuntimeEpoch,
  reservationId: string | null,
): RuntimeAssignment {
  return {
    instanceId: operation.instanceId,
    repositoryId: operation.repositoryId,
    runtimeEpoch,
    generation: operation.generation,
    clusterId: operation.clusterId,
    reservationId,
    deployment,
  };
}

function provesPreviousWriterAbsent(
  proof: WriterAbsenceProof | null,
  assignment: RuntimeAssignment,
  targetEpoch: RuntimeEpoch,
): proof is WriterAbsenceProof {
  return (
    proof !== null &&
    proof.instanceId === assignment.instanceId &&
    proof.repositoryId === assignment.repositoryId &&
    (proof.retiredRuntimeEpoch === null || proof.retiredRuntimeEpoch < targetEpoch) &&
    proof.providerObservationId.length > 0 &&
    Number.isFinite(Date.parse(proof.censusObservedAt)) &&
    proof.remainingWriters === 0 &&
    proof.source === "runtime-provider-census"
  );
}

/**
 * Executes a repository-scoped lifecycle operation with a durable checkpoint
 * before each external side effect. An admitted target is resolved before the
 * current writer is quiesced, so a missing build leaves the current runtime up.
 */
export class LifecycleService {
  private readonly now: () => number;
  private readonly quiesceTimeoutMs: number;
  private readonly readinessTimeoutMs: number;
  private readonly readinessEvidenceMaxAgeMs: number;
  private readonly pollIntervalMs: number;

  constructor(private readonly dependencies: LifecycleDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.quiesceTimeoutMs = dependencies.quiesceTimeoutMs ?? DEFAULT_QUIESCE_TIMEOUT_MS;
    this.readinessTimeoutMs = dependencies.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
    this.readinessEvidenceMaxAgeMs =
      dependencies.readinessEvidenceMaxAgeMs ?? DEFAULT_READINESS_EVIDENCE_MAX_AGE_MS;
    if (
      !Number.isSafeInteger(this.readinessEvidenceMaxAgeMs) ||
      this.readinessEvidenceMaxAgeMs < 1
    ) {
      throw new RangeError("readiness evidence age bound must be a positive integer");
    }
    this.pollIntervalMs = dependencies.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  async execute(operationId: string, context: LifecycleExecutionContext): Promise<LifecycleResult> {
    let operation = await this.dependencies.journal.load(operationId, context.signal);
    if (operation === null)
      return { status: "failed", code: "operation_missing", reason: "operation not found" };
    if (operation.phase === "complete") {
      await context.assertLease();
      const census = await this.dependencies.runtime.censusWriters(
        operation.instanceId,
        operation.repositoryId,
        context.signal,
      );
      if (!censusIsComplete(census)) {
        return {
          status: "unknown",
          code: "completed_writer_census_incomplete",
          reason: "cannot verify the completed runtime writer set",
        };
      }
      if (operation.kind === "stop") {
        const proof = operation.writerAbsenceProof;
        if (
          proof === null ||
          proof.instanceId !== operation.instanceId ||
          proof.repositoryId !== operation.repositoryId ||
          proof.remainingWriters !== 0 ||
          proof.source !== "runtime-provider-census" ||
          proof.providerObservationId.length === 0
        ) {
          return {
            status: "unknown",
            code: "completed_stop_absence_proof_missing",
            reason: "completed stop checkpoint lacks a bound writer absence proof",
          };
        }
        return census.writers.length === 0
          ? { status: "complete", observed: null }
          : {
              status: "unknown",
              code: "completed_stop_writer_present",
              reason: "a runtime writer is present after the stop checkpoint",
            };
      }
      if (operation.targetEpoch === null || operation.target === null) {
        return {
          status: "unknown",
          code: "completed_target_missing",
          reason: "completed lifecycle checkpoint lacks its target identity",
        };
      }
      const assignment = assignmentFor(
        operation,
        operation.target,
        operation.targetEpoch,
        operation.targetReservationId,
      );
      if (
        !provesPreviousWriterAbsent(
          operation.writerAbsenceProof,
          assignment,
          assignment.runtimeEpoch,
        )
      ) {
        return {
          status: "unknown",
          code: "completed_target_absence_proof_missing",
          reason: "completed replacement checkpoint lacks a bound old-writer absence proof",
        };
      }
      if (
        census.writers.length !== 1 ||
        census.writers[0]?.runtimeEpoch !== assignment.runtimeEpoch
      ) {
        return {
          status: "unknown",
          code: "completed_target_writer_mismatch",
          reason: "the completed target is not the sole observed runtime writer",
        };
      }
      const evidence = await this.verifyReadiness(assignment, context);
      return evidence === null
        ? {
            status: "unknown",
            code: "completed_target_not_ready",
            reason: "the completed target no longer passes fresh readiness checks",
          }
        : { status: "complete", observed: assignment };
    }
    if (operation.phase === "blocked") {
      return {
        status: "blocked",
        code: operation.failureCode ?? "lifecycle_blocked",
        reason: operation.failureReason ?? "lifecycle operation is blocked",
      };
    }
    if (operation.phase === "failed") {
      return {
        status: "failed",
        code: operation.failureCode ?? "lifecycle_failed",
        reason: operation.failureReason ?? "lifecycle operation failed",
      };
    }

    const checkpoint = async (
      patch: Partial<Omit<LifecycleOperation, "id" | "version">>,
    ): Promise<void> => {
      const updated = await this.dependencies.journal.advance(
        operation!.id,
        operation!.version,
        patch,
        context.signal,
      );
      if (updated === null) throw new StaleLifecycleOperationError();
      operation = updated;
      const readinessAssignment = updated.readinessEvidence?.assignment;
      const reportDetails =
        updated.phase === "route-activated" &&
        updated.rollbackEpoch === null &&
        updated.target !== null &&
        updated.targetEpoch !== null &&
        readinessAssignment !== undefined &&
        readinessAssignment.instanceId === updated.instanceId &&
        readinessAssignment.repositoryId === updated.repositoryId &&
        readinessAssignment.generation === updated.generation &&
        readinessAssignment.clusterId === updated.clusterId &&
        readinessAssignment.runtimeEpoch === updated.targetEpoch &&
        readinessAssignment.deployment.revisionId === updated.target.revisionId &&
        readinessAssignment.deployment.imageDigest === updated.target.imageDigest
          ? {
              instanceId: readinessAssignment.instanceId,
              repositoryId: String(readinessAssignment.repositoryId),
              generation: String(readinessAssignment.generation),
              clusterId: readinessAssignment.clusterId,
              runtimeEpoch: String(readinessAssignment.runtimeEpoch),
              revisionId: readinessAssignment.deployment.revisionId,
              imageDigest: readinessAssignment.deployment.imageDigest,
            }
          : undefined;
      await context.report?.(updated.phase, reportDetails);
    };

    const setOutcome = async (
      status: "blocked" | "failed" | "unknown",
      code: string,
      reason: string,
    ): Promise<LifecycleResult> => {
      const phase: LifecyclePhase = status;
      await checkpoint({
        phase,
        failureCode: code.slice(0, 128),
        failureReason: boundReason(reason),
      });
      if (status === "unknown") return { status, code, reason: boundReason(reason) };
      return { status, code, reason: boundReason(reason) };
    };

    try {
      await context.assertLease();
      if (operation.kind === "stop") {
        const retirement = await this.retireAssignment(
          operation,
          operation.current,
          operation.id,
          reasonForOperation(operation),
          context,
          checkpoint,
        );
        if (retirement.status !== "retired") return retirement.result;
        await context.assertLease();
        await this.dependencies.routes.deactivate(
          operation.instanceId,
          context.assertLease,
          context.signal,
        );
        if (
          operation.current?.reservationId !== null &&
          operation.current?.reservationId !== undefined
        ) {
          await context.assertLease();
          await this.dependencies.capacity.release(
            operation.current.reservationId,
            operation.id,
            context.assertLease,
            context.signal,
          );
        }
        await checkpoint({ phase: "complete", writerAbsenceProof: retirement.proof });
        return { status: "complete", observed: null };
      }

      if (operation.rollbackEpoch !== null) {
        return await this.resumeRollback(operation, context, checkpoint, setOutcome);
      }
      if (
        operation.quiesceRequest?.reason === "rollback" &&
        operation.target !== null &&
        operation.targetEpoch !== null
      ) {
        // A worker may exit after persisting rollback quiesce/evidence but
        // before allocating the fresh rollback epoch. Resume retirement of
        // the failed target instead of treating its live writer as the
        // operation's old current runtime.
        const failedAssignment = assignmentFor(
          operation,
          operation.target,
          operation.targetEpoch,
          operation.targetReservationId,
        );
        return await this.tryRollback(
          operation,
          failedAssignment,
          operation.target,
          operation.failureCode ?? "target_readiness_failure_recovery",
          context,
          checkpoint,
          setOutcome,
        );
      }

      const resolution = await this.resolveTarget(operation, context, checkpoint);
      if (resolution.status !== "resolved") return resolution.result;
      const target = resolution.deployment;
      const targetError = validateDeployment(target, operation);
      if (targetError !== null)
        return setOutcome("failed", targetError, "target deployment identity is invalid");

      if (
        operation.kind === "start" &&
        operation.current !== null &&
        operation.current.generation === operation.generation &&
        operation.current.runtimeEpoch === operation.runtimeEpoch &&
        operation.current.deployment.revisionId === target.revisionId &&
        operation.current.deployment.imageDigest === target.imageDigest &&
        operation.current.deployment.compositionManifestDigest ===
          target.compositionManifestDigest &&
        sameStrings(operation.current.deployment.enabledModuleIds, target.enabledModuleIds)
      ) {
        const census = await this.dependencies.runtime.censusWriters(
          operation.instanceId,
          operation.repositoryId,
          context.signal,
        );
        if (!censusIsComplete(census))
          return setOutcome(
            "unknown",
            "writer_census_incomplete",
            "runtime provider cannot prove the current writer set",
          );
        if (
          census.writers.length === 1 &&
          census.writers[0]?.runtimeEpoch === operation.current.runtimeEpoch
        ) {
          try {
            const evidence = await this.verifyReadiness(operation.current, context);
            if (evidence !== null) {
              await checkpoint({ readinessEvidence: evidence });
              await context.assertLease();
              await this.dependencies.routes.activate(
                operation.current,
                evidence,
                context.assertLease,
                context.signal,
              );
              await checkpoint({ phase: "route-activated" });
              await checkpoint({ phase: "complete" });
              return { status: "complete", observed: operation.current };
            }
          } catch {
            // A failed current runtime is repaired through the same quiesce/fence path.
          }
        }
      }

      let targetEpoch = operation.targetEpoch;
      if (targetEpoch === null) {
        targetEpoch = operation.runtimeEpoch;
        if (!Number.isSafeInteger(targetEpoch) || targetEpoch < 1) {
          return setOutcome(
            "failed",
            "target_epoch_invalid",
            "Control Plane did not allocate a valid runtime epoch",
          );
        }
        await checkpoint({ targetEpoch });
      }
      if (
        operation.current !== null &&
        targetEpoch <= operation.current.runtimeEpoch &&
        operation.kind !== "start"
      ) {
        return setOutcome(
          "blocked",
          "target_epoch_not_new",
          "replacement epoch must be newer than the current runtime",
        );
      }

      if (operation.targetReservationId === null) {
        await checkpoint({ phase: "capacity-reserved" });
        await context.assertLease();
        const reservation = await this.dependencies.capacity.reserve(
          operation.id,
          operation.instanceId,
          target,
          context.assertLease,
          context.signal,
        );
        if (reservation.status === "pending") {
          await checkpoint({ phase: "waiting-for-capacity" });
          return {
            status: "waiting",
            phase: "waiting-for-capacity",
            reason: "target capacity is not available",
          };
        }
        if (reservation.reservationId === undefined || reservation.reservationId.length === 0) {
          return setOutcome(
            "unknown",
            "reservation_identity_missing",
            "capacity provider did not return a durable reservation identity",
          );
        }
        await checkpoint({
          phase: "capacity-reserved",
          targetReservationId: reservation.reservationId,
        });
      }

      const targetAssignment = assignmentFor(
        operation,
        target,
        targetEpoch,
        operation.targetReservationId,
      );
      let retirement: { readonly status: "retired"; readonly proof: WriterAbsenceProof };
      const recoveredTargetCensus = await this.dependencies.runtime.censusWriters(
        operation.instanceId,
        operation.repositoryId,
        context.signal,
      );
      const recoveredProof = operation.writerAbsenceProof;
      const targetAlreadyRunning =
        censusIsComplete(recoveredTargetCensus) &&
        recoveredTargetCensus.writers.length === 1 &&
        recoveredTargetCensus.writers[0]?.runtimeEpoch === targetEpoch &&
        ["unknown", "starting-target", "target-ready", "route-activated"].includes(
          operation.phase,
        ) &&
        provesPreviousWriterAbsent(recoveredProof, targetAssignment, targetEpoch);

      if (targetAlreadyRunning && recoveredProof !== null) {
        // The old writer absence checkpoint is durable before start. A prior
        // worker may have started the target and exited before recording progress.
        retirement = { status: "retired", proof: recoveredProof };
      } else {
        const result = await this.retireAssignment(
          operation,
          operation.current,
          operation.id,
          reasonForOperation(operation),
          context,
          checkpoint,
        );
        if (result.status !== "retired") return result.result;
        retirement = result;
      }

      const beforeStart = await this.dependencies.runtime.censusWriters(
        operation.instanceId,
        operation.repositoryId,
        context.signal,
      );
      if (!censusIsComplete(beforeStart))
        return setOutcome(
          "unknown",
          "writer_census_incomplete",
          "runtime provider cannot prove the old writer is absent",
        );
      if (beforeStart.writers.length > 0) {
        if (
          beforeStart.writers.length === 1 &&
          beforeStart.writers[0]?.runtimeEpoch === targetEpoch &&
          provesPreviousWriterAbsent(retirement.proof, targetAssignment, targetEpoch)
        ) {
          // A prior attempt may have started the target and exited before recording progress.
          // Re-enter the idempotent provider start path so it can verify the exact
          // assignment and resume startup work such as runtime identity renewal.
          if (operation.phase === "unknown") {
            await context.assertLease();
            await checkpoint({ phase: "starting-target", failureCode: null, failureReason: null });
          }
          if (operation.phase === "starting-target") {
            await context.assertLease();
            await this.dependencies.runtime.start(
              targetAssignment,
              operation.id,
              context.assertLease,
              context.signal,
            );
          }
        } else {
          return setOutcome(
            "unknown",
            "writer_still_present",
            "an old or unexpected writer remains active",
          );
        }
      } else {
        await checkpoint({ phase: "old-writer-absent", writerAbsenceProof: retirement.proof });
        await context.assertLease();
        await checkpoint({ phase: "starting-target" });
        await context.assertLease();
        await this.dependencies.runtime.start(
          targetAssignment,
          operation.id,
          context.assertLease,
          context.signal,
        );
      }

      const readinessEvidence = await this.waitForReadiness(targetAssignment, context);
      if (readinessEvidence === null) {
        const rollback = await this.tryRollback(
          operation,
          targetAssignment,
          target,
          "target_readiness_timeout",
          context,
          checkpoint,
          setOutcome,
        );
        return rollback;
      }

      await checkpoint({ phase: "target-ready", readinessEvidence });
      await context.assertLease();
      await this.dependencies.routes.activate(
        targetAssignment,
        readinessEvidence,
        context.assertLease,
        context.signal,
      );
      await checkpoint({ phase: "route-activated" });

      if (
        operation.current?.reservationId !== null &&
        operation.current?.reservationId !== undefined
      ) {
        await context.assertLease();
        await this.dependencies.capacity.release(
          operation.current.reservationId,
          operation.id,
          context.assertLease,
          context.signal,
        );
      }
      await checkpoint({ phase: "complete" });
      return { status: "complete", observed: targetAssignment };
    } catch (error) {
      if (error instanceof StaleLifecycleOperationError) {
        return { status: "unknown", code: "stale_operation", reason: error.message };
      }
      if (context.signal.aborted) {
        return {
          status: "unknown",
          code: "operation_cancelled",
          reason: "operation was interrupted; recovery will inspect runtime state",
        };
      }
      throw error;
    }
  }

  private async resolveTarget(
    operation: LifecycleOperation,
    context: LifecycleExecutionContext,
    checkpoint: (patch: Partial<Omit<LifecycleOperation, "id" | "version">>) => Promise<void>,
  ): Promise<
    | { readonly status: "resolved"; readonly deployment: RuntimeDeployment }
    | { readonly status: "stopped"; readonly result: LifecycleResult }
  > {
    if (operation.target !== null) return { status: "resolved", deployment: operation.target };
    if (operation.targetRevisionId === null && operation.current !== null) {
      return { status: "resolved", deployment: operation.current.deployment };
    }
    await checkpoint({ phase: "waiting-for-artifact" });
    await context.assertLease();
    const resolution = await this.dependencies.builds.resolveOrBuild(
      operation,
      context.assertLease,
      context.signal,
    );
    if (resolution.status === "pending") {
      await checkpoint({
        phase: "waiting-for-artifact",
        ...(resolution.buildId === undefined ? {} : { buildId: resolution.buildId }),
      });
      return {
        status: "stopped",
        result: {
          status: "waiting",
          phase: "waiting-for-artifact",
          reason: "target artifact is still building; current runtime remains active",
        },
      };
    }
    if (resolution.status === "rejected" || resolution.deployment === undefined) {
      await checkpoint({
        phase: "failed",
        failureCode: resolution.reasonCode ?? "target_artifact_rejected",
        failureReason: "target artifact was not admitted",
      });
      return {
        status: "stopped",
        result: {
          status: "failed",
          code: resolution.reasonCode ?? "target_artifact_rejected",
          reason: "target artifact was not admitted",
        },
      };
    }
    await checkpoint({
      target: resolution.deployment,
      buildId: resolution.buildId ?? operation.buildId,
      phase: "accepted",
    });
    return { status: "resolved", deployment: resolution.deployment };
  }

  private async resumeRollback(
    operation: LifecycleOperation,
    context: LifecycleExecutionContext,
    checkpoint: (patch: Partial<Omit<LifecycleOperation, "id" | "version">>) => Promise<void>,
    setOutcome: (
      status: "blocked" | "failed" | "unknown",
      code: string,
      reason: string,
    ) => Promise<LifecycleResult>,
  ): Promise<LifecycleResult> {
    const previous = operation.current;
    const failedTarget = operation.target;
    const rollbackEpoch = operation.rollbackEpoch;
    if (previous === null || failedTarget === null || rollbackEpoch === null) {
      return setOutcome(
        "unknown",
        "rollback_checkpoint_incomplete",
        "rollback checkpoint lacks its admitted runtime identity",
      );
    }
    const failedAssignment = assignmentFor(
      operation,
      failedTarget,
      operation.targetEpoch ?? operation.runtimeEpoch,
      operation.targetReservationId,
    );
    if (
      operation.rollbackCompatible !== true ||
      !rollbackEvidenceMatches(
        operation.rollbackCompatibilityEvidence,
        failedAssignment,
        operation.quiesceReceipt,
      ) ||
      !(await this.dependencies.builds.isRollbackCompatible(
        previous.deployment,
        failedTarget,
        operation.rollbackCompatibilityEvidence,
      ))
    ) {
      return setOutcome(
        "unknown",
        "rollback_compatibility_unconfirmed",
        "fresh persisted post-quiesce data evidence does not prove the previous runtime can read and write this target state",
      );
    }

    const rollbackAssignment: RuntimeAssignment = {
      ...previous,
      runtimeEpoch: rollbackEpoch,
      // Rollback restores artifact/data compatibility, while retaining the
      // current public-origin policy (including an origin migration).
      deployment: {
        ...previous.deployment,
        hostname: operation.target?.hostname ?? previous.deployment.hostname,
        grantPolicy: operation.target?.grantPolicy ?? previous.deployment.grantPolicy,
      },
    };
    const proof = operation.writerAbsenceProof;
    if (
      !provesPreviousWriterAbsent(proof, rollbackAssignment, rollbackEpoch) ||
      proof.retiredRuntimeEpoch !== operation.targetEpoch
    ) {
      return setOutcome(
        "unknown",
        "rollback_writer_absence_unproven",
        "the failed target's writer absence is not durably proven",
      );
    }

    const census = await this.dependencies.runtime.censusWriters(
      operation.instanceId,
      operation.repositoryId,
      context.signal,
    );
    if (!censusIsComplete(census)) {
      return setOutcome(
        "unknown",
        "rollback_writer_census_incomplete",
        "cannot verify the writer set while recovering rollback",
      );
    }
    if (census.writers.length === 0) {
      await context.assertLease();
      await checkpoint({ phase: "starting-target" });
      await context.assertLease();
      await this.dependencies.runtime.start(
        rollbackAssignment,
        `${operation.id}:rollback`,
        context.assertLease,
        context.signal,
      );
    } else if (census.writers.length !== 1 || census.writers[0]?.runtimeEpoch !== rollbackEpoch) {
      return setOutcome(
        "unknown",
        "rollback_writer_unexpected",
        "an unexpected writer prevents rollback startup",
      );
    }

    const rollbackReadiness = await this.waitForReadiness(rollbackAssignment, context);
    if (rollbackReadiness === null) {
      return setOutcome(
        "unknown",
        "rollback_readiness_failed",
        "previous admitted runtime failed fresh readiness checks",
      );
    }
    await checkpoint({ phase: "target-ready", readinessEvidence: rollbackReadiness });
    await context.assertLease();
    await this.dependencies.routes.activate(
      rollbackAssignment,
      rollbackReadiness,
      context.assertLease,
      context.signal,
    );
    await checkpoint({ phase: "route-activated" });
    if (operation.targetReservationId !== null) {
      await context.assertLease();
      await this.dependencies.capacity.release(
        operation.targetReservationId,
        operation.id,
        context.assertLease,
        context.signal,
      );
    }
    const reason = `target readiness failed; prior admitted revision is active in epoch ${rollbackEpoch}`;
    await checkpoint({
      phase: "failed",
      failureCode: "target_readiness_failed_rolled_back",
      failureReason: reason,
    });
    return {
      status: "failed",
      code: "target_readiness_failed_rolled_back",
      reason,
      observed: rollbackAssignment,
    };
  }

  private async retireAssignment(
    operation: LifecycleOperation,
    assignment: RuntimeAssignment | null,
    operationId: string,
    reason: QuiesceRequest["reason"],
    context: LifecycleExecutionContext,
    checkpoint: (patch: Partial<Omit<LifecycleOperation, "id" | "version">>) => Promise<void>,
    beforeStop?: (receipt: QuiesceReceipt) => Promise<LifecycleResult | null>,
  ): Promise<
    | { readonly status: "retired"; readonly proof: WriterAbsenceProof }
    | { readonly status: "blocked"; readonly result: LifecycleResult }
  > {
    let census = await this.dependencies.runtime.censusWriters(
      operation.instanceId,
      operation.repositoryId,
      context.signal,
    );
    if (!censusIsComplete(census)) {
      return {
        status: "blocked",
        result: await this.saveOutcome(
          operation,
          checkpoint,
          "unknown",
          "writer_census_incomplete",
          "runtime provider could not prove the complete writer set",
        ),
      };
    }
    if (census.writers.length === 0) {
      const proof = this.absenceProof(operation, assignment, census);
      await checkpoint({ phase: "old-writer-absent", writerAbsenceProof: proof });
      return { status: "retired", proof };
    }
    if (
      assignment === null ||
      census.writers.length !== 1 ||
      census.writers[0]?.runtimeEpoch !== assignment.runtimeEpoch
    ) {
      return {
        status: "blocked",
        result: await this.saveOutcome(
          operation,
          checkpoint,
          "unknown",
          "unexpected_writer_present",
          "an unbound or concurrent writer prevents safe replacement",
        ),
      };
    }

    const persistedRequest = operation.quiesceRequest;
    const persistedOperationMatches =
      persistedRequest !== null &&
      persistedRequest.operationId === operationId &&
      persistedRequest.instanceId === assignment.instanceId &&
      persistedRequest.runtimeEpoch === assignment.runtimeEpoch;
    // A persisted receipt proves only that the producer was quiesced when the
    // worker last checkpointed it. The producer process can restart on the
    // same runtime epoch and reopen its in-memory mutation gate, so every
    // retirement attempt needs fresh remote confirmation and a fresh quiesce.
    let status: ProducerStatus;
    await context.assertLease();
    try {
      status = await this.dependencies.producer.status(assignment, context.signal);
    } catch {
      return {
        status: "blocked",
        result: await this.saveOutcome(
          operation,
          checkpoint,
          "unknown",
          "producer_remote_preflight_unavailable",
          "fresh producer remote confirmation was unavailable before retiring the writer",
        ),
      };
    }
    if (!hasFreshRemoteObservation(assignment, status, this.now())) {
      return {
        status: "blocked",
        result: await this.saveOutcome(
          operation,
          checkpoint,
          "unknown",
          "producer_remote_preflight_unverified",
          "fresh, assignment-bound remote confirmation was not available before retiring the writer",
        ),
      };
    }

    const request: QuiesceRequest = {
      operationId,
      instanceId: assignment.instanceId,
      runtimeEpoch: assignment.runtimeEpoch,
      reason: persistedOperationMatches ? (persistedRequest?.reason ?? reason) : reason,
      contractVersion: SCRIPTORIUM_PLATFORM_CONTRACT_VERSION,
      deadline: new Date(this.now() + this.quiesceTimeoutMs).toISOString(),
    };
    let receipt: QuiesceReceipt;
    await checkpoint({ phase: "quiescing-old", quiesceRequest: request, quiesceReceipt: null });
    try {
      await context.assertLease();
      receipt = await this.dependencies.producer.quiesce(
        request,
        context.assertLease,
        context.signal,
      );
    } catch (error) {
      const resumed = await this.resumeMatching(request, context);
      if (!resumed) {
        return {
          status: "blocked",
          result: await this.saveOutcome(
            operation,
            checkpoint,
            "unknown",
            "quiesce_outcome_unknown",
            "producer quiesce outcome is unknown and matching resume was not confirmed",
          ),
        };
      }
      await checkpoint({ phase: "accepted", quiesceRequest: null, quiesceReceipt: null });
      throw error;
    }
    if (!receiptMatches(receipt, request, this.now())) {
      const resumed = await this.resumeMatching(request, context);
      if (resumed)
        await checkpoint({ phase: "accepted", quiesceRequest: null, quiesceReceipt: null });
      return {
        status: "blocked",
        result: await this.saveOutcome(
          operation,
          checkpoint,
          "unknown",
          "quiesce_binding_invalid",
          resumed
            ? "producer returned a mismatched quiesce receipt"
            : "producer returned a mismatched receipt and could not be resumed",
        ),
      };
    }
    if (!quiesceIsSafe(receipt)) {
      const resumed = await this.resumeMatching(request, context);
      if (resumed)
        await checkpoint({ phase: "accepted", quiesceRequest: null, quiesceReceipt: null });
      const disposition = receipt.disposition === "blocked" ? "blocked" : "unknown";
      return {
        status: "blocked",
        result: await this.saveOutcome(
          operation,
          checkpoint,
          disposition,
          receipt.disposition === "blocked"
            ? "producer_quiesce_blocked"
            : "producer_quiesce_unknown",
          resumed
            ? `producer quiesce ${receipt.disposition}; unpublished work, active work, or unknown durability blocks retirement`
            : `producer quiesce ${receipt.disposition}; matching resume could not be confirmed`,
        ),
      };
    }
    await checkpoint({ phase: "old-quiesced", quiesceReceipt: receipt });
    if (beforeStop !== undefined) {
      const rejected = await beforeStop(receipt);
      if (rejected !== null) return { status: "blocked", result: rejected };
    }
    await context.assertLease();
    await checkpoint({ phase: "stopping-old" });
    try {
      await context.assertLease();
      await this.dependencies.runtime.stop(
        assignment,
        operationId,
        context.assertLease,
        context.signal,
      );
    } catch (error) {
      census = await this.dependencies.runtime
        .censusWriters(operation.instanceId, operation.repositoryId, context.signal)
        .catch(() => ({
          complete: false,
          providerObservationId: "",
          observedAt: "",
          matchedWriterCount: 0,
          writers: [],
        }));
      const stillOldWriter =
        censusIsComplete(census) &&
        census.writers.length === 1 &&
        census.writers[0]?.runtimeEpoch === assignment.runtimeEpoch;
      const resumed = stillOldWriter ? await this.resumeMatching(request, context) : false;
      if (resumed)
        await checkpoint({ phase: "accepted", quiesceRequest: null, quiesceReceipt: null });
      if (!stillOldWriter) {
        return {
          status: "blocked",
          result: await this.saveOutcome(
            operation,
            checkpoint,
            "unknown",
            "stop_outcome_unknown",
            "runtime stop did not prove whether the old writer remains",
          ),
        };
      }
      throw error;
    }

    const proof = await this.waitForAbsence(operation, assignment, context);
    if (proof === null) {
      return {
        status: "blocked",
        result: await this.saveOutcome(
          operation,
          checkpoint,
          "unknown",
          "old_writer_absence_unproven",
          "old writer termination is not proven; no replacement will start",
        ),
      };
    }
    await checkpoint({
      phase: "old-writer-absent",
      quiesceReceipt: receipt,
      writerAbsenceProof: proof,
    });
    return { status: "retired", proof };
  }

  private async waitForAbsence(
    operation: LifecycleOperation,
    assignment: RuntimeAssignment,
    context: LifecycleExecutionContext,
  ): Promise<WriterAbsenceProof | null> {
    const deadline = this.now() + this.quiesceTimeoutMs;
    while (this.now() < deadline) {
      await context.assertLease();
      const census = await this.dependencies.runtime.censusWriters(
        operation.instanceId,
        operation.repositoryId,
        context.signal,
      );
      if (!censusIsComplete(census)) return null;
      if (census.writers.length === 0) return this.absenceProof(operation, assignment, census);
      if (
        census.writers.length > 1 ||
        census.writers[0]?.runtimeEpoch !== assignment.runtimeEpoch
      ) {
        return null;
      }
      await sleep(this.pollIntervalMs, context.signal);
    }
    return null;
  }

  private absenceProof(
    operation: LifecycleOperation,
    retired: RuntimeAssignment | null,
    census: WriterCensus,
  ): WriterAbsenceProof {
    return {
      instanceId: operation.instanceId,
      repositoryId: operation.repositoryId,
      retiredRuntimeEpoch: retired?.runtimeEpoch ?? null,
      providerObservationId: census.providerObservationId,
      censusObservedAt: census.observedAt,
      remainingWriters: 0,
      evidenceIdentities: census.writers.flatMap((writer) => writer.identities),
      source: "runtime-provider-census",
    };
  }

  private async verifyReadiness(
    assignment: RuntimeAssignment,
    context: LifecycleExecutionContext,
  ): Promise<LifecycleReadinessEvidence | null> {
    const observed = await this.dependencies.runtime.readiness(assignment, context.signal);
    if (
      observed.status !== "ready" ||
      !sameAssignmentIdentity(observed.assignment, assignment) ||
      !observed.imageIdentityVerified ||
      observed.actualImageDigest !== assignment.deployment.platformManifestDigest ||
      observed.providerObservationId.length === 0
    )
      return null;
    const producer =
      observed.producer ?? (await this.dependencies.producer.status(assignment, context.signal));
    const producerObservedAt = Date.parse(producer.observedAt);
    const producerEvidenceTimeValid =
      Number.isFinite(producerObservedAt) &&
      producerObservedAt <= this.now() &&
      this.now() - producerObservedAt <= this.readinessEvidenceMaxAgeMs;
    if (
      !producer.ready ||
      producer.contractVersion !== SCRIPTORIUM_PLATFORM_CONTRACT_VERSION ||
      producer.instanceId !== assignment.instanceId ||
      producer.repositoryId !== assignment.repositoryId ||
      producer.runtimeEpoch !== assignment.runtimeEpoch ||
      producer.imageDigest !== assignment.deployment.imageDigest ||
      producer.compositionManifestDigest !== assignment.deployment.compositionManifestDigest ||
      !sameStrings(producer.enabledModuleIds, assignment.deployment.enabledModuleIds) ||
      !producerEvidenceTimeValid
    )
      return null;
    const auth = await this.dependencies.authProbe.verify(assignment, context.signal);
    const authObservedAt = Date.parse(auth.observedAt);
    const authEvidenceTimeValid =
      Number.isFinite(authObservedAt) &&
      authObservedAt <= this.now() &&
      this.now() - authObservedAt <= this.readinessEvidenceMaxAgeMs;
    const authPassed =
      auth.grantPolicyMatched &&
      auth.controlServicePolicyMatched &&
      auth.validGrantAccepted &&
      auth.wrongRepositoryGrantRejected &&
      auth.wrongEpochGrantRejected &&
      auth.invalidServiceCredentialRejected &&
      auth.applicationProbeId.length > 0 &&
      auth.uiApiMcpProbeId.length > 0 &&
      auth.persistenceProbeId.length > 0 &&
      auth.validGrantProbeId.length > 0 &&
      auth.wrongRepositoryProbeId.length > 0 &&
      auth.wrongEpochProbeId.length > 0 &&
      auth.invalidServiceCredentialProbeId.length > 0 &&
      authEvidenceTimeValid;
    if (!authPassed) return null;
    return {
      assignment,
      providerObservationId: observed.providerObservationId,
      actualImageDigest: observed.actualImageDigest,
      producerObservedAt: producer.observedAt,
      compositionManifestDigest: producer.compositionManifestDigest,
      enabledModuleIds: [...producer.enabledModuleIds].sort(),
      applicationProbeId: auth.applicationProbeId,
      uiApiMcpProbeId: auth.uiApiMcpProbeId,
      persistenceProbeId: auth.persistenceProbeId,
      validGrantProbeId: auth.validGrantProbeId,
      wrongRepositoryProbeId: auth.wrongRepositoryProbeId,
      wrongEpochProbeId: auth.wrongEpochProbeId,
      invalidServiceCredentialProbeId: auth.invalidServiceCredentialProbeId,
      persistence: producer.persistence ?? {
        state: "unknown",
        observedRemoteCommit: null,
        formats: [],
      },
      verifiedAt: auth.observedAt,
    };
  }

  private async waitForReadiness(
    assignment: RuntimeAssignment,
    context: LifecycleExecutionContext,
  ): Promise<LifecycleReadinessEvidence | null> {
    const deadline = this.now() + this.readinessTimeoutMs;
    while (this.now() < deadline) {
      await context.assertLease();
      try {
        const observation = await this.dependencies.runtime.readiness(assignment, context.signal);
        if (observation.status === "ready") {
          const evidence = await this.verifyReadiness(assignment, context);
          if (evidence !== null) return evidence;
        }
      } catch {
        // A transient observation failure is retried until the readiness deadline.
      }
      await sleep(this.pollIntervalMs, context.signal);
    }
    return null;
  }

  private async tryRollback(
    operation: LifecycleOperation,
    failedAssignment: RuntimeAssignment,
    target: RuntimeDeployment,
    readinessReason: string,
    context: LifecycleExecutionContext,
    checkpoint: (patch: Partial<Omit<LifecycleOperation, "id" | "version">>) => Promise<void>,
    setOutcome: (
      status: "blocked" | "failed" | "unknown",
      code: string,
      reason: string,
    ) => Promise<LifecycleResult>,
  ): Promise<LifecycleResult> {
    const previous = operation.current;
    if (previous === null) {
      return setOutcome(
        "unknown",
        "target_readiness_failed_no_compatible_rollback",
        `new runtime failed readiness (${boundReason(readinessReason)}); no prior admitted runtime is available`,
      );
    }

    let compatibilityEvidence = operation.rollbackCompatibilityEvidence;
    let rollbackCompatible = operation.rollbackCompatible;
    let quiesceReceipt = operation.quiesceReceipt;
    const retirement = await this.retireAssignment(
      operation,
      failedAssignment,
      `${operation.id}:rollback`,
      "rollback",
      context,
      checkpoint,
      async (receipt) => {
        quiesceReceipt = receipt;
        let census: WriterCensus;
        let status: ProducerStatus;
        try {
          await context.assertLease();
          census = await this.dependencies.runtime.censusWriters(
            operation.instanceId,
            operation.repositoryId,
            context.signal,
          );
          if (
            !censusIsComplete(census) ||
            census.writers.length !== 1 ||
            census.writers[0]?.runtimeEpoch !== failedAssignment.runtimeEpoch
          ) {
            return setOutcome(
              "unknown",
              "rollback_writer_observation_unproven",
              "post-quiesce provider observation did not identify exactly the failed target writer",
            );
          }
          status = await this.dependencies.producer.status(failedAssignment, context.signal);
        } catch {
          return setOutcome(
            "unknown",
            "rollback_persistence_observation_unavailable",
            "fresh producer persistence status could not be read after quiesce; the failed writer remains untouched",
          );
        }
        compatibilityEvidence = rollbackEvidenceFromStatus(
          failedAssignment,
          receipt,
          status,
          census,
          this.now(),
        );
        if (compatibilityEvidence === null) {
          return setOutcome(
            "unknown",
            "rollback_persistence_evidence_unproven",
            "post-quiesce status did not prove a fresh, safe, confirmed remote persistence state",
          );
        }
        await checkpoint({ rollbackCompatibilityEvidence: compatibilityEvidence });
        const compatible = await this.dependencies.builds.isRollbackCompatible(
          previous.deployment,
          target,
          compatibilityEvidence,
        );
        await checkpoint({ rollbackCompatible: compatible });
        rollbackCompatible = compatible;
        if (!compatible) {
          return setOutcome(
            "unknown",
            "target_readiness_failed_no_compatible_rollback",
            `new runtime failed readiness (${boundReason(readinessReason)}); the previous manifest cannot safely read and write the proven target state`,
          );
        }
        return null;
      },
    );
    if (retirement.status !== "retired") return retirement.result;
    if (
      rollbackCompatible !== true ||
      !rollbackEvidenceMatches(compatibilityEvidence, failedAssignment, quiesceReceipt) ||
      !(await this.dependencies.builds.isRollbackCompatible(
        previous.deployment,
        target,
        compatibilityEvidence,
      ))
    ) {
      return setOutcome(
        "unknown",
        "rollback_compatibility_unconfirmed",
        "a persisted fresh post-quiesce persistence proof is required before retiring the failed writer",
      );
    }

    let rollbackEpoch = operation.rollbackEpoch;
    if (rollbackEpoch === null) {
      rollbackEpoch = await this.dependencies.journal.allocateRollbackEpoch(
        operation.id,
        failedAssignment.runtimeEpoch,
        context.signal,
      );
      if (!Number.isSafeInteger(rollbackEpoch) || rollbackEpoch <= failedAssignment.runtimeEpoch) {
        return setOutcome(
          "blocked",
          "rollback_epoch_invalid",
          "Control Plane did not allocate a fresh rollback epoch",
        );
      }
      await checkpoint({ rollbackEpoch });
    }
    const rollbackAssignment: RuntimeAssignment = {
      ...previous,
      runtimeEpoch: rollbackEpoch,
      // Rollback restores artifact/data compatibility, while retaining the
      // current public-origin policy (including an origin migration).
      deployment: {
        ...previous.deployment,
        hostname: operation.target?.hostname ?? previous.deployment.hostname,
        grantPolicy: operation.target?.grantPolicy ?? previous.deployment.grantPolicy,
      },
    };
    const existing = await this.dependencies.runtime.censusWriters(
      operation.instanceId,
      operation.repositoryId,
      context.signal,
    );
    if (!censusIsComplete(existing))
      return setOutcome(
        "unknown",
        "rollback_writer_census_incomplete",
        "cannot prove the failed target writer is absent before rollback",
      );
    if (existing.writers.length === 0) {
      await checkpoint({ phase: "starting-target" });
      await context.assertLease();
      await this.dependencies.runtime.start(
        rollbackAssignment,
        `${operation.id}:rollback`,
        context.assertLease,
        context.signal,
      );
    } else if (
      existing.writers.length !== 1 ||
      existing.writers[0]?.runtimeEpoch !== rollbackEpoch
    ) {
      return setOutcome(
        "unknown",
        "rollback_writer_unexpected",
        "an unexpected writer prevents rollback startup",
      );
    }
    const rollbackReadiness = await this.waitForReadiness(rollbackAssignment, context);
    if (rollbackReadiness === null) {
      return setOutcome(
        "unknown",
        "rollback_readiness_failed",
        "previous admitted runtime failed fresh readiness checks",
      );
    }
    await checkpoint({ phase: "target-ready", readinessEvidence: rollbackReadiness });
    await context.assertLease();
    await this.dependencies.routes.activate(
      rollbackAssignment,
      rollbackReadiness,
      context.assertLease,
      context.signal,
    );
    if (operation.targetReservationId !== null) {
      await context.assertLease();
      await this.dependencies.capacity.release(
        operation.targetReservationId,
        operation.id,
        context.assertLease,
        context.signal,
      );
    }
    await checkpoint({
      phase: "failed",
      failureCode: "target_readiness_failed_rolled_back",
      failureReason: `target readiness failed (${boundReason(readinessReason)}); prior admitted revision is active in epoch ${rollbackEpoch}`,
    });
    return {
      status: "failed",
      code: "target_readiness_failed_rolled_back",
      reason: `target readiness failed (${boundReason(readinessReason)}); prior admitted revision is active`,
      observed: rollbackAssignment,
    };
  }

  private async resumeMatching(
    request: QuiesceRequest,
    context: LifecycleExecutionContext,
  ): Promise<boolean> {
    try {
      await context.assertLease();
      await this.dependencies.producer.resume(
        request,
        context.assertLease,
        AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
      );
      return true;
    } catch {
      return false;
    }
  }

  private async saveOutcome(
    operation: LifecycleOperation,
    checkpoint: (patch: Partial<Omit<LifecycleOperation, "id" | "version">>) => Promise<void>,
    status: "blocked" | "failed" | "unknown",
    code: string,
    reason: string,
  ): Promise<LifecycleResult> {
    await checkpoint({
      phase: status,
      failureCode: code.slice(0, 128),
      failureReason: boundReason(reason),
    });
    void operation;
    return { status, code, reason: boundReason(reason) };
  }
}
