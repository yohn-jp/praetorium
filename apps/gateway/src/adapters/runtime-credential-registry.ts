import {
  RuntimeGitCredentialRecordSchema,
  RuntimeGitCredentialRegistrationSchema,
  type RuntimeGitCredentialRecord,
} from "@praetorium/contracts";
import type { TokenVault } from "@praetorium/auth";
import type { RuntimeIdentity } from "@praetorium/github";
import type { GitHubInstallationTokenRevoker, InstallationToken } from "@praetorium/github";
import { z } from "zod";

const CONTROL_PLANE_ORIGIN = "https://control-plane.internal";
const CONTROL_PLANE_GATEWAY_AUTH_HEADER = "X-Control-Plane-Gateway-Auth";
const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_TIMEOUT_MS = 5_000;
const SMALL_RESPONSE_BYTES = 4_096;
const PENDING_RESPONSE_BYTES = 300 * 1_024;
const MAX_REQUEST_BYTES = 64 * 1_024;
const MAX_PENDING_CREDENTIALS = 8;
const MAX_REVOCATION_CONCURRENCY = 4;

const RegistrationResponseSchema = z.strictObject({
  status: z.enum(["active", "revocation_pending", "revoked"]),
});
const PendingResponseSchema = z.strictObject({
  credentials: z.array(RuntimeGitCredentialRecordSchema).max(MAX_PENDING_CREDENTIALS),
  remaining: z.number().int().nonnegative().safe(),
});
const RevocationAcknowledgementSchema = z.strictObject({ revoked: z.literal(true) });

export interface RuntimeCredentialRegistryConfig {
  /** Statically bound Cloudflare service binding. No caller-supplied URL is accepted. */
  readonly controlPlane: Fetcher;
  readonly controlPlaneGatewayAuth: string;
  readonly tokenVault: TokenVault;
  readonly revoker: GitHubInstallationTokenRevoker;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

export interface RuntimeCredentialRetirementRequest {
  readonly repositoryId: number;
  readonly runtimeEpoch: number;
}

export interface RuntimeCredentialRegistry {
  recordIssued(identity: RuntimeIdentity, credential: InstallationToken): Promise<boolean>;
  retire(input: RuntimeCredentialRetirementRequest): Promise<{ readonly complete: boolean }>;
}

function validGatewayAuth(value: string): boolean {
  return (
    value.length >= 32 &&
    value.length <= 512 &&
    !/[^\x21-\x7e]/u.test(value) &&
    !/^(placeholder|changeme|example)/iu.test(value)
  );
}

function timeoutValue(value: number | undefined): number {
  const timeout = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS)
    throw new TypeError(
      `Control Plane timeout must be between 1 and ${MAX_TIMEOUT_MS} milliseconds`,
    );
  return timeout;
}

function abortError(): DOMException {
  return new DOMException("Control Plane request timed out", "AbortError");
}

