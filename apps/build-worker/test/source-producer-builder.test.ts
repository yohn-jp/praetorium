import { afterEach, expect, it, vi } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SOURCE_PRODUCER_RESULT_MAX_BYTES } from "@praetorium/contracts";
import {
  assertSourceProducerResultWithinBudget,
  adaptScriptoriumV021Dockerfile,
  buildSourceRelease,
  readSourceProducerFile,
  sourceMetadataDockerfileIgnore,
  SourceBuildVerificationError,
  sourceGitEnvironment,
} from "../src/source-producer-builder.js";

const directories: string[] = [];
const sourceRepository="ghcr.io/yohn-jp/praetorium/scriptorium-producer";

async function executableOnPath(name: string): Promise<string> {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  throw new Error(`${name} is unavailable to the test runner`);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

it("applies the network foundation only to the exact Scriptorium v0.2.1 Dockerfile", async () => {
  // Byte-for-byte fixture from yohn-jp/scriptorium@3189a85bfa28ddd160600a0188ab3ccfa91755e4.
  const original = await readFile(new URL("./fixtures/scriptorium-v0.2.1.Dockerfile", import.meta.url));
  const adapted = adaptScriptoriumV021Dockerfile(
    "3189a85bfa28ddd160600a0188ab3ccfa91755e4", original,
  ).toString("utf8");

  expect(adapted).toContain("NODE_USE_ENV_PROXY=1 NODE_USE_SYSTEM_CA=1");
  expect(adapted).toContain("https://deb.debian.org/debian");
  expect(adapted).toContain("https://deb.debian.org/debian-security");
  expect(adapted.match(/node --input-type=module -e 'import\{rootCertificates\}/gu)).toHaveLength(3);
  expect(adapted).not.toContain("ENV NODE_USE_ENV_PROXY");
  expect(() => adaptScriptoriumV021Dockerfile("f".repeat(40), original)).toThrow(SourceBuildVerificationError);
  const modified = Buffer.from(original);
  modified[0] = modified[0]! ^ 1;
  expect(() => adaptScriptoriumV021Dockerfile(
    "3189a85bfa28ddd160600a0188ab3ccfa91755e4", modified,
  )).toThrow(SourceBuildVerificationError);
});

it("uses Node proxy flags with direct HTTP when no proxy variables are configured", async () => {
  const server = createServer((_request, response) => response.end("direct"));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Loopback HTTP server did not bind");
    const child = spawn(process.execPath, [
      "--input-type=module", "-e",
      `const response=await fetch("http://127.0.0.1:${address.port}/");if(await response.text()!=="direct")process.exit(3);`,
    ], {
      cwd: tmpdir(),
      env: { PATH: process.env.PATH, NODE_USE_ENV_PROXY: "1", NODE_USE_SYSTEM_CA: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (exitCode) => { clearTimeout(timer); resolve(exitCode); });
    });
    expect(code, stderr).toBe(0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

it("keeps tracked .gitconfig out of Git's global configuration", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "praetorium-source-git-test-"));
  directories.push(root);
  const repository = path.join(root, "checkout");
  const privateHome = path.join(root, "git-home");
  const marker = path.join(root, "fsmonitor-ran");
  const hookScript = path.join(root, "fsmonitor-hook");
  const bin = await executableOnPath("git");
  await mkdir(repository);
  await mkdir(privateHome, { mode: 0o700 });
  const gitEnvironment = sourceGitEnvironment(privateHome, path.dirname(bin));
  const runGit = (environment: NodeJS.ProcessEnv, ...args: string[]) => {
    const result = spawnSync(bin, args, { cwd: repository, env: environment, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
    return result.stdout;
  };

  runGit(gitEnvironment, "init", "--quiet");
  runGit(gitEnvironment, "config", "--local", "user.name", "Source test");
  runGit(gitEnvironment, "config", "--local", "user.email", "source-test@example.invalid");
  await writeFile(hookScript, "#!/bin/sh\ntouch " + JSON.stringify(marker) + "\n", { mode: 0o700 });
  await writeFile(path.join(repository, ".gitconfig"), `\n[core]\n\tfsmonitor = ${hookScript}\n`);
  runGit(gitEnvironment, "add", ".gitconfig");
  runGit(gitEnvironment, "commit", "--quiet", "-m", "fixture");

  // Reproduce the previous production environment exactly: HOME pointed at
  // the checkout. Its tracked .gitconfig then launched this process.
  const legacyEnvironment:NodeJS.ProcessEnv={
    PATH:path.dirname(bin),HOME:repository,LANG:"C",GIT_CONFIG_NOSYSTEM:"1",
    GIT_TERMINAL_PROMPT:"0",GIT_CONFIG_COUNT:"2",
    GIT_CONFIG_KEY_0:"core.hooksPath",GIT_CONFIG_VALUE_0:"/dev/null",
    GIT_CONFIG_KEY_1:"protocol.file.allow",GIT_CONFIG_VALUE_1:"never",
  };
  expect(runGit(legacyEnvironment,"status","--porcelain")).toBe("");
  await access(marker);
  await rm(marker,{force:true});

  // The fixed environment is the exact helper called by production checkout.
  expect(runGit(gitEnvironment,"status","--porcelain")).toBe("");
  await expect(access(marker)).rejects.toThrow();
});

it("keeps complete Git provenance outside the exact pinned image exclusions", async () => {
  const ignore = await readFile(new URL("./fixtures/scriptorium-v0.2.1.dockerignore", import.meta.url));
  expect(createHash("sha256").update(ignore).digest("hex"))
    .toBe("74f8c3802e47bd2c62aef7170018255e11e26321e74657a7f8fdd107bdf958f3");
  expect(ignore.toString("utf8").split("\n")).toEqual(expect.arrayContaining([
    ".git", ".github", "docs", ".env.*", ".gitconfig",
  ]));
  // The metadata context is a private, verified Git checkout; ignore no files
  // there so the producer's clean-tree check sees every tracked source file.
  expect(sourceMetadataDockerfileIgnore()).toHaveLength(0);
});

it("rejects a BuildKit metadata path that is a symbolic link", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "praetorium-source-artifact-test-"));
  directories.push(root);
  const secret = path.join(root, "outside.json");
  const exported = path.join(root, "build-catalog.json");
  await writeFile(secret, '{"not":"producer output"}');
  await symlink(secret, exported);

  await expect(readSourceProducerFile(exported, 1024, "BuildKit catalog")).rejects.toThrow();
});

it("rejects a BuildKit output whose parent directory is a symbolic link", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "praetorium-source-artifact-parent-test-"));
  directories.push(root);
  const outside = path.join(root, "outside");
  const exportedDirectory = path.join(root, "resolver");
  await mkdir(outside);
  await writeFile(path.join(outside, "build-catalog.mjs"), "outside output");
  await symlink(outside, exportedDirectory);

  await expect(readSourceProducerFile(
    path.join(exportedDirectory, "build-catalog.mjs"), 1024, "producer resolver bundle",
  )).rejects.toThrow();
});

