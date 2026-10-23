import type { AdminContext } from "./context.js";

export type InfraState = "healthy" | "degraded" | "unavailable" | "unknown";
export type InfraFreshness = "fresh" | "stale" | "absent";
export interface HostObservation {
  readonly id: string;
  readonly role: "management" | "runtime" | "builder";
  readonly observedAt: string;
  readonly state: InfraState;
  readonly freshness: InfraFreshness;
  readonly cpu: { readonly usedPercent: number | null };
  readonly memory: { readonly usedBytes: number | null; readonly totalBytes: number | null };
  readonly disk: { readonly usedBytes: number | null; readonly totalBytes: number | null };
  readonly reasons: readonly string[];
}
export interface InfraHosts {
  readonly schemaVersion: 1;
  readonly hosts: readonly HostObservation[];
}
export interface ServiceObservation {
  readonly id: string;
  readonly state: "healthy" | "unavailable";
  readonly observedAt: string;
}
export interface InfraServices {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly services: readonly ServiceObservation[];
}
export interface InfraDependencies {
  readonly schemaVersion: 1;
  readonly targets: readonly {
    readonly id: string;
    readonly role: HostObservation["role"];
    readonly services: readonly ServiceObservation[];
  }[];
}
export type InfraPayload = InfraHosts | InfraServices | InfraDependencies | HostObservation;
export interface InfraResult<T> {
  readonly endpoint: string;
  readonly status: number | null;
  readonly code: string | null;
  readonly value: T | null;
}

const ID = /^[a-z][a-z0-9-]{0,63}$/u;
const MAX_RESPONSE_BYTES = 256_000;
const STATES = new Set(["healthy", "degraded", "unavailable", "unknown"]);
const ROLES = new Set(["management", "runtime", "builder"]);
const VALID_SERVICE_STATES = new Set(["healthy", "unavailable"]);
const MAX_HOSTS = 25;
const MAX_SERVICES = 16;

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value) &&
    Number.isFinite(Date.parse(value));
}
function numberOrNull(value: unknown, maximum: number): value is number | null {
  return value === null || (typeof value === "number" &&
    Number.isFinite(value) && value >= 0 && value <= maximum);
}
function safeReason(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(value);
}
function host(value: unknown, now: number): HostObservation | null {
  const v = object(value), cpu = object(v?.cpu), memory = object(v?.memory), disk = object(v?.disk);
  if (!v || typeof v.id !== "string" || !ID.test(v.id) ||
      !ROLES.has(v.role as string) || !STATES.has(v.state as string) ||
      !validDate(v.observedAt) ||
      !cpu || !numberOrNull(cpu.usedPercent, 100) ||
      !memory || !numberOrNull(memory.usedBytes, Number.MAX_SAFE_INTEGER) ||
      !numberOrNull(memory.totalBytes, Number.MAX_SAFE_INTEGER) ||
      !disk || !numberOrNull(disk.usedBytes, Number.MAX_SAFE_INTEGER) ||
      !numberOrNull(disk.totalBytes, Number.MAX_SAFE_INTEGER) ||
      !Array.isArray(v.reasons) || v.reasons.length > 20 ||
      !v.reasons.every(safeReason)) return null;
  const age = now - Date.parse(v.observedAt);
  const freshness: InfraFreshness = v.freshness === "absent" || age > 300_000 ? "absent"
    : age > 90_000 || age < -30_000 ? "stale" : "fresh";
  const state: InfraState = freshness === "fresh" ? v.state as InfraState : "unknown";
  return {
    id: v.id, role: v.role as HostObservation["role"],
    observedAt: v.observedAt, freshness, state,
    cpu: {usedPercent: cpu.usedPercent as number | null},
    memory: {usedBytes: memory.usedBytes as number | null,
      totalBytes: memory.totalBytes as number | null},
    disk: {usedBytes: disk.usedBytes as number | null,
      totalBytes: disk.totalBytes as number | null},
    reasons: v.reasons,
  };
}
function services(data: unknown): readonly ServiceObservation[] | null {
  if (!Array.isArray(data) || data.length > MAX_SERVICES) return null;
  const seen = new Set<string>();
  const result: ServiceObservation[] = [];
  for (const item of data) {
    const v = object(item);
    if (!v || typeof v.id !== "string" || !ID.test(v.id) || seen.has(v.id) ||
        !VALID_SERVICE_STATES.has(v.state as string) || !validDate(v.observedAt)) return null;
    seen.add(v.id);
    result.push({
      id: v.id, state: v.state as ServiceObservation["state"], observedAt: v.observedAt,
    });
  }
  return result;
}
function parsePayload(path: string, raw: unknown, now: number): InfraPayload | null {
  const d = object(raw);
  if (!d) return null;
  if (path === "/v1/hosts") {
    if (d.schemaVersion !== 1 || !Array.isArray(d.hosts) ||
        d.hosts.length > MAX_HOSTS) return null;
    const items = d.hosts.map(v => host(v, now));
    if (items.some(v => v === null)) return null;
    const known = items as HostObservation[];
    if (new Set(known.map(v => v.id)).size !== known.length) return null;
    return {schemaVersion:1, hosts:known};
  }
  if (path === "/v1/dependencies") {
    if (d.schemaVersion !== 1 || !Array.isArray(d.targets) ||
        d.targets.length > MAX_HOSTS) return null;
    const targets: InfraDependencies["targets"][number][] = [];
    for (const item of d.targets) {
      const v = object(item), list = services(v?.services);
      if (!v || typeof v.id !== "string" || !ID.test(v.id) ||
          !ROLES.has(v.role as string) || !list) return null;
      targets.push({id:v.id,role:v.role as HostObservation["role"],services:list});
    }
    if (new Set(targets.map(t => t.id)).size !== targets.length) return null;
    return {schemaVersion:1, targets};
  }
  if (path.endsWith("/services")) {
    if (d.schemaVersion !== 1 || typeof d.id !== "string" || !ID.test(d.id) ||
        !services(d.services)) return null;
    return {schemaVersion:1,id:d.id,services:services(d.services)!};
  }
  return host(raw, now);
}

