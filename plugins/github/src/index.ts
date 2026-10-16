import type { AccessProvider } from "@praetorium/contracts";
import type { MutationAuthorizationReceiptVerifier } from "@praetorium/auth";
import { createGitHubAccessApi, createGitHubRestClient } from "./api.js";
import { createGitHubAccessProvider } from "./access.js";
import { createGitCredentialBroker } from "./credential-broker.js";
import { createGitHubInstallationTokenIssuer } from "./installation-token.js";
import { createGitHubAppOAuthProvider } from "./oauth.js";
import { verifyAndClaimGitHubWebhook } from "./webhooks.js";
import type {
  GitHubAccessProvider,
  GitHubServicePolicy,
  GitHubUserTokenSource,
  InstanceOriginResolver,
  RepositoryBindingReader,
  RuntimeBindingReader,
  RuntimeIdentityAuthenticator,
} from "./types.js";
import type { GitHubWebhookDeliveryStore, GitHubWebhookInput } from "./webhooks.js";

export * from "./types.js";
export * from "./api.js";
export * from "./access.js";
export * from "./oauth.js";
export * from "./app-jwt.js";
export * from "./installation-token.js";
export * from "./runtime-identity-authenticator.js";
export * from "./credential-broker.js";
export * from "./webhooks.js";

export interface GitHubAppPluginConfig {
  readonly appId: number;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly privateKeyPem: string;
  readonly webhookSecret: string;
  readonly requestTimeoutMs: number;
  readonly userTokens: GitHubUserTokenSource;
  readonly repositoryBindings: RepositoryBindingReader;
  readonly runtimeAuthenticator: RuntimeIdentityAuthenticator;
  readonly runtimeBindings: RuntimeBindingReader;
  readonly mutationReceiptVerifier: MutationAuthorizationReceiptVerifier;
  readonly webhookDeliveries: GitHubWebhookDeliveryStore;
  readonly servicePolicy: GitHubServicePolicy;
  readonly instanceOriginFor: InstanceOriginResolver;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
}

export interface GitHubAppPlugin {
  readonly oauth: ReturnType<typeof createGitHubAppOAuthProvider>;
  readonly access: GitHubAccessProvider & AccessProvider;
  readonly credentialBroker: ReturnType<typeof createGitCredentialBroker>;
  verifyAndClaimWebhook(input: GitHubWebhookInput): ReturnType<typeof verifyAndClaimGitHubWebhook>;
}

/** Static composition for the trusted Gateway credential service. */
export function createGitHubAppPlugin(config: GitHubAppPluginConfig): GitHubAppPlugin {
  const client = createGitHubRestClient({
    requestTimeoutMs: config.requestTimeoutMs,
    ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
  });
  const access = createGitHubAccessProvider({
    appId: config.appId,
    api: createGitHubAccessApi(client),
    userTokens: config.userTokens,
    repositoryBindings: config.repositoryBindings,
    servicePolicy: config.servicePolicy,
    instanceOriginFor: config.instanceOriginFor,
    ...(config.now ? { now: config.now } : {}),
  });
  const tokenIssuer = createGitHubInstallationTokenIssuer({
    appId: config.appId,
    privateKeyPem: config.privateKeyPem,
    client,
  });
  return {
    oauth: createGitHubAppOAuthProvider({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      requestTimeoutMs: config.requestTimeoutMs,
      ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
      ...(config.now ? { now: config.now } : {}),
    }),
    access,
    credentialBroker: createGitCredentialBroker({
      runtimeAuthenticator: config.runtimeAuthenticator,
      runtimeBindings: config.runtimeBindings,
      repositoryBindings: config.repositoryBindings,
      accessProvider: access,
      mutationReceiptVerifier: config.mutationReceiptVerifier,
      tokenIssuer,
      ...(config.now ? { now: config.now } : {}),
    }),
    verifyAndClaimWebhook: (input) =>
      verifyAndClaimGitHubWebhook(config.webhookSecret, config.webhookDeliveries, input),
  };
}
