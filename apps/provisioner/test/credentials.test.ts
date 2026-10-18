import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readProvisionerImagePullConfig } from "../src/credentials.js";

describe("Provisioner image pull config reader", () => {
  it("reads a validated GHCR-only Docker config", async () => {
    const directory = await mkdtemp(join(tmpdir(), "praetorium-provisioner-image-pull-"));
    const path = join(directory, "config.json");
    const value = JSON.stringify({ auths: { "ghcr.io": { auth: "dXNlcjp0b2tlbg==" } } });
    try {
      await writeFile(path, `${value}\n`, { mode: 0o600 });
      await expect(readProvisionerImagePullConfig(path)).resolves.toBe(value);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed without including malformed credential contents in its error", async () => {
    const directory = await mkdtemp(join(tmpdir(), "praetorium-provisioner-image-pull-"));
    const path = join(directory, "config.json");
    const value = JSON.stringify({ auths: { "docker.io": { auth: "private-test-value" } } });
    try {
      await writeFile(path, value, { mode: 0o600 });
      const error = await readProvisionerImagePullConfig(path).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ message: "provisioner_image_pull_config_invalid" });
      expect((error as Error).message).not.toContain("private-test-value");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
