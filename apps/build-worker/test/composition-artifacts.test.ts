import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildKey } from "@praetorium/contracts";
import type { BuildInput, CompositionManifest } from "@praetorium/contracts";
import { sha256Digest, type Sha256Digest } from "@praetorium/ghcr";
import type { BuildKitProviderConfig } from "@praetorium/buildkit";
import type { BuildKitRootfsExporter, CompositionRegistry } from "../src/composition-artifacts.js";
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

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Scriptorium composition receipt reader", () => {
  it("rejects an image path whose parent symlink escapes the exported rootfs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "praetorium-composition-rootfs-test-"));
    roots.push(root);
    const imageRoot = path.join(root, "image");
    const external = path.join(root, "external");
    const metadataFile = path.join(root, "build-metadata.json");
    const imageDigest = `sha256:${"6".repeat(64)}` as Sha256Digest;
    const manifest: CompositionManifest = {
      schemaVersion: "scriptorium-composition/v1",
      buildInput: input,
      buildKey: await buildKey(input),
      producerRevision: input.producerRevision,
      platform: input.platform,
      resolvedModules: [],
      server: { entry: "app/launch.mjs", moduleIds: [] },
      browser: { entry: "app/app/dist/main.js", moduleIds: [] },
      nativeDependencies: [],
      smoke: { id: "health", healthPath: "/health/ready", timeoutSeconds: 5 },
    };
    const externalManifest = path.join(external, "composition-manifest.json");
    await Promise.all([
      mkdir(path.join(imageRoot, "usr", "share"), { recursive: true }),
      mkdir(external, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(metadataFile, JSON.stringify({ "containerimage.digest": imageDigest })),
      writeFile(externalManifest, JSON.stringify(manifest)),
    ]);
    await symlink(external, path.join(imageRoot, "usr", "share", "scriptorium"));

    const rootfsExporter: BuildKitRootfsExporter = {
      exportImage: vi.fn(async () => ({ imageRoot, smokeResult: null, dispose: async () => undefined })),
    };
    const registry: CompositionRegistry = {
      registryHost: "ghcr.io",
      readBlob: vi.fn(),
      publishBlob: vi.fn(async (_repository, bytes) => sha256Digest(bytes)),
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
    const reader = new ScriptoriumBuildCandidateReceiptReader(registry, config, "test/compositions", { rootfsExporter });

    await expect(
      reader.read({
        metadataFile,
        expectedInput: input,
        outputRepository: "ghcr.io/test/candidates",
      }),
    ).rejects.toMatchObject({ code: "BUILD_FAILED" });
    expect(rootfsExporter.exportImage).toHaveBeenCalledOnce();
    expect(registry.publishBlob).not.toHaveBeenCalled();
  });
});
