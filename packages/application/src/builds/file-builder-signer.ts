import { createPrivateKey, sign as cryptoSign } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import {
  BuilderArtifactStatementSchema,
  BuilderSignatureSchema,
} from "@praetorium/contracts";
import type { BuilderArtifactStatement, BuilderSignature } from "@praetorium/contracts";
import type { BuilderSigner } from "./types.js";

const KEY_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const MAX_KEY_BYTES = 16 * 1024;

export class BuilderSignerConfigurationError extends Error {
  constructor() {
    super("Builder signing key configuration is invalid");
    this.name = "BuilderSignerConfigurationError";
  }
}

export async function loadFileBuilderSigner(input: {
  privateKeyPath: string;
  keyId: string;
}): Promise<BuilderSigner> {
  if (!input.privateKeyPath.startsWith("/") || !KEY_ID.test(input.keyId)) {
    throw new BuilderSignerConfigurationError();
  }

  let privateKey;
  try {
    const info = await lstat(input.privateKeyPath);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size < 1 || info.size > MAX_KEY_BYTES ||
      (info.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && info.uid !== process.getuid())
    ) {
      throw new BuilderSignerConfigurationError();
    }
    const pem = await readFile(input.privateKeyPath, "utf8");
    privateKey = createPrivateKey({ key: pem, format: "pem", type: "pkcs8" });
    if (privateKey.asymmetricKeyType !== "ed25519") throw new BuilderSignerConfigurationError();
  } catch (error) {
    if (error instanceof BuilderSignerConfigurationError) throw error;
    throw new BuilderSignerConfigurationError();
  }

  return new Ed25519BuilderSigner(privateKey, input.keyId);
}

export class Ed25519BuilderSigner implements BuilderSigner {
  constructor(private readonly privateKey: ReturnType<typeof createPrivateKey>, private readonly keyId: string) {
    if (privateKey.asymmetricKeyType !== "ed25519" || !KEY_ID.test(keyId)) {
      throw new BuilderSignerConfigurationError();
    }
  }

  async sign(value: BuilderArtifactStatement): Promise<BuilderSignature> {
    const statement = BuilderArtifactStatementSchema.parse(value);
    const signature = cryptoSign(null, canonicalBuilderStatement(statement), this.privateKey).toString("base64");
    return BuilderSignatureSchema.parse({ algorithm: "Ed25519", keyId: this.keyId, signature });
  }
}

/** Stable signing bytes: recursively sorted JSON object keys, with no whitespace. */
export function canonicalBuilderStatement(statement: BuilderArtifactStatement): Buffer {
  const parsed = BuilderArtifactStatementSchema.parse(statement);
  return Buffer.from(JSON.stringify(sortJsonKeys(parsed)), "utf8");
}

function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sortJsonKeys(record[key])]));
}
