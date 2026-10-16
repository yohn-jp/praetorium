import { z } from "zod";

export const ScriptoriumBuildContractVersion = z.literal("scriptorium-build/v1");
export const ScriptoriumPlatformContractVersion = z.literal("scriptorium-platform/v1");

const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const ProducerRevisionSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
const ModuleIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
const NonNegativeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const PositiveIntegerSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const NonEmptyStringSchema = z.string().min(1).max(512);
const AbsolutePathSchema = z.string().regex(/^\/(?!\/)[^\r\n?#]*$/u);

function unique<T>(items: readonly T[]): boolean {
  return new Set(items).size === items.length;
}

const UniqueModuleIdsSchema = z
  .array(ModuleIdSchema)
  .max(256)
  .refine(unique, "module IDs must be unique");
const ResourceAmountsSchema = z.strictObject({
  cpuMilli: NonNegativeIntegerSchema,
  memoryMiB: NonNegativeIntegerSchema,
  ephemeralStorageMiB: NonNegativeIntegerSchema,
});

const WorkerLimitsSchema = z.record(
  z.string().regex(/^[a-z][a-zA-Z0-9]{0,63}$/u),
  NonNegativeIntegerSchema,
);

const BuildModuleSchema = z.strictObject({
  id: ModuleIdSchema,
  version: NonEmptyStringSchema,
  artifactDigest: Sha256DigestSchema,
  requires: UniqueModuleIdsSchema,
  conflicts: UniqueModuleIdsSchema,
  contractRange: NonEmptyStringSchema,
  exclusiveResources: ResourceAmountsSchema,
  sharedResourceGroupIds: z
    .array(ModuleIdSchema)
    .max(256)
    .refine(unique, "shared resource group IDs must be unique"),
  workerLimits: WorkerLimitsSchema,
});
export type BuildModule = z.infer<typeof BuildModuleSchema>;

const ResourceProfileSchema = z.strictObject({
  id: ModuleIdSchema,
  ...ResourceAmountsSchema.shape,
});

/** Versioned producer catalog. Unknown fields fail closed until the contract is revised. */
export const BuildCatalogSchema = z.strictObject({
  contractVersion: ScriptoriumBuildContractVersion,
  producerRevision: ProducerRevisionSchema,
  runtimeBaseDigest: Sha256DigestSchema,
  buildKitDigest: Sha256DigestSchema,
  recipeDigest: Sha256DigestSchema,
  lockDigest: Sha256DigestSchema,
  sourceDigest: Sha256DigestSchema,
  supportedPlatforms: z
    .array(z.string().regex(/^[a-z0-9][a-z0-9._-]{0,31}\/[a-z0-9][a-z0-9._-]{0,31}$/u))
    .min(1)
    .max(32)
    .refine(unique, "platforms must be unique"),
  modules: z
    .array(BuildModuleSchema)
    .max(256)
    .refine((modules) => unique(modules.map(({ id }) => id)), "module IDs must be unique"),
  baseResources: ResourceAmountsSchema,
  sharedResourceGroups: z
    .array(z.strictObject({ id: ModuleIdSchema, resources: ResourceAmountsSchema }))
    .max(256)
    .refine(
      (groups) => unique(groups.map(({ id }) => id)),
      "shared resource group IDs must be unique",
    ),
  resourceProfiles: z
    .array(ResourceProfileSchema)
    .max(256)
    .refine(
      (profiles) => unique(profiles.map(({ id }) => id)),
      "resource profile IDs must be unique",
    ),
});
export type BuildCatalog = z.infer<typeof BuildCatalogSchema>;

const MetadataPathSchema = z.strictObject({
  liveness: AbsolutePathSchema,
  readiness: AbsolutePathSchema,
  metadata: AbsolutePathSchema,
  shutdown: AbsolutePathSchema,
  status: z.literal("/api/platform/v1/status"),
  quiesce: z.literal("/api/platform/v1/quiesce"),
  resume: z.literal("/api/platform/v1/resume"),
});

/** Producer-declared paths and listener values; the adapter does not infer them from a source image. */
export const RuntimeMetadataSchema = z.strictObject({
  contractVersion: ScriptoriumPlatformContractVersion,
  producerRevision: ProducerRevisionSchema,
  listener: z.strictObject({ port: PositiveIntegerSchema.max(65_535) }),
  paths: MetadataPathSchema,
  shutdownTimeoutSeconds: PositiveIntegerSchema,
});
export type RuntimeMetadata = z.infer<typeof RuntimeMetadataSchema>;

const RepositoryIdSchema = PositiveIntegerSchema;
const RemoteRevisionSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u)
  .nullable();
const ActivitySchema = z
  .strictObject({
    lastMeaningfulActivityAt: z.iso.datetime().nullable(),
    activeApiRequests: NonNegativeIntegerSchema,
    activeMcpRequests: NonNegativeIntegerSchema,
    activeMutations: NonNegativeIntegerSchema,
    activeJobs: NonNegativeIntegerSchema,
    restartableJobs: NonNegativeIntegerSchema,
    pendingCheckpoints: NonNegativeIntegerSchema,
    uncertainPublication: z.boolean(),
  })
  .refine(
    (activity) => activity.restartableJobs <= activity.activeJobs,
    "restartable jobs cannot exceed active jobs",
  );

/** Runtime self-report only. It cannot substitute for registry/CRI image observation. */
export const RuntimeStatusSchema = z.strictObject({
  contractVersion: ScriptoriumPlatformContractVersion,
  instanceId: NonEmptyStringSchema,
  repositoryId: RepositoryIdSchema,
  runtimeEpoch: PositiveIntegerSchema,
  imageDigest: Sha256DigestSchema,
  compositionManifestDigest: Sha256DigestSchema,
  enabledModuleIds: UniqueModuleIdsSchema,
  ready: z.boolean(),
  activity: ActivitySchema,
  lastConfirmedRemoteRevision: RemoteRevisionSchema,
  observedAt: z.iso.datetime(),
});
export type RuntimeStatus = z.infer<typeof RuntimeStatusSchema>;

export const QuiesceRequestSchema = z.strictObject({
  contractVersion: ScriptoriumPlatformContractVersion,
  operationId: NonEmptyStringSchema,
  instanceId: NonEmptyStringSchema,
  runtimeEpoch: PositiveIntegerSchema,
  reason: z.string().min(1).max(128),
  deadline: z.iso.datetime(),
});
export type QuiesceRequest = z.infer<typeof QuiesceRequestSchema>;

const QuiesceDispositionSchema = z.enum(["safe", "blocked", "unknown"]);
const QuiesceResultBodySchema = z
  .strictObject({
    contractVersion: ScriptoriumPlatformContractVersion,
    operationId: NonEmptyStringSchema,
    instanceId: NonEmptyStringSchema,
    runtimeEpoch: PositiveIntegerSchema,
    quiesceRevision: NonEmptyStringSchema,
    disposition: QuiesceDispositionSchema,
    activeMutations: NonNegativeIntegerSchema,
    activeJobs: NonNegativeIntegerSchema,
    restartableJobs: NonNegativeIntegerSchema,
    pendingCheckpoints: NonNegativeIntegerSchema,
    uncertainPublication: z.boolean(),
    lastConfirmedRemoteRevision: RemoteRevisionSchema,
    reasonCodes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/u)).max(64),
    observedAt: z.iso.datetime(),
  })
  .refine(
    (result) => result.restartableJobs <= result.activeJobs,
    "restartable jobs cannot exceed active jobs",
  );

