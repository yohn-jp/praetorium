import { access, lstat, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { BuildKitConfigurationError, type BuildKitProviderConfig } from "./types.js";

const REPOSITORY =
  /^(?<host>[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?)(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/u;
const MAX_INPUT_BYTES = 65_536;
const MAX_PROGRESS_BYTES = 16 * 1024 * 1024;
const MAX_BUILD_TIMEOUT_MS = 24 * 60 * 60 * 1000;

function absolute(value: string): boolean {
  return path.isAbsolute(value) && !value.includes("\0");
}

function repositoryHost(value: string): string {
  const match = REPOSITORY.exec(value);
  const host = match?.groups?.host;
  if (!host) throw new BuildKitConfigurationError();
  return host;
}

function validTcpAddress(value: string): boolean {
  try {
    const address = new URL(value);
    return (
      address.protocol === "tcp:" &&
      address.hostname !== "" &&
      address.port !== "" &&
      address.username === "" &&
      address.password === "" &&
      (address.pathname === "" || address.pathname === "/") &&
      address.search === "" &&
      address.hash === ""
    );
  } catch {
    return false;
  }
}

function validTlsServerName(value: string): boolean {
  return (
    value.length <= 253 &&
    !/[\s\0\\/]/u.test(value) &&
    /^[A-Za-z0-9.-]+$/u.test(value) &&
    !value.startsWith(".") &&
    !value.endsWith(".")
  );
}

export function validateBuildKitConfig(config: BuildKitProviderConfig): void {
  if (
    !validTcpAddress(config.address) ||
    !validTlsServerName(config.tlsServerName) ||
    !absolute(config.tlsCaFile) ||
    !absolute(config.tlsCertFile) ||
    !absolute(config.tlsKeyFile) ||
    !absolute(config.buildctlPath) ||
    !absolute(config.dockerConfigDirectory) ||
    !absolute(config.temporaryDirectory) ||
    !config.safePath ||
    config.safePath.includes("\n") ||
    config.safePath.includes("\0")
  ) {
    throw new BuildKitConfigurationError();
  }

  repositoryHost(config.buildkitRepository);
  const outputHost = repositoryHost(config.outputRepository);
  if (
    config.allowInsecureLoopbackRegistry === true &&
    !/^127\.0\.0\.1:[1-9][0-9]{0,4}$/u.test(outputHost)
  ) {
    throw new BuildKitConfigurationError();
  }

  if (
    !Number.isSafeInteger(config.maxBuildInputBytes) ||
    config.maxBuildInputBytes < 1 ||
    config.maxBuildInputBytes > MAX_INPUT_BYTES ||
    !Number.isSafeInteger(config.maxProgressBytes) ||
    config.maxProgressBytes < 1 ||
    config.maxProgressBytes > MAX_PROGRESS_BYTES ||
    !Number.isSafeInteger(config.buildTimeoutMs) ||
    config.buildTimeoutMs < 1_000 ||
    config.buildTimeoutMs > MAX_BUILD_TIMEOUT_MS
  ) {
    throw new BuildKitConfigurationError();
  }
}

async function assertFile(
  filePath: string,
  options: { executable?: boolean; secret?: boolean } = {},
): Promise<void> {
  const info = options.secret ? await lstat(filePath) : await stat(filePath);
  if (!info.isFile()) throw new BuildKitConfigurationError();
  if (options.executable) await access(filePath, constants.X_OK);
  if (
    options.secret &&
    (info.isSymbolicLink() ||
      info.size < 1 ||
      info.size > 16 * 1024 ||
      (info.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && info.uid !== process.getuid()))
  )
    throw new BuildKitConfigurationError();
}

async function assertPrivateDirectory(directoryPath: string): Promise<void> {
  const info = await lstat(directoryPath);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && info.uid !== process.getuid())
  )
    throw new BuildKitConfigurationError();
  await access(directoryPath, constants.W_OK | constants.X_OK);
}

function authRegistryHost(value: string): string | null {
  if (value === "https://index.docker.io/v1/") return "docker.io";
  try {
    const parsed = new URL(value.includes("://") ? value : `https://${value}`);
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      (parsed.pathname !== "/" && parsed.pathname !== "")
    )
      return null;
    return parsed.host.toLowerCase();
  } catch {
    return null;
  }
}

function containsControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Checks that BuildKit's auth session can reach only the approved frontend and
 * output registries. Credential values are parsed only to validate shape and
 * are never returned, logged, or copied into build context.
 */
