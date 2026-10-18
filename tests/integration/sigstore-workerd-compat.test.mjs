import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Miniflare } from "miniflare";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const appRoot = path.join(repositoryRoot, "apps/control-plane");

test("the production Sigstore verifier accepts its real bundle in Workerd and rejects a tampered SET", async () => {
  const tempRoot = process.env.PRAETORIUM_TEST_TMPDIR ?? process.env.TMPDIR ?? os.tmpdir();
  await mkdir(tempRoot, { recursive: true });
  const bundleRoot = await mkdtemp(path.join(tempRoot, "praetorium-sigstore-workerd-bundle-"));
  let miniflare;
  try {
    await execFileAsync(
      process.execPath,
      [
        path.join(appRoot, "node_modules/wrangler/bin/wrangler.js"),
        "deploy",
        "--config",
        path.join(appRoot, "test/wrangler.sigstore-workerd-probe.toml"),
        "--dry-run",
        "--outdir",
        bundleRoot,
      ],
      {
        cwd: appRoot,
        env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      },
    );
    const script = await readFile(path.join(bundleRoot, "sigstore-workerd-probe.js"), "utf8");
    assert.ok(
      script.length > 10_000,
      "Wrangler must bundle the actual Sigstore verifier and Worker crypto path",
    );
    miniflare = new Miniflare({
      name: "praetorium-sigstore-workerd-probe",
      script,
      modules: true,
      compatibilityDate: "2026-07-30",
      compatibilityFlags: ["nodejs_compat"],
    });
    await miniflare.ready;
    const response = await miniflare.dispatchFetch("https://sigstore-probe.test/");
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(
      result.valid,
      true,
      "the actual trusted-root verifier must accept the committed producer bundle",
    );
    assert.equal(
      result.validSigner,
      "https://github.com/yohn-jp/praetorium/.github/workflows/scriptorium-producer-verification.yml@refs/heads/main",
    );
    assert.equal(
      result.tampered,
      false,
      "the actual verifier must reject the same bundle with a modified Rekor SET",
    );
    assert.ok(
      result.tamperedEvidence.includes("signature or producer identity verification failed"),
    );
  } finally {
    await miniflare?.dispose();
    await rm(bundleRoot, { recursive: true, force: true });
  }
});
