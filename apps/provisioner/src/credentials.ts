import { readFile } from "node:fs/promises";

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
