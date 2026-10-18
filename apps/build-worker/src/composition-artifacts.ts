import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  BuildInputSchema,
  CompositionManifestSchema,
  buildKey,
  canonicalBuildInput,
  validateCompositionBindings,
  type BuildInput,
  type CompositionManifest,
} from "@praetorium/contracts";
import { BuildKitAttemptError, BuildKitImageRootfsExporter } from "@praetorium/buildkit";
import type { BuildCandidateReceiptReader, BuildKitProviderConfig } from "@praetorium/buildkit";
import { sha256Digest, type Sha256Digest, type GhcrRegistryClient } from "@praetorium/ghcr";

const COMPOSITION_PATH = "/usr/share/scriptorium/composition-manifest.json";
const MAX_COMPOSITION_BYTES = 4 * 1024 * 1024;
export type BuildKitRootfsExporter = Pick<BuildKitImageRootfsExporter, "exportImage">;
export type CompositionRegistry = Pick<GhcrRegistryClient, "registryHost" | "publishBlob">;

/** Retrieves trusted producer composition metadata from the immutable image without exporting the full rootfs. */
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
      { imageReference, platform: input.expectedInput.platform, filePath: COMPOSITION_PATH },
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


function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

