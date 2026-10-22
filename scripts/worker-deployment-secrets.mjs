// Private input files for the existing Wrangler deployment, never a separate publisher.
import { writeFileSync } from "node:fs";
import path from "node:path";

export function writeWorkerDeploymentSecrets({
  directory,
  privateBytes,
  notificationsEnabled,
  hasReleaseOperatorToken,
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
  };
  const files = {};
  for (const [worker, secrets] of Object.entries({ gateway, control })) {
    files[worker] = path.join(directory, `${worker}-secrets.json`);
    writeFileSync(files[worker], JSON.stringify(secrets), { mode: 0o600, flag: "wx" });
  }
  return files;
}
