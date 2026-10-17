import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
} from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { validateOffHostResticDestination } from "./restic-destination.ts";

export const IMPORT_FORMAT = "praetorium.legacy-import-plan.v1";
export const METADATA_FORMAT = "praetorium.platform-metadata-backup.v1";

const ARCHIVE_FORMAT = "praetorium.encrypted-metadata.v1";
const FILE_NAMES = ["d1-export.sql", "migration-checksums.json", "platform-config.json"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const SNAPSHOT_ID = /^[0-9a-f]{64}$/i;
const REPOSITORY_ID = /^[1-9][0-9]{0,19}$/;
const INSTANCE_ID = /^ins_[0-9A-HJKMNP-TV-Z]{26}$/;
const RELEASE_ID = /^(?:none|rel_[0-9A-HJKMNP-TV-Z]{26})$/;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const SCRYPT = { N: 131_072, r: 8, p: 1, keyLength: 32 } as const;
const CHECKOUT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export interface LegacyPlatformExport {
  readonly format: "praetorium.legacy-platform-export.v1";
  readonly source: {
    readonly system: string;
    readonly exportId: string;
    readonly revision: string;
  };
  readonly users: readonly { readonly id: string }[];
  readonly instances: readonly {
    readonly id: string;
    readonly origin: string;
    readonly userIds: readonly string[];
  }[];
  readonly releases: readonly { readonly id: string; readonly instanceId: string }[];
  readonly auditEvents: readonly { readonly id: string; readonly instanceId: string }[];
}

export type LegacyPublicationState = "published" | "producer-exported" | "pending" | "unknown";

export interface LegacyProducerManifest {
  readonly format: "praetorium.legacy-producer-manifest.v1";
  readonly exportId: string;
  readonly sourceInstanceId: string;
  readonly repositories: readonly {
    readonly repositoryId: string;
    readonly owner: string;
    readonly name: string;
    readonly installationId: string;
    readonly publicationState: LegacyPublicationState;
  }[];
}

export interface LegacyImportPlanOptions {
  readonly platform: LegacyPlatformExport;
  readonly producerManifests: readonly LegacyProducerManifest[];
  readonly targetOrigins?: Readonly<Record<string, string>>;
}

type ImportConflict = {
  readonly code: string;
  readonly message: string;
  readonly sourceInstanceIds: readonly string[];
};

type BindingPlan = {
  readonly repositoryId: string;
  readonly owner: string;
  readonly name: string;
  readonly installationId: string | null;
  readonly targetBindingKey: string;
  readonly targetInstanceId: null;
  readonly targetOrigin: string | null;
  readonly sourceInstances: readonly {
    readonly instanceId: string;
    readonly sourceOrigin: string;
    readonly sourceUserIds: readonly string[];
    readonly releaseIds: readonly string[];
    readonly auditEventIds: readonly string[];
    readonly producerExportIds: readonly string[];
    readonly publicationState: LegacyPublicationState;
  }[];
  readonly sourceOrigins: readonly string[];
  readonly browserStorageMigrated: false;
  readonly legacyAclImported: false;
  readonly accessTokensImported: false;
  readonly applicationData: {
    readonly opaque: true;
    readonly unresolvedLocalWork: boolean;
    readonly disposition: "retain-legacy-data" | "producer-exported";
  };
  readonly conflicts: readonly ImportConflict[];
  readonly status: "blocked" | "requires-target-origin" | "ready-for-review";
};

export interface LegacyImportPlan {
  readonly format: typeof IMPORT_FORMAT;
  readonly planId: string;
  readonly source: {
    readonly system: string;
    readonly exportId: string;
    readonly revision: string;
  };
  readonly mode: "offline-dry-run";
  readonly writesPerformed: false;
  readonly access: {
    readonly reauthenticationRequired: true;
    readonly legacyAclImported: false;
    readonly accessTokensImported: false;
  };
  readonly summary: {
    readonly sourceInstanceCount: number;
    readonly repositoryBindingCount: number;
    readonly deduplicatedBindingCount: number;
    readonly blockedBindingCount: number;
    readonly missingTargetOriginCount: number;
    readonly reviewStatus: "blocked" | "requires-target-origin" | "ready-for-review";
  };
  readonly bindings: readonly BindingPlan[];
  readonly originMappings: readonly {
    readonly sourceInstanceId: string;
    readonly sourceOrigin: string;
    readonly repositoryId: string | null;
    readonly targetOrigin: string | null;
    readonly browserStorageMigrated: false;
  }[];
  readonly sourceInstanceMappings: readonly {
    readonly sourceInstanceId: string;
    readonly targetBindingKeys: readonly string[];
  }[];
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertNoCredentials(value: unknown, path = "input"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoCredentials(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (
      /(?:access|refresh|github|app|bearer|oauth)?_?(?:token|secret|password|credential|cookie|authorization)/i.test(
        key,
      )
    ) {
      throw new Error(`${path}.${key} is credential-bearing and cannot be imported`);
    }
    assertNoCredentials(child, `${path}.${key}`);
  }
}

function canonicalOrigin(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a canonical HTTPS origin`);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${label} must be a canonical HTTPS origin`);
  }
  return url.origin;
}

function addConflict(
  groups: Map<string, ImportConflict[]>,
  repositoryId: string,
  conflict: ImportConflict,
): void {
  const conflicts = groups.get(repositoryId) ?? [];
  if (
    !conflicts.some((entry) => entry.code === conflict.code && entry.message === conflict.message)
  ) {
    conflicts.push(conflict);
  }
  groups.set(repositoryId, conflicts);
}

