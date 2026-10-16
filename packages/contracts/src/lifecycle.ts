import { z } from "zod";
export const OperationSchema = z.strictObject({
  id: z.string().min(1),
  instanceId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  runtimeEpoch: z.number().int().nonnegative(),
  kind: z.enum(["start", "stop", "redeploy", "update"]),
  status: z.enum(["pending", "claimed", "running", "succeeded", "failed", "blocked"]),
  attempt: z.number().int().nonnegative(),
  leaseEpoch: z.number().int().nonnegative(),
  reportSequence: z.number().int().nonnegative(),
  leaseExpiresAt: z.number().int().nullable(),
});
export type Operation = z.infer<typeof OperationSchema>;
export const ResourceRequirementsSchema = z.strictObject({
  cpuMilli: z.number().int().nonnegative(),
  memoryMiB: z.number().int().nonnegative(),
  ephemeralStorageMiB: z.number().int().nonnegative(),
});
export type ResourceRequirements = z.infer<typeof ResourceRequirementsSchema>;
