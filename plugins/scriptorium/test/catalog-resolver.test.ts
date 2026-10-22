import { expect, it } from "vitest";
import { BuildCatalogSchema } from "@praetorium/contracts";
import { createScriptoriumCatalogResolverRegistry } from "../src/catalog-resolver.js";
import fixture from "./fixtures/build-catalog.v1.fixture.json" with { type: "json" };

function catalog(revision: string) {
  const ids = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "search"];
  return BuildCatalogSchema.parse({ ...fixture, producerRevision: revision,
    modules: ids.map((id, index) => ({ ...fixture.modules[0], id,
      requires: index ? [ids[index - 1]] : [], conflicts: [], contractRange: "^1" })),
  });
}

it("resolves nine catalog-declared modules for distinct immutable Releases without fixed IDs or SHAs", () => {
  const registry = createScriptoriumCatalogResolverRegistry();
  for (const revision of ["a".repeat(40), "f".repeat(40)]) {
    const resolver = registry.resolve(revision).resolver;
    const value = catalog(revision);
    expect(new Set(resolver.resolve({ catalog: value, requestedModules: ["search"], targetPlatform: "linux/amd64" })))
      .toEqual(new Set(value.modules.map(module => module.id)));
    expect(resolver.producerRevision).toBe(revision);
    expect(() => resolver.resolve({catalog:catalog("b".repeat(40)),requestedModules:[],targetPlatform:"linux/amd64"}))
      .toThrow(/selected producer revision/u);
  }
});

it("rejects unsupported contracts, unknown selections, cycles and conflicts from signed catalog data", () => {
  const revision = "a".repeat(40);
  const resolver = createScriptoriumCatalogResolverRegistry().resolve(revision).resolver;
  const run = (value = catalog(revision), requestedModules = ["search"]) => resolver.resolve({catalog:value,requestedModules,targetPlatform:"linux/amd64"});
  expect(() => run(catalog(revision), ["absent"])).toThrow(/absent/u);
  const unsupported = catalog(revision); unsupported.modules[0]!.contractRange = "^2";
  expect(() => run(unsupported)).toThrow(/contract range/u);
  const cycle = catalog(revision); cycle.modules[0]!.requires = ["search"];
  expect(() => run(cycle)).toThrow(/cycle/u);
  const conflict = catalog(revision); conflict.modules[0]!.conflicts = ["search"];
  expect(() => run(conflict)).toThrow(/conflict/u);
});
