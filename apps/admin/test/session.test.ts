import { describe, expect, it, vi } from "vitest";
import type { AdminIdentityRpc } from "../src/context.js";
import { createAdminContext } from "../src/context.js";
import { authenticateAdmin, adminFormCsrf, completeAdminHandoff, logoutAdmin, adminReturnPath } from "../src/session.js";
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

  it("re-enters authentication for allowlisted deep links without exposing operator data", async () => {
    const { context, cp } = fixture();
    const response = await handleAdminHost(new Request(ADMIN + "/builds"), context);
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(GATEWAY + "/_admin/entry?return_to=" +
      encodeURIComponent("/builds?ui=desktop"));
    expect((await handleAdminHost(new Request(ADMIN + "/unrecognized"), context)).status).toBe(403);
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


it("retains bounded read-only query context after an expired Admin session", async () => {
  const {context,cp}=fixture();
  const url=ADMIN+"/builds?ui=mobile&state=failed&sort=attempt&cursor=queue_older";
  const response=await handleAdminHost(new Request(url),context);
  expect(response.status).toBe(303);
  const location=new URL(response.headers.get("Location")!);
  expect(location.origin).toBe(GATEWAY);
  expect(location.searchParams.get("return_to")).toBe(
    "/builds?ui=mobile&state=failed&sort=attempt&cursor=queue_older");
  expect(cp.fetch).not.toHaveBeenCalled();
});

it("accepts only bounded same-origin GET destination search parameters", () => {
  expect(adminReturnPath("/audit?ui=mobile&q=lease+epoch&cursor=12:evt_1")).toBe(
    "/audit?ui=mobile&q=lease+epoch&cursor=12%3Aevt_1");
  expect(adminReturnPath("/builds?ui=desktop&state=failed&sort=attempt")).toBe(
    "/builds?ui=desktop&state=failed&sort=attempt");
  for(const invalid of [
    "//evil.example/", "/builds?ui=mobile&ui=desktop",
    "/audit?q=a&q=b", "/releases?state=failed",
    "/builds?state=not_real", "/audit?q=%0A", "/logout?ui=mobile",
    "/audit?next=https://evil.example", "/audit#fragment",
  ]) expect(adminReturnPath(invalid)).toBe("/");
});

it("fetches only an operation's current evidence on its detail page", async () => {
  const {context,identity,cp}=fixture();
  const response=await handleAdminHost(sessionRequest(ADMIN+"/operations/op_123?ui=mobile"),context);
  expect(response.status).toBe(200);
  expect(identity.listApprovedSourceReleases).not.toHaveBeenCalled();
  expect(cp.fetch).toHaveBeenCalledTimes(1);
  const request=vi.mocked(cp.fetch).mock.calls[0]?.[0] as Request;
  expect(new URL(request.url).pathname).toBe("/v1/operations/op_123/evidence");
});