export async function validateRegistryAuth(config: BuildKitProviderConfig): Promise<void> {
  const configPath = path.join(config.dockerConfigDirectory, "config.json");
  try {
    const directory = await lstat(config.dockerConfigDirectory);
    const file = await lstat(configPath);
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      !file.isFile() ||
      file.isSymbolicLink() ||
      file.size > 64 * 1024 ||
      (directory.mode & 0o077) !== 0 ||
      (file.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" &&
        (directory.uid !== process.getuid() || file.uid !== process.getuid()))
    ) {
      throw new BuildKitConfigurationError();
    }
    const parsed: unknown = JSON.parse(await readFile(configPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new BuildKitConfigurationError();
    }
    const value = parsed as Record<string, unknown>;
    if (
      Object.keys(value).some((key) => key !== "auths") ||
      typeof value.auths !== "object" ||
      value.auths === null ||
      Array.isArray(value.auths)
    ) {
      throw new BuildKitConfigurationError();
    }
    const allowedHosts = new Set([
      repositoryHost(config.buildkitRepository),
      repositoryHost(config.outputRepository),
    ]);
    const authenticatedHosts = new Set<string>();
    for (const [server, credentials] of Object.entries(value.auths as Record<string, unknown>)) {
      const host = authRegistryHost(server);
      if (
        host === null ||
        !allowedHosts.has(host) ||
        typeof credentials !== "object" ||
        credentials === null ||
        Array.isArray(credentials)
      ) {
        throw new BuildKitConfigurationError();
      }
      const entry = credentials as Record<string, unknown>;
      if (
        Object.keys(entry).some(
          (key) => !["auth", "identitytoken", "username", "password", "email"].includes(key),
        )
      ) {
        throw new BuildKitConfigurationError();
      }
      if (
        !["auth", "identitytoken", "username", "password"].some(
          (key) => typeof entry[key] === "string" && entry[key] !== "",
        )
      ) {
        throw new BuildKitConfigurationError();
      }
      authenticatedHosts.add(host);
    }
    const outputHost = repositoryHost(config.outputRepository);
    if (!authenticatedHosts.has(outputHost) && config.allowInsecureLoopbackRegistry !== true) {
      throw new BuildKitConfigurationError();
    }
  } catch (error) {
    if (error instanceof BuildKitConfigurationError) throw error;
    throw new BuildKitConfigurationError();
  }
}

/**
 * Reads the registry-only publisher credential already mounted for BuildKit.
 * The value stays in memory and is never returned to a build context or log.
 */
export async function readBuildKitRegistryCredential(
  config: BuildKitProviderConfig,
  registryHost: string,
): Promise<{ readonly username: string; readonly password: string }> {
  await validateRegistryAuth(config);
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$/u.test(registryHost)) {
    throw new BuildKitConfigurationError();
  }
  try {
    const configPath = path.join(config.dockerConfigDirectory, "config.json");
    const parsed: unknown = JSON.parse(await readFile(configPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new BuildKitConfigurationError();
    }
    const auths = (parsed as Record<string, unknown>).auths;
    if (typeof auths !== "object" || auths === null || Array.isArray(auths)) {
      throw new BuildKitConfigurationError();
    }
    const entry = Object.entries(auths as Record<string, unknown>).find(
      ([server]) => authRegistryHost(server) === registryHost,
    )?.[1];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new BuildKitConfigurationError();
    }
    const credential = entry as Record<string, unknown>;
    let username = typeof credential.username === "string" ? credential.username : "";
    let password = typeof credential.password === "string" ? credential.password : "";
    if ((!username || !password) && typeof credential.auth === "string") {
      const encoded = credential.auth;
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
        throw new BuildKitConfigurationError();
      }
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.toString("base64") !== encoded) throw new BuildKitConfigurationError();
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const separator = decoded.indexOf(":");
      if (separator > 0) {
        username = decoded.slice(0, separator);
        password = decoded.slice(separator + 1);
      }
    }
    if (
      username.length < 1 ||
      username.length > 256 ||
      password.length < 1 ||
      password.length > 4096 ||
      containsControlCharacters(username) ||
      containsControlCharacters(password)
    ) {
      throw new BuildKitConfigurationError();
    }
    return { username, password };
  } catch (error) {
    if (error instanceof BuildKitConfigurationError) throw error;
    throw new BuildKitConfigurationError();
  }
}

export async function validateBuildKitFiles(config: BuildKitProviderConfig): Promise<void> {
  validateBuildKitConfig(config);
  try {
    await Promise.all([
      assertFile(config.buildctlPath, { executable: true }),
      assertFile(config.tlsCaFile),
      assertFile(config.tlsCertFile),
      assertFile(config.tlsKeyFile, { secret: true }),
      assertPrivateDirectory(config.temporaryDirectory),
      validateRegistryAuth(config),
    ]);
  } catch (error) {
    if (error instanceof BuildKitConfigurationError) throw error;
    throw new BuildKitConfigurationError();
  }
}
