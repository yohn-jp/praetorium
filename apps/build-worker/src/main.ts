import {
  BuildWorkerService,
  VerifiedBuildAttestor,
  loadFileBuilderSigner,
} from "@praetorium/application/builds";
import type { BuildCandidateVerifier, BuildQueuePort } from "@praetorium/application/builds";
import { WorkAvailability } from "@praetorium/application";
import { GhcrCandidateVerifier, GhcrRegistryClient, requireSha256Digest } from "@praetorium/ghcr";
import type { RegistryCredential } from "@praetorium/ghcr";
import {
  BuildKitImageFileExporter,
  BuildKitProvider,
  readBuildKitRegistryCredential,
  validateBuildKitFiles,
} from "@praetorium/buildkit";
import type { BuildCandidateReceiptReader } from "@praetorium/buildkit";
import { pathToFileURL } from "node:url";
import { readBuildWorkerConfig } from "./config.js";
import { BuildQueueHttpClient, readBuildServiceToken } from "./http-client.js";
import { SourceReleaseBuildWorker } from "./source-release-worker.js";
import { readRegistryPullCredential } from "./registry-credential.js";
import {
  closeBuildWorkNotificationServer,
  startBuildWorkNotificationServer,
} from "./work-notification-server.js";
import {
  ScriptoriumBuildCandidateReceiptReader,
  type BuildKitFileExporter,
} from "./composition-artifacts.js";

export type BuildWorkerDependencies = {
  receiptReader?: BuildCandidateReceiptReader;
  fileExporter?: BuildKitFileExporter;
  registryCredential?: RegistryCredential;
  queue?: BuildQueuePort;
  signer?: Awaited<ReturnType<typeof loadFileBuilderSigner>>;
  workAvailability?: WorkAvailability;
};

function repositoryPath(repository: string, registryHost: string): string {
  const prefix = `${registryHost}/`;
  if (!repository.startsWith(prefix))
    throw new TypeError("Build worker registry repositories do not match the configured origin");
  const path = repository.slice(prefix.length);
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/u.test(path)) {
    throw new TypeError("Build worker registry repository is invalid");
  }
  return path;
}

function reusesRegistryCredential(token: string, credential: RegistryCredential): boolean {
  const pair = `${credential.username}:${credential.password}`;
  return (
    token === credential.username ||
    token === credential.password ||
    token === pair ||
    token === Buffer.from(pair, "utf8").toString("base64")
  );
}

