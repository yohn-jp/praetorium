import {
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
import { createWorkersRateLimiter } from "./adapters/rate-limiter-workers.js";
import { loadKeyRegistry } from "./adapters/key-registry-kv.js";
import { assertActiveSigningKeyRegistered, resolveActiveSigningKey } from "./adapters/signing-key.js";
import { resolveTokenVault } from "./adapters/token-vault.js";
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
  readonly tokenExchangeSourceRateLimiter: RateLimiter;
  readonly runtimeCredentialRateLimiter: RateLimiter;
  readonly loginRateLimiter: RateLimiter;
  readonly wakeRateLimiter: RateLimiter;
  readonly mutationReceiptRateLimiter: RateLimiter;
  readonly githubProvider: ReturnType<typeof createGitHubAppOAuthProvider>;
  readonly githubAccess: GitHubAccessProvider;
  /** Load public signing keys only on routes that sign, verify, or publish credentials. */
  readonly getKeyRegistry: () => Promise<readonly KeyRecord[]>;
  /** Require the current secret key to be the active key in the fresh registry. */
  readonly getSigningKey: () => Promise<SigningKey>;
  /** Set only when a trusted runtime authenticator and assignment reader are configured. */
  readonly getGitHubCredentialBroker: () => Promise<GitCredentialBroker | undefined>;
  readonly runtimeCredentialRegistry?: ReturnType<typeof createRuntimeCredentialRegistry>;
  readonly githubUserTokens: GitHubUserTokenSource & {
    storeEncrypted(subject: string, tokens: GitHubTokenResponse, issuedAt: string): Promise<void>;
  };
  readonly controlPlane: ControlPlaneClient;
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

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function configFrom(env: GatewayEnv): Promise<GatewayConfig> {
  const origin = parseOrigin(env.GATEWAY_ORIGIN);
  const environment = env.GATEWAY_ENVIRONMENT;
  if (!environment || !/^(production|preview|development|test)$/.test(environment))
    throw new TypeError("GATEWAY_ENVIRONMENT must explicitly identify the deployment environment");
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
  const tokenVault = await resolveTokenVault(
    tokenKeyId,
    requireSecret(env.GATEWAY_TOKEN_ENCRYPTION_KEY, "GATEWAY_TOKEN_ENCRYPTION_KEY"),
  );
  const sessionTtlSeconds = positiveInteger(env.GATEWAY_SESSION_TTL_SECONDS, "GATEWAY_SESSION_TTL_SECONDS", 600, 86_400);
  const handoffTtlSeconds = positiveInteger(env.GATEWAY_HANDOFF_TTL_SECONDS, "GATEWAY_HANDOFF_TTL_SECONDS", 1, 60);
  const accessGrantTtlSeconds = positiveInteger(env.GATEWAY_ACCESS_GRANT_TTL_SECONDS, "GATEWAY_ACCESS_GRANT_TTL_SECONDS", 1, 300);
  return {
    environment,
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
  if (!env.USER_AUTH_STATE || !env.EPHEMERAL_CODES || !env.GATEWAY_KV || !env.CONTROL_PLANE ||
    !env.LOGIN_RATE_LIMIT || !env.MCP_SOURCE_RATE_LIMIT || !env.MCP_CREDENTIAL_RATE_LIMIT ||
    !env.RUNTIME_GIT_RATE_LIMIT || !env.WAKE_RATE_LIMIT || !env.MUTATION_RECEIPT_RATE_LIMIT) {
    throw new TypeError("Gateway Durable Object, KV, Control Plane and Rate Limiting bindings are required");
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
  let keyRegistryPromise: Promise<readonly KeyRecord[]> | undefined;
  const getKeyRegistry = (): Promise<readonly KeyRecord[]> => {
    keyRegistryPromise ??= loadKeyRegistry(env.GATEWAY_KV);
    return keyRegistryPromise;
  };
  let signingKeyPromise: Promise<SigningKey> | undefined;
  const getSigningKey = (): Promise<SigningKey> => {
    signingKeyPromise ??= (async () => {
      const [signingKey, keyRegistry] = await Promise.all([
        resolveActiveSigningKey(signingValue),
        getKeyRegistry(),
      ]);
      assertActiveSigningKeyRegistered(signingKey, signingJwk, keyRegistry);
      return signingKey;
    })();
    return signingKeyPromise;
  };

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
  const githubAppPrivateKeyPem = env.GITHUB_APP_PRIVATE_KEY
    ? requireSecret(env.GITHUB_APP_PRIVATE_KEY, "GITHUB_APP_PRIVATE_KEY")
    : undefined;
  let githubCredentialBrokerPromise: Promise<GitCredentialBroker | undefined> | undefined;
  const getGitHubCredentialBroker = (): Promise<GitCredentialBroker | undefined> => {
    if (!githubAppPrivateKeyPem) return Promise.resolve(undefined);
    githubCredentialBrokerPromise ??= getKeyRegistry().then((keyRegistry) => createRuntimeGitCredentialBroker({
      controlPlane: env.CONTROL_PLANE,
      controlPlaneGatewayAuth: config.controlPlaneSecret,
      runtimeIdentityIssuer: HttpsOriginSchema.parse(env.CONTROL_PLANE_ORIGIN),
      gatewayOrigin: config.origin,
      githubAppId: config.githubAppId,
      githubAppPrivateKeyPem,
      repositoryBindings,
      accessProvider: githubAccess,
      gatewayKeyRegistry: keyRegistry,
      ...(runtimeCredentialRegistry ? { credentialLifecycle: runtimeCredentialRegistry } : {}),
    }));
    return githubCredentialBrokerPromise;
  };
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
    tokenExchangeRateLimiter: createWorkersRateLimiter(env.MCP_CREDENTIAL_RATE_LIMIT, config.environment),
    tokenExchangeSourceRateLimiter: createWorkersRateLimiter(env.MCP_SOURCE_RATE_LIMIT, config.environment),
    runtimeCredentialRateLimiter: createWorkersRateLimiter(env.RUNTIME_GIT_RATE_LIMIT, config.environment),
    loginRateLimiter: createWorkersRateLimiter(env.LOGIN_RATE_LIMIT, config.environment),
    wakeRateLimiter: createWorkersRateLimiter(env.WAKE_RATE_LIMIT, config.environment),
    mutationReceiptRateLimiter: createWorkersRateLimiter(env.MUTATION_RECEIPT_RATE_LIMIT, config.environment),
    githubProvider: oauth,
    githubAccess,
    getKeyRegistry,
    getSigningKey,
    getGitHubCredentialBroker,
    ...(runtimeCredentialRegistry ? { runtimeCredentialRegistry } : {}),
    githubUserTokens,
    controlPlane,
  };
}
