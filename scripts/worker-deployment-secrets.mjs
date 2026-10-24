// Private input files for the existing Wrangler deployment, never a separate publisher.
import { writeFileSync } from "node:fs";
import path from "node:path";

export function writeWorkerDeploymentSecrets({
  directory,
  privateBytes,
  notificationsEnabled,
  hasReleaseOperatorToken,
  hasAdminCredential = false,
  hasObserverCredential = false,
}) {
  // Match the prior Wrangler secret-put stdin normalization exactly.
  const value = (role) => privateBytes(role).toString("utf8").trimEnd();
  const gateway = {
    INSTANCE_ACCESS_SERVICE_AUTH_TOKEN: value("instanceAccessServiceAuth"),
  };
  const control = {
    PROVISIONER_AUTH_TOKEN: value("controlPlaneCredential"),
    BUILD_WORKER_AUTH_TOKEN: value("buildWorkerControlPlaneAuth"),
    REGISTRY_PULL_CREDENTIAL: value("buildWorkerRegistryPull"),
    ...(notificationsEnabled
      ? {
          PROVISIONER_WORK_NOTIFICATION_TOKEN: value("provisionerWorkNotificationToken"),
          BUILD_WORK_NOTIFICATION_TOKEN: value("buildWorkerWorkNotificationToken"),
        }
      : {}),
    ...(hasReleaseOperatorToken ? { RELEASE_OPERATOR_TOKEN: value("releaseOperatorToken") } : {}),
    ...(hasAdminCredential ? { ADMIN_CONTROL_PLANE_AUTH: value("adminControlPlaneAuth") } : {}),
  };
  const files = {};
  const admin = hasAdminCredential ? {
    ADMIN_CONTROL_PLANE_AUTH: value("adminControlPlaneAuth"),
    ...(hasObserverCredential ? { ADMIN_OBSERVER_AUTH: value("adminObserverToken") } : {}),
  } : null;
  for (const [worker, secrets] of Object.entries({ gateway, control,
    ...(admin ? { admin } : {}),
  })) {
    files[worker] = path.join(directory, `${worker}-secrets.json`);
    writeFileSync(files[worker], JSON.stringify(secrets), { mode: 0o600, flag: "wx" });
  }
  return files;
}

export const remoteDisposableSecretRoles = Object.freeze([
  "t14GithubAppPrivateKey",
  "t14GithubOauthClientSecret",
  "t14GatewayGithubWebhookSecret",
  "t14GatewaySigningKey",
  "t14ControlPlaneGatewayAuth",
  "t14RuntimeCredentialRetirementAuth",
  "t14InstanceAccessServiceAuth",
  "t14GatewaySessionDigestPepper",
  "t14GatewayCredentialDigestPepper",
  "t14GatewayHandoffDigestPepper",
  "t14GatewayTokenEncryptionKey",
  "t14RuntimeControlSigningKey",
  "t14RuntimeIdentitySigningKey",
  "t14ProvisionerAuthToken",
  "t14BuildWorkerAuthToken",
  "t14RegistryPullCredential",
  "t14ReleaseOperatorToken",
]);

export function assertRemoteDisposableSecretMaterials(privateBytes) {
  const materials = remoteDisposableSecretRoles.map((role) => {
    const value = privateBytes(role);
    if (!Buffer.isBuffer(value) || value.length < 16 || value.length > 64 * 1024) {
      throw new Error(`${role} must be a distinct bounded test secret`);
    }
    return value.toString("base64");
  });
  if (new Set(materials).size !== materials.length) {
    throw new Error("remote-disposable secret materials must be distinct test values");
  }
  const tokenRoles = [
    "t14ControlPlaneGatewayAuth",
    "t14RuntimeCredentialRetirementAuth",
    "t14ProvisionerAuthToken",
    "t14BuildWorkerAuthToken",
    "t14ReleaseOperatorToken",
  ];
  const tokens = tokenRoles.map((role) => privateBytes(role));
  if (tokens.some((value) => value.length < 32 || value.length > 4096 ||
      value.some((byte) => byte < 0x21 || byte > 0x7e))) {
    throw new Error("remote-disposable service tokens must be bounded printable test values");
  }
}

/** Build only the test Gateway/Control Plane secret bundles from test-scoped files. */
export function writeRemoteDisposableWorkerDeploymentSecrets({ directory, privateBytes }) {
  const value = (role) => privateBytes(role).toString("utf8").trimEnd();
  const gateway = {
    GITHUB_APP_PRIVATE_KEY: value("t14GithubAppPrivateKey"),
    GITHUB_OAUTH_CLIENT_SECRET: value("t14GithubOauthClientSecret"),
    GATEWAY_GITHUB_WEBHOOK_SECRET: value("t14GatewayGithubWebhookSecret"),
    GATEWAY_SIGNING_KEY: value("t14GatewaySigningKey"),
    CONTROL_PLANE_GATEWAY_AUTH: value("t14ControlPlaneGatewayAuth"),
    RUNTIME_CREDENTIAL_RETIREMENT_AUTH: value("t14RuntimeCredentialRetirementAuth"),
    INSTANCE_ACCESS_SERVICE_AUTH_TOKEN: value("t14InstanceAccessServiceAuth"),
    GATEWAY_SESSION_DIGEST_PEPPER: value("t14GatewaySessionDigestPepper"),
    GATEWAY_CREDENTIAL_DIGEST_PEPPER: value("t14GatewayCredentialDigestPepper"),
    GATEWAY_HANDOFF_DIGEST_PEPPER: value("t14GatewayHandoffDigestPepper"),
    GATEWAY_TOKEN_ENCRYPTION_KEY: value("t14GatewayTokenEncryptionKey"),
  };
  const control = {
    CONTROL_PLANE_GATEWAY_AUTH: value("t14ControlPlaneGatewayAuth"),
    RUNTIME_CREDENTIAL_RETIREMENT_AUTH: value("t14RuntimeCredentialRetirementAuth"),
    RUNTIME_CONTROL_SIGNING_KEY: value("t14RuntimeControlSigningKey"),
    RUNTIME_IDENTITY_SIGNING_KEY: value("t14RuntimeIdentitySigningKey"),
    PROVISIONER_AUTH_TOKEN: value("t14ProvisionerAuthToken"),
    BUILD_WORKER_AUTH_TOKEN: value("t14BuildWorkerAuthToken"),
    REGISTRY_PULL_CREDENTIAL: value("t14RegistryPullCredential"),
    RELEASE_OPERATOR_TOKEN: value("t14ReleaseOperatorToken"),
  };
  const files = {};
  for (const [worker, secrets] of Object.entries({ gateway, control })) {
    files[worker] = path.join(directory, `${worker}-secrets.json`);
    writeFileSync(files[worker], JSON.stringify(secrets), { mode: 0o600, flag: "wx" });
  }
  return files;
}
