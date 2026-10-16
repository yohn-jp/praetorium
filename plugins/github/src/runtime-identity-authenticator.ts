import {
  createRuntimeIdentityCredentialVerifier,
  type RuntimeIdentityCredentialVerifierConfig,
} from "@praetorium/auth";
import type {
  RuntimeIdentity,
  RuntimeIdentityAuthenticator,
  RuntimeIdentityProof,
} from "./types.js";

export interface SignedRuntimeIdentityAuthenticatorConfig
  extends RuntimeIdentityCredentialVerifierConfig {
  readonly now?: () => Date;
}

/** Authenticates provisioner-issued service identities without trusting proof fields as claims. */
export function createRuntimeIdentityAuthenticator(
  config: SignedRuntimeIdentityAuthenticatorConfig,
): RuntimeIdentityAuthenticator {
  const verifier = createRuntimeIdentityCredentialVerifier(config);
  const now = config.now ?? (() => new Date());

  return {
    async authenticate(proof: RuntimeIdentityProof): Promise<RuntimeIdentity | null> {
      if (
        !proof ||
        typeof proof !== "object" ||
        typeof proof.serviceToken !== "string" ||
        typeof proof.runtimeId !== "string" ||
        typeof proof.instanceId !== "string" ||
        !Number.isSafeInteger(proof.repositoryId) ||
        proof.repositoryId <= 0 ||
        !Number.isSafeInteger(proof.installationId) ||
        proof.installationId <= 0 ||
        !Number.isSafeInteger(proof.runtimeEpoch) ||
        proof.runtimeEpoch <= 0 ||
        typeof proof.leaseId !== "string"
      )
        return null;

      const instant = now();
      if (!(instant instanceof Date) || !Number.isFinite(instant.getTime())) return null;
      const result = await verifier.verify(proof.serviceToken, {
        runtimeId: proof.runtimeId,
        instanceId: proof.instanceId,
        repositoryId: proof.repositoryId,
        installationId: proof.installationId,
        runtimeEpoch: proof.runtimeEpoch,
        leaseId: proof.leaseId,
        now: instant.toISOString(),
      });
      if (!result.ok) {
        if (result.error.code === "KEY_SOURCE_UNAVAILABLE")
          throw new Error("runtime identity verification keys are unavailable");
        return null;
      }

      const identity: RuntimeIdentity = {
        runtimeId: result.value.runtimeId,
        instanceId: result.value.instanceId,
        repositoryId: result.value.repositoryId,
        installationId: result.value.installationId,
        runtimeEpoch: result.value.runtimeEpoch,
        leaseId: result.value.leaseId,
      };
      if (
        identity.runtimeId !== proof.runtimeId ||
        identity.instanceId !== proof.instanceId ||
        identity.repositoryId !== proof.repositoryId ||
        identity.installationId !== proof.installationId ||
        identity.runtimeEpoch !== proof.runtimeEpoch ||
        identity.leaseId !== proof.leaseId
      )
        return null;
      return identity;
    },
  };
}
