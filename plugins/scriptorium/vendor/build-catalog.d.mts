export type ProducerResourceAmounts = {
  cpuMilli: number;
  memoryMiB: number;
  ephemeralStorageMiB: number;
};
export type ProducerResolvedModule = { id: string; version: string; artifactDigest: string };
export type ProducerBuildCatalogSelection = {
  requestedModules: string[];
  resolvedModules: ProducerResolvedModule[];
  resourceRequirements: ProducerResourceAmounts;
  moduleOrder: string[];
};
export declare function resolveBuildCatalogSelection(
  catalog: unknown,
  requestedModuleIds: readonly string[],
): ProducerBuildCatalogSelection;
export declare function resolveCompositionPersistence(selectedModuleIds: readonly string[]): {
  contractVersion: "scriptorium-persistence/v1";
  readable: { formatId: string; versions: number[] }[];
  writable: { formatId: string; version: number }[];
};
