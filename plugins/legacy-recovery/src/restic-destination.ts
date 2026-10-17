import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { isIP } from "node:net";

const REMOTE_RESTIC_SCHEMES = new Set(["s3", "sftp", "rest", "gs", "azure", "b2", "swift"]);

export interface OffHostResticDestinationIdentity {
  readonly backend: string;
  readonly endpoint: string;
  readonly repositoryScope: string;
  readonly fingerprint: string;
  readonly destinationIdentityFingerprint: string;
}

function isLoopbackHost(input: string): boolean {
  const host = input
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  const ipVersion = isIP(host);
  if (ipVersion === 4) {
    const octets = host.split(".").map(Number);
    return octets[0] === 0 || octets[0] === 127 || (octets[0] === 169 && octets[1] === 254);
  }
  if (ipVersion === 6) {
    const normalized = new URL(`http://[${host}]/`).hostname.slice(1, -1);
    if (normalized === "::" || normalized === "::1" || /^fe[89ab][0-9a-f]:/.test(normalized))
      return true;
    const mappedDotted = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mappedDotted) return isLoopbackHost(mappedDotted[1]);
    const mappedHex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (!mappedHex) return false;
    const upper = Number.parseInt(mappedHex[1], 16);
    const lower = Number.parseInt(mappedHex[2], 16);
    return isLoopbackHost(`${upper >>> 8}.${upper & 0xff}.${lower >>> 8}.${lower & 0xff}`);
  }
  return false;
}

function splitUrlTarget(target: string): { endpoint: string; repositoryScope: string } | null {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) return null;
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new Error("Restic destination URL is invalid");
  }
  if (!(url.protocol === "http:" || url.protocol === "https:"))
    throw new Error("Restic destination URL must use HTTP or HTTPS");
  if (url.username || url.password)
    throw new Error("Restic backend credentials must not be embedded in the repository URL");
  if (url.search || url.hash)
    throw new Error("Restic destination URL must not contain a query or fragment");
  if (isLoopbackHost(url.hostname))
    throw new Error("Restic destination must not use a loopback or local endpoint");
  const authorityStart = target.indexOf("://") + 3;
  const pathStart = target.indexOf("/", authorityStart);
  const rawPath = pathStart < 0 ? "/" : target.slice(pathStart);
  let path: string;
  try {
    // Restic's Go URL parser decodes escaped path separators but does not apply
    // WHATWG URL dot-segment normalization before splitting the S3 bucket.
    path = decodeURIComponent(rawPath);
  } catch {
    throw new Error("Restic destination URL path is invalid");
  }
  return {
    endpoint: url.origin,
    repositoryScope: path.startsWith("/") ? path.slice(1) : path,
  };
}

function splitSftpTarget(target: string): { endpoint: string; repositoryScope: string } | null {
  const separator = target.indexOf(":");
  if (separator < 1) return null;
  const authority = target.slice(0, separator);
  const repositoryScope = target.slice(separator + 1);
  if (!repositoryScope) return null;
  const endpoint = authority.slice(authority.lastIndexOf("@") + 1).replace(/^\[|\]$/g, "");
  if (!endpoint) return null;
  if (isLoopbackHost(endpoint))
    throw new Error("Restic destination must not use a loopback or local endpoint");
  return { endpoint, repositoryScope };
}

function splitS3Target(target: string): { endpoint: string; repositoryScope: string } {
  const firstSlash = target.indexOf("/");
  if (firstSlash < 1 || firstSlash === target.length - 1)
    throw new Error("S3 Restic destination must include its remote endpoint and bucket");
  const authority = target.slice(0, firstSlash);
  const remainder = target.slice(firstSlash + 1);
  if (authority.includes("@"))
    throw new Error("Restic backend credentials must not be embedded in the repository URI");
  let endpointUrl: URL;
  try {
    endpointUrl = new URL(`https://${authority}`);
  } catch {
    throw new Error("S3 Restic destination endpoint is invalid");
  }
  if (
    endpointUrl.username ||
    endpointUrl.password ||
    endpointUrl.pathname !== "/" ||
    endpointUrl.search ||
    endpointUrl.hash
  )
    throw new Error("S3 Restic destination endpoint is invalid");
  if (isLoopbackHost(endpointUrl.hostname))
    throw new Error("Restic destination must not use a loopback or local endpoint");
  return { endpoint: endpointUrl.host.toLowerCase(), repositoryScope: remainder };
}

