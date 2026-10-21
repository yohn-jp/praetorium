import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sourceProofDigest } from "@praetorium/contracts";
import { expect, it } from "vitest";
import provenance from "../vendor/provenance.json" with { type: "json" };
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

it("fails closed for producer revisions without a statically approved bundle", () => {
  expect(() => createScriptoriumCatalogResolverRegistry().resolve(
    "1111111111111111111111111111111111111111",
  )).toThrow(/No approved Scriptorium resolver/u);
});
