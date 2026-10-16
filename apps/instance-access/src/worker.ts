import { createInstanceAccessHandler, type InstanceAccessEnvironment } from "./handler.js";

export default {
  fetch(request: Request, env: InstanceAccessEnvironment): Promise<Response> {
    return createInstanceAccessHandler(env)(request);
  },
};
