import { createHash } from "node:crypto";
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
const MAX_TIMER_MS = 2_147_483_647;
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
  /** Required operator cap for the aggregate raw bytes downloaded while verifying all image layers. */
  readonly maxImageLayerBytes: number;
  /** Required operator wall-clock budget for verification from token exchange through all image layers. */
  readonly maxImageVerificationMs: number;
  /** Required cap for each registry request, including response body consumption. */
  readonly maxRegistryRequestMs: number;
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

function samePlatformFamily(left: OciPlatform, right: OciPlatform): boolean {
  return left.os === right.os && left.architecture === right.architecture;
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

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  label: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const declaredLength = contentLength(response);
  if (declaredLength !== null && declaredLength > maxBytes) {
    void response.body?.cancel().catch(() => undefined);
    throw new RegistryError("invalid_content", `${label} exceeds the configured size limit`);
  }
  if (signal?.aborted) {
    void response.body?.cancel().catch(() => undefined);
    throw new RegistryError("unavailable", `${label} request was canceled`);
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let rejectAborted: ((error: Error) => void) | undefined;
  const aborted = signal === undefined
    ? undefined
    : new Promise<never>((_, reject) => { rejectAborted = reject; });
  void aborted?.catch(() => undefined);
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
    rejectAborted?.(new Error("response body read aborted"));
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    while (true) {
      const read = reader.read();
      const { done, value } = aborted === undefined ? await read : await Promise.race([read, aborted]);
      if (done) break;
      total += value.byteLength;
      if (!Number.isSafeInteger(total) || total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new RegistryError("invalid_content", `${label} exceeds the configured size limit`);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (signal?.aborted) throw new RegistryError("unavailable", `${label} request was canceled`);
    if (error instanceof RegistryError) throw error;
    throw new RegistryError("unavailable", `${label} body read failed`);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try { reader.releaseLock(); } catch { /* an aborted stream can still have a pending read */ }
  }
  if (signal?.aborted) throw new RegistryError("unavailable", `${label} request was canceled`);
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
  private readonly maxImageLayerBytes: number;
  private readonly maxImageVerificationMs: number;
  private readonly maxRegistryRequestMs: number;

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
    this.maxImageLayerBytes = options.maxImageLayerBytes;
    this.maxImageVerificationMs = options.maxImageVerificationMs;
    this.maxRegistryRequestMs = options.maxRegistryRequestMs;
    if (!Number.isSafeInteger(this.maxImageLayerBytes) || this.maxImageLayerBytes < 1) {
      throw new TypeError("maxImageLayerBytes must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.maxImageVerificationMs) || this.maxImageVerificationMs < 1 || this.maxImageVerificationMs > MAX_TIMER_MS) {
      throw new TypeError("maxImageVerificationMs must be a positive timer duration");
    }
    if (!Number.isSafeInteger(this.maxRegistryRequestMs) || this.maxRegistryRequestMs < 1 || this.maxRegistryRequestMs > MAX_TIMER_MS) {
      throw new TypeError("maxRegistryRequestMs must be a positive timer duration");
    }
  }

  /** Canonical host (including any configured port) of this registry origin. */
  get registryHost(): string {
    return this.baseUrl.host;
  }

  /** Resolves a mutable tag once. Persist the returned digest; never use the tag as artifact identity. */
  async discoverTag(repository: string, tag: string, signal?: AbortSignal): Promise<{ digest: Sha256Digest; mediaType: string }> {
    const repo = this.requireAllowedRepository(repository);
    if (!TAG_RE.test(tag)) throw new TypeError("registry tag is invalid");
    const token = await this.getToken(repo, ["pull"], undefined, signal);
    const manifest = await this.fetchManifest(repo, tag, token, null, signal);
    return { digest: manifest.digest, mediaType: manifest.mediaType };
  }

  /** Issues a narrowly scoped pull token for a BuildKit/runtime consumer. */
  async issuePullAuth(repository: string, signal?: AbortSignal): Promise<RegistryAuthToken> {
    const repo = this.requireAllowedRepository(repository);
    return {
      registry: this.baseUrl.host,
      repository: repo,
      actions: ["pull"],
      token: await this.getToken(repo, ["pull"], undefined, signal),
    };
  }

  /** Issues a write token only from the separately configured GHCR publisher credential. */
  async issuePublishAuth(repository: string, signal?: AbortSignal): Promise<RegistryAuthToken> {
    const repo = this.requireAllowedRepository(repository);
    if (!this.options.publishCredential || !this.publishRepositories.has(repo)) {
      throw new RegistryError("unauthorized", "dedicated registry publisher credential is not configured");
    }
    return {
      registry: this.baseUrl.host,
      repository: repo,
      actions: ["pull", "push"],
      token: await this.getToken(repo, ["pull", "push"], this.options.publishCredential, signal),
    };
  }

  /** Verifies an immutable image manifest and the selected OS/architecture family. */
  async verifyImage(
    repository: string,
    manifestDigest: string,
    requestedPlatform: OciPlatform,
    signal?: AbortSignal,
  ): Promise<VerifiedOciImage> {
    return this.withAbortBudget(signal, this.maxImageVerificationMs, "image verification", (budgetSignal) =>
      this.verifyImageWithinBudget(repository, manifestDigest, requestedPlatform, budgetSignal));
  }

  private async verifyImageWithinBudget(
    repository: string,
    manifestDigest: string,
    requestedPlatform: OciPlatform,
    signal: AbortSignal,
  ): Promise<VerifiedOciImage> {
    const repo = this.requireAllowedRepository(repository);
    const digest = requireSha256Digest(manifestDigest, "manifest digest");
    validatePlatform(requestedPlatform);
    const token = await this.getToken(repo, ["pull"], undefined, signal);
    const root = await this.fetchManifest(repo, digest, token, digest, signal);
    let selected = root;

    if (isIndexMediaType(root.mediaType)) {
      if (!Array.isArray(root.json.manifests)) {
        throw new RegistryError("invalid_content", "OCI index has no manifest descriptors");
      }
      const descriptors = root.json.manifests.map((item, index) => parseDescriptor(item, `manifest ${index}`));
      // BuildInput names OS/architecture only. OCI ARM64 descriptors often
      // carry a variant (commonly v8), which is not a separate target here.
      // Multiple descriptors for the same family remain ambiguous and fail.
      const matches = descriptors.filter(
        (descriptor) => descriptor.platform !== undefined && samePlatformFamily(descriptor.platform, requestedPlatform),
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
      selected = await this.fetchManifest(repo, child.digest, token, child.digest, signal);
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
    }, signal);
    const config = jsonObject(configBlob.bytes, "image config");
    const actualPlatform = parsePlatform({
      os: config.os,
      architecture: config.architecture,
      ...(config.variant === undefined ? {} : { variant: config.variant }),
    });
    if (actualPlatform === null || !samePlatformFamily(actualPlatform, requestedPlatform)) {
      throw new RegistryError("invalid_content", "image config platform does not match the requested platform");
    }

    let reachableLayerBytes = 0;
    for (const layer of imageManifest.layers) {
      reachableLayerBytes += layer.size;
      if (!Number.isSafeInteger(reachableLayerBytes)) {
        throw new RegistryError("invalid_content", "image layer sizes overflow the supported range");
      }
      if (reachableLayerBytes > this.maxImageLayerBytes) {
        throw new RegistryError("invalid_content", "image layers exceed the configured aggregate size limit");
      }
    }

    for (const layer of imageManifest.layers) {
      await this.verifyLayerContent(repo, layer, token, signal);
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
  async readBlob(repository: string, digest: string, maxBytes = this.maxMetadataBlobBytes, signal?: AbortSignal): Promise<VerifiedBlob> {
    const repo = this.requireAllowedRepository(repository);
    const expectedDigest = requireSha256Digest(digest, "blob digest");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > this.maxMetadataBlobBytes) {
      throw new TypeError("blob size limit is outside the configured metadata limit");
    }
    const token = await this.getToken(repo, ["pull"], undefined, signal);
    return this.fetchBlob(repo, expectedDigest, token, { maxBytes }, signal);
  }

  /** Uploads one bounded digest-addressed metadata blob to an explicit derived-output repository. */
  async publishBlob(repository: string, bytes: Uint8Array, signal?: AbortSignal): Promise<Sha256Digest> {
    const repo = this.requireAllowedRepository(repository);
    const anonymousLoopbackPublisher =
      this.options.allowInsecureLoopback === true &&
      this.baseUrl.protocol === "http:" &&
      isLoopback(this.baseUrl.hostname);
    if (!this.publishRepositories.has(repo) || (!this.options.publishCredential && !anonymousLoopbackPublisher)) {
      throw new RegistryError("unauthorized", "dedicated registry publisher is not configured for this repository");
    }
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > this.maxMetadataBlobBytes) {
      throw new RegistryError("invalid_content", "metadata blob exceeds the configured size limit");
    }
    const digest = await sha256Digest(bytes);
    const token = await this.getToken(repo, ["pull", "push"], this.options.publishCredential, signal);
    const blobUrl = new URL(`/v2/${repo}/blobs/${encodeURIComponent(digest)}`, this.baseUrl);
    const authorization = new Headers();
    if (token) authorization.set("authorization", `Bearer ${token}`);
    const alreadyPresent = await this.withRegistryRequest<boolean>(
      blobUrl,
      { method: "HEAD", headers: authorization, redirect: "manual" },
      signal,
      "blob existence check",
      async (response) => {
        if (response.status === 200) {
          const headerDigest = response.headers.get("docker-content-digest");
          if (headerDigest !== null && headerDigest !== digest) {
            throw new RegistryError("invalid_content", "registry blob existence digest does not match requested bytes");
          }
          void response.body?.cancel().catch(() => undefined);
          return true;
        }
        if (response.status === 404) {
          void response.body?.cancel().catch(() => undefined);
          return false;
        }
        if (response.status === 401 || response.status === 403) {
          throw new RegistryError("unauthorized", "registry denied metadata blob access");
        }
        if (response.status === 429) throw new RegistryError("rate_limited", "registry rate limit exceeded");
        throw new RegistryError("unavailable", `registry blob existence check returned ${response.status}`);
      },
    );
    if (alreadyPresent) return digest;

    const uploadUrl = new URL(`/v2/${repo}/blobs/uploads/`, this.baseUrl);
    const uploadLocation = await this.withRegistryRequest<URL>(
      uploadUrl,
      { method: "POST", headers: authorization, redirect: "manual" },
      signal,
      "blob upload start",
      async (response) => {
        if (response.status === 401 || response.status === 403) {
          throw new RegistryError("unauthorized", "registry denied metadata blob upload");
        }
        if (response.status === 429) throw new RegistryError("rate_limited", "registry rate limit exceeded");
        if (response.status !== 202) {
          throw new RegistryError("unavailable", `registry blob upload start returned ${response.status}`);
        }
        const location = response.headers.get("location");
        if (!location || location.length > 8192) {
          throw new RegistryError("invalid_content", "registry omitted or oversized the upload location");
        }
        const resolved = new URL(location, this.baseUrl);
        const uploadPrefix = `/v2/${repo}/blobs/uploads/`;
        const uploadId = resolved.pathname.startsWith(uploadPrefix)
          ? resolved.pathname.slice(uploadPrefix.length).replace(/\/$/u, "")
          : "";
        if (
          resolved.origin !== this.baseUrl.origin ||
          resolved.username !== "" ||
          resolved.password !== "" ||
          resolved.hash !== "" ||
          !/^[A-Za-z0-9._~-]{1,512}$/u.test(uploadId) ||
          uploadId === "." ||
          uploadId === ".." ||
          resolved.search.length > 4096
        ) {
          throw new RegistryError("invalid_content", "registry returned an unsafe upload location");
        }
        void response.body?.cancel().catch(() => undefined);
        return resolved;
      },
    );
    uploadLocation.searchParams.set("digest", digest);
    await this.withRegistryRequest(
      uploadLocation,
      {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: Buffer.from(bytes),
        redirect: "manual",
      },
      signal,
      "blob upload",
      async (response) => {
        if (response.status === 401 || response.status === 403) {
          throw new RegistryError("unauthorized", "registry denied metadata blob upload");
        }
        if (response.status === 429) throw new RegistryError("rate_limited", "registry rate limit exceeded");
        if (response.status !== 201) {
          throw new RegistryError("unavailable", `registry blob upload returned ${response.status}`);
        }
        const headerDigest = response.headers.get("docker-content-digest");
        if (headerDigest !== null && headerDigest !== digest) {
          throw new RegistryError("invalid_content", "registry stored metadata under a different digest");
        }
        void response.body?.cancel().catch(() => undefined);
        return undefined;
      },
    );
    return digest;
  }

  private async withAbortBudget<T>(
    parentSignal: AbortSignal | undefined,
    timeoutMs: number,
    label: string,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let timedOut = false;
    let rejectAborted: ((error: Error) => void) | undefined;
    const aborted = new Promise<never>((_, reject) => { rejectAborted = reject; });
    void aborted.catch(() => undefined);
    const onAbort = () => rejectAborted?.(new Error(`${label} aborted`));
    const onParentAbort = () => controller.abort(parentSignal?.reason);
    controller.signal.addEventListener("abort", onAbort, { once: true });
    if (parentSignal?.aborted) controller.abort(parentSignal.reason);
    else parentSignal?.addEventListener("abort", onParentAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`${label} timed out`));
    }, timeoutMs);

    try {
      if (controller.signal.aborted) throw new RegistryError("unavailable", `${label} was canceled`);
      const result = await Promise.race([operation(controller.signal), aborted]);
      if (timedOut) throw new RegistryError("unavailable", `${label} exceeded its configured time limit`);
      if (parentSignal?.aborted) throw new RegistryError("unavailable", `${label} was canceled`);
      return result;
    } catch (error) {
      if (timedOut) throw new RegistryError("unavailable", `${label} exceeded its configured time limit`);
      if (parentSignal?.aborted) throw new RegistryError("unavailable", `${label} was canceled`);
      throw error;
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
      parentSignal?.removeEventListener("abort", onParentAbort);
    }
  }

  private withRegistryRequest<T>(
    url: URL,
    init: RequestInit,
    parentSignal: AbortSignal | undefined,
    label: string,
    consume: (response: Response, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    return this.withAbortBudget(parentSignal, this.maxRegistryRequestMs, `registry ${label}`, async (signal) => {
      let response: Response;
      try {
        response = await this.fetchImplementation(url, { ...init, signal });
      } catch {
        if (signal.aborted) throw new RegistryError("unavailable", `registry ${label} request was canceled`);
        throw new RegistryError("unavailable", `registry ${label} request failed`);
      }
      if (signal.aborted) throw new RegistryError("unavailable", `registry ${label} request was canceled`);
      try {
        return await consume(response, signal);
      } catch (error) {
        if (!response.bodyUsed) void response.body?.cancel().catch(() => undefined);
        throw error;
      }
    });
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
    signal?: AbortSignal,
  ): Promise<string> {
    const credential = overrideCredential ?? this.options.pullCredential;
    if (this.baseUrl.host !== "ghcr.io" && credential === undefined) return "";
    const tokenUrl = new URL("/token", this.baseUrl);
    tokenUrl.searchParams.set("service", this.baseUrl.host);
    tokenUrl.searchParams.set("scope", `repository:${repository}:${[...actions].sort().join(",")}`);
    const headers = new Headers();
    if (credential) headers.set("authorization", encodeBasicCredential(credential));

    return this.withRegistryRequest(tokenUrl, { headers, redirect: "manual" }, signal, "token exchange", async (response, requestSignal) => {
      if (response.status === 401 || response.status === 403) {
        throw new RegistryError("unauthorized", "registry rejected the configured credential");
      }
      if (response.status === 429) throw new RegistryError("rate_limited", "registry rate limit exceeded");
      if (!response.ok) throw new RegistryError("unavailable", `registry token request returned ${response.status}`);
      const bytes = await readBoundedBody(response, 64 * 1024, "registry token response", requestSignal);
      let body: unknown;
      try {
        body = jsonObject(bytes, "registry token response");
      } catch {
        throw new RegistryError("invalid_content", "registry token response is not valid JSON");
      }
      if (!isRecord(body)) throw new RegistryError("invalid_content", "registry token response is not an object");
      const token = typeof body.token === "string" ? body.token : body.access_token;
      if (typeof token !== "string" || token.length === 0) {
        throw new RegistryError("unauthorized", "registry did not issue a scoped access token");
      }
      return token;
    });
  }

  private async fetchManifest(
    repository: string,
    reference: string,
    token: string,
    expectedDigest: Sha256Digest | null,
    signal?: AbortSignal,
  ): Promise<ManifestResponse> {
    const url = new URL(`/v2/${repository}/manifests/${encodeURIComponent(reference)}`, this.baseUrl);
    const headers = new Headers({ accept: MANIFEST_ACCEPT });
    if (token) headers.set("authorization", `Bearer ${token}`);
    return this.withRegistryRequest(url, { headers, redirect: "manual" }, signal, "manifest", async (response, requestSignal) => {
      if (response.status === 404) throw new RegistryError("not_found", "registry manifest was not found");
      if (response.status === 401 || response.status === 403) throw new RegistryError("unauthorized", "registry manifest access was denied");
      if (response.status === 429) throw new RegistryError("rate_limited", "registry rate limit exceeded");
      if (!response.ok) throw new RegistryError("unavailable", `registry manifest request returned ${response.status}`);

      const bytes = await readBoundedBody(response, MAX_MANIFEST_BYTES, "registry manifest", requestSignal);
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
    });
  }

  private async fetchBlob(
    repository: string,
    digest: Sha256Digest,
    token: string,
    options: { readonly expectedSize?: number; readonly maxBytes: number },
    signal?: AbortSignal,
  ): Promise<VerifiedBlob> {
    const url = new URL(`/v2/${repository}/blobs/${encodeURIComponent(digest)}`, this.baseUrl);
    const headers = new Headers();
    if (token) headers.set("authorization", `Bearer ${token}`);
    return this.withRegistryRequest(url, { headers, redirect: "manual" }, signal, "blob", async (response, requestSignal) => {
      if (response.status === 404) throw new RegistryError("not_found", "registry blob was not found");
      if (response.status === 401 || response.status === 403) throw new RegistryError("unauthorized", "registry blob access was denied");
      if (response.status === 429) throw new RegistryError("rate_limited", "registry rate limit exceeded");
      if (!response.ok) throw new RegistryError("unavailable", `registry blob request returned ${response.status}`);
      const headerLength = contentLength(response);
      if (headerLength !== null && headerLength > options.maxBytes) {
        void response.body?.cancel().catch(() => undefined);
        throw new RegistryError("invalid_content", "registry blob exceeds the configured size limit");
      }
      const bytes = await readBoundedBody(response, options.maxBytes, "registry blob", requestSignal);
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
    });
  }

  private async verifyLayerContent(
    repository: string,
    descriptor: OciDescriptor,
    token: string,
    signal: AbortSignal,
  ): Promise<void> {
    const url = new URL(`/v2/${repository}/blobs/${encodeURIComponent(descriptor.digest)}`, this.baseUrl);
    const headers = new Headers({ "accept-encoding": "identity" });
    if (token) headers.set("authorization", `Bearer ${token}`);
    await this.withRegistryRequest(url, { headers, redirect: "manual" }, signal, "layer", async (response, requestSignal) => {
      if (response.status === 404) throw new RegistryError("not_found", "an image layer is missing from the registry");
      if (response.status === 401 || response.status === 403) throw new RegistryError("unauthorized", "registry layer access was denied");
      if (response.status === 429) throw new RegistryError("rate_limited", "registry rate limit exceeded");
      if (!response.ok) throw new RegistryError("unavailable", `registry layer request returned ${response.status}`);
      const declaredLengthHeader = response.headers.get("content-length");
      const declaredLength = contentLength(response);
      if (declaredLengthHeader !== null && (declaredLength === null || declaredLength !== descriptor.size)) {
        void response.body?.cancel().catch(() => undefined);
        throw new RegistryError("invalid_content", "registry layer size header does not match its descriptor");
      }
      const headerDigest = response.headers.get("docker-content-digest");
      if (headerDigest !== null && headerDigest !== descriptor.digest) {
        void response.body?.cancel().catch(() => undefined);
        throw new RegistryError("invalid_content", "registry layer digest header does not match its descriptor");
      }
      const encoding = response.headers.get("content-encoding");
      if (encoding !== null && encoding.toLowerCase() !== "identity") {
        void response.body?.cancel().catch(() => undefined);
        throw new RegistryError("invalid_content", "registry layer used an unexpected HTTP content encoding");
      }
      if (response.body === null) {
        if (descriptor.size !== 0 || descriptor.digest !== "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855") {
          throw new RegistryError("invalid_content", "registry layer body is missing");
        }
        return;
      }

      const reader = response.body.getReader();
      const hash = createHash("sha256");
      let total = 0;
      let rejectAborted: ((error: Error) => void) | undefined;
      const aborted = new Promise<never>((_, reject) => { rejectAborted = reject; });
      void aborted.catch(() => undefined);
      const onAbort = () => {
        void reader.cancel().catch(() => undefined);
        rejectAborted?.(new Error("layer body read aborted"));
      };
      requestSignal.addEventListener("abort", onAbort, { once: true });
      if (requestSignal.aborted) onAbort();
      try {
        while (true) {
          const read = reader.read();
          const { done, value } = await Promise.race([read, aborted]);
          if (done) break;
          total += value.byteLength;
          if (!Number.isSafeInteger(total) || total > descriptor.size) {
            void reader.cancel().catch(() => undefined);
            throw new RegistryError("invalid_content", "registry layer bytes exceed the manifest descriptor size");
          }
          hash.update(value);
        }
      } catch (error) {
        if (requestSignal.aborted) throw new RegistryError("unavailable", "registry layer body read was canceled");
        if (error instanceof RegistryError) throw error;
        throw new RegistryError("unavailable", "registry layer body read failed");
      } finally {
        requestSignal.removeEventListener("abort", onAbort);
        try { reader.releaseLock(); } catch { /* an aborted stream can still have a pending read */ }
      }
      if (total !== descriptor.size) {
        throw new RegistryError("invalid_content", "registry layer byte count does not match its descriptor");
      }
      if (`sha256:${hash.digest("hex")}` !== descriptor.digest) {
        throw new RegistryError("invalid_content", "registry layer bytes do not match their digest");
      }
    });
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
