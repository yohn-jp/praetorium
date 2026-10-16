import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createInstanceAccessHandler, type InstanceAccessEnvironment } from "./handler.js";

const MAX_REQUEST_BYTES = 8_192;
const handle = createInstanceAccessHandler(process.env as InstanceAccessEnvironment);

function requestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      headers.set(name, name === "cookie" ? value.join("; ") : value.join(", "));
    } else {
      headers.set(name, value);
    }
  }
  return headers;
}

async function requestBody(request: IncomingMessage): Promise<Uint8Array | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.byteLength;
    if (size > MAX_REQUEST_BYTES) throw new RangeError("request body too large");
    chunks.push(buffer);
  }
  return size === 0 ? null : new Uint8Array(Buffer.concat(chunks));
}

function writeResponse(response: Response, target: ServerResponse): void {
  target.statusCode = response.status;
  const cookieHeaders = response.headers.getSetCookie();
  response.headers.forEach((value, name) => {
    if (name.toLowerCase() !== "set-cookie") target.setHeader(name, value);
  });
  if (cookieHeaders.length) target.setHeader("Set-Cookie", cookieHeaders);
  void response.arrayBuffer().then((body) => target.end(Buffer.from(body)));
}

async function dispatch(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const headers = requestHeaders(request);
    const host = headers.get("host") ?? "localhost";
    const url = new URL(request.url ?? "/", `http://${host}`);
    const method = request.method ?? "GET";
    const needsHandoffForm = method === "POST" && url.pathname === "/_platform/handoff";
    const body = needsHandoffForm ? await requestBody(request) : null;
    if (method !== "GET" && method !== "HEAD" && !needsHandoffForm) {
      // Fallback API/MCP requests are answered locally. Drain the socket without
      // buffering or forwarding the application's request body to Gateway.
      request.resume();
    }
    const webRequest = new Request(url, {
      method,
      headers,
      ...(body ? { body: Buffer.from(body).toString("utf8") } : {}),
    });
    writeResponse(
      await handle(webRequest),
      response,
    );
  } catch {
    response.statusCode = 500;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end('{"error":"internal_error"}');
  }
}

const configuredPort = Number(process.env.INSTANCE_ACCESS_PORT ?? "8080");
if (!Number.isInteger(configuredPort) || configuredPort < 1 || configuredPort > 65_535) {
  throw new Error("INSTANCE_ACCESS_PORT must be a valid TCP port");
}

createServer((request, response) => {
  void dispatch(request, response);
}).listen(configuredPort, "0.0.0.0");
