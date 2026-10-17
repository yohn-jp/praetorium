import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath, readdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  BuildInputSchema,
  BuildCatalogSchema,
  CompositionManifestSchema,
  PersistenceCompatibilitySchema,
  RuntimeMetadataSchema,
  buildKey,
  canonicalBuildInput,
  validateCompositionBindings,
  type BuildInput,
  type CompositionManifest,
  type RuntimeMetadata,
} from "@praetorium/contracts";
import { scriptoriumCompositionPersistence } from "@praetorium/scriptorium";
import { BuildKitAttemptError } from "@praetorium/buildkit";
import type { BuildCandidateReceiptReader, BuildKitProviderConfig } from "@praetorium/buildkit";
import { BuildKitImageRootfsExporter } from "@praetorium/buildkit";
import { verifyRuntimePackageClosure, type RuntimePackageRecord } from "./pnpm-runtime-closure.js";
import type {
  CompositionArtifactInspection,
  CompositionArtifactInspector,
  GhcrRegistryClient,
} from "@praetorium/ghcr";
import { sha256Digest, type Sha256Digest, type VerifiedOciImage } from "@praetorium/ghcr";

const COMPOSITION_PATH = "/usr/share/scriptorium/composition-manifest.json";
const BUILD_REPORT_PATH = "/usr/share/scriptorium/build-artifact-report.json";
const BUILD_CATALOG_PATH = "/usr/share/scriptorium/build-catalog.json";
const RUNTIME_METADATA_FILE_PATH = "/usr/share/scriptorium/runtime-metadata.json";
const RUNTIME_METADATA_PATH = "/api/platform/v1/metadata";
const SERVER_REGISTRY_PATH = "/app/generated/server.mjs";
const MAX_COMPOSITION_BYTES = 4 * 1024 * 1024;
const MAX_CONFIG_BYTES = 8 * 1024 * 1024;
const MAX_REGISTRY_BYTES = 2 * 1024 * 1024;
const MAX_BROWSER_BYTES = 128 * 1024 * 1024;
const MAX_PACKAGE_FILES = 100_000;
const MAX_PACKAGE_BYTES = 1024 * 1024 * 1024;
const MAX_NATIVE_FILES = 10_000;
const MAX_NATIVE_BYTES = 1024 * 1024 * 1024;
const BROWSER_REGISTRY_PATH = "/app/generated/browser.mjs";
const BROWSER_MANIFEST_PATH = "/app/app/dist/.vite/manifest.json";
export type BuildKitRootfsExporter = Pick<BuildKitImageRootfsExporter, "exportImage">;
export type CompositionRegistry = Pick<
  GhcrRegistryClient,
  "registryHost" | "readBlob" | "publishBlob"
>;

/** Reads the exact receipt embedded in the immutable image and publishes those bytes by digest. */
export class ScriptoriumBuildCandidateReceiptReader implements BuildCandidateReceiptReader {
  private readonly rootfsExporter: BuildKitRootfsExporter;

  constructor(
    private readonly registry: CompositionRegistry,
    buildKitConfig: BuildKitProviderConfig,
    private readonly compositionRepository: string,
    options: { readonly rootfsExporter?: BuildKitRootfsExporter } = {},
  ) {
    this.rootfsExporter = options.rootfsExporter ?? new BuildKitImageRootfsExporter(buildKitConfig);
  }

  supports(input: BuildInput): boolean {
    return (
      BuildInputSchema.safeParse(input).success && input.contractVersion === "scriptorium-build/v1"
    );
  }

  async read(input: {
    metadataFile: string;
    expectedInput: BuildInput;
    outputRepository: string;
    signal?: AbortSignal;
  }): Promise<{ compositionManifest: { repository: string; digest: Sha256Digest } }> {
    if (!this.supports(input.expectedInput) || input.signal?.aborted) {
      throw new Error("producer receipt request is invalid or canceled");
    }
    const repository = repositoryPath(input.outputRepository, this.registry.registryHost);
    let imageDigest: Sha256Digest;
    try {
      imageDigest = await readBuildMetadataDigest(input.metadataFile);
    } catch {
      if (input.signal?.aborted) throw new BuildKitAttemptError("BUILD_CANCELED", true);
      throw new BuildKitAttemptError("BUILD_FAILED", false);
    }
    const imageReference = `${this.registry.registryHost}/${repository}@${imageDigest}`;
    const exported = await this.rootfsExporter.exportImage(
      { imageReference, platform: input.expectedInput.platform },
      input.signal ?? new AbortController().signal,
    );
    try {
      if (input.signal?.aborted) throw new Error("producer receipt request was canceled");
      let bytes: Uint8Array;
      try {
        bytes = await readRootFile(exported.imageRoot, COMPOSITION_PATH, MAX_COMPOSITION_BYTES);
        const manifest = parseCompositionManifest(bytes);
        const canonicalExpected = canonicalBuildInput(input.expectedInput);
        if (
          canonicalBuildInput(manifest.buildInput) !== canonicalExpected ||
          manifest.producerRevision !== input.expectedInput.producerRevision ||
          manifest.platform !== input.expectedInput.platform ||
          manifest.buildKey !== (await buildKey(input.expectedInput)) ||
          !(await validateCompositionBindings(manifest))
        ) {
          throw new Error("producer receipt is not bound to the immutable build input");
        }
      } catch {
        if (input.signal?.aborted) throw new BuildKitAttemptError("BUILD_CANCELED", true);
        throw new BuildKitAttemptError("BUILD_FAILED", false);
      }
      if (input.signal?.aborted) throw new Error("producer receipt request was canceled");
      const digest = await this.registry.publishBlob(
        this.compositionRepository,
        bytes,
        input.signal,
      );
      if (digest !== (await sha256Digest(bytes)))
        throw new BuildKitAttemptError("BUILD_FAILED", false);
      return { compositionManifest: { repository: this.compositionRepository, digest } };
    } finally {
      await exported.dispose();
    }
  }
}

/** Verifies the digest-pinned Scriptorium image contents and executes its own startup command. */
export class ScriptoriumCompositionArtifactInspector implements CompositionArtifactInspector {
  private readonly rootfsExporter: BuildKitRootfsExporter;

  constructor(
    private readonly registry: CompositionRegistry,
    buildKitConfig: BuildKitProviderConfig,
    options: { readonly rootfsExporter?: BuildKitRootfsExporter } = {},
  ) {
    this.rootfsExporter = options.rootfsExporter ?? new BuildKitImageRootfsExporter(buildKitConfig);
  }

