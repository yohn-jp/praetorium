import { describe, expect, it } from "vitest";
import { createMutationAuthorizationReceiptVerifier } from "@praetorium/auth";
import { createGitCredentialBroker } from "../src/credential-broker.js";
import type { InstallationToken } from "../src/installation-token.js";
import type { RuntimeIdentity, RuntimeIdentityProof } from "../src/types.js";

const identity: RuntimeIdentity = {
  runtimeId: "rt_01",
  instanceId: "ins_01",
  repositoryId: 1001,
  installationId: 71,
  runtimeEpoch: 4,
  leaseId: "lease_01",
};
const proof: RuntimeIdentityProof = {
  serviceToken: "runtime-secret",
  ...identity,
};
const token: InstallationToken = {
  token: "opaque-install-token",
  expiresAt: "2026-10-17T01:00:00.000Z",
  installationId: 71,
  repositoryId: 1001,
  permission: "read",
};

function broker(input: {
  readonly recordIssued: (identity: RuntimeIdentity, token: InstallationToken) => Promise<boolean>;
  readonly events: string[];
}) {
  return createGitCredentialBroker({
    runtimeAuthenticator: { authenticate: async () => identity },
    runtimeBindings: {
      getCurrent: async () => ({
        repositoryId: identity.repositoryId,
        installationId: identity.installationId,
        instanceId: identity.instanceId,
        runtimeEpoch: identity.runtimeEpoch,
        leaseId: identity.leaseId,
        active: true,
      }),
    },
    repositoryBindings: {
      getByRepositoryId: async () => ({
        repositoryId: identity.repositoryId,
        installationId: identity.installationId,
        owner: "org",
        name: "sample",
        instanceId: identity.instanceId,
        runtimeEpoch: identity.runtimeEpoch,
        authorizationRevision: 12,
        bindingEpoch: 3,
        status: "active",
      }),
    },
    accessProvider: { checkBoundAccess: async () => ({ status: "denied" }) },
    mutationReceiptVerifier: createMutationAuthorizationReceiptVerifier({
      issuer: "https://gateway.example.test",
      audience: "praetorium-git-publisher",
      resolveKey: async () => null,
    }),
    tokenIssuer: {
      issue: async () => {
        input.events.push("minted");
        return token;
      },
    },
    credentialLifecycle: { recordIssued: input.recordIssued },
    now: () => new Date("2026-10-17T00:00:00.000Z"),
  });
}

describe("Git credential durable lifecycle hook", () => {
  it("waits for durable registration before returning a minted token", async () => {
    const events: string[] = [];
    const service = broker({
      events,
      recordIssued: async (actualIdentity, actualToken) => {
        events.push("registered");
        expect(actualIdentity).toEqual(identity);
        expect(actualToken).toBe(token);
        return true;
      },
    });

    const result = await service.issue({ proof, operation: "fetch" });
    expect(events).toEqual(["minted", "registered"]);
    expect(result).toMatchObject({ status: "issued", credential: { token: token.token } });
  });

  it("denies the token when the durable registry reports a retired runtime", async () => {
    const events: string[] = [];
    const result = await broker({
      events,
      recordIssued: async () => {
        events.push("registered");
        return false;
      },
    }).issue({ proof, operation: "fetch" });

    expect(events).toEqual(["minted", "registered"]);
    expect(result).toEqual({ status: "denied", reason: "runtime_retired" });
    expect("credential" in result).toBe(false);
  });

  it("fails unavailable when durable registration throws and never returns the token", async () => {
    const events: string[] = [];
    const result = await broker({
      events,
      recordIssued: async () => {
        events.push("registration-failed");
        throw new Error("registry unavailable");
      },
    }).issue({ proof, operation: "fetch" });

    expect(events).toEqual(["minted", "registration-failed"]);
    expect(result).toEqual({ status: "unavailable", reason: "runtime_credential_registry_unavailable" });
    expect("credential" in result).toBe(false);
  });
});
