import type { BuildCatalog } from "@praetorium/contracts";
import type {
  ReleaseAdmissionResult,
  ReleaseCandidateManifest,
  ReleaseCandidateVerifier,
  ReleaseProducerMetadataVerifier,
} from "./model.js";

export interface ImmutableReleaseImageVerifier {
  verifyImage(
    repository: string,
    digest: string,
    platform: { readonly os: string; readonly architecture: string },
  ): Promise<{
    readonly repository: string;
    readonly manifestDigest: string;
    readonly platform: { readonly os: string; readonly architecture: string };
  }>;
}

export interface SourceProvenanceVerifier {
  verify(input: {
    readonly imageDigest: string;
    readonly signatureRef: string;
    readonly provenanceRef: string;
  }): Promise<{
    readonly verified: boolean;
    readonly signerIdentity?: string;
    readonly evidence: readonly string[];
  }>;
}

export type ReleaseVerifierFailureClassifier = (error: unknown) => "retry" | "rejected";

export interface RegistryBackedReleaseVerifierDeps {
  readonly registry: ImmutableReleaseImageVerifier;
  readonly provenance: SourceProvenanceVerifier;
  /** Required because image-subject verification alone cannot bind producer catalog fields. */
  readonly producerMetadata: ReleaseProducerMetadataVerifier;
  readonly classifyRegistryError?: ReleaseVerifierFailureClassifier;
}

function defaultRegistryFailure(error: unknown): "retry" | "rejected" {
  if (typeof error === "object" && error !== null && "reason" in error) {
    return (error as { readonly reason?: unknown }).reason === "invalid_content"
      ? "rejected"
      : "retry";
  }
  return error instanceof TypeError || error instanceof RangeError ? "rejected" : "retry";
}

function supportedPlatforms(
  catalog: BuildCatalog,
): readonly { readonly os: string; readonly architecture: string }[] {
  const allowed = new Set(["linux/amd64", "linux/arm64"]);
  return catalog.supportedPlatforms
    .filter((platform) => allowed.has(platform))
    .map((platform) => {
      const [os, architecture] = platform.split("/");
      return { os: os!, architecture: architecture! };
    });
}

/**
 * Bridges the canonical source release manifest to T05's digest-only OCI and
 * Sigstore providers. It verifies every supported Linux platform before a
 * candidate can be written to the admission catalog.
 */
export function createRegistryBackedReleaseVerifier(
  deps: RegistryBackedReleaseVerifierDeps,
): ReleaseCandidateVerifier {
  const classify = deps.classifyRegistryError ?? defaultRegistryFailure;
  return {
    async verify(manifest: ReleaseCandidateManifest): Promise<ReleaseAdmissionResult> {
      const platforms = supportedPlatforms(manifest.catalog);
      if (platforms.length === 0) {
        return { kind: "rejected", reason: "release has no supported Linux runtime platform" };
      }

      for (const platform of platforms) {
        let verifiedImage;
        try {
          verifiedImage = await deps.registry.verifyImage(
            manifest.imageRepository,
            manifest.catalog.runtimeBaseDigest,
            platform,
          );
        } catch (error) {
          return {
            kind: classify(error),
            reason: `runtime base image verification failed for ${platform.os}/${platform.architecture}`,
          };
        }
        if (
          verifiedImage.repository !== manifest.imageRepository ||
          verifiedImage.manifestDigest !== manifest.catalog.runtimeBaseDigest ||
          verifiedImage.platform.os !== platform.os ||
          verifiedImage.platform.architecture !== platform.architecture
        ) {
          return {
            kind: "rejected",
            reason: `runtime base image identity mismatch for ${platform.os}/${platform.architecture}`,
          };
        }
      }

      let provenance;
      try {
        provenance = await deps.provenance.verify({
          imageDigest: manifest.catalog.runtimeBaseDigest,
          signatureRef: manifest.signatureRef,
          provenanceRef: manifest.provenanceRef,
        });
      } catch {
        return { kind: "retry", reason: "source provenance verifier is unavailable" };
      }
      if (!provenance.verified) {
        return {
          kind: "rejected",
          reason: provenance.evidence.join("; ") || "source provenance verification failed",
        };
      }
      let producerMetadata: ReleaseAdmissionResult;
      try {
        producerMetadata = await deps.producerMetadata.verify({
          imageRepository: manifest.imageRepository,
          imageDigest: manifest.catalog.runtimeBaseDigest,
          producerRevision: manifest.catalog.producerRevision,
          catalog: manifest.catalog,
          runtimeMetadata: manifest.runtimeMetadata,
        });
      } catch {
        return { kind: "retry", reason: "producer metadata verifier is unavailable" };
      }
      if (producerMetadata.kind !== "verified") return producerMetadata;
      return {
        kind: "verified",
        evidence: [
          ...platforms.map(
            ({ os, architecture }) =>
              `registry verified ${os}/${architecture} at the immutable image digest`,
          ),
          ...(provenance.signerIdentity ? [`Sigstore signer: ${provenance.signerIdentity}`] : []),
          ...provenance.evidence,
          ...producerMetadata.evidence,
        ],
      };
    },
  };
}
