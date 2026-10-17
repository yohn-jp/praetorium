import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { parseAllDocuments } from "yaml";

const LOCK_PATH = "/usr/share/scriptorium/pnpm-lock.yaml";
const LOCK_MAX_BYTES = 32 * 1024 * 1024;
const MAX_PACKAGES = 20_000;

export type RuntimePackageRecord = {
  readonly name: string;
  readonly version: string;
  readonly packagePath: string;
  readonly lockIdentity: string;
  readonly lockIntegrity: string | null;
};

type PackageMetadata = {
  readonly name: string;
  readonly version: string;
  readonly dependencies: readonly string[];
  readonly peerDependencies: readonly string[];
  readonly optionalPeerDependencies: ReadonlySet<string>;
  readonly optionalDependencies: readonly string[];
};

type PnpmLock = {
  readonly importers: Readonly<Record<string, unknown>>;
  readonly packages: Readonly<Record<string, unknown>>;
  readonly snapshots: Readonly<Record<string, unknown>>;
};

/** Recomputes the runtime package graph and proves the image contains exactly that pnpm closure. */
export async function verifyRuntimePackageClosure(input: {
  readonly imageRoot: string;
  readonly selectedModuleIds: readonly string[];
  readonly expectedLockDigest: string;
  readonly runtimePackages: readonly RuntimePackageRecord[];
  readonly signal: AbortSignal;
}): Promise<readonly RuntimePackageRecord[]> {
  const root = await realpath(input.imageRoot);
  const rootInfo = await stat(root);
  if (!rootInfo.isDirectory()) throw new Error("exported image rootfs is not a directory");
  const lockBytes = await readImageFile(root, LOCK_PATH, LOCK_MAX_BYTES, input.signal);
  const lockDigest = `sha256:${createHash("sha256").update(lockBytes).digest("hex")}`;
  if (lockDigest !== input.expectedLockDigest) throw new Error("embedded pnpm lockfile differs from the immutable build input");
  const lock = parsePnpmLock(lockBytes);

  const pnpmStorePath = await resolveImageDirectory(root, "/app/node_modules/.pnpm");
  const roots = [
    await resolveImageDirectory(root, "/app/node_modules/@scriptorium/api"),
    ...await Promise.all(input.selectedModuleIds.map((id) => resolveImageDirectory(root, `/app/node_modules/@scriptorium/module-${id}`))),
  ];
  const reachable = new Map<string, PackageMetadata>();
  const pending = [...roots];
  while (pending.length > 0) {
    ensureNotAborted(input.signal);
    const packageRoot = pending.pop()!;
    const canonicalPackageRoot = await realpath(packageRoot);
    if (!isWithin(root, canonicalPackageRoot)) throw new Error("runtime package escapes the exported image rootfs");
    if (reachable.has(canonicalPackageRoot)) continue;
    if (reachable.size >= MAX_PACKAGES) throw new Error("runtime package closure exceeds the inspection bound");
    const metadata = await readPackageMetadata(root, canonicalPackageRoot, input.signal);
    reachable.set(canonicalPackageRoot, metadata);
    const required = [
      ...metadata.dependencies,
      ...metadata.peerDependencies.filter((name) => !metadata.optionalPeerDependencies.has(name)),
    ];
    const optional = [
      ...metadata.optionalDependencies,
      ...metadata.peerDependencies.filter((name) => metadata.optionalPeerDependencies.has(name)),
    ];
    for (const dependency of required) {
      const resolved = await resolveImageDependency(root, canonicalPackageRoot, dependency);
      if (!resolved) throw new Error(`required runtime dependency is missing: ${dependency}`);
      pending.push(resolved);
    }
    for (const dependency of optional) {
      const resolved = await resolveImageDependency(root, canonicalPackageRoot, dependency, true);
      if (resolved) pending.push(resolved);
    }
  }

  const records = [...reachable.entries()].map(([packageRoot, metadata]) => {
    const packagePath = `/${path.relative(root, packageRoot).split(path.sep).join("/")}`;
    if (!packagePath.startsWith("/app/node_modules/.pnpm/")) {
      throw new Error("runtime dependency is outside the deployed pnpm package store");
    }
    const lockIdentity = lockIdentityFromPackagePath(packagePath, metadata.name, metadata.version);
    const lockIntegrity = validateLockIdentity(lock, lockIdentity, metadata.name, metadata.version);
    return { name: metadata.name, version: metadata.version, packagePath, lockIdentity, lockIntegrity };
  }).sort((left, right) => compareText(left.packagePath, right.packagePath));

  assertRuntimePackageRecords(input.runtimePackages, records);
  const physicalPackages = await listPnpmStorePackages(root, pnpmStorePath, input.signal);
  const reachablePaths = new Set(records.map(({ packagePath }) => packagePath));
  if (
    physicalPackages.length !== reachablePaths.size ||
    physicalPackages.some((packagePath) => !reachablePaths.has(packagePath))
  ) {
    throw new Error("pnpm store contains runtime packages outside the selected production dependency closure");
  }
  return records;
}

