import { z } from "zod";
import { RepositoryIdSchema } from "./access.js";
const Id = z.string().min(1).max(128);
/** Platform-only runtime service identity; never a user grant or GitHub token. */
export const RuntimeIdentityCredentialSchema = z
  .strictObject({
    contractVersion: z.literal("praetorium-runtime-identity/v1"),
    iss: z.url().startsWith("https://"),
    aud: z.literal("praetorium-git-broker"),
    sub: Id,
    runtimeId: Id,
    instanceId: Id,
    repositoryId: RepositoryIdSchema,
    installationId: z.number().int().positive().safe(),
    runtimeEpoch: z.number().int().positive().safe(),
    leaseId: Id,
    iat: z.number().int().nonnegative().safe(),
    nbf: z.number().int().nonnegative().safe(),
    exp: z.number().int().positive().safe(),
    jti: Id,
  })
  .refine(
    (value) =>
      value.sub === value.runtimeId &&
      value.nbf === value.iat &&
      value.exp > value.iat &&
      value.exp - value.iat <= 300,
    { message: "Runtime identity must bind its subject and a lifetime of at most five minutes" },
  );
export type RuntimeIdentityCredential = z.infer<typeof RuntimeIdentityCredentialSchema>;