/** Build a deterministic, offline-only repository binding plan from explicit exports. */
export function buildLegacyImportPlan(options: LegacyImportPlanOptions): LegacyImportPlan {
  const { platform, producerManifests } = options;
  assertNoCredentials(platform);
  assertNoCredentials(producerManifests);
  assertNoCredentials(options.targetOrigins ?? {});
  if (platform?.format !== "praetorium.legacy-platform-export.v1") {
    throw new Error("platform export format is unsupported");
  }
  if (
    !platform.source ||
    !platform.source.system ||
    !platform.source.exportId ||
    !COMMIT.test(platform.source.revision)
  ) {
    throw new Error("platform export provenance is incomplete");
  }
  if (
    !Array.isArray(platform.instances) ||
    !Array.isArray(platform.users) ||
    !Array.isArray(platform.releases) ||
    !Array.isArray(platform.auditEvents)
  ) {
    throw new Error("platform export must contain users, instances, releases, and audit events");
  }

  const userIds = new Set(platform.users.map((user) => user.id));
  const instances = new Map<string, LegacyPlatformExport["instances"][number]>();
  for (const instance of platform.instances) {
    if (!instance.id || instances.has(instance.id))
      throw new Error("platform export has duplicate instance IDs");
    if (
      !Array.isArray(instance.userIds) ||
      instance.userIds.some((id: unknown) => typeof id !== "string" || !userIds.has(id))
    ) {
      throw new Error(`legacy instance ${instance.id} refers to an unknown source user`);
    }
    instances.set(instance.id, {
      ...instance,
      origin: canonicalOrigin(instance.origin, `legacy instance ${instance.id} origin`),
    });
  }

  const releasesByInstance = new Map<string, string[]>();
  for (const release of platform.releases ?? []) {
    if (!instances.has(release.instanceId)) {
      throw new Error(`legacy release ${release.id} refers to an unknown source instance`);
    }
    const values = releasesByInstance.get(release.instanceId) ?? [];
    values.push(release.id);
    releasesByInstance.set(release.instanceId, values);
  }
  const auditByInstance = new Map<string, string[]>();
  for (const event of platform.auditEvents ?? []) {
    if (!instances.has(event.instanceId)) {
      throw new Error(`legacy audit event ${event.id} refers to an unknown source instance`);
    }
    const values = auditByInstance.get(event.instanceId) ?? [];
    values.push(event.id);
    auditByInstance.set(event.instanceId, values);
  }

  const manifestsByInstance = new Map<string, LegacyProducerManifest[]>();
  const knownManifestIds = new Set<string>();
  for (const manifest of producerManifests) {
    if (manifest?.format !== "praetorium.legacy-producer-manifest.v1") {
      throw new Error("producer manifest format is unsupported");
    }
    if (!instances.has(manifest.sourceInstanceId)) {
      throw new Error(
        `producer manifest ${manifest.exportId} refers to an unknown legacy instance`,
      );
    }
    if (!manifest.exportId || knownManifestIds.has(manifest.exportId)) {
      throw new Error("producer manifests have missing or duplicate export IDs");
    }
    knownManifestIds.add(manifest.exportId);
    const values = manifestsByInstance.get(manifest.sourceInstanceId) ?? [];
    values.push(manifest);
    manifestsByInstance.set(manifest.sourceInstanceId, values);
  }

  const entries = new Map<
    string,
    {
      owner: string;
      name: string;
      installations: Set<string>;
      sourceInstances: Map<
        string,
        {
          sourceOrigin: string;
          sourceUserIds: string[];
          releaseIds: string[];
          auditEventIds: string[];
          producerExportIds: string[];
          publicationStates: Set<LegacyPublicationState>;
        }
      >;
    }
  >();
  const conflicts = new Map<string, ImportConflict[]>();
  const sourceInstanceKeys = new Map<string, Set<string>>();

  for (const [instanceId, instance] of instances) {
    const manifests = manifestsByInstance.get(instanceId) ?? [];
    if (manifests.length === 0) {
      addConflict(conflicts, `instance:${instanceId}`, {
        code: "missing-producer-manifest",
        message: `Legacy instance ${instanceId} has no producer manifest; its application data remains unresolved.`,
        sourceInstanceIds: [instanceId],
      });
      continue;
    }
    let repositoryCount = 0;
    for (const manifest of manifests) {
      for (const repository of manifest.repositories) {
        repositoryCount += 1;
        if (!REPOSITORY_ID.test(repository.repositoryId)) {
          throw new Error(`repository ID ${repository.repositoryId} is invalid`);
        }
        if (
          !/^[A-Za-z0-9_.-]{1,100}$/.test(repository.owner) ||
          !/^[A-Za-z0-9_.-]{1,100}$/.test(repository.name)
        ) {
          throw new Error(
            `repository ${repository.repositoryId} has an invalid owner/name locator`,
          );
        }
        if (!/^[0-9]{1,20}$/.test(repository.installationId)) {
          throw new Error(`repository ${repository.repositoryId} has an invalid installation ID`);
        }
        if (
          !["published", "producer-exported", "pending", "unknown"].includes(
            repository.publicationState,
          )
        ) {
          throw new Error(`repository ${repository.repositoryId} has an invalid publication state`);
        }

        const key = repository.repositoryId;
        const entry = entries.get(key) ?? {
          owner: repository.owner,
          name: repository.name,
          installations: new Set<string>(),
          sourceInstances: new Map(),
        };
        entries.set(key, entry);
        if (
          entry.owner.toLowerCase() !== repository.owner.toLowerCase() ||
          entry.name.toLowerCase() !== repository.name.toLowerCase()
        ) {
          addConflict(conflicts, key, {
            code: "repository-identity-conflict",
            message: `Repository ID ${key} has conflicting owner/name locators across exports.`,
            sourceInstanceIds: [instanceId],
          });
        }
        entry.installations.add(repository.installationId);
        const source = entry.sourceInstances.get(instanceId) ?? {
          sourceOrigin: instance.origin,
          sourceUserIds: [...instance.userIds],
          releaseIds: [...(releasesByInstance.get(instanceId) ?? [])],
          auditEventIds: [...(auditByInstance.get(instanceId) ?? [])],
          producerExportIds: [],
          publicationStates: new Set<LegacyPublicationState>(),
        };
        source.producerExportIds.push(manifest.exportId);
        source.publicationStates.add(repository.publicationState);
        entry.sourceInstances.set(instanceId, source);
        const keys = sourceInstanceKeys.get(instanceId) ?? new Set<string>();
        keys.add(`repo:${key}`);
        sourceInstanceKeys.set(instanceId, keys);
        if (
          repository.publicationState === "pending" ||
          repository.publicationState === "unknown"
        ) {
          addConflict(conflicts, key, {
            code: "unresolved-local-work",
            message: `Repository ${key} has unpublished or unknown application state; retain its legacy PVC and resolve it through the producer before migration.`,
            sourceInstanceIds: [instanceId],
          });
        }
      }
    }
    if (repositoryCount === 0) {
      addConflict(conflicts, `instance:${instanceId}`, {
        code: "no-repository-binding",
        message: `Legacy instance ${instanceId} has no repository identity in its producer manifest.`,
        sourceInstanceIds: [instanceId],
      });
    }
  }

  for (const [repositoryId, entry] of entries) {
    if (entry.installations.size !== 1) {
      addConflict(conflicts, repositoryId, {
        code: "installation-conflict",
        message: `Repository ${repositoryId} is associated with multiple GitHub App installations; current access must be revalidated before binding.`,
        sourceInstanceIds: [...entry.sourceInstances.keys()].sort(),
      });
    }
  }

  const normalizedTargets = new Map<string, string>();
  for (const [repositoryId, origin] of Object.entries(options.targetOrigins ?? {})) {
    if (!entries.has(repositoryId)) {
      throw new Error(`target origin map refers to unknown repository ${repositoryId}`);
    }
    normalizedTargets.set(
      repositoryId,
      canonicalOrigin(origin, `target origin for repository ${repositoryId}`),
    );
  }
  const targetOwners = new Map<string, string>();
  for (const [repositoryId, origin] of normalizedTargets) {
    const other = targetOwners.get(origin);
    if (other && other !== repositoryId) {
      addConflict(conflicts, repositoryId, {
        code: "target-origin-collision",
        message: `Target origin ${origin} is assigned to more than one repository binding.`,
        sourceInstanceIds: [...(entries.get(repositoryId)?.sourceInstances.keys() ?? [])].sort(),
      });
      addConflict(conflicts, other, {
        code: "target-origin-collision",
        message: `Target origin ${origin} is assigned to more than one repository binding.`,
        sourceInstanceIds: [...(entries.get(other)?.sourceInstances.keys() ?? [])].sort(),
      });
    } else {
      targetOwners.set(origin, repositoryId);
    }
  }

  const bindings: BindingPlan[] = [...entries.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([repositoryId, entry]) => {
      const bindingConflicts = conflicts.get(repositoryId) ?? [];
      const targetOrigin = normalizedTargets.get(repositoryId) ?? null;
      const states = [...entry.sourceInstances.values()].flatMap((source) => [
        ...source.publicationStates,
      ]);
      const allPublishedOrExported = states.every(
        (state) => state === "published" || state === "producer-exported",
      );
      const sourceInstances = [...entry.sourceInstances.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([instanceId, source]) => ({
          instanceId,
          sourceOrigin: source.sourceOrigin,
          sourceUserIds: [...new Set(source.sourceUserIds)].sort(),
          releaseIds: [...new Set(source.releaseIds)].sort(),
          auditEventIds: [...new Set(source.auditEventIds)].sort(),
          producerExportIds: [...new Set(source.producerExportIds)].sort(),
          publicationState: source.publicationStates.has("unknown")
            ? ("unknown" as const)
            : source.publicationStates.has("pending")
              ? ("pending" as const)
              : source.publicationStates.has("producer-exported")
                ? ("producer-exported" as const)
                : ("published" as const),
        }));
      const status =
        bindingConflicts.length > 0
          ? "blocked"
          : targetOrigin
            ? "ready-for-review"
            : "requires-target-origin";
      return {
        repositoryId,
        owner: entry.owner,
        name: entry.name,
        installationId: entry.installations.size === 1 ? [...entry.installations][0] : null,
        targetBindingKey: `repo:${repositoryId}`,
        targetInstanceId: null,
        targetOrigin,
        sourceInstances,
        sourceOrigins: [...new Set(sourceInstances.map((source) => source.sourceOrigin))].sort(),
        browserStorageMigrated: false,
        legacyAclImported: false,
        accessTokensImported: false,
        applicationData: {
          opaque: true,
          unresolvedLocalWork: !allPublishedOrExported,
          disposition: allPublishedOrExported ? "producer-exported" : "retain-legacy-data",
        },
        conflicts: bindingConflicts,
        status,
      };
    });

  for (const [key, list] of conflicts) {
    if (!key.startsWith("instance:")) continue;
    // Instance-level issues stay visible even if no repository identity exists to attach them to.
    const instanceId = key.slice("instance:".length);
    if (!sourceInstanceKeys.has(instanceId)) {
      const source = instances.get(instanceId)!;
      sourceInstanceKeys.set(instanceId, new Set([`unresolved:${instanceId}`]));
      bindings.push({
        repositoryId: `unresolved:${instanceId}`,
        owner: "",
        name: "",
        installationId: null,
        targetBindingKey: `unresolved:${instanceId}`,
        targetInstanceId: null,
        targetOrigin: null,
        sourceInstances: [
          {
            instanceId,
            sourceOrigin: source.origin,
            sourceUserIds: [...source.userIds].sort(),
            releaseIds: [...(releasesByInstance.get(instanceId) ?? [])].sort(),
            auditEventIds: [...(auditByInstance.get(instanceId) ?? [])].sort(),
            producerExportIds: [],
            publicationState: "unknown",
          },
        ],
        sourceOrigins: [source.origin],
        browserStorageMigrated: false,
        legacyAclImported: false,
        accessTokensImported: false,
        applicationData: {
          opaque: true,
          unresolvedLocalWork: true,
          disposition: "retain-legacy-data",
        },
        conflicts: list,
        status: "blocked",
      });
    }
  }

  const originMappings: LegacyImportPlan["originMappings"][number][] = [...entries.entries()]
    .flatMap(([repositoryId, entry]) =>
      [...entry.sourceInstances.entries()].map(([sourceInstanceId, source]) => ({
        sourceInstanceId,
        sourceOrigin: source.sourceOrigin,
        repositoryId,
        targetOrigin: normalizedTargets.get(repositoryId) ?? null,
        browserStorageMigrated: false as const,
      })),
    )
    .sort(
      (left, right) =>
        left.sourceInstanceId.localeCompare(right.sourceInstanceId) ||
        (left.repositoryId ?? "").localeCompare(right.repositoryId ?? ""),
    );

  const mappedSources = new Set(originMappings.map((mapping) => mapping.sourceInstanceId));
  for (const [sourceInstanceId, source] of instances) {
    if (!mappedSources.has(sourceInstanceId)) {
      originMappings.push({
        sourceInstanceId,
        sourceOrigin: source.origin,
        repositoryId: null,
        targetOrigin: null,
        browserStorageMigrated: false,
      });
    }
  }
  originMappings.sort(
    (left, right) =>
      left.sourceInstanceId.localeCompare(right.sourceInstanceId) ||
      (left.repositoryId ?? "").localeCompare(right.repositoryId ?? ""),
  );

  const sourceInstanceMappings = [...instances.keys()].sort().map((sourceInstanceId) => ({
    sourceInstanceId,
    targetBindingKeys: [...(sourceInstanceKeys.get(sourceInstanceId) ?? [])].sort(),
  }));
  const blockedBindingCount = bindings.filter((binding) => binding.status === "blocked").length;
  const missingTargetOriginCount = bindings.filter(
    (binding) => binding.status === "requires-target-origin",
  ).length;
  const reviewStatus =
    blockedBindingCount > 0
      ? "blocked"
      : missingTargetOriginCount > 0
        ? "requires-target-origin"
        : "ready-for-review";
  const stableInput = {
    platform,
    producerManifests: [...producerManifests].sort((a, b) => a.exportId.localeCompare(b.exportId)),
    targetOrigins: Object.fromEntries(
      [...normalizedTargets.entries()].sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
  return {
    format: IMPORT_FORMAT,
    planId: sha256(canonicalJson(stableInput)),
    source: { ...platform.source },
    mode: "offline-dry-run",
    writesPerformed: false,
    access: {
      reauthenticationRequired: true,
      legacyAclImported: false,
      accessTokensImported: false,
    },
    summary: {
      sourceInstanceCount: instances.size,
      repositoryBindingCount: entries.size,
      deduplicatedBindingCount: [...entries.values()].filter(
        (entry) => entry.sourceInstances.size > 1,
      ).length,
      blockedBindingCount,
      missingTargetOriginCount,
      reviewStatus,
    },
    bindings,
    originMappings,
    sourceInstanceMappings,
  };
}

export interface MetadataSource {
  readonly environment: string;
  readonly databaseName: string;
  readonly databaseId: string;
  readonly sourceRevision: string;
  readonly recoveryPointId?: string;
}

export interface MetadataFileManifest {
  readonly bytes: number;
  readonly sha256: string;
}

export interface MetadataBackupManifest {
  readonly format: typeof METADATA_FORMAT;
  readonly createdAt: string;
  readonly source: MetadataSource;
  readonly files: Readonly<Record<(typeof FILE_NAMES)[number], MetadataFileManifest>>;
  readonly requiredExternalSecrets: readonly string[];
  readonly sqlImported: false;
}

export type MetadataFiles = Readonly<Record<(typeof FILE_NAMES)[number], Uint8Array>>;

interface EncryptedArchive {
  readonly format: typeof ARCHIVE_FORMAT;
  readonly kdf: {
    readonly name: "scrypt";
    readonly N: number;
    readonly r: number;
    readonly p: number;
    readonly salt: string;
  };
  readonly cipher: { readonly name: "aes-256-gcm"; readonly nonce: string; readonly tag: string };
  readonly ciphertext: string;
}

interface MetadataPayload {
  readonly manifest: MetadataBackupManifest;
  readonly files: Readonly<Record<string, string>>;
}

function authenticatedHeader(archive: Pick<EncryptedArchive, "format" | "kdf" | "cipher">): Buffer {
  return Buffer.from(
    canonicalJson({
      format: archive.format,
      kdf: archive.kdf,
      cipher: { name: archive.cipher.name, nonce: archive.cipher.nonce },
    }),
  );
}

function validateMetadataSource(source: MetadataSource): void {
  if (!source || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(source.environment))
    throw new Error("metadata environment label is invalid");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(source.databaseName))
    throw new Error("metadata database name is invalid");
  if (!UUID.test(source.databaseId)) throw new Error("metadata database ID is invalid");
  if (!COMMIT.test(source.sourceRevision))
    throw new Error("metadata source revision must be a full Git commit SHA");
}

function makeMetadataManifest(
  files: MetadataFiles,
  source: MetadataSource,
  createdAt = new Date().toISOString(),
): MetadataBackupManifest {
  validateMetadataSource(source);
  for (const filename of FILE_NAMES) {
    if (!(files[filename] instanceof Uint8Array) || files[filename].byteLength === 0) {
      throw new Error(`metadata backup requires a non-empty ${filename}`);
    }
  }
  return {
    format: METADATA_FORMAT,
    createdAt,
    source: {
      ...source,
      databaseId: source.databaseId.toLowerCase(),
      sourceRevision: source.sourceRevision.toLowerCase(),
      recoveryPointId: source.recoveryPointId ?? randomUUID(),
    },
    files: Object.fromEntries(
      FILE_NAMES.map((filename) => [
        filename,
        { bytes: files[filename].byteLength, sha256: sha256(files[filename]) },
      ]),
    ) as MetadataBackupManifest["files"],
    requiredExternalSecrets: [
      "GitHub App private key",
      "session and credential encryption keys",
      "Platform signing keys",
      "Restic repository credentials",
      "metadata archive recovery passphrase",
    ],
    sqlImported: false,
  };
}

/** Encrypt all metadata inputs with an authenticated AES-256-GCM envelope. */
export function encryptMetadataBackup(
  files: MetadataFiles,
  source: MetadataSource,
  passphrase: string,
  createdAt?: string,
): Buffer {
  if (Buffer.byteLength(passphrase, "utf8") < 16)
    throw new Error("recovery passphrase must contain at least 16 bytes");
  const manifest = makeMetadataManifest(files, source, createdAt);
  const payload: MetadataPayload = {
    manifest,
    files: Object.fromEntries(
      FILE_NAMES.map((filename) => [filename, Buffer.from(files[filename]).toString("base64")]),
    ),
  };
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const archiveHeader: Pick<EncryptedArchive, "format" | "kdf" | "cipher"> = {
    format: ARCHIVE_FORMAT,
    kdf: { name: "scrypt", N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString("base64") },
    cipher: { name: "aes-256-gcm", nonce: nonce.toString("base64"), tag: "" },
  };
  const key = scryptSync(passphrase, salt, SCRYPT.keyLength, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 256 * 1024 * 1024,
  });
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(authenticatedHeader(archiveHeader));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payload))),
    cipher.final(),
  ]);
  const archive: EncryptedArchive = {
    ...archiveHeader,
    cipher: { ...archiveHeader.cipher, tag: cipher.getAuthTag().toString("base64") },
    ciphertext: ciphertext.toString("base64"),
  };
  return Buffer.from(`${JSON.stringify(archive)}\n`);
}

