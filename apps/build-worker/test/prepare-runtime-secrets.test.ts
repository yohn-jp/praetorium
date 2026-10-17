import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BuildKitProviderConfig } from "@praetorium/buildkit";
import { validateBuildKitFiles } from "@praetorium/buildkit";
import { loadFileBuilderSigner } from "@praetorium/application/builds";
import { readBuildServiceToken } from "../src/http-client.js";
import { prepareRuntimeSecrets } from "../src/prepare-runtime-secrets.js";
import { readRegistryPullCredential } from "../src/registry-credential.js";

const roots: string[] = [];
const PROJECTED_FILES = {
  buildkit: {
    "ca.crt": "buildkit ca",
    "tls.crt": "buildkit certificate",
    "tls.key": "buildkit key",
  },
  registry: {
    "config.json": JSON.stringify({
      auths: {
        "buildkit.example": { auth: Buffer.from("builder:push-token").toString("base64") },
        "registry.example": { auth: Buffer.from("builder:pull-token").toString("base64") },
      },
    }),
  },
  "registry-pull": {
    "credential.json": JSON.stringify({ username: "reader", password: "pull-only-token" }),
  },
  "control-plane": { token: "c".repeat(48) },
  signing: {},
};

type Fixture = {
  root: string;
  layout: {
    destinationMount: string;
    temporaryMount: string;
    sourceMounts: Record<string, string>;
  };
  sourceMounts: Record<string, string>;
  signingKey: string;
};

async function createProjection(
  mount: string,
  name: string,
  files: Record<string, string>,
): Promise<void> {
  const generationName = `..2026_10_17_00_00_${name}`;
  const generation = path.join(mount, generationName);
  await mkdir(generation);
  await chmod(generation, 0o2755);
  for (const [file, content] of Object.entries(files)) {
    const filePath = path.join(generation, file);
    await writeFile(filePath, content, { mode: 0o440 });
    await chmod(filePath, 0o440);
    await symlink(path.join("..data", file), path.join(mount, file));
  }
  await symlink(generationName, path.join(mount, "..data"));
}

async function rotateProjection(
  mount: string,
  name: string,
  files: Record<string, string>,
): Promise<void> {
  const generationName = `..2026_10_17_00_01_${name}`;
  const generation = path.join(mount, generationName);
  await mkdir(generation);
  for (const [file, content] of Object.entries(files)) {
    const filePath = path.join(generation, file);
    await writeFile(filePath, content, { mode: 0o440 });
    await chmod(filePath, 0o440);
  }
  const nextLink = path.join(mount, "..data.next");
  await symlink(generationName, nextLink);
  await rename(nextLink, path.join(mount, "..data"));
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "praetorium-build-worker-secrets-test-"));
  roots.push(root);
  const sourceMounts: Record<string, string> = {};
  const sourceFiles: Record<string, Record<string, string>> = {
    buildkit: { ...PROJECTED_FILES.buildkit },
    registry: { ...PROJECTED_FILES.registry },
    "registry-pull": { ...PROJECTED_FILES["registry-pull"] },
    "control-plane": { ...PROJECTED_FILES["control-plane"] },
    signing: {},
  };
  const { privateKey } = generateKeyPairSync("ed25519");
  const signingKey = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  sourceFiles.signing["key.pem"] = signingKey;

  for (const [name, files] of Object.entries(sourceFiles)) {
    const sourceMount = path.join(root, "sources", name);
    await mkdir(sourceMount, { recursive: true });
    await chmod(sourceMount, 0o3777);
    await createProjection(sourceMount, "000000000", files);
    sourceMounts[name] = sourceMount;
  }

  const destinationMount = path.join(root, "destination-mount");
  const temporaryMount = path.join(root, "temporary-mount");
  await mkdir(destinationMount, { mode: 0o2777 });
  await mkdir(temporaryMount, { mode: 0o2777 });
  await chmod(destinationMount, 0o2777);
  await chmod(temporaryMount, 0o2777);
  return {
    root,
    sourceMounts,
    layout: { destinationMount, temporaryMount, sourceMounts },
    signingKey,
  };
}

function destination(f: Fixture, volume: string, file: string): string {
  return path.join(f.layout.destinationMount, "private", volume, file);
}

function buildKitConfig(f: Fixture): BuildKitProviderConfig {
  const privateRoot = path.join(f.layout.destinationMount, "private");
  return {
    address: "tcp://buildkit.example:1234",
    tlsServerName: "buildkit.example",
    tlsCaFile: destination(f, "buildkit", "ca.crt"),
    tlsCertFile: destination(f, "buildkit", "tls.crt"),
    tlsKeyFile: destination(f, "buildkit", "tls.key"),
    buildctlPath: process.execPath,
    buildkitRepository: "buildkit.example/praetorium/frontend",
    outputRepository: "registry.example/praetorium/candidates",
    dockerConfigDirectory: path.join(privateRoot, "registry"),
    temporaryDirectory: path.join(f.layout.temporaryMount, "private"),
    maxBuildInputBytes: 65_536,
    maxProgressBytes: 1024 * 1024,
    buildTimeoutMs: 60_000,
    safePath: "/usr/bin:/bin",
  };
}

