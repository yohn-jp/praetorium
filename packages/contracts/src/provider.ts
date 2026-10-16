export type BeforeEffect = () => Promise<void>;
export type RuntimeIdentity = {
  instanceId: string;
  repositoryId: number;
  runtimeEpoch: number;
  generation: number;
  clusterId: string;
};
export type RuntimeObservation = {
  identity: RuntimeIdentity;
  writer: "present" | "absent" | "unknown";
  ready: boolean;
  observedImageDigest: string | null;
  observedAt: number;
};
export type CapacitySnapshot = {
  observedAt: number;
  authoritative: boolean;
  cpuMilli: number;
  memoryMiB: number;
  ephemeralStorageMiB: number;
};
export interface RuntimeProvider {
  inspect(identity: RuntimeIdentity): Promise<RuntimeObservation>;
  ensureRunning(
    assignment: RuntimeIdentity & { artifactDigest: string },
    beforeEffect: BeforeEffect,
  ): Promise<RuntimeObservation>;
  ensureStopped(identity: RuntimeIdentity, beforeEffect: BeforeEffect): Promise<RuntimeObservation>;
  ensureRelease(identity: RuntimeIdentity, beforeEffect: BeforeEffect): Promise<void>;
  ensureRuntimeDeleted(identity: RuntimeIdentity, beforeEffect: BeforeEffect): Promise<void>;
  listManagedInstances(): Promise<RuntimeObservation[]>;
  getCapacitySnapshot(): Promise<CapacitySnapshot>;
}
