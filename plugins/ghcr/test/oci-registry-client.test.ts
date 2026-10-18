import { beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Digest } from "../src/digest.js";
import { GhcrRegistryClient, RegistryError } from "../src/oci-registry-client.js";

const encoder = new TextEncoder();
const repository = "praetorium/derived";
const imageLimits = {
  maxImageLayerBytes: 1024 * 1024,
  maxImageVerificationMs: 5_000,
  maxRegistryRequestMs: 1_000,
};

it("retains the global receiver for the platform fetch default", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function (this: unknown) {
    if (this !== globalThis) throw new TypeError("Illegal invocation");
    return Promise.resolve(new Response(null, { status: 404 }));
  } as typeof fetch;
  try {
    const client = new GhcrRegistryClient({
      registryUrl: "https://registry.example",
      allowedRepositories: [repository],
      ...imageLimits,
    });
    await expect(client.discoverTag(repository, "missing")).rejects.toMatchObject({ reason: "not_found" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

async function digestOf(bytes: Uint8Array): Promise<string> {
  return sha256Digest(bytes);
}

async function metadataArtifactFixture(payload: Uint8Array) {
  const payloadDigest = await digestOf(payload);
  const emptyConfig = encoder.encode("{}");
  const emptyConfigDigest = await digestOf(emptyConfig);
  const tag = `metadata-sha256-${payloadDigest.slice("sha256:".length)}`;
  const manifest = encoder.encode(JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    artifactType: "application/vnd.praetorium.metadata.v1+json",
    config: {
      mediaType: "application/vnd.oci.empty.v1+json",
      digest: emptyConfigDigest,
      size: emptyConfig.byteLength,
    },
    layers: [{
      mediaType: "application/vnd.praetorium.metadata.v1+json",
      digest: payloadDigest,
      size: payload.byteLength,
    }],
  }));
  return { payloadDigest, emptyConfig, emptyConfigDigest, tag, manifest, manifestDigest: await digestOf(manifest) };
}

interface ImageFixture {
  readonly rootBytes: Uint8Array;
  readonly rootDigest: string;
  readonly childBytes: Uint8Array;
  readonly childDigest: string;
  readonly configBytes: Uint8Array;
  readonly configDigest: string;
  readonly layerBytes: Uint8Array;
  readonly layerDigest: string;
  readonly layerSize: number;
}

async function imageFixture(options: {
  readonly configArchitecture?: string;
  readonly configVariant?: string;
  readonly indexArchitecture?: string;
  readonly indexVariant?: string;
  readonly layerOverrides?: Record<string, unknown>;
} = {}): Promise<ImageFixture> {
  const configBytes = encoder.encode(JSON.stringify({
    os: "linux",
    architecture: options.configArchitecture ?? "amd64",
    ...(options.configVariant === undefined ? {} : { variant: options.configVariant }),
  }));
  const configDigest = await digestOf(configBytes);
  const layerBytes = encoder.encode("opaque layer content");
  const layerDigest = await digestOf(layerBytes);
  const childBytes = encoder.encode(JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: configDigest, size: configBytes.byteLength },
    layers: [{ mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", digest: layerDigest, size: layerBytes.byteLength, ...options.layerOverrides }],
  }));
  const childDigest = await digestOf(childBytes);
  const rootBytes = encoder.encode(JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [{
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      digest: childDigest,
      size: childBytes.byteLength,
      platform: {
        os: "linux",
        architecture: options.indexArchitecture ?? "amd64",
        ...(options.indexVariant === undefined ? {} : { variant: options.indexVariant }),
      },
    }],
  }));
  return {
    rootBytes,
    rootDigest: await digestOf(rootBytes),
    childBytes,
    childDigest,
    configBytes,
    configDigest,
    layerBytes,
    layerDigest,
    layerSize: layerBytes.byteLength,
  };
}

function jsonResponse(bytes: Uint8Array, mediaType: string, digest?: string): Response {
  return new Response(bytes, {
    status: 200,
    headers: {
      "content-type": mediaType,
      "content-length": String(bytes.byteLength),
      ...(digest === undefined ? {} : { "docker-content-digest": digest }),
    },
  });
}

