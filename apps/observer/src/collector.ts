import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

export type HostRole = "management" | "runtime" | "builder";
export type HostStatus = "healthy" | "degraded" | "unavailable" | "unknown";
export interface Probe {
  readonly id: string;
  readonly url: string;
}
export interface HostTarget {
  readonly id: string;
  readonly role: HostRole;
  readonly metricsUrl: string;
  readonly services: readonly Probe[];
}
export interface ObserverConfig {
  readonly token: string;
  readonly targets: readonly HostTarget[];
}
export interface HostObservation {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly role: HostRole;
  readonly observedAt: string;
  readonly state: HostStatus;
  readonly freshness: "fresh" | "absent";
  readonly cpu: { readonly usedPercent: number | null };
  readonly memory: { readonly usedBytes: number | null; readonly totalBytes: number | null };
  readonly disk: { readonly usedBytes: number | null; readonly totalBytes: number | null };
  readonly reasons: readonly string[];
}
export interface ServiceObservation {
  readonly id: string;
  readonly state: "healthy" | "unavailable";
  readonly observedAt: string;
}
const HOST_ID = /^[a-z][a-z0-9-]{0,63}$/u;
const MAX_TEXT_BYTES = 256_000;
const TARGET_LIMIT = 25;
function privateUrl(value: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (!["http:", "https:"].includes(url.protocol) ||
      url.username || url.password || url.search || url.hash ||
      !url.pathname || url.pathname === "//" || !url.port) return false;
  const ip = url.hostname.replace(/^\[|\]$/gu, "");
  if (isIP(ip) !== 4) return false;
  const parts = ip.split(".").map(Number);
  return ip === "127.0.0.1" ||
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
    (parts[0] === 192 && parts[1] === 168);
}
export function parseObserverConfig(input: string, token: string): ObserverConfig {
  if (!/^[\x21-\x7e]{32,4096}$/u.test(token)) throw new TypeError("Observer token is invalid");
  const raw: unknown = JSON.parse(input);
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > TARGET_LIMIT)
    throw new TypeError("Observer hosts must be a bounded array");
  const seen = new Set<string>();
  const targets: HostTarget[] = raw.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new TypeError("Invalid host");
    const data = item as Record<string, unknown>;
    const id = data.id;
    const role = data.role;
    const metricsUrl = data.metricsUrl;
    const services = data.services;
    if (typeof id !== "string" || !HOST_ID.test(id) || seen.has(id) ||
        !["management", "runtime", "builder"].includes(String(role)) ||
        typeof metricsUrl !== "string" || !privateUrl(metricsUrl) ||
        !Array.isArray(services) || services.length > 16)
      throw new TypeError("Invalid bounded host inventory");
    seen.add(id);
    const probes: Probe[] = services.map((p: unknown) => {
      if (!p || typeof p !== "object") throw new TypeError("Invalid service");
      const probe = p as Record<string, unknown>;
      if (typeof probe.id !== "string" || !HOST_ID.test(probe.id) ||
          typeof probe.url !== "string" || !privateUrl(probe.url))
        throw new TypeError("Invalid private service probe");
      return { id: probe.id, url: probe.url };
    });
    if (new Set(probes.map(p => p.id)).size !== probes.length)
      throw new TypeError("Duplicate service identity");
    return { id, role: role as HostRole, metricsUrl, services: probes };
  });
  return { token, targets };
}
function authorized(request: Request, token: string): boolean {
  const value = request.headers.get("Authorization");
  if (!value?.startsWith("Bearer ")) return false;
  const candidate = Buffer.from(value.slice(7));
  const expected = Buffer.from(token);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
async function boundedText(response: Response): Promise<string> {
  if (!response.ok) throw new Error("provider_unavailable");
  const declared = response.headers.get("Content-Length");
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > MAX_TEXT_BYTES))
    throw new Error("provider_too_large");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("provider_empty");
  const chunks: Uint8Array[] = [];
  let count = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      count += part.value.byteLength;
      if (count > MAX_TEXT_BYTES) {
        await reader.cancel();
        throw new Error("provider_too_large");
      }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const joined = new Uint8Array(count);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder("utf-8", { fatal: true }).decode(joined);
}
type CpuTotals = { total: number; idle: number };
function metrics(text: string): {
  memory: { usedBytes: number | null; totalBytes: number | null };
  disk: { usedBytes: number | null; totalBytes: number | null };
  cpu: CpuTotals | null;
} {
  let memTotal: number | null = null, memAvail: number | null = null;
  let diskTotal: number | null = null, diskAvail: number | null = null;
  let cpuTotal = 0, cpuIdle = 0, cpuFound = false;
  for (const line of text.split("\n")) {
    const parts = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]+\})?\s+([^\s]+)(?:\s|$)/u.exec(line);
    if (!parts) continue;
    const value = Number(parts[3]);
    if (!Number.isFinite(value) || value < 0) continue;
    const name = parts[1], labels = parts[2] ?? "";
    if (name === "node_memory_MemTotal_bytes") memTotal = value;
    if (name === "node_memory_MemAvailable_bytes") memAvail = value;
    if (name === "node_filesystem_size_bytes" && /(?:^|,)mountpoint="\/"/u.test(labels.slice(1)))
      diskTotal = value;
    if (name === "node_filesystem_avail_bytes" && /(?:^|,)mountpoint="\/"/u.test(labels.slice(1)))
      diskAvail = value;
    if (name === "node_cpu_seconds_total" &&
        !/mode="guest(?:_nice)?"/u.test(labels)) {
      cpuTotal += value;
      if (/mode="idle"/u.test(labels)) cpuIdle += value;
      cpuFound = true;
    }
  }
  return {
    memory: { usedBytes: memTotal !== null && memAvail !== null
      ? Math.max(0, memTotal - memAvail) : null, totalBytes: memTotal },
    disk: { usedBytes: diskTotal !== null && diskAvail !== null
      ? Math.max(0, diskTotal - diskAvail) : null, totalBytes: diskTotal },
    cpu: cpuFound ? { total: cpuTotal, idle: cpuIdle } : null,
  };
}