  async inspectAndSmoke(
    input: {
      readonly imageReference: string;
      readonly image: VerifiedOciImage;
      readonly compositionManifest: CompositionManifest;
      readonly compositionManifestDigest: Sha256Digest;
    },
    signal: AbortSignal,
  ): Promise<CompositionArtifactInspection> {
    if (
      signal.aborted ||
      input.imageReference !==
        `${this.registry.registryHost}/${input.image.repository}@${input.image.manifestDigest}` ||
      input.compositionManifest.platform !==
        `${input.image.platform.os}/${input.image.platform.architecture}`
    ) {
      throw new Error("composition inspection input is not digest-bound");
    }
    const configBlob = await this.registry.readBlob(
      input.image.repository,
      input.image.configDigest,
      MAX_CONFIG_BYTES,
      signal,
    );
    const imageConfig = parseImageConfig(configBlob.bytes);
    validateImageRuntimeEnvironment(imageConfig);
    const port = imageListenerPort(imageConfig);
    const command = imageStartupCommand(imageConfig);
    const exported = await this.rootfsExporter.exportImage(
      {
        imageReference: input.imageReference,
        platform: input.compositionManifest.platform,
        startup: {
          entrypoint: command.entrypoint,
          command: command.command,
          workingDirectory: command.workingDirectory,
          port,
          healthPath: input.compositionManifest.smoke.healthPath,
          metadataPath: RUNTIME_METADATA_PATH,
          timeoutMs: input.compositionManifest.smoke.timeoutSeconds * 1000,
        },
      },
      signal,
    );
    try {
      if (!exported.smokeResult?.passed || exported.smokeResult.status !== 200) {
        throw new Error("producer startup smoke did not pass");
      }
      const embeddedComposition = await readRootFile(
        exported.imageRoot,
        COMPOSITION_PATH,
        MAX_COMPOSITION_BYTES,
      );
      if ((await sha256Digest(embeddedComposition)) !== input.compositionManifestDigest) {
        throw new Error("embedded composition manifest differs from the digest-bound receipt");
      }
      const embeddedCompositionValue = CompositionManifestSchema.parse(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(embeddedComposition),
        ) as unknown,
      );
      if (
        !canonicalBytesEqual(embeddedComposition, embeddedCompositionValue) ||
        canonicalJson(embeddedCompositionValue) !== canonicalJson(input.compositionManifest)
      ) {
        throw new Error(
          "embedded composition manifest differs from the verified producer declaration",
        );
      }
      verifyHostedPersistence(input.compositionManifest);
      const metadata = RuntimeMetadataSchema.parse(exported.smokeResult.metadata);
      validateRuntimeMetadata(metadata, input.compositionManifest, port);
      ensureNotAborted(signal);
      const contractDigests = await verifyEmbeddedBuildContracts(
        exported.imageRoot,
        input.compositionManifest,
        metadata,
      );
      await verifyArtifactEntries(exported.imageRoot, input.compositionManifest);
      ensureNotAborted(signal);
      const report = await readBuildArtifactReport(exported.imageRoot);
      validateBuildArtifactReport(report, input.compositionManifest, contractDigests);
      const installedModules = await verifyModulePackageClosure(
        exported.imageRoot,
        input.compositionManifest,
        signal,
      );
      if (JSON.stringify(installedModules) !== JSON.stringify(report.modulePackages)) {
        throw new Error("build report module identities differ from installed package contents");
      }
      await verifyRuntimePackageClosure({
        imageRoot: exported.imageRoot,
        selectedModuleIds: input.compositionManifest.server.moduleIds,
        expectedLockDigest: input.compositionManifest.buildInput.lockDigest,
        runtimePackages: report.runtimePackages,
        signal,
      });
      ensureNotAborted(signal);
      const serverModuleIds = await verifyServerRegistry(
        exported.imageRoot,
        input.compositionManifest,
        signal,
      );
      if (!sameStrings(serverModuleIds, report.serverModuleIds)) {
        throw new Error("build report server module IDs differ from the generated server registry");
      }
      const browserModuleIds = await verifyBrowserArtifacts(
        exported.imageRoot,
        input.compositionManifest,
        report,
        signal,
      );
      const nativeDependencies = await scanNativeDependencies(
        exported.imageRoot,
        MAX_NATIVE_BYTES,
        signal,
      );
      if (
        JSON.stringify(nativeDependencies) !==
          JSON.stringify(input.compositionManifest.nativeDependencies) ||
        JSON.stringify(nativeDependencies) !== JSON.stringify(report.nativeDependencies)
      ) {
        throw new Error(
          "native dependencies in the OCI rootfs differ from the composition manifest and build report",
        );
      }
      return {
        imageDigest: input.image.manifestDigest,
        compositionManifestDigest: input.compositionManifestDigest,
        serverEntry: input.compositionManifest.server.entry,
        browserEntry: input.compositionManifest.browser.entry,
        serverModuleIds,
        browserModuleIds,
        nativeDependencies,
        smoke: {
          id: input.compositionManifest.smoke.id,
          healthPath: input.compositionManifest.smoke.healthPath,
          passed: true,
        },
      };
    } finally {
      await exported.dispose();
    }
  }
}

async function readBuildMetadataDigest(filename: string): Promise<Sha256Digest> {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 16 * 1024) {
    throw new Error("BuildKit output metadata is invalid");
  }
  const parsed: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(await readFile(filename)),
  );
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("BuildKit output metadata is invalid");
  }
  const digest = (parsed as Record<string, unknown>)["containerimage.digest"];
  if (typeof digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(digest)) {
    throw new Error("BuildKit output metadata has no immutable image digest");
  }
  return digest as Sha256Digest;
}

function repositoryPath(repository: string, registryHost: string): string {
  const prefix = `${registryHost}/`;
  if (!repository.startsWith(prefix))
    throw new Error("BuildKit output repository has a different registry origin");
  const pathName = repository.slice(prefix.length);
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/u.test(pathName)) {
    throw new Error("BuildKit output repository path is invalid");
  }
  return pathName;
}

function parseCompositionManifest(bytes: Uint8Array): CompositionManifest {
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  return CompositionManifestSchema.parse(value);
}

async function readRootFile(
  root: string,
  absolutePath: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (signal?.aborted) throw signal.reason ?? new Error("composition inspection was canceled");
  const filename = await resolveRootRegularFile(root, absolutePath, maxBytes);
  return signal ? readFile(filename, { signal }) : readFile(filename);
}

async function resolveRootRegularFile(
  root: string,
  absolutePath: string,
  maxBytes: number,
): Promise<string> {
  const rootRealPath = await realpath(root);
  const rootInfo = await stat(rootRealPath);
  if (!rootInfo.isDirectory()) throw new Error("exported image rootfs is not a directory");
  const filename = rootPath(rootRealPath, absolutePath);
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maxBytes) {
    throw new Error("producer artifact file is missing or outside the configured size bound");
  }
  const target = await realpath(filename);
  if (!isWithin(rootRealPath, target))
    throw new Error("producer artifact file escapes the exported image rootfs");
  const targetInfo = await stat(target);
  if (!targetInfo.isFile() || targetInfo.size < 1 || targetInfo.size > maxBytes) {
    throw new Error("producer artifact file is missing or outside the configured size bound");
  }
  return target;
}

function rootPath(root: string, absolutePath: string): string {
  if (!path.isAbsolute(absolutePath) || absolutePath.includes("\0"))
    throw new Error("image path is invalid");
  const rootAbsolute = path.resolve(root);
  const target = path.resolve(rootAbsolute, `.${absolutePath}`);
  const relative = path.relative(rootAbsolute, target);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error("image path escapes the exported rootfs");
  }
  return target;
}

type ImageConfig = {
  readonly env: ReadonlyMap<string, string>;
  readonly entrypoint: readonly string[];
  readonly command: readonly string[];
  readonly workingDirectory: string;
  readonly exposedPorts: ReadonlySet<number>;
};

