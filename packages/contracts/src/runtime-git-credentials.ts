import { z } from "zod";

/** Ciphertext only. The Gateway vault key and GitHub bearer never enter D1. */
export const RuntimeGitCredentialRegistrationSchema = z.strictObject({
  tokenId: z.string().regex(/^[a-f0-9]{64}$/u),
  repositoryId: z.number().int().positive().safe(),
  installationId: z.number().int().positive().safe(),
  instanceId: z.string().min(1).max(128),
  runtimeId: z.string().min(1).max(128),
  runtimeEpoch: z.number().int().positive().safe(),
  leaseId: z.string().min(1).max(128),
  permission: z.enum(["read", "write"]),
  expiresAt: z.iso.datetime(),
  encryptedSecret: z.strictObject({
    version: z.literal(1),
    keyId: z.string().min(1).max(128),
    iv: z.string().regex(/^[A-Za-z0-9_-]{16}$/u),
    ciphertext: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/u)
      .max(32768),
  }),
});
export type RuntimeGitCredentialRegistration = z.infer<
  typeof RuntimeGitCredentialRegistrationSchema
>;
export const RuntimeGitCredentialRecordSchema = RuntimeGitCredentialRegistrationSchema.extend({
  status: z.enum(["active", "revocation_pending", "revoked"]),
  createdAt: z.number().int().nonnegative().safe(),
  updatedAt: z.number().int().nonnegative().safe(),
});
export type RuntimeGitCredentialRecord = z.infer<typeof RuntimeGitCredentialRecordSchema>;
