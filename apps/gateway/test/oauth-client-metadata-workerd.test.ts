import { expect, it } from "vitest";
import { build } from "esbuild";
import { Miniflare, createFetchMock } from "miniflare";

it("resolves CIMD in workerd and rejects redirects without fetching their target", async () => {
  const bundle = await build({
    stdin: {
      contents: `import { fetchMetadataClient } from './src/services/oauth-client-metadata.ts';
        export default { async fetch() {
          return Response.json(await fetchMetadataClient('https://chatgpt.com/oauth/client.json'));
        } };`,
      resolveDir: process.cwd(),
    },
    bundle: true, format: "esm", platform: "browser", target: "es2022", write: false,
  });
  const fetchMock = createFetchMock();
  fetchMock.disableNetConnect();
  const clientId = "https://chatgpt.com/oauth/client.json";
  const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
  const upstream = fetchMock.get("https://chatgpt.com");
  upstream.intercept({ path: "/oauth/client.json" }).reply(200, JSON.stringify({
    client_id: clientId, client_name: "ChatGPT", redirect_uris: [redirectUri],
    token_endpoint_auth_method: "private_key_jwt",
    token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
  }), { headers: { "Content-Type": "application/json" } });
  upstream.intercept({ path: "/oauth/client.json" }).reply(302, "", {
    headers: { Location: "http://127.0.0.1/private", "Content-Type": "application/json" },
  });
  const worker = new Miniflare({
    modules: true, script: bundle.outputFiles[0]!.text,
    compatibilityDate: "2026-07-30", fetchMock,
  });
  try {
    const valid = await worker.dispatchFetch("http://localhost/");
    expect(await valid.json()).toEqual({ clientId, clientName: "ChatGPT", redirectUris: [redirectUri] });
    const redirect = await worker.dispatchFetch("http://localhost/");
    expect(await redirect.json()).toBeNull();
    fetchMock.assertNoPendingInterceptors();
  } finally {
    await worker.dispose();
  }
});
