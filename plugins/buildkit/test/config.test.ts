import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BuildKitProviderConfig } from "../src/types.js";
import {
  validateBuildKitConfig,
  validateBuildKitFiles,
  readBuildKitRegistryCredential,
  validateRegistryAuth,
} from "../src/config.js";

const directories: string[] = [];

async function createConfig(): Promise<BuildKitProviderConfig> {
  const root = await mkdtemp(path.join(tmpdir(), "praetorium-buildkit-config-test-"));
  directories.push(root);
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
  await writeFile(
    path.join(dockerConfigDirectory, "config.json"),
    JSON.stringify({
      auths: { "registry.example": { auth: Buffer.from("user:token").toString("base64") } },
    }),
    { mode: 0o600 },
  );
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

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("BuildKit worker configuration", () => {
  it("accepts bounded mTLS remote BuildKit and private registry auth configuration", async () => {
    const config = await createConfig();
    expect(() => validateBuildKitConfig(config)).not.toThrow();
    await expect(validateBuildKitFiles(config)).resolves.toBeUndefined();
  });

  it("reads only a Basic registry credential from the approved private BuildKit auth file", async () => {
    const config = await createConfig();
    await expect(readBuildKitRegistryCredential(config, "registry.example")).resolves.toEqual({
      username: "user",
      password: "token",
    });
    await expect(readBuildKitRegistryCredential(config, "outside.example")).rejects.toThrow();
    await writeFile(
      path.join(config.dockerConfigDirectory, "config.json"),
      JSON.stringify({ auths: { "registry.example": { auth: "not-base64!" } } }),
      { mode: 0o600 },
    );
    await expect(readBuildKitRegistryCredential(config, "registry.example")).rejects.toThrow();
  });

  it("rejects non-TLS endpoints, malformed server names, unsafe repositories and excessive limits", async () => {
    const config = await createConfig();
    expect(() =>
      validateBuildKitConfig({ ...config, address: "tcp://buildkit.example:1234?tls=0" }),
    ).toThrow();
    expect(() =>
      validateBuildKitConfig({ ...config, tlsServerName: "buildkit.example\n--tls=false" }),
    ).toThrow();
    expect(() =>
      validateBuildKitConfig({ ...config, outputRepository: "registry.example/../../other" }),
    ).toThrow();
    expect(() => validateBuildKitConfig({ ...config, maxBuildInputBytes: 65_537 })).toThrow();
  });

  it("rejects credential helpers and auth entries outside the two approved registry hosts", async () => {
    const config = await createConfig();
    const file = path.join(config.dockerConfigDirectory, "config.json");
    await writeFile(file, JSON.stringify({ credsStore: "secretservice", auths: {} }), {
      mode: 0o600,
    });
    await expect(validateRegistryAuth(config)).rejects.toThrow();

    await writeFile(file, JSON.stringify({ auths: {} }), { mode: 0o600 });
    await expect(validateRegistryAuth(config)).rejects.toThrow();

    await writeFile(
      file,
      JSON.stringify({ auths: { "attacker.invalid": { auth: "dXNlcjpwYXNz" } } }),
      { mode: 0o600 },
    );
    await expect(validateRegistryAuth(config)).rejects.toThrow();
  });

  it("rejects group-readable registry credentials", async () => {
    const config = await createConfig();
    await chmod(path.join(config.dockerConfigDirectory, "config.json"), 0o640);
    await expect(validateRegistryAuth(config)).rejects.toThrow();
  });

  it("permits unauthenticated output only for the explicitly configured loopback acceptance registry", async () => {
    const config = await createConfig();
    const local = {
      ...config,
      buildkitRepository: "registry.example/praetorium/buildkit",
      outputRepository: "127.0.0.1:39567/praetorium/candidates",
      allowInsecureLoopbackRegistry: true,
    };
    const file = path.join(config.dockerConfigDirectory, "config.json");
    await writeFile(file, JSON.stringify({ auths: {} }), { mode: 0o600 });
    expect(() => validateBuildKitConfig(local)).not.toThrow();
    await expect(validateRegistryAuth(local)).resolves.toBeUndefined();
    expect(() =>
      validateBuildKitConfig({
        ...local,
        outputRepository: "registry.example/praetorium/candidates",
      }),
    ).toThrow();
  });
});
