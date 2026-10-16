import { beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Digest } from "../src/digest.js";
import { GhcrRegistryClient, RegistryError } from "../src/oci-registry-client.js";

const encoder = new TextEncoder();
const repository = "praetorium/derived";

async function digestOf(bytes: Uint8Array): Promise<string> {
  return sha256Digest(bytes);
}

interface ImageFixture {
  readonly rootBytes: Uint8Array;
  readonly rootDigest: string;
  readonly childBytes: Uint8Array;
  readonly childDigest: string;
  readonly configBytes: Uint8Array;
  readonly configDigest: string;
  readonly layerDigest: string;
  readonly layerSize: number;
}

async function imageFixture(options: { readonly configArchitecture?: string } = {}): Promise<ImageFixture> {
  const configBytes = encoder.encode(JSON.stringify({ os: "linux", architecture: options.configArchitecture ?? "amd64" }));
  const configDigest = await digestOf(configBytes);
  const layerBytes = encoder.encode("opaque layer content");
  const layerDigest = await digestOf(layerBytes);
  const childBytes = encoder.encode(JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: configDigest, size: configBytes.byteLength },
    layers: [{ mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", digest: layerDigest, size: layerBytes.byteLength }],
  }));
  const childDigest = await digestOf(childBytes);
  const rootBytes = encoder.encode(JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [{
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      digest: childDigest,
      size: childBytes.byteLength,
      platform: { os: "linux", architecture: "amd64" },
    }],
  }));
  return {
    rootBytes,
    rootDigest: await digestOf(rootBytes),
    childBytes,
    childDigest,
    configBytes,
    configDigest,
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
      return jsonResponse(fixture.configBytes, "application/vnd.oci.image.config.v1+json", fixture.configDigest);
    }
    if (decodeURIComponent(url.pathname).endsWith(`/blobs/${fixture.layerDigest}`)) {
      if (options.missingLayer) return new Response(null, { status: 404 });
      return new Response(null, {
        status: 200,
        headers: options.omitLayerHeaders ? {} : {
          "content-length": String(fixture.layerSize),
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
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/token") return new Response(JSON.stringify({ token: "token" }));
      if (url.pathname.endsWith("/manifests/stable")) {
        return jsonResponse(tagBytes, "application/vnd.oci.image.index.v1+json");
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    const client = new GhcrRegistryClient({ allowedRepositories: [repository], fetch: fetcher });

    const initial = await client.discoverTag(repository, "stable");
    tagBytes = secondBytes;
    const moved = await client.discoverTag(repository, "stable");

    expect(initial.digest).toBe(first.rootDigest);
    expect(moved.digest).toBe(await digestOf(secondBytes));
    expect(moved.digest).not.toBe(initial.digest);
  });

  it("verifies the index, selected child, config platform, and every layer reference", async () => {
    const fixture = await imageFixture();
    const client = new GhcrRegistryClient({
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

  it("rejects child bytes that do not match the index descriptor digest", async () => {
    const fixture = await imageFixture();
    const alteredChild = encoder.encode(JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: fixture.configDigest, size: fixture.configBytes.byteLength },
      layers: [],
    }));
    const client = new GhcrRegistryClient({
      allowedRepositories: [repository],
      fetch: imageFetch(fixture, { alteredChild }),
    });

    await expect(client.verifyImage(repository, fixture.rootDigest, { os: "linux", architecture: "amd64" }))
      .rejects.toMatchObject({ reason: "invalid_content" });
  });

  it("rejects a config whose actual platform differs from the selected index descriptor", async () => {
    const fixture = await imageFixture({ configArchitecture: "arm64" });
    const client = new GhcrRegistryClient({ allowedRepositories: [repository], fetch: imageFetch(fixture) });

    await expect(client.verifyImage(repository, fixture.rootDigest, { os: "linux", architecture: "amd64" }))
      .rejects.toMatchObject({ reason: "invalid_content" });
  });

  it("rejects an image when any layer content reference is missing", async () => {
    const fixture = await imageFixture();
    const client = new GhcrRegistryClient({
      allowedRepositories: [repository],
      fetch: imageFetch(fixture, { missingLayer: true }),
    });

    await expect(client.verifyImage(repository, fixture.rootDigest, { os: "linux", architecture: "amd64" }))
      .rejects.toMatchObject({ reason: "not_found" });
  });

  it("rejects a reachable layer whose registry response omits digest and exact size", async () => {
    const fixture = await imageFixture();
    const client = new GhcrRegistryClient({
      allowedRepositories: [repository],
      fetch: imageFetch(fixture, { omitLayerHeaders: true }),
    });

    await expect(client.verifyImage(repository, fixture.rootDigest, { os: "linux", architecture: "amd64" }))
      .rejects.toMatchObject({ reason: "invalid_content" });
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
    const client = new GhcrRegistryClient({ allowedRepositories: [repository], fetch: fetcher });

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

  it("rejects an unallowlisted repository before network access", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new GhcrRegistryClient({ allowedRepositories: [], fetch: fetcher });

    await expect(client.discoverTag(repository, "stable")).rejects.toMatchObject({ reason: "not_found" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
