import { describe, expect, it } from "vitest";
import type { OperationRecord, RepositorySnapshot } from "@praetorium/application/instances";
import {
  createControlCredentialIssuer,
  type ControlCredentialIssuerConfig,
  type IssueControlCredentialInput,
} from "./control-credentials.js";

const NOW = Date.parse("2026-10-17T00:00:10.000Z");
const ISSUER = "https://control.example.test";
const INSTANCE_ID = "ins_01";
const REPOSITORY_ID = 1001;
const OPERATION_ID = "op_01";
const WORKER_ID = "worker-a";
const LEASE_TOKEN = "a".repeat(64);
const PAYLOAD_DIGEST = `sha256:${"b".repeat(64)}`;

function operation(overrides: Partial<OperationRecord> = {}): OperationRecord {
  return {
    id: OPERATION_ID,
    instanceId: INSTANCE_ID,
    generation: 8,
    runtimeEpoch: 5,
    kind: "redeploy",
    status: "running",
    attempt: 2,
    leaseEpoch: 4,
    reportSequence: 1,
    leaseExpiresAt: NOW + 25_000,
    repositoryId: REPOSITORY_ID,
    clusterId: "cluster-a",
    reservationId: "reservation-a",
    deploymentRevisionId: "revision-a",
    buildId: null,
    prerequisiteBuildId: null,
    idempotencyKey: "request-a",
    phase: "starting-target",
    workerId: WORKER_ID,
    leaseToken: LEASE_TOKEN,
    requestHash: "request-hash",
    checkpointSequence: 0,
    checkpoint: null,
    result: null,
    createdAt: NOW - 10_000,
    updatedAt: NOW,
    ...overrides,
  };
}

function repositorySnapshot(
  overrides: {
    readonly binding?: Partial<RepositorySnapshot["binding"]>;
    readonly instance?: Partial<RepositorySnapshot["instance"]>;
  } = {},
): RepositorySnapshot {
  return {
    binding: {
      repositoryId: REPOSITORY_ID,
      instanceId: INSTANCE_ID,
      installationId: 77,
      owner: "praetorium",
      name: "demo",
      authorizationRevision: 3,
      bindingEpoch: 2,
      suspended: false,
      ...overrides.binding,
    },
    instance: {
      instanceId: INSTANCE_ID,
      repositoryId: REPOSITORY_ID,
      generation: 8,
      runtimeEpoch: 5,
      desiredState: "running",
      policy: "stable",
      observedGeneration: 8,
      currentArtifactDigest: PAYLOAD_DIGEST,
      desiredArtifactDigest: PAYLOAD_DIGEST,
      observedState: "ready",
      observedRuntimeEpoch: 4,
      observedSequence: 12,
      desiredRevisionId: "revision-a",
      observedRevisionId: "revision-a",
      reservationState: "allocated",
      reservationId: "reservation-a",
      clusterId: "cluster-a",
      createdAt: NOW - 100_000,
      updatedAt: NOW,
      ...overrides.instance,
    },
  };
}

function validInput(
  overrides: Partial<IssueControlCredentialInput> = {},
): IssueControlCredentialInput {
  return {
    operationId: OPERATION_ID,
    workerId: WORKER_ID,
    leaseToken: LEASE_TOKEN,
    leaseEpoch: 4,
    instanceId: INSTANCE_ID,
    repositoryId: REPOSITORY_ID,
    runtimeEpoch: 5,
    action: "resume",
    payloadDigest: PAYLOAD_DIGEST,
    ...overrides,
  };
}

async function createSigningKey() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  return {
    publicKey: pair.publicKey,
    privateKeyJwk: await crypto.subtle.exportKey("jwk", pair.privateKey),
  };
}

