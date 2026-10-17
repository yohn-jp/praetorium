import { z } from "zod";
import { buildKey, canonicalBuildInput, BuildInputSchema, DigestSchema } from "./build.js";
import { PersistenceCompatibilitySchema } from "./persistence-compatibility.js";

const ModuleIdentitySchema = z.strictObject({
  id: z.string().min(1).max(128),
  version: z.string().min(1).max(128),
  artifactDigest: DigestSchema,
});
const ArtifactEntrySchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^(?!\/)[A-Za-z0-9._/-]+$/u)
  .refine(
    (entry) =>
      entry.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    "entry must be a normalized relative artifact path",
  );
const ModuleIdsSchema = z
  .array(z.string().min(1).max(128))
  .max(256)
  .refine((ids) => new Set(ids).size === ids.length, "closure module ids must be unique")
  .refine(
    (ids) => ids.every((id, index) => index === 0 || ids[index - 1]! < id),
    "closure module ids must be sorted",
  );
const NativeDependencySchema = z.strictObject({
  id: z.string().min(1).max(128),
  version: z.string().min(1).max(128),
  artifactDigest: DigestSchema,
});

/**
 * Proposed producer handoff for immutable composition contents. This is not
 * evidence that the current producer has shipped S01; admission also compares
 * it with an inspector that scans the digest-pinned image and runs its smoke.
 */
export const CompositionManifestSchema = z
  .strictObject({
    schemaVersion: z.literal("scriptorium-composition/v1"),
    buildInput: BuildInputSchema,
    buildKey: DigestSchema,
    producerRevision: z.string().regex(/^[a-f0-9]{40}$/u),
    platform: z.enum(["linux/amd64", "linux/arm64"]),
    resolvedModules: z.array(ModuleIdentitySchema).max(256),
    server: z.strictObject({ entry: ArtifactEntrySchema, moduleIds: ModuleIdsSchema }),
    browser: z.strictObject({ entry: ArtifactEntrySchema, moduleIds: ModuleIdsSchema }),
    nativeDependencies: z.array(NativeDependencySchema).max(512),
    persistence: PersistenceCompatibilitySchema.optional(),
    smoke: z.strictObject({
      id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
      healthPath: z
        .string()
        .regex(/^\/(?!\/)[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/u)
        .max(512),
      timeoutSeconds: z.number().int().min(1).max(300),
    }),
  })
  .refine((manifest) => {
    const nativeIds = manifest.nativeDependencies.map(({ id }) => id);
    return (
      new Set(nativeIds).size === nativeIds.length &&
      nativeIds.every((id, index) => index === 0 || nativeIds[index - 1]! < id)
    );
  }, "native dependencies must have unique, sorted identities");
export type CompositionManifest = z.infer<typeof CompositionManifestSchema>;

/** Structural checks independent of the asynchronous image inspector. */
export async function validateCompositionBindings(value: CompositionManifest): Promise<boolean> {
  const input = BuildInputSchema.parse(JSON.parse(canonicalBuildInput(value.buildInput)));
  if (value.buildKey !== (await buildKey(input))) return false;
  const resolvedIds = new Set(input.resolvedModules.map((module) => module.id));
  if (input.requestedModules.some((id) => !resolvedIds.has(id))) return false;
  if (
    value.producerRevision !== input.producerRevision ||
    value.platform !== input.platform ||
    value.resolvedModules.length !== input.resolvedModules.length
  )
    return false;
  for (let index = 0; index < value.resolvedModules.length; index += 1) {
    const module = value.resolvedModules[index]!;
    const inputModule = input.resolvedModules[index];
    if (
      inputModule === undefined ||
      module.id !== inputModule.id ||
      module.version !== inputModule.version ||
      module.artifactDigest !== inputModule.artifactDigest ||
      (index > 0 && value.resolvedModules[index - 1]!.id >= module.id)
    )
      return false;
  }
  const expectedModuleIds = new Set(input.resolvedModules.map(({ id }) => id));
  const declaredModuleIds = new Set([...value.server.moduleIds, ...value.browser.moduleIds]);
  return (
    expectedModuleIds.size === declaredModuleIds.size &&
    [...expectedModuleIds].every((id) => declaredModuleIds.has(id))
  );
}