function parseImageConfig(bytes: Uint8Array): ImageConfig {
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("OCI config is invalid");
  const config = (value as Record<string, unknown>).config;
  if (typeof config !== "object" || config === null || Array.isArray(config))
    throw new Error("OCI runtime config is missing");
  const record = config as Record<string, unknown>;
  const env = new Map<string, string>();
  if (record.Env !== undefined) {
    if (
      !Array.isArray(record.Env) ||
      record.Env.some((item) => typeof item !== "string" || !item.includes("="))
    ) {
      throw new Error("OCI environment is invalid");
    }
    for (const item of record.Env as string[]) {
      const separator = item.indexOf("=");
      env.set(item.slice(0, separator), item.slice(separator + 1));
    }
  }
  const parseCommand = (key: string): readonly string[] => {
    const input = record[key];
    if (input === undefined || input === null) return [];
    if (
      !Array.isArray(input) ||
      input.some((part) => typeof part !== "string" || part.length === 0 || part.includes("\0"))
    ) {
      throw new Error(`OCI ${key} is invalid`);
    }
    return input as string[];
  };
  const exposedPorts = new Set<number>();
  if (record.ExposedPorts !== undefined) {
    if (
      typeof record.ExposedPorts !== "object" ||
      record.ExposedPorts === null ||
      Array.isArray(record.ExposedPorts)
    ) {
      throw new Error("OCI exposed ports are invalid");
    }
    for (const name of Object.keys(record.ExposedPorts as Record<string, unknown>)) {
      const match = /^(\d{1,5})\/tcp$/u.exec(name);
      if (!match || Number(match[1]) < 1 || Number(match[1]) > 65_535)
        throw new Error("OCI exposed port is invalid");
      exposedPorts.add(Number(match[1]));
    }
  }
  const workingDirectory =
    typeof record.WorkingDir === "string" && record.WorkingDir !== "" ? record.WorkingDir : "/";
  if (!path.isAbsolute(workingDirectory) || workingDirectory.includes("\0"))
    throw new Error("OCI working directory is invalid");
  return {
    env,
    entrypoint: parseCommand("Entrypoint"),
    command: parseCommand("Cmd"),
    workingDirectory,
    exposedPorts,
  };
}

function imageListenerPort(config: ImageConfig): number {
  const configured = config.env.get("PORT");
  if (configured === undefined || !/^[1-9][0-9]{0,4}$/u.test(configured)) {
    throw new Error("OCI image does not declare a valid listener port");
  }
  const port = Number(configured);
  if (port > 65_535 || !config.exposedPorts.has(port))
    throw new Error("OCI listener and exposed port do not match");
  return port;
}

function imageStartupCommand(config: ImageConfig): {
  readonly entrypoint: readonly string[];
  readonly command: readonly string[];
  readonly workingDirectory: string;
} {
  if (config.entrypoint.length === 0 && config.command.length === 0)
    throw new Error("OCI image has no startup command");
  return {
    entrypoint: config.entrypoint,
    command: config.command,
    workingDirectory: config.workingDirectory,
  };
}

function validateImageRuntimeEnvironment(config: ImageConfig): void {
  const hostedMode = config.env.get("SCRIPTORIUM_HOSTED_MODE");
  if (
    config.env.get("SCRIPTORIUM_PROFILE") !== "hosted" ||
    config.env.get("SCRIPTORIUM_MODULE_PROFILE_PATH") !== SERVER_REGISTRY_PATH ||
    hostedMode !== "1" ||
    config.env.has("SCRIPTORIUM_AUTH_TOKEN") ||
    config.env.has("SCRIPTORIUM_GITHUB_TOKEN")
  ) {
    throw new Error("producer image does not declare a credential-free hosted composition runtime");
  }
}

function validateRuntimeMetadata(
  metadata: RuntimeMetadata,
  manifest: CompositionManifest,
  port: number,
): void {
  if (
    metadata.producerRevision !== manifest.producerRevision ||
    metadata.listener.port !== 3000 ||
    port !== 3000 ||
    metadata.paths.liveness !== "/health/live" ||
    metadata.paths.readiness !== "/health/ready" ||
    metadata.paths.metadata !== RUNTIME_METADATA_PATH ||
    metadata.paths.shutdown !== "/api/platform/v1/quiesce" ||
    metadata.paths.status !== "/api/platform/v1/status" ||
    metadata.paths.quiesce !== "/api/platform/v1/quiesce" ||
    metadata.paths.resume !== "/api/platform/v1/resume" ||
    metadata.shutdownTimeoutSeconds !== 25 ||
    manifest.smoke.healthPath !== metadata.paths.readiness
  ) {
    throw new Error("runtime metadata is not bound to the inspected producer image");
  }
}

export function verifyHostedPersistence(manifest: CompositionManifest): void {
  if (!manifest.persistence)
    throw new Error("hosted composition does not declare persistence compatibility");
  const expected = PersistenceCompatibilitySchema.parse(
    scriptoriumCompositionPersistence(
      manifest.producerRevision,
      manifest.resolvedModules.map(({ id }) => id),
    ),
  );
  const actual = PersistenceCompatibilitySchema.parse(manifest.persistence);
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(
      "hosted persistence compatibility does not match the pinned Scriptorium module set",
    );
  }
}

async function verifyEmbeddedBuildContracts(
  root: string,
  manifest: CompositionManifest,
  runtimeMetadata: RuntimeMetadata,
): Promise<{ readonly catalogDigest: Sha256Digest; readonly runtimeMetadataDigest: Sha256Digest }> {
  const catalogBytes = await readRootFile(root, BUILD_CATALOG_PATH, MAX_REGISTRY_BYTES);
  const catalogValue: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(catalogBytes),
  );
  const catalog = BuildCatalogSchema.parse(catalogValue);
  if (!canonicalBytesEqual(catalogBytes, catalog))
    throw new Error("embedded build catalog is not canonical JSON");
  if (
    catalog.contractVersion !== manifest.buildInput.contractVersion ||
    catalog.producerRevision !== manifest.producerRevision ||
    catalog.runtimeBaseDigest !== manifest.buildInput.runtimeBaseDigest ||
    catalog.buildKitDigest !== manifest.buildInput.buildKitDigest ||
    catalog.recipeDigest !== manifest.buildInput.recipeDigest ||
    catalog.lockDigest !== manifest.buildInput.lockDigest ||
    catalog.sourceDigest !== manifest.buildInput.sourceDigest ||
    !catalog.supportedPlatforms.includes(manifest.platform)
  ) {
    throw new Error("embedded build catalog does not match the composition manifest");
  }
  const catalogModules = new Map(catalog.modules.map((module) => [module.id, module]));
  for (const resolved of manifest.resolvedModules) {
    const available = catalogModules.get(resolved.id);
    if (
      available === undefined ||
      available.version !== resolved.version ||
      available.artifactDigest !== resolved.artifactDigest
    ) {
      throw new Error("selected module identity is absent from the embedded build catalog");
    }
  }
  const metadataBytes = await readRootFile(root, RUNTIME_METADATA_FILE_PATH, MAX_REGISTRY_BYTES);
  const fileMetadataValue: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(metadataBytes),
  );
  const fileMetadata = RuntimeMetadataSchema.parse(fileMetadataValue);
  if (!canonicalBytesEqual(metadataBytes, fileMetadata))
    throw new Error("embedded runtime metadata is not canonical JSON");
  if (!sameRuntimeMetadata(fileMetadata, runtimeMetadata)) {
    throw new Error(
      "embedded runtime metadata differs from the running producer metadata endpoint",
    );
  }
  return {
    catalogDigest: await sha256Digest(catalogBytes),
    runtimeMetadataDigest: await sha256Digest(metadataBytes),
  };
}

