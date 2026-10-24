import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Vitest runs in Node, whereas named service entrypoints run under workerd.
// The alias is test-only: Wrangler continues to use cloudflare:workers.
export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(
        new URL("./test/testing/cloudflare-workers-stub.ts", import.meta.url),
      ),
    },
  },
});
