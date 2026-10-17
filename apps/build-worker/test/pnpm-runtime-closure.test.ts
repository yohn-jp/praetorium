import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyRuntimePackageClosure, type RuntimePackageRecord } from "../src/pnpm-runtime-closure.js";

const roots: string[] = [];
const digest = (bytes: Uint8Array): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("runtime package closure verification", () => {
  it("recomputes the selected dependency graph and binds packages to the source pnpm lock", async () => {
    const fixture = await makeRuntimeImage();
    const result = await verifyRuntimePackageClosure(fixture.request);

    expect(result).toEqual(fixture.request.runtimePackages);
  });

  it("ignores orphan optional peer metadata from the MCP debug runtime package", async () => {
    const fixture = await makeRuntimeImage();

    expect(await verifyRuntimePackageClosure(fixture.request)).toEqual(fixture.request.runtimePackages);
  });

  it("does not turn an orphan peer metadata key into a runtime dependency edge", async () => {
    const fixture = await makeRuntimeImage();
    const nodeModules = path.join(fixture.imageRoot, "app/node_modules");
    const supportsColor = path.join(nodeModules, ".pnpm/supports-color@1.0.0/node_modules/supports-color");
    const debug = path.join(nodeModules, ".pnpm/debug@4.4.3/node_modules/debug");
    await writePackage(supportsColor, { name: "supports-color", version: "1.0.0" });
    await mkdir(path.join(debug, "node_modules"), { recursive: true });
    await symlink(supportsColor, path.join(debug, "node_modules/supports-color"), "dir");

    await expect(verifyRuntimePackageClosure(fixture.request))
      .rejects.toThrow(/pnpm store contains runtime packages outside the selected production dependency closure/u);
  });

  it("keeps a declared peer required when an unrelated peer metadata key is optional", async () => {
    const fixture = await makeRuntimeImage();
    const debug = path.join(fixture.imageRoot, "app/node_modules/.pnpm/debug@4.4.3/node_modules/debug");
    await writePackage(debug, {
      name: "debug",
      version: "4.4.3",
      dependencies: { ms: "^2.1.3" },
      peerDependencies: { "required-peer": "^1.0.0" },
      peerDependenciesMeta: { "supports-color": { optional: true } },
    });

    await expect(verifyRuntimePackageClosure(fixture.request))
      .rejects.toThrow(/required runtime dependency is missing: required-peer/u);
  });

  it("rejects unselected packages left in the physical pnpm store", async () => {
    const fixture = await makeRuntimeImage();
    const excluded = path.join(fixture.imageRoot, "app/node_modules/.pnpm/onnxruntime-node@1.0.0/node_modules/onnxruntime-node");
    await mkdir(path.join(excluded, "bin"), { recursive: true });
    await writeFile(path.join(excluded, "package.json"), JSON.stringify({ name: "onnxruntime-node", version: "1.0.0" }));
    await writeFile(path.join(excluded, "bin", "addon.node"), "unselected native dependency");

    await expect(verifyRuntimePackageClosure(fixture.request)).rejects.toThrow(/outside the selected production dependency closure/u);
  });

  it("rejects runtime package paths that escape the exported image rootfs", async () => {
    const fixture = await makeRuntimeImage();
    const outside = path.join(fixture.root, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "package.json"), JSON.stringify({ name: "@scriptorium/api", version: "1.0.0" }));
    await rm(path.join(fixture.imageRoot, "app/node_modules/@scriptorium/api"));
    await symlink(outside, path.join(fixture.imageRoot, "app/node_modules/@scriptorium/api"));

    await expect(verifyRuntimePackageClosure(fixture.request)).rejects.toThrow(/escapes the exported image rootfs/u);
  });
});

