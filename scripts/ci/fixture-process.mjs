import { spawn } from "node:child_process";
import path from "node:path";

export const FIXTURE_CHILD_OUTPUT_MAX_BYTES = 64 * 1024;
export const FIXTURE_EVIDENCE_MAX_BYTES = 16 * 1024;
export const FIXTURE_CHILD_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_TERMINATION_GRACE_MS = 5_000;

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class BoundedOutputTail {
  #chunks = [];
  #byteLength = 0;

  constructor(maxBytes = FIXTURE_CHILD_OUTPUT_MAX_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
      throw new RangeError("output tail limit must be a positive safe integer");
    this.maxBytes = maxBytes;
  }

  append(value) {
    const bytes = Buffer.from(value);
    if (!bytes.length) return;
    if (bytes.length >= this.maxBytes) {
      this.#chunks = [Buffer.from(bytes.subarray(bytes.length - this.maxBytes))];
      this.#byteLength = this.maxBytes;
      return;
    }
    this.#chunks.push(bytes);
    this.#byteLength += bytes.length;
    while (this.#byteLength > this.maxBytes) {
      const excess = this.#byteLength - this.maxBytes;
      const first = this.#chunks[0];
      if (first.length <= excess) {
        this.#chunks.shift();
        this.#byteLength -= first.length;
      } else {
        this.#chunks[0] = Buffer.from(first.subarray(excess));
        this.#byteLength -= excess;
      }
    }
  }

  get byteLength() {
    return this.#byteLength;
  }

  toBuffer() {
    return Buffer.concat(this.#chunks, this.#byteLength);
  }

  toString() {
    return this.toBuffer().toString("utf8");
  }
}

/** Strip common credential forms before diagnostics leave the disposable runner. */
export function sanitizeFixtureDiagnostic(value, maxBytes = FIXTURE_EVIDENCE_MAX_BYTES) {
  const sanitized = String(value)
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gu, "[REDACTED PEM]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/giu, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu, "$1[REDACTED]@")
    .replace(
      /source-stable-fixture-(?:gateway-secret|release-operator|build-worker-token)-[A-Za-z0-9_-]+/gu,
      "[REDACTED FIXTURE TOKEN]",
    );
  const bytes = Buffer.from(sanitized);
  return bytes.length > maxBytes
    ? bytes.subarray(bytes.length - maxBytes).toString("utf8")
    : sanitized;
}

function processGroupExists(pid) {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function signalProcessGroup(pid, signal) {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

/** Stop an owned detached subprocess group, escalating TERM to KILL. */
export async function stopProcessGroup(
  pid,
  { graceMs = DEFAULT_TERMINATION_GRACE_MS, pollMs = 50, finalWaitMs = 1_000 } = {},
) {
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  signalProcessGroup(pid, "SIGTERM");
  const graceDeadline = Date.now() + graceMs;
  while (processGroupExists(pid) && Date.now() < graceDeadline) await pause(pollMs);
  if (processGroupExists(pid)) signalProcessGroup(pid, "SIGKILL");
  const finalDeadline = Date.now() + finalWaitMs;
  while (processGroupExists(pid) && Date.now() < finalDeadline) await pause(pollMs);
  return !processGroupExists(pid);
}

export class FixtureChildProcessError extends Error {
  constructor({
    command,
    exitCode,
    signal,
    timeoutMs,
    outputTail,
    outputMaxBytes,
    processGroupStopped,
  }) {
    const status = timeoutMs
      ? `timed out after ${timeoutMs} ms`
      : `exited ${exitCode ?? signal ?? "unknown"}`;
    const detail = outputTail
      ? `\nLast child output (up to ${outputMaxBytes} bytes):\n${outputTail}`
      : "";
    super(`${command} ${status}${detail}`);
    this.name = "FixtureChildProcessError";
    this.command = command;
    this.exitCode = exitCode;
    this.signal = signal;
    this.timeoutMs = timeoutMs;
    this.outputTail = outputTail;
    this.outputMaxBytes = outputMaxBytes;
    this.processGroupStopped = processGroupStopped;
  }
}

/** Run one fixture-owned command with a bounded output tail and process-group timeout. */
export function run(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? FIXTURE_CHILD_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new RangeError("child timeout must be a positive safe integer");
  const output = new BoundedOutputTail(options.maxOutputBytes ?? FIXTURE_CHILD_OUTPUT_MAX_BYTES);

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (error) {
      reject(error);
      return;
    }

    let settled = false;
    let timedOut = false;
    let timeoutCleanup = Promise.resolve(true);
    const timeout = setTimeout(() => {
      timedOut = true;
      timeoutCleanup = stopProcessGroup(child.pid, { graceMs: killGraceMs });
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => output.append(chunk));
    child.stderr?.on("data", (chunk) => output.append(chunk));
    child.once("error", (error) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      void (async () => {
        const processGroupStopped = timedOut ? await timeoutCleanup : undefined;
        if (timedOut) {
          reject(
            new FixtureChildProcessError({
              command: path.basename(command),
              signal,
              timeoutMs,
              outputTail: output.toString(),
              outputMaxBytes: output.maxBytes,
              processGroupStopped,
            }),
          );
        } else if (exitCode === 0) {
          resolve(output.toString().trim());
        } else {
          reject(
            new FixtureChildProcessError({
              command: path.basename(command),
              exitCode,
              signal,
              outputTail: output.toString(),
              outputMaxBytes: output.maxBytes,
            }),
          );
        }
      })().catch(reject);
    });
  });
}