it("bounds the complete signed proof by canonical UTF-8 bytes before signing", () => {
  const exact={proof:"a".repeat(SOURCE_PRODUCER_RESULT_MAX_BYTES-12)};
  expect(JSON.stringify(exact)).toHaveLength(SOURCE_PRODUCER_RESULT_MAX_BYTES);
  expect(()=>assertSourceProducerResultWithinBudget(exact)).not.toThrow();

  const oversized={proof:"a".repeat(SOURCE_PRODUCER_RESULT_MAX_BYTES-11)};
  expect(()=>assertSourceProducerResultWithinBudget(oversized)).toThrow(SourceBuildVerificationError);

  const multibyte={proof:"é".repeat(32_763)};
  expect(multibyte.proof).toHaveLength(32_763);
  expect(()=>assertSourceProducerResultWithinBudget(multibyte)).toThrow(SourceBuildVerificationError);
});

it("reports an unpublished Source Release as an immutable source change", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "praetorium-source-release-test-"));
  directories.push(root);
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));
  const job = {
    job_id: "sr_11111111-1111-4111-8111-111111111111",
    source_id: "scriptorium" as const,
    source_repository: "yohn-jp/scriptorium" as const,
    github_release_id: 416422590,
    source_tag: "v0.2.1",
    source_revision: "3189a85bfa28ddd160600a0188ab3ccfa91755e4",
    release_version: "0.2.1",
    actor_id: "source-test",
    lease_worker: "source-test",
    lease_token: "11111111-1111-4111-8111-111111111111",
    lease_epoch: 1,
    lease_expires_at: Date.now() + 60_000,
  };
  const config = { buildKit: { temporaryDirectory: root, buildkitRepository: sourceRepository } } as never;

  await expect(buildSourceRelease(job, config, new AbortController().signal))
    .rejects.toMatchObject({ name: "SourceBuildChangedError", code: "SOURCE_CHANGED" });
});

it("rejects non-loopback physical output mappings before contacting GitHub", async () => {
  const job = {
    job_id: "sr_11111111-1111-4111-8111-111111111111",
    source_id: "scriptorium" as const,
    source_repository: "yohn-jp/scriptorium" as const,
    github_release_id: 416422590,
    source_tag: "v0.2.1",
    source_revision: "3189a85bfa28ddd160600a0188ab3ccfa91755e4",
    release_version: "0.2.1",
    actor_id: "source-test",
    lease_worker: "source-test",
    lease_token: "11111111-1111-4111-8111-111111111111",
    lease_epoch: 1,
    lease_expires_at: Date.now() + 60_000,
  };
  const fetch = vi.spyOn(globalThis, "fetch");
  await expect(buildSourceRelease(job, {buildKit:{buildkitRepository:sourceRepository}} as never, new AbortController().signal, {
    isolatedRegistry: { host: "registry.invalid:5000", repositoryPath: "yohn-jp/scriptorium-producer" },
  })).rejects.toThrow("Isolated source registry is available only to loopback tests");
  expect(fetch).not.toHaveBeenCalled();
});
