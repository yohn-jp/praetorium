const SESSION_PREFIX = "session:";
const CREDENTIAL_PREFIX = "credential:";
const GITHUB_TOKEN_KEY = "github-user-token";

function isActiveRecord(
  record: { readonly expiresAt: string; readonly revokedAt: string | null },
  now: string,
): boolean {
  const nowMs = new Date(now).getTime();
  const notRevoked = !record.revokedAt || new Date(record.revokedAt).getTime() > nowMs;
  const notExpired = new Date(record.expiresAt).getTime() > nowMs;
  return notRevoked && notExpired;
}

/**
 * Authoritative per-user store for browser sessions (#18) and MCP
 * credentials (#19). One instance per user (`idFromName(userId)`) gives
 * strong consistency scoped exactly where it matters: the concurrent-
 * session limit and revocation must never race within a single user's
 * requests, and Cloudflare serializes all requests to one Durable Object
 * instance.
 */
export class UserAuthStateDurableObject implements DurableObject {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }

    const url = new URL(request.url);
    const body = (await request.json()) as Record<string, unknown>;

    switch (url.pathname) {
      case "/sessions/create": {
        const { digest, record } = body as { digest: string; record: unknown };
        await this.state.storage.put(`${SESSION_PREFIX}${digest}`, record);
        return new Response(null, { status: 204 });
      }
      case "/sessions/get": {
        const { digest } = body as { digest: string };
        const record = await this.state.storage.get(`${SESSION_PREFIX}${digest}`);
        return Response.json({ record: record ?? null });
      }
      case "/sessions/touch": {
        const { digest, lastActivityBucket, expiresAt } = body as {
          digest: string;
          lastActivityBucket: string;
          expiresAt: string;
        };
        const key = `${SESSION_PREFIX}${digest}`;
        const existing = await this.state.storage.get<Record<string, unknown>>(key);
        if (existing) {
          await this.state.storage.put(key, { ...existing, lastActivityBucket, expiresAt });
        }
        return new Response(null, { status: 204 });
      }
      case "/sessions/revoke": {
        const { digest, revokedAt } = body as { digest: string; revokedAt: string };
        const key = `${SESSION_PREFIX}${digest}`;
        const existing = await this.state.storage.get<Record<string, unknown>>(key);
        if (existing) {
          await this.state.storage.put(key, { ...existing, revokedAt });
        }
        return new Response(null, { status: 204 });
      }
      case "/sessions/revoke-all": {
        const { revokedAt } = body as { revokedAt: string };
        const entries = await this.state.storage.list<Record<string, unknown>>({ prefix: SESSION_PREFIX });
        for (const [key, record] of entries) {
          if (!record["revokedAt"]) {
            await this.state.storage.put(key, { ...record, revokedAt });
          }
        }
        return new Response(null, { status: 204 });
      }
      case "/sessions/count-active": {
        const { now } = body as { now: string };
        const entries = await this.state.storage.list<{
          expiresAt: string;
          revokedAt: string | null;
        }>({ prefix: SESSION_PREFIX });
        let count = 0;
        for (const record of entries.values()) {
          if (isActiveRecord(record, now)) {
            count += 1;
          }
        }
        return Response.json({ count });
      }

      case "/credentials/create": {
        const { digest, record } = body as { digest: string; record: unknown };
        await this.state.storage.put(`${CREDENTIAL_PREFIX}${digest}`, record);
        return new Response(null, { status: 204 });
      }
      case "/credentials/get": {
        const { digest } = body as { digest: string };
        const record = await this.state.storage.get(`${CREDENTIAL_PREFIX}${digest}`);
        return Response.json({ record: record ?? null });
      }
      case "/credentials/list": {
        const entries = await this.state.storage.list({ prefix: CREDENTIAL_PREFIX });
        const items = [...entries.entries()].map(([key, record]) => ({
          digest: key.slice(CREDENTIAL_PREFIX.length),
          record,
        }));
        return Response.json({ items });
      }
      case "/credentials/touch-last-used": {
        const { digest, lastUsedAt } = body as { digest: string; lastUsedAt: string };
        const key = `${CREDENTIAL_PREFIX}${digest}`;
        const existing = await this.state.storage.get<Record<string, unknown>>(key);
        if (existing) {
          await this.state.storage.put(key, { ...existing, lastUsedAt });
        }
        return new Response(null, { status: 204 });
      }
      case "/credentials/revoke": {
        const { digest, revokedAt } = body as { digest: string; revokedAt: string };
        const key = `${CREDENTIAL_PREFIX}${digest}`;
        const existing = await this.state.storage.get<Record<string, unknown>>(key);
        if (existing) {
          await this.state.storage.put(key, { ...existing, revokedAt });
        }
        return new Response(null, { status: 204 });
      }
      case "/credentials/revoke-all": {
        const { revokedAt } = body as { revokedAt: string };
        const entries = await this.state.storage.list<Record<string, unknown>>({
          prefix: CREDENTIAL_PREFIX,
        });
        for (const [key, record] of entries) {
          if (!record["revokedAt"]) {
            await this.state.storage.put(key, { ...record, revokedAt });
          }
        }
        return new Response(null, { status: 204 });
      }

      case "/github-token/store": {
        const { encrypted, accessTokenExpiresAt, refreshTokenExpiresAt } = body as {
          encrypted: unknown;
          accessTokenExpiresAt: string | null;
          refreshTokenExpiresAt: string | null;
        };
        const current = await this.state.storage.get<Record<string, unknown>>(GITHUB_TOKEN_KEY);
        await this.state.storage.put(GITHUB_TOKEN_KEY, {
          encrypted,
          accessTokenExpiresAt,
          refreshTokenExpiresAt,
          revision: Number(current?.["revision"] ?? 0) + 1,
          refreshLockedUntil: null,
          refreshLockId: null,
        });
        return new Response(null, { status: 204 });
      }
      case "/github-token/get": {
        const state = await this.state.storage.get(GITHUB_TOKEN_KEY);
        return Response.json({ state: state ?? null });
      }
      case "/github-token/lock": {
        const { lockId, lockUntil, now } = body as { lockId: string; lockUntil: string; now: string };
        const acquired = await this.state.storage.transaction(async (transaction) => {
          const current = await transaction.get<Record<string, unknown>>(GITHUB_TOKEN_KEY);
          if (!current) return false;
          const expires = current["refreshLockedUntil"];
          if (typeof expires === "string" && new Date(expires).getTime() > new Date(now).getTime()) return false;
          await transaction.put(GITHUB_TOKEN_KEY, { ...current, refreshLockId: lockId, refreshLockedUntil: lockUntil });
          return true;
        });
        return Response.json({ acquired });
      }
      case "/github-token/rotate": {
        const { lockId, expectedRevision, encrypted, accessTokenExpiresAt, refreshTokenExpiresAt } = body as {
          lockId: string;
          expectedRevision: number;
          encrypted: unknown;
          accessTokenExpiresAt: string | null;
          refreshTokenExpiresAt: string | null;
        };
        const stored = await this.state.storage.transaction(async (transaction) => {
          const current = await transaction.get<Record<string, unknown>>(GITHUB_TOKEN_KEY);
          if (!current || current["refreshLockId"] !== lockId || current["revision"] !== expectedRevision) return false;
          await transaction.put(GITHUB_TOKEN_KEY, {
            encrypted,
            accessTokenExpiresAt,
            refreshTokenExpiresAt,
            revision: expectedRevision + 1,
            refreshLockedUntil: null,
            refreshLockId: null,
          });
          return true;
        });
        return Response.json({ stored });
      }
      case "/github-token/unlock": {
        const { lockId } = body as { lockId: string };
        await this.state.storage.transaction(async (transaction) => {
          const current = await transaction.get<Record<string, unknown>>(GITHUB_TOKEN_KEY);
          if (current?.["refreshLockId"] === lockId) {
            await transaction.put(GITHUB_TOKEN_KEY, { ...current, refreshLockId: null, refreshLockedUntil: null });
          }
        });
        return new Response(null, { status: 204 });
      }

      default:
        return new Response("not found", { status: 404 });
    }
  }
}
