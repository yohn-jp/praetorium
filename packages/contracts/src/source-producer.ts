import { z } from "zod";
import { BuildCatalogSchema, RuntimeMetadataSchema } from "./producer.js";
import { ProducerRevisionSchema, ResolverRevisionSchema } from "./artifact-identity.js";

export const SOURCE_PRODUCER_RESULT_MAX_BYTES = 65_536;
export const SOURCE_PRODUCER_REQUEST_MAX_BYTES = 70 * 1024;

/**
 * Producer evidence is signed by the existing trusted Build Worker Ed25519 key.
 * It is distinct from a composition attestation and cannot claim Stable on its own.
 */
export const SourceResolverDescriptorSchema = z.strictObject({
  producerRevision: ProducerRevisionSchema,
  resolverRevision: ResolverRevisionSchema,
  contractVersion: z.literal("scriptorium-build/v1"),
  provenanceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
});
export const SourceProducerStatementSchema = z.strictObject({
  schemaVersion: z.literal(3),
  jobId: z.string().regex(/^sr_[0-9a-f-]{36}$/u),
  githubReleaseId: z.number().int().positive().safe(),
  sourceId: z.literal("scriptorium"),
  sourceRepository: z.literal("yohn-jp/scriptorium"),
  sourceTag: z.string().min(1).max(128),
  sourceRevision: ProducerRevisionSchema,
  releaseVersion: z.string().min(1).max(128),
  imageRepository: z.string().max(255).regex(/^ghcr\.io\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/u),
  runtimeBaseDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  buildKitDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  catalogDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  runtimeMetadataDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  nodeImage: z.string().max(512).regex(/^(?:[a-z0-9.-]+(?::[0-9]+)?\/)+[a-z0-9._/-]+(?::[A-Za-z0-9._-]+)?@sha256:[a-f0-9]{64}$/u),
  buildEnvironmentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  resolverDigest: ResolverRevisionSchema,
  resolverProvenanceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
});
const SignatureSchema = z.strictObject({
    algorithm: z.literal("Ed25519"),
    keyId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u),
    signature: z.string().min(1).max(512),
  });
export const SourceProducerResultSchema = z.strictObject({
  statement: SourceProducerStatementSchema,
  signature: SignatureSchema,
  catalog: BuildCatalogSchema,
  runtimeMetadata: RuntimeMetadataSchema,
  resolver: SourceResolverDescriptorSchema,
});
export type SourceResolverDescriptor = z.infer<typeof SourceResolverDescriptorSchema>;
export type SourceProducerStatement = z.infer<typeof SourceProducerStatementSchema>;
export type SourceProducerResult = z.infer<typeof SourceProducerResultSchema>;

/** Stable bytes shared by Node Builder signer and Worker/D1 verifier. */
export function canonicalSourceProof(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalSourceProof).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return "{" + Object.entries(value as Record<string,unknown>)
      .sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key,v]) => JSON.stringify(key) + ":" + canonicalSourceProof(v)).join(",") + "}";
  }
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError("Proof contains unsupported data");
  return json;
}
export function sourceProducerResultByteLength(value: unknown): number {
  return new TextEncoder().encode(canonicalSourceProof(value)).byteLength;
}
export async function sourceProofDigest(value: unknown): Promise<`sha256:${string}`> {
  const bytes = new TextEncoder().encode(canonicalSourceProof(value));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${Array.from(digest,x=>x.toString(16).padStart(2,"0")).join("")}`;
}
