import { z } from "zod";
const IdSchema = z.string().regex(/^ins_[0-9A-HJKMNP-TV-Z]{26}$/);
const SuffixSchema = z
  .string()
  .max(210)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/);
/** Retains source stable origin derivation; neither actor nor repository name enters the hostname. */
export function instanceHostname(instanceId: string, suffix: string): string {
  const id = IdSchema.parse(instanceId);
  SuffixSchema.parse(suffix);
  const host = `ins-${id.slice(4).toLowerCase()}.${suffix}`;
  if (host.length > 253) throw new Error("Instance hostname too long");
  return host;
}
export function instanceIdFromHostname(hostname: string, suffix: string): string {
  SuffixSchema.parse(suffix);
  if (hostname !== hostname.toLowerCase() || !hostname.endsWith(`.${suffix}`))
    throw new Error("Invalid instance host");
  const label = hostname.slice(0, -suffix.length - 1);
  if (!/^ins-[0-9a-hjkmnp-tv-z]{26}$/.test(label)) throw new Error("Invalid instance host");
  const id = IdSchema.parse(`ins_${label.slice(4).toUpperCase()}`);
  if (instanceHostname(id, suffix) !== hostname) throw new Error("Invalid instance host");
  return id;
}
