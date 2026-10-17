import {
  createTokenVault,
  importPrivateKeyJwk,
  importTokenEncryptionKey,
  type AccessRefreshCredentialStore,
  type HandoffCodeStore,
  type KeyRecord,
  type LoginAttemptStore,
  type McpCredentialStore,
  type RateLimiter,
  type SessionStore,
  type SigningKey,
  type TokenVault,
  type GitHubTokenResponse,
} from "@praetorium/auth";
import { HttpsOriginSchema, requireSecret } from "@praetorium/config";
import {
  createGitHubAccessApi,
  createGitHubAccessProvider,
  createGitHubAppOAuthProvider,
  createGitHubRestClient,
  createGitHubInstallationTokenRevoker,
  type GitCredentialBroker,
  type GitHubAccessProvider,
  type GitHubUserTokenSource,
  type RepositoryBinding as GitHubRepositoryBinding,
} from "@praetorium/github";
import { instanceHostname } from "@praetorium/contracts";
import type { GatewayEnv } from "./env.js";
import { runtimeEpochForAccess } from "./active-runtime.js";
import {
  createDurableObjectHandoffCodeStore,
  createDurableObjectLoginAttemptStore,
} from "./adapters/durable-objects/ephemeral-code-client.js";
import { createDurableObjectAccessRefreshCredentialStore } from "./adapters/durable-objects/ephemeral-code-client.js";
import {
  createDurableObjectMcpCredentialStore,
  createDurableObjectSessionStore,
} from "./adapters/durable-objects/user-auth-state-client.js";
import { createKvDigestUserIndex } from "./adapters/digest-user-index.js";
import { createControlPlaneClient, type ControlPlaneClient } from "./adapters/control-plane-client.js";
import { createKvRateLimiter } from "./adapters/rate-limiter-kv.js";
import { loadKeyRegistry } from "./adapters/key-registry-kv.js";
import { createDurableObjectGitHubUserTokenStore } from "./adapters/github-user-tokens.js";
import { createRuntimeGitCredentialBroker } from "./adapters/runtime-git-broker.js";
import { createRuntimeCredentialRegistry } from "./adapters/runtime-credential-registry.js";

export { type GatewayEnv } from "./env.js";

export interface GatewayConfig {
  readonly environment: string;
  readonly origin: string;
  readonly sessionTtlSeconds: number;
  readonly handoffTtlSeconds: number;
  readonly accessGrantTtlSeconds: number;
  readonly instanceHostnameSuffix: string;
  readonly allowedRepositoryOwner: string;
  readonly githubAppId: number;
  readonly oauthClientId: string;
  readonly oauthClientSecret: string;
  readonly controlPlaneSecret: string;
  readonly instanceAccessSecret: string;
  readonly sessionPepper: Uint8Array;
  readonly credentialPepper: Uint8Array;
  readonly handoffPepper: Uint8Array;
  readonly tokenVault: TokenVault;
}

export interface GatewayContext {
  readonly config: GatewayConfig;
  readonly env: GatewayEnv;
  readonly requestId: string;
  readonly requestNow: string;
  readonly sessionStore: SessionStore;
  readonly loginAttemptStore: LoginAttemptStore;
  readonly mcpCredentialStore: McpCredentialStore;
  readonly handoffStore: HandoffCodeStore;
  readonly accessRefreshCredentialStore: AccessRefreshCredentialStore;
  readonly tokenExchangeRateLimiter: RateLimiter;
  readonly runtimeCredentialRateLimiter: RateLimiter;
  readonly loginRateLimiter: RateLimiter;
  readonly wakeRateLimiter: RateLimiter;
  readonly mutationReceiptRateLimiter: RateLimiter;
  readonly githubProvider: ReturnType<typeof createGitHubAppOAuthProvider>;
  readonly githubAccess: GitHubAccessProvider;
  /** Set only when a trusted runtime authenticator and assignment reader are configured. */
  readonly githubCredentialBroker?: GitCredentialBroker;
  readonly runtimeCredentialRegistry?: ReturnType<typeof createRuntimeCredentialRegistry>;
  readonly githubUserTokens: GitHubUserTokenSource & {
    storeEncrypted(subject: string, tokens: GitHubTokenResponse, issuedAt: string): Promise<void>;
  };
  readonly controlPlane: ControlPlaneClient;
  readonly signingKey: SigningKey;
  readonly keyRegistry: readonly KeyRecord[];
}

