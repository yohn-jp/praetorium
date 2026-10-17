import { z } from "zod";

/** A coalescible hint to inspect D1; never an assignment or execution grant. */
export const WorkNotificationSchema = z
  .strictObject({
    version: z.literal(1),
    kind: z.enum(["build", "operation"]),
    instanceId: z.string().min(1).max(128).optional(),
  })
  .refine((value) => value.kind === "operation" || value.instanceId === undefined, {
    message: "Only operation notifications can identify an instance",
  });

/** Scoped metadata lookup; the result is never authority to stop a runtime. */
export const RuntimeIdleCandidateRequestSchema = z.strictObject({
  workerId: z.string().min(1).max(128),
  clusterId: z.string().min(1).max(128),
  instanceId: z.string().min(1).max(128),
});

export type WorkNotification = z.infer<typeof WorkNotificationSchema>;
export type RuntimeIdleCandidateRequest = z.infer<typeof RuntimeIdleCandidateRequestSchema>;
