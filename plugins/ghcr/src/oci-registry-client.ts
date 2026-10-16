import { isSha256Digest, requireSha256Digest, sha256Digest, type Sha256Digest } from "./digest.js";
import type {
  OciDescriptor,
  OciPlatform,
  RegistryAction,
  RegistryAuthToken,
  RegistryCredential,
  VerifiedBlob,
  VerifiedOciImage,
} from "./oci-types.js";

const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.oci.artifact.manifest.v1+json",
  "application/vnd.oci.image.config.v1+json",
  "application/json",
].join(", ");
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_CONFIG_BYTES = 8 * 1024 * 1024;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const REPOSITORY_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/;
const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

export type RegistryErrorReason =
  | "not_found"
  | "unauthorized"
  | "unavailable"
  | "rate_limited"
  | "invalid_content";

export class RegistryError extends Error {
  constructor(
    readonly reason: RegistryErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "RegistryError";
  }
}

export interface GhcrRegistryClientOptions {
  /** Override only for an explicitly owned local registry. GHCR is the production default. */
  readonly registryUrl?: string;
  /** Permits HTTP only for loopback registry tests. Never set in production composition. */
  readonly allowInsecureLoopback?: boolean;
  /** Registry-only pull credential. GitHub App or user repository tokens do not satisfy this type. */
  readonly pullCredential?: RegistryCredential;
  /** Separate registry-only push credential; used only to request `push,pull` scope. */
  readonly publishCredential?: RegistryCredential;
  readonly allowedRepositories: readonly string[];
  /** Explicit derived-output repositories. Source/base repositories are never writable. */
  readonly publishRepositories?: readonly string[];
  readonly fetch?: typeof fetch;
  readonly maxMetadataBlobBytes?: number;
}

interface RawDescriptor {
  readonly mediaType?: unknown;
  readonly digest?: unknown;
  readonly size?: unknown;
  readonly platform?: unknown;
}

interface ManifestResponse {
  readonly bytes: Uint8Array;
  readonly digest: Sha256Digest;
  readonly mediaType: string;
  readonly json: Record<string, unknown>;
}

interface ImageManifest {
  readonly config: OciDescriptor;
  readonly layers: readonly OciDescriptor[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mediaTypeFromHeader(value: string | null): string | null {
  if (value === null) return null;
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType || null;
}

function parsePlatform(value: unknown): OciPlatform | null {
  if (!isRecord(value)) return null;
  const os = value.os;
  const architecture = value.architecture;
  const variant = value.variant;
  if (
    typeof os !== "string" ||
    os.length === 0 ||
    typeof architecture !== "string" ||
    architecture.length === 0 ||
    (variant !== undefined && (typeof variant !== "string" || variant.length === 0))
  ) {
    return null;
  }
  return variant === undefined ? { os, architecture } : { os, architecture, variant };
}

function exactPlatform(left: OciPlatform, right: OciPlatform): boolean {
  return (
    left.os === right.os &&
    left.architecture === right.architecture &&
    (left.variant ?? "") === (right.variant ?? "")
  );
}

function parseDescriptor(value: unknown, label: string): OciDescriptor {
  if (!isRecord(value)) throw new RegistryError("invalid_content", `${label} descriptor is not an object`);
  const descriptor = value as RawDescriptor;
  if (
    typeof descriptor.mediaType !== "string" ||
    descriptor.mediaType.length === 0 ||
    !isSha256Digest(descriptor.digest) ||
    !Number.isSafeInteger(descriptor.size) ||
    (descriptor.size as number) < 0
  ) {
    throw new RegistryError("invalid_content", `${label} descriptor is incomplete or invalid`);
  }
  const platform = descriptor.platform === undefined ? undefined : parsePlatform(descriptor.platform);
  if (descriptor.platform !== undefined && platform === null) {
    throw new RegistryError("invalid_content", `${label} platform descriptor is invalid`);
  }
  return {
    mediaType: descriptor.mediaType,
    digest: descriptor.digest,
    size: descriptor.size as number,
    ...(platform === undefined ? {} : { platform: platform! }),
  };
}

function parseImageManifest(json: Record<string, unknown>): ImageManifest {
  if (json.schemaVersion !== 2 || !Array.isArray(json.layers)) {
    throw new RegistryError("invalid_content", "image manifest schema is not supported");
  }
  const config = parseDescriptor(json.config, "config");
  if (json.layers.length > 4096) {
    throw new RegistryError("invalid_content", "image manifest has too many layers");
  }
  return {
    config,
    layers: json.layers.map((layer, index) => parseDescriptor(layer, `layer ${index}`)),
  };
}

function jsonObject(bytes: Uint8Array, label: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!isRecord(parsed)) throw new Error("expected object");
    return parsed;
  } catch {
    throw new RegistryError("invalid_content", `${label} is not valid UTF-8 JSON`);
  }
}

