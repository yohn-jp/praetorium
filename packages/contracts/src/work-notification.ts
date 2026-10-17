import { z } from "zod";

/** A coalescible hint to inspect D1; never an assignment or execution grant. */
export const WorkNotificationSchema = z.strictObject({
  version: z.literal(1),
  kind: z.enum(["build", "operation"]),
});

export type WorkNotification = z.infer<typeof WorkNotificationSchema>;
