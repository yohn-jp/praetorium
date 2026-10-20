import { physicalInstanceId } from "@praetorium/contracts";
import { z } from "zod";
import {
  base64UrlEncode,
  constantTimeEqual,
  issueRuntimeControlCredential,
} from "@praetorium/auth";
import type { OperationService } from "@praetorium/application/operations";
import type { InstanceService } from "@praetorium/application/instances";

const AUDIENCE = "praetorium-runtime-control";
export const IssueControlCredentialInputSchema = z.strictObject({
  operationId: z.string().min(1).max(128),
  workerId: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/u),
  leaseToken: z.string().min(32).max(256),
  leaseEpoch: z.number().int().nonnegative(),
  instanceId: z.string().min(1).max(128),
  repositoryId: z.number().int().positive().safe(),
  runtimeEpoch: z.number().int().positive(),
  action: z.enum(["status", "quiesce", "resume"]),
  payloadDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  ttlSeconds: z.number().int().min(1).max(60).optional(),
});
export const IssueObservationCredentialInputSchema = z.strictObject({
  operationId: z.string().min(1).max(128),
  workerId: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/u),
  clusterId: z.string().min(1).max(128),
  instanceId: z.string().min(1).max(128),
  repositoryId: z.number().int().positive().safe(),
  expectedGeneration: z.number().int().nonnegative(),
  runtimeEpoch: z.number().int().positive(),
});
const EMPTY_BODY_SHA256 = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const ALLOWED_PRIVATE_JWK_MEMBERS = new Set([
  "kty",
  "crv",
  "x",
  "y",
  "d",
  "alg",
  "use",
  "key_ops",
  "ext",
]);

export interface ControlPlaneSigningKey {
  readonly kid: string;
  readonly privateKeyJwk: JsonWebKey;
}

export interface ControlCredentialIssuerConfig {
  readonly operations: Pick<OperationService, "getById">;
  readonly instances: Pick<InstanceService, "getByInstanceId">;
  /** Must check all pending, claimed and running operations for this instance. */
  readonly hasActiveOperation?: (instanceId: string) => Promise<boolean>;
  readonly issuerOrigin: string;
  readonly signingKey: ControlPlaneSigningKey;
  readonly now?: () => number;
}

export interface IssueControlCredentialInput {
  readonly operationId: string;
  readonly workerId: string;
  readonly leaseToken: string;
  readonly leaseEpoch: number;
  readonly instanceId: string;
  readonly repositoryId: number;
  readonly runtimeEpoch: number;
  readonly action: "status" | "quiesce" | "resume";
  readonly payloadDigest: string;
  readonly ttlSeconds?: number;
}

export interface IssueObservationCredentialInput {
  readonly operationId: string;
  readonly workerId: string;
  readonly clusterId: string;
  readonly instanceId: string;
  readonly repositoryId: number;
  readonly expectedGeneration: number;
  readonly runtimeEpoch: number;
}

export interface IssuedControlCredential {
  readonly token: string;
  readonly expiresAt: string;
}

export interface ControlJwksDocument {
  readonly keys: readonly {
    readonly kty: "EC";
    readonly crv: "P-256";
    readonly x: string;
    readonly y: string;
    readonly use: "sig";
    readonly alg: "ES256";
    readonly kid: string;
  }[];
}

export interface ControlCredentialIssuer {
  issue(input: IssueControlCredentialInput): Promise<IssuedControlCredential>;
  issueObservation(input: IssueObservationCredentialInput): Promise<IssuedControlCredential>;
  jwks(): Promise<ControlJwksDocument>;
}

