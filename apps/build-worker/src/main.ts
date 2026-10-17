import {
  BuildWorkerService,
  VerifiedBuildAttestor,
  loadFileBuilderSigner,
} from "@praetorium/application/builds";
import type { BuildCandidateVerifier, BuildQueuePort } from "@praetorium/application/builds";
import { GhcrCandidateVerifier, GhcrRegistryClient, requireSha256Digest } from "@praetorium/ghcr";
import type { CompositionArtifactInspector, RegistryCredential } from "@praetorium/ghcr";
import {
  BuildKitImageRootfsExporter,
  BuildKitProvider,
  readBuildKitRegistryCredential,
  validateBuildKitFiles,
} from "@praetorium/buildkit";
import type { BuildCandidateReceiptReader } from "@praetorium/buildkit";
import { pathToFileURL } from "node:url";
import { readBuildWorkerConfig } from "./config.js";
import { BuildQueueHttpClient, readBuildServiceToken } from "./http-client.js";
import { readRegistryPullCredential } from "./registry-credential.js";
import {
  ScriptoriumBuildCandidateReceiptReader,
  ScriptoriumCompositionArtifactInspector,
  type BuildKitRootfsExporter,
} from "./composition-artifacts.js";

export type BuildWorkerDependencies = {
  receiptReader?: BuildCandidateReceiptReader;
  compositionInspector?: CompositionArtifactInspector;
  rootfsExporter?: BuildKitRootfsExporter;
  registryCredential?: RegistryCredential;
  queue?: BuildQueuePort;
  signer?: Awaited<ReturnType<typeof loadFileBuilderSigner>>;
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
    registryOrigin.host === "ghcr.io"
      ? await readBuildKitRegistryCredential(config.buildKit, registryOrigin.host)
      : undefined;
  const registry = new GhcrRegistryClient({
    registryUrl: config.registryUrl,
    ...(config.registryAllowInsecureLoopback ? { allowInsecureLoopback: true } : {}),
    allowedRepositories: [outputRepository, compositionRepository],
    publishRepositories: [compositionRepository],
    maxImageLayerBytes: config.maxImageLayerBytes,
    maxImageVerificationMs: config.maxImageVerificationMs,
    maxRegistryRequestMs: config.maxRegistryRequestMs,
    maxMetadataBlobBytes: 4 * 1024 * 1024,
    ...(registryCredential ? { pullCredential: registryCredential } : {}),
    ...(publishCredential ? { publishCredential } : {}),
  });
  const rootfsExporter = dependencies.rootfsExporter ?? new BuildKitImageRootfsExporter(config.buildKit);
  const verifier = new GhcrCandidateVerifier(
    registry,
    dependencies.compositionInspector ?? new ScriptoriumCompositionArtifactInspector(registry, config.buildKit, { rootfsExporter }),
    undefined,
    config.maxImageVerificationMs,
  );
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
    { rootfsExporter },
  );
  const provider = new BuildKitProvider(config.buildKit, { receiptReader });
  return new BuildWorkerService(queue, provider, attestor, {
    workerId: config.workerId,
    leaseSeconds: config.leaseSeconds,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
  });
}

export async function main(): Promise<void> {
  const config = readBuildWorkerConfig();
  const worker = await createBuildWorker(process.env);
  const shutdown = new AbortController();
  const stop = (): void => {
    shutdown.abort();
    worker.stopCurrentBuild();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await worker.runUntilStopped(shutdown.signal, config.idleDelayMs);
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => {
    process.stderr.write("Build worker startup or shutdown failed\n");
    process.exitCode = 1;
  });
}
