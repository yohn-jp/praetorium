import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBuildctlRunner, sanitizeBuildKitDiagnostic } from "../src/buildctl.js";
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
    const script = `process.stderr.write(${JSON.stringify("BuildKit stage timeout")}); setInterval(() => undefined, 1000)`;
    await expect(
      runner(["-e", script], options),
    ).rejects.toMatchObject({
      code: "BUILD_TIMEOUT",
      diagnostic: { text: "BuildKit stage timeout" },
    });
  });

  it("terminates the child when the attempt is canceled", async () => {
    const controller = new AbortController();
    const options = await makeOptions({ signal: controller.signal });
    const runner = createBuildctlRunner({ buildctlPath: process.execPath });
    const script = `process.stderr.write(${JSON.stringify("compiler error TS5100: invalid option")}); setInterval(() => undefined, 1000)`;
    const run = runner(["-e", script], options);
    const timer = setTimeout(() => controller.abort(), 30);
    await expect(run).rejects.toMatchObject({
      code: "BUILD_CANCELED",
      diagnostic: { text: expect.stringContaining("compiler error TS5100") },
    });
    clearTimeout(timer);
  });

  it("terminates a child that exceeds aggregate progress bytes", async () => {
    const options = await makeOptions({ maxProgressBytes: 2048 });
    const runner = createBuildctlRunner({ buildctlPath: process.execPath });
    const script =
      "process.stdout.write('x'.repeat(8192)+'\\n'); setInterval(() => undefined, 1000)";
    await expect(runner(["-e", script], options)).rejects.toMatchObject({ code: "BUILD_FAILED" });
  });

  it.each([
    { stream: "stdout", newline: true }, { stream: "stderr", newline: true },
    { stream: "stdout", newline: false }, { stream: "stderr", newline: false },
  ])("keeps failed-vertex compiler evidence from $stream (final newline: $newline)", async ({stream,newline}) => {
    const options = await makeOptions();
    const runner = createBuildctlRunner({ buildctlPath: process.execPath });
    const vertex = "sha256:failed";
    const log = [
      "src/app.ts:12:7 - error TS2307: Cannot find module '@praetorium/contracts'",
      "Authorization: Bearer super-secret-header-value",
      "dependency fetch https://user:password@registry.example.test/private?token=secret failed",
      "NPM_TOKEN=secret-value",
      "Error: package unavailable",
    ].join("\n") + "\n";
    const events = [
      JSON.stringify({
        vertexes: [{ digest: vertex }],
        logs: [
          { vertex:"sha256:succeeded",stream:2,data:Buffer.from("Error: unrelated successful vertex\n").toString("base64") },
          { vertex, stream: 2, data: Buffer.from(log, "utf8").toString("base64") },
        ],
      }),
      JSON.stringify({ vertexes: [{ digest: vertex, error: 'process "/bin/sh -c pnpm run build" failed: exit code 1' }] }),
    ].join("\n");
    const script = `process.${stream}.write(${JSON.stringify(events + (newline ? "\n" : ""))}); process.exitCode = 1;`;
    let diagnostic: unknown;
    try {
      await runner(["-e", script], options);
    } catch (error) {
      diagnostic = error;
    }
    expect(diagnostic).toMatchObject({
      code: "BUILD_FAILED",
      diagnostic: { text: expect.stringContaining("error TS2307") },
    });
    const excerpt = (diagnostic as { diagnostic?: { text?: string } }).diagnostic?.text ?? "";
    expect(excerpt).toContain("Cannot find module");
    expect(excerpt).toContain("[url redacted]");
    expect(excerpt).not.toContain("super-secret-header-value");
    expect(excerpt).not.toContain("password@registry");
    expect(excerpt).not.toContain("secret-value");
    expect(excerpt).not.toContain("pnpm run build");
    expect(excerpt).not.toContain("unrelated successful vertex");
    expect(Buffer.byteLength(excerpt, "utf8")).toBeLessThanOrEqual(4096);
  });

  it("drops private-key, command, environment, and header lines and applies a UTF-8 byte cap", () => {
    const safe = sanitizeBuildKitDiagnostic([
      "RUN pnpm install",
      "PRIVATE_VALUE=do-not-store",
      "Cookie: session-secret",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "private-key-body-secret",
      "-----END OPENSSH PRIVATE KEY-----",
      "Build failed for café 🧪 because a module is missing",
    ].join("\n"), 24);

    expect(safe).toMatchObject({ truncated: true });
    expect(Buffer.byteLength(safe?.text ?? "", "utf8")).toBeLessThanOrEqual(24);
    expect(safe?.text).not.toContain("do-not-store");
    expect(safe?.text).not.toContain("session-secret");
    expect(safe?.text).not.toContain("private-key-body-secret");
    expect(sanitizeBuildKitDiagnostic("Authorization: Bearer a-very-long-secret\nNPM_TOKEN=value")).toBeUndefined();
  });

  it("caps the raw diagnostic capture and reports truncation", async () => {
    const options = await makeOptions();
    const runner = createBuildctlRunner({ buildctlPath: process.execPath });
    const vertex = "sha256:large";
    const log = "src/app.ts:12 - error TS2307: " + "missing module detail ".repeat(350) + "\n";
    const events = [
      JSON.stringify({ vertexes: [{ digest: vertex }], logs: [{ vertex, stream: 2, data: Buffer.from(log).toString("base64") }] }),
      JSON.stringify({ vertexes: [{ digest: vertex, error: "solve failed: exit code 1" }] }),
    ].join("\n");
    let failure:unknown;
    try {
      await runner(["-e", `process.stdout.write(${JSON.stringify(events + "\n")});process.exitCode=1;`], options);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code:"BUILD_FAILED",
      diagnostic:{truncated:true},
    });
    const excerpt=(failure as {diagnostic?:{text?:string}}).diagnostic?.text??"";
    expect(Buffer.byteLength(excerpt,"utf8")).toBeLessThanOrEqual(4096);
  });

  it("keeps compiler logs when the solve has no failed Vertex or log vertex identity", async () => {
    const options = await makeOptions();
    const runner = createBuildctlRunner({ buildctlPath: process.execPath });
    const progress = JSON.stringify({
      logs: [{
        stream: 2,
        data: Buffer.from("src/build.ts:9 - error TS2307: Cannot find module 'missing-package'\n").toString("base64"),
      }],
    });
    let failure: unknown;
    try {
      const script = `process.stderr.write(${JSON.stringify(progress + String.fromCharCode(10))});process.exitCode=1;`;
      await runner(["-e", script], options);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "BUILD_FAILED",
      diagnostic: { text: expect.stringContaining("error TS2307") },
    });
    expect((failure as { diagnostic?: { text?: string } }).diagnostic?.text)
      .toContain("Cannot find module");
  });

  it("keeps BuildKit errors without a failed Vertex and filters null-identity errors alongside a failed Vertex", async () => {
    const options = await makeOptions();
    const runner = createBuildctlRunner({ buildctlPath: process.execPath });
    const withoutVertex = JSON.stringify({ error: "failed to solve: source metadata compiler error TS5042" });
    let failure: unknown;
    try {
      await runner(["-e", `process.stderr.write(${JSON.stringify(withoutVertex + "\n")});process.exitCode=1;`], options);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "BUILD_FAILED",
      diagnostic: { text: expect.stringContaining("compiler error TS5042") },
    });

    const withVertex = [
      JSON.stringify({ vertexes: [{ digest: "sha256:failed", error: "failed to solve" }] }),
      JSON.stringify({ error: "compiler error TS5042 without vertex identity" }),
    ].join(String.fromCharCode(10));
    failure = undefined;
    try {
      const script = `process.stderr.write(${JSON.stringify(withVertex + String.fromCharCode(10))});process.exitCode=1;`;
      await runner(["-e", script], options);
    } catch (error) {
      failure = error;
    }
    expect((failure as { diagnostic?: { text?: string } }).diagnostic?.text)
      .toContain("compiler error TS5042 without vertex identity");
  });

  it("uses sanitized plain stderr when BuildKit emits no raw-json diagnostic", async () => {
    const options = await makeOptions();
    const runner = createBuildctlRunner({ buildctlPath: process.execPath });
    let failure: unknown;
    try {
      const raw = [
        "Authorization: Bearer bearer-secret-value",
        "NPM_TOKEN=hidden-value",
        "BuildKit failed with compiler error TS5042 while connecting to https://user:password@builder.example/v1?token=secret",
      ].join(String.fromCharCode(10));
      const script = `process.stderr.write(${JSON.stringify(raw)});process.exitCode=1`;
      await runner(["-e", script], options);
    } catch (error) {
      failure = error;
    }
    const excerpt = (failure as { diagnostic?: { text?: string } }).diagnostic?.text ?? "";
    expect(excerpt).toContain("[url redacted]");
    expect(excerpt).toContain("compiler error TS5042");
    expect(excerpt).not.toMatch(/password|token=secret|bearer-secret-value|hidden-value/u);
    expect(Buffer.byteLength(excerpt, "utf8")).toBeLessThanOrEqual(4096);
  });

  it("redacts a PEM block split across stderr chunks and retains safe evidence after it", async () => {
    const options = await makeOptions();
    const runner = createBuildctlRunner({ buildctlPath: process.execPath });
    const chunks = [
      "-----BEGIN PRIVATE KEY-----\n",
      "compiler error TS5099: base64body-should-not-leak\n",
      "-----END PRIVATE KEY-----\n",
      "compiler error TS5042: module resolution failed\n",
    ];
    const script = `const chunks=${JSON.stringify(chunks)};let index=0;const next=()=>{if(index===chunks.length){process.exitCode=1;return;}process.stderr.write(chunks[index++]);setTimeout(next,10)};next()`;
    let failure: unknown;
    try {
      await runner(["-e", script], options);
    } catch (error) {
      failure = error;
    }
    const excerpt = (failure as { diagnostic?: { text?: string } }).diagnostic?.text ?? "";
    expect(excerpt).toContain("compiler error TS5042");
    expect(excerpt).not.toContain("base64body-should-not-leak");
  });

  it("flushes a trailing log without vertex identity when another failed vertex exists", async () => {
    const options = await makeOptions();
    const runner = createBuildctlRunner({ buildctlPath: process.execPath });
    const events = [
      JSON.stringify({
        logs: [{
          stream: 2,
          data: Buffer.from("compiler error TS2307: Cannot find module 'missing-package'").toString("base64"),
        }],
      }),
      JSON.stringify({ vertexes: [{ digest: "sha256:failed", error: "failed to solve" }] }),
    ].join(String.fromCharCode(10));
    const script = `process.stderr.write(${JSON.stringify(events + String.fromCharCode(10))});process.exitCode=1;`;
    let failure: unknown;
    try {
      await runner(["-e", script], options);
    } catch (error) {
      failure = error;
    }
    expect((failure as { diagnostic?: { text?: string } }).diagnostic?.text)
      .toContain("error TS2307");
  });

  it("omits empty diagnostic output instead of manufacturing an excerpt", async () => {
    const options = await makeOptions();
    const runner = createBuildctlRunner({ buildctlPath: process.execPath });
    await expect(runner(["-e", "process.exitCode=1"], options)).rejects.toMatchObject({
      code: "BUILD_FAILED",
      diagnostic: undefined,
    });
  });
});
