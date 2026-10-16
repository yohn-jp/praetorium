import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildKey } from "@praetorium/contracts";
import type { BuildInput } from "@praetorium/contracts";
import { BuildKitProvider, FRONTEND_INPUT_OPTION } from "../src/provider.js";
import type { BuildctlRunOptions } from "../src/buildctl.js";
import type { BuildKitProviderConfig, BuildCandidateReceiptReader } from "../src/types.js";

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
const imageDigest = `sha256:${"6".repeat(64)}`;
const compositionManifest = {
  repository: "praetorium/compositions",
  digest: `sha256:${"7".repeat(64)}`,
};

async function config(): Promise<BuildKitProviderConfig> {
  const root = await mkdtemp(path.join(tmpdir(), "praetorium-buildkit-provider-test-"));
  roots.push(root);
  const dockerConfigDirectory = path.join(root, "docker");
  const temporaryDirectory = path.join(root, "tmp");
  await mkdir(dockerConfigDirectory, { mode: 0o700 });
  await mkdir(temporaryDirectory, { mode: 0o700 });
  const tlsCaFile = path.join(root, "ca.pem");
  const tlsCertFile = path.join(root, "cert.pem");
  const tlsKeyFile = path.join(root, "key.pem");
  await writeFile(tlsCaFile, "ca");
  await writeFile(tlsCertFile, "cert");
  await writeFile(tlsKeyFile, "key", { mode: 0o600 });
  await writeFile(path.join(dockerConfigDirectory, "config.json"), JSON.stringify({
    auths: { "registry.example": { auth: Buffer.from("user:token").toString("base64") } },
  }), { mode: 0o600 });
  return {
    address: "tcp://buildkit.example:1234",
    tlsServerName: "buildkit.example",
    tlsCaFile,
    tlsCertFile,
    tlsKeyFile,
    buildctlPath: process.execPath,
    buildkitRepository: "registry.example/praetorium/buildkit",
    outputRepository: "registry.example/praetorium/candidates",
    dockerConfigDirectory,
    temporaryDirectory,
    maxBuildInputBytes: 65_536,
    maxProgressBytes: 1024 * 1024,
    buildTimeoutMs: 60_000,
    safePath: "/usr/bin:/bin",
  };
}

