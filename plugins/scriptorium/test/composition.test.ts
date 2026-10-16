import { describe, expect, it } from "vitest";
import catalogFixture from "./fixtures/build-catalog.v1.fixture.json" with { type: "json" };
import {
  CompositionError,
  normalizeComposition,
  type ProducerCatalogResolver,
} from "../src/composition.js";

const dependencyResolver: ProducerCatalogResolver = {
  contractVersion: "scriptorium-build/v1",
  producerRevision: catalogFixture.producerRevision,
  resolve({ catalog, requestedModules }) {
    const modules = new Map(catalog.modules.map((module) => [module.id, module]));
    const resolved = new Set<string>();
    const include = (id: string): void => {
      const module = modules.get(id);
      if (!module) throw new Error("unknown fixture module");
      if (resolved.has(id)) return;
      if (module.contractRange !== "^1.0.0") throw new Error("unsupported fixture contract range");
      resolved.add(id);
      for (const dependency of module.requires) include(dependency);
    };
    for (const id of requestedModules) include(id);
    return [...resolved];
  },
};

const request = {
  requestedModules: ["diagnostics"],
  targetPlatform: "linux/amd64",
  resourceProfileId: "medium",
};

describe("Scriptorium composition normalization", () => {
  it("accepts the Core preset as an empty producer-resolved selection", () => {
    const result = normalizeComposition(catalogFixture, {
      requestedModules: [],
      targetPlatform: "linux/amd64",
      resourceProfileId: "small",
    }, dependencyResolver);

    expect(result.buildInput.requestedModules).toEqual([]);
    expect(result.buildInput.resolvedModules).toEqual([]);
    expect(result.minimumResources).toEqual(catalogFixture.baseResources);
  });

  it("accepts a second non-preset selection from the same catalog fixture", () => {
    const result = normalizeComposition(catalogFixture, {
      requestedModules: ["nlp"],
      targetPlatform: "linux/amd64",
      resourceProfileId: "medium",
    }, dependencyResolver);

    expect(result.buildInput.requestedModules).toEqual(["nlp"]);
    expect(result.buildInput.resolvedModules.map(({ id }) => id)).toEqual(["nlp"]);
    expect(result.minimumResources).toEqual({
      cpuMilli: 1500,
      memoryMiB: 2560,
      ephemeralStorageMiB: 3072,
    });
  });

  it("builds canonical immutable input and counts a shared resource group once", () => {
    const result = normalizeComposition(catalogFixture, request, dependencyResolver);

    expect(result.buildInput.requestedModules).toEqual(["diagnostics"]);
    expect(result.buildInput.resolvedModules).toEqual([
      {
        id: "diagnostics",
        version: "1.0.0",
        artifactDigest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
      },
      {
        id: "nlp",
        version: "1.0.0",
        artifactDigest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      },
    ]);
    expect(result.buildInput.sourceDigest).toBe(catalogFixture.sourceDigest);
    expect(result.minimumResources).toEqual({
      cpuMilli: 1600,
      memoryMiB: 2816,
      ephemeralStorageMiB: 3200,
    });
    expect(result.selectedResourceProfile).toEqual({
      id: "medium",
      cpuMilli: 2000,
      memoryMiB: 4096,
      ephemeralStorageMiB: 4096,
    });
  });

  it("fails closed without a versioned producer resolver or when its closure disagrees", () => {
    expect(() => normalizeComposition(catalogFixture, request, undefined as never)).toThrow(/resolver/u);
    expect(() => normalizeComposition(catalogFixture, request, {
      ...dependencyResolver,
      resolve: () => ["diagnostics"],
    }))
      .toThrow(CompositionError);
    expect(() => normalizeComposition(catalogFixture, request, {
      ...dependencyResolver,
      producerRevision: "1111111111111111111111111111111111111111",
    })).toThrow(/bound/u);
  });

  it("rejects unknown requested modules and delegates compatibility to the producer resolver", () => {
    expect(() => normalizeComposition(catalogFixture, {
      ...request,
      requestedModules: ["not-in-catalog"],
    }, dependencyResolver)).toThrow(/absent/u);
    expect(() => normalizeComposition(catalogFixture, request, {
      ...dependencyResolver,
      resolve() {
        throw new Error("producer rejects incompatible module contract range");
      },
    })).toThrow(/incompatible module contract range/u);
  });

  it("rejects unsupported platforms and profiles below declared minimum demand", () => {
    expect(() => normalizeComposition(catalogFixture, { ...request, targetPlatform: "linux/arm64" }, dependencyResolver))
      .toThrow(/support/u);
    expect(() => normalizeComposition(catalogFixture, { ...request, resourceProfileId: "small" }, dependencyResolver))
      .toThrow(/below/u);
  });

  it("rejects malformed SemVer prerelease and build identifiers", () => {
    for (const version of [
      "latest",
      "1.0.0-alpha..1",
      "1.0.0-.x",
      "1.0.0-alpha.01",
      "01.0.0",
      "1.0.0+build..1",
    ]) {
      const catalog = {
        ...catalogFixture,
        modules: catalogFixture.modules.map((module) => module.id === "nlp"
          ? { ...module, version }
          : module),
      };
      expect(() => normalizeComposition(catalog, request, dependencyResolver), version)
        .toThrow(/semantic version/u);
    }

    const validSemver = {
      ...catalogFixture,
      modules: catalogFixture.modules.map((module) => module.id === "nlp"
        ? { ...module, version: "1.2.3-alpha.0+build.5" }
        : module),
    };
    const normalized = normalizeComposition(validSemver, request, dependencyResolver);
    expect(normalized.buildInput.resolvedModules.find(({ id }) => id === "nlp")?.version)
      .toBe("1.2.3-alpha.0+build.5");
  });

  it("rejects cycles, unknown references, and conflicting selected modules", () => {
    const cyclic = {
      ...catalogFixture,
      modules: catalogFixture.modules.map((module) => module.id === "nlp"
        ? { ...module, requires: ["diagnostics"] }
        : module),
    };
    expect(() => normalizeComposition(cyclic, request, dependencyResolver)).toThrow(/cycle/u);

    const dangling = {
      ...catalogFixture,
      modules: catalogFixture.modules.map((module) => module.id === "nlp"
        ? { ...module, requires: ["absent"] }
        : module),
    };
    expect(() => normalizeComposition(dangling, request, dependencyResolver)).toThrow(/absent/u);

    const conflict = {
      ...catalogFixture,
      modules: catalogFixture.modules.map((module) => module.id === "diagnostics"
        ? { ...module, conflicts: ["nlp"] }
        : module),
    };
    expect(() => normalizeComposition(conflict, request, dependencyResolver)).toThrow(/conflict/u);

    const invalidVersion = {
      ...catalogFixture,
      modules: catalogFixture.modules.map((module) => module.id === "nlp"
        ? { ...module, version: "latest" }
        : module),
    };
    expect(() => normalizeComposition(invalidVersion, request, dependencyResolver)).toThrow(/semantic version/u);
  });

  it("rejects unknown shared groups and resource totals that overflow safe integers", () => {
    const unknownGroup = {
      ...catalogFixture,
      modules: catalogFixture.modules.map((module) => module.id === "nlp"
        ? { ...module, sharedResourceGroupIds: ["missing-pool"] }
        : module),
    };
    expect(() => normalizeComposition(unknownGroup, request, dependencyResolver)).toThrow(/shared resource group/u);

    const overflow = {
      ...catalogFixture,
      baseResources: { ...catalogFixture.baseResources, cpuMilli: Number.MAX_SAFE_INTEGER },
    };
    expect(() => normalizeComposition(overflow, request, dependencyResolver)).toThrow(/safe integer/u);
  });
});
