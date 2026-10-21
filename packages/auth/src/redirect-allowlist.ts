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
