import type { BuildCandidate, BuildProgress, BuildProvider } from "@praetorium/application/builds";
import type { BuildInput } from "@praetorium/contracts";

export type { BuildCandidate, BuildProgress, BuildProvider };

export type BuildKitProviderConfig = {
  address: string;
  tlsServerName: string;
  tlsCaFile: string;
  tlsCertFile: string;
  tlsKeyFile: string;
  buildctlPath: string;
  buildkitRepository: string;
  outputRepository: string;
  dockerConfigDirectory: string;
  temporaryDirectory: string;
  maxBuildInputBytes: number;
  maxProgressBytes: number;
  buildTimeoutMs: number;
  safePath: string;
  /** Permits an unauthenticated output only for an explicitly configured 127.0.0.1 test registry. */
  allowInsecureLoopbackRegistry?: boolean;
};

export type BuildKitProgressEvent = BuildProgress;
export type BuildKitFailureCode = "BUILD_FAILED" | "BUILD_TIMEOUT" | "BUILD_CANCELED";

/** Trusted adapter for one explicitly approved immutable producer receipt contract. */
export interface BuildCandidateReceiptReader {
  supports(input: BuildInput): boolean;
  read(input: {
    metadataFile: string;
    expectedInput: BuildInput;
    outputRepository: string;
  }): Promise<{ compositionManifest: BuildCandidate["compositionManifest"] }>;
}

export class UnsupportedProducerRecipeError extends Error {
  readonly code = "BUILD_FAILED";
  readonly retryable = false;

  constructor() {
    super("Pinned producer does not implement an approved immutable artifact receipt contract");
    this.name = "UnsupportedProducerRecipeError";
  }
}

export class BuildKitAttemptError extends Error {
  constructor(
    readonly code: BuildKitFailureCode,
    readonly retryable: boolean,
  ) {
    super(code === "BUILD_TIMEOUT" ? "Build exceeded its configured deadline" :
      code === "BUILD_CANCELED" ? "Build was canceled" : "BuildKit solve failed");
    this.name = "BuildKitAttemptError";
  }
}

export class BuildKitConfigurationError extends Error {
  constructor(message = "BuildKit worker configuration is invalid") {
    super(message);
    this.name = "BuildKitConfigurationError";
  }
}
