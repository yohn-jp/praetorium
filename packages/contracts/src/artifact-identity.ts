import { z } from "zod";

/** Wire identities are deliberately separate: a Git revision is not a bundle digest. */
export const ProducerRevisionSchema = z.string().regex(/^[a-f0-9]{40}$/u).brand<"ProducerRevision">();
export const ResolverRevisionSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u).brand<"ResolverRevision">();
export const RegistryHostSchema = z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[1-9][0-9]{0,4})?$/u).brand<"RegistryHost">();
export const RepositoryPathSchema = z.string().regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/u).brand<"RepositoryPath">();
export const ImageReferenceSchema = z.strictObject({
  registryHost: RegistryHostSchema,
  repositoryPath: RepositoryPathSchema,
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
});
export type ProducerRevision = z.infer<typeof ProducerRevisionSchema>;
export type ResolverRevision = z.infer<typeof ResolverRevisionSchema>;
export type RegistryHost = z.infer<typeof RegistryHostSchema>;
export type RepositoryPath = z.infer<typeof RepositoryPathSchema>;
export type ImageReference = z.infer<typeof ImageReferenceSchema>;

/** No URL normalization: callers must supply the exact canonical registry identity. */
export function repositoryPathForHost(repository: string, expectedHost: string): RepositoryPath {
  const host = RegistryHostSchema.parse(expectedHost);
  const prefix = host + "/";
  if (!repository.startsWith(prefix)) throw new TypeError("Image registry host is not approved");
  return RepositoryPathSchema.parse(repository.slice(prefix.length));
}
