import { describe, expect, it } from "vitest";
import { issueRuntimeIdentityCredential } from "@praetorium/auth";
import { createRuntimeIdentityAuthenticator } from "../src/runtime-identity-authenticator.js";
import type { RuntimeIdentityProof } from "../src/types.js";

const NOW = "2026-10-17T00:00:10.000Z";
const CLAIMS = {
  runtimeId: "res_runtime-4",
  instanceId: "ins_repository-7",
  repositoryId: 7001,
  installationId: 9001,
  runtimeEpoch: 4,
  leaseId: "res_runtime-4",
};

describe("GitHub runtime identity authenticator", () => {
  it("authenticates only the cryptographically signed service token", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const issued = await issueRuntimeIdentityCredential(
      { kid: "runtime-key-1", privateKey: pair.privateKey },
      { ...CLAIMS, issuer: "https://control.example.test", now: NOW, ttlSeconds: 120 },
    );
    const authenticator = createRuntimeIdentityAuthenticator({
      issuer: "https://control.example.test",
      resolveKey: async (kid) => (kid === "runtime-key-1" ? pair.publicKey : null),
      now: () => new Date(NOW),
    });
    const proof: RuntimeIdentityProof = { ...CLAIMS, serviceToken: issued.token };

    await expect(authenticator.authenticate(proof)).resolves.toEqual(CLAIMS);
    for (const [field, value] of [
      ["runtimeId", "res_other"],
      ["instanceId", "ins_other"],
      ["repositoryId", 7002],
      ["installationId", 9002],
      ["runtimeEpoch", 5],
      ["leaseId", "lease_other"],
    ] as const) {
      await expect(authenticator.authenticate({ ...proof, [field]: value })).resolves.toBeNull();
    }

    const [header, payload, signature] = issued.token.split(".");
    const forged = `${header}.${payload}.${signature?.slice(0, -1)}${signature?.endsWith("A") ? "B" : "A"}`;
    await expect(
      authenticator.authenticate({ ...proof, serviceToken: forged }),
    ).resolves.toBeNull();
  });

  it("does not fall back to caller-posted fields when the key or token is invalid", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const issued = await issueRuntimeIdentityCredential(
      { kid: "runtime-key-1", privateKey: pair.privateKey },
      { ...CLAIMS, issuer: "https://control.example.test", now: NOW, ttlSeconds: 120 },
    );
    const proof: RuntimeIdentityProof = { ...CLAIMS, serviceToken: issued.token };
    const noKeys = createRuntimeIdentityAuthenticator({
      issuer: "https://control.example.test",
      resolveKey: async () => null,
      now: () => new Date(NOW),
    });
    const unavailable = createRuntimeIdentityAuthenticator({
      issuer: "https://control.example.test",
      resolveKey: async () => {
        throw new Error("key store offline");
      },
      now: () => new Date(NOW),
    });

    await expect(noKeys.authenticate(proof)).resolves.toBeNull();
    await expect(unavailable.authenticate(proof)).rejects.toThrow(
      "verification keys are unavailable",
    );
    await expect(
      noKeys.authenticate({ ...proof, serviceToken: "static-shared-token" }),
    ).resolves.toBeNull();
  });
});