function positiveInteger(value: string | undefined, name: string, minimum: number, maximum: number): number {
  if (!value || !/^(0|[1-9][0-9]*)$/.test(value)) throw new TypeError(`${name} must be configured as an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new TypeError(`${name} is outside its allowed range`);
  return parsed;
}

function parseOrigin(value: string | undefined): string {
  const parsed = HttpsOriginSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("GATEWAY_ORIGIN must be an exact HTTPS origin");
  return parsed.data;
}

function parseHostnameSuffix(value: string | undefined): string {
  const suffix = value?.toLowerCase();
  if (
    !suffix ||
    suffix.length > 200 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(suffix) ||
    /(?:^|\.)(?:localhost|example\.(?:com|org|net))(?:\.|$)/.test(suffix)
  ) throw new TypeError("GATEWAY_INSTANCE_HOSTNAME_SUFFIX must be a concrete DNS suffix");
  // Validate the full derived hostname against the canonical host helper too.
  instanceHostname("ins_01ARZ3NDEKTSV4RRFFQ69G5FAV", suffix);
  return suffix;
}

function parseOwner(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(value)) {
    throw new TypeError("GATEWAY_ALLOWED_REPOSITORY_OWNER must name the configured service owner");
  }
  return value;
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError("token encryption key must be base64url");
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateRegistry(value: unknown): readonly KeyRecord[] {
  if (!Array.isArray(value) || value.length > 8) throw new TypeError("Gateway public key registry is invalid");
  const statuses = new Set(["active", "next", "retired", "compromised"]);
  const records = value.map((entry): KeyRecord => {
    if (!object(entry) || typeof entry["kid"] !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(entry["kid"]) ||
      typeof entry["status"] !== "string" || !statuses.has(entry["status"]) ||
      typeof entry["createdAt"] !== "string" ||
      !(entry["retiredAt"] === null || typeof entry["retiredAt"] === "string") ||
      !object(entry["publicKeyJwk"])) throw new TypeError("Gateway public key registry is invalid");
    const jwk = entry["publicKeyJwk"];
    if (Object.hasOwn(jwk, "d") || jwk["kty"] !== "EC" || jwk["crv"] !== "P-256" ||
      typeof jwk["x"] !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(jwk["x"]) ||
      typeof jwk["y"] !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(jwk["y"])) {
      throw new TypeError("Gateway public key registry contains invalid or private key material");
    }
    return {
      kid: entry["kid"],
      status: entry["status"] as KeyRecord["status"],
      publicKeyJwk: { kty: "EC", crv: "P-256", x: jwk["x"], y: jwk["y"] },
      createdAt: entry["createdAt"],
      retiredAt: entry["retiredAt"],
    };
  });
  return records;
}

async function configFrom(env: GatewayEnv): Promise<GatewayConfig> {
  const origin = parseOrigin(env.GATEWAY_ORIGIN);
  const allowedRepositoryOwner = parseOwner(env.GATEWAY_ALLOWED_REPOSITORY_OWNER);
  const githubAppId = positiveInteger(env.GITHUB_APP_ID, "GITHUB_APP_ID", 1, Number.MAX_SAFE_INTEGER);
  const oauthClientId = env.GITHUB_OAUTH_CLIENT_ID;
  if (!oauthClientId || oauthClientId.length > 256 || /placeholder|example/i.test(oauthClientId)) {
    throw new TypeError("GITHUB_OAUTH_CLIENT_ID must be configured");
  }
  const oauthClientSecret = requireSecret(env.GITHUB_OAUTH_CLIENT_SECRET, "GITHUB_OAUTH_CLIENT_SECRET");
  const controlPlaneSecret = requireSecret(env.CONTROL_PLANE_GATEWAY_AUTH, "CONTROL_PLANE_GATEWAY_AUTH");
  const instanceAccessSecret = requireSecret(env.INSTANCE_ACCESS_SERVICE_AUTH_TOKEN, "INSTANCE_ACCESS_SERVICE_AUTH_TOKEN");
  const tokenKeyId = env.GATEWAY_TOKEN_ENCRYPTION_KEY_ID;
  if (!tokenKeyId || !/^[A-Za-z0-9_-]{1,64}$/.test(tokenKeyId)) throw new TypeError("GATEWAY_TOKEN_ENCRYPTION_KEY_ID is required");
  const rawTokenKey = decodeBase64Url(requireSecret(env.GATEWAY_TOKEN_ENCRYPTION_KEY, "GATEWAY_TOKEN_ENCRYPTION_KEY"));
  if (rawTokenKey.byteLength !== 32) throw new TypeError("GATEWAY_TOKEN_ENCRYPTION_KEY must decode to 32 bytes");
  const tokenKey = await importTokenEncryptionKey(rawTokenKey);
  const tokenVault = createTokenVault([{ id: tokenKeyId, key: tokenKey }], tokenKeyId);
  const sessionTtlSeconds = positiveInteger(env.GATEWAY_SESSION_TTL_SECONDS, "GATEWAY_SESSION_TTL_SECONDS", 600, 86_400);
  const handoffTtlSeconds = positiveInteger(env.GATEWAY_HANDOFF_TTL_SECONDS, "GATEWAY_HANDOFF_TTL_SECONDS", 1, 60);
  const accessGrantTtlSeconds = positiveInteger(env.GATEWAY_ACCESS_GRANT_TTL_SECONDS, "GATEWAY_ACCESS_GRANT_TTL_SECONDS", 1, 300);
  return {
    environment: env.GATEWAY_ENVIRONMENT ?? "production",
    origin,
    sessionTtlSeconds,
    handoffTtlSeconds,
    accessGrantTtlSeconds,
    instanceHostnameSuffix: parseHostnameSuffix(env.GATEWAY_INSTANCE_HOSTNAME_SUFFIX),
    allowedRepositoryOwner,
    githubAppId,
    oauthClientId,
    oauthClientSecret,
    controlPlaneSecret,
    instanceAccessSecret,
    sessionPepper: new TextEncoder().encode(requireSecret(env.GATEWAY_SESSION_DIGEST_PEPPER, "GATEWAY_SESSION_DIGEST_PEPPER")),
    credentialPepper: new TextEncoder().encode(requireSecret(env.GATEWAY_CREDENTIAL_DIGEST_PEPPER, "GATEWAY_CREDENTIAL_DIGEST_PEPPER")),
    handoffPepper: new TextEncoder().encode(requireSecret(env.GATEWAY_HANDOFF_DIGEST_PEPPER, "GATEWAY_HANDOFF_DIGEST_PEPPER")),
    tokenVault,
  };
}

function snapshotBinding(snapshot: Awaited<ReturnType<ControlPlaneClient["getByRepositoryId"]>>): GitHubRepositoryBinding | null {
  if (!snapshot) return null;
  return {
    repositoryId: snapshot.binding.repositoryId,
    installationId: snapshot.binding.installationId,
    owner: snapshot.binding.owner,
    name: snapshot.binding.name,
    instanceId: snapshot.binding.instanceId,
    runtimeEpoch: runtimeEpochForAccess(snapshot.instance),
    authorizationRevision: snapshot.binding.authorizationRevision,
    bindingEpoch: snapshot.binding.bindingEpoch,
    status: snapshot.binding.suspended ? "suspended" : "active",
  };
}

export async function createGatewayContext(env: GatewayEnv, requestId: string, now: string): Promise<GatewayContext> {
  if (!env.USER_AUTH_STATE || !env.EPHEMERAL_CODES || !env.GATEWAY_KV || !env.CONTROL_PLANE) {
    throw new TypeError("Gateway Durable Object, KV and Control Plane service bindings are required");
  }
  const config = await configFrom(env);
  const controlPlane = createControlPlaneClient(env.CONTROL_PLANE, config.controlPlaneSecret);
  const sessionIndex = createKvDigestUserIndex(env.GATEWAY_KV, "session");
  const credentialIndex = createKvDigestUserIndex(env.GATEWAY_KV, "credential");
  const sessionStore = createDurableObjectSessionStore(env.USER_AUTH_STATE, sessionIndex);
  const oauth = createGitHubAppOAuthProvider({ clientId: config.oauthClientId, clientSecret: config.oauthClientSecret, requestTimeoutMs: 5_000 });
  const githubUserTokens = createDurableObjectGitHubUserTokenStore(env.USER_AUTH_STATE, config.tokenVault, oauth);
  const githubApi = createGitHubAccessApi(createGitHubRestClient({ requestTimeoutMs: 5_000 }));
  const repositoryBindings = {
    async getByRepositoryId(repositoryId: number) {
      return snapshotBinding(await controlPlane.getByRepositoryId(repositoryId));
    },
  };
  const servicePolicy = {
    async allowsRepository(repository: { readonly owner: string }) {
      return repository.owner.toLowerCase() === config.allowedRepositoryOwner.toLowerCase();
    },
  };
  const githubAccess = createGitHubAccessProvider({
    appId: config.githubAppId,
    api: githubApi,
    userTokens: githubUserTokens,
    repositoryBindings,
    servicePolicy,
    instanceOriginFor: (instanceId) => `https://${instanceHostname(instanceId, config.instanceHostnameSuffix)}`,
  });
  const signingValue = requireSecret(env.GATEWAY_SIGNING_KEY, "GATEWAY_SIGNING_KEY");
  const signingConfig: unknown = JSON.parse(signingValue);
  if (!object(signingConfig) || typeof signingConfig["kid"] !== "string" || !object(signingConfig["privateKeyJwk"])) {
    throw new TypeError("Gateway signing key JSON is invalid");
  }
  const signingJwk = signingConfig["privateKeyJwk"] as unknown as JsonWebKey;
  if (signingJwk.kty !== "EC" || signingJwk.crv !== "P-256" || typeof signingJwk.x !== "string" || typeof signingJwk.y !== "string" || typeof signingJwk.d !== "string") {
    throw new TypeError("Gateway signing key must be a private P-256 key");
  }
  const signingKey: SigningKey = { kid: signingConfig["kid"], privateKey: await importPrivateKeyJwk(signingJwk) };
  const keyRegistry = validateRegistry(await loadKeyRegistry(env.GATEWAY_KV));
  if (!keyRegistry.some((record) => record.kid === signingKey.kid && record.status === "active" &&
    record.publicKeyJwk.x === signingJwk.x && record.publicKeyJwk.y === signingJwk.y)) {
    throw new TypeError("the active Gateway signing key must match its public key registry record");
  }

  if (env.GITHUB_APP_PRIVATE_KEY) {
    const retirementAuth = requireSecret(env.RUNTIME_CREDENTIAL_RETIREMENT_AUTH, "RUNTIME_CREDENTIAL_RETIREMENT_AUTH");
    if (!/^[\x21-\x7e]{32,4096}$/u.test(retirementAuth) ||
      retirementAuth === config.controlPlaneSecret || retirementAuth === config.instanceAccessSecret)
      throw new TypeError("Credential retirement requires a separate bounded service credential");
  }
  const runtimeCredentialRegistry = env.GITHUB_APP_PRIVATE_KEY ? createRuntimeCredentialRegistry({
    controlPlane: env.CONTROL_PLANE,
    controlPlaneGatewayAuth: config.controlPlaneSecret,
    tokenVault: config.tokenVault,
    revoker: createGitHubInstallationTokenRevoker({ client: createGitHubRestClient({ requestTimeoutMs: 1_000 }) }),
  }) : undefined;
  return {
    config,
    env,
    requestId,
    requestNow: now,
    sessionStore,
    loginAttemptStore: createDurableObjectLoginAttemptStore(env.EPHEMERAL_CODES),
    mcpCredentialStore: createDurableObjectMcpCredentialStore(env.USER_AUTH_STATE, credentialIndex),
    handoffStore: createDurableObjectHandoffCodeStore(env.EPHEMERAL_CODES),
    accessRefreshCredentialStore: createDurableObjectAccessRefreshCredentialStore(env.EPHEMERAL_CODES),
    tokenExchangeRateLimiter: createKvRateLimiter(env.GATEWAY_KV, "token-exchange", { limit: 20, windowSeconds: 60 }),
    runtimeCredentialRateLimiter: createKvRateLimiter(env.GATEWAY_KV, "runtime-git-credential", { limit: 120, windowSeconds: 60 }),
    loginRateLimiter: createKvRateLimiter(env.GATEWAY_KV, "login", { limit: 10, windowSeconds: 60 }),
    wakeRateLimiter: createKvRateLimiter(env.GATEWAY_KV, "wake", { limit: 10, windowSeconds: 60 }),
    mutationReceiptRateLimiter: createKvRateLimiter(env.GATEWAY_KV, "mutation-receipt", { limit: 10, windowSeconds: 60 }),
    githubProvider: oauth,
    githubAccess,
    ...(runtimeCredentialRegistry ? { runtimeCredentialRegistry } : {}),
    ...(env.GITHUB_APP_PRIVATE_KEY ? {
      githubCredentialBroker: createRuntimeGitCredentialBroker({
        controlPlane: env.CONTROL_PLANE,
        controlPlaneGatewayAuth: config.controlPlaneSecret,
        runtimeIdentityIssuer: HttpsOriginSchema.parse(env.CONTROL_PLANE_ORIGIN),
        gatewayOrigin: config.origin,
        githubAppId: config.githubAppId,
        githubAppPrivateKeyPem: requireSecret(env.GITHUB_APP_PRIVATE_KEY, "GITHUB_APP_PRIVATE_KEY"),
        repositoryBindings,
        accessProvider: githubAccess,
        gatewayKeyRegistry: keyRegistry,
        ...(runtimeCredentialRegistry ? { credentialLifecycle: runtimeCredentialRegistry } : {}),
      }),
    } : {}),
    githubUserTokens,
    controlPlane,
    signingKey,
    keyRegistry,
  };
}
