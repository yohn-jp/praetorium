/**
 * Query strings are omitted entirely because nested redirect targets can
 * carry sensitive values under otherwise innocuous parameter names. Request
 * logging never includes headers at all (see `logRequest`), so cookies and
 * `Authorization` headers are structurally excluded rather than filtered.
 */
export function redactedPath(url: URL): string {
  return url.pathname;
}

export interface RequestLogEvent {
  readonly requestId: string;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly durationMs: number;
}

/** The only fields ever logged for a request — deliberately excludes headers, cookies, and bodies. */
export function logRequest(event: RequestLogEvent): void {
  console.log(JSON.stringify({ level: "info", type: "request", ...event }));
}