function parseEncryptedArchive(archiveBytes: Uint8Array): EncryptedArchive {
  let archive: EncryptedArchive;
  try {
    archive = JSON.parse(Buffer.from(archiveBytes).toString("utf8")) as EncryptedArchive;
  } catch {
    throw new Error("encrypted metadata archive is not valid JSON");
  }
  if (
    archive?.format !== ARCHIVE_FORMAT ||
    archive.kdf?.name !== "scrypt" ||
    archive.kdf.N !== SCRYPT.N ||
    archive.kdf.r !== SCRYPT.r ||
    archive.kdf.p !== SCRYPT.p ||
    archive.cipher?.name !== "aes-256-gcm" ||
    !archive.cipher.nonce ||
    !archive.cipher.tag ||
    typeof archive.ciphertext !== "string"
  )
    throw new Error("encrypted metadata archive format or parameters are unsupported");
  const salt = Buffer.from(archive.kdf.salt, "base64");
  const nonce = Buffer.from(archive.cipher.nonce, "base64");
  const tag = Buffer.from(archive.cipher.tag, "base64");
  if (salt.length !== 16 || nonce.length !== 12 || tag.length !== 16)
    throw new Error("encrypted metadata archive header is malformed");
  return archive;
}

/** Authenticate and validate a metadata archive entirely in memory. */
export function decryptMetadataBackup(
  archiveBytes: Uint8Array,
  passphrase: string,
): { manifest: MetadataBackupManifest; files: MetadataFiles } {
  if (Buffer.byteLength(passphrase, "utf8") < 16)
    throw new Error("recovery passphrase must contain at least 16 bytes");
  const archive = parseEncryptedArchive(archiveBytes);
  const salt = Buffer.from(archive.kdf.salt, "base64");
  const nonce = Buffer.from(archive.cipher.nonce, "base64");
  const key = scryptSync(passphrase, salt, SCRYPT.keyLength, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 256 * 1024 * 1024,
  });
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(authenticatedHeader(archive));
    decipher.setAuthTag(Buffer.from(archive.cipher.tag, "base64"));
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(archive.ciphertext, "base64")),
      decipher.final(),
    ]);
  } catch {
    throw new Error("metadata archive authentication failed");
  }
  let payload: MetadataPayload;
  try {
    payload = JSON.parse(plaintext.toString("utf8")) as MetadataPayload;
  } catch {
    throw new Error("authenticated metadata payload is invalid");
  }
  if (payload?.manifest?.format !== METADATA_FORMAT || payload.manifest.sqlImported !== false) {
    throw new Error("authenticated metadata manifest is unsupported");
  }
  validateMetadataSource(payload.manifest.source);
  const files = {} as Record<(typeof FILE_NAMES)[number], Uint8Array>;
  for (const filename of FILE_NAMES) {
    const encoded = payload.files?.[filename];
    const fileManifest = payload.manifest.files?.[filename];
    if (typeof encoded !== "string" || !fileManifest)
      throw new Error(`authenticated metadata is missing ${filename}`);
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.byteLength !== fileManifest.bytes || sha256(bytes) !== fileManifest.sha256) {
      throw new Error(`metadata checksum validation failed for ${filename}`);
    }
    files[filename] = bytes;
  }
  return { manifest: payload.manifest, files };
}

