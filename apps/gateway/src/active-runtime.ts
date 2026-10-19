import type { InstanceSnapshot } from "@praetorium/contracts";

type RuntimeObservation = Pick<
  InstanceSnapshot,
  "runtimeEpoch" | "observedRuntimeEpoch" | "observedState" | "currentArtifactDigest" | "legacyRuntimeEpoch"
>;

/**
 * A configuration plan advances the desired runtime epoch before replacement
 * begins. The currently ready image keeps its own epoch until observation says
 * that runtime is no longer serving.
 */
export function runtimeEpochForAccess(instance: RuntimeObservation): number {
  if (
    instance.observedState === "ready" &&
    instance.currentArtifactDigest !== null &&
    instance.observedRuntimeEpoch !== null
  ) return instance.observedRuntimeEpoch;
  return instance.runtimeEpoch;
}

export function hasReadyCurrentRuntime(instance: RuntimeObservation): boolean {
  return instance.observedRuntimeEpoch !== instance.legacyRuntimeEpoch && instance.observedState === "ready" &&
    instance.currentArtifactDigest !== null &&
    instance.observedRuntimeEpoch !== null;
}

export function hasReadyDesiredRuntime(instance: InstanceSnapshot): boolean {
  return hasReadyCurrentRuntime(instance) &&
    instance.observedGeneration === instance.generation &&
    instance.observedRuntimeEpoch === instance.runtimeEpoch;
}
