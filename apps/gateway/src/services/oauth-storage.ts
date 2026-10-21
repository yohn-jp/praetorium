import { constantTimeEqual, generateToken, keyedDigest } from "@praetorium/auth";
import { shardNameFor } from "../adapters/durable-objects/shard.js";

export interface OAuthClientRecord {
  readonly clientId: string;
  readonly clientName: string;
  readonly redirectUris: readonly string[];
}

export interface OAuthCodeRecord {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly resource: string;
  readonly challenge: string;
  readonly permissions: readonly ("read" | "write")[];
  readonly repositoryId: number;
  readonly userId: string;
  readonly sessionDigest: string;
  readonly expiresAt: string;
}

export interface OAuthRefreshRecord {
  readonly clientId: string;
  readonly resource: string;
  readonly repositoryId: number;
  readonly permissions: readonly ("read" | "write")[];
  readonly userId: string;
  readonly sessionDigest: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

export interface OAuthStorage {
  saveClient(record: OAuthClientRecord): Promise<void>;
  getClient(id: string): Promise<OAuthClientRecord | null>;
  saveCode(code: string, record: OAuthCodeRecord): Promise<void>;
  consumeCode(code: string): Promise<OAuthCodeRecord | null>;
  createRefresh(record: OAuthRefreshRecord): Promise<string>;
  getRefresh(plaintext: string, clientId: string, resource: string, now: string): Promise<OAuthRefreshRecord | null>;
  rotateRefresh(plaintext: string, clientId: string, resource: string, now: string):
    Promise<{ record: OAuthRefreshRecord; nextToken: string } | null>;
}

function parseRefresh(raw: string): { id: string; secret: string } | null {
  const match = /^praetorium_oauth_ref_v1\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(raw);
  return match ? { id: match[1]!, secret: match[2]! } : null;
}

/** OAuth state is Durable-Object backed. No process-memory or per-Pod grants. */
export function createOAuthStorage(namespace: DurableObjectNamespace, pepper: Uint8Array): OAuthStorage {
  async function call<T>(shardKey: string, path: string, body: unknown): Promise<T> {
    const stub = namespace.get(namespace.idFromName(shardNameFor(shardKey)));
    const response = await stub.fetch("https://ephemeral-code" + path, {
      method: "POST", body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error("OAuth state store unavailable");
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }
  return {
    async saveClient(record) {
      await call(record.clientId, "/save", { key: "oauth-client:" + record.clientId, record });
    },
    async getClient(id) {
      const result = await call<{ record: OAuthClientRecord | null }>(
        id, "/get", { key: "oauth-client:" + id },
      );
      return result.record;
    },
    async saveCode(code, record) {
      await call(code, "/save", { key: "oauth-code:" + code, record });
    },
    async consumeCode(code) {
      const result = await call<{ record: OAuthCodeRecord | null }>(
        code, "/consume", { key: "oauth-code:" + code },
      );
      return result.record;
    },
    async createRefresh(record) {
      const id = generateToken(128);
      const secret = generateToken(256);
      const plaintext = "praetorium_oauth_ref_v1." + id + "." + secret;
      const credentialId = "oauth:" + id;
      const digest = await keyedDigest(pepper, plaintext);
      await call("refresh:" + credentialId, "/refresh/create", { credentialId, digest, record });
      return plaintext;
    },
    async getRefresh(plaintext, clientId, resource, now) {
      const parsed = parseRefresh(plaintext);
      if (!parsed) return null;
      const credentialId = "oauth:" + parsed.id;
      const entry = await call<{ entry: { digest: string; record: OAuthRefreshRecord } | null }>(
        "refresh:" + credentialId, "/refresh/get", { credentialId },
      );
      const record = entry.entry?.record;
      if (!entry.entry || !record || record.revokedAt !== null ||
          record.clientId !== clientId || record.resource !== resource ||
          Date.parse(record.expiresAt) <= Date.parse(now)) return null;
      const digest = await keyedDigest(pepper, plaintext);
      return constantTimeEqual(digest, entry.entry.digest) ? record : null;
    },
    async rotateRefresh(plaintext, clientId, resource, now) {
      const parsed = parseRefresh(plaintext);
      if (!parsed) return null;
      const credentialId = "oauth:" + parsed.id;
      const shard = "refresh:" + credentialId;
      const entry = await call<{ entry: { digest: string; record: OAuthRefreshRecord } | null }>(
        shard, "/refresh/get", { credentialId },
      );
      const record = entry.entry?.record;
      if (!entry.entry || !record || record.revokedAt !== null ||
          record.clientId !== clientId || record.resource !== resource ||
          Date.parse(record.expiresAt) <= Date.parse(now)) return null;
      const digest = await keyedDigest(pepper, plaintext);
      if (!constantTimeEqual(digest, entry.entry.digest)) return null;
      const nextToken = "praetorium_oauth_ref_v1." + parsed.id + "." + generateToken(256);
      const nextDigest = await keyedDigest(pepper, nextToken);
      const result = await call<{ rotated: boolean }>(
        shard, "/refresh/rotate", { credentialId, currentDigest: digest, nextDigest, now },
      );
      return result.rotated ? { record, nextToken } : null;
    },
  };
}
