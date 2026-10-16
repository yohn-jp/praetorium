import { spawn } from "node:child_process";
import type { BuildProgress } from "@praetorium/application/builds";
import { BuildKitAttemptError, type BuildKitProviderConfig } from "./types.js";

export type BuildctlRunOptions = {
  cwd: string;
  dockerConfigDirectory: string;
  temporaryDirectory: string;
  safePath: string;
  buildTimeoutMs: number;
  maxProgressBytes: number;
  signal: AbortSignal;
  onProgress: (progress: BuildProgress) => void;
};

export type BuildctlRunner = (
  args: readonly string[],
  options: BuildctlRunOptions,
) => Promise<void>;

type RawVertex = {
  completed?: string | number | null;
  cached?: boolean;
  error?: string;
};

function progressFromJsonLine(line: string): BuildProgress | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.vertexes) || record.vertexes.length === 0) return null;
  let completed = 0;
  for (const item of record.vertexes as RawVertex[]) {
    if (item && (typeof item.completed === "string" || typeof item.completed === "number" || item.cached === true)) {
      completed++;
    }
  }
  return {
    stage: "building",
    percent: Math.max(0, Math.min(99, Math.floor((completed / record.vertexes.length) * 100))),
  };
}

export function createBuildctlRunner(config: Pick<BuildKitProviderConfig, "buildctlPath">): BuildctlRunner {
  return (args, options) => new Promise<void>((resolve, reject) => {
    if (options.signal.aborted) {
      reject(new BuildKitAttemptError("BUILD_CANCELED", true));
      return;
    }

    const environment: NodeJS.ProcessEnv = {
      DOCKER_CONFIG: options.dockerConfigDirectory,
      HOME: options.temporaryDirectory,
      LANG: "C",
      PATH: options.safePath,
      TMPDIR: options.temporaryDirectory,
    };
    const child = spawn(config.buildctlPath, [...args], {
      cwd: options.cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });

    let totalBytes = 0;
    let lineBuffer = "";
    let terminalReason: "timeout" | "canceled" | "output-limit" | null = null;
    let killTimer: NodeJS.Timeout | undefined;
    let settled = false;

    const failOnce = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const terminate = (reason: "timeout" | "canceled" | "output-limit"): void => {
      if (terminalReason !== null) return;
      terminalReason = reason;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 3_000);
      killTimer.unref();
    };
    const onAbort = (): void => terminate("canceled");
    options.signal.addEventListener("abort", onAbort, { once: true });
    const timeoutTimer = setTimeout(() => terminate("timeout"), options.buildTimeoutMs);
    timeoutTimer.unref();

    const consume = (chunk: Buffer, isStdout: boolean): void => {
      totalBytes += chunk.byteLength;
      if (totalBytes > options.maxProgressBytes) {
        terminate("output-limit");
        return;
      }
      if (!isStdout) return;
      lineBuffer += chunk.toString("utf8");
      if (lineBuffer.length > 64 * 1024 && !lineBuffer.includes("\n")) {
        terminate("output-limit");
        return;
      }
      let newline = lineBuffer.indexOf("\n");
      while (newline >= 0) {
        const line = lineBuffer.slice(0, newline);
        lineBuffer = lineBuffer.slice(newline + 1);
        if (line.length > 64 * 1024) {
          terminate("output-limit");
          return;
        }
        const progress = progressFromJsonLine(line);
        if (progress) options.onProgress(progress);
        newline = lineBuffer.indexOf("\n");
      }
    };

    child.stdout.on("data", (chunk: Buffer) => consume(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => consume(chunk, false));
    child.once("error", () => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      options.signal.removeEventListener("abort", onAbort);
      failOnce(new BuildKitAttemptError("BUILD_FAILED", true));
    });
    child.once("close", (code) => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      options.signal.removeEventListener("abort", onAbort);
      if (settled) return;
      if (terminalReason === "timeout") {
        failOnce(new BuildKitAttemptError("BUILD_TIMEOUT", true));
      } else if (terminalReason === "canceled" || options.signal.aborted) {
        failOnce(new BuildKitAttemptError("BUILD_CANCELED", true));
      } else if (terminalReason === "output-limit" || code !== 0) {
        failOnce(new BuildKitAttemptError("BUILD_FAILED", terminalReason === "output-limit"));
      } else {
        if (lineBuffer.length > 0) {
          if (lineBuffer.length > 64 * 1024) {
            failOnce(new BuildKitAttemptError("BUILD_FAILED", true));
            return;
          }
          const progress = progressFromJsonLine(lineBuffer);
          if (progress) options.onProgress(progress);
        }
        resolve();
      }
    });
  });
}
