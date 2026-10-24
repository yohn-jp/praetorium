import { createGatewayContext } from "./context.js";
import type { GatewayEnv } from "./env.js";
import { errorResponse } from "./middleware/error-response.js";
import { getOrCreateRequestId, withRequestId } from "./middleware/request-id.js";
import { applySecurityHeaders } from "./middleware/security-headers.js";
import { logRequest, redactedPath } from "./middleware/logging.js";
import { loadKeyRegistry } from "./adapters/key-registry-kv.js";
import { publicJwks } from "./router.js";
import { handle } from "./handle.js";

export { AdminIdentityBroker } from "./admin/broker.js";
export { EphemeralCodeDurableObject } from "./adapters/durable-objects/ephemeral-code-durable-object.js";
export { UserAuthStateDurableObject } from "./adapters/durable-objects/user-auth-state-durable-object.js";

function finishStaticResponse(
  request: Request,
  response: Response,
  requestId: string,
  startedAt: number,
  environment: string | undefined,
): Response {
  response = applySecurityHeaders(response, {
    isProductionLike: environment !== "development" && environment !== "test",
  });
  response = withRequestId(response, requestId);
  logRequest({
    requestId,
    method: request.method,
    path: redactedPath(new URL(request.url)),
    status: response.status,
    durationMs: Date.now() - startedAt,
  });
  return response;
}

export default {
  async fetch(request: Request, env: GatewayEnv): Promise<Response> {
    const requestId = getOrCreateRequestId(request);
    const startedAt = Date.now();
    const pathname = new URL(request.url).pathname;
    if (request.method === "GET" && pathname === "/healthz") {
      return finishStaticResponse(
        request,
        Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } }),
        requestId,
        startedAt,
        env.GATEWAY_ENVIRONMENT,
      );
    }
    if (request.method === "GET" && pathname === "/.well-known/jwks.json") {
      let response: Response;
      try {
        if (!env.GATEWAY_KV) throw new TypeError("Gateway public key registry binding is required");
        response = publicJwks(await loadKeyRegistry(env.GATEWAY_KV));
      } catch {
        console.error(JSON.stringify({
          level: "error",
          type: "key_registry_unavailable",
          requestId,
          message: "Gateway public key registry is unavailable",
        }));
        response = errorResponse(request, "INTERNAL", "internal error", requestId);
      }
      return finishStaticResponse(request, response, requestId, startedAt, env.GATEWAY_ENVIRONMENT);
    }
    const now = new Date().toISOString();

    let context;
    try {
      context = await createGatewayContext(env, requestId, now);
    } catch {
      // Config/secret resolution failed before a context even exists — fail closed, still respond safely.
      console.error(
        JSON.stringify({
          level: "error",
          type: "context_init_failed",
          requestId,
          message: "Gateway configuration or required authority is unavailable",
        }),
      );
      let response = errorResponse(request, "INTERNAL", "internal error", requestId);
      response = applySecurityHeaders(response, { isProductionLike: false });
      return withRequestId(response, requestId);
    }

    return handle(request, context);
  },
};
