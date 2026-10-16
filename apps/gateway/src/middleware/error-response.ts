export interface PublicError {
  readonly code: string;
  readonly message: string;
}

export function errorResponse(
  request: Request,
  code: string,
  message: string,
  requestId: string,
  status = statusFor(code),
): Response {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  if (code === "INSTANCE_STARTING") headers.set("Retry-After", "5");
  if (request.method === "HEAD") return new Response(null, { status, headers });
  return Response.json({ error: { code, message }, requestId }, { status, headers });
}

function statusFor(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED": return 401;
    case "UNAUTHORIZED":
    case "FORBIDDEN": return 403;
    case "NOT_FOUND": return 404;
    case "INVALID_REQUEST": return 400;
    case "RATE_LIMITED": return 429;
    case "CONFLICT":
    case "STALE_GENERATION": return 409;
    case "UNAVAILABLE":
    case "UPSTREAM_UNAVAILABLE":
    case "INSTANCE_STARTING": return 503;
    case "FAILED": return 502;
    case "INTERNAL":
    default: return 500;
  }
}
