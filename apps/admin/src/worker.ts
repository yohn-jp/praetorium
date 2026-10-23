import { createAdminContext, type AdminEnv } from "./context.js";
import { adminStyles } from "./styles.js";
import { handleAdminHost } from "./admin/console.js";

function finish(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "same-origin");
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
  return new Response(response.body, {
    status: response.status, statusText: response.statusText, headers,
  });
}
export default {
  async fetch(request: Request, env: AdminEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== env.ADMIN_ORIGIN) return new Response("Not found", { status: 404 });
    if (request.method === "GET" && url.pathname === "/healthz") {
      return finish(Response.json({ status: "ok" }));
    }
    if (request.method === "GET" && url.pathname === "/assets/admin.css") {
      const mode = url.searchParams.get("ui") === "mobile" ? "mobile" : "desktop";
      return finish(new Response(adminStyles(mode), { headers: {
        "Content-Type": "text/css; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
      } }));
    }
    let context;
    try { context = createAdminContext(env); }
    catch { return finish(new Response("Administration configuration unavailable", { status: 503 })); }
    try { return finish(await handleAdminHost(request, context)); }
    catch {
      return finish(new Response("Administration temporarily unavailable", {
        status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" },
      }));
    }
  },
} satisfies ExportedHandler<AdminEnv>;
