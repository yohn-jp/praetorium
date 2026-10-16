import type {
  BuilderArtifactStatement,
  BuilderSignature,
  BuildInput,
} from "@praetorium/contracts";
import type { Sha256Digest } from "./digest.js";

export type { BuilderArtifactStatement, BuilderSignature } from "@praetorium/contracts";
export type ArtifactPlatform = BuilderArtifactStatement["artifact"]["platform"];

export interface OciPlatform {
  readonly os: string;
  readonly architecture: string;
  readonly variant?: string;
}

export interface ArtifactBlobDescriptor {
  readonly digest: Sha256Digest;
  readonly size: number;
  readonly mediaType: string;
}

export interface RegistryVerifiedImage {
  readonly repository: string;
  readonly manifestDigest: Sha256Digest;
  readonly platformManifestDigest: Sha256Digest;
  readonly platform: OciPlatform;
  readonly configDigest: Sha256Digest;
  readonly layerDescriptors: readonly ArtifactBlobDescriptor[];
  readonly reachableLayerBytes: number;
}

export interface RegistryVerifiedBlob {
  readonly digest: Sha256Digest;
  readonly mediaType: string;
  readonly size: number;
  readonly bytes: Uint8Array;
}

/** Neutral application port; plugins implement it structurally. */
export interface ArtifactRegistryProvider {
  verifyImage(repository: string, manifestDigest: string, platform: OciPlatform): Promise<RegistryVerifiedImage>;
  readBlob(repository: string, digest: string, maxBytes?: number): Promise<RegistryVerifiedBlob>;
}

export interface BuilderSignatureVerification {
  readonly verified: boolean;
  readonly keyId?: string;
  readonly reason?: string;
}

/** Neutral application port; only configured operator public keys may verify derived output. */
export interface BuilderSignatureVerifier {
  verify(statement: BuilderArtifactStatement, signature: BuilderSignature): Promise<BuilderSignatureVerification>;
}

export interface ArtifactCandidate {
  readonly statement: BuilderArtifactStatement;
  readonly signature: BuilderSignature;
}

export interface VerifiedArtifact {
  readonly schemaVersion: 1;
  readonly buildKey: Sha256Digest;
  /** Persisted immutable input is required to recompute the cache key on every hit. */
  readonly buildInput: BuildInput;
  readonly image: {
    readonly repository: string;
    readonly digest: Sha256Digest;
    readonly reference: string;
    readonly platformManifestDigest: Sha256Digest;
    readonly platform: ArtifactPlatform;
  };
  readonly compositionManifest: {
    readonly repository: string;
    readonly digest: Sha256Digest;
  };
  readonly producerRevision: string;
  readonly resolvedModules: BuilderArtifactStatement["resolvedModules"];
  readonly contractVersion: string;
  readonly issuedAt: string;
  readonly signerKeyId: string;
  readonly signature: BuilderSignature;
  readonly verifiedAt: string;
  readonly reachableLayerBytes: number;
  readonly compositionManifestBytes: number;
}
