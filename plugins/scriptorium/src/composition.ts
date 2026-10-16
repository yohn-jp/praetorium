import { z } from "zod";
import {
  BuildCatalogSchema,
  BuildInputSchema,
  ResourceRequirementsSchema,
  type BuildCatalog,
  type BuildInput,
  type ResourceRequirements,
} from "@praetorium/contracts";

const ModuleIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
const CompositionRequestSchema = z.strictObject({
  requestedModules: z.array(ModuleIdSchema).max(256),
  targetPlatform: z.string().min(1).max(64),
  resourceProfileId: ModuleIdSchema,
});

export type CompositionRequest = z.infer<typeof CompositionRequestSchema>;

/**
 * This seam must be backed by the producer's versioned resolver. Scriptorium
 * currently publishes no resolver for `scriptorium-build/v1`, so callers must
 * fail closed until one is available. The adapter verifies its result against
 * the catalog's declared dependency graph; it does not invent module ordering
 * or a new module contract-range implementation. The inspected producer's
 * `packages/module-runtime/src/module-plan.ts` checks exact numeric
 * `contractVersion === CONTRACT_VERSION`; it has no `contractRange` field, so
 * that legacy resolver cannot satisfy this interface for the new catalog.
 */
export interface ProducerCatalogResolver {
  readonly contractVersion: BuildCatalog["contractVersion"];
  readonly producerRevision: string;
  resolve(input: {
    readonly catalog: BuildCatalog;
    readonly requestedModules: readonly string[];
    readonly targetPlatform: string;
  }): readonly string[];
}

export type CompositionErrorCode =
  | "CATALOG_REFERENCE_UNKNOWN"
  | "DEPENDENCY_CYCLE"
  | "INVALID_MODULE_VERSION"
  | "UNKNOWN_MODULE"
  | "UNSUPPORTED_PLATFORM"
  | "UNSUPPORTED_MODULE_SET"
  | "UNKNOWN_RESOURCE_PROFILE"
  | "UNKNOWN_SHARED_RESOURCE_GROUP"
  | "RESOURCE_OVERFLOW"
  | "RESOURCE_PROFILE_TOO_SMALL";

export class CompositionError extends TypeError {
  constructor(
    readonly code: CompositionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CompositionError";
  }
}

export interface NormalizedScriptoriumComposition {
  readonly buildInput: BuildInput;
  readonly minimumResources: ResourceRequirements;
  readonly selectedResourceProfile: ResourceRequirements & { readonly id: string };
}

/**
 * Resolve and validate one requested selection using a verified producer
 * resolver. Resource admission remains separate from the canonical build key.
 */
export function normalizeComposition(
  catalogInput: unknown,
  requestInput: unknown,
  producerResolver: ProducerCatalogResolver,
): NormalizedScriptoriumComposition {
  const catalog = BuildCatalogSchema.parse(catalogInput);
  const request = CompositionRequestSchema.parse(requestInput);
  if (typeof producerResolver?.resolve !== "function") {
    throw new TypeError("A versioned Scriptorium catalog resolver is required");
  }
  if (
    producerResolver.contractVersion !== catalog.contractVersion ||
    producerResolver.producerRevision !== catalog.producerRevision
  ) {
    throw new TypeError("The Scriptorium catalog resolver is not bound to this producer revision");
  }

  const modules = validateCatalogGraph(catalog);
  if (!catalog.supportedPlatforms.includes(request.targetPlatform)) {
    throw new CompositionError("UNSUPPORTED_PLATFORM", "The producer catalog does not support the requested platform");
  }
  if (new Set(request.requestedModules).size !== request.requestedModules.length) {
    throw new CompositionError("UNSUPPORTED_MODULE_SET", "Requested module IDs must be unique");
  }
  for (const id of request.requestedModules) {
    if (!modules.has(id)) throw new CompositionError("UNKNOWN_MODULE", "A requested module is absent from the producer catalog");
  }

  // The producer resolver owns contract-range and module compatibility rules.
  const producerResolvedIds = producerResolver.resolve({
    catalog,
    requestedModules: [...request.requestedModules],
    targetPlatform: request.targetPlatform,
  });
  if (!Array.isArray(producerResolvedIds) || new Set(producerResolvedIds).size !== producerResolvedIds.length) {
    throw new CompositionError("UNSUPPORTED_MODULE_SET", "The producer resolver returned an invalid module plan");
  }
  const resolved = new Set(producerResolvedIds);
  const expected = dependencyClosure(modules, request.requestedModules);
  if (
    resolved.size !== expected.size ||
    [...expected].some((id) => !resolved.has(id)) ||
    [...resolved].some((id) => !modules.has(id))
  ) {
    throw new CompositionError("UNSUPPORTED_MODULE_SET", "The producer resolver result does not match the declared dependency closure");
  }
  rejectConflicts(modules, resolved);

  const selectedModules = [...resolved]
    .map((id) => modules.get(id)!)
    .sort((left, right) => left.id.localeCompare(right.id));
  const minimumResources = calculateMinimumResources(catalog, selectedModules);
  const profile = catalog.resourceProfiles.find(({ id }) => id === request.resourceProfileId);
  if (!profile) throw new CompositionError("UNKNOWN_RESOURCE_PROFILE", "The selected resource profile is absent from the producer catalog");
  const selectedResourceProfile = ResourceRequirementsSchema.parse({
    cpuMilli: profile.cpuMilli,
    memoryMiB: profile.memoryMiB,
    ephemeralStorageMiB: profile.ephemeralStorageMiB,
  });
  if (
    selectedResourceProfile.cpuMilli < minimumResources.cpuMilli ||
    selectedResourceProfile.memoryMiB < minimumResources.memoryMiB ||
    selectedResourceProfile.ephemeralStorageMiB < minimumResources.ephemeralStorageMiB
  ) {
    throw new CompositionError("RESOURCE_PROFILE_TOO_SMALL", "The selected resource profile is below the declared module minimum");
  }

  const buildInput = BuildInputSchema.parse({
    contractVersion: catalog.contractVersion,
    producerRevision: catalog.producerRevision,
    runtimeBaseDigest: catalog.runtimeBaseDigest,
    buildKitDigest: catalog.buildKitDigest,
    recipeDigest: catalog.recipeDigest,
    sourceDigest: catalog.sourceDigest,
    lockDigest: catalog.lockDigest,
    requestedModules: [...request.requestedModules].sort(),
    resolvedModules: selectedModules.map(({ id, version, artifactDigest }) => ({ id, version, artifactDigest })),
    platform: request.targetPlatform,
    options: {},
  });

  return {
    buildInput,
    minimumResources,
    selectedResourceProfile: { id: profile.id, ...selectedResourceProfile },
  };
}

