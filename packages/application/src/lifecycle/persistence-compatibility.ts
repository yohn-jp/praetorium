import { PersistenceCompatibilitySchema } from "@praetorium/contracts";
import type {
  RollbackCompatibilityEvidence,
  RuntimeDeployment,
  RuntimePersistenceDeclaration,
} from "./ports.js";

function formatKey(formatId: string, version: number): string {
  return `${formatId}\u0000${version}`;
}

function declarationValid(
  value: RuntimePersistenceDeclaration | undefined,
): value is RuntimePersistenceDeclaration {
  return PersistenceCompatibilitySchema.safeParse(value).success;
}

/**
 * A previous image can safely replace a quiesced target only when both
 * admitted manifests declare the same persistence contract, the target's
 * writes are readable by the previous image, and the fresh
 * producer scan found no unsupported formats at the exact confirmed remote
 * commit. Browser recovery formats are covered by the target declaration even
 * though the server cannot observe browser IndexedDB contents. Compatibility
 * is directional: the previous image must read target writes; it may continue
 * writing its own declared versions after rollback.
 */
export function isPersistenceRollbackCompatible(
  previous: RuntimeDeployment,
  target: RuntimeDeployment,
  evidence: RollbackCompatibilityEvidence,
): boolean {
  const prior = previous.persistence;
  const next = target.persistence;
  const emptyRemote =
    evidence.observedRemoteCommit === null &&
    evidence.quiesceRemoteCommit === null &&
    Array.isArray(evidence.formats) &&
    evidence.formats.length === 0;
  const matchingCommit =
    typeof evidence.observedRemoteCommit === "string" &&
    /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(evidence.observedRemoteCommit) &&
    typeof evidence.quiesceRemoteCommit === "string" &&
    /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(evidence.quiesceRemoteCommit) &&
    evidence.observedRemoteCommit === evidence.quiesceRemoteCommit;
  if (!declarationValid(prior) || !declarationValid(next)) return false;
  if (
    evidence.contractVersion !== "praetorium-rollback-compatibility/v1" ||
    typeof evidence.repositoryId !== "number" ||
    evidence.repositoryId !== target.repositoryId ||
    typeof evidence.imageDigest !== "string" ||
    evidence.imageDigest !== target.imageDigest ||
    typeof evidence.compositionManifestDigest !== "string" ||
    evidence.compositionManifestDigest !== target.compositionManifestDigest ||
    !Number.isSafeInteger(evidence.runtimeEpoch) ||
    evidence.runtimeEpoch < 1 ||
    typeof evidence.providerObservationId !== "string" ||
    evidence.providerObservationId.length === 0 ||
    typeof evidence.providerObservedAt !== "string" ||
    !Number.isFinite(Date.parse(evidence.providerObservedAt)) ||
    typeof evidence.observedAt !== "string" ||
    !Number.isFinite(Date.parse(evidence.observedAt)) ||
    Date.parse(evidence.providerObservedAt) > Date.parse(evidence.observedAt) ||
    typeof evidence.remoteObservedAt !== "string" ||
    !Number.isFinite(Date.parse(evidence.remoteObservedAt)) ||
    Date.parse(evidence.remoteObservedAt) > Date.parse(evidence.observedAt) ||
    Date.parse(evidence.observedAt) - Date.parse(evidence.remoteObservedAt) > 15_000 ||
    !Array.isArray(evidence.formats) ||
    evidence.formats.length > 256 ||
    (!emptyRemote && !matchingCommit) ||
    typeof evidence.quiesceRevision !== "string" ||
    evidence.quiesceRevision.length === 0
  )
    return false;

  const previousReadable = new Map(
    prior.readable.map((item) => [item.formatId, new Set(item.versions)]),
  );
  for (const item of next.writable) {
    if (
      item === null ||
      typeof item !== "object" ||
      !/^[a-z][a-z0-9.-]{0,127}$/u.test(item.formatId) ||
      !Number.isSafeInteger(item.version) ||
      item.version < 1
    )
      return false;
    if (!previousReadable.get(item.formatId)?.has(item.version)) return false;
  }
  const observedFormats = new Set<string>();
  for (const item of evidence.formats) {
    if (
      item === null ||
      typeof item !== "object" ||
      typeof item.formatId !== "string" ||
      !/^[a-z][a-z0-9.-]{0,127}$/u.test(item.formatId) ||
      !Number.isSafeInteger(item.version) ||
      item.version < 1
    )
      return false;
    const key = formatKey(item.formatId, item.version);
    if (observedFormats.has(key)) return false;
    observedFormats.add(key);
    if (!previousReadable.get(item.formatId)?.has(item.version)) return false;
  }
  return true;
}
