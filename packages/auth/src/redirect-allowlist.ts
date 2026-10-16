/**
 * Validates a post-login redirect target as a same-origin relative path.
 * Rejects anything that could be interpreted as an absolute or
 * protocol-relative URL (scheme, `//`, backslash tricks) and anything
 * carrying a raw CR/LF that could be used for header/response splitting.
 */
export function isSafeRelativeRedirect(target: string): boolean {
  if (target.length === 0 || !target.startsWith("/")) {
    return false;
  }
  if (target.startsWith("//") || target.startsWith("/\\")) {
    return false;
  }
  return !/[\r\n]/.test(target);
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
