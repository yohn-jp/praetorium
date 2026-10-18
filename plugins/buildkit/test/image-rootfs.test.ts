import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BuildKitImageRootfsExporter } from "../src/image-rootfs.js";
import type { BuildctlRunner } from "../src/buildctl.js";
import type { BuildKitProviderConfig } from "../src/types.js";

const roots: string[] = [];

async function createConfig(): Promise<BuildKitProviderConfig> {
  const root = await mkdtemp(path.join(tmpdir(), "praetorium-image-rootfs-test-"));
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

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("BuildKit image rootfs export", () => {
  it("exports a digest-pinned image only after its configured startup command and health endpoint pass", async () => {
    const config = await createConfig();
    const metadata = { contractVersion: "scriptorium-platform/v1", producerRevision: "a".repeat(40) };
    let outputDirectory = "";
    const runBuildctl = vi.fn<BuildctlRunner>(async (args, options) => {
      const dockerfile = await readFile(path.join(options.cwd, "Dockerfile"), "utf8");
      const settings = JSON.parse(await readFile(path.join(options.cwd, "praetorium-startup-settings.json"), "utf8")) as Record<string, unknown>;
      const smokeSource = await readFile(path.join(options.cwd, "praetorium-startup-smoke.mjs"), "utf8");
      expect(dockerfile).toContain("FROM --platform=linux/amd64 ghcr.io/scriptorium/image@sha256:" + "1".repeat(64));
      expect(dockerfile).toContain("COPY --chmod=0444 praetorium-startup-smoke.mjs /praetorium-startup-smoke.mjs");
      expect(dockerfile).toContain("COPY --chmod=0444 praetorium-startup-settings.json /praetorium-startup-settings.json");
      expect(dockerfile).toContain("SCRIPTORIUM_HOSTED_MODE=0");
      expect(dockerfile).toContain("RUN --network=none node /praetorium-startup-smoke.mjs /praetorium-startup-settings.json");
      expect(settings.command).toEqual(["/usr/bin/tini", "--", "node", "launch.mjs"]);
      expect(smokeSource).toContain('SCRIPTORIUM_HOSTED_MODE: "0"');
      expect(smokeSource).toContain('SCRIPTORIUM_AUTH_TOKEN: randomBytes(32).toString("base64url")');
      expect(smokeSource).toContain("delete runtimeEnvironment.SCRIPTORIUM_GITHUB_TOKEN");
      expect(args).toContain("tcp://buildkit.example:1234");
      const output = args[args.indexOf("--output") + 1];
      if (!output?.startsWith("type=local,dest=")) throw new Error("local output destination is missing");
      outputDirectory = output.slice("type=local,dest=".length);
      await mkdir(path.join(outputDirectory, "image"), { recursive: true });
      await writeFile(
        path.join(outputDirectory, "smoke-result.json"),
        JSON.stringify({ passed: true, status: 200, healthPath: "/health/ready", metadata }),
      );
    });
    const exporter = new BuildKitImageRootfsExporter(config, { runBuildctl });
    const result = await exporter.exportImage(
      {
        imageReference: `ghcr.io/scriptorium/image@sha256:${"1".repeat(64)}`,
        platform: "linux/amd64",
        startup: {
          entrypoint: ["/usr/bin/tini", "--"],
          command: ["node", "launch.mjs"],
          workingDirectory: "/app",
          port: 3000,
          healthPath: "/health/ready",
          metadataPath: "/api/platform/v1/metadata",
          timeoutMs: 60_000,
        },
      },
      new AbortController().signal,
    );

    expect(result.smokeResult).toEqual({
      passed: true,
      status: 200,
      healthPath: "/health/ready",
      metadata,
    });
    await expect(readFile(path.join(result.imageRoot, "../smoke-result.json"))).resolves.toBeDefined();
    expect(runBuildctl).toHaveBeenCalledOnce();
    expect(outputDirectory).not.toBe("");
    await result.dispose();
    await expect(readFile(path.join(outputDirectory, "smoke-result.json"))).rejects.toThrow();
  });

  it("exports only a validated receipt file, not the entire rootfs", async () => {
    const config = await createConfig();
    const digest = "1".repeat(64);
    const filePath = "/usr/share/scriptorium/composition-manifest.json";
    const runBuildctl = vi.fn<BuildctlRunner>(async (_args, options) => {
      const dockerfile = await readFile(path.join(options.cwd, "Dockerfile"), "utf8");
      expect(dockerfile).toContain(
        "COPY --from=candidate /usr/share/scriptorium/composition-manifest.json /image/usr/share/scriptorium/composition-manifest.json",
      );
      expect(dockerfile).not.toContain("COPY --from=candidate / /image/");
      expect(dockerfile).not.toContain("FROM candidate AS smoke");
    });
    const exporter = new BuildKitImageRootfsExporter(config, { runBuildctl });
    const imageReference = `ghcr.io/scriptorium/image@sha256:${digest}`;
    const result = await exporter.exportImage(
      { imageReference, platform: "linux/amd64", filePath },
      new AbortController().signal,
    );
    expect(result.smokeResult).toBeNull();
    expect(runBuildctl).toHaveBeenCalledOnce();
    await result.dispose();

    for (const invalidPath of [
      "/usr/share/../secret",
      "/usr//share/receipt.json",
      "/usr/share/receipt.json\\nRUN echo unsafe",
      "/usr/share/",
      "/./receipt.json",
    ]) {
      await expect(
        exporter.exportImage(
          { imageReference, platform: "linux/amd64", filePath: invalidPath },
          new AbortController().signal,
        ),
      ).rejects.toThrow("BuildKit image startup input is invalid");
    }
    expect(runBuildctl).toHaveBeenCalledOnce();
    await expect(
      exporter.exportImage(
        {
          imageReference,
          platform: "linux/amd64",
          filePath,
          startup: {
            entrypoint: ["/usr/bin/tini", "--"],
            command: ["node", "launch.mjs"],
            workingDirectory: "/app",
            port: 3000,
            healthPath: "/health/ready",
            timeoutMs: 10_000,
          },
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("BuildKit image startup input is invalid");
  })});