export class Observer {
  private readonly lastCpu = new Map<string, CpuTotals>();
  constructor(private readonly config: ObserverConfig,
    private readonly fetcher: typeof fetch = fetch) {}

  private async probe(url: string): Promise<Response> {
    return this.fetcher(url, { method: "GET", signal: AbortSignal.timeout(2200),
      headers: { Accept: "text/plain" } });
  }

  async observeHost(target: HostTarget): Promise<HostObservation> {
    const observedAt = new Date().toISOString();
    try {
      const parsed = metrics(await boundedText(await this.probe(target.metricsUrl)));
      const reasons: string[] = [];
      let usedPercent: number | null = null;
      if (parsed.cpu) {
        const prior = this.lastCpu.get(target.id);
        this.lastCpu.set(target.id, parsed.cpu);
        if (prior && parsed.cpu.total > prior.total) {
          const busy = 1 - (parsed.cpu.idle - prior.idle) /
            (parsed.cpu.total - prior.total);
          usedPercent = Math.max(0, Math.min(100, busy * 100));
        } else reasons.push("cpu_baseline_pending");
      } else reasons.push("cpu_not_collected");
      if (parsed.memory.usedBytes === null) reasons.push("memory_not_collected");
      if (parsed.disk.usedBytes === null) reasons.push("disk_not_collected");
      return {
        schemaVersion: 1, id: target.id, role: target.role, observedAt,
        state: reasons.some(x => x !== "cpu_baseline_pending") ? "degraded" : "healthy",
        freshness: "fresh", cpu: { usedPercent }, memory: parsed.memory,
        disk: parsed.disk, reasons,
      };
    } catch {
      return { schemaVersion: 1, id: target.id, role: target.role, observedAt,
        state: "unavailable", freshness: "absent",
        cpu: { usedPercent: null }, memory: {usedBytes:null,totalBytes:null},
        disk: {usedBytes:null,totalBytes:null}, reasons: ["metrics_unavailable"] };
    }
  }

  async services(target: HostTarget): Promise<readonly ServiceObservation[]> {
    return Promise.all(target.services.map(async service => {
      let state: ServiceObservation["state"] = "unavailable";
      try { state = (await this.probe(service.url)).ok ? "healthy" : "unavailable"; }
      catch { /* A missing service must never be shown as healthy. */ }
      return { id: service.id, state, observedAt: new Date().toISOString() };
    }));
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const json = (value: unknown, status = 200) => Response.json(value, { status, headers: {
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    } });
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
    if (url.pathname === "/healthz") return json({ status: "ok" });
    if (url.pathname === "/readyz") return json({ status: "ready" });
    if (!authorized(request, this.config.token)) return json({ error: "unauthorized" }, 401);
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments[0] !== "v1") return json({error:"not_found"},404);
    if (segments[1] === "hosts" && segments.length === 2) {
      const hosts = await Promise.all(this.config.targets.map(t => this.observeHost(t)));
      return json({ schemaVersion: 1, hosts });
    }
    if (segments[1] === "hosts" && segments.length >= 3 && segments.length <= 4) {
      const host = this.config.targets.find(t => t.id === segments[2]);
      if (!host) return json({error:"not_found"},404);
      if (segments.length === 3) return json(await this.observeHost(host));
      if (segments[3] === "services") {
        return json({schemaVersion:1, id:host.id, services:await this.services(host)});
      }
    }
    if (segments[1] === "dependencies" && segments.length === 2) {
      const results = await Promise.all(this.config.targets.map(async target =>
        ({id:target.id, role:target.role, services:await this.services(target)})));
      return json({schemaVersion:1, targets:results});
    }
    return json({error:"not_found"},404);
  }
}
