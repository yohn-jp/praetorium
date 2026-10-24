import { describe, expect, it } from "vitest";
import { BuildCatalogSchema } from "./producer.js";

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const catalog = {
  contractVersion: "scriptorium-build/v1",
  producerRevision: "a".repeat(40),
  runtimeBaseDigest: digest("1"),
  buildKitDigest: digest("2"),
  recipeDigest: digest("3"),
  lockDigest: digest("4"),
  sourceDigest: digest("5"),
  supportedPlatforms: ["linux/amd64"],
  modules: [],
  baseResources: { cpuMilli: 250, memoryMiB: 256, ephemeralStorageMiB: 512 },
  sharedResourceGroups: [],
  resourceProfiles: [],
};
const module = {
  id: "mcp",
  version: "1.0.0",
  artifactDigest: digest("6"),
  requires: [],
  conflicts: [],
  contractRange: "^1",
  exclusiveResources: { cpuMilli: 0, memoryMiB: 0, ephemeralStorageMiB: 0 },
  sharedResourceGroupIds: [],
  workerLimits: {},
};

describe("BuildCatalog module display metadata", () => {
  it("continues to accept historical catalogs without names or descriptions", () => {
    expect(BuildCatalogSchema.parse({ ...catalog, modules: [module] }).modules[0]).toMatchObject(module);
  });

  it("accepts bounded catalog-supplied names and descriptions", () => {
    const metadata = { name: "MCP connections", description: "Connect an authorized MCP client." };
    expect(BuildCatalogSchema.parse({ ...catalog, modules: [{ ...module, ...metadata }] }).modules[0])
      .toMatchObject({ ...module, ...metadata });
    expect(BuildCatalogSchema.safeParse({
      ...catalog,
      modules: [{ ...module, ...metadata, description: "x".repeat(513) }],
    }).success).toBe(false);
  });
});
