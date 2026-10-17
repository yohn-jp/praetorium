import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BuildInputSchema,
  buildKey,
  canonicalBuildInput,
  BuildCandidateSchema,
} from "@praetorium/contracts";
import type {
  BuildCandidate,
  BuildExecutionRequest,
  BuildProgress,
  BuildProvider,
} from "@praetorium/application/builds";
import { createBuildctlRunner, type BuildctlRunner } from "./buildctl.js";
import { validateBuildKitFiles } from "./config.js";
import {
  BuildKitAttemptError,
  UnsupportedProducerRecipeError,
  type BuildCandidateReceiptReader,
  type BuildKitProviderConfig,
} from "./types.js";

const FRONTEND_INPUT_OPTION = "scriptorium.build-input.v1";
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const ATTEMPT_ID = /^[A-Za-z0-9._:-]{1,256}$/u;

function metadataDigest(raw: string): string {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new BuildKitAttemptError("BUILD_FAILED", true);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BuildKitAttemptError("BUILD_FAILED", true);
  }
  const digest = (value as Record<string, unknown>)["containerimage.digest"];
  if (typeof digest !== "string" || !IMAGE_DIGEST.test(digest)) {
    throw new BuildKitAttemptError("BUILD_FAILED", true);
  }
  return digest;
}

async function readMetadataDigest(file: string): Promise<string> {
  const info = await stat(file);
  if (!info.isFile() || info.size > 16 * 1024) throw new BuildKitAttemptError("BUILD_FAILED", true);
  const raw = await readFile(file, "utf8");
  return metadataDigest(raw);
}

function safeProgress(
  callback: ((value: BuildProgress) => void) | undefined,
  value: BuildProgress,
): void {
  try {
    callback?.(value);
  } catch {
    // Progress reporting does not affect solve correctness or leak raw BuildKit output.
  }
}

export class BuildKitProvider implements BuildProvider {
  private readonly runBuildctl: BuildctlRunner;

  constructor(
    private readonly config: BuildKitProviderConfig,
    options: { runBuildctl?: BuildctlRunner; receiptReader?: BuildCandidateReceiptReader } = {},
  ) {
    this.runBuildctl = options.runBuildctl ?? createBuildctlRunner(config);
    this.receiptReader = options.receiptReader;
  }

  private readonly receiptReader: BuildCandidateReceiptReader | undefined;

  async execute(
    request: BuildExecutionRequest,
    signal: AbortSignal,
    beforeEffect: () => Promise<void>,
  ): Promise<BuildCandidate> {
    const input = BuildInputSchema.parse(request.input);
    if (
      !ATTEMPT_ID.test(request.attemptId) ||
      !Number.isSafeInteger(request.leaseEpoch) ||
      request.leaseEpoch < 1 ||
      !Number.isSafeInteger(request.attempt) ||
      request.attempt < 1 ||
      request.buildId.length < 1 ||
      request.buildId.length > 128 ||
      !IMAGE_DIGEST.test(request.buildKey) ||
      (await buildKey(input)) !== request.buildKey
    ) {
      throw new TypeError("verified build request binding is invalid");
    }

    if (!this.receiptReader || !this.receiptReader.supports(input)) {
      throw new UnsupportedProducerRecipeError();
    }

    const canonicalInput = canonicalBuildInput(input);
    const encodedInput = Buffer.from(canonicalInput, "utf8").toString("base64url");
    if (Buffer.byteLength(encodedInput, "utf8") > this.config.maxBuildInputBytes) {
      throw new TypeError("build input exceeds the configured bound");
    }
    await validateBuildKitFiles(this.config);
    if (signal.aborted) throw new BuildKitAttemptError("BUILD_CANCELED", true);

    const attemptHash = await sha256(request.attemptId);
    const outputTag = `${this.config.outputRepository}:candidate-${request.buildKey.slice("sha256:".length)}-${attemptHash.slice(0, 20)}`;
    const frontendRef = `${this.config.buildkitRepository}@${input.buildKitDigest}`;
    const buildDirectory = await mkdtemp(
      path.join(this.config.temporaryDirectory, "praetorium-build-"),
    );
    const metadataFile = path.join(buildDirectory, "metadata.json");
    const args = [
      "--addr",
      this.config.address,
      "--tlsservername",
      this.config.tlsServerName,
      "--tlscacert",
      this.config.tlsCaFile,
      "--tlscert",
      this.config.tlsCertFile,
      "--tlskey",
      this.config.tlsKeyFile,
      "build",
      "--progress=rawjson",
      "--frontend",
      "gateway.v0",
      "--opt",
      `source=${frontendRef}`,
      "--opt",
      `${FRONTEND_INPUT_OPTION}=${encodedInput}`,
      "--output",
      `type=image,name=${outputTag},push=true`,
      "--metadata-file",
      metadataFile,
    ];
    const cwd = tmpdir();

    try {
      await beforeEffect();
      if (signal.aborted) throw new BuildKitAttemptError("BUILD_CANCELED", true);
      await this.runBuildctl(args, {
        cwd,
        dockerConfigDirectory: this.config.dockerConfigDirectory,
        temporaryDirectory: buildDirectory,
        safePath: this.config.safePath,
        buildTimeoutMs: this.config.buildTimeoutMs,
        maxProgressBytes: this.config.maxProgressBytes,
        signal,
        onProgress: (progress) => safeProgress(request.onProgress, progress),
      });
      if (signal.aborted) throw new BuildKitAttemptError("BUILD_CANCELED", true);
      safeProgress(request.onProgress, { stage: "publishing", percent: 99 });
      const manifestDigest = await readMetadataDigest(metadataFile);
      if (signal.aborted) throw new BuildKitAttemptError("BUILD_CANCELED", true);
      const receipt = await this.receiptReader.read({
        metadataFile,
        expectedInput: input,
        outputRepository: this.config.outputRepository,
        signal,
      });
      if (signal.aborted) throw new BuildKitAttemptError("BUILD_CANCELED", true);
      const result = BuildCandidateSchema.parse({
        candidateRef: `${this.config.outputRepository}@${manifestDigest}`,
        manifestDigest,
        compositionManifest: receipt.compositionManifest,
      });
      safeProgress(request.onProgress, { stage: "publishing", percent: 100 });
      return result;
    } catch (error) {
      if (error instanceof BuildKitAttemptError) throw error;
      if (signal.aborted) throw new BuildKitAttemptError("BUILD_CANCELED", true);
      throw new BuildKitAttemptError("BUILD_FAILED", true);
    } finally {
      await rm(buildDirectory, { force: true, recursive: true, maxRetries: 2, retryDelay: 100 });
    }
  }
}

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export { FRONTEND_INPUT_OPTION };
