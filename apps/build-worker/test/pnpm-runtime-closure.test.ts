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
  const dependency = path.join(nodeModules, ".pnpm/dep@1.2.3/node_modules/dep");
  await Promise.all([
    mkdir(api, { recursive: true }),
    mkdir(core, { recursive: true }),
    mkdir(dependency, { recursive: true }),
    mkdir(path.join(nodeModules, "@scriptorium"), { recursive: true }),
    mkdir(path.join(api, "node_modules/@scriptorium"), { recursive: true }),
  ]);
  await Promise.all([
    writePackage(api, { name: "@scriptorium/api", version: "0.1.0", dependencies: { "@scriptorium/core": "workspace:*", dep: "^1.2.3" } }),
    writePackage(core, { name: "@scriptorium/core", version: "0.1.0" }),
    writePackage(dependency, { name: "dep", version: "1.2.3" }),
    symlink(api, path.join(nodeModules, "@scriptorium/api")),
    symlink(core, path.join(api, "node_modules/@scriptorium/core"), "dir"),
    symlink(dependency, path.join(api, "node_modules/dep"), "dir"),
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
    "  dep@1.2.3:\n",
    "    resolution: {integrity: sha512-AbCd==}\n",
    "snapshots:\n",
    "  dep@1.2.3: {}\n",
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
      name: "dep",
      version: "1.2.3",
      packagePath: "/app/node_modules/.pnpm/dep@1.2.3/node_modules/dep",
      lockIdentity: "dep@1.2.3",
      lockIntegrity: "sha512-AbCd==",
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
