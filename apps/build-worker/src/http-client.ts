import { z } from "zod";
import { lstat, readFile } from "node:fs/promises";
import {
  BuildClaimRequestSchema,
  BuildClaimSchema,
  BuildHeartbeatRequestSchema,
  BuildReportRequestSchema,
} from "@praetorium/contracts";
import type {
  BuildClaim,
  BuildQueueHeartbeatInput,
  BuildQueueHeartbeatResult,
  BuildQueuePort,
  BuildQueueReportInput,
  BuildQueueReportResult,
} from "@praetorium/application/builds";

const HeartbeatResponseSchema = z.strictObject({
  accepted: z.boolean(),
  cancelRequested: z.boolean(),
  leaseExpiresAt: z.number().int().positive().nullable(),
});
const ReportResponseSchema = z.strictObject({ accepted: z.boolean(), duplicate: z.boolean() });

export class BuildQueueHttpError extends Error {
  constructor(
    readonly status: number | null,
    message = "Build Control Plane request failed",
  ) {
    super(message);
    this.name = "BuildQueueHttpError";
  }
}

type HttpClientOptions = {
  baseUrl: string;
  serviceToken: string;
  requestTimeoutMs: number;
  maxResponseBytes: number;
  leaseSeconds: number;
  fetch?: typeof fetch;
};

export class BuildQueueHttpClient implements BuildQueuePort {
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpClientOptions) {
    let url: URL;
    try {
      url = new URL(options.baseUrl);
    } catch {
      throw new TypeError("Build Control Plane URL is invalid");
    }
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== "" ||
      !Number.isSafeInteger(options.requestTimeoutMs) ||
      options.requestTimeoutMs < 100 ||
      options.requestTimeoutMs > 60_000 ||
      !Number.isSafeInteger(options.maxResponseBytes) ||
      options.maxResponseBytes < 1024 ||
      options.maxResponseBytes > 1_048_576 ||
      !Number.isSafeInteger(options.leaseSeconds) ||
      options.leaseSeconds < 15 ||
      options.leaseSeconds > 300 ||
      options.serviceToken.length < 32 ||
      options.serviceToken.length > 4096 ||
      /[^\x21-\x7e]/u.test(options.serviceToken)
    ) {
      throw new TypeError("Build Control Plane client configuration is invalid");
    }
    this.origin = url.origin;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async claimNext(input: {
    workerId: string;
    now: number;
    leaseSeconds: number;
  }): Promise<BuildClaim | null> {
    const body = BuildClaimRequestSchema.parse({
      workerId: input.workerId,
      leaseSeconds: input.leaseSeconds,
    });
    const response = await this.post("/internal/builds/claim", body);
    if (response.status === 204 || response.value === null) return null;
    return BuildClaimSchema.parse(response.value);
  }

  async heartbeat(input: BuildQueueHeartbeatInput): Promise<BuildQueueHeartbeatResult> {
    const body = BuildHeartbeatRequestSchema.parse({
      buildId: input.buildId,
      attemptId: input.attemptId,
      workerId: input.workerId,
      leaseToken: input.leaseToken,
      leaseEpoch: input.leaseEpoch,
      sequence: input.sequence,
      leaseSeconds: input.leaseSeconds ?? this.options.leaseSeconds,
      ...(input.progress ? { progress: input.progress } : {}),
    });
    const response = await this.post(
      `/internal/builds/${encodeURIComponent(input.buildId)}/heartbeat`,
      body,
    );
    return HeartbeatResponseSchema.parse(response.value);
  }

  async report(input: BuildQueueReportInput): Promise<BuildQueueReportResult> {
    const body = BuildReportRequestSchema.parse({
      buildId: input.buildId,
      buildKey: input.buildKey,
      attemptId: input.attemptId,
      workerId: input.workerId,
      leaseToken: input.leaseToken,
      leaseEpoch: input.leaseEpoch,
      sequence: input.sequence,
      result: input.result,
    });
    const response = await this.post(
      `/internal/builds/${encodeURIComponent(input.buildId)}/report`,
      body,
    );
    return ReportResponseSchema.parse(response.value);
  }

  private async post(path: string, body: unknown): Promise<{ status: number; value: unknown }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.requestTimeoutMs);
    timeout.unref();
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(path, this.origin), {
        method: "POST",
        redirect: "error",
        cache: "no-store",
        headers: {
          authorization: `Bearer ${this.options.serviceToken}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timeout);
      throw new BuildQueueHttpError(null);
    }

    try {
      if (response.status === 204) return { status: 204, value: null };
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        throw new BuildQueueHttpError(response.status);
      }
      const bytes = await boundedBody(response.body, this.options.maxResponseBytes);
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
      } catch {
        throw new BuildQueueHttpError(response.status, "Build Control Plane response is invalid");
      }
      return { status: response.status, value };
    } catch (error) {
      if (error instanceof BuildQueueHttpError) throw error;
      throw new BuildQueueHttpError(
        response.status,
        "Build Control Plane response exceeded its bound",
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

export async function readBuildServiceToken(filePath: string): Promise<string> {
  if (!filePath.startsWith("/")) throw new TypeError("Build worker service credential is invalid");
  try {
    const info = await lstat(filePath);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size < 32 ||
      info.size > 4098 ||
      (info.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && info.uid !== process.getuid())
    )
      throw new TypeError("Build worker service credential is invalid");
    let token = await readFile(filePath, "utf8");
    if (token.endsWith("\r\n")) token = token.slice(0, -2);
    else if (token.endsWith("\n")) token = token.slice(0, -1);
    if (token.length < 32 || token.length > 4096 || /[^\x21-\x7e]/u.test(token)) {
      throw new TypeError("Build worker service credential is invalid");
    }
    return token;
  } catch {
    throw new TypeError("Build worker service credential is invalid");
  }
}

async function boundedBody(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new RangeError("response body limit exceeded");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
