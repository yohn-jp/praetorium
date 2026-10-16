import { z } from "zod";
import { RepositoryIdSchema } from "./access.js";
import { DigestSchema } from "./build.js";
/** Private metadata-only control capability, separate from hosted user grants and Git credentials. */
export const RuntimeControlCredentialSchema = z
  .strictObject({
    contractVersion: z.literal("praetorium-runtime-control/v1"),
    iss: z.string().url(),
    sub: z.string().min(1).max(128),
    aud: z.string().min(1).max(512),
    instanceId: z.string().min(1).max(128),
    repositoryId: RepositoryIdSchema,
    runtimeEpoch: z.number().int().positive(),
    operationId: z.string().min(1).max(128),
    action: z.enum(["status", "quiesce", "resume"]),
    payloadDigest: DigestSchema,
    iat: z.number().int().nonnegative(),
    nbf: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
    jti: z.string().min(1).max(128),
  })
  .refine(
    (x) => x.exp > x.iat && x.exp - x.iat <= 60 && x.nbf >= x.iat && x.nbf < x.exp,
    "Invalid runtime control credential lifetime",
  );
export type RuntimeControlCredential = z.infer<typeof RuntimeControlCredentialSchema>;
export function assertRuntimeControlBinding(
  value: unknown,
  expected: {
    issuer: string;
    audience: string;
    instanceId: string;
    repositoryId: number;
    runtimeEpoch: number;
    operationId: string;
    action: RuntimeControlCredential["action"];
    payloadDigest: string;
    now: number;
  },
): RuntimeControlCredential {
  const claims = RuntimeControlCredentialSchema.parse(value);
  if (
    !Number.isSafeInteger(expected.now) ||
    expected.now < 0 ||
    claims.iss !== expected.issuer ||
    claims.aud !== expected.audience ||
    claims.instanceId !== expected.instanceId ||
    claims.repositoryId !== expected.repositoryId ||
    claims.runtimeEpoch !== expected.runtimeEpoch ||
    claims.operationId !== expected.operationId ||
    claims.action !== expected.action ||
    claims.payloadDigest !== expected.payloadDigest ||
    claims.iat > expected.now ||
    claims.nbf > expected.now ||
    claims.exp <= expected.now
  )
    throw new Error("Runtime control credential binding mismatch");
  return claims;
}
