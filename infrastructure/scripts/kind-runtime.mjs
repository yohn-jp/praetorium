export const KIND_RUNTIME_VERSION = "v0.31.0";
export const NODE_IMAGE =
  "kindest/node:v1.35.0@sha256:452d707d4862f52530247495d180205e029056831160e22870e37e3f6c1ac31f";

function reportedVersion(output) {
  if (typeof output !== "string") return null;
  const match = output.trim().match(/^kind (v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\s|$)/u);
  return match?.[1] ?? null;
}

export function assertKindRuntimeVersion(output) {
  const actual = reportedVersion(output);
  if (actual === null) {
    throw new Error("Kind runtime version output is missing or unrecognized");
  }
  if (actual !== KIND_RUNTIME_VERSION) {
    throw new Error(
      `Kind runtime ${actual} is unsupported; this disposable cluster requires ${KIND_RUNTIME_VERSION}`,
    );
  }
  return actual;
}
