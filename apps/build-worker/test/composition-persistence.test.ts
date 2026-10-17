import { describe, expect, it } from "vitest";
import {
  createScriptoriumCatalogResolver,
  scriptoriumCompositionPersistence,
} from "@praetorium/scriptorium";
import {
  buildKey,
  type BuildInput,
  type CompositionManifest,
  type PersistenceCompatibility,
} from "@praetorium/contracts";
import { verifyHostedPersistence } from "../src/composition-artifacts.js";

const producerRevision = createScriptoriumCatalogResolver().producerRevision;

describe("hosted composition persistence verification", () => {
  it("accepts the producer-owned exact declaration for a selected story module", async () => {
    const persistence = scriptoriumCompositionPersistence(producerRevision, ["story"]);
    const base = scriptoriumCompositionPersistence(producerRevision, []);
    const manifest = await awaitManifest(["story"], persistence);
    expect(moduleOwnedReadable(persistence, base, "story").length).toBeGreaterThan(0);
    expect(moduleOwnedWritable(persistence, base, "story").length).toBeGreaterThan(0);

    expect(() => verifyHostedPersistence(manifest)).not.toThrow();
  });

  it("rejects a missing module-owned format", async () => {
    const expected = scriptoriumCompositionPersistence(producerRevision, ["story"]);
    const base = scriptoriumCompositionPersistence(producerRevision, []);
    const missing = moduleOwnedReadable(expected, base, "story")[0];
    if (!missing) throw new Error("trusted story composition has no module-owned readable format");
    const persistence: PersistenceCompatibility = {
      ...expected,
      readable: expected.readable.filter(({ formatId }) => formatId !== missing.formatId),
      writable: expected.writable.filter(({ formatId }) => formatId !== missing.formatId),
    };
    const manifest = await awaitManifest(["story"], persistence);

    expect(() => verifyHostedPersistence(manifest)).toThrow(/pinned Scriptorium module set/u);
  });

  it("rejects an extra format outside the selected module set", async () => {
    const expected = scriptoriumCompositionPersistence(producerRevision, ["story"]);
    const persistence: PersistenceCompatibility = {
      ...expected,
      readable: [
        ...expected.readable,
        { formatId: "scriptorium.module-unselected.test", versions: [1] },
      ],
    };
    const manifest = await awaitManifest(["story"], persistence);

    expect(() => verifyHostedPersistence(manifest)).toThrow(/pinned Scriptorium module set/u);
  });

  it("rejects an incorrect version for a selected module-owned format", async () => {
    const expected = scriptoriumCompositionPersistence(producerRevision, ["story"]);
    const base = scriptoriumCompositionPersistence(producerRevision, []);
    const moduleWritable = moduleOwnedWritable(expected, base, "story")[0];
    if (!moduleWritable)
      throw new Error("trusted story composition has no module-owned writable format");
    const wrongVersion = moduleWritable.version + 1;
    const persistence: PersistenceCompatibility = {
      ...expected,
      readable: expected.readable.map((entry) =>
        entry.formatId === moduleWritable.formatId
          ? {
              ...entry,
              versions: entry.versions.map((version) =>
                version === moduleWritable.version ? wrongVersion : version,
              ),
            }
          : entry,
      ),
      writable: expected.writable.map((entry) =>
        entry.formatId === moduleWritable.formatId ? { ...entry, version: wrongVersion } : entry,
      ),
    };
    const manifest = await awaitManifest(["story"], persistence);

    expect(() => verifyHostedPersistence(manifest)).toThrow(/pinned Scriptorium module set/u);
  });
});

async function awaitManifest(
  moduleIds: readonly string[],
  persistence: PersistenceCompatibility,
): Promise<CompositionManifest> {
  const resolvedModules = moduleIds.map((id) => ({
    id,
    version: "0.1.0",
    artifactDigest: `sha256:${"7".repeat(64)}`,
  }));
  const buildInput: BuildInput = {
    contractVersion: "scriptorium-build/v1",
    producerRevision,
    runtimeBaseDigest: `sha256:${"1".repeat(64)}`,
    buildKitDigest: `sha256:${"2".repeat(64)}`,
    recipeDigest: `sha256:${"3".repeat(64)}`,
    sourceDigest: `sha256:${"4".repeat(64)}`,
    lockDigest: `sha256:${"5".repeat(64)}`,
    requestedModules: [...moduleIds],
    resolvedModules,
    platform: "linux/amd64",
    options: {},
  };
  return {
    schemaVersion: "scriptorium-composition/v1",
    buildInput,
    buildKey: await buildKey(buildInput),
    producerRevision,
    platform: buildInput.platform,
    resolvedModules,
    server: { entry: "app/launch.mjs", moduleIds: [...moduleIds] },
    browser: { entry: "app/app/dist/main.js", moduleIds: [...moduleIds] },
    nativeDependencies: [],
    smoke: { id: "health", healthPath: "/health/ready", timeoutSeconds: 5 },
    persistence,
  };
}

function moduleOwnedReadable(
  selected: PersistenceCompatibility,
  baseline: PersistenceCompatibility,
  moduleId: string,
): PersistenceCompatibility["readable"] {
  const baselineFormats = new Set(baseline.readable.map(({ formatId }) => formatId));
  return selected.readable.filter(
    ({ formatId }) =>
      formatId.startsWith(`scriptorium.module-${moduleId}.`) && !baselineFormats.has(formatId),
  );
}

function moduleOwnedWritable(
  selected: PersistenceCompatibility,
  baseline: PersistenceCompatibility,
  moduleId: string,
): PersistenceCompatibility["writable"] {
  const baselineFormats = new Set(baseline.writable.map(({ formatId }) => formatId));
  return selected.writable.filter(
    ({ formatId }) =>
      formatId.startsWith(`scriptorium.module-${moduleId}.`) && !baselineFormats.has(formatId),
  );
}
