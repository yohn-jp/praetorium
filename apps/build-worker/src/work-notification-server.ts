import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { WorkAvailability } from "@praetorium/application";
import { WorkNotificationSchema } from "@praetorium/contracts";
import type { BuildWorkerConfig } from "./config.js";

const WORK_AVAILABLE_PATH = "/internal/work-available";
const MAX_NOTIFICATION_BODY_BYTES = 1024;

export async function startBuildWorkNotificationServer(
  config: Pick<BuildWorkerConfig, "notificationHost" | "notificationPort" | "notificationToken">,
  availability: WorkAvailability,
): Promise<Server> {
  const token = config.notificationToken;
  if (!token) throw new TypeError("Build work notification authentication is not configured");
  const expectedToken = Buffer.from(token, "utf8");
  const server = createServer((request, response) => {
    void handleNotification(request, response, expectedToken, availability);
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.timeout = 15_000;
  server.keepAliveTimeout = 1_000;
  server.maxHeadersCount = 32;

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
    server.listen(config.notificationPort, config.notificationHost);
  });
  return server;
}

export async function closeBuildWorkNotificationServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeIdleConnections();
  });
}

async function handleNotification(
  request: IncomingMessage,
  response: ServerResponse,
  expectedToken: Buffer,
  availability: WorkAvailability,
): Promise<void> {
  const url = request.url;
  if (url !== WORK_AVAILABLE_PATH) {
    respond(response, 404);
    request.resume();
    return;
  }
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    respond(response, 405);
    request.resume();
    return;
  }
  if (!hasValidBearer(request.headers.authorization, expectedToken)) {
    respond(response, 401);
    request.resume();
    return;
  }
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    respond(response, 415);
    request.resume();
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
    respond(response, 413);
    request.resume();
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
  } catch {
    respond(response, 400);
    return;
  }
  const notification = WorkNotificationSchema.safeParse(parsed);
  if (!notification.success) {
    respond(response, 400);
    return;
  }
  if (notification.data.kind !== "build") {
    respond(response, 422);
    return;
  }

  availability.notify();
  respond(response, 202);
}

function hasValidBearer(value: string | undefined, expectedToken: Buffer): boolean {
  const prefix = "Bearer ";
  if (!value?.startsWith(prefix)) return false;
  const provided = Buffer.from(value.slice(prefix.length), "utf8");
  if (provided.length !== expectedToken.length) {
    const padded = Buffer.alloc(expectedToken.length);
    provided.copy(padded, 0, 0, expectedToken.length);
    timingSafeEqual(expectedToken, padded);
    return false;
  }
  return timingSafeEqual(expectedToken, provided);
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
    const onAborted = (): void => fail(new Error("Build work notification request was aborted"));
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
