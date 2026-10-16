import { z } from "zod";
import { DigestSchema } from "./build.js";
const ModuleIdentitySchema = z.strictObject({
  id: z.string().min(1),
  version: z.string().min(1),
  artifactDigest: DigestSchema,
});
const RepositorySchema = z
  .string()
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/);
export const BuilderArtifactStatementSchema = z.strictObject({
  schemaVersion: z.literal("praetorium.build-artifact/v1"),
  buildKey: DigestSchema,
  artifact: z.strictObject({
    repository: RepositorySchema,
    digest: DigestSchema,
    platformManifestDigest: DigestSchema,
    platform: z.enum(["linux/amd64", "linux/arm64"]),
  }),
  compositionManifest: z.strictObject({ repository: RepositorySchema, digest: DigestSchema }),
  producerRevision: z.string().regex(/^[a-f0-9]{40}$/),
  resolvedModules: z.array(ModuleIdentitySchema),
  contractVersion: z.literal("scriptorium-build/v1"),
  issuedAt: z.string().datetime(),
});
export const BuilderSignatureSchema = z.strictObject({
  algorithm: z.literal("Ed25519"),
  keyId: z.string().min(1).max(128),
  signature: z
    .string()
    .regex(/^[A-Za-z0-9+/]+={0,2}$/)
    .max(1024),
});
export type BuilderArtifactStatement = z.infer<typeof BuilderArtifactStatementSchema>;
export type BuilderSignature = z.infer<typeof BuilderSignatureSchema>;
