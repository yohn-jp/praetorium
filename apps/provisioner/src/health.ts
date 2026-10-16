import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ProvisionerMetrics } from "./metrics.js";

export interface HealthState {
  readonly isLive: () => boolean;
  readonly isReady: () => boolean;
}

export interface HealthServerOptions extends HealthState {
  readonly metrics: ProvisionerMetrics;
  readonly host?: string;
  readonly port?: number;
}

function send(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.statusCode = status;
  response.setHeader("content-type", contentType);
  response.setHeader("cache-control", "no-store");
  response.end(body);
}

export function handleHealthRequest(
  request: IncomingMessage,
  response: ServerResponse,
  state: HealthState,
  metrics: ProvisionerMetrics,
): void {
  const path = (request.url ?? "/").split("?", 1)[0];
  if (request.method !== "GET" && request.method !== "HEAD") {
    send(response, 405, "text/plain; charset=utf-8", "method not allowed\n");
    return;
  }
  if (path === "/healthz") {
    const live = state.isLive();
    send(response, live ? 200 : 503, "application/json; charset=utf-8", JSON.stringify({ status: live ? "ok" : "stopping" }));
    return;
  }
  if (path === "/readyz") {
    const ready = state.isReady();
    send(response, ready ? 200 : 503, "application/json; charset=utf-8", JSON.stringify({ status: ready ? "ready" : "not_ready" }));
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
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
    this.started = false;
  }
}
