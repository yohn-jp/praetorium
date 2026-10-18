import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createBuildctlRunner, type BuildctlRunner } from "./buildctl.js";
import type { BuildKitProviderConfig } from "./types.js";
import { BuildKitAttemptError } from "./types.js";

const IMAGE_REFERENCE =
  /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[1-9][0-9]{0,4})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[a-f0-9]{64}$/u;
const MAX_STARTUP_ARGUMENT_BYTES = 16 * 1024;

export type BuildKitImageStartup = {
  readonly entrypoint: readonly string[];
  readonly command: readonly string[];
  readonly workingDirectory: string;
  readonly port: number;
  readonly healthPath: string;
  readonly metadataPath?: string;
  readonly timeoutMs: number;
};

export type BuildKitImageRootfs = {
  readonly imageRoot: string;
  readonly smokeResult: {
    readonly passed: true;
    readonly status: 200;
    readonly healthPath: string;
    readonly metadata?: unknown;
  } | null;
  dispose(): Promise<void>;
};

/**
 * Exports and inspects one digest-pinned image using the configured isolated
 * BuildKit worker. The temporary Dockerfile copies only that image's merged
 * rootfs and runs its configured entrypoint under BuildKit's networkless RUN
 * sandbox before the export can complete.
 */
export class BuildKitImageRootfsExporter {
  private readonly runBuildctl: BuildctlRunner;

  constructor(
    private readonly config: BuildKitProviderConfig,
    options: { readonly runBuildctl?: BuildctlRunner } = {},
  ) {
    this.runBuildctl = options.runBuildctl ?? createBuildctlRunner(config);
  }

