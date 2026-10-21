import { UserAuthStateDurableObject } from "../src/adapters/durable-objects/user-auth-state-durable-object.js";
import { EphemeralCodeDurableObject } from "../src/adapters/durable-objects/ephemeral-code-durable-object.js";

export { UserAuthStateDurableObject, EphemeralCodeDurableObject };

export default {
  async fetch(request: Request, env: { readonly USER_AUTH_STATE: DurableObjectNamespace }): Promise<Response> {
    const stub = env.USER_AUTH_STATE.get(env.USER_AUTH_STATE.idFromName("workerd-session-race"));
    return stub.fetch(request);
  },
};
