import { z } from "zod";
export const RepositoryIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const PermissionSchema = z.enum(["read", "write", "maintain", "admin"]);
export const AccessGrantSchema = z
  .strictObject({
    iss: z.string().url(),
    sub: z.string().min(1),
    aud: z.string().url(),
    instanceId: z.string().min(1),
    repositoryId: RepositoryIdSchema,
    runtimeEpoch: z.number().int().nonnegative(),
    permissions: z.array(PermissionSchema).min(1),
    sessionRevision: z.number().int().nonnegative(),
    authorizationRevision: z.number().int().nonnegative(),
    iat: z.number().int(),
    nbf: z.number().int(),
    exp: z.number().int(),
    jti: z.string().min(1),
  })
  .refine((x) => x.exp > x.iat && x.exp - x.iat <= 300 && x.nbf <= x.exp, "Invalid grant lifetime");
export type AccessGrant = z.infer<typeof AccessGrantSchema>;
export function validateGrantBinding(
  value: unknown,
  expected: {
    issuer: string;
    audience: string;
    instanceId: string;
    repositoryId: number;
    runtimeEpoch: number;
    now: number;
  },
): AccessGrant {
  const grant = AccessGrantSchema.parse(value);
  if (
    grant.iss !== expected.issuer ||
    grant.aud !== expected.audience ||
    grant.instanceId !== expected.instanceId ||
    grant.repositoryId !== expected.repositoryId ||
    grant.runtimeEpoch !== expected.runtimeEpoch ||
    grant.exp <= expected.now ||
    grant.nbf > expected.now
  )
    throw new Error("Grant binding mismatch");
  return grant;
}
export type AccessDecision = {
  allowed: boolean;
  permissions: z.infer<typeof PermissionSchema>[];
  checkedAt: number;
  expiresAt: number;
  installationId: number;
  repositoryId: number;
};
export interface AccessProvider {
  authorize(
    user: string,
    repositoryId: number,
    action: z.infer<typeof PermissionSchema>,
  ): Promise<AccessDecision>;
}
