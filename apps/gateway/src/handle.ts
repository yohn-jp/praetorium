import type { GatewayContext } from "./context.js";
import { applySecurityHeaders } from "./middleware/security-headers.js";
import { getOrCreateRequestId, withRequestId } from "./middleware/request-id.js";
import { logRequest, redactedPath } from "./middleware/logging.js";
import { createGatewayRouter } from "./router.js";
import { handleAdminHost } from "./admin/console.js";

export async function handle(request: Request, context: GatewayContext): Promise<Response> {
  const startedAt = Date.now();
  const requestId = context.requestId || getOrCreateRequestId(request);
  let response: Response;
  try {
    response = context.config.adminOrigin && new URL(request.url).origin === context.config.adminOrigin
      ? await handleAdminHost(request, context)
      : await createGatewayRouter(context).fetch(request);
  } catch {
    console.error(JSON.stringify({
      level: "error",
      type: "gateway_request_failed",
      requestId,
      message: "Gateway handler failed",
    }));
    response = Response.json({ error: { code: "INTERNAL", message: "The request could not be completed." }, requestId }, {
      status: 500,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const headers = applySecurityHeaders(response, {
    isProductionLike: context.config.environment !== "development" && context.config.environment !== "test",
  });
  response = withRequestId(headers, requestId);
  logRequest({
    requestId,
    method: request.method,
    path: redactedPath(new URL(request.url)),
    status: response.status,
    durationMs: Date.now() - startedAt,
  });
  return response;
}
