import type { SourceBuildSummary } from "@praetorium/contracts";
export type SourceBuildStatus = SourceBuildSummary;
export interface RegisteredReleaseSource {
  readonly id: string;
  readonly label: string;
  readonly githubRepository: string;
  readonly adapter: "scriptorium-v1";
}
export interface PublishedSourceRelease {
  readonly id: number;
  readonly tag: string;
  readonly name: string;
  readonly version: string | null;
  readonly publishedAt: string;
  readonly prerelease: boolean;
  readonly notes: string;
}
export interface SourceReleaseView {
  readonly source: RegisteredReleaseSource;
  readonly releases: readonly PublishedSourceRelease[];
  readonly error: string | null;
  readonly endpoint: string;
  readonly status: number | null;
  readonly code: string | null;
}
export type SourceRetryIdentityResult =
  | { readonly kind: "matched"; readonly sourceId: string; readonly githubReleaseId: number;
      readonly sourceTag: string; readonly sourceRevision: string; readonly releaseVersion: string }
  | { readonly kind: "conflict" | "forbidden" | "unavailable" };
