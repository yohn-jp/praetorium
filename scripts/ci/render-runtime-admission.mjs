#!/usr/bin/env node
// Synthetic, non-publishable CI input. Tests the REAL tenant manifest renderer
// against a disposable Kubernetes API. This is not a production deployment.
import {
  createKubernetesResourceRenderer,
  parseRuntimeInstanceId,
  parseRuntimeReleaseId,
  parseRuntimeRepositoryId,
} from "../../plugins/kubernetes/dist/index.js";

const INSTANCE = parseRuntimeInstanceId("ins_00000000000000000000000001");
const REPOSITORY = parseRuntimeRepositoryId(731);
const INDEX = `sha256:${"a".repeat(64)}`;
const PLATFORM = `sha256:${"b".repeat(64)}`;
const COMPOSITION = `sha256:${"c".repeat(64)}`;
const request = { cpuMilli: 500, memoryMiB: 512, ephemeralStorageMiB: 512 };
const control = "https://control.praetorium.example.test";
const gateway = "https://gateway.praetorium.example.test";
const hostname = "731.scriptorium.yohn.jp";
const policy = {
  grantPolicy: {
    issuer: gateway,
    jwksUrl: `${gateway}/.well-known/jwks.json`,
    audience: `https://${hostname}`,
  },
  controlServicePolicy: {
    issuer: control,
    jwksUrl: `${control}/.well-known/control-jwks.json`,
    audience: "praetorium-runtime-control",
  },
};
const spec = {
  instanceId: INSTANCE,
  repositoryId: REPOSITORY,
  generation: 2,
  runtimeEpoch: 5,
  clusterId: "ci-owned-cluster",
  release: {
    releaseId: parseRuntimeReleaseId("revision-ci-5"),
    artifactRef: `ghcr.io/praetorium/ci-runtime@${INDEX}`,
    imageDigest: INDEX,
    platformManifestDigest: PLATFORM,
  },
  resourceProfile: { id: "small", request },
  hostname,
  runtimeConfig: {},
  application: {
    httpPort: 3847,
    livenessPath: "/health/live",
    readinessPath: "/health/ready",
    metadataPath: "/api/platform/v1/metadata",
    shutdownPath: "/api/platform/v1/shutdown",
    shutdownTimeoutSeconds: 25,
    platformControlPaths: {
      status: "/api/platform/v1/status",
      quiesce: "/api/platform/v1/quiesce",
      resume: "/api/platform/v1/resume",
    },
  },
  scriptoriumAssignment: {
    contractVersion: "scriptorium-platform/v1",
    instanceId: INSTANCE,
    repositoryId: REPOSITORY,
    repositoryLocator: "https://github.com/operator/owned-ci",
    defaultBranchPolicy: "follow-default",
    runtimeEpoch: 5,
    imageDigest: INDEX,
    compositionManifestDigest: COMPOSITION,
    enabledModuleIds: ["story"],
    credentialBrokerLocator: `${gateway}/internal/github/credential`,
    ...policy,
  },
  // Fake signed syntax only: this fixture is not a real, runnable Runtime.
  runtimeIdentityProof: "eyJhbGciOiJFUzI1NiJ9.eyJleHAiOjk5OTk5OTk5OTl9.signature",
};
const renderer = createKubernetesResourceRenderer({
  namespacePrefix: "praetorium-instances",
  clusterId: spec.clusterId,
  ingressNamespace: "traefik",
  instanceAccessNamespace: "praetorium-system",
  instanceAccessService: "instance-access",
  controlNamespace: "praetorium-system",
  controlService: "provisioner",
  maximumResources: { cpuMilli: 2_000, memoryMiB: 4_096, ephemeralStorageMiB: 8_192 },
  includeImagePullSecret: true,
});
const rendered = renderer.renderRunning(spec);
const kindSet = new Set(rendered.map(({ kind }) => kind));
for (const required of [
  "ServiceAccount",
  "Service",
  "Deployment",
  "Secret",
  "NetworkPolicy",
  "LimitRange",
  "ResourceQuota",
]) {
  if (!kindSet.has(required)) throw new Error(`tenant render lacks ${required}`);
}
if (rendered.some(({ kind }) => kind === "IngressRoute"))
  throw new Error("unactivated runtime must not render a public IngressRoute");
process.stdout.write(JSON.stringify({ apiVersion: "v1", kind: "List", items: rendered }) + "\n");