function sameRuntimeMetadata(left: RuntimeMetadata, right: RuntimeMetadata): boolean {
  return (
    left.contractVersion === right.contractVersion &&
    left.producerRevision === right.producerRevision &&
    left.listener.port === right.listener.port &&
    left.paths.liveness === right.paths.liveness &&
    left.paths.readiness === right.paths.readiness &&
    left.paths.metadata === right.paths.metadata &&
    left.paths.shutdown === right.paths.shutdown &&
    left.paths.status === right.paths.status &&
    left.paths.quiesce === right.paths.quiesce &&
    left.paths.resume === right.paths.resume &&
    left.shutdownTimeoutSeconds === right.shutdownTimeoutSeconds
  );
}

async function verifyArtifactEntries(root: string, manifest: CompositionManifest): Promise<void> {
  await Promise.all([
    verifyRegularImageEntry(root, manifest.server.entry),
    verifyRegularImageEntry(root, manifest.browser.entry),
  ]);
}

type BuildArtifactReport = {
  readonly schemaVersion: "scriptorium-build-report/v1";
  readonly producerRevision: string;
  readonly buildKey: string;
  readonly catalogPath: string;
  readonly catalogDigest: Sha256Digest;
  readonly runtimeMetadataPath: string;
  readonly runtimeMetadataDigest: Sha256Digest;
  readonly compositionManifestPath: string;
  readonly lockPath: string;
  readonly lockDigest: Sha256Digest;
  readonly persistence: NonNullable<CompositionManifest["persistence"]>;
  readonly browserPersistence: {
    readonly indexedDbVersion: number;
    readonly sourceDigest: Sha256Digest;
  };
  readonly modulePackages: readonly {
    readonly id: string;
    readonly version: string;
    readonly artifactDigest: Sha256Digest;
    readonly packagePath: string;
  }[];
  readonly runtimePackages: readonly RuntimePackageRecord[];
  readonly serverModuleIds: readonly string[];
  readonly browserModuleIds: readonly string[];
  readonly serverRegistryPath: string;
  readonly browserRegistryPath: string;
  readonly browserManifestPath: string;
  readonly browserFiles: readonly { readonly path: string; readonly digest: Sha256Digest }[];
  readonly browserEntryPath: string;
  readonly browserBundleDigest: Sha256Digest;
  readonly nativeDependencies: CompositionManifest["nativeDependencies"];
};

async function readBuildArtifactReport(root: string): Promise<BuildArtifactReport> {
  const bytes = await readRootFile(root, BUILD_REPORT_PATH, MAX_REGISTRY_BYTES);
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("producer build artifact report is invalid");
  const record = value as Record<string, unknown>;
  const reportKeys = [
    "schemaVersion",
    "producerRevision",
    "buildKey",
    "catalogPath",
    "catalogDigest",
    "runtimeMetadataPath",
    "runtimeMetadataDigest",
    "compositionManifestPath",
    "lockPath",
    "lockDigest",
    "persistence",
    "browserPersistence",
    "modulePackages",
    "runtimePackages",
    "serverModuleIds",
    "browserModuleIds",
    "serverRegistryPath",
    "browserRegistryPath",
    "browserManifestPath",
    "browserFiles",
    "browserEntryPath",
    "browserBundleDigest",
    "nativeDependencies",
  ];
  if (
    !hasExactKeys(record, reportKeys) ||
    record.schemaVersion !== "scriptorium-build-report/v1" ||
    typeof record.producerRevision !== "string" ||
    typeof record.buildKey !== "string" ||
    typeof record.catalogPath !== "string" ||
    typeof record.catalogDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(record.catalogDigest) ||
    typeof record.runtimeMetadataPath !== "string" ||
    typeof record.runtimeMetadataDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(record.runtimeMetadataDigest) ||
    typeof record.compositionManifestPath !== "string" ||
    typeof record.lockPath !== "string" ||
    typeof record.lockDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(record.lockDigest) ||
    typeof record.persistence !== "object" ||
    record.persistence === null ||
    Array.isArray(record.persistence) ||
    typeof record.browserPersistence !== "object" ||
    record.browserPersistence === null ||
    Array.isArray(record.browserPersistence) ||
    !Array.isArray(record.modulePackages) ||
    !Array.isArray(record.runtimePackages) ||
    !Array.isArray(record.serverModuleIds) ||
    !Array.isArray(record.browserModuleIds) ||
    typeof record.serverRegistryPath !== "string" ||
    typeof record.browserRegistryPath !== "string" ||
    typeof record.browserManifestPath !== "string" ||
    !Array.isArray(record.browserFiles) ||
    typeof record.browserEntryPath !== "string" ||
    typeof record.browserBundleDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(record.browserBundleDigest) ||
    !Array.isArray(record.nativeDependencies)
  )
    throw new Error("producer build artifact report does not match its versioned contract");
  const persistence = PersistenceCompatibilitySchema.parse(record.persistence);
  if (!canonicalBytesEqual(bytes, record))
    throw new Error("producer build artifact report is not canonical JSON");
  const browserPersistenceRecord = record.browserPersistence as Record<string, unknown>;
  if (
    Object.keys(browserPersistenceRecord).sort().join(",") !== "indexedDbVersion,sourceDigest" ||
    browserPersistenceRecord.indexedDbVersion !== 3 ||
    typeof browserPersistenceRecord.sourceDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(browserPersistenceRecord.sourceDigest)
  )
    throw new Error("producer browser persistence report does not match its versioned contract");
  const modulePackages = record.modulePackages.map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error("producer module report is invalid");
    const item = value as Record<string, unknown>;
    if (
      !hasExactKeys(item, ["id", "version", "artifactDigest", "packagePath"]) ||
      typeof item.id !== "string" ||
      typeof item.version !== "string" ||
      typeof item.artifactDigest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(item.artifactDigest) ||
      typeof item.packagePath !== "string"
    )
      throw new Error("producer module identity is invalid");
    return {
      id: item.id,
      version: item.version,
      artifactDigest: item.artifactDigest as Sha256Digest,
      packagePath: item.packagePath,
    };
  });
  const runtimePackages = record.runtimePackages.map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error("producer runtime package report is invalid");
    const item = value as Record<string, unknown>;
    if (
      !hasExactKeys(item, ["name", "version", "packagePath", "lockIdentity", "lockIntegrity"]) ||
      typeof item.name !== "string" ||
      typeof item.version !== "string" ||
      typeof item.packagePath !== "string" ||
      typeof item.lockIdentity !== "string" ||
      (item.lockIntegrity !== null && typeof item.lockIntegrity !== "string")
    )
      throw new Error("producer runtime package identity is invalid");
    return {
      name: item.name,
      version: item.version,
      packagePath: item.packagePath,
      lockIdentity: item.lockIdentity,
      lockIntegrity: item.lockIntegrity as string | null,
    };
  });
  const browserFiles = record.browserFiles.map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error("producer browser file report is invalid");
    const item = value as Record<string, unknown>;
    if (
      !hasExactKeys(item, ["path", "sha256"]) ||
      typeof item.path !== "string" ||
      typeof item.sha256 !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(item.sha256)
    )
      throw new Error("producer browser file digest is invalid");
    return { path: item.path, digest: item.sha256 as Sha256Digest };
  });
  const stringArray = (value: unknown): string[] => {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
      throw new Error("producer module ID list is invalid");
    return value as string[];
  };
  const nativeDependencies = record.nativeDependencies.map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error("producer native dependency is invalid");
    const item = value as Record<string, unknown>;
    if (
      !hasExactKeys(item, ["id", "version", "artifactDigest"]) ||
      typeof item.id !== "string" ||
      typeof item.version !== "string" ||
      typeof item.artifactDigest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(item.artifactDigest)
    )
      throw new Error("producer native dependency identity is invalid");
    return {
      id: item.id,
      version: item.version,
      artifactDigest: item.artifactDigest as Sha256Digest,
    };
  });
  return {
    schemaVersion: "scriptorium-build-report/v1",
    producerRevision: record.producerRevision,
    buildKey: record.buildKey,
    catalogPath: record.catalogPath,
    catalogDigest: record.catalogDigest as Sha256Digest,
    runtimeMetadataPath: record.runtimeMetadataPath,
    runtimeMetadataDigest: record.runtimeMetadataDigest as Sha256Digest,
    compositionManifestPath: record.compositionManifestPath,
    lockPath: record.lockPath,
    lockDigest: record.lockDigest as Sha256Digest,
    persistence,
    browserPersistence: {
      indexedDbVersion: browserPersistenceRecord.indexedDbVersion as number,
      sourceDigest: browserPersistenceRecord.sourceDigest as Sha256Digest,
    },
    modulePackages,
    runtimePackages,
    serverModuleIds: stringArray(record.serverModuleIds),
    browserModuleIds: stringArray(record.browserModuleIds),
    serverRegistryPath: record.serverRegistryPath,
    browserRegistryPath: record.browserRegistryPath,
    browserManifestPath: record.browserManifestPath,
    browserFiles,
    browserEntryPath: record.browserEntryPath,
    browserBundleDigest: record.browserBundleDigest as Sha256Digest,
    nativeDependencies,
  };
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return sameStrings(actual, sortedExpected);
}

