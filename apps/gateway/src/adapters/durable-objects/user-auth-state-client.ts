import type { McpCredentialStore, SessionStore, UserId } from "@praetorium/auth";
import type { DigestUserIndex } from "../digest-user-index.js";

async function call<T>(
  namespace: DurableObjectNamespace,
  userId: UserId,
  path: string,
  body: unknown,
): Promise<T> {
  const stub = namespace.get(namespace.idFromName(userId));
  const response = await stub.fetch(`https://user-auth-state${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error("user auth state store unavailable");
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

export function createDurableObjectSessionStore(
  namespace: DurableObjectNamespace,
  digestIndex: DigestUserIndex,
): SessionStore {
  return {
    async create(digest, record) {
      await call(namespace, record.userId, "/sessions/create", { digest, record });
      try {
        await digestIndex.set(digest, record.userId, record.expiresAt);
      } catch (error) {
        await call(namespace, record.userId, "/sessions/revoke", {
          digest, revokedAt: record.createdAt,
        });
        throw error;
      }
    },
    async createWithinLimit(digest, record, concurrentSessionLimit, now) {
      const { created } = await call<{ created: boolean }>(
        namespace,
        record.userId,
        "/sessions/create-within-limit",
        { digest, record, concurrentSessionLimit, now },
      );
      if (!created) return false;
      try {
        await digestIndex.set(digest, record.userId, record.expiresAt);
      } catch (error) {
        await call(namespace, record.userId, "/sessions/revoke", { digest, revokedAt: now });
        throw error;
      }
      return true;
    },
    async get(digest) {
      const userId = await digestIndex.get(digest);
      if (!userId) {
        return null;
      }
      const { record } = await call<{ record: Awaited<ReturnType<SessionStore["get"]>> }>(
        namespace,
        userId,
        "/sessions/get",
        { digest },
      );
      if (!record) await digestIndex.delete(digest);
      return record;
    },
    async touch(digest, lastActivityBucket, expiresAt) {
      const userId = await digestIndex.get(digest);
      if (!userId) {
        return;
      }
      await digestIndex.set(digest, userId, expiresAt);
      await call(namespace, userId, "/sessions/touch", { digest, lastActivityBucket, expiresAt });
    },
    async revoke(digest, revokedAt) {
      const userId = await digestIndex.get(digest);
      if (!userId) {
        return;
      }
      await call(namespace, userId, "/sessions/revoke", { digest, revokedAt });
    },
    async revokeAllForUser(userId, revokedAt) {
      await call(namespace, userId, "/sessions/revoke-all", { revokedAt });
    },
    async countActiveForUser(userId, now) {
      const { count } = await call<{ count: number }>(namespace, userId, "/sessions/count-active", { now });
      return count;
    },
  };
}

export function createDurableObjectMcpCredentialStore(
  namespace: DurableObjectNamespace,
  digestIndex: DigestUserIndex,
): McpCredentialStore {
  return {
    async create(digest, record) {
      await call(namespace, record.userId, "/credentials/create", { digest, record });
      try {
        await digestIndex.set(digest, record.userId, record.expiresAt);
      } catch (error) {
        await call(namespace, record.userId, "/credentials/revoke", {
          digest, revokedAt: record.createdAt,
        });
        throw error;
      }
    },
    async get(digest) {
      const userId = await digestIndex.get(digest);
      if (!userId) {
        return null;
      }
      const { record } = await call<{ record: Awaited<ReturnType<McpCredentialStore["get"]>> }>(
        namespace,
        userId,
        "/credentials/get",
        { digest },
      );
      if (!record) await digestIndex.delete(digest);
      return record;
    },
    async listForUser(userId, cursor) {
      const page = await call<Awaited<ReturnType<McpCredentialStore["listForUser"]>>>(
        namespace,
        userId,
        "/credentials/list",
        cursor ? { cursor } : {},
      );
      return page;
    },
    async touchLastUsed(digest, lastUsedAt) {
      const userId = await digestIndex.get(digest);
      if (!userId) {
        return;
      }
      await call(namespace, userId, "/credentials/touch-last-used", { digest, lastUsedAt });
    },
    async revoke(digest, revokedAt) {
      const userId = await digestIndex.get(digest);
      if (!userId) {
        return;
      }
      await call(namespace, userId, "/credentials/revoke", { digest, revokedAt });
    },
    async revokeById(userId, id, revokedAt) {
      const { revoked } = await call<{ revoked: boolean }>(
        namespace,
        userId,
        "/credentials/revoke-by-id",
        { id, revokedAt },
      );
      return revoked;
    },
    async revokeAllForUser(userId, revokedAt) {
      await call(namespace, userId, "/credentials/revoke-all", { revokedAt });
    },
  };
}
