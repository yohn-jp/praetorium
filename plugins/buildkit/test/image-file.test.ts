import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BuildKitImageFileExporter } from "../src/image-file.js";
import type { BuildctlRunner } from "../src/buildctl.js";
import type { BuildKitProviderConfig } from "../src/types.js";

const roots: string[] = [];

async function createConfig(): Promise<BuildKitProviderConfig> {
  const root = await mkdtemp(path.join(tmpdir(), "praetorium-metadata-test-"));
  roots.push(root);
  const temporaryDirectory = path.join(root, "tmp");
  const dockerConfigDirectory = path.join(root, "docker");
  await Promise.all([
    mkdir(temporaryDirectory, { mode: 0o700 }),
    mkdir(dockerConfigDirectory, { mode: 0o700 }),
  ]);
  return {
    address: "tcp://buildkit.example:1234",
    tlsServerName: "buildkit.example",
    tlsCaFile: path.join(root, "ca.pem"),
    tlsCertFile: path.join(root, "cert.pem"),
    tlsKeyFile: path.join(root, "key.pem"),
    buildctlPath: process.execPath,
    buildkitRepository: "ghcr.io/praetorium/buildkit",
    outputRepository: "ghcr.io/praetorium/candidates",
    dockerConfigDirectory,
    temporaryDirectory,
    maxBuildInputBytes: 65_536,
    maxProgressBytes: 1024 * 1024,
    buildTimeoutMs: 60_000,
    safePath: "/usr/bin:/bin",
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("BuildKit immutable metadata export", () => {
  it("returns only the requested metadata bytes without exporting the image filesystem", async () => {
    const config = await createConfig();
    const bytes = Buffer.from('{"schemaVersion":"scriptorium-composition/v1"}');
    const imageReference = `ghcr.io/praetorium/candidates@sha256:${"1".repeat(64)}`;
    const runBuildctl = vi.fn<BuildctlRunner>(async (args, options) => {
      const dockerfile = await readFile(path.join(options.cwd, "Dockerfile"), "utf8");
      expect(dockerfile).toContain(`FROM --platform=linux/amd64 ${imageReference} AS candidate`);
      expect(dockerfile).toContain(
        "COPY --from=candidate /usr/share/scriptorium/composition-manifest.json /receipt.json",
      );
      expect(dockerfile).not.toContain("COPY --from=candidate / /image/");
      expect(dockerfile).not.toContain("RUN --network=none");
      expect(args).toContain("tcp://buildkit.example:1234");
      const output = args[args.indexOf("--output") + 1];
      if (!output?.startsWith("type=local,dest=")) throw new Error("local export path missing");
      await writeFile(path.join(output.slice("type=local,dest=".length), "receipt.json"), bytes);
    });
    const exporter = new BuildKitImageFileExporter(config, { runBuildctl });
    const result = await exporter.exportFile(
      {
        imageReference,
        platform: "linux/amd64",
        filePath: "/usr/share/scriptorium/composition-manifest.json",
      },
      new AbortController().signal,
    );
    expect(result.bytes).toEqual(bytes);
    expect(runBuildctl).toHaveBeenCalledOnce();
  });

  it("rejects arbitrary Dockerfile path syntax before BuildKit execution", async () => {
    const config = await createConfig();
    const runBuildctl = vi.fn<BuildctlRunner>();
    const exporter = new BuildKitImageFileExporter(config, { runBuildctl });
    const imageReference = `ghcr.io/praetorium/candidates@sha256:${"2".repeat(64)}`;
    for (const filePath of [
      "/usr/share/../secret",
      "/usr//share/receipt.json",
      "/usr/share/receipt.json\\nRUN echo unsafe",
      "/usr/share/",
      "/./receipt.json",
      "/usr/share/*.json",
    ]) {
      await expect(exporter.exportFile(
        { imageReference, platform: "linux/amd64", filePath },
        new AbortController().signal,
      )).rejects.toThrow("BuildKit metadata file export input is invalid");
    }
    expect(runBuildctl).not.toHaveBeenCalled();
  });

  it("rejects missing or oversized metadata rather than signing an incomplete build", async () => {
    const config = await createConfig();
    const imageReference = `ghcr.io/praetorium/candidates@sha256:${"3".repeat(64)}`;
    const runBuildctl = vi.fn<BuildctlRunner>(async (args) => {
      const output = args[args.indexOf("--output") + 1];
      if (!output?.startsWith("type=local,dest=")) throw new Error("local export path missing");
      await writeFile(path.join(output.slice("type=local,dest=".length), "receipt.json"), Buffer.alloc(4 * 1024 * 1024 + 1));
    });
    const exporter = new BuildKitImageFileExporter(config, { runBuildctl });
    await expect(exporter.exportFile(
      { imageReference, platform: "linux/amd64", filePath: "/usr/share/scriptorium/composition-manifest.json" },
      new AbortController().signal,
    )).rejects.toMatchObject({ code: "BUILD_FAILED" });
  });
});