function canonicalBytesEqual(bytes: Uint8Array, value: unknown): boolean {
  return Buffer.from(bytes).equals(Buffer.from(canonicalJson(value), "utf8"));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function validateBuildArtifactReport(
  report: BuildArtifactReport,
  manifest: CompositionManifest,
  contractDigests: {
    readonly catalogDigest: Sha256Digest;
    readonly runtimeMetadataDigest: Sha256Digest;
  },
): void {
  const serverIds = [...report.serverModuleIds].sort();
  const browserIds = [...report.browserModuleIds].sort();
  const expectedServerIds = [...manifest.server.moduleIds].sort();
  const expectedBrowserIds = [...manifest.browser.moduleIds].sort();
  const moduleIds = report.modulePackages.map(({ id }) => id).sort();
  const resolvedIds = manifest.resolvedModules.map(({ id }) => id).sort();
  const nativeIds = report.nativeDependencies.map(({ id }) => id);
  const sortedNativeIds = [...nativeIds].sort();
  if (
    report.producerRevision !== manifest.producerRevision ||
    report.buildKey !== manifest.buildKey ||
    report.catalogPath !== BUILD_CATALOG_PATH ||
    report.catalogDigest !== contractDigests.catalogDigest ||
    report.runtimeMetadataPath !== RUNTIME_METADATA_FILE_PATH ||
    report.runtimeMetadataDigest !== contractDigests.runtimeMetadataDigest ||
    report.compositionManifestPath !== COMPOSITION_PATH ||
    report.lockPath !== "/usr/share/scriptorium/pnpm-lock.yaml" ||
    report.lockDigest !== manifest.buildInput.lockDigest ||
    !samePersistence(report.persistence, manifest.persistence) ||
    report.browserPersistence.indexedDbVersion !== 3 ||
    report.serverRegistryPath !== SERVER_REGISTRY_PATH ||
    report.browserRegistryPath !== BROWSER_REGISTRY_PATH ||
    report.browserManifestPath !== BROWSER_MANIFEST_PATH ||
    report.browserEntryPath !== "/" + manifest.browser.entry ||
    !sameStrings(serverIds, expectedServerIds) ||
    !sameStrings(report.serverModuleIds, serverIds) ||
    !sameStrings(browserIds, expectedBrowserIds) ||
    !sameStrings(report.browserModuleIds, browserIds) ||
    !sameStrings(moduleIds, resolvedIds) ||
    !sameStrings(
      report.modulePackages.map(({ id }) => id),
      moduleIds,
    ) ||
    !sameStrings(
      report.runtimePackages.map(({ packagePath }) => packagePath),
      [...report.runtimePackages.map(({ packagePath }) => packagePath)].sort(),
    ) ||
    new Set(report.runtimePackages.map(({ packagePath }) => packagePath)).size !==
      report.runtimePackages.length ||
    !sameStrings(
      report.browserFiles.map(({ path: filePath }) => filePath),
      [...report.browserFiles.map(({ path: filePath }) => filePath)].sort(),
    ) ||
    new Set(report.browserFiles.map(({ path: filePath }) => filePath)).size !==
      report.browserFiles.length ||
    !sameStrings(nativeIds, sortedNativeIds) ||
    new Set(report.serverModuleIds).size !== report.serverModuleIds.length ||
    new Set(report.browserModuleIds).size !== report.browserModuleIds.length
  )
    throw new Error("producer build artifact report is not bound to the composition manifest");
  for (const item of report.modulePackages) {
    if (item.packagePath !== "/app/node_modules/@scriptorium/module-" + item.id) {
      throw new Error("producer module report path is not a canonical installed package path");
    }
  }
}

function samePersistence(
  left: NonNullable<CompositionManifest["persistence"]>,
  right: CompositionManifest["persistence"],
): boolean {
  if (!right) return false;
  const normalize = (value: NonNullable<CompositionManifest["persistence"]>) => ({
    contractVersion: value.contractVersion,
    readable: [...value.readable]
      .map(({ formatId, versions }) => ({
        formatId,
        versions: [...versions].sort((a, b) => a - b),
      }))
      .sort((a, b) => (a.formatId < b.formatId ? -1 : a.formatId > b.formatId ? 1 : 0)),
    writable: [...value.writable]
      .map(({ formatId, version }) => ({ formatId, version }))
      .sort((a, b) => (a.formatId < b.formatId ? -1 : a.formatId > b.formatId ? 1 : 0)),
  });
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

async function verifyModulePackageClosure(
  root: string,
  manifest: CompositionManifest,
  signal: AbortSignal,
): Promise<BuildArtifactReport["modulePackages"][number][]> {
  const modulesDirectory = rootPath(root, "/app/node_modules/@scriptorium");
  const modulesRealPath = await realpath(modulesDirectory);
  const rootRealPath = await realpath(root);
  if (!isWithin(rootRealPath, modulesRealPath))
    throw new Error("installed Scriptorium packages escape the image rootfs");
  const actualModules: BuildArtifactReport["modulePackages"][number][] = [];
  let totalBytes = 0;
  let totalFiles = 0;
  for (const entry of await readdir(modulesDirectory, { withFileTypes: true })) {
    ensureNotAborted(signal);
    if (!entry.name.startsWith("module-") || entry.name === "module-runtime") continue;
    const id = entry.name.slice("module-".length);
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(id))
      throw new Error("installed module package name is invalid");
    const packageDirectory = path.join(modulesDirectory, entry.name);
    const packageRoot = await realpath(packageDirectory);
    if (!isWithin(rootRealPath, packageRoot))
      throw new Error("installed module package escapes the image rootfs");
    const packageJsonPath = path.join(packageRoot, "package.json");
    const packageManifestBytes = await readRegularFile(packageJsonPath, 1024 * 1024, signal);
    const packageManifest: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(packageManifestBytes),
    );
    if (
      typeof packageManifest !== "object" ||
      packageManifest === null ||
      Array.isArray(packageManifest)
    ) {
      throw new Error("installed module package manifest is invalid");
    }
    const packageRecord = packageManifest as Record<string, unknown>;
    const identity = manifest.resolvedModules.find((module) => module.id === id);
    if (
      !identity ||
      packageRecord.name !== `@scriptorium/module-${id}` ||
      packageRecord.version !== identity.version ||
      typeof packageRecord.scriptoriumModule !== "object" ||
      packageRecord.scriptoriumModule === null ||
      (packageRecord.scriptoriumModule as Record<string, unknown>).id !== id
    ) {
      throw new Error("installed module package identity differs from the composition manifest");
    }
    const entries: Array<[string, string]> = [
      [
        "package.json",
        await sha256Digest(packageManifestBytes).then((value) => value.slice("sha256:".length)),
      ],
    ];
    const distRoot = path.join(packageRoot, "dist");
    const distInfo = await lstat(distRoot);
    if (!distInfo.isDirectory() || distInfo.isSymbolicLink())
      throw new Error("installed module dist directory is invalid");
    const pending = [{ directory: distRoot, relative: "dist" }];
    while (pending.length > 0) {
      const current = pending.pop()!;
      for (const child of await readdir(current.directory, { withFileTypes: true })) {
        ensureNotAborted(signal);
        totalFiles += 1;
        if (totalFiles > MAX_PACKAGE_FILES)
          throw new Error("installed module packages contain too many files");
        const childPath = path.join(current.directory, child.name);
        const relative = `${current.relative}/${child.name}`;
        const info = await lstat(childPath);
        if (info.isSymbolicLink()) throw new Error("installed module dist contains a symlink");
        if (info.isDirectory()) {
          pending.push({ directory: childPath, relative });
          continue;
        }
        if (!info.isFile()) throw new Error("installed module dist contains a special file");
        totalBytes += info.size;
        if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_PACKAGE_BYTES) {
          throw new Error("installed module package payload exceeds the inspection size bound");
        }
        entries.push([
          relative,
          await hashFile(childPath, signal).then((value) => value.slice("sha256:".length)),
        ]);
      }
    }
    entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    actualModules.push({
      id,
      version: identity.version,
      artifactDigest: identity.artifactDigest as Sha256Digest,
      packagePath: "/app/node_modules/@scriptorium/module-" + id,
    });
    const artifactDigest = `sha256:${createHash("sha256").update(JSON.stringify(entries), "utf8").digest("hex")}`;
    if (artifactDigest !== identity.artifactDigest)
      throw new Error("installed module package bytes differ from the catalog artifact digest");
  }
  actualModules.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const expectedIds = manifest.resolvedModules.map(({ id }) => id).sort();
  const actualIds = actualModules.map(({ id }) => id);
  if (!sameStrings(actualIds, expectedIds))
    throw new Error("installed module package closure differs from the composition manifest");
  return actualModules;
}

