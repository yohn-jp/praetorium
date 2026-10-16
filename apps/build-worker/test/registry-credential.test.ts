import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readRegistryPullCredential } from "../src/registry-credential.js";

const directories: string[] = [];

async function credentialFile(value: unknown): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "praetorium-registry-credential-test-"));
  directories.push(directory);
  const file = path.join(directory, "credential.json");
  await writeFile(file, JSON.stringify(value), { mode: 0o600 });
  return file;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("registry-only pull credentials", () => {
  it("reads a private, strict username/password file", async () => {
    const file = await credentialFile({ username: "registry-reader", password: "read-only-token" });
    await expect(readRegistryPullCredential(file)).resolves.toEqual({
      username: "registry-reader",
      password: "read-only-token",
    });
  });

  it("rejects extra fields and group-readable files", async () => {
    const file = await credentialFile({ username: "reader", password: "token", helper: "exec" });
    await expect(readRegistryPullCredential(file)).rejects.toThrow();
    await writeFile(file, JSON.stringify({ username: "reader", password: "token" }), {
      mode: 0o600,
    });
    await chmod(file, 0o640);
    await expect(readRegistryPullCredential(file)).rejects.toThrow();
  });
});