/** Builds the isolated operator signer used only for short-lived runtime-control tokens. */
export function createControlCredentialIssuer(
  config: ControlCredentialIssuerConfig,
): ControlCredentialIssuer {
  const issuer = trustedOrigin(config.issuerOrigin);
  const kid = validateSigningKey(config.signingKey);
  const keySetupPromise = crypto.subtle
    .importKey(
      "jwk",
      config.signingKey.privateKeyJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign"],
    )
    .then(async (privateKey) => {
      const exported = await crypto.subtle.exportKey("jwk", privateKey);
      if (
        exported.kty !== "EC" ||
        exported.crv !== "P-256" ||
        typeof exported.x !== "string" ||
        typeof exported.y !== "string"
      )
        throw new TypeError("operator signing key did not yield a public P-256 key");
      return {
        privateKey,
        jwks: {
          keys: [
            {
              kty: "EC" as const,
              crv: "P-256" as const,
              x: exported.x,
              y: exported.y,
              use: "sig" as const,
              alg: "ES256" as const,
              kid,
            },
          ],
        },
      };
    })
    .then(
      (value) => ({ ok: true as const, value }),
      () => ({ ok: false as const }),
    );
  const loadKeySetup = async () => {
    const result = await keySetupPromise;
    if (!result.ok) throw new TypeError("operator private key could not be imported");
    return result.value;
  };
  const now = config.now ?? Date.now;

  return {
    async issue(untrustedInput) {
      const input = IssueControlCredentialInputSchema.parse(untrustedInput);
      const nowMs = now();
      if (!Number.isSafeInteger(nowMs) || nowMs < 0)
        throw new TypeError("runtime control issuance clock is invalid");

      const operation = await config.operations.getById(input.operationId);
      if (!operation) throw denied();
      const snapshot = await config.instances.getByInstanceId(input.instanceId);
      if (!snapshot) throw denied();

      const observedRuntimeEpoch = snapshot.instance.observedRuntimeEpoch;
      const leaseTokenMatches =
        operation.leaseToken !== null &&
        (await equalLeaseToken(operation.leaseToken, input.leaseToken));
      if (
        operation.id !== input.operationId ||
        operation.instanceId !== input.instanceId ||
        operation.repositoryId !== input.repositoryId ||
        operation.workerId !== input.workerId ||
        !leaseTokenMatches ||
        operation.leaseEpoch !== input.leaseEpoch ||
        operation.leaseExpiresAt === null ||
        operation.leaseExpiresAt <= nowMs ||
        (operation.status !== "claimed" && operation.status !== "running") ||
        operation.generation !== snapshot.instance.generation ||
        snapshot.instance.instanceId !== input.instanceId ||
        snapshot.instance.repositoryId !== input.repositoryId ||
        snapshot.binding.instanceId !== input.instanceId ||
        snapshot.binding.repositoryId !== input.repositoryId ||
        snapshot.binding.suspended ||
        (input.runtimeEpoch !== operation.runtimeEpoch &&
          input.runtimeEpoch !== observedRuntimeEpoch)
      )
        throw denied();

      const issuedAt = Math.floor(nowMs / 1000);
      const leaseExpirySecond = Math.floor(operation.leaseExpiresAt / 1000);
      const leaseBoundTtl = leaseExpirySecond - issuedAt;
      const ttlSeconds = Math.min(input.ttlSeconds ?? 60, 60, leaseBoundTtl);
      if (ttlSeconds < 1) throw denied();

      const issued = await issueRuntimeControlCredential(
        { kid, privateKey: (await loadKeySetup()).privateKey },
        {
          issuer,
          audience: AUDIENCE,
          subject: "praetorium-control-plane",
          instanceId: physicalInstanceId(
            input.instanceId,
            input.runtimeEpoch,
            snapshot.instance.legacyRuntimeEpoch,
          ),
          repositoryId: input.repositoryId,
          runtimeEpoch: input.runtimeEpoch,
          operationId: input.operationId,
          action: input.action,
          payloadDigest: input.payloadDigest,
          now: new Date(nowMs).toISOString(),
          ttlSeconds,
        },
      );
      return {
        token: issued.token,
        expiresAt: new Date(issued.descriptor.exp * 1000).toISOString(),
      };
    },
    async issueObservation(untrustedInput) {
      const input = IssueObservationCredentialInputSchema.parse(untrustedInput);
      const nowMs = now();
      if (!Number.isSafeInteger(nowMs) || nowMs < 0)
        throw new TypeError("runtime control issuance clock is invalid");
      if (!config.hasActiveOperation) throw denied();

      const snapshot = await config.instances.getByInstanceId(input.instanceId);
      const instance = snapshot?.instance;
      const matchesObservedAssignment =
        instance?.observedGeneration === input.expectedGeneration &&
        instance.observedRuntimeEpoch === input.runtimeEpoch;
      const matchesDesiredAssignment =
        instance?.generation === input.expectedGeneration &&
        instance.runtimeEpoch === input.runtimeEpoch &&
        matchesObservedAssignment;
      const matchesRetainedObservedAssignment =
        matchesObservedAssignment &&
        instance.generation >= input.expectedGeneration &&
        instance.runtimeEpoch >= input.runtimeEpoch &&
        (instance.generation > input.expectedGeneration ||
          instance.runtimeEpoch > input.runtimeEpoch) &&
        instance.observedRevisionId !== null &&
        instance.currentArtifactDigest !== null;
      if (
        !snapshot ||
        snapshot.instance.instanceId !== input.instanceId ||
        snapshot.instance.repositoryId !== input.repositoryId ||
        snapshot.binding.instanceId !== input.instanceId ||
        snapshot.binding.repositoryId !== input.repositoryId ||
        snapshot.binding.suspended ||
        (!matchesDesiredAssignment && !matchesRetainedObservedAssignment) ||
        snapshot.instance.observedState !== "ready" ||
        snapshot.instance.desiredState !== "running" ||
        snapshot.instance.clusterId !== input.clusterId ||
        (await config.hasActiveOperation(input.instanceId))
      )
        throw denied();

      const issued = await issueRuntimeControlCredential(
        { kid, privateKey: (await loadKeySetup()).privateKey },
        {
          issuer,
          audience: AUDIENCE,
          subject: "praetorium-control-plane",
          instanceId: physicalInstanceId(
            input.instanceId,
            input.runtimeEpoch,
            snapshot.instance.legacyRuntimeEpoch,
          ),
          repositoryId: input.repositoryId,
          runtimeEpoch: input.runtimeEpoch,
          operationId: input.operationId,
          action: "status",
          payloadDigest: EMPTY_BODY_SHA256,
          now: new Date(nowMs).toISOString(),
          ttlSeconds: 30,
        },
      );
      return {
        token: issued.token,
        expiresAt: new Date(issued.descriptor.exp * 1000).toISOString(),
      };
    },
    async jwks() {
      return (await loadKeySetup()).jwks;
    },
  };
}