export async function readRecoveryPassphrase(path: string): Promise<string> {
  const metadata = await stat(path).catch(() => null);
  if (!metadata?.isFile()) throw new Error("recovery key file must be an accessible regular file");
  if ((metadata.mode & 0o077) !== 0)
    throw new Error("recovery key file must not be accessible by group or other users");
  const value = (await readFile(path, "utf8")).replace(/[\r\n]+$/, "");
  if (Buffer.byteLength(value, "utf8") < 16)
    throw new Error("recovery key file must contain a passphrase of at least 16 bytes");
  return value;
}

export async function readMetadataInputDirectory(
  directory: string,
): Promise<{ files: MetadataFiles; source: MetadataSource }> {
  const root = resolve(directory);
  const sourcePath = join(root, "source.json");
  let source: MetadataSource;
  try {
    const parsed = JSON.parse(await readFile(sourcePath, "utf8")) as {
      format?: string;
      source?: MetadataSource;
    };
    if (parsed.format !== "praetorium.metadata-source.v1" || !parsed.source)
      throw new Error("unsupported source descriptor");
    source = parsed.source;
  } catch {
    throw new Error("metadata input requires a valid source.json descriptor");
  }
  validateMetadataSource(source);
  const files = {} as Record<(typeof FILE_NAMES)[number], Uint8Array>;
  for (const filename of FILE_NAMES) {
    files[filename] = await readFile(join(root, filename)).catch(() => {
      throw new Error(`metadata input is missing ${filename}`);
    });
  }
  return { files, source };
}

