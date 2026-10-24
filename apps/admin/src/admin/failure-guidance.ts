export const CANARY_CONFIGURATION_CONFLICT = "canary_configuration_conflict";

const FAILURE_GUIDANCE: Readonly<Record<string, string>> = {
  [CANARY_CONFIGURATION_CONFLICT]:
    "Canary configuration changed or an operation is still active; inspect the current operation and let normal recovery finish before automatic retry.",
};

export function failureGuidance(code: string | null | undefined): string | null {
  return code ? FAILURE_GUIDANCE[code] ?? null : null;
}
