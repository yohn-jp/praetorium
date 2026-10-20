import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WorkNotificationSchema, type WorkNotification } from "@praetorium/contracts";
import type { CoordinationConfig, NotificationTarget } from "./config.js";

const WORK_NOTIFICATION_PATH = "/internal/work-available";
const MAX_NOTIFICATION_BODY_BYTES = 1024;
const DISPATCH_TIMEOUT_MS = 2_000;

export async function startCoordinationServer(
  config: Pick<CoordinationConfig, "host" | "port" | "targets">,
  fetcher: typeof fetch = fetch,
): Promise<Server> {
  const server = createServer((request, response) => {
    void handleRequest(request, response, config.targets, fetcher).catch(() => {
      if (!response.headersSent) respond(response, 500);
      else response.destroy();
    });
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.timeout = 15_000;
  server.keepAliveTimeout = 1_000;
  server.maxHeadersCount = 32;
  server.maxConnections = 64;
  server.maxRequestsPerSocket = 64;
  server.on("timeout", (socket) => socket.destroy());

  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error): void => {
      server.removeListener("listening", ready);
      reject(error);
    };
    const ready = (): void => {
      server.removeListener("error", fail);
      resolve();
    };
    server.once("error", fail);
    server.once("listening", ready);
    server.listen(config.port, config.host);
  });
  return server;
}

export async function closeCoordinationServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeIdleConnections();
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  targets: CoordinationConfig["targets"],
  fetcher: typeof fetch,
): Promise<void> {
  if (request.url === "/healthz" || request.url === "/readyz") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      request.resume();
      respond(response, 405);
      return;
    }
    const status = request.url === "/healthz" ? "ok" : "ready";
    respondJson(response, 200, request.method === "HEAD" ? undefined : { status });
    return;
  }
  if (request.url !== WORK_NOTIFICATION_PATH) {
    request.resume();
    respond(response, 404);
    return;
  }
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    request.resume();
    respond(response, 405);
    return;
  }
  const authenticatedKind = authenticatedNotificationKind(request.headers.authorization, targets);
  if (authenticatedKind === undefined) {
    request.resume();
    response.setHeader("WWW-Authenticate", "Bearer");
    respond(response, 401);
    return;
  }
  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)
  ) {
    request.resume();
    respond(response, 415);
    return;
  }
  const contentLength = request.headers["content-length"];
  if (contentLength !== undefined && Number(contentLength) > MAX_NOTIFICATION_BODY_BYTES) {
    response.setHeader("Connection", "close");
    request.resume();
    respond(response, 413);
    return;
  }

  let body: Buffer | null;
  try {
    body = await readBoundedBody(request, MAX_NOTIFICATION_BODY_BYTES);
  } catch {
    respond(response, 400);
    return;
  }
  if (body === null) {
    response.setHeader("Connection", "close");
    request.resume();
    respond(response, 413);
    return;
  }

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
  } catch {
    respond(response, 400);
    return;
  }
  const parsed = WorkNotificationSchema.safeParse(value);
  if (!parsed.success) {
    respond(response, 400);
    return;
  }
  if (parsed.data.kind !== authenticatedKind) {
    respond(response, 401);
    return;
  }

  const target = targetFor(parsed.data, targets);
  try {
    const upstream = await fetcher(target.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${target.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(parsed.data),
      redirect: "manual",
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    });
    await upstream.body?.cancel();
    respond(response, upstream.ok ? 202 : 503);
  } catch {
    respond(response, 503);
  }
}

function targetFor(
  notification: WorkNotification,
  targets: CoordinationConfig["targets"],
): NotificationTarget {
  return notification.kind === "build" ? targets.build : targets.operation;
}

function authenticatedNotificationKind(
  value: string | undefined,
  targets: CoordinationConfig["targets"],
): WorkNotification["kind"] | undefined {
  const prefix = "Bearer ";
  if (!value?.startsWith(prefix)) return undefined;
  const provided = Buffer.from(value.slice(prefix.length), "utf8");
  const matchesOperation = matchesToken(provided, targets.operation.token);
  const matchesBuild = matchesToken(provided, targets.build.token);
  if (matchesOperation) return "operation";
  if (matchesBuild) return "build";
  return undefined;
}

function matchesToken(provided: Buffer, token: string): boolean {
  const expected = Buffer.from(token, "utf8");
  const candidate = Buffer.alloc(expected.byteLength);
  provided.copy(candidate, 0, 0, expected.byteLength);
  const matches = timingSafeEqual(expected, candidate);
  return provided.byteLength === expected.byteLength && matches;
}

function readBoundedBody(request: IncomingMessage, maximumBytes: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let finished = false;
    const cleanup = (): void => {
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("error", onError);
      request.removeListener("aborted", onAborted);
    };
    const settle = (result: Buffer | null): void => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(result);
    };
    const fail = (error: Error): void => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.byteLength;
      if (total > maximumBytes) {
        chunks.length = 0;
        settle(null);
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = (): void => settle(Buffer.concat(chunks, total));
    const onError = (error: Error): void => fail(error);
    const onAborted = (): void => fail(new Error("coordination request was aborted"));
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
  });
}

function respond(response: ServerResponse, status: number): void {
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  response.end();
}

function respondJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(body === undefined ? undefined : JSON.stringify(body));
}