async function boundedJson(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
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
  let readPending = false;
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortListener = () => reject(abortError());
    if (signal.aborted) abortListener();
    else signal.addEventListener("abort", abortListener, { once: true });
  });
  try {
    for (;;) {
      const read = reader.read().then(
        (result) => {
          readPending = false;
          return result;
        },
        (error: unknown) => {
          readPending = false;
          throw error;
        },
      );
      readPending = true;
      const { done, value } = await Promise.race([read, aborted]);
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) throw new TypeError("Control Plane response is too large");
      chunks.push(value);
    }
  } catch (error) {
    // Cancellation is best effort: the explicit race above bounds a stalled reader.
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    if (abortListener) signal.removeEventListener("abort", abortListener);
    if (!readPending) reader.releaseLock();
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

function credentialVaultContext(metadata: {
  readonly tokenId: string;
  readonly repositoryId: number;
  readonly installationId: number;
  readonly instanceId: string;
  readonly runtimeId: string;
  readonly runtimeEpoch: number;
  readonly leaseId: string;
  readonly permission: "read" | "write";
  readonly expiresAt: string;
}): string {
  // Keep the canonical tuple order stable. AES-GCM AAD binds ciphertext to the hash,
  // repository, installation, instance, runtime lease/epoch, permissions and expiry.
  return JSON.stringify([
    "praetorium-runtime-git-credential:v1",
    metadata.tokenId,
    metadata.repositoryId,
    metadata.installationId,
    metadata.instanceId,
    metadata.runtimeId,
    metadata.runtimeEpoch,
    metadata.leaseId,
    metadata.permission,
    metadata.expiresAt,
  ]);
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validIdentityAndCredential(
  identity: RuntimeIdentity,
  credential: InstallationToken,
  now: Date,
): boolean {
  const expiresAt = new Date(credential.expiresAt);
  return (
    Number.isSafeInteger(identity.repositoryId) &&
    identity.repositoryId > 0 &&
    Number.isSafeInteger(identity.installationId) &&
    identity.installationId > 0 &&
    Number.isSafeInteger(identity.runtimeEpoch) &&
    identity.runtimeEpoch > 0 &&
    identity.instanceId.length > 0 &&
    identity.instanceId.length <= 128 &&
    identity.runtimeId.length > 0 &&
    identity.runtimeId.length <= 128 &&
    identity.leaseId.length > 0 &&
    identity.leaseId.length <= 128 &&
    typeof credential.token === "string" &&
    credential.token.length > 0 &&
    credential.repositoryId === identity.repositoryId &&
    credential.installationId === identity.installationId &&
    (credential.permission === "read" || credential.permission === "write") &&
    Number.isFinite(expiresAt.getTime()) &&
    expiresAt.toISOString() === credential.expiresAt &&
    expiresAt.getTime() > now.getTime()
  );
}

/**
 * Tracks only encrypted GitHub installation credentials. Plaintext tokens are encrypted
 * before any Control Plane request and never enter a URL, request body or diagnostic.
 */
export function createRuntimeCredentialRegistry(
  config: RuntimeCredentialRegistryConfig,
): RuntimeCredentialRegistry {
  if (!validGatewayAuth(config.controlPlaneGatewayAuth))
    throw new TypeError("Control Plane Gateway authentication secret is required");
  const timeoutMs = timeoutValue(config.timeoutMs);
  const now = config.now ?? (() => new Date());

  async function postJson(
    path: string,
    body: unknown,
    maximumResponseBytes: number,
  ): Promise<unknown> {
    const payload = JSON.stringify(body);
    if (new TextEncoder().encode(payload).byteLength > MAX_REQUEST_BYTES)
      throw new TypeError("Control Plane request body is too large");
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(abortError());
      }, timeoutMs);
    });
    const request = (async () => {
      const response = await config.controlPlane.fetch(`${CONTROL_PLANE_ORIGIN}${path}`, {
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          [CONTROL_PLANE_GATEWAY_AUTH_HEADER]: config.controlPlaneGatewayAuth,
        },
        body: payload,
      });
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => undefined);
        throw abortError();
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new TypeError(
          `Control Plane credential request failed with status ${response.status}`,
        );
      }
      return await boundedJson(response, maximumResponseBytes, controller.signal);
    })();
    try {
      return await Promise.race([request, deadline]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  async function acknowledgeRevoked(tokenId: string): Promise<void> {
    const response = RevocationAcknowledgementSchema.parse(
      await postJson(`/internal/runtime-credentials/${tokenId}/revoked`, {}, SMALL_RESPONSE_BYTES),
    );
    if (!response.revoked)
      throw new TypeError("Control Plane did not confirm credential revocation");
  }

  async function revokeIssued(credential: InstallationToken, tokenId?: string): Promise<void> {
    await config.revoker.revoke(credential);
    if (tokenId) {
      try {
        await acknowledgeRevoked(tokenId);
      } catch {
        // A successful GitHub revoke is still not a durable registry acknowledgement.
        // Leave the Control Plane row pending for its idempotent retirement retry.
      }
    }
  }

  async function readPending(repositoryId: number, runtimeEpoch: number) {
    return PendingResponseSchema.parse(
      await postJson(
        "/internal/runtime-credentials/pending",
        { repositoryId, runtimeEpoch },
        PENDING_RESPONSE_BYTES,
      ),
    );
  }

  async function revokePending(record: RuntimeGitCredentialRecord): Promise<void> {
    if (record.status === "revoked") return;
    if (record.status !== "revocation_pending")
      throw new TypeError("credential is not pending revocation");
    const context = credentialVaultContext(record);
    const token = await config.tokenVault.open(record.encryptedSecret, context);
    if ((await sha256Hex(token)) !== record.tokenId)
      throw new TypeError("decrypted credential does not match its registry identifier");
    const credential: InstallationToken = {
      token,
      expiresAt: record.expiresAt,
      installationId: record.installationId,
      repositoryId: record.repositoryId,
      permission: record.permission,
    };
    await config.revoker.revoke(credential);
    await acknowledgeRevoked(record.tokenId);
  }

  return {
    async recordIssued(identity, credential) {
      let tokenId: string | undefined;
      let revocationAttempted = false;
      try {
        const issuedAt = now();
        if (
          !Number.isFinite(issuedAt.getTime()) ||
          !validIdentityAndCredential(identity, credential, issuedAt)
        )
          throw new TypeError("runtime identity and installation credential do not match");
        tokenId = await sha256Hex(credential.token);
        const metadata = {
          tokenId,
          repositoryId: identity.repositoryId,
          installationId: identity.installationId,
          instanceId: identity.instanceId,
          runtimeId: identity.runtimeId,
          runtimeEpoch: identity.runtimeEpoch,
          leaseId: identity.leaseId,
          permission: credential.permission,
          expiresAt: credential.expiresAt,
        } as const;
        const registration = RuntimeGitCredentialRegistrationSchema.parse({
          ...metadata,
          encryptedSecret: await config.tokenVault.seal(
            credential.token,
            credentialVaultContext(metadata),
          ),
        });
        const response = RegistrationResponseSchema.parse(
          await postJson("/internal/runtime-credentials", registration, SMALL_RESPONSE_BYTES),
        );
        if (response.status === "active") return true;
        if (response.status === "revoked") return false;
        revocationAttempted = true;
        await config.revoker.revoke(credential);
        try {
          await acknowledgeRevoked(tokenId);
        } catch {
          // Keep a durable pending row so the retirement worker can retry later.
        }
        return false;
      } catch (error) {
        // Minting happened before this hook. If durable registration failed, immediately
        // revoke the bearer and acknowledge it when a token identifier was derived.
        if (!revocationAttempted) {
          try {
            await revokeIssued(credential, tokenId);
          } catch {
            // Preserve the registry error and never let the broker return the raw token.
          }
        }
        throw error;
      }
    },

    async retire(input) {
      if (
        !Number.isSafeInteger(input.repositoryId) ||
        input.repositoryId <= 0 ||
        !Number.isSafeInteger(input.runtimeEpoch) ||
        input.runtimeEpoch <= 0
      )
        return { complete: false };

      let batch: z.infer<typeof PendingResponseSchema>;
      try {
        batch = await readPending(input.repositoryId, input.runtimeEpoch);
      } catch {
        return { complete: false };
      }

      let allRevoked = true;
      const seen = new Set<string>();
      const records = batch.credentials;
      if (
        records.some((record) => {
          if (
            record.repositoryId !== input.repositoryId ||
            record.runtimeEpoch !== input.runtimeEpoch
          )
            return true;
          if (seen.has(record.tokenId)) return true;
          seen.add(record.tokenId);
          return false;
        })
      )
        allRevoked = false;

      if (allRevoked) {
        let next = 0;
        const worker = async () => {
          for (;;) {
            const index = next++;
            if (index >= records.length) return;
            try {
              await revokePending(records[index]!);
            } catch {
              allRevoked = false;
            }
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(MAX_REVOCATION_CONCURRENCY, records.length) }, () =>
            worker(),
          ),
        );
      }

      let after: z.infer<typeof PendingResponseSchema>;
      try {
        after = await readPending(input.repositoryId, input.runtimeEpoch);
      } catch {
        return { complete: false };
      }
      return {
        complete: allRevoked && after.credentials.length === 0 && after.remaining === 0,
      };
    },
  };
}
