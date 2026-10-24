/**
 * Validates a post-login redirect target as a same-origin relative path.
 * Rejects anything that could be interpreted as an absolute or
 * protocol-relative URL, including characters the WHATWG URL parser silently
 * strips or treats as separators. The parsed URL is also checked against a
 * fixed origin so normalization cannot change the redirect authority.
 */
export function isSafeRelativeRedirect(target: string): boolean {
  if (target.length === 0 || !target.startsWith("/")) {
    return false;
  }
  if (target.startsWith("//") || target.split("").some((character) => {
    const code = character.codePointAt(0)!;
    return code <= 0x20 || code === 0x7f || character === "\\";
  }) || /%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/iu.test(target)) {
    return false;
  }
  try {
    return new URL(target, "https://redirect.invalid/").origin === "https://redirect.invalid";
  } catch {
    return false;
  }
}

/**
 * Validates an absolute instance URL against the configured instance
 * hostname suffix before a browser is ever redirected to it, so a
 * control-plane response cannot redirect a user off-platform.
 */
export function isAllowedInstanceHostname(url: URL, hostnameSuffix: string): boolean {
  const normalizedSuffix = hostnameSuffix.replace(/^\.+/, "");
  return (
    url.protocol === "https:" &&
    (url.hostname === normalizedSuffix || url.hostname.endsWith(`.${normalizedSuffix}`))
  );
}


/**
 * OAuth Admin return targets are restricted to read-only pages and their own
 * bounded navigation state. No POST destination, arbitrary URL, or query key
 * is ever accepted. The same authority is used by Gateway and Admin.
 */
export function adminReturnPath(target: string | null | undefined): string {
  if (!target || target.length > 768 || !isSafeRelativeRedirect(target) ||
      target.includes("#")) return "/";
  let url: URL;
  try { url = new URL(target, "https://admin.invalid"); }
  catch { return "/"; }
  if (url.origin !== "https://admin.invalid") return "/";
  const path = url.pathname;
  const buildDetail = /^\/builds\/sr_[0-9a-f-]{36}$/u.test(path);
  const releaseDetail = /^\/releases\/[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(path);
  const infrastructure = /^\/infrastructure(?:\/hosts\/[a-z][a-z0-9-]{0,63}|\/dependencies)?$/u.test(path);
  const operation = /^\/operations\/op_[A-Za-z0-9_.:-]{1,124}$/u.test(path);
  if (!["/", "/builds", "/releases", "/audit"].includes(path) &&
      !buildDetail && !releaseDetail && !infrastructure && !operation) return "/";
  const permitted = path === "/builds" ? ["ui", "sort", "state", "cursor"] :
    path === "/audit" ? ["ui", "q", "cursor"] :
    path === "/releases" || buildDetail ? ["ui", "cursor"] : ["ui"];
  const normalized = new URLSearchParams();
  const entries = [...url.searchParams.entries()];
  if (entries.length > permitted.length) return "/";
  for (const [key, value] of entries) {
    if (!permitted.includes(key) || normalized.has(key)) return "/";
    if (key === "ui" && value !== "desktop" && value !== "mobile") return "/";
    if (key === "sort" && !["recent", "source", "state", "attempt"].includes(value)) return "/";
    if (key === "state" && !["queued", "building", "produced", "admitted", "failed"].includes(value)) return "/";
    if (key === "q" && (value.length > 100 ||
        [...value].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))) return "/";
    if (key === "cursor" && (value.length < 1 || value.length > 512 ||
        !/^(?:[A-Za-z0-9_.~:-]|%[0-9A-Fa-f]{2})+$/u.test(value))) return "/";
    normalized.append(key, value);
  }
  return path + (normalized.size ? "?" + normalized.toString() : "");
}
