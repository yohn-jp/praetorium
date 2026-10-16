import { describe, expect, it } from "vitest";
import type { ReleaseCandidateManifest } from "./model.js";
import { createRegistryBackedReleaseVerifier } from "./verifier.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const PRODUCER = "a".repeat(40);

function manifest(): ReleaseCandidateManifest {
  return {
    schemaVersion: 1,
    version: "1.2.3",
    imageRepository: "example/runtime",
    catalog: {
      contractVersion: "scriptorium-build/v1",
      producerRevision: PRODUCER,
      runtimeBaseDigest: DIGEST,
      buildKitDigest: DIGEST,
      recipeDigest: DIGEST,
      lockDigest: DIGEST,
      sourceDigest: DIGEST,
      supportedPlatforms: ["linux/amd64", "linux/arm64"],
      modules: [],
      baseResources: { cpuMilli: 0, memoryMiB: 0, ephemeralStorageMiB: 0 },
      sharedResourceGroups: [],
      resourceProfiles: [],
    },
    runtimeMetadata: {
      contractVersion: "scriptorium-platform/v1",
      producerRevision: PRODUCER,
      listener: { port: 3000 },
      paths: {
        liveness: "/health/live",
        readiness: "/health/ready",
        metadata: "/api/platform/v1/metadata",
        shutdown: "/api/platform/v1/shutdown",
        status: "/api/platform/v1/status",
        quiesce: "/api/platform/v1/quiesce",
        resume: "/api/platform/v1/resume",
      },
      shutdownTimeoutSeconds: 30,
    },
    signatureRef: "https://evidence.example/signature",
    provenanceRef: "https://evidence.example/provenance",
  };
}

describe("registry-backed release verifier", () => {
  it("checks every supported Linux digest and attests the exact producer catalog and metadata", async () => {
    const input = manifest();
    const imageChecks: string[] = [];
    let attested: unknown;
    const verifier = createRegistryBackedReleaseVerifier({
      registry: {
        async verifyImage(repository, digest, platform) {
          imageChecks.push(`${repository}:${digest}:${platform.os}/${platform.architecture}`);
          return { repository, manifestDigest: digest, platform };
        },
      },
      provenance: {
        async verify() {
          return {
            verified: true,
            signerIdentity: "release-signer",
            evidence: ["sigstore verified"],
          };
        },
      },
      producerMetadata: {
        async verify(metadata) {
          attested = metadata;
          return { kind: "verified", evidence: ["producer contract attested"] };
        },
      },
    });

    const result = await verifier.verify(input);

    expect(result.kind).toBe("verified");
    expect(imageChecks).toEqual([
      `example/runtime:${DIGEST}:linux/amd64`,
      `example/runtime:${DIGEST}:linux/arm64`,
    ]);
    expect(attested).toEqual({
      imageRepository: input.imageRepository,
      imageDigest: DIGEST,
      producerRevision: PRODUCER,
      catalog: input.catalog,
      runtimeMetadata: input.runtimeMetadata,
    });
    if (result.kind === "verified") {
      expect(result.evidence).toContain("producer contract attested");
      expect(result.evidence).toContain("Sigstore signer: release-signer");
    }
  });

  it("fails closed when the producer catalog attestation rejects the candidate", async () => {
    const verifier = createRegistryBackedReleaseVerifier({
      registry: {
        async verifyImage(repository, digest, platform) {
          return { repository, manifestDigest: digest, platform };
        },
      },
      provenance: {
        async verify() {
          return { verified: true, evidence: [] };
        },
      },
      producerMetadata: {
        async verify() {
          return { kind: "rejected", reason: "catalog is not in the signed producer manifest" };
        },
      },
    });

    await expect(verifier.verify(manifest())).resolves.toEqual({
      kind: "rejected",
      reason: "catalog is not in the signed producer manifest",
    });
  });
});
