import { z } from "zod";
export const HttpsOriginSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/"
    );
  }, "An HTTPS origin without credentials or path is required");
export const SecretReferenceSchema = z.strictObject({
  path: z.string().regex(/^\/(?!\/)[^\r\n]+$/),
});
export const WorkerPolicySchema = z.strictObject({
  gatewayOrigin: HttpsOriginSchema,
  instanceDomain: z.string().regex(/^(?!.*(?:localhost|example\.(?:com|org|net)))[a-z0-9.-]+$/),
  grantLifetimeSeconds: z.number().int().min(1).max(300),
  handoffLifetimeSeconds: z.number().int().min(1).max(60),
  idleTimeoutSeconds: z.number().int().min(60).max(86400),
});
export type WorkerPolicy = z.infer<typeof WorkerPolicySchema>;
export function requireSecret(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.length < 32 ||
    /^(?:placeholder|changeme|example)/i.test(value)
  )
    throw new Error(`Missing or invalid secret binding: ${name}`);
  return value;
}
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /(token|secret|password|authorization|cookie|private.?key|manuscript)/i.test(key)
          ? "[REDACTED]"
          : redactSecrets(item),
      ]),
    );
  return value;
}
