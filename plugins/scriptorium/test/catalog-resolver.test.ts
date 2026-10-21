import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sourceProofDigest } from "@praetorium/contracts";
import { expect, it } from "vitest";
import provenance from "../vendor/provenance.json" with { type: "json" };
import provenanceV021 from "../vendor/provenance-3189a85bfa28ddd160600a0188ab3ccfa91755e4.json" with { type: "json" };
import { createScriptoriumCatalogResolverRegistry } from "../src/catalog-resolver.js";

it("pins the legacy resolver entry to the exact clean-source bundle and provenance", async () => {
  expect(provenance.sourceTreeClean).toBe(true);
  expect(provenance.bundlePath).toBe("build-catalog.mjs");
  expect(provenance.declarationPath).toBe("build-catalog.d.mts");
  for (const [filename, digest] of [
    [provenance.bundlePath, provenance.bundleDigest],
    [provenance.declarationPath, provenance.declarationDigest],
  ]) {
    const bytes = await readFile(new URL(`../vendor/${filename}`, import.meta.url));
    expect(`sha256:${createHash("sha256").update(bytes).digest("hex")}`).toBe(digest);
  }
  const entry = createScriptoriumCatalogResolverRegistry().resolve(provenance.producerRevision);
  expect(entry.descriptor).toEqual({
    producerRevision: "008d5c429ec279a424cafd5b8c4cbee70a613b8e",
    resolverRevision: "sha256:2982c0d9595168b73b021da3229b30e7c4dd699ed86b6a728060f77cb3c2ea18",
    contractVersion: "scriptorium-build/v1",
    provenanceDigest: "sha256:c81b71fff985aaf542d8fd6e2d76c0740ff9390f53f642d00da2fc6bd975db88",
  });
  expect(provenance.producerRevision).toBe(entry.descriptor.producerRevision);
  expect(provenance.bundleDigest).toBe(entry.descriptor.resolverRevision);
  expect(await sourceProofDigest(provenance)).toBe(entry.descriptor.provenanceDigest);
  expect(entry.resolver.producerRevision).toBe(entry.descriptor.producerRevision);
  expect(entry.resolver.resolverRevision).toBe(entry.descriptor.resolverRevision);
  expect(entry.resolver.contractVersion).toBe(entry.descriptor.contractVersion);
  expect(() => createScriptoriumCatalogResolverRegistry().resolve(
    entry.descriptor.producerRevision,
    "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  )).toThrow(/does not match/u);
});

it("pins v0.2.1 to the exact clean-source provenance and revision-bound static resolver", async () => {
  const provenanceBytes = await readFile(new URL(
    "../vendor/provenance-3189a85bfa28ddd160600a0188ab3ccfa91755e4.json", import.meta.url,
  ));
  expect(`sha256:${createHash("sha256").update(provenanceBytes).digest("hex")}`)
    .toBe("sha256:26993976c30fcfb0eb30629c61e6262da345c55dcace23a987b53ad8331156ba");
  expect(provenanceV021.sourceTreeClean).toBe(true);
  expect(provenanceV021.producerRevision).toBe("3189a85bfa28ddd160600a0188ab3ccfa91755e4");
  expect(provenanceV021.bundlePath).toBe("build-catalog.mjs");
  expect(provenanceV021.declarationPath).toBe("build-catalog.d.mts");
  for (const [filename, digest] of [
    [provenanceV021.bundlePath, provenanceV021.bundleDigest],
    [provenanceV021.declarationPath, provenanceV021.declarationDigest],
  ]) {
    const bytes = await readFile(new URL(`../vendor/${filename}`, import.meta.url));
    expect(`sha256:${createHash("sha256").update(bytes).digest("hex")}`).toBe(digest);
  }
  const registry = createScriptoriumCatalogResolverRegistry();
  const entry = registry.resolve(provenanceV021.producerRevision, provenanceV021.bundleDigest);
  const legacy = registry.resolve(provenance.producerRevision);
  expect(entry.descriptor).toEqual({
    producerRevision: "3189a85bfa28ddd160600a0188ab3ccfa91755e4",
    resolverRevision: "sha256:2982c0d9595168b73b021da3229b30e7c4dd699ed86b6a728060f77cb3c2ea18",
    contractVersion: "scriptorium-build/v1",
    provenanceDigest: "sha256:46dc7f209c1a074b5acdeb8a7111006cfb20e3c40f219bc3edbe910be2209cac",
  });
  expect(await sourceProofDigest(provenanceV021)).toBe(entry.descriptor.provenanceDigest);
  expect(provenanceV021.bundleDigest).toBe(entry.descriptor.resolverRevision);
  expect(legacy.descriptor.producerRevision).not.toBe(entry.descriptor.producerRevision);
  expect(legacy.descriptor.resolverRevision).toBe(entry.descriptor.resolverRevision);
  expect(legacy.descriptor.provenanceDigest).not.toBe(entry.descriptor.provenanceDigest);
  expect(() => registry.resolve(entry.descriptor.producerRevision,
    "sha256:0000000000000000000000000000000000000000000000000000000000000000")).toThrow(/does not match/u);
});

it("fails closed for producer revisions without a statically approved bundle", () => {
  expect(() => createScriptoriumCatalogResolverRegistry().resolve(
    "1111111111111111111111111111111111111111",
  )).toThrow(/No approved Scriptorium resolver/u);
});