async function expectPrivateFile(filePath: string): Promise<void> {
  const info = await lstat(filePath);
  expect(info.isFile()).toBe(true);
  expect(info.isSymbolicLink()).toBe(false);
  expect(info.uid).toBe(process.getuid?.());
  expect(info.nlink).toBe(1);
  expect(info.mode & 0o7777).toBe(0o600);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Build Worker projected runtime secrets", () => {
  it("copies a pinned AtomicWriter generation into private files accepted by production readers", async () => {
    const f = await fixture();
    await prepareRuntimeSecrets(f.layout);

    const destinationRoot = path.join(f.layout.destinationMount, "private");
    const temporaryRoot = path.join(f.layout.temporaryMount, "private");
    for (const directory of [
      destinationRoot,
      ...Object.keys(f.sourceMounts).map((name) => path.join(destinationRoot, name)),
      temporaryRoot,
    ]) {
      const info = await lstat(directory);
      expect(info.isDirectory()).toBe(true);
      expect(info.isSymbolicLink()).toBe(false);
      expect(info.uid).toBe(process.getuid?.());
      expect(info.mode & 0o7777).toBe(0o700);
    }
    for (const [volume, files] of Object.entries({
      buildkit: ["ca.crt", "tls.crt", "tls.key"],
      registry: ["config.json"],
      "registry-pull": ["credential.json"],
      "control-plane": ["token"],
      signing: ["key.pem"],
    })) {
      for (const file of files) await expectPrivateFile(destination(f, volume, file));
    }

    await expect(readBuildServiceToken(destination(f, "control-plane", "token"))).resolves.toBe(
      PROJECTED_FILES["control-plane"].token,
    );
    await expect(
      readRegistryPullCredential(destination(f, "registry-pull", "credential.json")),
    ).resolves.toEqual({ username: "reader", password: "pull-only-token" });
    await expect(validateBuildKitFiles(buildKitConfig(f))).resolves.toBeUndefined();
    await expect(
      loadFileBuilderSigner({
        privateKeyPath: destination(f, "signing", "key.pem"),
        keyId: "builder-key-v1",
      }),
    ).resolves.toBeDefined();

    const rotatedFiles = { ...PROJECTED_FILES["control-plane"], token: "d".repeat(48) };
    await rotateProjection(f.sourceMounts["control-plane"]!, "000000001", rotatedFiles);
    await prepareRuntimeSecrets(f.layout);
    await expect(readBuildServiceToken(destination(f, "control-plane", "token"))).resolves.toBe(
      rotatedFiles.token,
    );
  });

  it("rejects source-link escapes and oversized projected files before replacing outputs", async () => {
    const f = await fixture();
    await prepareRuntimeSecrets(f.layout);
    const originalToken = await readFile(destination(f, "control-plane", "token"), "utf8");

    const escapedEntry = path.join(f.sourceMounts["control-plane"]!, "token");
    await rm(escapedEntry);
    await symlink("/etc/passwd", escapedEntry);
    await expect(prepareRuntimeSecrets(f.layout)).rejects.toThrow(
      "Build worker runtime secret preparation failed",
    );
    await expect(readFile(destination(f, "control-plane", "token"), "utf8")).resolves.toBe(
      originalToken,
    );

    const oversizedFiles = {
      ...PROJECTED_FILES.buildkit,
      "tls.key": "x".repeat(16 * 1024 + 1),
    };
    await rotateProjection(f.sourceMounts.buildkit!, "000000001", oversizedFiles);
    await expect(prepareRuntimeSecrets(f.layout)).rejects.toThrow(
      "Build worker runtime secret preparation failed",
    );
    await expect(readFile(destination(f, "control-plane", "token"), "utf8")).resolves.toBe(
      originalToken,
    );
  });

  it("copies a public certificate bundle above 64 KiB within Kubernetes Secret bounds", async () => {
    const f = await fixture();
    const bundle = "x".repeat(256 * 1024);
    await rotateProjection(f.sourceMounts.buildkit!, "000000001", {
      ...PROJECTED_FILES.buildkit,
      "ca.crt": bundle,
    });

    await prepareRuntimeSecrets(f.layout);
    const copiedBundle = await readFile(destination(f, "buildkit", "ca.crt"));
    expect(copiedBundle.byteLength).toBe(Buffer.byteLength(bundle));
    await expect(validateBuildKitFiles(buildKitConfig(f))).resolves.toBeUndefined();
  });

  it("rejects ambiguous existing targets without following or changing their referent", async () => {
    const f = await fixture();
    await prepareRuntimeSecrets(f.layout);
    const target = path.join(f.root, "outside-target");
    await writeFile(target, "untouched", { mode: 0o600 });
    const destinationFile = destination(f, "registry-pull", "credential.json");
    await rm(destinationFile);
    await symlink(target, destinationFile);

    await expect(prepareRuntimeSecrets(f.layout)).rejects.toThrow(
      "Build worker runtime secret preparation failed",
    );
    await expect(readFile(target, "utf8")).resolves.toBe("untouched");
  });
});
