import { CanaryCleanupEvidenceSchema, CanaryHealthEvidenceSchema } from "@praetorium/application/releases";
import type { CanaryProvisionerObservationReader } from "@praetorium/application/releases";
import type { D1Database } from "@praetorium/persistence/d1";

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const MAX_WRITER_CENSUS_AGE_MS = 2 * 5 * 60 * 1_000;
const MAX_HEALTH_SAMPLE_AGE_MS = 2 * 60 * 1_000;
const MAX_COMPONENT_EVIDENCE_AGE_MS = 30 * 1_000;

export interface CanaryOperationReader {
  getById(operationId: string): Promise<unknown | null>;
}

export type RuntimeHealthObservationRow = {
  readonly instance_id: string;
  readonly repository_id: number;
  readonly runtime_epoch: number;
  readonly generation: number;
  readonly cluster_id: string;
  readonly operation_id: string;
  readonly provider_observation_id: string;
  readonly observed_at: number;
  readonly evidence_json: string;
};

/**
 * Reads the latest authenticated health sample recorded by the provisioner.
 * The internal write route fences each row against the current binding and
 * admitted provider observation; this reader independently binds that row to
 * the successful canary operation before it becomes promotion evidence.
 */
export function createReleaseCanaryObservationReader(
  operations: CanaryOperationReader,
  db: D1Database,
  now: () => number = Date.now,
): CanaryProvisionerObservationReader {
  return {
    async latestHealth(input) {
      const [operation, row] = await Promise.all([
        operations.getById(input.operationId),
        db
          .prepare(
            `SELECT instance_id, repository_id, runtime_epoch, generation, cluster_id,
                    operation_id, provider_observation_id, observed_at, evidence_json
             FROM runtime_health_observations
             WHERE instance_id = ? AND repository_id = ?`,
          )
          .bind(input.instanceId, input.repositoryId)
          .first<RuntimeHealthObservationRow>(),
      ]);
      if (!isRecord(operation) || !isSucceededOperation(operation) || !isRecord(row)) return null;
      if (
        operation.id !== input.operationId ||
        operation.instanceId !== input.instanceId ||
        operation.repositoryId !== input.repositoryId ||
        !["start", "redeploy", "update"].includes(String(operation.kind)) ||
        row.instance_id !== input.instanceId ||
        row.repository_id !== input.repositoryId ||
        row.operation_id !== input.operationId
      ) {
        return null;
      }

      const runtimeEpoch = positiveInteger(operation.runtimeEpoch);
      const generation = positiveInteger(operation.generation);
      const clusterId = operation.clusterId;
      const deploymentRevisionId = operation.deploymentRevisionId;
      const result = operation.result;
      const observation = isRecord(result) && isRecord(result.observation) ? result.observation : null;
      const evidence = parseEvidence(row.evidence_json);
      const assignment = evidence && isRecord(evidence.assignment) ? evidence.assignment : null;
      const deployment = assignment && isRecord(assignment.deployment) ? assignment.deployment : null;
      const checkpoint = isRecord(operation.checkpoint) ? operation.checkpoint : null;
      const lifecycle = checkpoint && isRecord(checkpoint.lifecycle) ? checkpoint.lifecycle : null;
      const startup = lifecycle && isRecord(lifecycle.readinessEvidence) ? lifecycle.readinessEvidence : null;
      const startupAssignment = startup && isRecord(startup.assignment) ? startup.assignment : null;
      const startupDeployment =
        startupAssignment && isRecord(startupAssignment.deployment) ? startupAssignment.deployment : null;
      if (
        !evidence ||
        !assignment ||
        !deployment ||
        !observation ||
        !isRecord(result) ||
        !startup ||
        !startupAssignment ||
        !startupDeployment
      ) return null;

      const artifactDigest = deployment.imageDigest;
      const platformManifestDigest = deployment.platformManifestDigest;
      const compositionManifestDigest = deployment.compositionManifestDigest;
      const actualImageDigest = evidence.actualImageDigest;
      const providerObservationId = evidence.providerObservationId;
      const moduleIds = stringArray(evidence.enabledModuleIds);
      const persistence = evidence.persistence;
      const observedAt = row.observed_at;
      const producerObservedAt = parseTimestamp(evidence.producerObservedAt);
      const verifiedAt = parseTimestamp(evidence.verifiedAt);
      const observedNow = now();
      const probeIds = [
        evidence.applicationProbeId,
        evidence.validGrantProbeId,
        evidence.wrongRepositoryProbeId,
        evidence.wrongEpochProbeId,
        evidence.invalidServiceCredentialProbeId,
        evidence.uiApiMcpProbeId,
        evidence.persistenceProbeId,
      ];
      if (
        runtimeEpoch === null ||
        generation === null ||
        typeof clusterId !== "string" ||
        clusterId.length === 0 ||
        typeof deploymentRevisionId !== "string" ||
        deploymentRevisionId.length === 0 ||
        row.runtime_epoch !== runtimeEpoch ||
        row.generation !== generation ||
        row.cluster_id !== clusterId ||
        assignment.instanceId !== input.instanceId ||
        assignment.repositoryId !== input.repositoryId ||
        assignment.runtimeEpoch !== runtimeEpoch ||
        assignment.generation !== generation ||
        assignment.clusterId !== clusterId ||
        !isDigest(artifactDigest) ||
        !isDigest(platformManifestDigest) ||
        !isDigest(compositionManifestDigest) ||
        deployment.revisionId !== deploymentRevisionId ||
        actualImageDigest !== platformManifestDigest ||
        evidence.compositionManifestDigest !== compositionManifestDigest ||
        !validText(providerObservationId) ||
        row.provider_observation_id !== providerObservationId ||
        !Number.isSafeInteger(observedAt) ||
        observedAt > observedNow ||
        observedNow - observedAt > MAX_HEALTH_SAMPLE_AGE_MS ||
        !Number.isSafeInteger(producerObservedAt) ||
        !Number.isSafeInteger(verifiedAt) ||
        producerObservedAt > observedAt ||
        verifiedAt !== observedAt ||
        observedNow - producerObservedAt > MAX_COMPONENT_EVIDENCE_AGE_MS ||
        observedNow - verifiedAt > MAX_COMPONENT_EVIDENCE_AGE_MS ||
        !probeIds.every(validText) ||
        new Set(probeIds).size !== probeIds.length ||
        !validPersistenceObservation(persistence) ||
        startupAssignment.instanceId !== input.instanceId ||
        startupAssignment.repositoryId !== input.repositoryId ||
        startupAssignment.runtimeEpoch !== runtimeEpoch ||
        startupAssignment.generation !== generation ||
        startupAssignment.clusterId !== clusterId ||
        startupDeployment.revisionId !== deploymentRevisionId ||
        startupDeployment.imageDigest !== artifactDigest ||
        startupDeployment.platformManifestDigest !== platformManifestDigest ||
        startupDeployment.compositionManifestDigest !== compositionManifestDigest ||
        !sameModules(moduleIds, startup.enabledModuleIds) ||
        observation.instanceId !== input.instanceId ||
        observation.repositoryId !== input.repositoryId ||
        observation.generation !== generation ||
        observation.runtimeEpoch !== runtimeEpoch ||
        observation.observedState !== "ready" ||
        observation.observedArtifactDigest !== artifactDigest ||
        observation.observedRevisionId !== deploymentRevisionId ||
        operation.status !== "succeeded" ||
        result.terminal !== "succeeded"
      ) {
        return null;
      }

      const parsed = CanaryHealthEvidenceSchema.safeParse({
        artifactDigest,
        runtimeId: input.instanceId,
        operationId: input.operationId,
        runtimeEpoch,
        providerObservationId,
        source: "runtime-provisioner-observation",
        imageIdentityVerified: true,
        observedAt,
        checks: { startup: true, auth: true, uiApiMcp: true, persistence: true },
        checkEvidence: {
          startup: evidence.applicationProbeId,
          auth: [
            evidence.validGrantProbeId,
            evidence.wrongRepositoryProbeId,
            evidence.wrongEpochProbeId,
            evidence.invalidServiceCredentialProbeId,
          ].join(";"),
          uiApiMcp: evidence.uiApiMcpProbeId,
          persistence: evidence.persistenceProbeId,
        },
      });
      return parsed.success ? parsed.data : null;
    },

    async writerAbsence(input) {
      const operation = await operations.getById(input.afterOperationId);
      if (
        !isRecord(operation) ||
        !isSucceededOperation(operation) ||
        operation.kind !== "stop" ||
        operation.id !== input.afterOperationId ||
        operation.instanceId !== input.instanceId ||
        operation.repositoryId !== input.repositoryId ||
        operation.runtimeEpoch !== input.retiredEpoch
      ) {
        return null;
      }
      const checkpoint = operation.checkpoint;
      if (!isRecord(checkpoint)) return null;
      const proof = isRecord(checkpoint.writerAbsenceProof)
        ? checkpoint.writerAbsenceProof
        : isRecord(checkpoint.lifecycle) && isRecord(checkpoint.lifecycle.writerAbsenceProof)
          ? checkpoint.lifecycle.writerAbsenceProof
          : null;
      if (!proof) return null;
      const censusObservedAt = parseTimestamp(proof.censusObservedAt);
      const observedNow = now();
      const identities = stringArray(proof.evidenceIdentities);
      const parsed = CanaryCleanupEvidenceSchema.shape.writerAbsence.safeParse({
        instanceId: proof.instanceId,
        repositoryId: proof.repositoryId,
        retiredEpoch: proof.retiredRuntimeEpoch,
        providerObservationId: proof.providerObservationId,
        censusObservedAt,
        remainingWriters: proof.remainingWriters,
        evidenceIdentities: identities,
        source: proof.source,
      });
      if (
        !parsed.success ||
        parsed.data.instanceId !== input.instanceId ||
        parsed.data.repositoryId !== input.repositoryId ||
        parsed.data.retiredEpoch !== input.retiredEpoch ||
        typeof operation.createdAt !== "number" ||
        !Number.isSafeInteger(operation.createdAt) ||
        censusObservedAt < operation.createdAt ||
        observedNow < censusObservedAt ||
        observedNow - censusObservedAt > MAX_WRITER_CENSUS_AGE_MS
      ) {
        return null;
      }
      return parsed.data;
    },
  };
}

function parseEvidence(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || value.length > 32_768) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isSucceededOperation(value: Record<string, unknown>): boolean {
  return value.status === "succeeded" && value.result !== null && value.checkpoint !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function parseTimestamp(value: unknown): number {
  return typeof value === "string" ? Date.parse(value) : Number.NaN;
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && DIGEST.test(value);
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function sameModules(left: readonly string[], right: unknown): boolean {
  if (!Array.isArray(right) || !right.every((item) => typeof item === "string")) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length && sortedLeft.every((id, index) => id === sortedRight[index]);
}

function validPersistenceObservation(value: unknown): boolean {
  if (!isRecord(value) || value.state !== "verified" || !COMMIT.test(String(value.observedRemoteCommit))) {
    return false;
  }
  return (
    Array.isArray(value.formats) &&
    value.formats.every(
      (format) =>
        isRecord(format) &&
        validText(format.formatId) &&
        Number.isSafeInteger(format.version) &&
        (format.version as number) > 0,
    )
  );
}
