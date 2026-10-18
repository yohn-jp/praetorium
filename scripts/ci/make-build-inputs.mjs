#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const source = process.env.SCRIPTORIUM_ROOT;
const catalogPath = process.env.CATALOG_PATH;
const outputDirectory = process.env.BUILD_INPUT_OUTPUT_DIR;
if (!source || !catalogPath || !outputDirectory)
  throw new Error("SCRIPTORIUM_ROOT, CATALOG_PATH and BUILD_INPUT_OUTPUT_DIR are required");

const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: source,
  encoding: "utf8",
}).trim();
const status = execFileSync("git", ["status", "--porcelain"], { cwd: source, encoding: "utf8" });
const { canonicalJson, trustedModuleData } = await import(
  pathToFileURL(path.join(source, "scripts/hosted-build.mjs"))
);
const { resolveBuildCatalogSelection } = await import(
  pathToFileURL(path.join(source, "packages/module-runtime/dist/index.js"))
);
if (
  typeof canonicalJson !== "function" ||
  typeof trustedModuleData !== "function" ||
  typeof resolveBuildCatalogSelection !== "function"
)
  throw new Error("Producer build-input dependencies are missing");

const catalogBytes = await readFile(catalogPath);
const catalogText = catalogBytes.toString("utf8");
const catalog = JSON.parse(catalogText);
if (canonicalJson(catalog) !== catalogText) throw new Error("Catalog is not canonical JSON");
if (catalog.producerRevision !== revision || status !== "")
  throw new Error("Catalog does not describe the clean checked-out producer HEAD");
const trusted = await trustedModuleData();
const selections = [
  { name: "core", requested: [] },
  { name: "story", requested: ["story"] },
];
await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
const result = [];
for (const item of selections) {
  const resolved = resolveBuildCatalogSelection(catalog, item.requested, trusted);
  const input = {
    contractVersion: catalog.contractVersion,
    producerRevision: catalog.producerRevision,
    runtimeBaseDigest: catalog.runtimeBaseDigest,
    buildKitDigest: catalog.buildKitDigest,
    recipeDigest: catalog.recipeDigest,
    sourceDigest: catalog.sourceDigest,
    lockDigest: catalog.lockDigest,
    requestedModules: resolved.requestedModules,
    resolvedModules: resolved.resolvedModules,
    platform: "linux/amd64",
    options: {},
  };
  const encoded = Buffer.from(JSON.stringify(input), "utf8").toString("base64url");
  await writeFile(path.join(outputDirectory, item.name + ".input"), encoded, { mode: 0o600 });
  result.push({
    name: item.name,
    requestedModules: input.requestedModules,
    resolvedModules: input.resolvedModules,
    encodedSha256: await (async () => {
      const { createHash } = await import("node:crypto");
      return createHash("sha256").update(encoded).digest("hex");
    })(),
  });
}
await writeFile(
  path.join(outputDirectory, "build-inputs.json"),
  canonicalJson({
    schemaVersion: "praetorium-scriptorium-ci-inputs/v1",
    producerRevision: revision,
    selections: result,
  }),
  { mode: 0o600 },
);
