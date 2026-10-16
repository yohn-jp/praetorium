import type { Sha256Digest } from "./digest.js";

export interface OciPlatform {
  readonly os: string;
  readonly architecture: string;
  readonly variant?: string;
}

export interface OciDescriptor {
  readonly mediaType: string;
  readonly digest: Sha256Digest;
  readonly size: number;
  readonly platform?: OciPlatform;
}

export interface VerifiedBlob {
  readonly digest: Sha256Digest;
  readonly mediaType: string;
  readonly size: number;
  readonly bytes: Uint8Array;
}

export interface VerifiedOciImage {
  readonly repository: string;
  readonly manifestDigest: Sha256Digest;
  readonly manifestMediaType: string;
  readonly platformManifestDigest: Sha256Digest;
  readonly platform: OciPlatform;
  readonly configDigest: Sha256Digest;
  readonly layerDescriptors: readonly OciDescriptor[];
  readonly reachableLayerBytes: number;
}

export interface RegistryCredential {
  readonly username: string;
  readonly password: string;
}

export type RegistryAction = "pull" | "push";

export interface RegistryAuthToken {
  readonly registry: string;
  readonly repository: string;
  readonly actions: readonly RegistryAction[];
  readonly token: string;
}
