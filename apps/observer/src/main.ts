import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { Observer, parseObserverConfig } from "./collector.js";

const config = parseObserverConfig(
  process.env.PRAETORIUM_OBSERVER_TARGETS_FILE
    ? readFileSync(process.env.PRAETORIUM_OBSERVER_TARGETS_FILE, "utf8")
    : process.env.PRAETORIUM_OBSERVER_TARGETS_JSON ?? "",
  readFileSync(process.env.PRAETORIUM_OBSERVER_AUTH_TOKEN_FILE ?? "", "utf8").trimEnd(),
);
const observer = new Observer(config);
const port = Number(process.env.PRAETORIUM_OBSERVER_PORT ?? "8791");
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new TypeError("Observer port invalid");
const server = createServer(async (incoming, outgoing) => {
  try {
    const request = new Request("http://127.0.0.1:" + port + (incoming.url ?? "/"), {
      method: incoming.method ?? "GET", headers: incoming.headers as HeadersInit,
    });
    const response = await observer.handle(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    outgoing.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    outgoing.end('{"error":"observer_unavailable"}');
  }
});
server.listen(port, "0.0.0.0");