async function readRegularFile(
  filename: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (signal?.aborted) throw signal.reason ?? new Error("composition inspection was canceled");
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maxBytes) {
    throw new Error("image file is missing or outside the configured size bound");
  }
  return signal ? readFile(filename, { signal }) : readFile(filename);
}

async function verifyRegularImageEntry(root: string, entry: string): Promise<void> {
  const rootRealPath = await realpath(root);
  const filename = rootPath(rootRealPath, `/${entry}`);
  const target = await realpath(filename);
  if (!isWithin(rootRealPath, target))
    throw new Error("composition entry points outside the exported rootfs");
  const info = await stat(target);
  if (!info.isFile() || info.size < 1)
    throw new Error("composition entry is not a regular non-empty file");
}

async function verifyServerRegistry(
  root: string,
  manifest: CompositionManifest,
  signal: AbortSignal,
): Promise<readonly string[]> {
  const bytes = await readRootFile(root, SERVER_REGISTRY_PATH, MAX_REGISTRY_BYTES, signal);
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!source.split("\n").includes('export const profile = "hosted";')) {
    throw new Error("server registry was not generated for the hosted composition");
  }
  const moduleManifests = parseFrozenJsonExport(source, "moduleManifests");
  if (!Array.isArray(moduleManifests))
    throw new Error("server registry module manifests are invalid");
  const manifestIds = moduleManifests
    .filter((value) => {
      if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new Error("server module manifest is invalid");
      return (value as Record<string, unknown>).serverEntry !== undefined;
    })
    .map((value) => {
      if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new Error("server module manifest is invalid");
      const id = (value as Record<string, unknown>).id;
      if (typeof id !== "string") throw new Error("server module manifest id is invalid");
      return id;
    })
    .sort();
  const loaderIds = parseLoaderIds(source, "moduleLoaders");
  const expectedIds = [...manifest.server.moduleIds].sort();
  const expectedVersions = new Map(
    manifest.resolvedModules.map(({ id, version }) => [id, version]),
  );
  if (
    !sameStrings(manifestIds, expectedIds) ||
    !sameStrings(loaderIds, expectedIds) ||
    moduleManifests.some((value) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return true;
      const record = value as Record<string, unknown>;
      return typeof record.id !== "string" || record.version !== expectedVersions.get(record.id);
    })
  ) {
    throw new Error("server registry modules differ from the composition manifest");
  }
  return loaderIds;
}

function parseFrozenJsonExport(source: string, name: string): unknown {
  const startMarker = `export const ${name} = Object.freeze(`;
  const markerIndex = source.indexOf(startMarker);
  if (markerIndex < 0) throw new Error(`server registry does not export ${name}`);
  const jsonStart = markerIndex + startMarker.length;
  const startCharacter = source[jsonStart];
  if (startCharacter !== "[" && startCharacter !== "{")
    throw new Error(`server registry ${name} export is invalid`);
  const end = findJsonEnd(source, jsonStart);
  if (source.slice(end + 1, end + 3) !== ");")
    throw new Error(`server registry ${name} export is invalid`);
  return JSON.parse(source.slice(jsonStart, end + 1)) as unknown;
}