export async function createBuildWorker(
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: BuildWorkerDependencies = {},
): Promise<BuildWorkerService> {
  const config = readBuildWorkerConfig(environment);
  await validateBuildKitFiles(config.buildKit);
  const registryOrigin = new URL(config.registryUrl);
  const outputRepository = repositoryPath(config.buildKit.outputRepository, registryOrigin.host);
  const compositionRepository = config.compositionRepository;
  const serviceToken = await readBuildServiceToken(config.serviceTokenFile);
  const signer =
    dependencies.signer ??
    (await loadFileBuilderSigner({
      privateKeyPath: config.signingKeyFile,
      keyId: config.signingKeyId,
    }));
  const registryCredential =
    dependencies.registryCredential ??
    (config.registryPullCredentialFile
      ? await readRegistryPullCredential(config.registryPullCredentialFile)
      : undefined);
  const publishCredential =
    config.registryAllowAnonymousLoopbackPublish
      ? undefined
      : await readBuildKitRegistryCredential(config.buildKit, registryOrigin.host);
  if (
    config.notificationToken !== undefined &&
    (config.notificationToken === serviceToken ||
      (registryCredential !== undefined &&
        reusesRegistryCredential(config.notificationToken, registryCredential)) ||
      (publishCredential !== undefined &&
        reusesRegistryCredential(config.notificationToken, publishCredential)))
  ) {
    throw new TypeError("Build worker credentials must remain separate");
  }
  const registry = new GhcrRegistryClient({
    registryUrl: config.registryUrl,
    ...(config.registryAllowInsecureLoopback ? { allowInsecureLoopback: true } : {}),
    allowedRepositories: [outputRepository, compositionRepository],
    publishRepositories: [compositionRepository],
    ...(config.registryAllowAnonymousLoopbackPublish ? { allowAnonymousLoopbackPublish: true } : {}),
    maxImageLayerBytes: config.maxImageLayerBytes,
    maxImageVerificationMs: config.maxImageVerificationMs,
    maxRegistryRequestMs: config.maxRegistryRequestMs,
    maxMetadataBlobBytes: 8 * 1024 * 1024,
    ...(registryCredential ? { pullCredential: registryCredential } : {}),
    ...(publishCredential ? { publishCredential } : {}),
  });
  const fileExporter = dependencies.fileExporter ?? new BuildKitImageFileExporter(config.buildKit);
  const verifier = new GhcrCandidateVerifier(registry);
  const candidateVerifier: BuildCandidateVerifier = {
    verify: async ({ buildKey, expected, candidate, signal }) => {
      const expectedImagePrefix = `${registryOrigin.host}/${outputRepository}@`;
      if (!candidate.candidateRef.startsWith(expectedImagePrefix)) {
        throw new TypeError("candidate is outside the configured output repository");
      }
      if (candidate.compositionManifest.repository !== compositionRepository) {
        throw new TypeError("composition receipt is outside the configured repository");
      }
      return verifier.verifyUnsignedCandidate(
        {
          expectedInput: expected,
          expectedBuildKey: requireSha256Digest(buildKey),
          candidateRef: candidate.candidateRef,
          manifestDigest: requireSha256Digest(candidate.manifestDigest),
          compositionManifest: {
            repository: candidate.compositionManifest.repository,
            digest: requireSha256Digest(candidate.compositionManifest.digest),
          },
        },
        {
          registryHost: registryOrigin.host,
          repository: outputRepository,
        },
        signal,
      );
    },
  };
  const attestor = new VerifiedBuildAttestor(candidateVerifier, signer);
  const queue =
    dependencies.queue ??
    new BuildQueueHttpClient({
      baseUrl: config.controlPlaneUrl,
      serviceToken,
      requestTimeoutMs: config.requestTimeoutMs,
      maxResponseBytes: config.maxResponseBytes,
      leaseSeconds: config.leaseSeconds,
    });
  const receiptReader = dependencies.receiptReader ?? new ScriptoriumBuildCandidateReceiptReader(
    registry,
    config.buildKit,
    compositionRepository,
    { fileExporter },
  );
  const provider = new BuildKitProvider(config.buildKit, { receiptReader });
  return new BuildWorkerService(queue, provider, attestor, {
    workerId: config.workerId,
    leaseSeconds: config.leaseSeconds,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    ...(dependencies.workAvailability ? { workAvailability: dependencies.workAvailability } : {}),
  });
}

export async function main(): Promise<void> {
  const config = readBuildWorkerConfig();
  const workAvailability = new WorkAvailability();
  const worker = await createBuildWorker(process.env, { workAvailability });
  const sourceWorker = new SourceReleaseBuildWorker(config, new BuildQueueHttpClient({
    baseUrl: config.controlPlaneUrl,
    serviceToken: await readBuildServiceToken(config.serviceTokenFile),
    requestTimeoutMs: config.requestTimeoutMs,
    sourceReportTimeoutMs: Math.max(
      config.requestTimeoutMs,
      config.maxImageVerificationMs + 2 * config.maxRegistryRequestMs,
    ),
    maxResponseBytes: config.maxResponseBytes,
    leaseSeconds: config.leaseSeconds,
  }));
  const notificationServer = config.notificationEnabled
    ? await startBuildWorkNotificationServer(config, workAvailability)
    : undefined;
  const shutdown = new AbortController();
  const stop = (): void => {
    shutdown.abort();
    worker.stopCurrentBuild();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    while(!shutdown.signal.aborted){
      let didWork=false;
      try {didWork=await sourceWorker.runOnce(shutdown.signal);}
      catch { process.stderr.write("Source build loop failed; queued work will be rechecked.\n"); }
      if(shutdown.signal.aborted)break;
      try {didWork=(await worker.runOnce(shutdown.signal))||didWork;}
      catch { /* The durable Build queue is retried after a bounded wait. */ }
      if(!didWork&&!shutdown.signal.aborted)
        await workAvailability.wait(shutdown.signal,config.reconciliationIntervalMs);
    }
  } finally {
    if (notificationServer) await closeBuildWorkNotificationServer(notificationServer);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => {
    process.stderr.write("Build worker startup or shutdown failed\n");
    process.exitCode = 1;
  });
}