export interface ToolResult {
  readonly stdout: string;
}

export type ToolRunner = (
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv },
) => Promise<ToolResult>;

async function runProcess(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ToolResult> {
  return await new Promise((resolveResult, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let bytes = 0;
    let overflow = false;
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_CAPTURE_BYTES) {
        overflow = true;
        child.kill("SIGTERM");
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", () => {});
    child.on("error", () => reject(new Error(`${basename(command)} could not be started`)));
    child.on("close", (code) => {
      if (overflow)
        return reject(new Error(`${basename(command)} output exceeded the bounded capture limit`));
      if (code !== 0)
        return reject(new Error(`${basename(command)} failed with exit code ${code ?? "unknown"}`));
      resolveResult({ stdout });
    });
  });
}

function parseJsonOutput(stdout: string, tool: string): unknown {
  try {
    return JSON.parse(stdout.trim()) as unknown;
  } catch {
    throw new Error(`${tool} did not return valid JSON`);
  }
}

function d1DatabaseInfo(payload: unknown): { databaseId: string; name?: string } {
  const value = payload as Record<string, unknown>;
  const candidates = [value, value.result, value.database].filter(
    (entry): entry is Record<string, unknown> => !!entry && typeof entry === "object",
  );
  for (const item of candidates) {
    const id = [item.database_id, item.uuid, item.id].find(
      (candidate) => typeof candidate === "string",
    );
    const name = [item.database_name, item.name].find((candidate) => typeof candidate === "string");
    if (typeof id === "string" && UUID.test(id))
      return { databaseId: id.toLowerCase(), ...(typeof name === "string" ? { name } : {}) };
  }
  throw new Error("Wrangler did not return a valid D1 database identity");
}

const ensureRemoteRestic = validateOffHostResticDestination;

function resticEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allow = (name: string) =>
    ["PATH", "HOME", "TMPDIR"].includes(name) ||
    ["RESTIC_", "AWS_", "AZURE_", "B2_", "GOOGLE_", "RCLONE_"].some((prefix) =>
      name.startsWith(prefix),
    );
  return Object.fromEntries(Object.entries(env).filter(([name]) => allow(name)));
}

function wranglerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([name]) =>
        !["RESTIC_", "AWS_", "AZURE_", "B2_", "GOOGLE_", "RCLONE_"].some((prefix) =>
          name.startsWith(prefix),
        ),
    ),
  );
}

function parseResticSnapshotId(stdout: string): string {
  for (const line of stdout.split(/\r?\n/).filter(Boolean).reverse()) {
    try {
      const event = JSON.parse(line) as { message_type?: string; snapshot_id?: string };
      if (
        event.message_type === "summary" &&
        typeof event.snapshot_id === "string" &&
        SNAPSHOT_ID.test(event.snapshot_id)
      )
        return event.snapshot_id.toLowerCase();
    } catch {
      // Ignore progress events; only a complete summary is accepted.
    }
  }
  throw new Error("Restic did not report a complete snapshot identifier");
}

function parseSnapshotList(
  stdout: string,
): Array<{ id: string; host: string; paths: string[]; tags: string[]; time?: string }> {
  const parsed = parseJsonOutput(stdout, "Restic snapshots");
  if (!Array.isArray(parsed)) throw new Error("Restic snapshots did not return a list");
  return parsed as Array<{
    id: string;
    host: string;
    paths: string[];
    tags: string[];
    time?: string;
  }>;
}

export interface MetadataBackupOptions {
  readonly database: string;
  readonly config: string;
  readonly migrationChecksums: string;
  readonly environment: string;
  readonly sourceRevision: string;
  readonly output: string;
  readonly keyFile: string;
  readonly remote: true;
}

