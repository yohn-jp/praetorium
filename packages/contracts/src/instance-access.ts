import { z } from "zod";
const InstanceIdSchema = z.string().min(1).max(128);
const HostnameSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/);
const OriginSchema = z
  .string()
  .url()
  .refine((value) => {
    const u = new URL(value);
    return (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      !u.port &&
      u.pathname === "/" &&
      !u.search &&
      !u.hash
    );
  }, "Exact HTTPS instance origin required");
const ReturnPathSchema = z
  .string()
  .max(2048)
  .regex(/^\/(?!\/)[^\r\n\\]*$/);
const RequestShape = {
  contractVersion: z.literal("instance-access/v1"),
  audience: z.literal("instance-access"),
  instanceId: InstanceIdSchema,
  hostname: HostnameSchema,
  origin: OriginSchema,
};
const matchingHost = (input: { hostname: string; origin: string }) =>
  new URL(input.origin).hostname === input.hostname;
export const RedeemHandoffRequestSchema = z
  .strictObject({
    ...RequestShape,
    code: z.string().min(16).max(256),
    returnPath: ReturnPathSchema,
  })
  .refine(matchingHost, "Host and origin mismatch");
export const RefreshAccessRequestSchema = z
  .strictObject({ ...RequestShape, refreshCredential: z.string().min(16).max(1024) })
  .refine(matchingHost, "Host and origin mismatch");
export const RevokeAccessRequestSchema = RefreshAccessRequestSchema;
const CredentialResponseShape = {
  contractVersion: z.literal("instance-access/v1"),
  token: z.string().min(1).max(16384),
  expiresAt: z.string().datetime(),
  refreshCredential: z.string().min(16).max(1024),
  refreshExpiresAt: z.string().datetime(),
};
export const RedeemHandoffResponseSchema = z.strictObject(CredentialResponseShape);
export const RefreshAccessResponseSchema = z.strictObject(CredentialResponseShape);
export const RevokeAccessResponseSchema = z.strictObject({
  contractVersion: z.literal("instance-access/v1"),
  revoked: z.literal(true),
});
export type RedeemHandoffRequest = z.infer<typeof RedeemHandoffRequestSchema>;
export type RedeemHandoffResponse = z.infer<typeof RedeemHandoffResponseSchema>;
export type RefreshAccessRequest = z.infer<typeof RefreshAccessRequestSchema>;
export type RefreshAccessResponse = z.infer<typeof RefreshAccessResponseSchema>;
export type RevokeAccessRequest = z.infer<typeof RevokeAccessRequestSchema>;
export type RevokeAccessResponse = z.infer<typeof RevokeAccessResponseSchema>;
