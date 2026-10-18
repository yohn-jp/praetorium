import { readFile } from "node:fs/promises";
import { validateApplicationImagePullConfig } from "@praetorium/kubernetes";

/** Reads the mounted service credential without logging or copying it into
 * process arguments or Control Plane payloads. */
export async function readProvisionerCredential(path: string): Promise<string> {
  let value: string;
  try {
    value = await readFile(path, "utf8");
  } catch {
    throw new Error("provisioner_credential_unavailable");
  }
  const credential = value.trim();
  if (credential.length === 0 || credential.length > 4096 || /[\r\n]/u.test(credential)) {
    throw new Error("provisioner_credential_invalid");
  }
  return credential;
}

/** Reads the operator-only Docker config without exposing it to logs or requests. */
export async function readProvisionerImagePullConfig(path: string): Promise<string> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    throw new Error("provisioner_image_pull_config_unavailable");
  }
  if (bytes.byteLength > 64 * 1024) throw new Error("provisioner_image_pull_config_invalid");
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
    validateApplicationImagePullConfig(value);
  } catch {
    throw new Error("provisioner_image_pull_config_invalid");
  }
  return value;
}
