export type PackageBoundary =
  | "auth"
  | "application"
  | "contracts"
  | "domain"
  | "persistence"
  | "config"
  | "observability";
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
export function assertNever(value: never): never {
  throw new Error(`Unexpected state: ${String(value)}`);
}
export function canRetire(observation: {
  disposition: "safe" | "blocked" | "unknown";
  activeMutations: number;
  activeJobs: number;
  unpublishedCheckpoints: number;
  uncertainPublication: boolean;
}): boolean {
  return (
    observation.disposition === "safe" &&
    observation.activeMutations === 0 &&
    observation.activeJobs === 0 &&
    observation.unpublishedCheckpoints === 0 &&
    !observation.uncertainPublication
  );
}
