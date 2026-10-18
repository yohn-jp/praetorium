const MAX_IMAGE_PULL_CONFIG_BYTES = 64 * 1024;
const ALLOWED_AUTH_FIELDS = new Set([
  "auth",
  "username",
  "password",
  "identitytoken",
  "registrytoken",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Validates the operator Docker config without exposing its credential values. */
export function validateApplicationImagePullConfig(value: string): void {
  if (
    Buffer.byteLength(value, "utf8") === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_IMAGE_PULL_CONFIG_BYTES
  ) {
    throw new TypeError("application image pull configuration is invalid");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new TypeError("application image pull configuration is invalid");
  }
  const root = record(parsed);
  const auths = record(root?.auths);
  const credentials = record(auths?.["ghcr.io"]);
  if (
    root === undefined ||
    Object.keys(root).length !== 1 ||
    auths === undefined ||
    Object.keys(auths).length !== 1 ||
    credentials === undefined ||
    Object.keys(credentials).length === 0 ||
    Object.keys(credentials).some((key) => !ALLOWED_AUTH_FIELDS.has(key))
  ) {
    throw new TypeError("application image pull configuration is invalid");
  }

  const values = Object.values(credentials);
  if (
    values.some((field) => typeof field !== "string" || field.length === 0 || field.length > 16_384)
  ) {
    throw new TypeError("application image pull configuration is invalid");
  }
  const username = credentials.username;
  const password = credentials.password;
  if ((username === undefined) !== (password === undefined)) {
    throw new TypeError("application image pull configuration is invalid");
  }
  if (
    credentials.auth === undefined &&
    credentials.identitytoken === undefined &&
    credentials.registrytoken === undefined &&
    (typeof username !== "string" || typeof password !== "string")
  ) {
    throw new TypeError("application image pull configuration is invalid");
  }
}
