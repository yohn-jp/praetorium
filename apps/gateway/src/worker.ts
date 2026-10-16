import { createGatewayContext } from "./context.js";
import type { GatewayEnv } from "./env.js";
import { errorResponse } from "./middleware/error-response.js";
import { getOrCreateRequestId, withRequestId } from "./middleware/request-id.js";
import { applySecurityHeaders } from "./middleware/security-headers.js";
import { handle } from "./handle.js";

export { EphemeralCodeDurableObject } from "./adapters/durable-objects/ephemeral-code-durable-object.js";
export { UserAuthStateDurableObject } from "./adapters/durable-objects/user-auth-state-durable-object.js";

export default {
  async fetch(request: Request, env: GatewayEnv): Promise<Response> {
    const requestId = getOrCreateRequestId(request);
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
