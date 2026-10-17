import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { WorkNotificationSchema } from "@praetorium/contracts";
import type { WorkAvailability } from "@praetorium/application";
import type { ProvisionerMetrics } from "./metrics.js";

export interface HealthState {
  readonly isLive: () => boolean;
  readonly isReady: () => boolean;
}

export interface HealthServerOptions extends HealthState {
  readonly metrics: ProvisionerMetrics;
  readonly workAvailability?: WorkAvailability;
  readonly onWorkAvailable?: (instanceId?: string) => void;
  readonly workNotificationToken?: string;
  readonly host?: string;
  readonly port?: number;
}

const MAX_WORK_NOTIFICATION_BYTES = 1_024;

class WorkNotificationBodyError extends Error {
  constructor(readonly status: 400 | 413) {
    super("work notification body is invalid");
  }
}

type WorkNotificationTarget = Pick<
  HealthServerOptions,
  "workAvailability" | "workNotificationToken" | "onWorkAvailable"
>;

function send(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.statusCode = status;
  response.setHeader("content-type", contentType);
  response.setHeader("cache-control", "no-store");
  response.end(body);
}

function authorizedNotification(request: IncomingMessage, expectedToken: string): boolean {
  const authorization = request.headers.authorization;
  const match =
    typeof authorization === "string"
      ? /^Bearer ([\x21-\x7e]{1,4096})$/u.exec(authorization)
      : null;
  const received = match?.[1] ?? "";
  const expectedDigest = createHash("sha256").update(expectedToken, "utf8").digest();
  const receivedDigest = createHash("sha256").update(received, "utf8").digest();
  const digestMatches = timingSafeEqual(expectedDigest, receivedDigest);
  return digestMatches && received.length === expectedToken.length;
}

async function readNotificationBody(request: IncomingMessage): Promise<unknown> {
  const contentLength = request.headers["content-length"];
  if (contentLength !== undefined && Number(contentLength) > MAX_WORK_NOTIFICATION_BYTES) {
    throw new WorkNotificationBodyError(413);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  await new Promise<void>((resolve, reject) => {
    const onEnd = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new WorkNotificationBodyError(400));
    };
    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > MAX_WORK_NOTIFICATION_BYTES) {
        cleanup();
        request.pause();
        // A one-shot error listener prevents a late socket error from becoming
        // an unhandled EventEmitter error while the 413 response is flushed.
        request.once("error", () => undefined);
        reject(new WorkNotificationBodyError(413));
        return;
      }
      chunks.push(bytes);
    };
    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
    };
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
  }).catch((error: unknown) => {
    if (error instanceof WorkNotificationBodyError) throw error;
    throw new WorkNotificationBodyError(400);
  });
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new WorkNotificationBodyError(400);
  }
}

async function handleWorkNotification(
  request: IncomingMessage,
  response: ServerResponse,
  options: WorkNotificationTarget,
): Promise<void> {
  if (options.workAvailability === undefined || options.workNotificationToken === undefined) {
    request.resume();
    send(response, 404, "text/plain; charset=utf-8", "not found\n");
    return;
  }
  if (request.method !== "POST") {
    request.resume();
    send(response, 405, "text/plain; charset=utf-8", "method not allowed\n");
    return;
  }
  let url: URL;
  try {
    url = new URL(request.url ?? "/", "http://provisioner.invalid");
  } catch {
    request.resume();
    send(response, 400, "text/plain; charset=utf-8", "bad request\n");
    return;
  }
  if (url.search !== "" || url.hash !== "") {
    request.resume();
    send(response, 400, "text/plain; charset=utf-8", "bad request\n");
    return;
  }
  if (!authorizedNotification(request, options.workNotificationToken)) {
    request.resume();
    response.setHeader("www-authenticate", "Bearer");
    send(response, 401, "text/plain; charset=utf-8", "unauthorized\n");
    return;
  }
  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)
  ) {
    request.resume();
    send(response, 415, "text/plain; charset=utf-8", "unsupported media type\n");
    return;
  }
  let body: unknown;
  try {
    body = await readNotificationBody(request);
  } catch (error) {
    const status = error instanceof WorkNotificationBodyError ? error.status : 400;
    if (status === 413) {
      response.shouldKeepAlive = false;
      response.setHeader("connection", "close");
      response.once("finish", () => request.socket.destroy());
    }
    send(
      response,
      status,
      "text/plain; charset=utf-8",
      status === 413 ? "payload too large\n" : "bad request\n",
    );
    return;
  }
  const notification = WorkNotificationSchema.safeParse(body);
  if (!notification.success || notification.data.kind !== "operation") {
    send(response, 400, "text/plain; charset=utf-8", "invalid work notification\n");
    return;
  }
  options.workAvailability.notify();
  if (notification.data.instanceId !== undefined) {
    options.onWorkAvailable?.(notification.data.instanceId);
  }
  send(response, 202, "application/json; charset=utf-8", '{"accepted":true}\n');
}

export function handleHealthRequest(
  request: IncomingMessage,
  response: ServerResponse,
  state: HealthState & WorkNotificationTarget,
  metrics: ProvisionerMetrics,
): void {
  const path = (request.url ?? "/").split("?", 1)[0];
  if (path === "/internal/work-available") {
    void handleWorkNotification(request, response, state).catch(() => {
      if (!response.headersSent)
        send(response, 500, "text/plain; charset=utf-8", "internal server error\n");
    });
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    send(response, 405, "text/plain; charset=utf-8", "method not allowed\n");
    return;
  }
  if (path === "/healthz") {
    const live = state.isLive();
    send(
      response,
      live ? 200 : 503,
      "application/json; charset=utf-8",
      JSON.stringify({ status: live ? "ok" : "stopping" }),
    );
    return;
  }
  if (path === "/readyz") {
    const ready = state.isReady();
    send(
      response,
      ready ? 200 : 503,
      "application/json; charset=utf-8",
      JSON.stringify({ status: ready ? "ready" : "not_ready" }),
    );
    return;
  }
  if (path === "/metrics") {
    send(response, 200, "text/plain; version=0.0.4; charset=utf-8", metrics.renderPrometheus());
    return;
  }
  send(response, 404, "text/plain; charset=utf-8", "not found\n");
}

export class HealthServer {
  private readonly server: Server;
  private started = false;

  constructor(private readonly options: HealthServerOptions) {
    this.server = createServer((request, response) =>
      handleHealthRequest(request, response, options, options.metrics),
    );
    this.server.headersTimeout = 5_000;
    this.server.requestTimeout = 10_000;
    this.server.timeout = 15_000;
    this.server.keepAliveTimeout = 1_000;
    this.server.maxConnections = 64;
    this.server.maxRequestsPerSocket = 64;
    this.server.setTimeout(15_000, (socket) => socket.destroy());
  }

  get address(): ReturnType<Server["address"]> {
    return this.server.address();
  }

  async start(): Promise<void> {
    if (this.started) return;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off("error", onError);
        this.started = true;
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.options.port ?? 8080, this.options.host ?? "0.0.0.0");
    });
  }

  async close(): Promise<void> {
    if (!this.started) return;
    this.server.closeIdleConnections();
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
    this.started = false;
  }
}
