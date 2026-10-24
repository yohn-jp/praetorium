import { createHash } from "node:crypto";

export const HISTORY_CONTRACT_VERSION = "v1";
export const HISTORY_STORAGE_MIB = 512;
export const MAX_HISTORY_BYTES = 512 * 1024;
export const MAX_HISTORY_MANIFEST_BYTES = 768 * 1024;
export const MAX_HISTORY_EXEC_STDOUT_BYTES = 1024 * 1024;
export const MAX_HISTORY_ENTRIES = 4096;
export const MAX_HISTORY_DEPTH = 16;
export const HISTORY_MARKER_NAME = ".praetorium-initialized";
export const HISTORY_SEED_KEY = "snapshot.json";

export type HistorySourceDirectory = "/data/history";

export interface HistorySnapshotFile {
  readonly path: string;
  readonly contentBase64: string;
  readonly sha256: string;
}

export interface HistorySnapshot {
  readonly schemaVersion: 1;
  readonly sourcePodUid: string;
  readonly manifestSha256: string;
  readonly files: readonly HistorySnapshotFile[];
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pathIsSafe(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    value !== HISTORY_MARKER_NAME &&
    value !== ".praetorium-restore-in-progress" &&
    value.split("/").every((part) =>
      part.length > 0 && part !== "." && part !== ".." && /^[A-Za-z0-9._-]{1,128}$/u.test(part),
    )
  );
}

function decodeBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value))
    throw new TypeError("history snapshot file encoding is invalid");
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (btoa(binary) !== value) throw new TypeError("history snapshot file encoding is not canonical");
  return bytes;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalManifest(
  sourcePodUid: string,
  files: readonly HistorySnapshotFile[],
): string {
  return JSON.stringify({ schemaVersion: 1, sourcePodUid, files });
}

/** Parse and verify the bounded output from the provider's fixed Node reader. */
export function parseHistorySnapshot(
  value: string,
  expectedSourcePodUid: string,
): HistorySnapshot {
  if (value.length === 0 || Buffer.byteLength(value, "utf8") > MAX_HISTORY_MANIFEST_BYTES)
    throw new TypeError("history snapshot manifest exceeds its bound");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new TypeError("history snapshot manifest is malformed");
  }
  const root = record(parsed);
  if (
    root === null ||
    root.schemaVersion !== 1 ||
    root.sourcePodUid !== expectedSourcePodUid ||
    typeof root.manifestSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(root.manifestSha256) ||
    !Array.isArray(root.files) ||
    root.files.length > 4096
  ) {
    throw new TypeError("history snapshot identity or schema is invalid");
  }
  const files: HistorySnapshotFile[] = [];
  let totalBytes = 0;
  let previousPath = "";
  for (const entry of root.files) {
    const file = record(entry);
    if (
      file === null ||
      Object.keys(file).sort().join(",") !== "contentBase64,path,sha256" ||
      typeof file.path !== "string" ||
      !pathIsSafe(file.path) ||
      typeof file.contentBase64 !== "string" ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(file.sha256) ||
      file.path <= previousPath
    ) {
      throw new TypeError("history snapshot contains an unsafe or unordered file");
    }
    const bytes = decodeBase64(file.contentBase64);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_HISTORY_BYTES || digest(bytes) !== file.sha256)
      throw new TypeError("history snapshot file content failed its size or digest check");
    files.push({ path: file.path, contentBase64: file.contentBase64, sha256: file.sha256 });
    previousPath = file.path;
  }
  const canonical = canonicalManifest(expectedSourcePodUid, files);
  if (digest(new TextEncoder().encode(canonical)) !== root.manifestSha256)
    throw new TypeError("history snapshot manifest digest does not match its files");
  return {
    schemaVersion: 1,
    sourcePodUid: expectedSourcePodUid,
    manifestSha256: root.manifestSha256,
    files,
  };
}

export function createEmptyHistorySnapshot(sourcePodUid = "initial-empty"): HistorySnapshot {
  const files: readonly HistorySnapshotFile[] = [];
  const manifestSha256 = digest(new TextEncoder().encode(canonicalManifest(sourcePodUid, files)));
  return { schemaVersion: 1, sourcePodUid, manifestSha256, files };
}

