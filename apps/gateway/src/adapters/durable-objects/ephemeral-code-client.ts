import type {
  AccessRefreshCredentialRecord,
  AccessRefreshCredentialStore,
  HandoffCodeRecord,
  HandoffCodeStore,
  LoginAttemptRecord,
  LoginAttemptStore,
} from "@praetorium/auth";
import { shardNameFor } from "./shard.js";

async function call<T>(
  namespace: DurableObjectNamespace,
  shardKey: string,
  path: string,
  body: unknown,
): Promise<T> {
  const stub = namespace.get(namespace.idFromName(shardNameFor(shardKey)));
  const response = await stub.fetch(`https://ephemeral-code${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return (await response.json()) as T;
}

export function createDurableObjectLoginAttemptStore(
  namespace: DurableObjectNamespace,
): LoginAttemptStore {
  return {
    async save(record) {
      await namespace
        .get(namespace.idFromName(shardNameFor(record.state)))
        .fetch("https://ephemeral-code/save", {
          method: "POST",
          body: JSON.stringify({ key: `login:${record.state}`, record }),
        });
    },
    async consume(state) {
      const { record } = await call<{ record: LoginAttemptRecord | null }>(
        namespace,
        state,
        "/consume",
        {
          key: `login:${state}`,
        },
      );
      return record;
    },
  };
}

export function createDurableObjectHandoffCodeStore(
  namespace: DurableObjectNamespace,
): HandoffCodeStore {
  return {
    async save(digest, record) {
      await namespace
        .get(namespace.idFromName(shardNameFor(digest)))
        .fetch("https://ephemeral-code/save", {
          method: "POST",
          body: JSON.stringify({ key: `handoff:${digest}`, record }),
        });
    },
    async consume(digest) {
      const { record } = await call<{ record: HandoffCodeRecord | null }>(
        namespace,
        digest,
        "/consume",
        {
          key: `handoff:${digest}`,
        },
      );
      return record;
    },
  };
}

async function callRefresh<T>(
  namespace: DurableObjectNamespace,
  credentialId: string,
  path: string,
  body: unknown,
): Promise<T> {
  const stub = namespace.get(namespace.idFromName(shardNameFor(`refresh:${credentialId}`)));
  const response = await stub.fetch(`https://ephemeral-code/refresh/${path}`, {
    method: "POST",
    body: JSON.stringify({ credentialId, ...((body ?? {}) as Record<string, unknown>) }),
  });
  if (!response.ok) throw new Error("refresh credential store unavailable");
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** Refresh chains stay on a deterministic ephemeral-code shard and rotate atomically within that Durable Object. */
export function createDurableObjectAccessRefreshCredentialStore(
  namespace: DurableObjectNamespace,
): AccessRefreshCredentialStore {
  return {
    async create(credentialId, digest, record) {
      await callRefresh(namespace, credentialId, "create", { digest, record });
    },
    async get(credentialId) {
      const { entry } = await callRefresh<{
        readonly entry: {
          readonly digest: string;
          readonly record: AccessRefreshCredentialRecord;
        } | null;
      }>(namespace, credentialId, "get", {});
      return entry;
    },
    async rotate(credentialId, currentDigest, nextDigest, now) {
      const { rotated } = await callRefresh<{ readonly rotated: boolean }>(
        namespace,
        credentialId,
        "rotate",
        {
          currentDigest,
          nextDigest,
          now,
        },
      );
      return rotated;
    },
    async revoke(credentialId, digest, revokedAt) {
      const { revoked } = await callRefresh<{ readonly revoked: boolean }>(
        namespace,
        credentialId,
        "revoke",
        {
          digest,
          revokedAt,
        },
      );
      return revoked;
    },
  };
}