export async function createD1ResticBackup(
  options: MetadataBackupOptions,
  dependencies: {
    readonly run?: ToolRunner;
    readonly env?: NodeJS.ProcessEnv;
    readonly tempRoot?: string;
    readonly now?: () => Date;
  } = {},
): Promise<Record<string, unknown>> {
  const run = dependencies.run ?? runProcess;
  const env = dependencies.env ?? process.env;
  if (options.remote !== true)
    throw new Error("explicit --remote is required; local D1 is not a recovery source");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(options.database))
    throw new Error("D1 database name is invalid");
  if (!COMMIT.test(options.sourceRevision))
    throw new Error("source revision must be a full Git commit SHA");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(options.environment))
    throw new Error("environment label is invalid");
  const remote = ensureRemoteRestic(env);
  const passphrase = await readRecoveryPassphrase(options.keyFile);
  const configBytes = await readFile(options.config).catch(() => {
    throw new Error("Wrangler config must be an existing regular file");
  });
  const checksumsBytes = await readFile(options.migrationChecksums).catch(() => {
    throw new Error("migration checksum manifest must be an existing regular file");
  });
  let checksums: unknown;
  try {
    checksums = JSON.parse(checksumsBytes.toString("utf8"));
  } catch {
    throw new Error("migration checksum manifest is not valid JSON");
  }
  const entryCount = Array.isArray(checksums)
    ? checksums.length
    : checksums && typeof checksums === "object"
      ? Object.keys(checksums).length
      : 0;
  if (entryCount < 1)
    throw new Error("migration checksum manifest must contain at least one entry");

  const wrangler = env.WRANGLER_BIN ?? "wrangler";
  const info = d1DatabaseInfo(
    parseJsonOutput(
      (
        await run(
          wrangler,
          ["d1", "info", options.database, "--json", "--config", resolve(options.config)],
          { env: wranglerEnv(env) },
        )
      ).stdout,
      "Wrangler d1 info",
    ),
  );
  if (info.name && info.name !== options.database)
    throw new Error("Wrangler database name does not match the requested source");
  const staging = await mkdtemp(
    join(dependencies.tempRoot ?? env.TMPDIR ?? tmpdir(), "praetorium-d1-recovery-"),
  );
  await chmod(staging, 0o700);
  const sqlPath = join(staging, "d1-export.sql");
  try {
    await run(
      wrangler,
      [
        "d1",
        "export",
        options.database,
        "--remote",
        `--output=${sqlPath}`,
        "--config",
        resolve(options.config),
      ],
      { env: wranglerEnv(env) },
    );
    await chmod(sqlPath, 0o600);
    const sql = await readFile(sqlPath).catch(() => null);
    if (!sql?.byteLength)
      throw new Error("Wrangler D1 export did not create a non-empty SQL artifact");
    const source: MetadataSource = {
      environment: options.environment,
      databaseName: options.database,
      databaseId: info.databaseId,
      sourceRevision: options.sourceRevision.toLowerCase(),
      recoveryPointId: randomUUID(),
    };
    const files: MetadataFiles = {
      "d1-export.sql": sql,
      "migration-checksums.json": checksumsBytes,
      "platform-config.json": configBytes,
    };
    const archive = encryptMetadataBackup(
      files,
      source,
      passphrase,
      (dependencies.now ?? (() => new Date()))().toISOString(),
    );
    const output = resolve(options.output);
    await writeFile(output, archive, { mode: 0o600, flag: "wx" });
    const restic = env.RESTIC_BIN ?? "restic";
    const backup = await run(
      restic,
      [
        "backup",
        "--json",
        "--quiet",
        "--tag",
        "arcadia-platform-d1",
        "--tag",
        `recovery-point:${source.recoveryPointId}`,
        "--tag",
        "praetorium-platform-metadata-v1",
        output,
      ],
      { env: resticEnv(env) },
    );
    const snapshotId = parseResticSnapshotId(backup.stdout);
    const snapshotResult = await run(restic, ["snapshots", "--json", snapshotId], {
      env: resticEnv(env),
    });
    const snapshots = parseSnapshotList(snapshotResult.stdout);
    const snapshot = snapshots[0];
    if (
      !snapshot ||
      snapshots.length !== 1 ||
      snapshot.id !== snapshotId ||
      !snapshot.paths?.includes(output) ||
      !snapshot.tags?.includes("praetorium-platform-metadata-v1")
    ) {
      throw new Error("Restic did not return the uploaded metadata snapshot identity");
    }
    return {
      format: "praetorium.metadata-recovery-receipt.v1",
      recoveryPointId: source.recoveryPointId,
      snapshotId: snapshot.id.toLowerCase(),
      sourceDatabaseId: info.databaseId,
      sourceRevision: source.sourceRevision,
      archiveSha256: sha256(archive),
      repositoryFingerprint: remote.fingerprint,
      destinationIdentityFingerprint: remote.destinationIdentityFingerprint,
      destination: "off-host-restic",
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function mountIsReadOnly(mountInfo: string, expectedPath: string): boolean {
  for (const line of mountInfo.split(/\r?\n/)) {
    const fields = line.split(" ");
    const separator = fields.indexOf("-");
    if (fields.length < 10 || separator < 6) continue;
    const mountPoint = fields[4]
      .replace(/\\040/g, " ")
      .replace(/\\011/g, "\t")
      .replace(/\\134/g, "\\");
    if (mountPoint === expectedPath) return fields[5].split(",").includes("ro");
  }
  return false;
}

function legacyBackupMetadata(env: NodeJS.ProcessEnv): {
  instanceId: string;
  volumeUid: string;
  schema: string;
  generation: number;
  releaseId: string;
  imageDigest: string;
  host: string;
  tag: string;
} {
  const instanceId = env.PRAETORIUM_LEGACY_INSTANCE_ID ?? "";
  const volumeUid = env.PRAETORIUM_LEGACY_VOLUME_UID ?? "";
  const schema = env.PRAETORIUM_LEGACY_SCHEMA_VERSION ?? "";
  const generation = Number(env.PRAETORIUM_LEGACY_GENERATION);
  const releaseId = env.PRAETORIUM_LEGACY_RELEASE_ID ?? "";
  const imageDigest = env.PRAETORIUM_LEGACY_IMAGE_DIGEST ?? "";
  if (!INSTANCE_ID.test(instanceId)) throw new Error("PRAETORIUM_LEGACY_INSTANCE_ID is invalid");
  if (!UUID.test(volumeUid)) throw new Error("PRAETORIUM_LEGACY_VOLUME_UID is invalid");
  if (!/^\d+\.\d+$/.test(schema)) throw new Error("PRAETORIUM_LEGACY_SCHEMA_VERSION is invalid");
  if (!Number.isSafeInteger(generation) || generation < 1)
    throw new Error("PRAETORIUM_LEGACY_GENERATION is invalid");
  if (!RELEASE_ID.test(releaseId)) throw new Error("PRAETORIUM_LEGACY_RELEASE_ID is invalid");
  if (!IMAGE_DIGEST.test(imageDigest)) throw new Error("PRAETORIUM_LEGACY_IMAGE_DIGEST is invalid");
  const host = `arcadia-${instanceId.slice(0, 3)}-${instanceId.slice(4).toLowerCase()}`;
  const tag = `arcadia-backup-v1:${instanceId}:${generation}:${volumeUid}:${schema}:${releaseId}:${imageDigest}`;
  return { instanceId, volumeUid, schema, generation, releaseId, imageDigest, host, tag };
}

/** Create or reuse a Restic snapshot from a read-only legacy /data PVC mount. */
export async function createLegacyPvcSnapshot(
  dependencies: {
    readonly run?: ToolRunner;
    readonly env?: NodeJS.ProcessEnv;
    readonly mountInfo?: string;
    readonly dataPath?: string;
  } = {},
): Promise<Record<string, unknown>> {
  const run = dependencies.run ?? runProcess;
  const env = dependencies.env ?? process.env;
  const dataPath = dependencies.dataPath ?? "/data";
  if (!dependencies.run && dataPath !== "/data")
    throw new Error("legacy PVC recovery requires the exact /data mount");
  if (
    !mountIsReadOnly(
      dependencies.mountInfo ?? (await readFile("/proc/self/mountinfo", "utf8")),
      dataPath,
    )
  ) {
    throw new Error("legacy /data PVC mount must be present and read-only");
  }
  const directory = await stat(dataPath).catch(() => null);
  if (!directory?.isDirectory())
    throw new Error("legacy /data mount must be an accessible directory");
  const remote = ensureRemoteRestic(env);
  const metadata = legacyBackupMetadata(env);
  const restic = env.RESTIC_BIN ?? "restic";
  const executionEnv = resticEnv(env);
  const existing = parseSnapshotList(
    (await run(restic, ["snapshots", "--json", "--tag", metadata.tag], { env: executionEnv }))
      .stdout,
  );
  let snapshotId: string;
  if (existing.length === 1) {
    snapshotId = existing[0].id;
  } else if (existing.length === 0) {
    snapshotId = parseResticSnapshotId(
      (
        await run(
          restic,
          ["backup", "--json", "--quiet", "--host", metadata.host, "--tag", metadata.tag, dataPath],
          { env: executionEnv },
        )
      ).stdout,
    );
  } else {
    throw new Error("multiple Restic snapshots already match the legacy PVC identity");
  }
  const verified = parseSnapshotList(
    (await run(restic, ["snapshots", "--json", snapshotId], { env: executionEnv })).stdout,
  );
  if (
    verified.length !== 1 ||
    verified[0].id !== snapshotId ||
    verified[0].host !== metadata.host ||
    JSON.stringify(verified[0].paths) !== JSON.stringify([dataPath]) ||
    !verified[0].tags?.includes(metadata.tag)
  )
    throw new Error("Restic snapshot identity does not match the legacy PVC source");
  await run(restic, ["check", "--read-data-subset=100%"], { env: executionEnv });
  return {
    format: "praetorium.legacy-pvc-recovery-receipt.v1",
    snapshotId,
    sourceInstanceId: metadata.instanceId,
    sourceVolumeUid: metadata.volumeUid,
    sourceSchemaVersion: metadata.schema,
    sourceGeneration: metadata.generation,
    sourceReleaseId: metadata.releaseId,
    sourceImageDigest: metadata.imageDigest,
    repositoryFingerprint: remote.fingerprint,
    destinationIdentityFingerprint: remote.destinationIdentityFingerprint,
    sourcePath: dataPath,
    readOnlyMountVerified: true,
    oldDataDeleted: false,
  };
}

export async function stageMetadataRestore(
  archiveBytes: Uint8Array,
  passphrase: string,
  destinationPath: string,
  repositoryRoot = CHECKOUT_ROOT,
): Promise<Record<string, unknown>> {
  const verified = decryptMetadataBackup(archiveBytes, passphrase);
  if (!isAbsolute(destinationPath))
    throw new Error("restore destination must be an absolute path outside the checkout");
  const destinationRequested = resolve(destinationPath);
  const parent = await realpath(dirname(destinationRequested)).catch(() => null);
  if (!parent) throw new Error("restore destination parent must already exist");
  const destination = join(parent, basename(destinationRequested));
  const checkout = await realpath(repositoryRoot);
  const relativeToCheckout = relative(checkout, destination);
  const insideCheckout =
    relativeToCheckout === "" ||
    (relativeToCheckout !== ".." &&
      !relativeToCheckout.startsWith(`..${sep}`) &&
      !isAbsolute(relativeToCheckout));
  if (destination === sep || insideCheckout)
    throw new Error("restore destination must be outside the source checkout");
  if (
    await lstat(destination)
      .then(() => true)
      .catch(() => false)
  )
    throw new Error("restore destination must not already exist");
  await mkdir(destination, { mode: 0o700 });
  try {
    for (const filename of FILE_NAMES) {
      await writeFile(join(destination, filename), verified.files[filename], {
        mode: 0o600,
        flag: "wx",
      });
    }
    await writeFile(
      join(destination, "manifest.json"),
      `${JSON.stringify(verified.manifest, null, 2)}\n`,
      { mode: 0o600, flag: "wx" },
    );
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
  return {
    format: "praetorium.metadata-restore-staging.v1",
    destination,
    sourceDatabaseId: verified.manifest.source.databaseId,
    sourceRevision: verified.manifest.source.sourceRevision,
    recoveryPointId: verified.manifest.source.recoveryPointId,
    files: verified.manifest.files,
    sqlImported: false,
    destinationIsolated: true,
  };
}

export async function createMetadataArchiveFromDirectory(
  inputDirectory: string,
  passphrase: string,
  createdAt?: string,
): Promise<Buffer> {
  const { files, source } = await readMetadataInputDirectory(inputDirectory);
  return encryptMetadataBackup(files, source, passphrase, createdAt);
}

export async function stageMetadataRestoreFromPath(
  archivePath: string,
  passphrase: string,
  destinationPath: string,
  repositoryRoot = CHECKOUT_ROOT,
): Promise<Record<string, unknown>> {
  const archive = await readFile(archivePath).catch(() => {
    throw new Error("encrypted metadata archive must be an accessible regular file");
  });
  return await stageMetadataRestore(archive, passphrase, destinationPath, repositoryRoot);
}

async function findSingleSnapshotFile(root: string, filename: string): Promise<string> {
  const matches: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name === filename) matches.push(path);
    }
  }
  if (matches.length !== 1)
    throw new Error(`legacy Restic snapshot must contain exactly one ${filename}`);
  return matches[0];
}

