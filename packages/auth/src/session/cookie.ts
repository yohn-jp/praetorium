/**
 * Host-only session cookie: no `Domain` attribute is ever set, so the
 * cookie is scoped to the exact gateway host and never leaks to
 * `*.container.*` instance hosts.
 */
export interface SessionCookieConfig {
  readonly name: string;
  readonly ttlSeconds: number;
}

export function buildSessionCookie(config: SessionCookieConfig, rawSessionId: string): string {
  return [
    `${config.name}=${rawSessionId}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${config.ttlSeconds}`,
  ].join("; ");
}

export function buildExpiredSessionCookie(config: Pick<SessionCookieConfig, "name">): string {
  return [`${config.name}=`, "Path=/", "HttpOnly", "Secure", "SameSite=Lax", "Max-Age=0"].join("; ");
}