/** A producer may report safe only when authoring state and remaining jobs are recoverable. */
export const QuiesceResultSchema = QuiesceResultBodySchema.refine(
  (result) =>
    result.disposition !== "safe" ||
    (result.activeMutations === 0 &&
      result.activeJobs === 0 &&
      result.pendingCheckpoints === 0 &&
      !result.uncertainPublication),
  "safe quiesce requires no active mutations, no unrecoverable jobs, no checkpoints, and certain publication",
);
export type QuiesceResult = z.infer<typeof QuiesceResultSchema>;

const HttpsUrlSchema = z.url({ protocol: /^https$/u });
const RepositoryLocatorSchema = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(url.pathname) &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}, "expected a canonical https://github.com/{owner}/{repository} locator");

/** Deployment assignment is structured data, never an arbitrary environment map. */
export const RuntimeAssignmentSchema = z.strictObject({
  contractVersion: ScriptoriumPlatformContractVersion,
  instanceId: NonEmptyStringSchema,
  repositoryId: RepositoryIdSchema,
  repositoryLocator: RepositoryLocatorSchema,
  defaultBranchPolicy: NonEmptyStringSchema,
  runtimeEpoch: PositiveIntegerSchema,
  imageDigest: Sha256DigestSchema,
  compositionManifestDigest: Sha256DigestSchema,
  enabledModuleIds: UniqueModuleIdsSchema,
  credentialBrokerLocator: NonEmptyStringSchema,
  controlServicePolicy: z.strictObject({
    issuer: HttpsUrlSchema,
    jwksUrl: HttpsUrlSchema,
    audience: NonEmptyStringSchema,
  }),
  grantPolicy: z.strictObject({
    issuer: HttpsUrlSchema,
    jwksUrl: HttpsUrlSchema,
    audience: NonEmptyStringSchema,
  }),
});
export type RuntimeAssignment = z.infer<typeof RuntimeAssignmentSchema>;

export function assertQuiesceResultBoundToRequest(
  requestInput: unknown,
  resultInput: unknown,
): { request: QuiesceRequest; result: QuiesceResult } {
  const request = QuiesceRequestSchema.parse(requestInput);
  const result = QuiesceResultSchema.parse(resultInput);
  if (
    request.operationId !== result.operationId ||
    request.instanceId !== result.instanceId ||
    request.runtimeEpoch !== result.runtimeEpoch
  ) {
    throw new TypeError("quiesce result binding does not match its request");
  }
  return { request, result };
}