function verifyLegacyD1Snapshot(
  manifestBytes: Buffer,
  sql: Buffer,
  checksums: Buffer,
): Record<string, unknown> {
  let manifest: Record<string, unknown>;
  try {
    const parsed = JSON.parse(manifestBytes.toString("utf8")) as unknown;
    if (!isRecord(parsed)) throw new Error("manifest must be an object");
    manifest = parsed;
  } catch {
    throw new Error("legacy D1 recovery manifest is not valid JSON");
  }
  const source = isRecord(manifest.source) ? manifest.source : {};
  const databaseExport = isRecord(manifest.databaseExport) ? manifest.databaseExport : {};
  const migrationChecksums = isRecord(manifest.migrationChecksums)
    ? manifest.migrationChecksums
    : {};
  if (
    manifest.format !== "arcadia-platform.d1-recovery.v1" ||
    typeof source.databaseId !== "string" ||
    !UUID.test(source.databaseId) ||
    typeof source.repositoryRevision !== "string" ||
    !COMMIT.test(source.repositoryRevision) ||
    databaseExport.file !== "d1-export.sql" ||
    databaseExport.bytes !== sql.byteLength ||
    databaseExport.sha256 !== sha256(sql) ||
    migrationChecksums.file !== "migration-checksums.json" ||
    migrationChecksums.sha256 !== sha256(checksums)
  ) {
    throw new Error("legacy D1 recovery identity or checksum validation failed");
  }
  return manifest;
}

/** Stage an existing source-format D1 Restic snapshot without executing its SQL. */
export async function stageLegacyD1ResticRestore(
  options: { readonly snapshotId: string; readonly destination: string; readonly remote: true },
  dependencies: {
    readonly run?: ToolRunner;
    readonly env?: NodeJS.ProcessEnv;
    readonly repoRoot?: string;
    readonly tempRoot?: string;
  } = {},
): Promise<Record<string, unknown>> {
  const run = dependencies.run ?? runProcess;
  const env = dependencies.env ?? process.env;
  const repository = ensureRemoteRestic(env);
  if (options.remote !== true)
    throw new Error("explicit --remote is required to restore a legacy D1 snapshot");
  if (!SNAPSHOT_ID.test(options.snapshotId))
    throw new Error("snapshot ID must be a full Restic snapshot ID");
  if (!isAbsolute(options.destination))
    throw new Error("restore destination must be an absolute path outside the source checkout");
  const destinationRequested = resolve(options.destination);
  const destinationParent = await realpath(dirname(destinationRequested)).catch(() => null);
  if (!destinationParent) throw new Error("restore destination parent must already exist");
  const destination = join(destinationParent, basename(destinationRequested));
  const checkoutRoot = await realpath(resolve(dependencies.repoRoot ?? CHECKOUT_ROOT));
  const destinationRelativeToCheckout = relative(checkoutRoot, destination);
  const insideCheckout =
    destinationRelativeToCheckout === "" ||
    (destinationRelativeToCheckout !== ".." &&
      !destinationRelativeToCheckout.startsWith(`..${sep}`) &&
      !isAbsolute(destinationRelativeToCheckout));
  if (destination === sep || insideCheckout)
    throw new Error("restore destination must be outside the source checkout");
  if (
    await lstat(destination)
      .then(() => true)
      .catch(() => false)
  ) {
    throw new Error("restore destination must not already exist");
  }

  const extraction = await mkdtemp(
    join(dependencies.tempRoot ?? env.TMPDIR ?? tmpdir(), "praetorium-legacy-d1-restore-"),
  );
  await chmod(extraction, 0o700);
  try {
    await run(
      env.RESTIC_BIN ?? "restic",
      ["restore", options.snapshotId.toLowerCase(), "--target", extraction],
      {
        env: resticEnv(env),
      },
    );
    const manifestPath = await findSingleSnapshotFile(extraction, "manifest.json");
    const sqlPath = await findSingleSnapshotFile(extraction, "d1-export.sql");
    const checksumsPath = await findSingleSnapshotFile(extraction, "migration-checksums.json");
    const manifestBytes = await readFile(manifestPath);
    const sql = await readFile(sqlPath);
    const checksums = await readFile(checksumsPath);
    const manifest = verifyLegacyD1Snapshot(manifestBytes, sql, checksums);
    await mkdir(destination, { mode: 0o700 });
    try {
      await writeFile(join(destination, "d1-export.sql"), sql, { mode: 0o600, flag: "wx" });
      await writeFile(join(destination, "migration-checksums.json"), checksums, {
        mode: 0o600,
        flag: "wx",
      });
      await writeFile(join(destination, "manifest.json"), manifestBytes, {
        mode: 0o600,
        flag: "wx",
      });
    } catch (error) {
      await rm(destination, { recursive: true, force: true });
      throw error;
    }
    return {
      format: "praetorium.legacy-d1-restore-staging.v1",
      destination,
      sourceDatabaseId: (manifest.source as Record<string, unknown>).databaseId,
      sourceRevision: (manifest.source as Record<string, unknown>).repositoryRevision,
      recoveryPointId: manifest.recoveryPointId,
      exportSha256: (manifest.databaseExport as Record<string, unknown>).sha256,
      migrationChecksumsSha256: (manifest.migrationChecksums as Record<string, unknown>).sha256,
      repositoryFingerprint: repository.fingerprint,
      destinationIdentityFingerprint: repository.destinationIdentityFingerprint,
      d1ImportExecuted: false,
    };
  } finally {
    await rm(extraction, { recursive: true, force: true });
  }
}

