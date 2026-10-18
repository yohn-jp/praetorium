import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createBuildctlRunner, type BuildctlRunner } from "./buildctl.js";
import type { BuildKitProviderConfig } from "./types.js";
import { BuildKitAttemptError } from "./types.js";

const IMAGE_REFERENCE =
  /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[1-9][0-9]{0,4})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[a-f0-9]{64}$/u;
const MAX_EXPORTED_FILE_BYTES = 4 * 1024 * 1024;

export type BuildKitImageFile = {
  readonly bytes: Uint8Array;
};

/**
 * Read one bounded metadata file from an immutable, operator-produced OCI image.
 * No rootfs export, startup smoke, dependency scan, or whole-image copy occurs.
 */
export class BuildKitImageFileExporter {
  private readonly runBuildctl: BuildctlRunner;

  constructor(
    private readonly config: BuildKitProviderConfig,
    options: { readonly runBuildctl?: BuildctlRunner } = {},
  ) {
    this.runBuildctl = options.runBuildctl ?? createBuildctlRunner(config);
  }

  async exportFile(
    input: {
      readonly imageReference: string;
      readonly platform: "linux/amd64" | "linux/arm64";
      readonly filePath: string;
    },
    signal: AbortSignal,
  ): Promise<BuildKitImageFile> {
    if (
      !IMAGE_REFERENCE.test(input.imageReference) ||
      (input.platform !== "linux/amd64" && input.platform !== "linux/arm64") ||
      !/^\/[A-Za-z0-9._/-]{1,511}$/u.test(input.filePath) ||
      input.filePath.split("/").slice(1).some((part) => part === "" || part === "." || part === "..")
    ) {
      throw new TypeError("BuildKit metadata file export input is invalid");
    }
    if (signal.aborted) throw new BuildKitAttemptError("BUILD_CANCELED", true);

    const workingDirectory = await mkdtemp(
      path.join(this.config.temporaryDirectory, "praetorium-metadata-"),
    );
    try {
      const contextDirectory = path.join(workingDirectory, "context");
      const outputDirectory = path.join(workingDirectory, "output");
      await Promise.all([
        mkdir(contextDirectory, { mode: 0o700 }),
        mkdir(outputDirectory, { mode: 0o700 }),
      ]);
      await writeFile(
        path.join(contextDirectory, "Dockerfile"),
        [
          `FROM --platform=${input.platform} ${input.imageReference} AS candidate`,
          "FROM scratch",
          `COPY --from=candidate ${input.filePath} /receipt.json`,
          "",
        ].join("\n"),
        { mode: 0o600 },
      );

      await this.runBuildctl(
        [
          "--addr", this.config.address,
          "--tlsservername", this.config.tlsServerName,
          "--tlscacert", this.config.tlsCaFile,
          "--tlscert", this.config.tlsCertFile,
          "--tlskey", this.config.tlsKeyFile,
          "build",
          "--progress=rawjson",
          "--frontend", "dockerfile.v0",
          "--local", `context=${contextDirectory}`,
          "--local", `dockerfile=${contextDirectory}`,
          "--opt", "filename=Dockerfile",
          "--opt", `platform=${input.platform}`,
          "--output", `type=local,dest=${outputDirectory}`,
        ],
        {
          cwd: contextDirectory,
          dockerConfigDirectory: this.config.dockerConfigDirectory,
          temporaryDirectory: workingDirectory,
          safePath: this.config.safePath,
          buildTimeoutMs: this.config.buildTimeoutMs,
          maxProgressBytes: this.config.maxProgressBytes,
          signal,
          onProgress: () => undefined,
        },
      );
      if (signal.aborted) throw new BuildKitAttemptError("BUILD_CANCELED", true);
      const outputFile = path.join(outputDirectory, "receipt.json");
      const info = await lstat(outputFile);
      if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_EXPORTED_FILE_BYTES)
        throw new BuildKitAttemptError("BUILD_FAILED", false);
      const bytes = await readFile(outputFile, { signal });
      if (bytes.byteLength !== info.size || bytes.byteLength > MAX_EXPORTED_FILE_BYTES)
        throw new BuildKitAttemptError("BUILD_FAILED", false);
      return { bytes };
    } catch (error) {
      if (signal.aborted) throw new BuildKitAttemptError("BUILD_CANCELED", true);
      if (error instanceof BuildKitAttemptError) throw error;
      throw new BuildKitAttemptError("BUILD_FAILED", false);
    } finally {
      await rm(workingDirectory, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    }
  }
}