function parsePnpmLock(bytes: Uint8Array): PnpmLock {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const documents = parseAllDocuments(source, { uniqueKeys: true });
  if (documents.some((document) => document.errors.length > 0)) throw new Error("embedded pnpm lockfile is invalid YAML");
  const candidates = [];
  for (const document of documents) {
    const value: unknown = document.toJS();
    if (!isRecord(value) || String(value.lockfileVersion) !== "9.0") continue;
    if (
      isRecord(value.importers) &&
      isRecord(value.packages) &&
      isRecord(value.snapshots) &&
      Object.hasOwn(value.importers, "packages/api")
    ) candidates.push(value);
  }
  if (candidates.length !== 1) throw new Error("embedded pnpm lockfile does not contain one pnpm v9 package graph");
  return candidates[0] as unknown as PnpmLock;
}

function lockIdentityFromPackagePath(packagePath: string, name: string, version: string): string {
  const storeRelative = packagePath.slice("/app/node_modules/.pnpm/".length);
  const separator = storeRelative.indexOf("/");
  if (separator <= 0) throw new Error("runtime package path is not in a pnpm virtual store entry");
  const storeName = storeRelative.slice(0, separator);
  const isKnownWorkspace = workspaceImporter(name);
  if (isKnownWorkspace) return `workspace:${isKnownWorkspace}`;

  const encodedName = name.startsWith("@") ? name.replace("/", "+") : name;
  const base = `${name}@${version}`;
  const storePrefix = `${encodedName}@${version}`;
  if (storeName !== storePrefix && !storeName.startsWith(`${storePrefix}_`)) {
    throw new Error("runtime package pnpm store path differs from its package name and version");
  }
  const peerSuffix = storeName === storePrefix
    ? ""
    : storeName.slice(storePrefix.length + 1).split("_").map((peer) => `(${peer.replaceAll("+", "/")})`).join("");
  return `${base}${peerSuffix}`;
}

function workspaceImporter(name: string): string | undefined {
  if (name === "@scriptorium/api") return "packages/api";
  if (name === "@scriptorium/core") return "packages/core";
  if (name === "@scriptorium/contracts") return "packages/contracts";
  if (name === "@scriptorium/migration") return "packages/migration";
  if (name === "@scriptorium/module-runtime") return "packages/module-runtime";
  const module = /^@scriptorium\/module-([a-z][a-z0-9-]{0,63})$/u.exec(name);
  if (module) return `modules/${module[1]}`;
  return undefined;
}

