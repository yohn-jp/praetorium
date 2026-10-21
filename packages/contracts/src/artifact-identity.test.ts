import { describe, expect, it } from "vitest";
import { ImageReferenceSchema, ProducerRevisionSchema, ResolverRevisionSchema, repositoryPathForHost } from "./artifact-identity.js";

describe("immutable artifact identity boundaries", () => {
  it("converts only the exact configured host to a repository path", () => {
    expect(repositoryPathForHost("ghcr.io/owner/repo", "ghcr.io")).toBe("owner/repo");
    for (const input of ["evil.example/owner/repo", "ghcr.io.evil/owner/repo", "https://ghcr.io/owner/repo", "ghcr.io/owner/repo@sha256:" + "a".repeat(64), "ghcr.io/owner/../repo"])
      expect(() => repositoryPathForHost(input, "ghcr.io")).toThrow();
  });
  it("distinguishes source revisions, resolver bytes and immutable image coordinates", () => {
    expect(ProducerRevisionSchema.safeParse("a".repeat(40)).success).toBe(true);
    expect(ProducerRevisionSchema.safeParse("sha256:" + "a".repeat(64)).success).toBe(false);
    expect(ResolverRevisionSchema.safeParse("a".repeat(40)).success).toBe(false);
    expect(ImageReferenceSchema.safeParse({ registryHost: "ghcr.io", repositoryPath: "owner/repo", digest: "latest" }).success).toBe(false);
  });
});
