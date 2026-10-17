import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import provenance from "../vendor/provenance.json" with { type: "json" };
import { createScriptoriumCatalogResolver } from "../src/catalog-resolver.js";

it("uses the exact producer resolver emitted from the recorded clean source", async () => {
  for (const [filename, digest] of [
    [provenance.bundlePath, provenance.bundleDigest],
    [provenance.declarationPath, provenance.declarationDigest],
  ]) {
    const bytes = await readFile(new URL(`../vendor/${filename}`, import.meta.url));
    expect(`sha256:${createHash("sha256").update(bytes).digest("hex")}`).toBe(digest);
  }
  const resolver = createScriptoriumCatalogResolver();
  expect(resolver.producerRevision).toBe(provenance.producerRevision);
  expect(resolver.contractVersion).toBe("scriptorium-build/v1");
});
