import {
  PersistenceCompatibilitySchema,
  type PersistenceCompatibility,
} from "@praetorium/contracts";
import {
  resolveCompositionPersistence,
  resolveBuildCatalogSelection,
} from "../vendor/build-catalog.mjs";
import provenance from "../vendor/provenance.json" with { type: "json" };
import type { ProducerCatalogResolver } from "./composition.js";

/** Uses the producer's exact resolver and embedded trusted module descriptors.
 * Updating the producer revision requires regenerating this checked-in artifact. */
export function createScriptoriumCatalogResolver(): ProducerCatalogResolver {
  if (
    provenance.schemaVersion !== "scriptorium-build-catalog-resolver-provenance/v1" ||
    provenance.sourceTreeClean !== true ||
    !/^[a-f0-9]{40}$/u.test(provenance.producerRevision)
  )
    throw new TypeError("The Scriptorium resolver artifact has no clean source binding");
  return {
    contractVersion: "scriptorium-build/v1",
    producerRevision: provenance.producerRevision,
    resolve({ catalog, requestedModules, targetPlatform }) {
      if (!catalog.supportedPlatforms.includes(targetPlatform)) {
        throw new TypeError("The Scriptorium resolver does not support the target platform");
      }
      return resolveBuildCatalogSelection(catalog, requestedModules).moduleOrder;
    },
  };
}

/** Uses exactly the persistence declarations embedded in the matching producer recipe. */
export function scriptoriumCompositionPersistence(
  producerRevision: string,
  selectedModuleIds: readonly string[],
): PersistenceCompatibility {
  const resolver = createScriptoriumCatalogResolver();
  if (producerRevision !== resolver.producerRevision)
    throw new TypeError("The composition producer revision does not match the trusted resolver");
  return PersistenceCompatibilitySchema.parse(resolveCompositionPersistence(selectedModuleIds));
}