function imageFetch(fixture: ImageFixture, options: {
  readonly missingLayer?: boolean;
  readonly omitLayerHeaders?: boolean;
  readonly alteredLayer?: Uint8Array;
  readonly alteredConfig?: Uint8Array;
  readonly missingConfig?: boolean;
  readonly alteredChild?: Uint8Array;
  readonly record?: (url: URL, init?: RequestInit) => void;
} = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    options.record?.(url, init);
    if (url.pathname === "/token") return new Response(JSON.stringify({ token: "scoped-test-token" }));
    if (url.pathname.includes("/manifests/")) {
      const reference = decodeURIComponent(url.pathname.split("/").at(-1)!);
      if (reference === fixture.rootDigest) {
        return jsonResponse(fixture.rootBytes, "application/vnd.oci.image.index.v1+json", fixture.rootDigest);
      }
      if (reference === fixture.childDigest) {
        const bytes = options.alteredChild ?? fixture.childBytes;
        return jsonResponse(bytes, "application/vnd.oci.image.manifest.v1+json", await digestOf(bytes));
      }
      return new Response(null, { status: 404 });
    }
    if (decodeURIComponent(url.pathname).endsWith(`/blobs/${fixture.configDigest}`)) {
      if (options.missingConfig) return new Response(null, { status: 404 });
      return jsonResponse(options.alteredConfig ?? fixture.configBytes, "application/vnd.oci.image.config.v1+json", fixture.configDigest);
    }
    if (decodeURIComponent(url.pathname).endsWith(`/blobs/${fixture.layerDigest}`)) {
      if (options.missingLayer) return new Response(null, { status: 404 });
      const bytes = options.alteredLayer ?? fixture.layerBytes;
      return new Response(bytes, {
        status: 200,
        headers: options.omitLayerHeaders ? {} : {
          "content-length": String(bytes.byteLength),
          "docker-content-digest": fixture.layerDigest,
        },
      });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
}

describe("GHCR OCI registry adapter", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("resolves a mutable tag to the digest of the exact returned manifest bytes", async () => {
    const first = await imageFixture();
    const secondBytes = encoder.encode(JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests: [] }));
    let tagBytes = first.rootBytes;
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/token") return new Response(JSON.stringify({ token: "token" }));
      if (url.pathname.endsWith("/manifests/stable")) {
        return jsonResponse(tagBytes, "application/vnd.oci.image.index.v1+json");
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    const client = new GhcrRegistryClient({ ...imageLimits, allowedRepositories: [repository], fetch: fetcher });

    const initial = await client.discoverTag(repository, "stable");
    tagBytes = secondBytes;
    const moved = await client.discoverTag(repository, "stable");

    expect(initial.digest).toBe(first.rootDigest);
    expect(moved.digest).toBe(await digestOf(secondBytes));
    expect(moved.digest).not.toBe(initial.digest);
  });

  it("verifies the index, selected child, config platform, and layer descriptors", async () => {
    const fixture = await imageFixture();
    const client = new GhcrRegistryClient({
      ...imageLimits,
      allowedRepositories: [repository],
      fetch: imageFetch(fixture),
    });

    const image = await client.verifyImage(repository, fixture.rootDigest, { os: "linux", architecture: "amd64" });

    expect(image.manifestDigest).toBe(fixture.rootDigest);
    expect(image.platformManifestDigest).toBe(fixture.childDigest);
    expect(image.platform).toEqual({ os: "linux", architecture: "amd64" });
    expect(image.layerDescriptors).toHaveLength(1);
    expect(image.reachableLayerBytes).toBe(fixture.layerSize);
  });

  it("uses manual redirect handling for every registry request", async () => {
    const fixture = await imageFixture();
    const redirects: Array<RequestRedirect | undefined> = [];
    const client = new GhcrRegistryClient({
      ...imageLimits,
      allowedRepositories: [repository],
      fetch: imageFetch(fixture, { record: (_url, init) => redirects.push(init?.redirect) }),
    });

    await client.verifyImage(repository, fixture.rootDigest, { os: "linux", architecture: "amd64" });

    expect(redirects).toEqual(["manual", "manual", "manual", "manual"]);
  });

  it("rejects a credentialed token-service redirect without following its target", async () => {
    const redirectTarget = "https://redirect-attacker.example/collect";
    const requests: Array<{ url: URL; redirect: RequestRedirect | undefined; authorization: string | null }> = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: new URL(input instanceof Request ? input.url : String(input)),
        redirect: init?.redirect,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return new Response("untrusted redirect body", {
        status: 302,
        headers: { location: redirectTarget },
      });
    }) as typeof fetch;
    const client = new GhcrRegistryClient({
      ...imageLimits,
      registryUrl: "http://127.0.0.1:5000",
      allowInsecureLoopback: true,
      allowedRepositories: [repository],
      pullCredential: { username: "runtime-reader", password: "read-secret" },
      fetch: fetcher,
    });

    const error = await client.discoverTag(repository, "stable").catch((reason: unknown) => reason);

    expect(error).toMatchObject({ reason: "unavailable" });
    expect(error).toBeInstanceOf(RegistryError);
    expect((error as Error).message).not.toContain(redirectTarget);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: expect.objectContaining({ pathname: "/token" }),
      redirect: "manual",
      authorization: `Basic ${btoa("runtime-reader:read-secret")}`,
    });
  });

  it.each([false, true])(
    "verifies official GHCR CDN bytes without forwarding auth (tampered=%s)",
    async (tampered) => {
      const fixture = await imageFixture();
      const alteredConfig = fixture.configBytes.slice();
      alteredConfig[0] = alteredConfig[0]! ^ 0xff;
      const serve = imageFetch(fixture, tampered ? { alteredConfig } : {});
      const cdnRequests: Array<{
        authorization: string | null;
        cookie: string | null;
        redirect: RequestRedirect | undefined;
        credentials: RequestCredentials | undefined;
      }> = [];
      const client = new GhcrRegistryClient({
        ...imageLimits,
        allowedRepositories: [repository],
        pullCredential: { username: "reader", password: "read-secret" },
        fetch: (async (input, init) => {
          const url = new URL(String(input));
          if (url.hostname === "ghcr.io" && url.pathname.includes("/blobs/")) {
            expect(new Headers(init?.headers).get("authorization")).toBe(
              "Bearer scoped-test-token",
            );
            return new Response(null, {
              status: 307,
              headers: {
                location: `https://pkg-containers.githubusercontent.com${url.pathname}?signed=opaque`,
              },
            });
          }
          if (url.hostname === "pkg-containers.githubusercontent.com") {
            const headers = new Headers(init?.headers);
            cdnRequests.push({
              authorization: headers.get("authorization"),
              cookie: headers.get("cookie"),
              redirect: init?.redirect,
              credentials: init?.credentials,
            });
          }
          return serve(input, init);
        }) as typeof fetch,
      });
      const result = client.verifyImage(repository, fixture.rootDigest, {
        os: "linux",
        architecture: "amd64",
      });
      if (tampered) await expect(result).rejects.toMatchObject({ reason: "invalid_content" });
      else expect((await result).manifestDigest).toBe(fixture.rootDigest);
      expect(cdnRequests).toEqual([
        { authorization: null, cookie: null, redirect: "manual", credentials: "omit" },
      ]);
    },
  );

  it.each([
    "https://attacker.example/blob",
    "https://pkg-containers.githubusercontent.com.attacker.example/blob",
    "http://pkg-containers.githubusercontent.com/blob",
    "https://pkg-containers.githubusercontent.com:8443/blob",
    "https://reader:password@pkg-containers.githubusercontent.com/blob",
    "https://pkg-containers.githubusercontent.com/blob#fragment",
    "/relative/blob",
  ])("rejects an unapproved blob redirect without contacting it: %s", async (target) => {
    const fixture = await imageFixture();
    const serve = imageFetch(fixture);
    const requests: string[] = [];
    const client = new GhcrRegistryClient({
      ...imageLimits,
      allowedRepositories: [repository],
      fetch: (async (input, init) => {
        const url = new URL(String(input));
        requests.push(url.hostname);
        if (url.pathname.includes("/blobs/"))
          return new Response(null, { status: 307, headers: { location: target } });
        return serve(input, init);
      }) as typeof fetch,
    });
    const error = await client
      .verifyImage(repository, fixture.rootDigest, { os: "linux", architecture: "amd64" })
      .catch((reason: unknown) => reason);
    expect(error).toMatchObject({ reason: "unavailable" });
    expect(String(error)).not.toContain(target);
    expect(requests.every((host) => host === "ghcr.io")).toBe(true);
  });

  it("rejects child bytes that do not match the index descriptor digest", async () => {
    const fixture = await imageFixture();
    const alteredChild = encoder.encode(JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: fixture.configDigest, size: fixture.configBytes.byteLength },
      layers: [],
    }));
    const client = new GhcrRegistryClient({
      ...imageLimits,
      allowedRepositories: [repository],
      fetch: imageFetch(fixture, { alteredChild }),
    });

    await expect(client.verifyImage(repository, fixture.rootDigest, { os: "linux", architecture: "amd64" }))
      .rejects.toMatchObject({ reason: "invalid_content" });
  });

  it("rejects a config whose actual platform differs from the selected index descriptor", async () => {
    const fixture = await imageFixture({ configArchitecture: "arm64" });
    const client = new GhcrRegistryClient({ ...imageLimits, allowedRepositories: [repository], fetch: imageFetch(fixture) });

    await expect(client.verifyImage(repository, fixture.rootDigest, { os: "linux", architecture: "amd64" }))
      .rejects.toMatchObject({ reason: "invalid_content" });
  });

  it("accepts the single OCI platform variant for the contracted OS/architecture target", async () => {
    const fixture = await imageFixture({
      configArchitecture: "arm64",
      configVariant: "v8",
      indexArchitecture: "arm64",
      indexVariant: "v8",
    });
    const client = new GhcrRegistryClient({ ...imageLimits, allowedRepositories: [repository], fetch: imageFetch(fixture) });

    const image = await client.verifyImage(repository, fixture.rootDigest, { os: "linux", architecture: "arm64" });

    expect(image.platform).toEqual({ os: "linux", architecture: "arm64", variant: "v8" });
  });

  it("validates descriptors without requesting layer bodies", async () => {
    const fixture = await imageFixture();
    const paths: string[] = [];
    const client = new GhcrRegistryClient({
      ...imageLimits,
      allowedRepositories: [repository],
      fetch: imageFetch(fixture, { missingLayer: true, record: (url) => paths.push(decodeURIComponent(url.pathname)) }),
    });
    await expect(client.verifyImage(repository, fixture.rootDigest, { os: "linux", architecture: "amd64" }))
      .resolves.toMatchObject({ reachableLayerBytes: fixture.layerSize });
    expect(paths).toEqual([
      "/token",
      `/v2/${repository}/manifests/${fixture.rootDigest}`,
      `/v2/${repository}/manifests/${fixture.childDigest}`,
      `/v2/${repository}/blobs/${fixture.configDigest}`,
    ]);
  });

  it.each([
    { digest: undefined }, { digest: "sha256:invalid" },
    { size: undefined }, { size: -1 }, { size: 1.5 }, { size: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects malformed layer descriptors: %j", async (layerOverrides) => {
    const fixture = await imageFixture({ layerOverrides });
    const client = new GhcrRegistryClient({ ...imageLimits, allowedRepositories: [repository], fetch: imageFetch(fixture) });
    await expect(client.verifyImage(repository, fixture.rootDigest, { os: "linux", architecture: "amd64" }))
      .rejects.toMatchObject({ reason: "invalid_content" });
  });

  it("rejects missing Config blobs", async () => {
    const fixture = await imageFixture();
    const client = new GhcrRegistryClient({ ...imageLimits, allowedRepositories: [repository], fetch: imageFetch(fixture, { missingConfig: true }) });
    await expect(client.verifyImage(repository, fixture.rootDigest, { os: "linux", architecture: "amd64" }))
      .rejects.toMatchObject({ reason: "not_found" });
  });

  it("rejects Config blobs with mismatched bytes or size", async () => {
    const fixture = await imageFixture();
    for (const alteredConfig of [new Uint8Array(fixture.configBytes.length), new Uint8Array(fixture.configBytes.length + 1)]) {
      const client = new GhcrRegistryClient({ ...imageLimits, allowedRepositories: [repository], fetch: imageFetch(fixture, { alteredConfig }) });
      await expect(client.verifyImage(repository, fixture.rootDigest, { os: "linux", architecture: "amd64" }))
        .rejects.toMatchObject({ reason: "invalid_content" });
    }
  });

  it("rejects an image before layer download when the aggregate byte cap is too small", async () => {
    const fixture = await imageFixture();
    let layerRequested = false;
    const client = new GhcrRegistryClient({
      ...imageLimits,
      maxImageLayerBytes: fixture.layerSize - 1,
      allowedRepositories: [repository],
      fetch: imageFetch(fixture, { record: (url) => {
        if (url.pathname.endsWith(`/blobs/${fixture.layerDigest}`)) layerRequested = true;
      } }),
    });

    await expect(client.verifyImage(repository, fixture.rootDigest, { os: "linux", architecture: "amd64" }))
      .rejects.toMatchObject({ reason: "invalid_content" });
    expect(layerRequested).toBe(false);
  });

  it("times out a registry request that never returns response headers", async () => {
    const fetcher = (async (input: RequestInfo | URL) => {
      if (new URL(input instanceof Request ? input.url : String(input)).pathname === "/token") {
        return new Response(JSON.stringify({ token: "token" }));
      }
      return new Promise<Response>(() => undefined);
    }) as typeof fetch;
    const client = new GhcrRegistryClient({
      ...imageLimits,
      maxRegistryRequestMs: 20,
      allowedRepositories: [repository],
      fetch: fetcher,
    });

    await expect(client.discoverTag(repository, "stable")).rejects.toMatchObject({ reason: "unavailable" });
  });

  it("bounds manifest body reads and the full image verification operation", async () => {
    const fixture = await imageFixture();
    const stalledBody = new ReadableStream<Uint8Array>({
      pull() { return new Promise<void>(() => undefined); },
      cancel() { return undefined; },
    });
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/token") return new Response(JSON.stringify({ token: "token" }));
      if (decodeURIComponent(url.pathname).endsWith(`/manifests/${fixture.rootDigest}`)) {
        return new Response(stalledBody, {
          headers: {
            "content-type": "application/vnd.oci.image.index.v1+json",
            "content-length": String(fixture.rootBytes.byteLength),
          },
        });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    const client = new GhcrRegistryClient({
      ...imageLimits,
      maxImageVerificationMs: 20,
      maxRegistryRequestMs: 1_000,
      allowedRepositories: [repository],
      fetch: fetcher,
    });

    await expect(client.verifyImage(repository, fixture.rootDigest, { os: "linux", architecture: "amd64" }))
      .rejects.toMatchObject({ reason: "unavailable" });
  });

  it("propagates an operator cancellation to an in-flight registry request", async () => {
    let requestSignal: AbortSignal | null = null;
    const fetcher = ((_: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal as AbortSignal;
      return new Promise<Response>(() => undefined);
    }) as typeof fetch;
    const client = new GhcrRegistryClient({
      ...imageLimits,
      maxRegistryRequestMs: 1_000,
      allowedRepositories: [repository],
      fetch: fetcher,
    });
    const controller = new AbortController();
    const request = client.discoverTag(repository, "stable", controller.signal);
    setTimeout(() => controller.abort(), 10);

    await expect(request).rejects.toMatchObject({ reason: "unavailable" });
    expect(requestSignal?.aborted).toBe(true);
  });

  it("cancels manifest streams that exceed the hard byte limit without Content-Length", async () => {
    const fixture = await imageFixture();
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4 * 1024 * 1024));
        controller.enqueue(new Uint8Array(4 * 1024 * 1024));
      },
    });
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/token") return new Response(JSON.stringify({ token: "token" }));
      if (decodeURIComponent(url.pathname).endsWith(`/manifests/${fixture.rootDigest}`)) {
        return new Response(oversized, { headers: { "content-type": "application/vnd.oci.image.index.v1+json" } });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    const client = new GhcrRegistryClient({ ...imageLimits, allowedRepositories: [repository], fetch: fetcher });

    await expect(client.verifyImage(repository, fixture.rootDigest, { os: "linux", architecture: "amd64" }))
      .rejects.toMatchObject({ reason: "invalid_content" });
  });

  it("keeps pull and publish credentials separate and scopes publishing to derived repositories", async () => {
    const seen: Array<{ scope: string | null; authorization: string | null }> = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      seen.push({ scope: url.searchParams.get("scope"), authorization: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ token: `token-${seen.length}` }));
    }) as typeof fetch;
    const client = new GhcrRegistryClient({
      ...imageLimits,
      allowedRepositories: [repository, "praetorium/runtime-base"],
      publishRepositories: [repository],
      pullCredential: { username: "runtime-reader", password: "read-secret" },
      publishCredential: { username: "build-publisher", password: "push-secret" },
      fetch: fetcher,
    });

    const pull = await client.issuePullAuth("praetorium/runtime-base");
    const publish = await client.issuePublishAuth(repository);

    expect(pull.actions).toEqual(["pull"]);
    expect(publish.actions).toEqual(["pull", "push"]);
    expect(seen[0]?.scope).toBe("repository:praetorium/runtime-base:pull");
    expect(seen[0]?.authorization).toBe(`Basic ${btoa("runtime-reader:read-secret")}`);
    expect(seen[1]?.scope).toBe("repository:praetorium/derived:pull,push");
    expect(seen[1]?.authorization).toBe(`Basic ${btoa("build-publisher:push-secret")}`);
    await expect(client.issuePublishAuth("praetorium/runtime-base")).rejects.toBeInstanceOf(RegistryError);
  });

  it("publishes exact composition bytes under a deterministic metadata artifact manifest", async () => {
    const bytes = encoder.encode('{"schemaVersion":"scriptorium-composition/v1"}\n');
    const artifact = await metadataArtifactFixture(bytes);
    const blobs = new Map<string, Uint8Array>();
    const manifests = new Map<string, { bytes: Uint8Array; digest: string }>();
    const seen: Array<{ method: string; path: string; authorization: string | null; body?: Uint8Array }> = [];
    let uploadCount = 0;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? "GET";
      if (url.pathname === "/token") return new Response(JSON.stringify({ token: "test-token" }));

      const manifestPrefix = `/v2/${repository}/manifests/`;
      if (url.pathname.startsWith(manifestPrefix) && method === "GET") {
        const tag = decodeURIComponent(url.pathname.slice(manifestPrefix.length));
        const manifest = manifests.get(tag);
        seen.push({ method, path: url.pathname, authorization: new Headers(init?.headers).get("authorization") });
        return manifest === undefined
          ? new Response(null, { status: 404 })
          : new Response(manifest.bytes, {
            headers: {
              "content-type": "application/vnd.oci.image.manifest.v1+json",
              "docker-content-digest": manifest.digest,
            },
          });
      }
      if (url.pathname.startsWith(manifestPrefix) && method === "PUT") {
        const tag = decodeURIComponent(url.pathname.slice(manifestPrefix.length));
        const body = new Uint8Array(await new Response(init?.body).arrayBuffer());
        const digest = await digestOf(body);
        manifests.set(tag, { bytes: body, digest });
        seen.push({ method, path: url.pathname, authorization: new Headers(init?.headers).get("authorization"), body });
        return new Response(null, { status: 201, headers: { "docker-content-digest": digest } });
      }

      const blobPrefix = `/v2/${repository}/blobs/`;
      if (url.pathname.startsWith(blobPrefix) && method === "POST") {
        const form = uploadCount++ === 0 ? "upload" : "uploads";
        const id = `owned-session-${uploadCount}`;
        seen.push({ method, path: url.pathname, authorization: new Headers(init?.headers).get("authorization") });
        return new Response(null, {
          status: 202,
          headers: { location: `/v2/${repository}/blobs/${form}/${id}?state=owned%2Bstate&part=first` },
        });
      }
      if (url.pathname.includes("/blobs/upload") && method === "PUT") {
        const digest = url.searchParams.get("digest");
        if (digest === null) throw new Error("blob upload omitted its digest query");
        const body = new Uint8Array(await new Response(init?.body).arrayBuffer());
        blobs.set(digest, body);
        seen.push({ method, path: url.pathname + url.search, authorization: new Headers(init?.headers).get("authorization"), body });
        return new Response(null, { status: 201, headers: { "docker-content-digest": digest } });
      }
      if (url.pathname.startsWith(blobPrefix) && (method === "HEAD" || method === "GET")) {
        const digest = decodeURIComponent(url.pathname.slice(blobPrefix.length));
        const blob = blobs.get(digest);
        seen.push({ method, path: url.pathname, authorization: new Headers(init?.headers).get("authorization") });
        if (blob === undefined) return new Response(null, { status: 404 });
        return method === "HEAD"
          ? new Response(null, { status: 200, headers: { "docker-content-digest": digest } })
          : new Response(blob, {
            headers: {
              "content-type": "application/vnd.praetorium.metadata.v1+json",
              "docker-content-digest": digest,
            },
          });
      }
      throw new Error("unexpected registry method: " + method);
    }) as typeof fetch;
    const client = new GhcrRegistryClient({
      ...imageLimits,
      registryUrl: "https://127.0.0.1:35009",
      allowAnonymousLoopbackPublish: true,
      allowedRepositories: [repository, "praetorium/runtime-base"],
      publishRepositories: [repository],
      pullCredential: { username: "runtime-reader", password: "read-secret" },
      fetch: fetcher,
    });

    await expect(client.issuePublishAuth(repository)).resolves.toEqual({
      registry: "127.0.0.1:35009",
      repository,
      actions: ["pull", "push"],
      token: "",
    });
    await expect(client.publishBlob(repository, bytes)).resolves.toBe(artifact.payloadDigest);
    const stored = await client.readBlob(repository, artifact.payloadDigest);
    expect(stored.bytes).toEqual(bytes);
    await expect(client.publishBlob(repository, bytes)).resolves.toBe(artifact.payloadDigest);
    const requestCount = seen.length;
    await expect(client.publishBlob("praetorium/runtime-base", bytes)).rejects.toMatchObject({ reason: "unauthorized" });
    await expect(client.issuePublishAuth("praetorium/runtime-base")).rejects.toMatchObject({ reason: "unauthorized" });
    expect(seen).toHaveLength(requestCount);

    const blobUploads = seen.filter(({ method, path }) => method === "PUT" && path.includes("/blobs/upload"));
    expect(blobUploads).toHaveLength(2);
    expect(blobUploads.map(({ body }) => body)).toEqual([bytes, artifact.emptyConfig]);
    const payloadUploadUrl = new URL(blobUploads[0]!.path, "https://127.0.0.1:35009");
    expect(payloadUploadUrl.pathname).toBe(`/v2/${repository}/blobs/upload/owned-session-1`);
    expect(payloadUploadUrl.searchParams.get("state")).toBe("owned+state");
    expect(payloadUploadUrl.searchParams.get("part")).toBe("first");
    expect(payloadUploadUrl.searchParams.get("digest")).toBe(artifact.payloadDigest);
    expect(new URL(blobUploads[1]!.path, "https://127.0.0.1:35009").pathname)
      .toBe(`/v2/${repository}/blobs/uploads/owned-session-2`);

    const manifestUploads = seen.filter(({ method, path }) => method === "PUT" && path.includes("/manifests/"));
    expect(manifestUploads).toHaveLength(1);
    expect(manifestUploads[0]?.path).toBe(`/v2/${repository}/manifests/${artifact.tag}`);
    expect(manifestUploads[0]?.body).toEqual(artifact.manifest);
    expect(manifestUploads[0]?.authorization).toBeNull();
    expect(seen.every(({ authorization }) => authorization === null || authorization === "Bearer test-token")).toBe(true);
  });

  it("anchors a pre-existing orphan metadata blob for pull and refuses a conflicting deterministic tag", async () => {
    const bytes = encoder.encode('{"schemaVersion":"scriptorium-composition/v1"}\n');
    const artifact = await metadataArtifactFixture(bytes);
    let storedArtifact: { bytes: Uint8Array; digest: string } | undefined;
    let artifactUploadCount = 0;
    let blobUploadCount = 0;
    const seen: Array<{ method: string; path: string }> = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? "GET";
      if (url.pathname === "/token") return new Response(JSON.stringify({ token: "test-token" }));

      const manifestPrefix = `/v2/${repository}/manifests/`;
      if (url.pathname.startsWith(manifestPrefix) && method === "GET") {
        const tag = decodeURIComponent(url.pathname.slice(manifestPrefix.length));
        if (tag !== artifact.tag) throw new Error("unexpected metadata artifact tag");
        seen.push({ method, path: url.pathname });
        return storedArtifact === undefined
          ? new Response(null, { status: 404 })
          : new Response(storedArtifact.bytes, {
            headers: {
              "content-type": "application/vnd.oci.image.manifest.v1+json",
              "docker-content-digest": storedArtifact.digest,
            },
          });
      }
      if (url.pathname.startsWith(manifestPrefix) && method === "PUT") {
        const body = new Uint8Array(await new Response(init?.body).arrayBuffer());
        const digest = await digestOf(body);
        storedArtifact = { bytes: body, digest };
        artifactUploadCount += 1;
        seen.push({ method, path: url.pathname });
        return new Response(null, { status: 201, headers: { "docker-content-digest": digest } });
      }

      const blobPrefix = `/v2/${repository}/blobs/`;
      if (url.pathname.startsWith(blobPrefix) && method === "HEAD") {
        const digest = decodeURIComponent(url.pathname.slice(blobPrefix.length));
        seen.push({ method, path: url.pathname });
        const exists = digest === artifact.payloadDigest || digest === artifact.emptyConfigDigest;
        return new Response(null, {
          status: exists ? 200 : 404,
          headers: exists ? { "docker-content-digest": digest } : undefined,
        });
      }
      if (url.pathname === `/v2/${repository}/blobs/${encodeURIComponent(artifact.payloadDigest)}` && method === "GET") {
        seen.push({ method, path: url.pathname });
        return storedArtifact === undefined
          ? new Response(JSON.stringify({ errors: [{ code: "BLOB_UNKNOWN" }] }), { status: 404 })
          : new Response(bytes, {
            headers: {
              "content-type": "application/vnd.praetorium.metadata.v1+json",
              "docker-content-digest": artifact.payloadDigest,
            },
          });
      }
      if (method === "POST" || (method === "PUT" && url.pathname.includes("/blobs/"))) {
        blobUploadCount += 1;
      }
      throw new Error("unexpected registry method: " + method);
    }) as typeof fetch;
    const client = new GhcrRegistryClient({
      ...imageLimits,
      registryUrl: "https://registry.example.test",
      allowedRepositories: [repository],
      publishRepositories: [repository],
      pullCredential: { username: "runtime-reader", password: "read-secret" },
      publishCredential: { username: "build-publisher", password: "push-secret" },
      fetch: fetcher,
    });

    await expect(client.readBlob(repository, artifact.payloadDigest)).rejects.toMatchObject({ reason: "not_found" });
    await expect(client.publishBlob(repository, bytes)).resolves.toBe(artifact.payloadDigest);
    const stored = await client.readBlob(repository, artifact.payloadDigest);
    expect(stored.bytes).toEqual(bytes);
    expect(storedArtifact?.bytes).toEqual(artifact.manifest);
    expect(storedArtifact?.digest).toBe(artifact.manifestDigest);
    expect(artifactUploadCount).toBe(1);
    expect(blobUploadCount).toBe(0);

    const conflictingManifest = encoder.encode(JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      artifactType: "application/vnd.praetorium.other-metadata.v1+json",
      config: { mediaType: "application/vnd.oci.empty.v1+json", digest: artifact.emptyConfigDigest, size: 2 },
      layers: [],
    }));
    storedArtifact = { bytes: conflictingManifest, digest: await digestOf(conflictingManifest) };
    await expect(client.publishBlob(repository, bytes)).rejects.toMatchObject({ reason: "invalid_content" });
    expect(artifactUploadCount).toBe(1);
    expect(blobUploadCount).toBe(0);
    expect(seen.filter(({ method, path }) => method === "GET" && path.includes("/blobs/")).length).toBe(2);
  });

  it("requires explicit anonymous loopback publication opt-in", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new GhcrRegistryClient({
      ...imageLimits,
      registryUrl: "https://127.0.0.1:35009",
      allowedRepositories: [repository],
      publishRepositories: [repository],
      fetch: fetcher,
    });

    await expect(client.publishBlob(repository, encoder.encode("metadata")))
      .rejects.toMatchObject({ reason: "unauthorized" });
    await expect(client.issuePublishAuth(repository)).rejects.toMatchObject({ reason: "unauthorized" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects anonymous publication opt-in for a non-loopback registry", () => {
    expect(() => new GhcrRegistryClient({
      ...imageLimits,
      registryUrl: "https://registry.example.test",
      allowAnonymousLoopbackPublish: true,
      allowedRepositories: [repository],
      publishRepositories: [repository],
    })).toThrow(/loopback hosts/u);
  });

  it("requires an explicit publish repository allowlist for anonymous loopback publication", () => {
    expect(() => new GhcrRegistryClient({
      ...imageLimits,
      registryUrl: "https://127.0.0.1:35009",
      allowAnonymousLoopbackPublish: true,
      allowedRepositories: [repository],
    })).toThrow(/derived-output repository allowlist/u);
  });

  it("rejects encoded or cross-repository upload locations before sending composition bytes", async () => {
    const bytes = encoder.encode('{"schemaVersion":"scriptorium-composition/v1"}');
    let puts = 0;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      if (init?.method === "HEAD") return new Response(null, { status: 404 });
      if (init?.method === "POST") {
        return new Response(null, {
          status: 202,
          headers: { location: "/v2/" + repository + "/blobs/uploads/%2e%2e%2fother" },
        });
      }
      if (init?.method === "PUT") puts += 1;
      throw new Error("unexpected registry method: " + (init?.method ?? "GET"));
    }) as typeof fetch;
    const client = new GhcrRegistryClient({
      ...imageLimits,
      registryUrl: "https://127.0.0.1:35009",
      allowAnonymousLoopbackPublish: true,
      allowedRepositories: [repository],
      publishRepositories: [repository],
      fetch: fetcher,
    });

    await expect(client.publishBlob(repository, bytes)).rejects.toMatchObject({ reason: "invalid_content" });
    expect(puts).toBe(0);
  });

  it.each([
    ["unrelated repository", `https://127.0.0.1:35009/v2/praetorium/unrelated/blobs/upload/session`],
    ["external origin", `https://registry-attacker.example.test/v2/${repository}/blobs/upload/session`],
  ])("rejects a %s upload location before sending composition bytes", async (_label, location) => {
    const bytes = encoder.encode('{"schemaVersion":"scriptorium-composition/v1"}');
    let puts = 0;
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "HEAD") return new Response(null, { status: 404 });
      if (init?.method === "POST") {
        return new Response(null, { status: 202, headers: { location } });
      }
      if (init?.method === "PUT") puts += 1;
      throw new Error("unexpected registry method: " + (init?.method ?? "GET"));
    }) as typeof fetch;
    const client = new GhcrRegistryClient({
      ...imageLimits,
      registryUrl: "https://127.0.0.1:35009",
      allowAnonymousLoopbackPublish: true,
      allowedRepositories: [repository],
      publishRepositories: [repository],
      fetch: fetcher,
    });

    await expect(client.publishBlob(repository, bytes)).rejects.toMatchObject({ reason: "invalid_content" });
    expect(puts).toBe(0);
  });

  it("rejects an unallowlisted repository before network access", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new GhcrRegistryClient({ ...imageLimits, allowedRepositories: [], fetch: fetcher });

    await expect(client.discoverTag(repository, "stable")).rejects.toMatchObject({ reason: "not_found" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
