import { ProducerRevisionSchema } from "@praetorium/contracts";
import { resolveCatalogModuleOrder, type ProducerCatalogResolver } from "./composition.js";

export interface ProducerCatalogResolverRegistryEntry {
  readonly resolver: ProducerCatalogResolver;
}
export interface ProducerCatalogResolverRegistry {
  resolve(producerRevision: string): ProducerCatalogResolverRegistryEntry;
}

/** The signed catalog supplies module identities; no Release SHA or module list is embedded. */
export function createScriptoriumCatalogResolverRegistry(): ProducerCatalogResolverRegistry {
  return {
    resolve(producerRevision) {
      const revision = ProducerRevisionSchema.parse(producerRevision);
      return { resolver: {
        contractVersion: "scriptorium-build/v1",
        producerRevision: revision,
        resolve(input) {
          if (input.catalog.producerRevision !== revision)
            throw new TypeError("Catalog does not match the selected producer revision");
          return resolveCatalogModuleOrder(input);
        },
      } };
    },
  };
}