export async function runImportPlanCli(
  platformPath: string,
  manifestsPath: string,
  originsPath?: string,
): Promise<LegacyImportPlan> {
  const platform = JSON.parse(await readFile(platformPath, "utf8")) as LegacyPlatformExport;
  const producerManifests = JSON.parse(
    await readFile(manifestsPath, "utf8"),
  ) as LegacyProducerManifest[];
  const targetOrigins = originsPath
    ? (JSON.parse(await readFile(originsPath, "utf8")) as Record<string, string>)
    : undefined;
  if (!Array.isArray(producerManifests))
    throw new Error("producer manifests file must contain a JSON array");
  return buildLegacyImportPlan({ platform, producerManifests, targetOrigins });
}

export function parseCliArgs(argv: readonly string[]): {
  action: string;
  values: Record<string, string>;
  flags: Set<string>;
} {
  const [action, ...rest] = argv;
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (!argument.startsWith("--")) throw new Error("invalid command arguments");
    const key = argument.slice(2);
    if (key === "remote") {
      if (flags.has(key)) throw new Error("duplicate command argument");
      flags.add(key);
      continue;
    }
    if (index + 1 >= rest.length || rest[index + 1].startsWith("--"))
      throw new Error("invalid command arguments");
    if (Object.hasOwn(values, key)) throw new Error("duplicate command argument");
    values[key] = rest[index + 1];
    index += 1;
  }
  return { action: action ?? "", values, flags };
}

function assertAllowedCliArguments(
  parsed: ReturnType<typeof parseCliArgs>,
  valueNames: readonly string[],
  flagNames: readonly string[] = [],
): void {
  const values = new Set(valueNames);
  const flags = new Set(flagNames);
  if (
    Object.keys(parsed.values).some((name) => !values.has(name)) ||
    [...parsed.flags].some((name) => !flags.has(name))
  ) {
    throw new Error("command contains an unknown argument");
  }
}

export async function main(argv = process.argv.slice(2), env = process.env): Promise<unknown> {
  const parsed = parseCliArgs(argv);
  if (parsed.action === "import-plan") {
    assertAllowedCliArguments(parsed, ["platform-export", "producer-manifests", "origin-map"]);
    const platform = parsed.values["platform-export"];
    const producers = parsed.values["producer-manifests"];
    if (!platform || !producers)
      throw new Error("import-plan requires --platform-export and --producer-manifests");
    return await runImportPlanCli(platform, producers, parsed.values["origin-map"]);
  }
  if (parsed.action === "metadata-backup") {
    assertAllowedCliArguments(parsed, ["input-dir", "output", "key-file"]);
    const input = parsed.values["input-dir"];
    const output = parsed.values.output;
    const keyFile = parsed.values["key-file"];
    if (!input || !output || !keyFile)
      throw new Error("metadata-backup requires --input-dir, --output, and --key-file");
    const passphrase = await readRecoveryPassphrase(keyFile);
    const archive = await createMetadataArchiveFromDirectory(input, passphrase);
    await writeFile(resolve(output), archive, { mode: 0o600, flag: "wx" });
    const verified = decryptMetadataBackup(archive, passphrase);
    return {
      format: "praetorium.metadata-backup-receipt.v1",
      output: resolve(output),
      archiveSha256: sha256(archive),
      sourceDatabaseId: verified.manifest.source.databaseId,
      sourceRevision: verified.manifest.source.sourceRevision,
      recoveryPointId: verified.manifest.source.recoveryPointId,
      encrypted: true,
    };
  }
  if (parsed.action === "metadata-verify") {
    assertAllowedCliArguments(parsed, ["archive", "key-file"]);
    const archivePath = parsed.values.archive;
    const keyFile = parsed.values["key-file"];
    if (!archivePath || !keyFile)
      throw new Error("metadata-verify requires --archive and --key-file");
    const passphrase = await readRecoveryPassphrase(keyFile);
    const verified = decryptMetadataBackup(await readFile(archivePath), passphrase);
    return {
      format: "praetorium.metadata-verification.v1",
      sourceDatabaseId: verified.manifest.source.databaseId,
      sourceRevision: verified.manifest.source.sourceRevision,
      recoveryPointId: verified.manifest.source.recoveryPointId,
      files: verified.manifest.files,
      authenticated: true,
      sqlImported: false,
    };
  }
  if (parsed.action === "metadata-restore") {
    assertAllowedCliArguments(parsed, ["archive", "destination", "key-file"]);
    const archivePath = parsed.values.archive;
    const destination = parsed.values.destination;
    const keyFile = parsed.values["key-file"];
    if (!archivePath || !destination || !keyFile)
      throw new Error("metadata-restore requires --archive, --destination, and --key-file");
    return await stageMetadataRestoreFromPath(
      archivePath,
      await readRecoveryPassphrase(keyFile),
      destination,
    );
  }
  if (parsed.action === "d1-backup") {
    assertAllowedCliArguments(
      parsed,
      [
        "database",
        "config",
        "migration-checksums",
        "environment",
        "source-revision",
        "output",
        "key-file",
      ],
      ["remote"],
    );
    const { database, config, output } = parsed.values;
    const checksums = parsed.values["migration-checksums"];
    const environment = parsed.values.environment;
    const sourceRevision = parsed.values["source-revision"];
    const keyFile = parsed.values["key-file"];
    if (
      !database ||
      !config ||
      !checksums ||
      !environment ||
      !sourceRevision ||
      !keyFile ||
      !output ||
      !parsed.flags.has("remote")
    ) {
      throw new Error(
        "d1-backup requires --remote, --database, --config, --migration-checksums, --environment, --source-revision, --output, and --key-file",
      );
    }
    return await createD1ResticBackup({
      database,
      config,
      migrationChecksums: checksums,
      environment,
      sourceRevision,
      output,
      keyFile,
      remote: true,
    });
  }
  if (parsed.action === "legacy-d1-restore") {
    assertAllowedCliArguments(parsed, ["snapshot-id", "destination"], ["remote"]);
    const snapshotId = parsed.values["snapshot-id"];
    const destination = parsed.values.destination;
    if (!snapshotId || !destination || !parsed.flags.has("remote")) {
      throw new Error("legacy-d1-restore requires --remote, --snapshot-id, and --destination");
    }
    return await stageLegacyD1ResticRestore({ snapshotId, destination, remote: true });
  }
  if (parsed.action === "pvc-backup") {
    if (Object.keys(parsed.values).length || parsed.flags.size)
      throw new Error(
        "pvc-backup accepts source identity and credentials through its protected environment only",
      );
    return await createLegacyPvcSnapshot({ env });
  }
  throw new Error(
    "expected import-plan, metadata-backup, metadata-verify, metadata-restore, d1-backup, legacy-d1-restore, or pvc-backup",
  );
}

export async function writeCliResult(result: unknown): Promise<void> {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
