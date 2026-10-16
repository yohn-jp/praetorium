const REQUEST_ID_HEADER = "X-Request-Id";

/** Reuses an inbound request id when present (e.g. from the Cloudflare edge), otherwise mints one. */
export function getOrCreateRequestId(request: Request): string {
  return request.headers.get(REQUEST_ID_HEADER) ?? crypto.randomUUID();
}

export function withRequestId(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set(REQUEST_ID_HEADER, requestId);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
