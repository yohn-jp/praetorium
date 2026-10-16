/**
 * Baseline security headers for a JSON API / redirect-driven Worker: no
 * inline scripts or styles are ever served here, so a strict CSP is safe.
 * HSTS is only sent in production-like environments, matching the
 * `Strict-Transport-Security` guidance for services that always terminate
 * TLS at the edge.
 */
export function applySecurityHeaders(
  response: Response,
  options: { readonly isProductionLike: boolean },
): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  if (!headers.has("Content-Security-Policy")) {
    headers.set(
      "Content-Security-Policy",
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
  }
  if (options.isProductionLike) {
    headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
