import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BoundedOutputTail,
  FixtureChildProcessError,
  removeOwnedBuildKitRoot,
  run,
  sanitizeFixtureDiagnostic,
  stopPrivilegedProcessGroup,
} from "../../scripts/ci/fixture-process.mjs";

test("fixture child diagnostics retain the bounded trailing output", () => {
  const tail = new BoundedOutputTail(12);
  tail.append("earlier output");
  tail.append("final-marker");
  assert.equal(tail.byteLength, 12);
  assert.equal(tail.toString(), "final-marker");
});

test(
  "fixture child timeout terminates the owned process group",
  { skip: process.platform === "win32" },
  async () => {
    await assert.rejects(
      run("sh", ["-c", "sleep 30 & wait"], { timeoutMs: 100, killGraceMs: 100 }),
      (error) => {
        assert.ok(error instanceof FixtureChildProcessError);
        assert.equal(error.timeoutMs, 100);
        assert.equal(error.processGroupStopped, true);
        return true;
      },
    );
  },
);

test("fixture command failures report trailing output rather than the beginning", async () => {
  await assert.rejects(
    run(
      process.execPath,
      [
        "-e",
        "process.stdout.write('x'.repeat(100000)); process.stderr.write('root-cause'); process.exitCode=1",
      ],
      { timeoutMs: 5_000, maxOutputBytes: 256 },
    ),
    (error) => {
      assert.ok(error instanceof FixtureChildProcessError);
      assert.equal(error.outputMaxBytes, 256);
      assert.ok(error.outputTail.endsWith("root-cause"));
      assert.ok(error.outputTail.length <= 256);
      return true;
    },
  );
});

test("fixture evidence diagnostics redact credentials and retain only their tail", () => {
  const value = sanitizeFixtureDiagnostic(
    `Bearer abc123\nsource-stable-fixture-gateway-secret-0123456789\nhttps://user:pass@example.test/a\n${"x".repeat(30)}`,
    8,
  );
  assert.equal(Buffer.byteLength(value), 8);
  assert.equal(value, "xxxxxxxx");
  const redacted = sanitizeFixtureDiagnostic(
    "Bearer abc123 source-stable-fixture-gateway-secret-0123456789 https://user:pass@example.test/a",
  );
  assert.doesNotMatch(redacted, /abc123|gateway-secret-0123456789|user:pass/u);
});

test("privileged fixture shutdown uses bounded sudo process-group signals and verifies exit", async () => {
  const calls = [];
  let alive = true;
  const runCommand = async (command, args, options) => {
    calls.push({ command, args, options });
    if (args[1] === "kill" && args[2] === "-0") {
      if (alive) return "";
      throw Object.assign(new Error("group exited"), {
        exitCode: 1,
        outputTail: "kill: (-4242): No such process",
      });
    }
    if (args[1] === "kill" && args[2] === "-KILL") alive = false;
    return "";
  };

  assert.equal(
    await stopPrivilegedProcessGroup(4242, {
      runCommand,
      graceMs: 0,
      pollMs: 1,
      finalWaitMs: 10,
    }),
    true,
  );
  assert.deepEqual(
    calls.map(({ command, args, options }) => [command, args, options.timeoutMs]),
    [
      ["sudo", ["-n", "kill", "-0", "--", "-4242"], 2_000],
      ["sudo", ["-n", "kill", "-TERM", "--", "-4242"], 2_000],
      ["sudo", ["-n", "kill", "-0", "--", "-4242"], 2_000],
      ["sudo", ["-n", "kill", "-KILL", "--", "-4242"], 2_000],
      ["sudo", ["-n", "kill", "-0", "--", "-4242"], 2_000],
      ["sudo", ["-n", "kill", "-0", "--", "-4242"], 2_000],
    ],
  );
});

test("privileged cleanup removes only the BuildKit child of a private fixture root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "praetorium-source-stable-fixture-cleanup-"));
  const target = path.join(root, "buildkit-root");
  const calls = [];
  try {
    await mkdir(target, { mode: 0o700 });
    assert.equal(
      await removeOwnedBuildKitRoot(root, async (command, args, options) => {
        calls.push({ command, args, options });
        return "";
      }),
      true,
    );
    assert.deepEqual(calls, [
      {
        command: "sudo",
        args: ["-n", "rm", "--recursive", "--force", "--", target],
        options: { timeoutMs: 30_000 },
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("privileged BuildKit cleanup rejects non-owned roots and symlink targets before sudo", async () => {
  const outside = await mkdtemp(path.join(os.tmpdir(), "praetorium-outside-cleanup-"));
  const invalidRoot = path.join(outside, "not-a-fixture-root");
  const root = await mkdtemp(path.join(os.tmpdir(), "praetorium-source-stable-fixture-symlink-"));
  const target = path.join(root, "buildkit-root");
  const calls = [];
  try {
    await mkdir(invalidRoot);
    await symlink(outside, target);
    const runCommand = async (...args) => {
      calls.push(args);
    };
    await assert.rejects(
      removeOwnedBuildKitRoot(invalidRoot, runCommand),
      /outside the owned task/u,
    );
    await assert.rejects(removeOwnedBuildKitRoot(root, runCommand), /not a real directory/u);
    assert.equal(calls.length, 0);
  } finally {
    await rm(outside, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
