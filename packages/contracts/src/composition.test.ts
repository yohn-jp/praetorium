import { expect, it } from "vitest";
import { buildKey } from "./build.js";
import { validateCompositionBindings, type CompositionManifest } from "./composition.js";
const digest = `sha256:${"a".repeat(64)}`;
it("binds claimed key and requested modules to actual declared closure", async () => {
  const input = {
    contractVersion: "scriptorium-build/v1" as const,
    producerRevision: "a".repeat(40),
    runtimeBaseDigest: digest,
    buildKitDigest: digest,
    recipeDigest: digest,
    sourceDigest: digest,
    lockDigest: digest,
    requestedModules: ["a"],
    resolvedModules: [{ id: "a", version: "1.0.0", artifactDigest: digest }],
    platform: "linux/amd64" as const,
    options: {},
  };
  const manifest: CompositionManifest = {
    schemaVersion: "scriptorium-composition/v1",
    buildInput: input,
    buildKey: await buildKey(input),
    producerRevision: input.producerRevision,
    platform: input.platform,
    resolvedModules: input.resolvedModules,
    server: { entry: "server/index.js", moduleIds: ["a"] },
    browser: { entry: "browser/index.js", moduleIds: [] },
    nativeDependencies: [],
    smoke: { id: "ready", healthPath: "/ready", timeoutSeconds: 30 },
  };
  expect(await validateCompositionBindings(manifest)).toBe(true);
  expect(
    await validateCompositionBindings({ ...manifest, buildKey: `sha256:${"b".repeat(64)}` }),
  ).toBe(false);
  const omitted = { ...input, requestedModules: ["missing"] };
  expect(
    await validateCompositionBindings({
      ...manifest,
      buildInput: omitted,
      buildKey: await buildKey(omitted),
    }),
  ).toBe(false);
});
