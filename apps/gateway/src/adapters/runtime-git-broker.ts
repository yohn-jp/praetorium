import {
  createMutationAuthorizationReceiptVerifier,
  importPublicKeyJwk,
  type FreshRepositoryAccessChecker,
  type KeyRecord,
} from "@praetorium/auth";
import {
  createGitCredentialBroker,
  createGitHubInstallationTokenIssuer,
  createGitHubRestClient,
  createRuntimeIdentityAuthenticator,
  GITHUB_PUBLISH_RECEIPT_AUDIENCE,
  type RepositoryBindingReader,
  type RuntimeBindingReader,
} from "@praetorium/github";
import { z } from "zod";

const CONTROL_PLANE_ORIGIN = "https://control-plane.internal";
const CONTROL_PLANE_GATEWAY_AUTH_HEADER = "X-Control-Plane-Gateway-Auth";
const DEFAULT_CONTROL_PLANE_TIMEOUT_MS = 3_000;
const MAX_CONTROL_PLANE_TIMEOUT_MS = 5_000;
const RUNTIME_BINDING_RESPONSE_BYTES = 4_096;
const RUNTIME_IDENTITY_JWKS_RESPONSE_BYTES = 16_384;

const RuntimeBindingMetadataSchema = z.strictObject({
  repositoryId: z.number().int().positive().safe(),
  installationId: z.number().int().positive().safe(),
  instanceId: z.string().min(1).max(128),
  runtimeId: z.string().min(1).max(128),
  runtimeEpoch: z.number().int().positive().safe(),
  leaseId: z.string().min(1).max(128),
  clusterId: z.string().min(1).max(128),
  active: z.literal(true),
  authority: z.enum(["observed-writer", "post-absence-target"]),
});

const RuntimeIdentityJwkSchema = z.strictObject({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  x: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  y: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  use: z.literal("sig"),
  alg: z.literal("ES256"),
  kid: z.string().min(1).max(128),
});

const RuntimeIdentityJwksSchema = z.strictObject({
  keys: z.array(RuntimeIdentityJwkSchema).max(8),
});

export interface RuntimeGitCredentialBrokerConfig {
  /** A statically bound Cloudflare service binding; URLs and hosts are not caller controlled. */
  readonly controlPlane: Fetcher;
  readonly controlPlaneGatewayAuth: string;
  /** Trusted Control Plane issuer expected in signed runtime identities. */
  readonly runtimeIdentityIssuer: string;
  /** Same exact HTTPS origin used to issue Gateway mutation receipts. */
  readonly gatewayOrigin: string;
  readonly githubAppId: number;
  readonly githubAppPrivateKeyPem: string;
  readonly repositoryBindings: RepositoryBindingReader;
  readonly accessProvider: FreshRepositoryAccessChecker;
  /** Public-only Gateway signing-key registry loaded by the trusted Gateway context. */
  readonly gatewayKeyRegistry: readonly KeyRecord[];
  readonly controlPlaneTimeoutMs?: number;
  readonly githubRequestTimeoutMs?: number;
  readonly githubFetchImpl?: typeof fetch;
  readonly now?: () => Date;
}

function trustedHttpsOrigin(value: string, name: string): string {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.origin !== value
  )
    throw new TypeError(`${name} must be an exact HTTPS origin`);
  return parsed.origin;
}

function validateTimeout(value: number | undefined, name: string, fallback: number): number {
  const timeout = value ?? fallback;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_CONTROL_PLANE_TIMEOUT_MS)
    throw new TypeError(`${name} must be between 1 and ${MAX_CONTROL_PLANE_TIMEOUT_MS} milliseconds`);
  return timeout;
}

async function boundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const contentLength = response.headers.get("Content-Length");
  if (contentLength !== null) {
    if (!/^(0|[1-9][0-9]*)$/u.test(contentLength) || Number(contentLength) > maximumBytes)
      throw new TypeError("Control Plane response size is invalid");
  }
  const contentType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new TypeError("Control Plane response is not JSON");
  const reader = response.body?.getReader();
  if (!reader) throw new TypeError("Control Plane response body is missing");

  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) throw new TypeError("Control Plane response is too large");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
  ) as unknown;
}