function validateLockIdentity(lock: PnpmLock, lockIdentity: string, name: string, version: string): string | null {
  if (lockIdentity.startsWith("workspace:")) {
    const importer = lockIdentity.slice("workspace:".length);
    if (workspaceImporter(name) !== importer || !Object.hasOwn(lock.importers, importer)) {
      throw new Error("runtime workspace package does not match its source lockfile importer");
    }
    return null;
  }
  if (!Object.hasOwn(lock.snapshots, lockIdentity)) throw new Error("runtime package snapshot is missing from the source lockfile");
  const base = `${name}@${version}`;
  const packageEntries = Object.entries(lock.packages).filter(([key]) => key === base || key.startsWith(`${base}(`));
  if (packageEntries.length === 0) throw new Error("runtime package resolution is missing from the source lockfile");
  const integrities = new Set(packageEntries.map(([, value]) => {
    if (!isRecord(value)) throw new Error("source lockfile package entry is invalid");
    const resolution = value.resolution;
    if (resolution === undefined) return null;
    if (!isRecord(resolution)) throw new Error("source lockfile package resolution is invalid");
    const integrity = resolution.integrity;
    if (integrity === undefined) return null;
    if (typeof integrity !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(integrity)) {
      throw new Error("source lockfile package integrity is invalid");
    }
    return integrity;
  }));
  if (integrities.size !== 1) throw new Error("source lockfile package integrity is ambiguous");
  return [...integrities][0]!;
}

async function listPnpmStorePackages(root: string, pnpmStorePath: string, signal: AbortSignal): Promise<string[]> {
  const packages: string[] = [];
  for (const storeEntry of await readdir(pnpmStorePath, { withFileTypes: true })) {
    ensureNotAborted(signal);
    if (storeEntry.name === "node_modules") continue;
    if (!storeEntry.isDirectory() || storeEntry.isSymbolicLink()) throw new Error("pnpm virtual store contains an invalid entry");
    const storeDirectory = path.join(pnpmStorePath, storeEntry.name);
    const storeModulesPath = path.join(storeDirectory, "node_modules");
    let storeModulesInfo;
    try { storeModulesInfo = await lstat(storeModulesPath); }
    catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    if (!storeModulesInfo.isDirectory() || storeModulesInfo.isSymbolicLink()) {
      throw new Error("pnpm package store entry has an invalid node_modules directory");
    }
    for (const entry of await readdir(storeModulesPath, { withFileTypes: true })) {
      ensureNotAborted(signal);
      if (entry.name.startsWith(".")) continue;
      const entryPath = path.join(storeModulesPath, entry.name);
      if (entry.name.startsWith("@")) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("pnpm scoped package directory is invalid");
        for (const child of await readdir(entryPath, { withFileTypes: true })) {
          if (!child.isDirectory() || child.isSymbolicLink()) continue;
          await addPackageRoot(path.join(entryPath, child.name));
        }
      } else if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await addPackageRoot(entryPath);
      }
    }
  }
  const result = packages.sort(compareText);
  if (new Set(result).size !== result.length) throw new Error("pnpm store contains duplicate package paths");
  return result;

  async function addPackageRoot(packageDirectory: string): Promise<void> {
    const manifestPath = path.join(packageDirectory, "package.json");
    let info;
    try { info = await lstat(manifestPath); }
    catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink()) return;
    const packageRoot = await realpath(packageDirectory);
    if (!isWithin(root, packageRoot) || !isWithin(pnpmStorePath, packageRoot)) {
      throw new Error("pnpm store package escapes the exported image rootfs");
    }
    packages.push(`/${path.relative(root, packageRoot).split(path.sep).join("/")}`);
  }
}

async function resolveImageDependency(root: string, fromPackageRoot: string, name: string, optional = false): Promise<string | null> {
  if (!/^(?:@[^/]+\/)?[^/]+$/u.test(name) || name.startsWith(".") || name.includes("\\")) {
    throw new Error("runtime package dependency name is invalid");
  }
  let directory = fromPackageRoot;
  while (true) {
    const candidate = path.join(directory, "node_modules", name);
    try {
      const resolved = await realpath(candidate);
      if (!isWithin(root, resolved)) throw new Error("runtime dependency symlink escapes the exported image rootfs");
      const info = await stat(resolved);
      if (!info.isDirectory()) throw new Error("runtime dependency does not resolve to a package directory");
      return resolved;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      if (optional) return null;
      throw new Error(`required runtime dependency is missing: ${name}`);
    }
    directory = parent;
  }
}