function destinationParts(
  backend: string,
  target: string,
): { endpoint: string; repositoryScope: string } {
  if (
    !target ||
    target.startsWith("/") ||
    target.startsWith("\\") ||
    target.startsWith("./") ||
    target.startsWith("../") ||
    /^[A-Za-z]:[\\/]/.test(target)
  )
    throw new Error("Restic destination must not use a local filesystem path");
  const url = splitUrlTarget(target);
  if (url) {
    if (backend === "s3" && !url.repositoryScope.split("/", 1)[0])
      throw new Error("S3 Restic destination URL must include its remote bucket");
    return url;
  }
  if (backend === "rest") throw new Error("REST Restic destinations must use an HTTP or HTTPS URL");
  if (backend === "sftp") {
    const sftp = splitSftpTarget(target);
    if (!sftp)
      throw new Error("SFTP Restic destination must name a remote host and repository path");
    return sftp;
  }
  if (backend === "s3") return splitS3Target(target);

  const scope = target.replace(/^\/+|\/+$/g, "");
  if (!scope || scope === "." || scope.startsWith("../"))
    throw new Error("Restic destination must name a remote repository scope");
  const endpoints: Record<string, string> = {
    gs: "google-cloud-storage",
    azure: "azure-blob-storage",
    b2: "backblaze-b2",
    swift: "openstack-swift",
  };
  return { endpoint: endpoints[backend], repositoryScope: scope };
}

/**
 * Bind the effective Restic target to an operator-approved value and reject
 * destinations whose URI identifies a local path or loopback host.
 * PRAETORIUM_OFFHOST_RESTIC_REPOSITORY must come from the owner's protected
 * recovery environment, not from a caller-provided command argument.
 */
export function validateOffHostResticDestination(
  env: NodeJS.ProcessEnv,
): OffHostResticDestinationIdentity {
  if (env.RESTIC_REPOSITORY_FILE)
    throw new Error(
      "RESTIC_REPOSITORY_FILE is an unsupported conflicting configuration; recovery requires one owner-approved repository URI",
    );
  const repository = env.RESTIC_REPOSITORY;
  if (!repository) throw new Error("RESTIC_REPOSITORY is required for off-host Restic operations");
  const approvedRepository = env.PRAETORIUM_OFFHOST_RESTIC_REPOSITORY;
  if (!approvedRepository || approvedRepository !== repository)
    throw new Error(
      "RESTIC_REPOSITORY must exactly match the owner-approved PRAETORIUM_OFFHOST_RESTIC_REPOSITORY",
    );

  const separator = repository.indexOf(":");
  const backend = separator > 0 ? repository.slice(0, separator).toLowerCase() : "";
  const target = separator > 0 ? repository.slice(separator + 1) : "";
  if (!REMOTE_RESTIC_SCHEMES.has(backend))
    throw new Error("RESTIC_REPOSITORY must name an approved remote Restic backend");
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/]*@/i.test(target))
    throw new Error("Restic backend credentials must not be embedded in the repository URL");

  const identity = destinationParts(backend, target);
  if (!env.RESTIC_PASSWORD && !env.RESTIC_PASSWORD_FILE)
    throw new Error("Restic password environment is required");
  if (env.RESTIC_PASSWORD_FILE) {
    let isFile = false;
    try {
      isFile = statSync(env.RESTIC_PASSWORD_FILE).isFile();
    } catch {
      // The error below deliberately does not expose the configured path.
    }
    if (!isFile) throw new Error("RESTIC_PASSWORD_FILE must reference an accessible regular file");
  }
  const endpoint = identity.endpoint;
  const fingerprint = createHash("sha256").update(repository).digest("hex");
  return {
    backend,
    endpoint,
    repositoryScope: identity.repositoryScope,
    fingerprint,
    destinationIdentityFingerprint: createHash("sha256")
      .update(
        JSON.stringify({
          format: "praetorium.offhost-restic-destination.v1",
          backend,
          endpoint,
          repositoryFingerprint: fingerprint,
        }),
      )
      .digest("hex"),
  };
}
