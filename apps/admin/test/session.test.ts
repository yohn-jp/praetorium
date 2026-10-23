import { describe, expect, it, vi } from "vitest";
import type { AdminIdentityRpc, AdminContext } from "../src/context.js";
import { createAdminContext } from "../src/context.js";
import { authenticateAdmin, adminFormCsrf, completeAdminHandoff, logoutAdmin } from "../src/session.js";
import { handleAdminHost } from "../src/admin/console.js";

const GATEWAY = "https://praetorium.test";
const ADMIN = "https://admin.praetorium.test";
const SESSION_ID = "a".repeat(43);
const CODE = "b".repeat(43);
const CSRF = "signed-csrf-token";

function fixture() {
  const identity: AdminIdentityRpc = {
    redeemAdminHandoff: vi.fn(async () => ({
      kind: "ok" as const, sessionId: SESSION_ID, csrfToken: CSRF, ttlSeconds: 3600,
    })),
    verifyAdminSession: vi.fn(async () => ({ actorId: "213253858", csrfToken: CSRF })),
    revokeAdminSession: vi.fn(async () => true),
    listApprovedSourceReleases: vi.fn(async () => []),
    resolvePublishedRelease: vi.fn(async () => ({ kind: "unavailable" as const })),
    revalidateRetrySource: vi.fn(async () => ({ kind: "unavailable" as const })),
  };
  const cp = { fetch: vi.fn(async () => Response.json({ items: [] })) };
  const context = createAdminContext({
    ADMIN_IDENTITY: identity, CONTROL_PLANE: cp as unknown as Fetcher,
    GATEWAY_ORIGIN: GATEWAY, ADMIN_ORIGIN: ADMIN,
    ADMIN_CONTROL_PLANE_AUTH: "c".repeat(48),
  });
  return { context, identity, cp };
}
function sessionRequest(url = ADMIN + "/", extra: HeadersInit = {}): Request {
  return new Request(url, { headers: {
    Cookie: "__Host-praetorium_session=" + SESSION_ID + "; __Host-praetorium_csrf=" + CSRF,
    ...extra,
  } });
}
function handoff(
  input = CODE, origin = GATEWAY,
): Request {
  return new Request(ADMIN + "/_admin/handoff", {
    method: "POST", headers: {
      Origin: origin, "Content-Type": "application/x-www-form-urlencoded",
    }, body: new URLSearchParams({code: input}).toString(),
  });
}

describe("independent Admin session boundary", () => {
  it("exchanges one-use Gateway handoff into Admin-host-only cookies", async () => {
    const { context, identity } = fixture();
    const response = await completeAdminHandoff(handoff(), context);
    expect(response.status).toBe(303);
    expect(response.headers.get("Set-Cookie")).toContain("__Host-praetorium_session=");
    expect(response.headers.get("Set-Cookie")).not.toContain("Domain=");
    expect(identity.redeemAdminHandoff).toHaveBeenCalledWith(CODE);
  });

  it("rejects cross-origin handoff before contacting the identity broker", async () => {
    const { context, identity } = fixture();
    expect((await completeAdminHandoff(handoff(CODE, "https://attacker.test"), context)).status).toBe(403);
    expect(identity.redeemAdminHandoff).not.toHaveBeenCalled();
    expect((await completeAdminHandoff(handoff("invalid"), context)).status).toBe(400);
  });

  it("fails closed on missing, duplicated and revoked admin sessions", async () => {
    const { context, identity } = fixture();
    expect(await authenticateAdmin(new Request(ADMIN), context)).toBeNull();
    expect(identity.verifyAdminSession).not.toHaveBeenCalled();
    expect(await authenticateAdmin(new Request(ADMIN, { headers: {
      Cookie: "__Host-praetorium_session=" + SESSION_ID +
        "; __Host-praetorium_session=" + SESSION_ID,
    }}), context)).toBeNull();
    vi.mocked(identity.verifyAdminSession).mockResolvedValueOnce(null);
    expect(await authenticateAdmin(sessionRequest(), context)).toBeNull();
  });

  it("blocks foreign-origin and stale CSRF without a downstream mutation", async () => {
    const { context } = fixture();
    const session = await authenticateAdmin(sessionRequest(), context);
    expect(session).not.toBeNull();
    const form = new URLSearchParams({ csrfToken: CSRF });
    const correct = new Request(ADMIN + "/logout", { method: "POST", headers: {
      Origin: ADMIN, Cookie: sessionRequest().headers.get("Cookie")!,
    }, body: form });
    expect(await adminFormCsrf(correct, context, session!, form)).toBe(true);
    const bad = new Request(ADMIN + "/logout", { method: "POST", headers: {
      Origin: "https://attacker.test",
      Cookie: sessionRequest().headers.get("Cookie")!,
    }, body: form });
    expect(await adminFormCsrf(bad, context, session!, form)).toBe(false);
  });

  it("rejects operator data access without a verified session", async () => {
    const { context, cp } = fixture();
    const response = await handleAdminHost(new Request(ADMIN + "/builds"), context);
    expect(response.status).toBe(403);
    expect(cp.fetch).not.toHaveBeenCalled();
  });

  it("revokes the admin session only through Gateway and expires host cookies", async () => {
    const { context, identity } = fixture();
    const current = (await authenticateAdmin(sessionRequest(), context))!;
    const response = await logoutAdmin(sessionRequest(), context, current);
    expect(response.status).toBe(303);
    expect(identity.revokeAdminSession).toHaveBeenCalledWith(SESSION_ID);
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });

  it("requires an independent Control Plane Admin credential", () => {
    const { context } = fixture();
    expect(context.config.controlPlaneSecret).toBe("c".repeat(48));
    expect(() => createAdminContext({
      ADMIN_IDENTITY: context.env.ADMIN_IDENTITY, CONTROL_PLANE: context.env.CONTROL_PLANE,
      ADMIN_ORIGIN: ADMIN, GATEWAY_ORIGIN: GATEWAY,
      ADMIN_CONTROL_PLANE_AUTH: "short",
    })).toThrow(/credential/u);
  });
});
