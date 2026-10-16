import {
  BuildClaimRequestSchema,
  BuildClaimSchema,
  BuildHeartbeatRequestSchema,
  BuildReportRequestSchema,
} from "@praetorium/contracts";
import type {
  BuildQueueHeartbeatInput,
  BuildQueuePort,
  BuildQueueReportInput,
} from "@praetorium/application/builds";
import { Hono } from "hono";
import { z } from "zod";

const MAX_BUILD_REQUEST_BYTES = 1_048_576;
const SERVICE_TOKEN_MIN = 32;
const SERVICE_TOKEN_MAX = 4096;
const BUILD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export type BuildRoutesOptions = {
  readonly queue: BuildQueuePort;
  readonly serviceToken: string;
  /** BuildQueueService replaces this transport value with its Control Plane clock. */
  readonly now?: () => number;
};

/** Bounded HTTP surface consumed by the isolated Build worker. */
export function createBuildRoutes(options: BuildRoutesOptions) {
  if (
    options.serviceToken.length < SERVICE_TOKEN_MIN ||
    options.serviceToken.length > SERVICE_TOKEN_MAX ||
    /[^\x21-\x7e]/u.test(options.serviceToken)
  ) {
    throw new TypeError("Build worker service credential is invalid");
  }
  const now = options.now ?? Date.now;
  const app = new Hono();

  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    await next();
  });
  app.use("/internal/builds/*", async (c, next) => {
    if (!authorized(c.req.header("Authorization") ?? null, options.serviceToken)) {
      return c.json({ error: { code: "UNAUTHORIZED" } }, 401, { "WWW-Authenticate": "Bearer" });
    }
    if (new URL(c.req.url).search !== "")
      return c.json({ error: { code: "INVALID_REQUEST" } }, 400);
    await next();
  });

  app.post("/internal/builds/claim", async (c) => {
    const body = await requestJson(c.req.raw);
    const input = BuildClaimRequestSchema.parse(body);
    const claim = await options.queue.claimNext({ ...input, now: now() });
    if (claim === null) return c.body(null, 204);
    return c.json(BuildClaimSchema.parse(claim));
  });

  app.post("/internal/builds/:buildId/heartbeat", async (c) => {
    const buildId = pathBuildId(c.req.param("buildId"));
    const input = BuildHeartbeatRequestSchema.parse(await requestJson(c.req.raw));
    if (input.buildId !== buildId) return c.json({ error: { code: "BUILD_ID_MISMATCH" } }, 400);
    const result = await options.queue.heartbeat({
      ...input,
      now: now(),
    } satisfies BuildQueueHeartbeatInput);
    return c.json(result);
  });

  app.post("/internal/builds/:buildId/report", async (c) => {
    const buildId = pathBuildId(c.req.param("buildId"));
    const input = BuildReportRequestSchema.parse(await requestJson(c.req.raw));
    if (input.buildId !== buildId) return c.json({ error: { code: "BUILD_ID_MISMATCH" } }, 400);
    const result = await options.queue.report({
      ...input,
      now: now(),
    } satisfies BuildQueueReportInput);
    return c.json(result);
  });

  app.all("/internal/builds/*", (c) =>
    c.json({ error: { code: "METHOD_NOT_ALLOWED" } }, 405, { Allow: "POST" }),
  );
  app.onError((error, c) => {
    if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof TypeError) {
      return c.json({ error: { code: "INVALID_REQUEST" } }, 400);
    }
    if (error instanceof RangeError) return c.json({ error: { code: "REQUEST_TOO_LARGE" } }, 413);
    return c.json({ error: { code: "BUILD_SERVICE_UNAVAILABLE" } }, 503);
  });
  return app;
}

function pathBuildId(value: string): string {
  if (!BUILD_ID.test(value)) throw new TypeError("build ID is invalid");
  return value;
}

function authorized(header: string | null, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  return constantTimeEqual(header.slice("Bearer ".length), expected);
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  if (leftBytes.length !== rightBytes.length) return false;
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index]! ^ rightBytes[index]!;
  }
  return difference === 0;
}

async function requestJson(request: Request): Promise<unknown> {
  if (!isJsonContentType(request.headers.get("content-type")))
    throw new TypeError("JSON content type required");
  const contentLength = request.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^\d+$/u.test(contentLength) || Number(contentLength) > MAX_BUILD_REQUEST_BYTES)
  ) {
    throw new RangeError("request body exceeded its bound");
  }
  if (!request.body) throw new TypeError("JSON body required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BUILD_REQUEST_BYTES) {
        await reader.cancel();
        throw new RangeError("request body exceeded its bound");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

function isJsonContentType(value: string | null): boolean {
  return value !== null && /^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(value.trim());
}