function createBoundedControlPlaneReader(
  binding: Fetcher,
  gatewayAuth: string,
  timeoutMs: number,
): {
  getRuntimeBinding(repositoryId: number): Promise<ReturnType<typeof RuntimeBindingMetadataSchema.parse> | null>;
  getRuntimeIdentityJwks(): Promise<ReturnType<typeof RuntimeIdentityJwksSchema.parse>>;
} {
  async function get(
    path: string,
    maximumBytes: number,
    authenticated: boolean,
    missingIsNull = false,
  ): Promise<unknown | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await binding.fetch(`${CONTROL_PLANE_ORIGIN}${path}`, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          ...(authenticated ? { [CONTROL_PLANE_GATEWAY_AUTH_HEADER]: gatewayAuth } : {}),
        },
      });
      if (response.status === 404 && missingIsNull) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new TypeError(`Control Plane read failed with status ${response.status}`);
      }
      return await boundedJson(response, maximumBytes);
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    async getRuntimeBinding(repositoryId) {
      if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) return null;
      const body = await get(
        `/internal/runtime-bindings/${repositoryId}`,
        RUNTIME_BINDING_RESPONSE_BYTES,
        true,
        true,
      );
      return body === null ? null : RuntimeBindingMetadataSchema.parse(body);
    },
    async getRuntimeIdentityJwks() {
      const body = await get(
        "/.well-known/runtime-identity-jwks.json",
        RUNTIME_IDENTITY_JWKS_RESPONSE_BYTES,
        false,
      );
      return RuntimeIdentityJwksSchema.parse(body);
    },
  };
}

/**
 * Composes the production broker from trusted Gateway providers and fixed Control Plane
 * service-binding reads. The runtime token issuer/transport remains a separate producer
 * integration; missing endpoint/key publication fails closed as broker unavailability.
 */
