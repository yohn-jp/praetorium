import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBuildctlRunner } from "../src/buildctl.js";
import type { BuildctlRunOptions } from "../src/buildctl.js";

const directories: string[] = [];

async function makeOptions(
  overrides: Partial<BuildctlRunOptions> = {},
): Promise<BuildctlRunOptions> {
  const root = await mkdtemp(path.join(tmpdir(), "praetorium-buildctl-test-"));
  directories.push(root);
  return {
    cwd: root,
    dockerConfigDirectory: path.join(root, "docker"),
    temporaryDirectory: root,
    safePath: "/usr/bin:/bin",
    buildTimeoutMs: 5000,
    maxProgressBytes: 64 * 1024,
    signal: new AbortController().signal,
    onProgress: () => undefined,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("remote buildctl execution", () => {
  it("parses bounded progress and keeps raw output and parent environment private", async () => {
    const options = await makeOptions();
    const environmentFile = path.join(options.temporaryDirectory, "child-env.json");
    const progress: unknown[] = [];
    const runner = createBuildctlRunner({ buildctlPath: process.execPath });
    const script = `require('node:fs').writeFileSync(${JSON.stringify(environmentFile)}, JSON.stringify(Object.keys(process.env).sort())); process.stdout.write(JSON.stringify({vertexes:[{completed:'now'},{}],logs:'private'})); process.stderr.write('private stderr');`;
    await runner(["-e", script], { ...options, onProgress: (value) => progress.push(value) });

    expect(progress).toEqual([{ stage: "building", percent: 50 }]);
    const childEnvironment = JSON.parse(await readFile(environmentFile, "utf8")) as string[];
    expect(childEnvironment).toEqual(["DOCKER_CONFIG", "HOME", "LANG", "PATH", "TMPDIR"]);
    expect(childEnvironment).not.toContain("PRAETORIUM_CONTROL_TOKEN");
  });

  it("kills a solve that exceeds its deadline", async () => {
    const options = await makeOptions({ buildTimeoutMs: 1000 });
    const runner = createBuildctlRunner({ buildctlPath: process.execPath });
    await expect(
      runner(["-e", "setInterval(() => undefined, 1000)"], options),
    ).rejects.toMatchObject({ code: "BUILD_TIMEOUT" });
  });

  it("terminates the child when the attempt is canceled", async () => {
    const controller = new AbortController();
    const options = await makeOptions({ signal: controller.signal });
    const runner = createBuildctlRunner({ buildctlPath: process.execPath });
    const run = runner(["-e", "setInterval(() => undefined, 1000)"], options);
    const timer = setTimeout(() => controller.abort(), 30);
    await expect(run).rejects.toMatchObject({ code: "BUILD_CANCELED" });
    clearTimeout(timer);
  });

  it("terminates a child that exceeds aggregate progress bytes", async () => {
    const options = await makeOptions({ maxProgressBytes: 2048 });
    const runner = createBuildctlRunner({ buildctlPath: process.execPath });
    const script =
      "process.stdout.write('x'.repeat(8192)+'\\n'); setInterval(() => undefined, 1000)";
    await expect(runner(["-e", script], options)).rejects.toMatchObject({ code: "BUILD_FAILED" });
  });
});