function validateCatalogGraph(catalog: BuildCatalog): Map<string, BuildCatalog["modules"][number]> {
  const modules = new Map(catalog.modules.map((module) => [module.id, module]));
  const resourceGroups = new Set(catalog.sharedResourceGroups.map(({ id }) => id));
  for (const module of catalog.modules) {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/u.test(module.version)) {
      throw new CompositionError("INVALID_MODULE_VERSION", "A catalog module has an invalid semantic version");
    }
    for (const id of [...module.requires, ...module.conflicts]) {
      if (!modules.has(id)) {
        throw new CompositionError("CATALOG_REFERENCE_UNKNOWN", "The producer catalog references a module that is absent");
      }
    }
    if (module.conflicts.includes(module.id)) {
      throw new CompositionError("CATALOG_REFERENCE_UNKNOWN", "A producer module cannot conflict with itself");
    }
    for (const groupId of module.sharedResourceGroupIds) {
      if (!resourceGroups.has(groupId)) {
        throw new CompositionError("UNKNOWN_SHARED_RESOURCE_GROUP", "A producer module references an absent shared resource group");
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new CompositionError("DEPENDENCY_CYCLE", "The producer catalog contains a dependency cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of modules.get(id)!.requires) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of modules.keys()) visit(id);
  return modules;
}

function dependencyClosure(
  modules: ReadonlyMap<string, BuildCatalog["modules"][number]>,
  requestedModules: readonly string[],
): Set<string> {
  const closure = new Set<string>();
  const include = (id: string): void => {
    if (closure.has(id)) return;
    const module = modules.get(id);
    if (!module) throw new CompositionError("UNKNOWN_MODULE", "The requested module dependency is absent from the producer catalog");
    closure.add(id);
    for (const dependency of module.requires) include(dependency);
  };
  for (const id of requestedModules) include(id);
  return closure;
}

function rejectConflicts(
  modules: ReadonlyMap<string, BuildCatalog["modules"][number]>,
  resolved: ReadonlySet<string>,
): void {
  for (const id of resolved) {
    if (modules.get(id)!.conflicts.some((other) => resolved.has(other))) {
      throw new CompositionError("UNSUPPORTED_MODULE_SET", "The resolved module selection contains a declared conflict");
    }
  }
}

function calculateMinimumResources(
  catalog: BuildCatalog,
  selectedModules: readonly BuildCatalog["modules"][number][],
): ResourceRequirements {
  const result = {
    cpuMilli: catalog.baseResources.cpuMilli,
    memoryMiB: catalog.baseResources.memoryMiB,
    ephemeralStorageMiB: catalog.baseResources.ephemeralStorageMiB,
  };
  const add = (resources: ResourceRequirements): void => {
    for (const key of Object.keys(result) as (keyof ResourceRequirements)[]) {
      const sum = result[key] + resources[key];
      if (!Number.isSafeInteger(sum)) throw new CompositionError("RESOURCE_OVERFLOW", "Declared resource demand exceeds safe integer range");
      result[key] = sum;
    }
  };
  const sharedGroupIds = new Set<string>();
  for (const module of selectedModules) {
    add(module.exclusiveResources);
    for (const groupId of module.sharedResourceGroupIds) sharedGroupIds.add(groupId);
  }
  const groups = new Map(catalog.sharedResourceGroups.map(({ id, resources }) => [id, resources]));
  for (const groupId of sharedGroupIds) {
    const resources = groups.get(groupId);
    if (!resources) throw new CompositionError("UNKNOWN_SHARED_RESOURCE_GROUP", "A selected shared resource group is absent from the producer catalog");
    add(resources);
  }
  return ResourceRequirementsSchema.parse(result);
}
