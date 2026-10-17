import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CompositionManifest } from "@praetorium/contracts";
import { verifyBrowserArtifacts } from "../src/composition-artifacts.js";

const roots: string[] = [];
const signal = new AbortController().signal;
const hash = (value: string): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("hosted browser artifact verification", () => {
  it("binds the browser registry, Vite graph, selected modules, and every emitted JS/CSS byte", async () => {
    const fixture = await makeBrowserImage(["story"]);
    await expect(verifyBrowserArtifacts(fixture.imageRoot, fixture.manifest, fixture.report, signal)).resolves.toEqual(["story"]);
  });

  it("rejects emitted JavaScript that is not reachable from the selected application entry", async () => {
    const fixture = await makeBrowserImage(["story"]);
    await mkdir(path.join(fixture.imageRoot, "app/app/dist/assets"), { recursive: true });
    await writeFile(path.join(fixture.imageRoot, "app/app/dist/assets/unselected.js"), "unselected module chunk");

    await expect(verifyBrowserArtifacts(fixture.imageRoot, fixture.manifest, fixture.report, signal)).rejects.toThrow(/unlisted JavaScript or CSS/u);
  });

  it("rejects an orphan module stylesheet in the Vite manifest", async () => {
    const fixture = await makeBrowserImage(["story"]);
    const dist = path.join(fixture.imageRoot, "app/app/dist");
    const manifestPath = path.join(dist, ".vite/manifest.json");
    const manifestValue = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifestValue["../modules/unselected/dist/browser.css"] = { file: "assets/unselected.css" };
    await mkdir(path.join(dist, "assets"), { recursive: true });
    await Promise.all([
      writeFile(manifestPath, JSON.stringify(manifestValue)),
      writeFile(path.join(dist, "assets/unselected.css"), "unselected module styles"),
    ]);

    await expect(verifyBrowserArtifacts(fixture.imageRoot, fixture.manifest, fixture.report, signal)).rejects.toThrow(/outside the selected browser closure/u);
  });

  it("accepts a browser registry without optional modules while checking the complete core output", async () => {
    const fixture = await makeBrowserImage([]);
    await expect(verifyBrowserArtifacts(fixture.imageRoot, fixture.manifest, fixture.report, signal)).resolves.toEqual([]);
  });
});

async function makeBrowserImage(moduleIds: readonly string[]): Promise<{
  imageRoot: string;
  manifest: CompositionManifest;
  report: {
    readonly browserBundleDigest: string;
    readonly browserFiles: readonly { readonly path: string; readonly digest: string }[];
    readonly browserRegistryPath: string;
    readonly browserManifestPath: string;
  };
}> {
  const root = await mkdtemp(path.join(tmpdir(), "praetorium-browser-artifacts-test-"));
  roots.push(root);
  const imageRoot = path.join(root, "image");
  const dist = path.join(imageRoot, "app/app/dist");
  const registryPath = path.join(imageRoot, "app/generated/browser.mjs");
  await mkdir(dist, { recursive: true });
  await mkdir(path.dirname(registryPath), { recursive: true });
  const registry = [
    'export const profile = "hosted";',
    "export const moduleBrowserLoaders = Object.freeze({",
    ...[...moduleIds].sort().map((id) => [
      `  ${JSON.stringify(id)}: async () => {`,
      `    const module = await import(${JSON.stringify(`@scriptorium/module-${id}/browser`)});`,
      `    if (!module.browserModule) throw new TypeError(${JSON.stringify(`@scriptorium/module-${id}/browser must export browserModule`)});`,
      "    return module.browserModule;",
      "  },",
    ].join("\n")),
    "});",
    "",
  ].join("\n");
  const javascript = "application entry";
  const stylesheet = "application styles";
  const dynamicJavascript = "selected module entry";
  const expectedDynamic = [...moduleIds].sort().map((id) => `../modules/${id}/dist/browser.js`);
  const manifestValue: Record<string, unknown> = {
    "index.html": {
      file: "main.js",
      isEntry: true,
      dynamicImports: expectedDynamic,
      css: ["styles.css"],
    },
    "style.css": { file: "styles.css", src: "style.css" },
  };
  if (moduleIds.includes("story")) {
    manifestValue["../modules/story/dist/browser.js"] = {
      file: "assets/browser-story.js",
      src: "../modules/story/dist/browser.js",
      isDynamicEntry: true,
    };
  }
  if (moduleIds.some((id) => id !== "story")) throw new Error("browser test fixture only handles the story dynamic entry");
  const browserFiles = [
    { path: "/app/app/dist/main.js", content: javascript },
    { path: "/app/app/dist/styles.css", content: stylesheet },
    ...(moduleIds.includes("story") ? [{ path: "/app/app/dist/assets/browser-story.js", content: dynamicJavascript }] : []),
  ].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (moduleIds.includes("story")) await mkdir(path.join(dist, "assets"), { recursive: true });
  await Promise.all([
    writeFile(registryPath, registry),
    writeFile(path.join(dist, "main.js"), javascript),
    writeFile(path.join(dist, "styles.css"), stylesheet),
    ...(moduleIds.includes("story") ? [
      writeFile(path.join(dist, "assets/browser-story.js"), dynamicJavascript),
    ] : []),
  ]);
  const viteManifest = path.join(dist, ".vite/manifest.json");
  await mkdir(path.dirname(viteManifest), { recursive: true });
  await writeFile(viteManifest, JSON.stringify(manifestValue));
  const manifest: CompositionManifest = {
    schemaVersion: "scriptorium-composition/v1",
    buildInput: {
      contractVersion: "scriptorium-build/v1",
      producerRevision: "a".repeat(40),
      runtimeBaseDigest: `sha256:${"1".repeat(64)}`,
      buildKitDigest: `sha256:${"2".repeat(64)}`,
      recipeDigest: `sha256:${"3".repeat(64)}`,
      sourceDigest: `sha256:${"4".repeat(64)}`,
      lockDigest: `sha256:${"5".repeat(64)}`,
      requestedModules: [],
      resolvedModules: [],
      platform: "linux/amd64",
      options: {},
    },
    buildKey: `sha256:${"6".repeat(64)}`,
    producerRevision: "a".repeat(40),
    platform: "linux/amd64",
    resolvedModules: [],
    server: { entry: "app/launch.mjs", moduleIds: [] },
    browser: { entry: "app/app/dist/main.js", moduleIds: [...moduleIds] },
    nativeDependencies: [],
    smoke: { id: "health", healthPath: "/health/ready", timeoutSeconds: 5 },
  };
  return {
    imageRoot,
    manifest,
    report: {
      browserBundleDigest: hash(javascript),
      browserFiles: browserFiles.map(({ path: file, content }) => ({ path: file, digest: hash(content) })),
      browserRegistryPath: "/app/generated/browser.mjs",
      browserManifestPath: "/app/app/dist/.vite/manifest.json",
    },
  };
}
