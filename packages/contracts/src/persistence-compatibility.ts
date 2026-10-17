import { z } from "zod";

const FormatId = z.string().regex(/^[a-z][a-z0-9.-]{0,127}$/u);
const Version = z.number().int().positive().safe();
const Format = z.strictObject({ formatId: FormatId, version: Version });
const uniqueFormats = (items: readonly { formatId: string }[]) =>
  new Set(items.map((item) => item.formatId)).size === items.length;

/** Immutable producer declaration: old readers must understand every format a
 * replacement can write, including the browser's origin-scoped recovery data. */
export const PersistenceCompatibilitySchema = z
  .strictObject({
    contractVersion: z.literal("scriptorium-persistence/v1"),
    readable: z
      .array(
        z.strictObject({
          formatId: FormatId,
          versions: z
            .array(Version)
            .min(1)
            .max(64)
            .refine((versions) => new Set(versions).size === versions.length),
        }),
      )
      .min(1)
      .max(256)
      .refine(uniqueFormats),
    writable: z
      .array(Format)
      .min(1)
      .max(256)
      .refine(
        (items) =>
          new Set(items.map((item) => `${item.formatId}:${item.version}`)).size === items.length,
      ),
  })
  .refine(
    (value) =>
      value.writable.every((format) =>
        value.readable.some(
          (reader) =>
            reader.formatId === format.formatId && reader.versions.includes(format.version),
        ),
      ),
    "a producer must read every format it writes",
  );
export type PersistenceCompatibility = z.infer<typeof PersistenceCompatibilitySchema>;

/** Complete observation of durable remote formats at one confirmed Git commit.
 * Browser storage is covered directionally by artifact declarations, never by
 * a claim that a server inspected a browser's IndexedDB. */
export const PersistenceObservationSchema = z
  .strictObject({
    state: z.enum(["verified", "unknown"]),
    observedRemoteCommit: z
      .string()
      .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u)
      .nullable(),
    formats: z.array(Format).max(256),
  })
  .refine(
    (value) =>
      new Set(value.formats.map((format) => `${format.formatId}:${format.version}`)).size ===
      value.formats.length,
    "observed format versions must be unique",
  );
export type PersistenceObservation = z.infer<typeof PersistenceObservationSchema>;