async function makeRuntimeImage(): Promise<{
  root: string;
  imageRoot: string;
  request: {
    readonly imageRoot: string;
    readonly selectedModuleIds: readonly string[];
    readonly expectedLockDigest: string;
    readonly runtimePackages: readonly RuntimePackageRecord[];
    readonly signal: AbortSignal;
  };
}> {
  const root = await mkdtemp(path.join(tmpdir(), "praetorium-runtime-closure-test-"));
  roots.push(root);
  const imageRoot = path.join(root, "image");
  const nodeModules = path.join(imageRoot, "app/node_modules");
  const api = path.join(nodeModules, ".pnpm/file+packages+api@workspace/node_modules/@scriptorium/api");
  const core = path.join(nodeModules, ".pnpm/file+packages+core@workspace/node_modules/@scriptorium/core");
  const debug = path.join(nodeModules, ".pnpm/debug@4.4.3/node_modules/debug");
  const ms = path.join(nodeModules, ".pnpm/ms@2.1.3/node_modules/ms");
  await Promise.all([
    mkdir(api, { recursive: true }),
    mkdir(core, { recursive: true }),
    mkdir(debug, { recursive: true }),
    mkdir(ms, { recursive: true }),
    mkdir(path.join(nodeModules, "@scriptorium"), { recursive: true }),
    mkdir(path.join(api, "node_modules/@scriptorium"), { recursive: true }),
    mkdir(path.join(api, "node_modules"), { recursive: true }),
    mkdir(path.join(debug, "node_modules"), { recursive: true }),
  ]);
  await Promise.all([
    writePackage(api, { name: "@scriptorium/api", version: "0.1.0", dependencies: { "@scriptorium/core": "workspace:*", debug: "^4.4.3" } }),
    writePackage(core, { name: "@scriptorium/core", version: "0.1.0" }),
    writePackage(debug, {
      name: "debug",
      version: "4.4.3",
      dependencies: { ms: "^2.1.3" },
      peerDependenciesMeta: { "supports-color": { optional: true } },
    }),
    writePackage(ms, { name: "ms", version: "2.1.3" }),
    symlink(api, path.join(nodeModules, "@scriptorium/api")),
    symlink(core, path.join(api, "node_modules/@scriptorium/core"), "dir"),
    symlink(debug, path.join(api, "node_modules/debug"), "dir"),
    symlink(ms, path.join(debug, "node_modules/ms"), "dir"),
  ]);
  const lockBytes = Buffer.from([
    "---\n",
    "lockfileVersion: '9.0'\n",
    "importers:\n",
    "  .: {}\n",
    "packages: {}\n",
    "snapshots: {}\n",
    "---\n",
    "lockfileVersion: '9.0'\n",
    "importers:\n",
    "  packages/api: {}\n",
    "  packages/core: {}\n",
    "packages:\n",
    "  debug@4.4.3:\n",
    "    resolution: {integrity: sha512-AbCd==}\n",
    "  ms@2.1.3:\n",
    "    resolution: {integrity: sha512-XyZ==}\n",
    "snapshots:\n",
    "  debug@4.4.3:\n",
    "    dependencies:\n",
    "      ms: 2.1.3\n",
    "  ms@2.1.3: {}\n",
  ].join(""));
  const lockPath = path.join(imageRoot, "usr/share/scriptorium/pnpm-lock.yaml");
  await mkdir(path.dirname(lockPath), { recursive: true });
  await writeFile(lockPath, lockBytes);
  const runtimePackages: RuntimePackageRecord[] = [
    {
      name: "@scriptorium/api",
      version: "0.1.0",
      packagePath: "/app/node_modules/.pnpm/file+packages+api@workspace/node_modules/@scriptorium/api",
      lockIdentity: "workspace:packages/api",
      lockIntegrity: null,
    },
    {
      name: "@scriptorium/core",
      version: "0.1.0",
      packagePath: "/app/node_modules/.pnpm/file+packages+core@workspace/node_modules/@scriptorium/core",
      lockIdentity: "workspace:packages/core",
      lockIntegrity: null,
    },
    {
      name: "debug",
      version: "4.4.3",
      packagePath: "/app/node_modules/.pnpm/debug@4.4.3/node_modules/debug",
      lockIdentity: "debug@4.4.3",
      lockIntegrity: "sha512-AbCd==",
    },
    {
      name: "ms",
      version: "2.1.3",
      packagePath: "/app/node_modules/.pnpm/ms@2.1.3/node_modules/ms",
      lockIdentity: "ms@2.1.3",
      lockIntegrity: "sha512-XyZ==",
    },
  ].sort((left, right) => left.packagePath < right.packagePath ? -1 : left.packagePath > right.packagePath ? 1 : 0);
  return {
    root,
    imageRoot,
    request: {
      imageRoot,
      selectedModuleIds: [],
      expectedLockDigest: digest(lockBytes),
      runtimePackages,
      signal: new AbortController().signal,
    },
  };
}

async function writePackage(directory: string, value: unknown): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "package.json"), JSON.stringify(value));
}
