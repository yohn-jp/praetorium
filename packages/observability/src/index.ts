export const packageBoundary = "observability" as const;
export interface ObservabilitySink {
  record(event: string): void;
}
export type ControlEvent = {
  event: string;
  correlationId: string;
  instanceId?: string;
  repositoryId?: number;
  operationId?: string;
  buildKey?: string;
  generation?: number;
  runtimeEpoch?: number;
  phase?: string;
  outcome?: "succeeded" | "failed" | "blocked";
  durationMs?: number;
};
const allowed = new Set([
  "event",
  "correlationId",
  "instanceId",
  "repositoryId",
  "operationId",
  "buildKey",
  "generation",
  "runtimeEpoch",
  "phase",
  "outcome",
  "durationMs",
]);
/** Control metadata only: unknown fields and unbounded/free text are rejected before logging. */
export function serializeControlEvent(event: ControlEvent): string {
  for (const [key, value] of Object.entries(event)) {
    if (!allowed.has(key)) throw new Error("Non-control log field rejected");
    if (typeof value === "string" && !/^[a-zA-Z0-9_.:/-]{1,160}$/.test(value))
      throw new Error("Unbounded control log value rejected");
    if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0))
      throw new Error("Invalid control log number");
  }
  if (!event.event || !event.correlationId) throw new Error("Control log identity required");
  return JSON.stringify(event);
}
