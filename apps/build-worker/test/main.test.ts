import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildKey } from "@praetorium/contracts";
import type { BuildClaim, BuildInput, CompositionManifest } from "@praetorium/contracts";
import type { BuildQueuePort } from "@praetorium/application/builds";
import type { BuilderSigner } from "@praetorium/application/builds";
import type { VerifiedOciImage } from "@praetorium/ghcr";
import { createBuildWorker, UnavailableCompositionArtifactInspector } from "../src/main.js";

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

async function workerEnvironment(): Promise<NodeJS.ProcessEnv> {
  const root = await mkdtemp(path.join(tmpdir(), "praetorium-build-worker-main-test-"));
  roots.push(root);
  const dockerConfigDirectory = path.join(root, "docker");
  const temporaryDirectory = path.join(root, "tmp");
  await mkdir(dockerConfigDirectory, { mode: 0o700 });
  await mkdir(temporaryDirectory, { mode: 0o700 });
  const tlsCaFile = path.join(root, "ca.pem");
  const tlsCertFile = path.join(root, "cert.pem");
  const tlsKeyFile = path.join(root, "key.pem");
  const serviceTokenFile = path.join(root, "service-token");
  await writeFile(tlsCaFile, "ca");
  await writeFile(tlsCertFile, "cert");
  await writeFile(tlsKeyFile, "key", { mode: 0o600 });
  await writeFile(serviceTokenFile, "service-token-".padEnd(48, "x"), { mode: 0o600 });
  await writeFile(path.join(dockerConfigDirectory, "config.json"), JSON.stringify({
    auths: { "ghcr.io": { auth: Buffer.from("builder:push-token").toString("base64") } },
  }), { mode: 0o600 });
  return {
    PRAETORIUM_BUILD_WORKER_ID: "worker-1",
    PRAETORIUM_CONTROL_PLANE_URL: "https://control.example",
    PRAETORIUM_BUILD_SERVICE_TOKEN_FILE: serviceTokenFile,
    PRAETORIUM_BUILD_SIGNING_KEY_FILE: path.join(root, "builder-key.pem"),
    PRAETORIUM_BUILD_SIGNING_KEY_ID: "builder-key-v1",
    PRAETORIUM_BUILD_REGISTRY_URL: "https://ghcr.io",
    PRAETORIUM_BUILD_COMPOSITION_REPOSITORY: "test/compositions",
    PRAETORIUM_BUILD_MAX_IMAGE_LAYER_BYTES: "2147483648",
    PRAETORIUM_BUILD_MAX_IMAGE_VERIFICATION_MS: "300000",
    PRAETORIUM_BUILD_MAX_REGISTRY_REQUEST_MS: "30000",
    PRAETORIUM_BUILDKIT_ADDRESS: "tcp://buildkit.internal:1234",
    PRAETORIUM_BUILDKIT_TLS_SERVER_NAME: "buildkit.internal",
    PRAETORIUM_BUILDKIT_TLS_CA_FILE: tlsCaFile,
    PRAETORIUM_BUILDKIT_TLS_CERT_FILE: tlsCertFile,
    PRAETORIUM_BUILDKIT_TLS_KEY_FILE: tlsKeyFile,
    PRAETORIUM_BUILDKIT_BUILDCTL_PATH: process.execPath,
    PRAETORIUM_BUILDKIT_FRONTEND_REPOSITORY: "ghcr.io/test/buildkit",
    PRAETORIUM_BUILDKIT_OUTPUT_REPOSITORY: "ghcr.io/test/candidates",
    PRAETORIUM_BUILDKIT_DOCKER_CONFIG_DIRECTORY: dockerConfigDirectory,
    PRAETORIUM_BUILDKIT_TEMPORARY_DIRECTORY: temporaryDirectory,
    PRAETORIUM_BUILDKIT_SAFE_PATH: "/usr/bin:/bin",
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("build worker composition", () => {
  it("uses the canonical queue/provider path and fails closed without an approved producer receipt", async () => {
    const environment = await workerEnvironment();
    const claim: BuildClaim = {
      buildId: "build-1",
      buildKey: await buildKey(input),
      input,
      attemptId: "attempt-1",
      attempt: 1,
      leaseEpoch: 1,
      leaseToken: "f".repeat(48),
      leaseExpiresAt: Date.now() + 60_000,
    };
    const reports: Array<{ result: unknown }> = [];
    const queue: BuildQueuePort = {
      claimNext: vi.fn(async () => claim),
      heartbeat: vi.fn(async () => ({ accepted: true, cancelRequested: false, leaseExpiresAt: Date.now() + 60_000 })),
      report: vi.fn(async (report) => {
        reports.push({ result: report.result });
        return { accepted: true, duplicate: false };
      }),
    };
    const signer: BuilderSigner = { sign: vi.fn(async () => { throw new Error("signer should not run"); }) };
    const worker = await createBuildWorker(environment, { queue, signer });

    await expect(worker.runOnce()).resolves.toBe(true);
    expect(reports).toEqual([{
      result: {
        kind: "failed",
        code: "BUILD_FAILED",
        message: "BuildKit solve failed",
        retryable: false,
      },
    }]);
    expect(signer.sign).not.toHaveBeenCalled();
  });

  it("provides an inspector that rejects candidate verification until a real image scanner exists", async () => {
    const inspector = new UnavailableCompositionArtifactInspector();
    const digest = `sha256:${"6".repeat(64)}` as `sha256:${string}`;
    const image: VerifiedOciImage = {
      repository: "test/candidates",
      manifestDigest: digest,
      manifestMediaType: "application/vnd.oci.image.manifest.v1+json",
      platformManifestDigest: digest,
      platform: { os: "linux", architecture: "amd64" },
      configDigest: digest,
      layerDescriptors: [],
      reachableLayerBytes: 0,
    };
    const compositionManifest: CompositionManifest = {
      schemaVersion: "scriptorium-composition/v1",
      buildInput: input,
      buildKey: `sha256:${"7".repeat(64)}`,
      producerRevision: input.producerRevision,
      platform: input.platform,
      resolvedModules: [],
      server: { entry: "server.js", moduleIds: [] },
      browser: { entry: "browser.js", moduleIds: [] },
      nativeDependencies: [],
      smoke: { id: "health", healthPath: "/health", timeoutSeconds: 5 },
    };
    await expect(inspector.inspectAndSmoke({
      imageReference: `ghcr.io/test/candidates@${digest}`,
      image,
      compositionManifest,
    }, new AbortController().signal)).rejects.toThrow(/unavailable/u);
  });
});
