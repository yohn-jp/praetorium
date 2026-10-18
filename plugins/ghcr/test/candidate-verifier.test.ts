import { buildKey, type BuildInput, type CompositionManifest } from "@praetorium/contracts";
import { describe, expect, it, vi } from "vitest";
import { GhcrCandidateVerifier } from "../src/candidate-verifier.js";
import { sha256Digest } from "../src/digest.js";
import { GhcrRegistryClient } from "../src/oci-registry-client.js";
import type { VerifiedOciImage } from "../src/oci-types.js";

const digestA = `sha256:${"a".repeat(64)}` as const;
const digestB = `sha256:${"b".repeat(64)}` as const;
const digestC = `sha256:${"c".repeat(64)}` as const;
const activeSignal = new AbortController().signal;
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
    registryHost: "ghcr.io",
    verifyImage: vi.fn(async (repository: string, manifestDigest: string) => {
      return { ...image, repository, manifestDigest };
    }),
    readBlob: vi.fn(async (repository: string, digest: string) => {
      return { repository, digest, mediaType: "application/json", size: compositionBytes.byteLength, bytes: compositionBytes };
    }),
  } as unknown as GhcrRegistryClient;
  const verifier = new GhcrCandidateVerifier(registry, () => new Date("2026-10-17T00:00:00.000Z"));
  const candidate = {
    expectedInput: input,
    expectedBuildKey: key as typeof digestA,
    candidateRef: `ghcr.io/praetorium/derived@${digestA}`,
    manifestDigest: digestA,
    compositionManifest: { repository: "praetorium/derived", digest: compositionDigest },
  };
  return { verifier, registry, candidate, compositionDigest, compositionBytes, image };
}

const approvedOutput = { registryHost: "ghcr.io", repository: "praetorium/derived" } as const;
const registryLimits = {
  allowedRepositories: ["praetorium/derived"],
  maxImageLayerBytes: 1024 * 1024,
  maxImageVerificationMs: 5_000,
  maxRegistryRequestMs: 1_000,
  fetch: vi.fn(async () => new Response(null, { status: 404 })) as typeof fetch,
};

function configuredRegistry(registryUrl: string, allowInsecureLoopback = false): GhcrRegistryClient {
  return new GhcrRegistryClient({
    ...registryLimits,
    registryUrl,
    allowInsecureLoopback,
  });
}

function stubConfiguredRegistry(
  registry: GhcrRegistryClient,
  image: VerifiedOciImage,
  compositionBytes: Uint8Array,
  compositionDigest: string,
): void {
  vi.spyOn(registry, "verifyImage").mockResolvedValue(image);
  vi.spyOn(registry, "readBlob").mockResolvedValue({
    digest: compositionDigest as typeof digestA,
    mediaType: "application/json",
    size: compositionBytes.byteLength,
    bytes: compositionBytes,
  });
}

describe("GHCR candidate verification", () => {
  it("binds trusted builder output to persisted input and digest-addressed composition metadata", async () => {
    const { verifier, registry, candidate, compositionDigest } = await fixture();

    await expect(verifier.verifyUnsignedCandidate(candidate, approvedOutput, activeSignal)).resolves.toEqual({
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
    expect(registry.readBlob).toHaveBeenCalledWith(
      candidate.compositionManifest.repository, compositionDigest, 4 * 1024 * 1024, activeSignal,
    );
    expect(registry.verifyImage).toHaveBeenCalledWith("praetorium/derived", digestA, { os: "linux", architecture: "amd64" }, activeSignal);
  });

  it("rejects an altered composition receipt even from the configured registry", async () => {
    const { verifier, registry, candidate } = await fixture();
    vi.spyOn(registry, "readBlob").mockResolvedValue({
      digest: candidate.compositionManifest.digest,
      mediaType: "application/json",
      size: 2,
      bytes: new TextEncoder().encode("{}"),
    });
    await expect(verifier.verifyUnsignedCandidate(candidate, approvedOutput, activeSignal))
      .rejects.toMatchObject({ reason: "composition" });
  });

  it("rejects when persisted input does not hash to the expected build key", async () => {
    const { verifier, candidate } = await fixture();
    await expect(verifier.verifyUnsignedCandidate({ ...candidate, expectedBuildKey: digestC }, approvedOutput, activeSignal))
      .rejects.toMatchObject({ reason: "invalid_candidate" });
  });

  it("rejects an arbitrary caller-approved registry host before registry access", async () => {
    const { verifier, registry, candidate } = await fixture();
    await expect(verifier.verifyUnsignedCandidate({
      ...candidate,
      candidateRef: `attacker.example/praetorium/derived@${digestA}`,
    }, { registryHost: "attacker.example", repository: "praetorium/derived" }, activeSignal))
      .rejects.toMatchObject({ reason: "invalid_candidate" });
    expect(registry.verifyImage).not.toHaveBeenCalled();
  });

  it("accepts the exact configured custom HTTPS registry host", async () => {
    const { candidate, compositionDigest, compositionBytes, image } = await fixture();
    const registry = configuredRegistry("https://registry.example.test");
    stubConfiguredRegistry(registry, image, compositionBytes, compositionDigest);
    const verifier = new GhcrCandidateVerifier(registry);
    const configuredCandidate = {
      ...candidate,
      candidateRef: `${registry.registryHost}/praetorium/derived@${digestA}`,
    };

    await expect(verifier.verifyUnsignedCandidate(configuredCandidate, {
      registryHost: registry.registryHost,
      repository: "praetorium/derived",
    }, activeSignal)).resolves.toBeDefined();
  });

  it("accepts the exact explicitly enabled loopback registry host and port", async () => {
    const { candidate, compositionDigest, compositionBytes, image } = await fixture();
    const registry = configuredRegistry("http://127.0.0.1:39567", true);
    stubConfiguredRegistry(registry, image, compositionBytes, compositionDigest);
    const verifier = new GhcrCandidateVerifier(registry);
    const configuredCandidate = {
      ...candidate,
      candidateRef: `${registry.registryHost}/praetorium/derived@${digestA}`,
    };

    await expect(verifier.verifyUnsignedCandidate(configuredCandidate, {
      registryHost: registry.registryHost,
      repository: "praetorium/derived",
    }, activeSignal)).resolves.toBeDefined();
  });

  it("rejects registry URL credentials instead of exposing them in the configured host", () => {
    expect(() => configuredRegistry("https://operator:secret@registry.example.test"))
      .toThrow("registry URL must be HTTPS");
  });

  it("rejects a valid digest from a different repository than the persisted output approval", async () => {
    const { verifier, candidate } = await fixture();
    await expect(verifier.verifyUnsignedCandidate({
      ...candidate,
      candidateRef: `ghcr.io/praetorium/source@${digestA}`,
    }, approvedOutput, activeSignal)).rejects.toMatchObject({ reason: "invalid_candidate" });
  });

  it("stops before registry access when the build attempt has been canceled", async () => {
    const { verifier, registry, candidate } = await fixture();
    const controller = new AbortController();
    controller.abort();

    await expect(verifier.verifyUnsignedCandidate(candidate, approvedOutput, controller.signal))
      .rejects.toMatchObject({ reason: "canceled" });
    expect(registry.verifyImage).not.toHaveBeenCalled();
  });

});