  async exportImage(
    input: {
      readonly imageReference: string;
      readonly platform: "linux/amd64" | "linux/arm64";
      /** Restrict metadata-only exports to one file instead of transferring the full rootfs. */
      readonly filePath?: string;
      readonly startup?: BuildKitImageStartup;
    },
    signal: AbortSignal,
  ): Promise<BuildKitImageRootfs> {
    validateImageInput(input);
    if (signal.aborted) throw new BuildKitAttemptError("BUILD_CANCELED", true);

    const workingDirectory = await mkdtemp(
      path.join(this.config.temporaryDirectory, "praetorium-image-inspection-"),
    );
    try {
      const contextDirectory = path.join(workingDirectory, "context");
      const outputDirectory = path.join(workingDirectory, "output");
      const imageRoot = path.join(outputDirectory, "image");
      const markerName = `probe-${randomBytes(16).toString("hex")}.json`;
      const smokeFile = "praetorium-startup-smoke.mjs";
      const settingsFile = "praetorium-startup-settings.json";
      await Promise.all([
        mkdir(contextDirectory, { mode: 0o700 }),
        mkdir(outputDirectory, { mode: 0o700 }),
      ]);
      const smokeSettings = input.startup ? {
        command: [...input.startup.entrypoint, ...input.startup.command],
        workingDirectory: input.startup.workingDirectory || "/",
        port: input.startup.port,
        healthPath: input.startup.healthPath,
        ...(input.startup.metadataPath ? { metadataPath: input.startup.metadataPath } : {}),
        markerPath: `/tmp/${markerName}`,
        timeoutMs: input.startup.timeoutMs,
      } : undefined;
      if (smokeSettings) {
        await Promise.all([
          writeFile(path.join(contextDirectory, smokeFile), STARTUP_SMOKE_SOURCE, { mode: 0o600 }),
          writeFile(path.join(contextDirectory, settingsFile), JSON.stringify(smokeSettings), { mode: 0o600 }),
        ]);
      }
      const dockerfile = [
        `FROM --platform=${input.platform} ${input.imageReference} AS candidate`,
        ...(smokeSettings ? [
          "FROM candidate AS smoke",
          `COPY --chmod=0444 ${smokeFile} /${smokeFile}`,
          `COPY --chmod=0444 ${settingsFile} /${settingsFile}`,
          "ENV HOST=127.0.0.1 HOME=/tmp TMPDIR=/tmp SCRIPTORIUM_DATA_DIR=/data SCRIPTORIUM_USAGE_DIR=/history SCRIPTORIUM_HOSTED_MODE=0",
          `RUN --network=none node /${smokeFile} /${settingsFile}`,
        ] : []),
        "FROM scratch",
        ...(input.filePath
          ? [`COPY --from=candidate ${input.filePath} /image${input.filePath}`]
          : ["COPY --from=candidate / /image/"]),
        ...(smokeSettings ? [`COPY --from=smoke /tmp/${markerName} /smoke-result.json`] : []),
        "",
      ].join("\n");
      await writeFile(path.join(contextDirectory, "Dockerfile"), dockerfile, { mode: 0o600 });

      await this.runBuildctl(
        [
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
          "dockerfile.v0",
          "--local",
          `context=${contextDirectory}`,
          "--local",
          `dockerfile=${contextDirectory}`,
          "--opt",
          `filename=Dockerfile`,
          "--opt",
          `platform=${input.platform}`,
          "--output",
          `type=local,dest=${outputDirectory}`,
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
      let smokeResult: BuildKitImageRootfs["smokeResult"] = null;
      if (input.startup) {
        const value: unknown = JSON.parse(await readFile(path.join(outputDirectory, "smoke-result.json"), "utf8"));
        if (
          typeof value !== "object" ||
          value === null ||
          Array.isArray(value) ||
          (value as Record<string, unknown>).passed !== true ||
          (value as Record<string, unknown>).status !== 200 ||
          (value as Record<string, unknown>).healthPath !== input.startup.healthPath
        ) {
          throw new Error("startup smoke result is invalid");
        }
        const record = value as Record<string, unknown>;
        smokeResult = {
          passed: true,
          status: 200,
          healthPath: input.startup.healthPath,
          ...(record.metadata === undefined ? {} : { metadata: record.metadata }),
        };
      }
      return {
        imageRoot,
        smokeResult,
        dispose: async () => rm(workingDirectory, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }),
      };
    } catch (error) {
      await rm(workingDirectory, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      if (signal.aborted) throw new BuildKitAttemptError("BUILD_CANCELED", true);
      if (error instanceof BuildKitAttemptError) throw error;
      throw new BuildKitAttemptError("BUILD_FAILED", false);
    }
  }
}

function validSelectedFilePath(value: string): boolean {
  return /^\/[A-Za-z0-9._/-]{1,511}$/u.test(value) &&
    value.split("/").slice(1).every((part) => part !== "" && part !== "." && part !== "..");
}

function validateImageInput(input: {
  readonly imageReference: string;
  readonly platform: string;
  readonly filePath?: string;
  readonly startup?: BuildKitImageStartup;
}): void {
  const args = input.startup ? [...input.startup.entrypoint, ...input.startup.command] : [];
  const argumentBytes = args.reduce((total, value) => total + Buffer.byteLength(value, "utf8"), 0);
  if (
    !IMAGE_REFERENCE.test(input.imageReference) ||
    (input.platform !== "linux/amd64" && input.platform !== "linux/arm64") ||
    (input.filePath !== undefined && (input.startup !== undefined || !validSelectedFilePath(input.filePath))) ||
    (input.startup !== undefined && (
      args.length === 0 ||
      args.length > 128 ||
      args.some((value) => typeof value !== "string" || value.length === 0 || value.includes("\0")) ||
      argumentBytes > MAX_STARTUP_ARGUMENT_BYTES ||
      !input.startup.workingDirectory.startsWith("/") ||
      input.startup.workingDirectory.includes("\0") ||
      !Number.isSafeInteger(input.startup.port) ||
      input.startup.port < 1 ||
      input.startup.port > 65_535 ||
      !/^\/(?!\/)[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/u.test(input.startup.healthPath) ||
      (input.startup.metadataPath !== undefined &&
        !/^\/(?!\/)[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/u.test(input.startup.metadataPath)) ||
      !Number.isSafeInteger(input.startup.timeoutMs) ||
      input.startup.timeoutMs < 1_000 ||
      input.startup.timeoutMs > 300_000
    ))
  ) {
    throw new TypeError("BuildKit image startup input is invalid");
  }
}

const STARTUP_SMOKE_SOURCE = String.raw`import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

const settings = JSON.parse(await readFile(process.argv[2], "utf8"));
if (!Array.isArray(settings.command) || settings.command.length === 0) throw new Error("image command missing");
// This checks standalone startup and public health only. Hosted authorization is verified by the Hosted product runner.
const runtimeEnvironment = {
  ...process.env,
  HOST: "127.0.0.1",
  PORT: String(settings.port),
  SCRIPTORIUM_HOSTED_MODE: "0",
  SCRIPTORIUM_AUTH_TOKEN: randomBytes(32).toString("base64url"),
};
delete runtimeEnvironment.SCRIPTORIUM_GITHUB_TOKEN;
delete runtimeEnvironment.SCRIPTORIUM_RUNTIME_ASSIGNMENT_PATH;
delete runtimeEnvironment.SCRIPTORIUM_RUNTIME_IDENTITY_PATH;
const child = spawn(settings.command[0], settings.command.slice(1), {
  cwd: settings.workingDirectory,
  env: runtimeEnvironment,
  stdio: ["ignore", "ignore", "ignore"],
  shell: false,
  windowsHide: true,
});
let exited = false;
let childError;
let resolveExit;
const childExit = new Promise((resolve) => { resolveExit = resolve; });
child.once("error", (error) => { exited = true; childError = error; resolveExit(); });
child.once("close", (code, signal) => {
  exited = true;
  if (code !== 0) childError = new Error("runtime exited (" + (code ?? signal ?? "unknown") + ")");
  resolveExit();
});
function get(path) {
  return new Promise((resolve) => {
    const req = request({ hostname: "127.0.0.1", port: settings.port, path, method: "GET" }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024) {
          response.destroy();
          resolve({ status: 0, body: null });
        } else chunks.push(chunk);
      });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", () => resolve({ status: 0, body: null }));
    });
    req.setTimeout(500, () => req.destroy());
    req.on("error", () => resolve({ status: 0, body: null }));
    req.end();
  });
}
try {
  const deadline = Date.now() + settings.timeoutMs;
  let health;
  while (Date.now() < deadline) {
    if (exited) throw childError ?? new Error("runtime exited before readiness");
    health = await get(settings.healthPath);
    if (health.status === 200) break;
    await delay(100);
  }
  if (health?.status !== 200) throw new Error("runtime health endpoint did not return HTTP 200");
  let metadata;
  if (settings.metadataPath) {
    const response = await get(settings.metadataPath);
    if (response.status !== 200 || response.body === null) throw new Error("runtime metadata endpoint did not return HTTP 200");
    metadata = JSON.parse(response.body);
  }
  if (exited) throw childError ?? new Error("runtime exited during readiness verification");
  await writeFile(settings.markerPath, JSON.stringify({ passed: true, status: 200, healthPath: settings.healthPath, ...(metadata === undefined ? {} : { metadata }) }), { mode: 0o644 });
} finally {
  if (!exited) {
    child.kill("SIGTERM");
    const stopped = await Promise.race([childExit.then(() => true), delay(3000).then(() => false)]);
    if (!stopped) {
      child.kill("SIGKILL");
      await childExit;
    }
  }
}
`;