function reader(): BuildCandidateReceiptReader {
  return {
    supports: (value) => value.recipeDigest === input.recipeDigest,
    read: async () => ({ compositionManifest }),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("BuildKitProvider", () => {
  it("runs only the fixed gateway frontend and returns an immutable, receipt-bound candidate", async () => {
    const configuration = await config();
    const capturedArgs: string[][] = [];
    const runBuildctl = vi.fn(async (args: readonly string[], options: BuildctlRunOptions) => {
      capturedArgs.push([...args]);
      const metadataPath = args[args.indexOf("--metadata-file") + 1];
      await writeFile(metadataPath!, JSON.stringify({ "containerimage.digest": imageDigest }));
      options.onProgress({ stage: "building", percent: 51 });
    });
    const progress: unknown[] = [];
    const provider = new BuildKitProvider(configuration, { runBuildctl, receiptReader: reader() });
    const key = await buildKey(input);
    const candidate = await provider.execute({
      buildId: "build-1",
      buildKey: key,
      attemptId: "attempt-1",
      attempt: 1,
      leaseEpoch: 1,
      input,
      onProgress: (value) => progress.push(value),
    }, new AbortController().signal, async () => undefined);

    expect(candidate).toEqual({
      candidateRef: `registry.example/praetorium/candidates@${imageDigest}`,
      manifestDigest: imageDigest,
      compositionManifest,
    });
    expect(progress).toContainEqual({ stage: "building", percent: 51 });
    const args = capturedArgs[0]!;
    expect(args).toContain("gateway.v0");
    expect(args).toContain(`source=registry.example/praetorium/buildkit@${input.buildKitDigest}`);
    const optionIndex = args.indexOf("--opt", args.indexOf("--opt") + 1);
    const inputOption = args[optionIndex + 1]!;
    expect(inputOption.startsWith(`${FRONTEND_INPUT_OPTION}=`)).toBe(true);
    expect(JSON.parse(Buffer.from(inputOption.slice(FRONTEND_INPUT_OPTION.length + 1), "base64url").toString("utf8"))).toEqual(input);
    expect(args.some((arg) => ["--local", "--secret", "--ssh", "--file", "--build-arg"].includes(arg))).toBe(false);
    expect(args[args.indexOf("--output") + 1]).toMatch(new RegExp(`^type=image,name=registry\\.example/praetorium/candidates:candidate-${key.slice(7)}-[a-f0-9]{20},push=true$`));
    expect(runBuildctl).toHaveBeenCalledOnce();
    expect(await readdir(configuration.temporaryDirectory)).toEqual([]);
  });

  it("fails before a remote solve when the immutable recipe has no approved receipt reader", async () => {
    const configuration = await config();
    const runBuildctl = vi.fn();
    const provider = new BuildKitProvider(configuration, { runBuildctl, receiptReader: undefined });
    const key = await buildKey(input);
    await expect(provider.execute({
      buildId: "build-1",
      buildKey: key,
      attemptId: "attempt-1",
      attempt: 1,
      leaseEpoch: 1,
      input,
    }, new AbortController().signal, async () => undefined)).rejects.toMatchObject({
      code: "BUILD_FAILED",
      retryable: false,
    });
    expect(runBuildctl).not.toHaveBeenCalled();
    expect(await readdir(configuration.temporaryDirectory)).toEqual([]);
  });

  it("rejects a mismatched build key and stale fence before BuildKit", async () => {
    const configuration = await config();
    const runBuildctl = vi.fn();
    const provider = new BuildKitProvider(configuration, { runBuildctl, receiptReader: reader() });
    await expect(provider.execute({
      buildId: "build-1",
      buildKey: `sha256:${"0".repeat(64)}`,
      attemptId: "attempt-1",
      attempt: 1,
      leaseEpoch: 0,
      input,
    }, new AbortController().signal, async () => undefined)).rejects.toThrow("binding is invalid");
    expect(runBuildctl).not.toHaveBeenCalled();
  });

  it("runs the effect fence immediately before the BuildKit side effect and cleans temporary files after failure", async () => {
    const configuration = await config();
    let fenceCalls = 0;
    const runBuildctl = vi.fn(async (_args: readonly string[], options: BuildctlRunOptions) => {
      const metadataPath = _args[_args.indexOf("--metadata-file") + 1];
      await writeFile(metadataPath!, "{}");
      options.onProgress({ stage: "building", percent: 1 });
    });
    const provider = new BuildKitProvider(configuration, { runBuildctl, receiptReader: reader() });
    const key = await buildKey(input);
    await expect(provider.execute({
      buildId: "build-1",
      buildKey: key,
      attemptId: "attempt-1",
      attempt: 1,
      leaseEpoch: 1,
      input,
    }, new AbortController().signal, async () => { fenceCalls++; })).rejects.toMatchObject({ code: "BUILD_FAILED" });
    expect(fenceCalls).toBe(1);
    expect(await readdir(configuration.temporaryDirectory)).toEqual([]);
  });

  it("does not read or return a candidate receipt after cancellation of the remote solve", async () => {
    const configuration = await config();
    const controller = new AbortController();
    const receiptReader = reader();
    const readReceipt = vi.spyOn(receiptReader, "read");
    const runBuildctl = vi.fn(async (args: readonly string[]) => {
      const metadataPath = args[args.indexOf("--metadata-file") + 1];
      await writeFile(metadataPath!, JSON.stringify({ "containerimage.digest": imageDigest }));
      controller.abort();
    });
    const provider = new BuildKitProvider(configuration, { runBuildctl, receiptReader });
    const key = await buildKey(input);
    await expect(provider.execute({
      buildId: "build-1",
      buildKey: key,
      attemptId: "attempt-1",
      attempt: 1,
      leaseEpoch: 1,
      input,
    }, controller.signal, async () => undefined)).rejects.toMatchObject({ code: "BUILD_CANCELED" });
    expect(readReceipt).not.toHaveBeenCalled();
    expect(await readdir(configuration.temporaryDirectory)).toEqual([]);
  });
});
