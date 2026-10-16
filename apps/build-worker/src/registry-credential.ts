import { lstat, readFile } from "node:fs/promises";
import type { RegistryCredential } from "@praetorium/ghcr";

const MAX_CREDENTIAL_BYTES = 4096;

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

/** Loads a registry-only pull credential kept separate from BuildKit push auth. */
export async function readRegistryPullCredential(filePath: string): Promise<RegistryCredential> {
  if (!filePath.startsWith("/")) throw new TypeError("Registry pull credential is invalid");
  try {
    const info = await lstat(filePath);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size < 2 ||
      info.size > MAX_CREDENTIAL_BYTES ||
      (info.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && info.uid !== process.getuid())
    )
      throw new TypeError("Registry pull credential is invalid");

    const parsed: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(await readFile(filePath)),
    );
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new TypeError("Registry pull credential is invalid");
    }
    const record = parsed as Record<string, unknown>;
    if (
      Object.keys(record).length !== 2 ||
      Object.keys(record).some((key) => key !== "username" && key !== "password") ||
      typeof record.username !== "string" ||
      typeof record.password !== "string" ||
      record.username.length < 1 ||
      record.username.length > 256 ||
      record.password.length < 1 ||
      record.password.length > 2048 ||
      hasControlCharacters(record.username) ||
      hasControlCharacters(record.password)
    )
      throw new TypeError("Registry pull credential is invalid");
    return { username: record.username, password: record.password };
  } catch {
    throw new TypeError("Registry pull credential is invalid");
  }
}
