import { z } from "zod";
const IdSchema = z.string().regex(/^(?:ins_[0-9A-HJKMNP-TV-Z]{26}|run_[0-9A-HJKMNP-TV-Z]{26}_[1-9][0-9]*)$/);
const SuffixSchema = z
  .string()
  .max(210)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/);
/** Physical runtime name. Browser credentials belong to applicationHostname instead. */
export function instanceHostname(instanceId: string, suffix: string): string {
  const id = IdSchema.parse(instanceId);
  SuffixSchema.parse(suffix);
  const label = id.startsWith("run_") ? id.slice(4).replace("_", "-").toLowerCase() : id.slice(4).toLowerCase();
  if (label.length > 63 || (id.startsWith("run_") && !Number.isSafeInteger(Number(id.split("_")[2])))) throw new Error("Invalid physical instance host label");
  const host = `${label}.${suffix}`;
  if (host.length > 253) throw new Error("Instance hostname too long");
  return host;
}
export function instanceIdFromHostname(hostname: string, suffix: string): string {
  SuffixSchema.parse(suffix);
  if (hostname !== hostname.toLowerCase() || !hostname.endsWith(`.${suffix}`))
    throw new Error("Invalid instance host");
  const label = hostname.slice(0, -suffix.length - 1);
  if (!/^[0-9a-hjkmnp-tv-z]{26}(?:-[1-9][0-9]*)?$/.test(label)) throw new Error("Invalid instance host");
  const [body, epoch] = label.split("-");
  const id = IdSchema.parse(epoch === undefined ? `ins_${body!.toUpperCase()}` : `run_${body!.toUpperCase()}_${epoch}`);
  if (instanceHostname(id, suffix) !== hostname) throw new Error("Invalid instance host");
  return id;
}