async function resolveImageDirectory(root: string, absolutePath: string): Promise<string> {
  const candidate = imagePath(root, absolutePath);
  const resolved = await realpath(candidate);
  if (!isWithin(root, resolved)) throw new Error("runtime package directory escapes the exported image rootfs");
  const info = await stat(resolved);
  if (!info.isDirectory()) throw new Error("runtime package path is not a directory");
  return resolved;
}

async function readPackageMetadata(root: string, packageRoot: string, signal: AbortSignal): Promise<PackageMetadata> {
  const bytes = await readImageFile(root, `${imagePathRelative(root, packageRoot)}/package.json`, 1024 * 1024, signal);
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.version !== "string") {
    throw new Error("runtime package manifest has no immutable name and version");
  }
  const dependencies = dependencyNames(value.dependencies, "dependencies");
  const peerDependencies = dependencyNames(value.peerDependencies, "peerDependencies");
  const optionalDependencies = dependencyNames(value.optionalDependencies, "optionalDependencies");
  const meta = value.peerDependenciesMeta === undefined ? {} : value.peerDependenciesMeta;
  if (!isRecord(meta)) throw new Error("runtime package peer dependency metadata is invalid");
  const optionalPeerDependencies = new Set<string>();
  for (const [name, details] of Object.entries(meta)) {
    if (!peerDependencies.includes(name) || !isRecord(details) || (details.optional !== undefined && typeof details.optional !== "boolean")) {
      throw new Error("runtime package peer dependency metadata is inconsistent");
    }
    if (details.optional === true) optionalPeerDependencies.add(name);
  }
  return { name: value.name, version: value.version, dependencies, peerDependencies, optionalPeerDependencies, optionalDependencies };
}

function dependencyNames(value: unknown, key: string): string[] {
  if (value === undefined) return [];
  if (!isRecord(value) || Object.keys(value).some((name) => !/^(?:@[^/]+\/)?[^/]+$/u.test(name))) {
    throw new Error(`runtime package ${key} declaration is invalid`);
  }
  return Object.keys(value);
}

function assertRuntimePackageRecords(actual: readonly RuntimePackageRecord[], expected: readonly RuntimePackageRecord[]): void {
  for (const record of actual) {
    if (
      !isRecord(record) ||
      Object.keys(record).sort().join(",") !== "lockIdentity,lockIntegrity,name,packagePath,version" ||
      typeof record.name !== "string" || typeof record.version !== "string" ||
      typeof record.packagePath !== "string" || typeof record.lockIdentity !== "string" ||
      (record.lockIntegrity !== null && typeof record.lockIntegrity !== "string")
    ) throw new Error("runtime package report entry is invalid");
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("runtime package report differs from the installed dependency closure or source lockfile");
  }
}

async function readImageFile(root: string, absolutePath: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  ensureNotAborted(signal);
  const filename = imagePath(root, absolutePath);
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maxBytes) {
    throw new Error("runtime package artifact is missing or outside the configured size bound");
  }
  const target = await realpath(filename);
  if (!isWithin(root, target)) throw new Error("runtime package artifact escapes the exported image rootfs");
  const targetInfo = await stat(target);
  if (!targetInfo.isFile() || targetInfo.size < 1 || targetInfo.size > maxBytes) {
    throw new Error("runtime package artifact is missing or outside the configured size bound");
  }
  return readFile(target, { signal });
}

function imagePath(root: string, absolutePath: string): string {
  if (!path.isAbsolute(absolutePath) || absolutePath.includes("\0")) throw new Error("image path is invalid");
  const target = path.resolve(root, `.${absolutePath}`);
  if (!isWithin(root, target)) throw new Error("image path escapes the exported rootfs");
  return target;
}

function imagePathRelative(root: string, absolutePath: string): string {
  const relative = path.relative(root, absolutePath).split(path.sep).join("/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) throw new Error("image package path is invalid");
  return `/${relative}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function ensureNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("runtime package inspection was canceled");
}
