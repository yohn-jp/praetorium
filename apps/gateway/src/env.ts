export interface GatewayEnv {
  readonly USER_AUTH_STATE: DurableObjectNamespace;
  readonly EPHEMERAL_CODES: DurableObjectNamespace;
  readonly GATEWAY_KV: KVNamespace;
  readonly CONTROL_PLANE: Fetcher;
  readonly GATEWAY_ENVIRONMENT?: string;
  readonly GATEWAY_ORIGIN?: string;
  readonly GATEWAY_SESSION_TTL_SECONDS?: string;
  readonly GATEWAY_HANDOFF_TTL_SECONDS?: string;
  readonly GATEWAY_ACCESS_GRANT_TTL_SECONDS?: string;
  readonly GATEWAY_INSTANCE_HOSTNAME_SUFFIX?: string;
  readonly GATEWAY_ALLOWED_REPOSITORY_OWNER?: string;
  readonly GITHUB_APP_ID?: string;
  readonly GITHUB_APP_PRIVATE_KEY?: string;
  readonly CONTROL_PLANE_ORIGIN?: string;
  readonly RUNTIME_CREDENTIAL_RETIREMENT_AUTH?: string;
  readonly GATEWAY_GITHUB_WEBHOOK_SECRET?: string;
  readonly GITHUB_OAUTH_CLIENT_ID?: string;
  readonly GITHUB_OAUTH_CLIENT_SECRET?: string;
  readonly GATEWAY_SESSION_DIGEST_PEPPER?: string;
  readonly GATEWAY_CREDENTIAL_DIGEST_PEPPER?: string;
  readonly GATEWAY_HANDOFF_DIGEST_PEPPER?: string;
  readonly GATEWAY_TOKEN_ENCRYPTION_KEY?: string;
  readonly GATEWAY_TOKEN_ENCRYPTION_KEY_ID?: string;
  readonly GATEWAY_SIGNING_KEY?: string;
  readonly CONTROL_PLANE_GATEWAY_AUTH?: string;
  readonly INSTANCE_ACCESS_SERVICE_AUTH_TOKEN?: string;
}
