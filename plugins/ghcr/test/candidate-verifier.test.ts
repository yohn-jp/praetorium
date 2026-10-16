import { buildKey, type BuildInput, type CompositionManifest } from "@praetorium/contracts";
import { describe, expect, it } from "vitest";
import { CandidateVerificationError, GhcrCandidateVerifier, type CompositionArtifactInspector } from "../src/candidate-verifier.js";
import { sha256Digest } from "../src/digest.js";
import type { GhcrRegistryClient } from "../src/oci-registry-client.js";
import type { VerifiedOciImage } from "../src/oci-types.js";

const digestA = `sha256:${"a".repeat(64)}` as const;
const digestB = `sha256:${"b".repeat(64)}` as const;
const digestC = `sha256:${"c".repeat(64)}` as const;
const input: BuildInput = {
  contractVersion: "scriptorium-build/v1",
  producerRevision: "a".repeat(40),
  runtimeBaseDigest: digestA,
  buildKitDigest: digestB,
  recipeDigest: digestC,
  sourceDigest: digestA,
  lockDigest: digestB,
  requestedModules: ["core"],
  resolvedModules: [{ id: "core", version: "1.0.0", artifactDigest: digestC }],
  platform: "linux/amd64",
  options: {},
};

async function fixture() {
  const key = await buildKey(input);
  const manifest: CompositionManifest = {
    schemaVersion: "scriptorium-composition/v1",
    buildInput: input,
    buildKey: key as typeof digestA,
    producerRevision: input.producerRevision,
    platform: input.platform,
    resolvedModules: input.resolvedModules,
    server: { entry: "dist/server.js", moduleIds: ["core"] },
    browser: { entry: "dist/browser.js", moduleIds: ["core"] },
    nativeDependencies: [],
    smoke: { id: "runtime-ready", healthPath: "/health", timeoutSeconds: 5 },
  };
  const compositionBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const compositionDigest = await sha256Digest(compositionBytes);
  const image: VerifiedOciImage = {
    repository: "praetorium/derived",
    manifestDigest: digestA,
    manifestMediaType: "application/vnd.oci.image.index.v1+json",
    platformManifestDigest: digestB,
    platform: { os: "linux", architecture: "amd64" },
    configDigest: digestC,
    layerDescriptors: [],
    reachableLayerBytes: 0,
  };
  const registry = {
    async verifyImage(repository: string, manifestDigest: string) {
      return { ...image, repository, manifestDigest };
    },
    async readBlob(repository: string, digest: string) {
      return { repository, digest, mediaType: "application/json", size: compositionBytes.byteLength, bytes: compositionBytes };
    },
  } as unknown as GhcrRegistryClient;
  const inspection: CompositionArtifactInspector = {
    async inspectAndSmoke() {
      return {
        imageDigest: digestA,
        compositionManifestDigest: compositionDigest,
        serverEntry: "dist/server.js",
        browserEntry: "dist/browser.js",
        serverModuleIds: ["core"],
        browserModuleIds: ["core"],
        nativeDependencies: [],
        smoke: { id: "runtime-ready", healthPath: "/health", passed: true },
      };
    },
  };
  const verifier = new GhcrCandidateVerifier(registry, inspection, () => new Date("2026-10-17T00:00:00.000Z"));
  const candidate = {
    expectedInput: input,
    expectedBuildKey: key as typeof digestA,
    candidateRef: `praetorium/derived@${digestA}`,
    manifestDigest: digestA,
    compositionManifest: { repository: "praetorium/derived", digest: compositionDigest },
  };
  return { verifier, registry, candidate, compositionDigest };
}

describe("GHCR candidate verification", () => {
  it("returns a canonical statement only after persisted-input, composition, closure, and smoke checks", async () => {
    const { verifier, candidate, compositionDigest } = await fixture();

    await expect(verifier.verifyUnsignedCandidate(candidate)).resolves.toEqual({
      schemaVersion: "praetorium.build-artifact/v1",
      buildKey: candidate.expectedBuildKey,
      artifact: {
        repository: "praetorium/derived",
        digest: digestA,
        platformManifestDigest: digestB,
        platform: "linux/amd64",
      },
      compositionManifest: { repository: "praetorium/derived", digest: compositionDigest },
      producerRevision: input.producerRevision,
      resolvedModules: input.resolvedModules,
      contractVersion: "scriptorium-build/v1",
      issuedAt: "2026-10-17T00:00:00.000Z",
    });
  });

  it("rejects a mismatched closure and a failed smoke instead of returning a signable statement", async () => {
    const { registry, candidate } = await fixture();
    const badInspector: CompositionArtifactInspector = {
      async inspectAndSmoke() {
        return {
          imageDigest: digestA,
          compositionManifestDigest: candidate.compositionManifest.digest,
          serverEntry: "dist/server.js",
          browserEntry: null,
          serverModuleIds: ["core"],
          browserModuleIds: [],
          nativeDependencies: [],
          smoke: { id: "runtime-ready", healthPath: "/health", passed: false },
        };
      },
    };
    const badVerifier = new GhcrCandidateVerifier(registry, badInspector);

    await expect(badVerifier.verifyUnsignedCandidate(candidate)).rejects.toBeInstanceOf(CandidateVerificationError);
  });

  it("rejects a failed declared health smoke even when the inspected closure matches", async () => {
    const { registry, candidate } = await fixture();
    const failedSmoke: CompositionArtifactInspector = {
      async inspectAndSmoke() {
        return {
          imageDigest: digestA,
          compositionManifestDigest: candidate.compositionManifest.digest,
          serverEntry: "dist/server.js",
          browserEntry: "dist/browser.js",
          serverModuleIds: ["core"],
          browserModuleIds: ["core"],
          nativeDependencies: [],
          smoke: { id: "runtime-ready", healthPath: "/health", passed: false },
        };
      },
    };

    await expect(new GhcrCandidateVerifier(registry, failedSmoke).verifyUnsignedCandidate(candidate))
      .rejects.toMatchObject({ reason: "smoke" });
  });

  it("rejects when persisted input does not hash to the expected build key", async () => {
    const { verifier, candidate } = await fixture();
    await expect(verifier.verifyUnsignedCandidate({ ...candidate, expectedBuildKey: digestC }))
      .rejects.toMatchObject({ reason: "invalid_candidate" });
  });
});
