import { lstat, readFile } from "node:fs/promises";

import {
  BuildInputSchema,
  CompositionManifestSchema,
  buildKey,
  canonicalBuildInput,
  validateCompositionBindings,
  type BuildInput,
  type CompositionManifest,
} from "@praetorium/contracts";
import { BuildKitAttemptError, BuildKitImageFileExporter } from "@praetorium/buildkit";
import type { BuildCandidateReceiptReader, BuildKitProviderConfig } from "@praetorium/buildkit";
import { sha256Digest, type Sha256Digest, type GhcrRegistryClient } from "@praetorium/ghcr";

const COMPOSITION_PATH = "/usr/share/scriptorium/composition-manifest.json";
const MAX_COMPOSITION_BYTES = 4 * 1024 * 1024;
export type BuildKitFileExporter = Pick<BuildKitImageFileExporter, "exportFile">;
export type CompositionRegistry = Pick<GhcrRegistryClient, "registryHost" | "publishBlob">;

/** Retrieves trusted producer composition metadata from the immutable image without exporting the full rootfs. */
export class ScriptoriumBuildCandidateReceiptReader implements BuildCandidateReceiptReader {
  private readonly fileExporter: BuildKitFileExporter;

  constructor(
    private readonly registry: CompositionRegistry,
    buildKitConfig: BuildKitProviderConfig,
    private readonly compositionRepository: string,
    options: { readonly fileExporter?: BuildKitFileExporter } = {},
  ) {
    this.fileExporter = options.fileExporter ?? new BuildKitImageFileExporter(buildKitConfig);
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
    // The trusted producer already verified module closure while composing this image.
    // Only retrieve the resulting metadata needed for runtime configuration.
    const { bytes } = await this.fileExporter.exportFile(
      { imageReference, platform: input.expectedInput.platform, filePath: COMPOSITION_PATH },
      input.signal ?? new AbortController().signal,
    );
    try {
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
    if (input.signal?.aborted) throw new BuildKitAttemptError("BUILD_CANCELED", true);
      const digest = await this.registry.publishBlob(
        this.compositionRepository,
        bytes,
        input.signal,
      );
      if (digest !== (await sha256Digest(bytes)))
        throw new BuildKitAttemptError("BUILD_FAILED", false);
      return { compositionManifest: { repository: this.compositionRepository, digest } };
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