function encodeBasicCredential(credential: RegistryCredential): string {
  if (!credential.username || !credential.password) {
    throw new TypeError("registry username and password must both be configured");
  }
  const bytes = new TextEncoder().encode(`${credential.username}:${credential.password}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

function contentLength(response: Response): number | null {
  const value = response.headers.get("content-length");
  if (value === null || !/^\d+$/.test(value)) return null;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : null;
}

async function readBoundedBody(response: Response, maxBytes: number, label: string): Promise<Uint8Array> {
  const declaredLength = contentLength(response);
  if (declaredLength !== null && declaredLength > maxBytes) {
    throw new RegistryError("invalid_content", `${label} exceeds the configured size limit`);
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (!Number.isSafeInteger(total) || total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new RegistryError("invalid_content", `${label} exceeds the configured size limit`);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof RegistryError) throw error;
    throw new RegistryError("unavailable", `${label} body read failed`);
  } finally {
    reader.releaseLock();
  }
  if (declaredLength !== null && total !== declaredLength) {
    throw new RegistryError("invalid_content", `${label} content length does not match its header`);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * A GHCR OCI Distribution client. Mutable tags are exposed only through
 * discoverTag(); all verification and admission APIs require sha256 digests.
 * Every manifest/config body consumed here is hashed before it is trusted.
 */
export class GhcrRegistryClient {
  private readonly baseUrl: URL;
  private readonly allowedRepositories: ReadonlySet<string>;
  private readonly publishRepositories: ReadonlySet<string>;
  private readonly fetchImplementation: typeof fetch;
  private readonly maxMetadataBlobBytes: number;

  constructor(private readonly options: GhcrRegistryClientOptions) {
    const baseUrl = new URL(options.registryUrl ?? "https://ghcr.io");
    if (
      baseUrl.pathname !== "/" ||
      baseUrl.username !== "" ||
      baseUrl.password !== "" ||
      baseUrl.search !== "" ||
      baseUrl.hash !== "" ||
      (baseUrl.protocol !== "https:" &&
        !(options.allowInsecureLoopback === true && baseUrl.protocol === "http:" && isLoopback(baseUrl.hostname)))
    ) {
      throw new TypeError("registry URL must be HTTPS (HTTP is allowed only for explicit loopback tests)");
    }
    this.baseUrl = new URL(baseUrl.origin);
    this.allowedRepositories = new Set(options.allowedRepositories.map((repo) => this.validateRepository(repo)));
    this.publishRepositories = new Set((options.publishRepositories ?? []).map((repo) => this.validateRepository(repo)));
    if (options.publishCredential && this.publishRepositories.size === 0) {
      throw new TypeError("publishCredential requires an explicit derived-output repository allowlist");
    }
    if (
      options.pullCredential &&
      options.publishCredential &&
      options.pullCredential.username === options.publishCredential.username &&
      options.pullCredential.password === options.publishCredential.password
    ) {
      throw new TypeError("registry pull and publish credentials must be separate");
    }
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.maxMetadataBlobBytes = options.maxMetadataBlobBytes ?? 2 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxMetadataBlobBytes) || this.maxMetadataBlobBytes < 1) {
      throw new TypeError("maxMetadataBlobBytes must be a positive safe integer");
    }
  }

  /** Resolves a mutable tag once. Persist the returned digest; never use the tag as artifact identity. */
  async discoverTag(repository: string, tag: string): Promise<{ digest: Sha256Digest; mediaType: string }> {
    const repo = this.requireAllowedRepository(repository);
    if (!TAG_RE.test(tag)) throw new TypeError("registry tag is invalid");
    const token = await this.getToken(repo, ["pull"]);
    const manifest = await this.fetchManifest(repo, tag, token, null);
    return { digest: manifest.digest, mediaType: manifest.mediaType };
  }

  /** Issues a narrowly scoped pull token for a BuildKit/runtime consumer. */
  async issuePullAuth(repository: string): Promise<RegistryAuthToken> {
    const repo = this.requireAllowedRepository(repository);
    return {
      registry: this.baseUrl.host,
      repository: repo,
      actions: ["pull"],
      token: await this.getToken(repo, ["pull"]),
    };
  }

  /** Issues a write token only from the separately configured GHCR publisher credential. */
  async issuePublishAuth(repository: string): Promise<RegistryAuthToken> {
    const repo = this.requireAllowedRepository(repository);
    if (!this.options.publishCredential || !this.publishRepositories.has(repo)) {
      throw new RegistryError("unauthorized", "dedicated registry publisher credential is not configured");
    }
    return {
      registry: this.baseUrl.host,
      repository: repo,
      actions: ["pull", "push"],
      token: await this.getToken(repo, ["pull", "push"], this.options.publishCredential),
    };
  }

  /** Verifies an immutable image manifest and the exact selected OS/architecture/variant. */
  async verifyImage(
    repository: string,
    manifestDigest: string,
    requestedPlatform: OciPlatform,
  ): Promise<VerifiedOciImage> {
    const repo = this.requireAllowedRepository(repository);
    const digest = requireSha256Digest(manifestDigest, "manifest digest");
    validatePlatform(requestedPlatform);
    const token = await this.getToken(repo, ["pull"]);
    const root = await this.fetchManifest(repo, digest, token, digest);
    let selected = root;

    if (isIndexMediaType(root.mediaType)) {
      if (!Array.isArray(root.json.manifests)) {
        throw new RegistryError("invalid_content", "OCI index has no manifest descriptors");
      }
      const descriptors = root.json.manifests.map((item, index) => parseDescriptor(item, `manifest ${index}`));
      const matches = descriptors.filter(
        (descriptor) => descriptor.platform !== undefined && exactPlatform(descriptor.platform, requestedPlatform),
      );
      if (matches.length !== 1) {
        throw new RegistryError(
          "invalid_content",
          matches.length === 0
            ? "OCI index has no manifest for the requested platform"
            : "OCI index has multiple manifests for the requested platform",
        );
      }
      const child = matches[0]!;
      selected = await this.fetchManifest(repo, child.digest, token, child.digest);
      if (selected.bytes.byteLength !== child.size) {
        throw new RegistryError("invalid_content", "selected platform manifest size does not match its descriptor");
      }
      if (normalizeMediaType(child.mediaType) !== selected.mediaType) {
        throw new RegistryError("invalid_content", "selected platform manifest media type does not match its descriptor");
      }
    } else if (!isImageManifestMediaType(root.mediaType)) {
      throw new RegistryError("invalid_content", "digest does not identify an OCI image manifest or index");
    }

    if (!isImageManifestMediaType(selected.mediaType)) {
      throw new RegistryError("invalid_content", "selected platform descriptor is not an OCI image manifest");
    }
    const imageManifest = parseImageManifest(selected.json);
    const configBlob = await this.fetchBlob(repo, imageManifest.config.digest, token, {
      expectedSize: imageManifest.config.size,
      maxBytes: MAX_CONFIG_BYTES,
    });
    const config = jsonObject(configBlob.bytes, "image config");
    const actualPlatform = parsePlatform({
      os: config.os,
      architecture: config.architecture,
      ...(config.variant === undefined ? {} : { variant: config.variant }),
    });
    if (actualPlatform === null || !exactPlatform(actualPlatform, requestedPlatform)) {
      throw new RegistryError("invalid_content", "image config platform does not match the requested platform");
    }

    let reachableLayerBytes = 0;
    for (const layer of imageManifest.layers) {
      reachableLayerBytes += layer.size;
      if (!Number.isSafeInteger(reachableLayerBytes)) {
        throw new RegistryError("invalid_content", "image layer sizes overflow the supported range");
      }
      await this.verifyBlobReachable(repo, layer, token);
    }

    return {
      repository: repo,
      manifestDigest: root.digest,
      manifestMediaType: root.mediaType,
      platformManifestDigest: selected.digest,
      platform: actualPlatform,
      configDigest: imageManifest.config.digest,
      layerDescriptors: imageManifest.layers,
      reachableLayerBytes,
    };
  }

  /** Fetches a small digest-addressed JSON/catalog blob and verifies its exact bytes. */
  async readBlob(repository: string, digest: string, maxBytes = this.maxMetadataBlobBytes): Promise<VerifiedBlob> {
    const repo = this.requireAllowedRepository(repository);
    const expectedDigest = requireSha256Digest(digest, "blob digest");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > this.maxMetadataBlobBytes) {
      throw new TypeError("blob size limit is outside the configured metadata limit");
    }
    const token = await this.getToken(repo, ["pull"]);
    return this.fetchBlob(repo, expectedDigest, token, { maxBytes });
  }

  private validateRepository(repository: string): string {
    const normalized = repository.trim();
    if (!REPOSITORY_RE.test(normalized)) throw new TypeError("registry repository path is invalid");
    return normalized;
  }

  private requireAllowedRepository(repository: string): string {
    const repo = this.validateRepository(repository);
    if (!this.allowedRepositories.has(repo)) {
      throw new RegistryError("not_found", "registry repository is not in the configured allowlist");
    }
    return repo;
  }

  private async getToken(
    repository: string,
    actions: readonly RegistryAction[],
    overrideCredential?: RegistryCredential,
  ): Promise<string> {
    const credential = overrideCredential ?? this.options.pullCredential;
    if (this.baseUrl.host !== "ghcr.io" && credential === undefined) return "";
    const tokenUrl = new URL("/token", this.baseUrl);
    tokenUrl.searchParams.set("service", this.baseUrl.host);
    tokenUrl.searchParams.set("scope", `repository:${repository}:${[...actions].sort().join(",")}`);
    const headers = new Headers();
    if (credential) headers.set("authorization", encodeBasicCredential(credential));

    let response: Response;
    try {
      response = await this.fetchImplementation(tokenUrl, { headers, redirect: "error" });
    } catch {
      throw new RegistryError("unavailable", "registry token request failed");
    }
    if (response.status === 401 || response.status === 403) {
      throw new RegistryError("unauthorized", "registry rejected the configured credential");
    }
    if (response.status === 429) throw new RegistryError("rate_limited", "registry rate limit exceeded");
    if (!response.ok) throw new RegistryError("unavailable", `registry token request returned ${response.status}`);
    let body: unknown;
    try {
      body = jsonObject(await readBoundedBody(response, 64 * 1024, "registry token response"), "registry token response");
    } catch {
      throw new RegistryError("invalid_content", "registry token response is not valid JSON");
    }
    if (!isRecord(body)) throw new RegistryError("invalid_content", "registry token response is not an object");
    const token = typeof body.token === "string" ? body.token : body.access_token;
    if (typeof token !== "string" || token.length === 0) {
      throw new RegistryError("unauthorized", "registry did not issue a scoped access token");
    }
    return token;
  }

  private async fetchManifest(
    repository: string,
    reference: string,
    token: string,
    expectedDigest: Sha256Digest | null,
  ): Promise<ManifestResponse> {
    const url = new URL(`/v2/${repository}/manifests/${encodeURIComponent(reference)}`, this.baseUrl);
    let response: Response;
    try {
      const headers = new Headers({ accept: MANIFEST_ACCEPT });
      if (token) headers.set("authorization", `Bearer ${token}`);
      response = await this.fetchImplementation(url, {
        headers,
        redirect: "error",
      });
    } catch {
      throw new RegistryError("unavailable", "registry manifest request failed");
    }
    if (response.status === 404) throw new RegistryError("not_found", "registry manifest was not found");
    if (response.status === 401 || response.status === 403) throw new RegistryError("unauthorized", "registry manifest access was denied");
    if (response.status === 429) throw new RegistryError("rate_limited", "registry rate limit exceeded");
    if (!response.ok) throw new RegistryError("unavailable", `registry manifest request returned ${response.status}`);

    const bytes = await readBoundedBody(response, MAX_MANIFEST_BYTES, "registry manifest");
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_MANIFEST_BYTES) {
      throw new RegistryError("invalid_content", "registry manifest body has an invalid size");
    }
    const actualDigest = await sha256Digest(bytes);
    if (expectedDigest !== null && actualDigest !== expectedDigest) {
      throw new RegistryError("invalid_content", "registry manifest bytes do not match the requested digest");
    }
    const headerDigest = response.headers.get("docker-content-digest");
    if (headerDigest !== null && headerDigest !== actualDigest) {
      throw new RegistryError("invalid_content", "registry digest header does not match manifest bytes");
    }
    const json = jsonObject(bytes, "registry manifest");
    const declaredType = typeof json.mediaType === "string" ? normalizeMediaType(json.mediaType) : null;
    const headerType = mediaTypeFromHeader(response.headers.get("content-type"));
    if (declaredType !== null && headerType !== null && declaredType !== headerType) {
      throw new RegistryError("invalid_content", "registry manifest media type declarations disagree");
    }
    const mediaType = declaredType ?? headerType;
    if (mediaType === null) throw new RegistryError("invalid_content", "registry manifest has no media type");
    return { bytes, digest: actualDigest, mediaType, json };
  }

  private async fetchBlob(
    repository: string,
    digest: Sha256Digest,
    token: string,
    options: { readonly expectedSize?: number; readonly maxBytes: number },
  ): Promise<VerifiedBlob> {
    const url = new URL(`/v2/${repository}/blobs/${encodeURIComponent(digest)}`, this.baseUrl);
    let response: Response;
    try {
      const headers = new Headers();
      if (token) headers.set("authorization", `Bearer ${token}`);
      response = await this.fetchImplementation(url, { headers });
    } catch {
      throw new RegistryError("unavailable", "registry blob request failed");
    }
    if (response.status === 404) throw new RegistryError("not_found", "registry blob was not found");
    if (response.status === 401 || response.status === 403) throw new RegistryError("unauthorized", "registry blob access was denied");
    if (response.status === 429) throw new RegistryError("rate_limited", "registry rate limit exceeded");
    if (!response.ok) throw new RegistryError("unavailable", `registry blob request returned ${response.status}`);
    const headerLength = contentLength(response);
    if (headerLength !== null && headerLength > options.maxBytes) {
      throw new RegistryError("invalid_content", "registry blob exceeds the configured size limit");
    }
    const bytes = await readBoundedBody(response, options.maxBytes, "registry blob");
    if (bytes.byteLength > options.maxBytes) throw new RegistryError("invalid_content", "registry blob exceeds the configured size limit");
    if (options.expectedSize !== undefined && bytes.byteLength !== options.expectedSize) {
      throw new RegistryError("invalid_content", "registry blob size does not match its descriptor");
    }
    const actualDigest = await sha256Digest(bytes);
    if (actualDigest !== digest) throw new RegistryError("invalid_content", "registry blob bytes do not match their digest");
    const headerDigest = response.headers.get("docker-content-digest");
    if (headerDigest !== null && headerDigest !== actualDigest) {
      throw new RegistryError("invalid_content", "registry blob digest header does not match its bytes");
    }
    return {
      digest: actualDigest,
      mediaType: mediaTypeFromHeader(response.headers.get("content-type")) ?? "application/octet-stream",
      size: bytes.byteLength,
      bytes,
    };
  }

  private async verifyBlobReachable(repository: string, descriptor: OciDescriptor, token: string): Promise<void> {
    const url = new URL(`/v2/${repository}/blobs/${encodeURIComponent(descriptor.digest)}`, this.baseUrl);
    let response: Response;
    try {
      const headers = new Headers();
      if (token) headers.set("authorization", `Bearer ${token}`);
      response = await this.fetchImplementation(url, {
        method: "HEAD",
        headers,
        redirect: "error",
      });
    } catch {
      throw new RegistryError("unavailable", "registry layer reachability check failed");
    }
    if (response.status === 404) throw new RegistryError("not_found", "an image layer is missing from the registry");
    if (response.status === 401 || response.status === 403) throw new RegistryError("unauthorized", "registry layer access was denied");
    if (response.status === 429) throw new RegistryError("rate_limited", "registry rate limit exceeded");
    if (!response.ok) throw new RegistryError("unavailable", `registry layer check returned ${response.status}`);
    const length = contentLength(response);
    if (length === null || length !== descriptor.size) {
      throw new RegistryError("invalid_content", "registry layer size does not match its descriptor");
    }
    const headerDigest = response.headers.get("docker-content-digest");
    if (headerDigest !== descriptor.digest) {
      throw new RegistryError("invalid_content", "registry layer digest header does not match its descriptor");
    }
  }
}

function validatePlatform(platform: OciPlatform): void {
  if (
    !platform ||
    typeof platform.os !== "string" ||
    platform.os.length === 0 ||
    typeof platform.architecture !== "string" ||
    platform.architecture.length === 0 ||
    (platform.variant !== undefined && (typeof platform.variant !== "string" || platform.variant.length === 0))
  ) {
    throw new TypeError("requested OCI platform is invalid");
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function normalizeMediaType(value: string): string {
  return value.split(";", 1)[0]!.trim().toLowerCase();
}

function isIndexMediaType(value: string): boolean {
  return value === "application/vnd.oci.image.index.v1+json" || value === "application/vnd.docker.distribution.manifest.list.v2+json";
}

function isImageManifestMediaType(value: string): boolean {
  return value === "application/vnd.oci.image.manifest.v1+json" || value === "application/vnd.docker.distribution.manifest.v2+json";
}

export { isSha256Digest };