export function createRuntimeGitCredentialBroker(
  config: RuntimeGitCredentialBrokerConfig,
) {
  if (
    config.controlPlaneGatewayAuth.length < 32 ||
    config.controlPlaneGatewayAuth.length > 512 ||
    /[^\x21-\x7e]/u.test(config.controlPlaneGatewayAuth) ||
    /^(placeholder|changeme|example)/iu.test(config.controlPlaneGatewayAuth)
  )
    throw new TypeError("Control Plane Gateway authentication secret is required");
  if (!Number.isSafeInteger(config.githubAppId) || config.githubAppId < 1)
    throw new TypeError("GitHub App ID must be a positive integer");
  if (
    typeof config.githubAppPrivateKeyPem !== "string" ||
    config.githubAppPrivateKeyPem.length > 16_384 ||
    !/^-----BEGIN (RSA )?PRIVATE KEY-----[\s\S]+-----END \1PRIVATE KEY-----$/u.test(
      config.githubAppPrivateKeyPem.trim(),
    )
  )
    throw new TypeError("GitHub App private key PEM is required");
  trustedHttpsOrigin(config.runtimeIdentityIssuer, "Runtime identity issuer");
  const gatewayOrigin = trustedHttpsOrigin(config.gatewayOrigin, "Gateway origin");
  const controlPlaneTimeoutMs = validateTimeout(
    config.controlPlaneTimeoutMs,
    "Control Plane timeout",
    DEFAULT_CONTROL_PLANE_TIMEOUT_MS,
  );
  const githubRequestTimeoutMs = validateTimeout(
    config.githubRequestTimeoutMs,
    "GitHub request timeout",
    MAX_CONTROL_PLANE_TIMEOUT_MS,
  );
  const controlPlane = createBoundedControlPlaneReader(
    config.controlPlane,
    config.controlPlaneGatewayAuth,
    controlPlaneTimeoutMs,
  );
  const importedRuntimeKeys = new Map<string, Promise<CryptoKey>>();
  const runtimeAuthenticator = createRuntimeIdentityAuthenticator({
    issuer: config.runtimeIdentityIssuer,
    ...(config.now ? { now: config.now } : {}),
    async resolveKey(kid) {
      const jwks = await controlPlane.getRuntimeIdentityJwks();
      const jwk = jwks.keys.find((key) => key.kid === kid);
      if (!jwk) return null;
      let imported = importedRuntimeKeys.get(kid);
      if (!imported) {
        if (importedRuntimeKeys.size >= 8) {
          const oldestKid = importedRuntimeKeys.keys().next().value;
          if (oldestKid !== undefined) importedRuntimeKeys.delete(oldestKid);
        }
        imported = importPublicKeyJwk(jwk);
        importedRuntimeKeys.set(kid, imported);
      }
      try {
        return await imported;
      } catch {
        importedRuntimeKeys.delete(kid);
        throw new TypeError("Control Plane runtime identity key is invalid");
      }
    },
  });

  const importedReceiptKeys = new Map<string, Promise<CryptoKey>>();
  const receiptVerifier = createMutationAuthorizationReceiptVerifier({
    issuer: gatewayOrigin,
    audience: GITHUB_PUBLISH_RECEIPT_AUDIENCE,
    async resolveKey(kid) {
      const record = config.gatewayKeyRegistry.find(
        (candidate) => candidate.kid === kid && candidate.status !== "compromised",
      );
      if (!record) return null;
      let imported = importedReceiptKeys.get(kid);
      if (!imported) {
        if (importedReceiptKeys.size >= 8) {
          const oldestKid = importedReceiptKeys.keys().next().value;
          if (oldestKid !== undefined) importedReceiptKeys.delete(oldestKid);
        }
        imported = importPublicKeyJwk(record.publicKeyJwk);
        importedReceiptKeys.set(kid, imported);
      }
      try {
        return await imported;
      } catch {
        importedReceiptKeys.delete(kid);
        throw new TypeError("Gateway mutation receipt key is invalid");
      }
    },
  });

  const githubClient = createGitHubRestClient({
    requestTimeoutMs: githubRequestTimeoutMs,
    ...(config.githubFetchImpl ? { fetchImpl: config.githubFetchImpl } : {}),
  });
  const tokenIssuer = createGitHubInstallationTokenIssuer({
    appId: config.githubAppId,
    privateKeyPem: config.githubAppPrivateKeyPem,
    client: githubClient,
  });

  const runtimeBindings: RuntimeBindingReader = {
    async getCurrent(repositoryId) {
      const binding = await controlPlane.getRuntimeBinding(repositoryId);
      if (!binding) return null;
      return {
        repositoryId: binding.repositoryId,
        installationId: binding.installationId,
        instanceId: binding.instanceId,
        runtimeEpoch: binding.runtimeEpoch,
        leaseId: binding.leaseId,
        active: binding.active,
      };
    },
  };
  const brokerRepositoryBindings: RepositoryBindingReader = {
    async getByRepositoryId(repositoryId) {
      const repository = await config.repositoryBindings.getByRepositoryId(repositoryId);
      if (!repository) return null;
      // User authorization intentionally keeps the observed-current epoch. Broker identity,
      // however, may belong to a target runtime admitted after the old writer was fenced.
      const currentRuntime = await runtimeBindings.getCurrent(repositoryId);
      if (
        !currentRuntime ||
        currentRuntime.repositoryId !== repositoryId ||
        repository.repositoryId !== repositoryId ||
        currentRuntime.installationId !== repository.installationId ||
        currentRuntime.instanceId !== repository.instanceId
      )
        return null;
      return { ...repository, runtimeEpoch: currentRuntime.runtimeEpoch };
    },
  };

  return createGitCredentialBroker({
    runtimeAuthenticator,
    runtimeBindings,
    repositoryBindings: brokerRepositoryBindings,
    accessProvider: config.accessProvider,
    mutationReceiptVerifier: receiptVerifier,
    tokenIssuer,
    ...(config.now ? { now: config.now } : {}),
  });
}