/** Fixed non-shell reader run only against the verified Scriptorium container. */
export const HISTORY_SNAPSHOT_NODE_SCRIPT = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = process.argv[1];
const podUid = process.argv[2];
const maxBytes = 512 * 1024;
const maxEntries = 4096;
const maxDepth = 16;
const segment = /^[A-Za-z0-9._-]{1,128}$/;
if (root !== '/data/history') throw new Error('invalid source path');
if (typeof podUid !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(podUid)) throw new Error('invalid source pod identity');
const parent = path.dirname(root);
const parentStat = fs.lstatSync(parent);
if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error('history parent is not a real directory');
let rootStat;
try {
  rootStat = fs.lstatSync(root);
} catch (error) {
  if (!error || error.code !== 'ENOENT') throw error;
  rootStat = null;
}
if (rootStat !== null && (!rootStat.isDirectory() || rootStat.isSymbolicLink())) throw new Error('history root is not a real directory');
let total = 0;
let count = 0;
let entryCount = 0;
const files = [];
function names(directory) {
  const handle = fs.opendirSync(directory);
  const result = [];
  try {
    for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
      entryCount += 1;
      if (entryCount > maxEntries) throw new Error('history contains too many entries');
      result.push(entry.name);
    }
  } finally { handle.closeSync(); }
  return result.sort();
}
function walk(directory, relative, depth) {
  if (depth > maxDepth) throw new Error('history directory nesting is too deep');
  for (const name of names(directory)) {
    if (!segment.test(name) || name === '.' || name === '..') throw new Error('unsafe history path');
    const rel = relative ? relative + '/' + name : name;
    if (rel.length > 512) throw new Error('history path is too long');
    const file = path.join(directory, name);
    const before = fs.lstatSync(file);
    if (before.isSymbolicLink()) throw new Error('history links are not allowed');
    if (before.isDirectory()) { walk(file, rel, depth + 1); continue; }
    if (!before.isFile() || before.nlink !== 1) throw new Error('history entry is not a regular file');
    if (before.size > maxBytes - total) throw new Error('history exceeds the 512 KiB bound');
    count += 1;
    if (count > 4096) throw new Error('history contains too many files');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.nlink !== 1 || opened.size > maxBytes - total) throw new Error('history exceeds the 512 KiB bound');
      const bytes = fs.readFileSync(fd);
      const after = fs.fstatSync(fd);
      if (!opened.isFile() || opened.nlink !== 1 || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || bytes.length !== after.size) throw new Error('history file changed while reading');
      total += bytes.length;
      if (total > maxBytes) throw new Error('history exceeds the 512 KiB bound');
      files.push({ path: rel, contentBase64: bytes.toString('base64'), sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
    } finally { fs.closeSync(fd); }
  }
}
if (rootStat !== null) walk(root, '', 0);
files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const manifest = { schemaVersion: 1, sourcePodUid: podUid, files };
const canonical = JSON.stringify(manifest);
const result = { ...manifest, manifestSha256: crypto.createHash('sha256').update(canonical).digest('hex') };
const output = JSON.stringify(result);
if (Buffer.byteLength(output, 'utf8') > 768 * 1024) throw new Error('history snapshot manifest exceeds its bound');
process.stdout.write(output);
`;

/** Restores a seed once, only into a truly empty PVC, and leaves later history untouched. */
export const HISTORY_RESTORE_NODE_SCRIPT = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = '/history';
const privateRoot = path.join(root, 'private');
const marker = path.join(root, '.praetorium-initialized');
const progressMarker = path.join(root, '.praetorium-restore-in-progress');
const seedPath = '/history-seed/snapshot.json';
const expected = {
  instanceId: process.env.PRAETORIUM_HISTORY_INSTANCE_ID,
  repositoryId: process.env.PRAETORIUM_HISTORY_REPOSITORY_ID,
  clusterId: process.env.PRAETORIUM_HISTORY_CLUSTER_ID,
  claimName: process.env.PRAETORIUM_HISTORY_CLAIM_NAME,
};
const segment = /^[A-Za-z0-9._-]{1,128}$/;
const maxEntries = 4096;
const maxDepth = 16;
const safePath = value => typeof value === 'string' && value.length <= 512 && !value.startsWith('/') && !value.includes('\\') && !value.includes('\0') && value.split('/').every(part => part.length > 0 && part !== '.' && part !== '..' && segment.test(part));
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const stat = fs.lstatSync(root);
if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('history volume root is unsafe');
try {
  const privateStat = fs.lstatSync(privateRoot);
  if (!privateStat.isDirectory() || privateStat.isSymbolicLink()) throw new Error('private history root is unsafe');
} catch (error) {
  if (!error || error.code !== 'ENOENT') throw error;
  fs.mkdirSync(privateRoot, { mode: 0o700 });
}
function fsyncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function fsyncFile(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function fsyncPrivateDirectories(directory, depth = 0) {
  if (depth > maxDepth) throw new Error('private history directory nesting is too deep');
  const handle = fs.opendirSync(directory);
  const subdirectories = [];
  let entries = 0;
  try {
    for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
      entries += 1;
      if (entries > maxEntries) throw new Error('private history contains too many entries');
      const target = path.join(directory, entry.name);
      const item = fs.lstatSync(target);
      if (item.isDirectory() && !item.isSymbolicLink()) subdirectories.push(target);
    }
  } finally { handle.closeSync(); }
  for (const child of subdirectories) fsyncPrivateDirectories(child, depth + 1);
  fsyncDirectory(directory);
}
fsyncDirectory(privateRoot);
fsyncDirectory(root);
function scanPrivateTree(directory, depth = 0, entries = []) {
  if (depth > maxDepth) throw new Error('private history directory nesting is too deep');
  const handle = fs.opendirSync(directory);
  try {
    for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
      if (entries.length >= maxEntries) throw new Error('private history contains too many entries');
      const target = path.join(directory, entry.name);
      if (path.relative(privateRoot, target).length > 512) throw new Error('private history path is too long');
      const item = fs.lstatSync(target);
      if (item.isSymbolicLink()) throw new Error('private history links are not allowed');
      if (item.isDirectory()) {
        entries.push({ target, dev: item.dev, ino: item.ino, directory: true });
        scanPrivateTree(target, depth + 1, entries);
      } else if (item.isFile() && item.nlink === 1) {
        entries.push({ target, dev: item.dev, ino: item.ino, directory: false });
      } else {
        throw new Error('private history entry is not a regular file or directory');
      }
    }
  } finally { handle.closeSync(); }
  return entries;
}
function enforcePrivateModes(directory, entries = scanPrivateTree(directory)) {
  // Preflight the complete bounded tree before changing any modes. This makes
  // oversized or unsafe trees fail closed without doing 4096 file fsyncs.
  fs.chmodSync(directory, 0o700);
  for (const entry of entries) {
    const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW |
      (entry.directory ? fs.constants.O_DIRECTORY : 0);
    const fd = fs.openSync(entry.target, flags);
    try {
      const item = fs.fstatSync(fd);
      if (item.dev !== entry.dev || item.ino !== entry.ino ||
          (entry.directory ? !item.isDirectory() : !item.isFile() || item.nlink !== 1)) {
        throw new Error('private history entry changed during mode repair');
      }
      fs.fchmodSync(fd, entry.directory ? 0o700 : 0o600);
      if (!entry.directory) fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  }
}
if (fs.existsSync(marker)) {
  const markerStat = fs.lstatSync(marker);
  if (!markerStat.isFile() || markerStat.isSymbolicLink()) throw new Error('history ownership marker is unsafe');
  const state = JSON.parse(fs.readFileSync(marker, 'utf8'));
  if (state.schemaVersion !== 1 || state.instanceId !== expected.instanceId || state.repositoryId !== expected.repositoryId || state.clusterId !== expected.clusterId || state.claimName !== expected.claimName || typeof state.seedManifestSha256 !== 'string') throw new Error('history volume belongs to another assignment');
  const privateEntries = scanPrivateTree(privateRoot);
  fs.chmodSync(marker, 0o600);
  fsyncFile(marker);
  if (fs.existsSync(progressMarker)) {
    const progressStat = fs.lstatSync(progressMarker);
    if (!progressStat.isFile() || progressStat.isSymbolicLink()) throw new Error('history restore progress marker is unsafe');
    const progress = JSON.parse(fs.readFileSync(progressMarker, 'utf8'));
    if (progress.schemaVersion !== 1 || progress.instanceId !== expected.instanceId || progress.repositoryId !== expected.repositoryId || progress.clusterId !== expected.clusterId || progress.claimName !== expected.claimName || progress.seedManifestSha256 !== state.seedManifestSha256) throw new Error('history restore progress does not match its completion marker');
    fs.unlinkSync(progressMarker);
    fsyncDirectory(root);
  }
  enforcePrivateModes(privateRoot, privateEntries);
  fsyncPrivateDirectories(privateRoot);
  fsyncDirectory(root);
  process.exit(0);
}
const seedStat = fs.lstatSync(seedPath);
if (!seedStat.isFile() || seedStat.isSymbolicLink() || seedStat.size > 768 * 1024) throw new Error('history seed is unsafe or oversized');
const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
if (seed.schemaVersion !== 1 || typeof seed.sourcePodUid !== 'string' || !Array.isArray(seed.files) || seed.files.length > 4096 || typeof seed.manifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(seed.manifestSha256)) throw new Error('history seed schema is invalid');
const canonical = JSON.stringify({ schemaVersion: 1, sourcePodUid: seed.sourcePodUid, files: seed.files });
if (digest(Buffer.from(canonical)) !== seed.manifestSha256) throw new Error('history seed manifest digest failed');
const progressState = { schemaVersion: 1, ...expected, seedManifestSha256: seed.manifestSha256 };
if (fs.existsSync(progressMarker)) {
  const progressStat = fs.lstatSync(progressMarker);
  if (!progressStat.isFile() || progressStat.isSymbolicLink()) throw new Error('history restore progress marker is unsafe');
  const existing = JSON.parse(fs.readFileSync(progressMarker, 'utf8'));
  if (JSON.stringify(existing) !== JSON.stringify(progressState)) throw new Error('history restore progress belongs to another seed');
} else {
  const handle = fs.opendirSync(privateRoot);
  try { if (handle.readSync() !== null) throw new Error('uninitialized history volume is not empty'); }
  finally { handle.closeSync(); }
  const progressFd = fs.openSync(progressMarker, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(progressFd, JSON.stringify(progressState)); fs.fsyncSync(progressFd); } finally { fs.closeSync(progressFd); }
  fsyncDirectory(root);
}
let total = 0;
let previous = '';
const expectedFiles = new Set();
const expectedDirectories = new Set();
let verifiedEntryCount = 0;
for (const file of seed.files) {
  if (!file || Object.keys(file).sort().join(',') !== 'contentBase64,path,sha256' || !safePath(file.path) || file.path === '.praetorium-initialized' || file.path === '.praetorium-restore-in-progress' || file.path <= previous || typeof file.contentBase64 !== 'string' || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('history seed file entry is invalid');
  const bytes = Buffer.from(file.contentBase64, 'base64');
  if (bytes.toString('base64') !== file.contentBase64 || digest(bytes) !== file.sha256) throw new Error('history seed file digest failed');
  total += bytes.length;
  if (total > 512 * 1024) throw new Error('history seed exceeds the 512 KiB bound');
  const target = path.join(privateRoot, ...file.path.split('/'));
  let parent = privateRoot;
  for (const part of file.path.split('/').slice(0, -1)) {
    parent = path.join(parent, part);
    expectedDirectories.add(path.relative(privateRoot, parent));
    try {
      const parentStat = fs.lstatSync(parent);
      if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error('history directory is unsafe');
    } catch (error) {
      if (error && error.code !== 'ENOENT') throw error;
      fs.mkdirSync(parent, { mode: 0o700 });
    }
  }
  expectedFiles.add(file.path);
  try {
    const existingStat = fs.lstatSync(target);
    if (!existingStat.isFile() || existingStat.isSymbolicLink() || existingStat.nlink !== 1 || existingStat.size !== bytes.length || digest(fs.readFileSync(target)) !== file.sha256) throw new Error('existing history file differs from its seed');
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
    const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  previous = file.path;
}
function verifyTree(directory, relative = '') {
  if (relative.split('/').filter(Boolean).length > maxDepth) throw new Error('private history directory nesting is too deep');
  const handle = fs.opendirSync(directory);
  const names = [];
  try {
    for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
      verifiedEntryCount += 1;
      if (verifiedEntryCount > maxEntries) throw new Error('private history contains too many entries');
      names.push(entry.name);
    }
  } finally { handle.closeSync(); }
  for (const name of names) {
    const rel = relative ? relative + '/' + name : name;
    if (relative === '' && (name === '.praetorium-initialized' || name === '.praetorium-restore-in-progress')) continue;
    const itemPath = path.join(directory, name);
    const item = fs.lstatSync(itemPath);
    if (item.isSymbolicLink()) throw new Error('unrecognized history link');
    if (item.isDirectory()) {
      if (!expectedDirectories.has(rel)) throw new Error('unrecognized history directory');
      if (rel.split('/').length > maxDepth) throw new Error('private history directory nesting is too deep');
      verifyTree(itemPath, rel);
    } else if (!item.isFile() || !expectedFiles.has(rel)) throw new Error('unrecognized history file');
  }
}
verifyTree(privateRoot);
enforcePrivateModes(privateRoot);
fsyncPrivateDirectories(privateRoot);
fsyncDirectory(root);
const state = { schemaVersion: 1, ...expected, seedManifestSha256: seed.manifestSha256, sourcePodUid: seed.sourcePodUid };
const markerFd = fs.openSync(marker, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
try { fs.writeFileSync(markerFd, JSON.stringify(state)); fs.fsyncSync(markerFd); } finally { fs.closeSync(markerFd); }
fsyncDirectory(root);
fs.unlinkSync(progressMarker);
fsyncDirectory(root);
`;

/** Fixed read-only reader for the marker under the owned /history PVC. */
export const HISTORY_MARKER_NODE_SCRIPT = String.raw`
const fs = require('node:fs');
const privateRoot = '/history/private';
const rootStat = fs.lstatSync(privateRoot);
if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o777) !== 0o700) throw new Error('private history root mode is invalid');
const path = require('node:path');
const file = path.join('/history', '.praetorium-initialized');
const stat = fs.lstatSync(file);
if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096 || (stat.mode & 0o777) !== 0o600) throw new Error('history ownership marker is invalid');
process.stdout.write(fs.readFileSync(file, 'utf8'));
`;