function trustedOrigin(value: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new TypeError("Control Plane origin is required");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Control Plane origin is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new TypeError("Control Plane origin must be a trusted HTTPS origin");
  return url.origin;
}

function validateSigningKey(value: ControlPlaneSigningKey): string {
  if (!value || typeof value !== "object") throw new TypeError("operator signing key is required");
  if (typeof value.kid !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(value.kid))
    throw new TypeError("operator signing key id is invalid");
  const key = value.privateKeyJwk as JsonWebKey & Record<string, unknown>;
  if (!key || typeof key !== "object" || Array.isArray(key))
    throw new TypeError("operator private JWK is required");
  if (Object.keys(key).some((member) => !ALLOWED_PRIVATE_JWK_MEMBERS.has(member)))
    throw new TypeError("operator JWK contains unsupported key material");
  if (
    key.kty !== "EC" ||
    key.crv !== "P-256" ||
    typeof key.x !== "string" ||
    !key.x ||
    typeof key.y !== "string" ||
    !key.y ||
    typeof key.d !== "string" ||
    !key.d ||
    (key.alg !== undefined && key.alg !== "ES256") ||
    (key.use !== undefined && key.use !== "sig") ||
    (key.ext !== undefined && key.ext !== true) ||
    (key.key_ops !== undefined &&
      (!Array.isArray(key.key_ops) || key.key_ops.length !== 1 || key.key_ops[0] !== "sign"))
  )
    throw new TypeError("operator private key must be a strict P-256 ES256 signing key");
  return value.kid;
}

async function equalLeaseToken(stored: string, presented: string): Promise<boolean> {
  const encode = new TextEncoder();
  const [storedDigest, presentedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encode.encode(stored)),
    crypto.subtle.digest("SHA-256", encode.encode(presented)),
  ]);
  return constantTimeEqual(
    base64UrlEncode(new Uint8Array(storedDigest)),
    base64UrlEncode(new Uint8Array(presentedDigest)),
  );
}

function denied(): Error {
  const error = new Error("runtime control credential issuance is fenced");
  Object.assign(error, { code: "CONTROL_CREDENTIAL_FENCED" });
  return error;
}
