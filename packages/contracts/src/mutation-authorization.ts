import { z } from "zod";
import { RepositoryIdSchema } from "./access.js";
import { DigestSchema } from "./build.js";
/** Signed Gateway decision for one specific authoring publication; never a posted actor ID. */
export const MutationAuthorizationReceiptSchema = z
  .strictObject({
    contractVersion: z.literal("praetorium-mutation/v1"),
    iss: z.string().url(),
    sub: z.string().min(1).max(128),
    aud: z.string().min(1).max(512),
    repositoryId: RepositoryIdSchema,
    instanceId: z.string().min(1).max(128),
    runtimeEpoch: z.number().int().positive(),
    operationId: z.string().min(1).max(128),
    payloadDigest: DigestSchema,
    action: z.literal("publish"),
    authorizationRevision: z.number().int().nonnegative(),
    sessionRevision: z.number().int().nonnegative(),
    iat: z.number().int(),
    nbf: z.number().int(),
    exp: z.number().int(),
    jti: z.string().min(1).max(128),
  })
  .refine(
    (x) => x.exp > x.iat && x.exp - x.iat <= 60 && x.nbf <= x.exp,
    "Mutation authorization must expire within 60 seconds",
  );
export type MutationAuthorizationReceipt = z.infer<typeof MutationAuthorizationReceiptSchema>;
export function assertMutationReceiptBinding(
  value: unknown,
  expected: {
    issuer: string;
    audience: string;
    repositoryId: number;
    instanceId: string;
    runtimeEpoch: number;
    operationId: string;
    payloadDigest: string;
    now: number;
  },
): MutationAuthorizationReceipt {
  if (!Number.isSafeInteger(expected.now) || expected.now < 0)
    throw new Error("Invalid mutation authorization clock");
  const receipt = MutationAuthorizationReceiptSchema.parse(value);
  if (
    receipt.iss !== expected.issuer ||
    receipt.aud !== expected.audience ||
    receipt.repositoryId !== expected.repositoryId ||
    receipt.instanceId !== expected.instanceId ||
    receipt.runtimeEpoch !== expected.runtimeEpoch ||
    receipt.operationId !== expected.operationId ||
    receipt.payloadDigest !== expected.payloadDigest ||
    receipt.exp <= expected.now ||
    receipt.nbf > expected.now ||
    receipt.iat > expected.now
  )
    throw new Error("Mutation authorization binding mismatch");
  return receipt;
}
