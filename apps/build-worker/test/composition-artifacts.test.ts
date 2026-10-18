import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildKey, type BuildInput, type CompositionManifest } from "@praetorium/contracts";
import { sha256Digest, type Sha256Digest } from "@praetorium/ghcr";
import type { BuildKitProviderConfig } from "@praetorium/buildkit";
import type { BuildKitFileExporter, CompositionRegistry } from "../src/composition-artifacts.js";
import { ScriptoriumBuildCandidateReceiptReader } from "../src/composition-artifacts.js";

const roots: string[] = [];
const input: BuildInput = {
  contractVersion: "scriptorium-build/v1",
  producerRevision: "a".repeat(40),
  runtimeBaseDigest: `sha256:${"1".repeat(64)}`,
  buildKitDigest: `sha256:${"2".repeat(64)}`,
  recipeDigest: `sha256:${"3".repeat(64)}`,
  sourceDigest: `sha256:${"4".repeat(64)}`,
  lockDigest: `sha256:${"5".repeat(64)}`,
  requestedModules: [],
  resolvedModules: [],
  platform: "linux/amd64",
  options: {},
};

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "praetorium-receipt-test-"));
  roots.push(root);
  const digest = `sha256:${"6".repeat(64)}` as Sha256Digest;
  const metadataFile = path.join(root, "build-metadata.json");
  await writeFile(metadataFile, JSON.stringify({ "containerimage.digest": digest }));
  const manifest: CompositionManifest = {
    schemaVersion: "scriptorium-composition/v1",
    buildInput: input,
    buildKey: (await buildKey(input)) as Sha256Digest,
    producerRevision: input.producerRevision,
    platform: input.platform,
    resolvedModules: [],
    server: { entry: "app/launch.mjs", moduleIds: [] },
    browser: { entry: "app/app/dist/main.js", moduleIds: [] },
    nativeDependencies: [],
    smoke: { id: "health", healthPath: "/health/ready", timeoutSeconds: 5 },
  };
  const config: BuildKitProviderConfig = {
    address: "tcp://buildkit.internal:1234",
    tlsServerName: "buildkit.internal",
    tlsCaFile: "/unused/ca.pem",
    tlsCertFile: "/unused/cert.pem",
    tlsKeyFile: "/unused/key.pem",
    buildctlPath: "/unused/buildctl",
    buildkitRepository: "ghcr.io/test/buildkit",
    outputRepository: "ghcr.io/test/candidates",
    dockerConfigDirectory: "/unused/docker",
    temporaryDirectory: "/unused/tmp",
    maxBuildInputBytes: 4096,
    maxProgressBytes: 4096,
    buildTimeoutMs: 10_000,
    safePath: "/usr/bin:/bin",
  };
  return { digest, metadataFile, manifest, config };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Scriptorium trusted builder metadata", () => {
  it("publishes the bounded composition manifest and binds it to the original BuildInput", async () => {
    const { digest, metadataFile, manifest, config } = await fixture();
    const bytes = new TextEncoder().encode(JSON.stringify(manifest));
    const manifestDigest = await sha256Digest(bytes);
    const fileExporter: BuildKitFileExporter = { exportFile: vi.fn(async () => ({ bytes })) };
    const registry: CompositionRegistry = {
      registryHost: "ghcr.io",
      publishBlob: vi.fn(async () => manifestDigest),
    };
    const reader = new ScriptoriumBuildCandidateReceiptReader(
      registry, config, "test/compositions", { fileExporter },
    );
    await expect(reader.read({
      metadataFile, expectedInput: input, outputRepository: "ghcr.io/test/candidates",
    })).resolves.toEqual({
      compositionManifest: { repository: "test/compositions", digest: manifestDigest },
    });
    expect(fileExporter.exportFile).toHaveBeenCalledWith(
      {
        imageReference: `ghcr.io/test/candidates@${digest}`,
        platform: "linux/amd64",
        filePath: "/usr/share/scriptorium/composition-manifest.json",
      },
      expect.any(AbortSignal),
    );
    expect(registry.publishBlob).toHaveBeenCalledWith("test/compositions", bytes, undefined);
  });

  it("rejects a builder receipt whose modules differ from the immutable selection", async () => {
    const { metadataFile, manifest, config } = await fixture();
    const bytes = new TextEncoder().encode(JSON.stringify({
      ...manifest,
      buildInput: { ...manifest.buildInput, requestedModules: ["unapproved"] },
    }));
    const fileExporter: BuildKitFileExporter = { exportFile: vi.fn(async () => ({ bytes })) };
    const registry: CompositionRegistry = {
      registryHost: "ghcr.io",
      publishBlob: vi.fn(async () => sha256Digest(bytes)),
    };
    const reader = new ScriptoriumBuildCandidateReceiptReader(
      registry, config, "test/compositions", { fileExporter },
    );
    await expect(reader.read({
      metadataFile, expectedInput: input, outputRepository: "ghcr.io/test/candidates",
    })).rejects.toMatchObject({ code: "BUILD_FAILED" });
    expect(registry.publishBlob).not.toHaveBeenCalled();
  });
});
