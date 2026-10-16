import { z } from "zod";
export const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const BuildInputSchema = z.strictObject({
  contractVersion: z.literal("scriptorium-build/v1"),
  producerRevision: z.string().regex(/^[a-f0-9]{40}$/),
  runtimeBaseDigest: DigestSchema,
  buildKitDigest: DigestSchema,
  recipeDigest: DigestSchema,
  sourceDigest: DigestSchema,
  lockDigest: DigestSchema,
  requestedModules: z.array(z.string().min(1)),
  resolvedModules: z.array(
    z.strictObject({
      id: z.string().min(1),
      version: z.string().min(1),
      artifactDigest: DigestSchema,
    }),
  ),
  platform: z.enum(["linux/amd64", "linux/arm64"]),
  options: z.strictObject({}),
});
export type BuildInput = z.infer<typeof BuildInputSchema>;
export function canonicalBuildInput(value: unknown): string {
  const input = BuildInputSchema.parse(value);
  if (
    new Set(input.requestedModules).size !== input.requestedModules.length ||
    new Set(input.resolvedModules.map((x) => x.id)).size !== input.resolvedModules.length
  )
    throw new Error("Duplicate modules");
  return JSON.stringify({
    ...input,
    requestedModules: [...input.requestedModules].sort(),
    resolvedModules: [...input.resolvedModules].sort((a, b) => a.id.localeCompare(b.id)),
  });
}
export async function buildKey(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalBuildInput(value)),
  );
  return `sha256:${Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, "0")).join("")}`;
}
