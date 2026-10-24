import type { OAuthClientRecord } from "./oauth-storage.js";

const MAX_METADATA_BYTES = 16_384;

/** Only the reviewed ChatGPT metadata URLs are fetched. URL client IDs must
 * never turn the public authorization/token endpoints into an SSRF proxy. */
export function isSupportedMetadataClientId(id: string): boolean {
  try {
    const url = new URL(id);
    return id === url.href && url.origin === "https://chatgpt.com" &&
      !url.username && !url.password && !url.search && !url.hash &&
      /^\/oauth\/(?:[A-Za-z0-9_-]{1,128}\/)?client\.json$/.test(url.pathname);
  } catch { return false; }
}

/** Public CIMD clients use PKCE and `none`; private_key_jwt is not advertised. */
export async function fetchMetadataClient(id: string): Promise<OAuthClientRecord | null> {
  if (!isSupportedMetadataClientId(id)) return null;
  // Workers supports follow/manual only. Inspect 3xx without following the allowlisted URL.
  const response = await fetch(id, {
    headers: { Accept: "application/json" }, redirect: "manual",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok || response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.byteLength;
    if (length > MAX_METADATA_BYTES) { await reader.cancel(); return null; }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  // The plural methods field is authoritative when present. ChatGPT's legacy
  // singular preference can be private_key_jwt while it also supports none.
  const methods = data.token_endpoint_auth_methods_supported;
  if (methods !== undefined
    ? !Array.isArray(methods) || !methods.every((method) => typeof method === "string") || !methods.includes("none")
    : data.token_endpoint_auth_method !== undefined && data.token_endpoint_auth_method !== "none") return null;
  if (data.client_id !== id || typeof data.client_name !== "string" ||
      data.client_name.length < 1 || data.client_name.length > 80 ||
      [...data.client_name].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f) ||
      !Array.isArray(data.redirect_uris) || data.redirect_uris.length < 1 || data.redirect_uris.length > 5 ||
      new Set(data.redirect_uris).size !== data.redirect_uris.length ||
      data.redirect_uris.some((uri: unknown) => {
        if (typeof uri !== "string" || uri.length > 1024) return true;
        try {
          const url = new URL(uri);
          return url.protocol !== "https:" || Boolean(url.username || url.password || url.hash);
        } catch { return true; }
      })) return null;
  return { clientId: id, clientName: data.client_name, redirectUris: data.redirect_uris as string[] };
}
