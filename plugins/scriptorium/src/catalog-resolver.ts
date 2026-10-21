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
import provenanceV021 from "../vendor/provenance-3189a85bfa28ddd160600a0188ab3ccfa91755e4.json" with { type: "json" };
import type { ProducerCatalogResolver } from "./composition.js";

const LEGACY_PRODUCER_REVISION="008d5c429ec279a424cafd5b8c4cbee70a613b8e";
const LEGACY_RESOLVER_REVISION="sha256:2982c0d9595168b73b021da3229b30e7c4dd699ed86b6a728060f77cb3c2ea18";
const LEGACY_PROVENANCE_DIGEST="sha256:c81b71fff985aaf542d8fd6e2d76c0740ff9390f53f642d00da2fc6bd975db88";
const V021_PRODUCER_REVISION="3189a85bfa28ddd160600a0188ab3ccfa91755e4";
const V021_RESOLVER_REVISION=LEGACY_RESOLVER_REVISION;
const V021_PROVENANCE_DIGEST="sha256:46dc7f209c1a074b5acdeb8a7111006cfb20e3c40f219bc3edbe910be2209cac";

if(provenance.schemaVersion!=="scriptorium-build-catalog-resolver-provenance/v1"||
   provenance.sourceTreeClean!==true||
   provenance.producerRevision!==LEGACY_PRODUCER_REVISION||
   provenance.bundlePath!=="build-catalog.mjs"||
   provenance.bundleDigest!==LEGACY_RESOLVER_REVISION)
  throw new Error("The legacy Scriptorium resolver provenance is not approved");

if(provenanceV021.schemaVersion!=="scriptorium-build-catalog-resolver-provenance/v1"||
   provenanceV021.sourceTreeClean!==true||
   provenanceV021.producerRevision!==V021_PRODUCER_REVISION||
   provenanceV021.bundlePath!=="build-catalog.mjs"||
   provenanceV021.bundleDigest!==V021_RESOLVER_REVISION||
   provenanceV021.declarationPath!=="build-catalog.d.mts"||
   provenanceV021.declarationDigest!=="sha256:4c5c02dcf633dea98e3a984b5e0a296aabb884bedab2b80d33258a5dae06f6b0")
  throw new Error("The Scriptorium v0.2.1 resolver provenance is not approved");

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
const v021Descriptor=SourceResolverDescriptorSchema.parse({
  producerRevision:V021_PRODUCER_REVISION,
  resolverRevision:V021_RESOLVER_REVISION,
  contractVersion:"scriptorium-build/v1",
  provenanceDigest:V021_PROVENANCE_DIGEST,
});

function resolverEntry(descriptor:SourceResolverDescriptor):ProducerCatalogResolverRegistryEntry {
  const resolver:RevisionBoundProducerCatalogResolver={
    contractVersion:descriptor.contractVersion,
    producerRevision:descriptor.producerRevision,
    resolverRevision:descriptor.resolverRevision,
    resolve({catalog,requestedModules,targetPlatform}){
      if(!catalog.supportedPlatforms.includes(targetPlatform))
        throw new TypeError("The Scriptorium resolver does not support the target platform");
      return resolveBuildCatalogSelection(catalog,requestedModules).moduleOrder;
    },
  };
  return {
    descriptor,
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
  // The approved v0.2.1 bundle is byte-identical to the legacy bundle. Keep
  // separate revision and provenance bindings so an old descriptor cannot be
  // replayed as evidence for the newer producer checkout.
  const entries=[resolverEntry(legacyDescriptor),resolverEntry(v021Descriptor)];
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