function allowedPath(path: string): boolean {
  return path === "/v1/hosts" || path === "/v1/dependencies" ||
    /^\/v1\/hosts\/[a-z][a-z0-9-]{0,63}(?:\/services)?$/u.test(path);
}
async function boundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("Content-Length");
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES))
    throw new Error("observer_response_too_large");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("observer_empty");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const p = await reader.read();
      if (p.done) break;
      length += p.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch { /* bounded */ }
        throw new Error("observer_response_too_large");
      }
      chunks.push(p.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder("utf-8", {fatal:true}).decode(bytes)) as unknown;
}

/** Dedicated read-only VPC path, no user-controlled URL or infra mutation. */
export async function readInfrastructure<T extends InfraPayload>(
  context: AdminContext, path: string,
): Promise<InfraResult<T>> {
  const endpoint = "GET " + path;
  if (!allowedPath(path)) return {endpoint,status:400,code:"INVALID_OBSERVATION_PATH",value:null};
  if (!context.env.INFRASTRUCTURE || !context.env.ADMIN_OBSERVER_AUTH)
    return {endpoint,status:null,code:"OBSERVER_NOT_CONFIGURED",value:null};
  try {
    const response = await context.env.INFRASTRUCTURE.fetch(
      "http://observer.internal" + path, {
        method: "GET",
        signal: AbortSignal.timeout(9000),
        headers: {
          Authorization: "Bearer " + context.env.ADMIN_OBSERVER_AUTH,
          Accept: "application/json",
        },
      },
    );
    if (!response.ok) return {endpoint,status:response.status,code:"OBSERVER_UNAVAILABLE",value:null};
    const parsed = parsePayload(path, await boundedJson(response), Date.now());
    if (!parsed) return {endpoint,status:502,code:"INVALID_OBSERVATION",value:null};
    return {endpoint,status:200,code:null,value:parsed as T};
  } catch {
    return {endpoint,status:null,code:"OBSERVER_UNAVAILABLE",value:null};
  }
}