async function harness(
  options: {
    readonly now?: number;
    readonly operation?: Partial<OperationRecord>;
    readonly binding?: Partial<RepositorySnapshot["binding"]>;
    readonly instance?: Partial<RepositorySnapshot["instance"]>;
  } = {},
) {
  const signingKey = await createSigningKey();
  const claim = operation(options.operation);
  const snapshot = repositorySnapshot({
    ...(options.binding ? { binding: options.binding } : {}),
    ...(options.instance ? { instance: options.instance } : {}),
  });
  const config: ControlCredentialIssuerConfig = {
    operations: { getById: async (id) => (id === claim.id ? claim : null) },
    instances: {
      getByInstanceId: async (id) => (id === snapshot.instance.instanceId ? snapshot : null),
    },
    issuerOrigin: ISSUER,
    signingKey: { kid: "operator-2026-01", privateKeyJwk: signingKey.privateKeyJwk },
    now: () => options.now ?? NOW,
  };
  return {
    issuer: createControlCredentialIssuer(config),
    config,
    signingKey,
  };
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

describe("Control Plane runtime-control credential issuer", () => {
  it("issues a signature bound to the active fenced operation and caps expiry at the lease", async () => {
    const h = await harness();
    const issued = await h.issuer.issue(validInput());
    const jwks = await h.issuer.jwks();
    const publicJwk = jwks.keys[0]!;
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      publicJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const [header, payload, signature] = issued.token.split(".") as [string, string, string];
    const claims = JSON.parse(new TextDecoder().decode(decodeBase64Url(payload))) as Record<
      string,
      unknown
    >;

    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        publicKey,
        asArrayBuffer(decodeBase64Url(signature)),
        new TextEncoder().encode(`${header}.${payload}`),
      ),
    ).toBe(true);
    expect(claims).toMatchObject({
      iss: ISSUER,
      sub: "praetorium-control-plane",
      aud: "praetorium-runtime-control",
      instanceId: INSTANCE_ID,
      repositoryId: REPOSITORY_ID,
      runtimeEpoch: 5,
      operationId: OPERATION_ID,
      action: "resume",
      payloadDigest: PAYLOAD_DIGEST,
      exp: Math.floor(NOW / 1000) + 25,
    });
    expect(issued.expiresAt).toBe(new Date((Math.floor(NOW / 1000) + 25) * 1000).toISOString());
  });

  it("allows only the operation target or current observed runtime epoch", async () => {
    const h = await harness();
    await expect(
      h.issuer.issue(validInput({ runtimeEpoch: 4, action: "quiesce" })),
    ).resolves.toHaveProperty("token");
    await expect(h.issuer.issue(validInput({ runtimeEpoch: 3 }))).rejects.toMatchObject({
      code: "CONTROL_CREDENTIAL_FENCED",
    });
  });

  it("rejects stale or mismatched operation fence, repository, instance, and generation", async () => {
    const defaults = await harness();
    const staleCases: Array<{
      readonly operation?: Partial<OperationRecord>;
      readonly input?: Partial<IssueControlCredentialInput>;
      readonly instance?: Partial<RepositorySnapshot["instance"]>;
      readonly binding?: Partial<RepositorySnapshot["binding"]>;
    }> = [
      { operation: { workerId: "worker-b" } },
      { operation: { leaseEpoch: 3 } },
      { operation: { leaseToken: "c".repeat(64) } },
      { operation: { leaseExpiresAt: NOW } },
      { operation: { status: "succeeded" } },
      { operation: { generation: 7 } },
      { input: { repositoryId: 1002 } },
      { input: { instanceId: "ins_other" } },
      { input: { runtimeEpoch: 6 } },
      { instance: { generation: 7 } },
      { binding: { suspended: true } },
    ];

    for (const stale of staleCases) {
      const operationRecord = operation(stale.operation);
      const snapshot = repositorySnapshot({
        ...(stale.instance ? { instance: stale.instance } : {}),
        ...(stale.binding ? { binding: stale.binding } : {}),
      });
      await expect(
        createControlCredentialIssuer({
          ...defaults.config,
          operations: {
            getById: async (id) => (id === operationRecord.id ? operationRecord : null),
          },
          instances: {
            getByInstanceId: async (id) =>
              id === INSTANCE_ID || stale.input?.instanceId === id ? snapshot : null,
          },
        }).issue(validInput(stale.input)),
      ).rejects.toMatchObject({ code: "CONTROL_CREDENTIAL_FENCED" });
    }
  });

  it("rejects leases too close to expiry to issue a one-second token", async () => {
    const h = await harness({ operation: { leaseExpiresAt: NOW + 999 } });
    await expect(h.issuer.issue(validInput())).rejects.toMatchObject({
      code: "CONTROL_CREDENTIAL_FENCED",
    });
  });

  it("publishes only an allowlisted public JWK and rejects missing or malformed operator keys/origin", async () => {
    const h = await harness();
    const jwks = await h.issuer.jwks();
    expect(jwks.keys).toHaveLength(1);
    expect(Object.keys(jwks.keys[0]!).sort()).toEqual([
      "alg",
      "crv",
      "kid",
      "kty",
      "use",
      "x",
      "y",
    ]);
    expect(jwks.keys[0]).toMatchObject({ kty: "EC", crv: "P-256", alg: "ES256", use: "sig" });
    expect(jwks.keys[0]).not.toHaveProperty("d");
    expect(jwks.keys[0]).not.toHaveProperty("key_ops");

    expect(() => createControlCredentialIssuer({ ...h.config, issuerOrigin: "" })).toThrow(
      "origin is required",
    );
    expect(() =>
      createControlCredentialIssuer({ ...h.config, signingKey: undefined as never }),
    ).toThrow("operator signing key is required");
    expect(() =>
      createControlCredentialIssuer({
        ...h.config,
        signingKey: {
          kid: "operator-2026-01",
          privateKeyJwk: { ...h.config.signingKey.privateKeyJwk, crv: "P-384" },
        },
      }),
    ).toThrow("strict P-256");
    expect(() =>
      createControlCredentialIssuer({
        ...h.config,
        signingKey: {
          kid: "operator-2026-01",
          privateKeyJwk: { ...h.config.signingKey.privateKeyJwk, p: "private-leak" },
        },
      }),
    ).toThrow("unsupported key material");
  });
});
