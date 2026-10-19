import { z } from "zod";
import { RepositoryIdSchema } from "./access.js";

/** Registered application namespaces are platform policy, never user input. */
export const AppIdentitySchema = z.literal("scriptorium");
export type AppIdentity = z.infer<typeof AppIdentitySchema>;
export const APPLICATION_DOMAIN = "yohn.jp";
const BindingId = z.string().regex(/^ins_[0-9A-HJKMNP-TV-Z]{26}$/);
const Epoch = z.number().int().positive().safe();

export function applicationHostname(appIdentity: string, repositoryId: number): string {
  return `${RepositoryIdSchema.parse(repositoryId)}.${AppIdentitySchema.parse(appIdentity)}.${APPLICATION_DOMAIN}`;
}
export function applicationFromHostname(hostname: string): {
  appIdentity: AppIdentity;
  repositoryId: number;
} {
  const match = /^([1-9][0-9]*)\.scriptorium\.yohn\.jp$/.exec(hostname);
  if (!match) throw new Error("Invalid application host");
  const repositoryId = RepositoryIdSchema.parse(Number(match[1]));
  if (applicationHostname("scriptorium", repositoryId) !== hostname)
    throw new Error("Invalid application host");
  return { appIdentity: "scriptorium", repositoryId };
}
/** Legacy instanceId fields in operations are durable binding IDs. A physical
 * identity is allocated once per monotonic epoch and is never reused by a
 * replacement or rollback. This injective encoding needs no second allocator. */
export function physicalInstanceId(
  bindingId: string,
  epoch: number,
  legacyEpoch?: number | null,
): string {
  // Absent marker is the legacy private wire format. New persistence always
  // projects an explicit null (or a recorded source epoch), never omission.
  if (legacyEpoch === undefined) return bindingId;
  BindingId.parse(bindingId);
  Epoch.parse(epoch);
  return epoch === legacyEpoch ? bindingId : `run_${bindingId.slice(4)}_${epoch}`;
}
export function bindingIdFromPhysicalInstanceId(instanceId: string): string {
  const parsed = /^run_([0-9A-HJKMNP-TV-Z]{26})_([1-9][0-9]*)$/.exec(instanceId);
  if (!parsed) throw new Error("Invalid physical instance identity");
  const bindingId = BindingId.parse(`ins_${parsed[1]}`);
  if (physicalInstanceId(bindingId, Number(parsed[2]), null) !== instanceId)
    throw new Error("Invalid physical instance identity");
  return bindingId;
}
export function assignmentInstanceId(assignment: {
  instanceId: string;
  runtimeEpoch: number;
  deployment: { legacyRuntimeEpoch?: number | null };
}): string {
  return physicalInstanceId(
    assignment.instanceId,
    assignment.runtimeEpoch,
    assignment.deployment.legacyRuntimeEpoch,
  );
}
export function publicRuntimeIdentity(instance: {
  instanceId: string;
  runtimeEpoch: number;
  observedRuntimeEpoch: number | null;
  observedState: string;
  legacyRuntimeEpoch?: number | null | undefined;
}): string {
  return physicalInstanceId(
    instance.instanceId,
    instance.observedState === "ready"
      ? (instance.observedRuntimeEpoch ?? instance.runtimeEpoch)
      : instance.runtimeEpoch,
    instance.legacyRuntimeEpoch,
  );
}
