import {
  PersistenceCompatibilitySchema,
  ResolverRevisionSchema,
  SourceResolverDescriptorSchema,
  type PersistenceCompatibility,
  type ResolverRevision,
  type SourceResolverDescriptor,
} from "@praetorium/contracts";
import {
  resolveCompositionPersistence,
  resolveBuildCatalogSelection,
} from "../vendor/build-catalog.mjs";
import provenance from "../vendor/provenance.json" with { type: "json" };
import type { ProducerCatalogResolver } from "./composition.js";

const LEGACY_PRODUCER_REVISION="008d5c429ec279a424cafd5b8c4cbee70a613b8e";
const LEGACY_RESOLVER_REVISION="sha256:2982c0d9595168b73b021da3229b30e7c4dd699ed86b6a728060f77cb3c2ea18";
const LEGACY_PROVENANCE_DIGEST="sha256:c81b71fff985aaf542d8fd6e2d76c0740ff9390f53f642d00da2fc6bd975db88";

if(provenance.schemaVersion!=="scriptorium-build-catalog-resolver-provenance/v1"||
   provenance.sourceTreeClean!==true||
   provenance.producerRevision!==LEGACY_PRODUCER_REVISION||
   provenance.bundlePath!=="build-catalog.mjs"||
   provenance.bundleDigest!==LEGACY_RESOLVER_REVISION)
  throw new Error("The legacy Scriptorium resolver provenance is not approved");

export type RevisionBoundProducerCatalogResolver = ProducerCatalogResolver & {
  readonly resolverRevision: ResolverRevision;
};

export interface ProducerCatalogResolverRegistryEntry {
  readonly descriptor: SourceResolverDescriptor;
  readonly resolver: RevisionBoundProducerCatalogResolver;
  persistenceForModules(selectedModuleIds: readonly string[]): PersistenceCompatibility;
}

export interface ProducerCatalogResolverRegistry {
  /** Select only statically approved resolver bytes bound to this producer revision. */
  resolve(producerRevision: string, resolverRevision?: string): ProducerCatalogResolverRegistryEntry;
}

const legacyDescriptor=SourceResolverDescriptorSchema.parse({
  producerRevision:LEGACY_PRODUCER_REVISION,
  resolverRevision:LEGACY_RESOLVER_REVISION,
  contractVersion:"scriptorium-build/v1",
  provenanceDigest:LEGACY_PROVENANCE_DIGEST,
});

function legacyEntry():ProducerCatalogResolverRegistryEntry {
  const resolver:RevisionBoundProducerCatalogResolver={
    contractVersion:legacyDescriptor.contractVersion,
    producerRevision:legacyDescriptor.producerRevision,
    resolverRevision:legacyDescriptor.resolverRevision,
    resolve({catalog,requestedModules,targetPlatform}){
      if(!catalog.supportedPlatforms.includes(targetPlatform))
        throw new TypeError("The Scriptorium resolver does not support the target platform");
      return resolveBuildCatalogSelection(catalog,requestedModules).moduleOrder;
    },
  };
  return {
    descriptor:legacyDescriptor,
    resolver,
    persistenceForModules(selectedModuleIds){
      return PersistenceCompatibilitySchema.parse(resolveCompositionPersistence(selectedModuleIds));
    },
  };
}

/**
 * Static allowlist of reviewed resolver bundles. Never load a resolver from a
 * Source proof or producer checkout; adding an ABI requires a reviewed entry.
 */
export function createScriptoriumCatalogResolverRegistry():ProducerCatalogResolverRegistry {
  const entries=[legacyEntry()];
  const byProducerRevision=new Map<string,ProducerCatalogResolverRegistryEntry>(
    entries.map((entry)=>[entry.descriptor.producerRevision,entry]),
  );
  return {
    resolve(producerRevision,resolverRevision){
      if(!/^[a-f0-9]{40}$/u.test(producerRevision))
        throw new TypeError("The producer revision is invalid");
      const entry=byProducerRevision.get(producerRevision);
      if(!entry)throw new TypeError("No approved Scriptorium resolver exists for this producer revision");
      if(resolverRevision!==undefined &&
         ResolverRevisionSchema.parse(resolverRevision)!==entry.descriptor.resolverRevision)
        throw new TypeError("The resolver digest does not match the approved producer bundle");
      return entry;
    },
  };
}

/** Compatibility API for the previously approved producer revision. */
export function createScriptoriumCatalogResolver():ProducerCatalogResolver {
  return createScriptoriumCatalogResolverRegistry().resolve(LEGACY_PRODUCER_REVISION).resolver;
}

/** Compatibility API; selection now uses the same revision-indexed entry. */
export function scriptoriumCompositionPersistence(
  producerRevision:string,
  selectedModuleIds:readonly string[],
):PersistenceCompatibility {
  return createScriptoriumCatalogResolverRegistry()
    .resolve(producerRevision).persistenceForModules(selectedModuleIds);
}