function findJsonEnd(source: string, start: number): number {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "[" || character === "{") stack.push(character);
    else if (character === "]" || character === "}") {
      const opening = stack.pop();
      if ((character === "]" && opening !== "[") || (character === "}" && opening !== "{")) {
        throw new Error("server registry JSON export is unbalanced");
      }
      if (stack.length === 0) return index;
    }
  }
  throw new Error("server registry JSON export is incomplete");
}

function parseLoaderIds(source: string, name: string): string[] {
  const marker = `export const ${name} = Object.freeze({\n`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`server registry does not export ${name}`);
  const end = source.indexOf("\n});", start + marker.length);
  if (end < 0) throw new Error(`server registry ${name} export is incomplete`);
  const body = source.slice(start + marker.length, end);
  const ids = [...body.matchAll(/^ {2}"([a-z][a-z0-9-]{0,63})": async \(context\) => \{$/gmu)].map(
    (match) => match[1]!,
  );
  return ids.sort();
}

export async function verifyBrowserArtifacts(
  root: string,
  manifest: CompositionManifest,
  report: Pick<
    BuildArtifactReport,
    "browserBundleDigest" | "browserFiles" | "browserRegistryPath" | "browserManifestPath"
  >,
  signal: AbortSignal,
): Promise<readonly string[]> {
  ensureNotAborted(signal);
  if (
    report.browserRegistryPath !== BROWSER_REGISTRY_PATH ||
    report.browserManifestPath !== BROWSER_MANIFEST_PATH
  ) {
    throw new Error("browser artifact paths differ from the hosted runtime contract");
  }
  const moduleIds = [...manifest.browser.moduleIds].sort();
  const registryBytes = await readRootFile(root, BROWSER_REGISTRY_PATH, MAX_REGISTRY_BYTES, signal);
  const registry = new TextDecoder("utf-8", { fatal: true }).decode(registryBytes);
  const expectedRegistry = [
    'export const profile = "hosted";',
    "export const moduleBrowserLoaders = Object.freeze({",
    ...moduleIds.map((id) =>
      [
        `  ${JSON.stringify(id)}: async () => {`,
        `    const module = await import(${JSON.stringify(`@scriptorium/module-${id}/browser`)});`,
        `    if (!module.browserModule) throw new TypeError(${JSON.stringify(`@scriptorium/module-${id}/browser must export browserModule`)});`,
        "    return module.browserModule;",
        "  },",
      ].join("\n"),
    ),
    "});",
    "",
  ].join("\n");
  if (registry !== expectedRegistry)
    throw new Error("browser registry imports differ from the selected module composition");

  const manifestBytes = await readRootFile(root, BROWSER_MANIFEST_PATH, MAX_REGISTRY_BYTES, signal);
  const manifestValue: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes),
  );
  if (!isRecord(manifestValue)) throw new Error("Vite browser manifest is invalid");
  const applicationEntry = manifestValue["index.html"];
  if (
    !isRecord(applicationEntry) ||
    applicationEntry.isEntry !== true ||
    applicationEntry.file !== "main.js"
  ) {
    throw new Error("Vite browser manifest has no canonical application entry");
  }
  const expectedSources = moduleIds.map((id) => `../modules/${id}/dist/browser.js`).sort();
  const dynamicImports = stringArray(
    applicationEntry.dynamicImports,
    "Vite application dynamic imports",
    true,
  ).sort();
  if (!sameStrings(dynamicImports, expectedSources))
    throw new Error("Vite application imports an unexpected browser module set");
  const dynamicEntries = Object.entries(manifestValue).filter(
    ([, entry]) => isRecord(entry) && entry.isDynamicEntry === true,
  );
  const dynamicSources = dynamicEntries
    .map(([key, entry]) => {
      if (!isRecord(entry)) throw new Error("Vite browser dynamic entry is invalid");
      return typeof entry.src === "string" ? entry.src : key;
    })
    .sort();
  if (!sameStrings(dynamicSources, expectedSources))
    throw new Error("Vite manifest contains an unexpected browser module chunk");

  const stylesheetEntry = manifestValue["style.css"];
  if (stylesheetEntry !== undefined) {
    if (
      !isRecord(stylesheetEntry) ||
      stylesheetEntry.file !== "styles.css" ||
      stylesheetEntry.src !== "style.css"
    ) {
      throw new Error("Vite manifest contains an unexpected standalone stylesheet entry");
    }
  }

  const reachable = new Set<string>();
  const visited = new Set<string>();
  const pending = ["index.html"];
  while (pending.length > 0) {
    ensureNotAborted(signal);
    const key = pending.pop()!;
    if (visited.has(key)) continue;
    visited.add(key);
    const entry = manifestValue[key];
    if (!isRecord(entry) || typeof entry.file !== "string")
      throw new Error(`Vite browser manifest entry is missing: ${key}`);
    reachable.add(validateBrowserOutputPath(entry.file));
    for (const css of stringArray(entry.css, "Vite CSS output", true))
      reachable.add(validateBrowserOutputPath(css));
    pending.push(...stringArray(entry.imports, "Vite static imports", true));
    pending.push(...stringArray(entry.dynamicImports, "Vite dynamic imports", true));
  }
  if (stylesheetEntry !== undefined) reachable.add(validateBrowserOutputPath("styles.css"));

  const manifestFiles = new Set<string>();
  const manifestJavascript = new Set<string>();
  for (const [key, entry] of Object.entries(manifestValue)) {
    if (!isRecord(entry)) throw new Error(`Vite browser manifest entry is invalid: ${key}`);
    if (typeof entry.file === "string") {
      const file = validateBrowserOutputPath(entry.file);
      if (/\.(?:m?js|css)$/u.test(file)) manifestFiles.add(file);
      if (/\.m?js$/u.test(file)) manifestJavascript.add(file);
    }
    for (const css of stringArray(entry.css, "Vite CSS output", true))
      manifestFiles.add(validateBrowserOutputPath(css));
  }
  const reachableJavascript = [...reachable].filter((file) => /\.m?js$/u.test(file)).sort();
  if (!sameStrings([...manifestJavascript].sort(), reachableJavascript)) {
    throw new Error(
      "Vite manifest contains JavaScript chunks outside the selected browser closure",
    );
  }
  const expectedFiles = [...manifestFiles].sort();
  const reachableFiles = [...reachable].filter((file) => /\.(?:m?js|css)$/u.test(file)).sort();
  if (!sameStrings(reachableFiles, expectedFiles)) {
    throw new Error(
      "Vite manifest contains JavaScript or CSS outputs outside the selected browser closure",
    );
  }
  const distDirectory = await resolveRootDirectory(root, "/app/app/dist");
  const emittedFiles = await listBrowserOutputs(distDirectory, signal);
  if (!sameStrings(emittedFiles, expectedFiles))
    throw new Error("browser output contains unlisted JavaScript or CSS files");
  const expectedReport = expectedFiles.map((file) => `/app/app/dist/${file}`);
  if (
    !sameStrings(
      report.browserFiles.map(({ path: file }) => file),
      expectedReport,
    )
  ) {
    throw new Error("producer browser file report differs from the Vite manifest output set");
  }
  const reportByPath = new Map(report.browserFiles.map(({ path: file, digest }) => [file, digest]));
  for (const file of expectedFiles) {
    ensureNotAborted(signal);
    const absolutePath = `/app/app/dist/${file}`;
    const filename = await resolveRootRegularFile(root, absolutePath, MAX_BROWSER_BYTES);
    if ((await hashFile(filename, signal)) !== reportByPath.get(absolutePath)) {
      throw new Error(`browser output bytes differ from the producer report: ${file}`);
    }
  }
  const browserBundle = reportByPath.get(`/${manifest.browser.entry}`);
  if (browserBundle !== report.browserBundleDigest)
    throw new Error("browser entry digest differs from the producer report");
  return moduleIds;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, label: string, allowMissing: boolean): string[] {
  if (value === undefined && allowMissing) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} are invalid`);
  }
  return value as string[];
}

function validateBrowserOutputPath(value: string): string {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ||
    path.posix.normalize(value) !== value ||
    !/^[A-Za-z0-9._/-]+$/u.test(value)
  )
    throw new Error("Vite browser output path is invalid");
  return value;
}

async function resolveRootDirectory(root: string, absolutePath: string): Promise<string> {
  const rootRealPath = await realpath(root);
  const target = await realpath(rootPath(rootRealPath, absolutePath));
  if (!isWithin(rootRealPath, target) || !(await stat(target)).isDirectory()) {
    throw new Error("browser output directory is missing or escapes the exported image rootfs");
  }
  return target;
}

async function listBrowserOutputs(directory: string, signal: AbortSignal): Promise<string[]> {
  const outputs: string[] = [];
  const pending = [{ absolute: directory, relative: "" }];
  let walked = 0;
  while (pending.length > 0) {
    ensureNotAborted(signal);
    const current = pending.pop()!;
    for (const entry of await readdir(current.absolute, { withFileTypes: true })) {
      ensureNotAborted(signal);
      walked += 1;
      if (walked > MAX_PACKAGE_FILES) throw new Error("browser output contains too many files");
      const relative = current.relative === "" ? entry.name : `${current.relative}/${entry.name}`;
      if (current.relative === "" && entry.name === ".vite") {
        if (!entry.isDirectory() || entry.isSymbolicLink())
          throw new Error("Vite metadata directory is invalid");
        continue;
      }
      if (entry.isSymbolicLink()) throw new Error("browser output contains a symlink");
      const absolute = path.join(current.absolute, entry.name);
      if (entry.isDirectory()) pending.push({ absolute, relative });
      else if (entry.isFile() && /\.(?:m?js|css)$/u.test(entry.name))
        outputs.push(validateBrowserOutputPath(relative));
      else if (!entry.isFile()) throw new Error("browser output contains a special file");
    }
  }
  return outputs.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

type NativeDependency = CompositionManifest["nativeDependencies"][number];

async function scanNativeDependencies(
  root: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<NativeDependency[]> {
  const dependencies: NativeDependency[] = [];
  const nativeRoot = await realpath(rootPath(root, "/app/node_modules"));
  const rootAbsolute = await realpath(root);
  if (!isWithin(rootAbsolute, nativeRoot))
    throw new Error("runtime node_modules escapes the exported rootfs");
  const pending = [nativeRoot];
  const visited = new Set<string>();
  let walked = 0;
  let nativeBytes = 0;
  while (pending.length > 0) {
    ensureNotAborted(signal);
    const directory = pending.pop()!;
    const resolvedDirectory = await realpath(directory);
    if (!isWithin(nativeRoot, resolvedDirectory))
      throw new Error("node_modules directory symlink escapes its root");
    if (visited.has(resolvedDirectory)) continue;
    visited.add(resolvedDirectory);
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      ensureNotAborted(signal);
      walked += 1;
      if (walked > 1_000_000) throw new Error("OCI rootfs contains too many files to inspect");
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(filename);
        continue;
      }
      if (entry.isSymbolicLink()) {
        const target = await realpath(filename);
        if (!isWithin(nativeRoot, target)) throw new Error("node_modules symlink escapes its root");
        const targetInfo = await stat(target);
        if (targetInfo.isDirectory()) pending.push(filename);
        else if (targetInfo.isFile() && isNativePath(entry.name)) {
          dependencies.push(
            await nativeDependency(rootAbsolute, nativeRoot, filename, target, signal),
          );
        }
      } else if (entry.isFile() && isNativePath(entry.name)) {
        dependencies.push(
          await nativeDependency(rootAbsolute, nativeRoot, filename, filename, signal),
        );
      }
      if (dependencies.length > MAX_NATIVE_FILES)
        throw new Error("OCI rootfs contains too many native dependencies");
      if (entry.isFile() || entry.isSymbolicLink()) {
        const info = await stat(filename);
        if (isNativePath(entry.name)) {
          nativeBytes += info.size;
          if (!Number.isSafeInteger(nativeBytes) || nativeBytes > maxBytes) {
            throw new Error("OCI native dependencies exceed the verified image byte bound");
          }
        }
      }
    }
  }
  dependencies.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  if (new Set(dependencies.map(({ id }) => id)).size !== dependencies.length) {
    throw new Error("OCI rootfs has duplicate native dependency identities");
  }
  return dependencies;
}

function isNativePath(filename: string): boolean {
  return /(?:\.node|\.wasm|\.so(?:\.[0-9]+)*|\.dylib|\.dll)$/u.test(filename);
}

async function nativeDependency(
  root: string,
  nativeRoot: string,
  filename: string,
  target: string,
  signal: AbortSignal,
): Promise<NativeDependency> {
  const packageRoot = await findOwningPackageRoot(root, nativeRoot, filename, signal);
  const packageBytes = await readRootFile(
    root,
    `/${path.relative(root, path.join(packageRoot, "package.json")).split(path.sep).join("/")}`,
    1024 * 1024,
    signal,
  );
  const packageManifest = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(packageBytes),
  ) as unknown;
  if (
    typeof packageManifest !== "object" ||
    packageManifest === null ||
    Array.isArray(packageManifest)
  ) {
    throw new Error("native dependency package manifest is invalid");
  }
  const record = packageManifest as Record<string, unknown>;
  if (typeof record.name !== "string" || typeof record.version !== "string") {
    throw new Error("native dependency package identity is invalid");
  }
  const relativePath = path.relative(packageRoot, filename).split(path.sep).join("/");
  if (!relativePath || relativePath.startsWith("../") || path.isAbsolute(relativePath)) {
    throw new Error("native dependency path is outside its package root");
  }
  return {
    id: `${record.name}/${relativePath}`,
    version: record.version,
    artifactDigest: await hashFile(target, signal),
  };
}

async function findOwningPackageRoot(
  root: string,
  nativeRoot: string,
  filename: string,
  signal: AbortSignal,
): Promise<string> {
  let directory = path.dirname(filename);
  while (isWithin(nativeRoot, directory) && directory !== nativeRoot) {
    ensureNotAborted(signal);
    try {
      const manifest = await lstat(path.join(directory, "package.json"));
      if (manifest.isFile() && !manifest.isSymbolicLink()) return directory;
    } catch {
      // Continue to the nearest package manifest in the extracted rootfs.
    }
    directory = path.dirname(directory);
  }
  throw new Error("native dependency is not owned by an installed package");
}

async function hashFile(filename: string, signal?: AbortSignal): Promise<Sha256Digest> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename, signal ? { signal } : undefined))
    hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

function ensureNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("composition inspection was canceled");
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
