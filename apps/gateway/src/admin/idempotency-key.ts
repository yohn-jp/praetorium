import { generateToken } from "@praetorium/auth";

/** Keeps random command tokens inside the operator API's alphanumeric-led key grammar. */
export function generateAdminIdempotencyKey(): string {
  return `cmd_${generateToken(128)}`;
}
