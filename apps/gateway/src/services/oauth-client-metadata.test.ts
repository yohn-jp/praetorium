import { afterEach, expect, it, vi } from "vitest";
import { fetchMetadataClient } from "./oauth-client-metadata.js";

const CLIENT = "https://chatgpt.com/oauth/client.json";
const CALLBACK = "https://chatgpt.com/connector_platform_oauth_redirect";
const metadata = { client_id: CLIENT, client_name: "ChatGPT", redirect_uris: [CALLBACK],
  token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
  token_endpoint_auth_method: "private_key_jwt" };

afterEach(() => vi.unstubAllGlobals());

it.each([CLIENT, "https://chatgpt.com/oauth/callback-123/client.json"])("resolves reviewed metadata URL %s using public PKCE", async (id) => {
  const fetcher = vi.fn(async () => Response.json({ ...metadata, client_id: id }));
  vi.stubGlobal("fetch", fetcher);
  expect(await fetchMetadataClient(id)).toEqual({ clientId: id, clientName: "ChatGPT", redirectUris: [CALLBACK] });
  expect(fetcher).toHaveBeenCalledWith(id, {
    headers: { Accept: "application/json" }, redirect: "error", signal: expect.any(AbortSignal),
  });
});

it.each([
  "http://chatgpt.com/oauth/client.json", "https://127.0.0.1/oauth/client.json",
  "https://chatgpt.com.attacker.test/oauth/client.json", "https://chatgpt.com@attacker.test/oauth/client.json",
  "https://chatgpt.com/oauth/client.json?target=internal", "https://chatgpt.com/oauth/client.json#fragment",
  "https://chatgpt.com/anything.json", "https://chatgpt.com:444/oauth/client.json",
])("never fetches an unapproved URL %s", async (id) => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  expect(await fetchMetadataClient(id)).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});

it.each([
  { client_id: "https://chatgpt.com/oauth/other/client.json" },
  { client_name: "" }, { client_name: "unsafe\nname" },
  { redirect_uris: [] }, { redirect_uris: [CALLBACK, CALLBACK] },
  { redirect_uris: ["http://localhost/callback"] },
  { redirect_uris: ["https://user:secret@chatgpt.com/callback"] },
  { redirect_uris: [CALLBACK + "#fragment"] },
  { token_endpoint_auth_methods_supported: ["private_key_jwt"] },
  { token_endpoint_auth_methods_supported: "none" },
  { token_endpoint_auth_methods_supported: undefined, token_endpoint_auth_method: "private_key_jwt" },
])("rejects metadata that cannot authorize the public client: %j", async (override) => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...metadata, ...override })));
  expect(await fetchMetadataClient(CLIENT)).toBeNull();
});

it.each([
  () => new Response("{}", { status: 302, headers: { Location: "https://internal.test" } }),
  () => new Response("{}", { status: 503 }),
  () => new Response("{}", { headers: { "Content-Type": "text/html" } }),
  () => new Response(" ".repeat(16_385), { headers: { "Content-Type": "application/json" } }),
])("rejects redirects, unavailable endpoints, wrong content types and oversized documents", async (response) => {
  vi.stubGlobal("fetch", vi.fn(async () => response()));
  expect(await fetchMetadataClient(CLIENT)).toBeNull();
});
